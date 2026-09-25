import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { nativeSleep } from "./keep-alive";
import { isNativeApp, saveToDeviceGallery } from "./native";
import type { StudioResult, TabState, VideoTabId } from "./types";

const VENICE = "https://api.venice.ai/api/v1";
const VENICE_KEY_STORAGE = "venice_api_key";
const PROVIDER_STORAGE = "video_provider";
export const PROVIDER_EVENT = "video-provider-change";

export type VideoProvider = "runware" | "venice";

/* ---------- key + provider storage ---------- */

function storedVeniceKey() {
  return (localStorage.getItem(VENICE_KEY_STORAGE) || "").trim();
}

export function saveVeniceKey(key: string) {
  const value = key.trim();
  if (value) localStorage.setItem(VENICE_KEY_STORAGE, value);
  else localStorage.removeItem(VENICE_KEY_STORAGE);
}

export function hasLocalVeniceKey() {
  return Boolean(storedVeniceKey());
}

export function loadVideoProvider(): VideoProvider {
  try {
    return localStorage.getItem(PROVIDER_STORAGE) === "venice" ? "venice" : "runware";
  } catch {
    return "runware";
  }
}

export function saveVideoProvider(provider: VideoProvider) {
  localStorage.setItem(PROVIDER_STORAGE, provider);
  window.dispatchEvent(new CustomEvent(PROVIDER_EVENT, { detail: provider }));
}

/* ---------- model mapping ---------- */

type Variant = "image" | "reference" | "text";

const VENICE_MODELS: Partial<Record<VideoTabId, Record<Variant, string>>> = {
  "wan-3": {
    image: "wan-3-0-image-to-video",
    reference: "wan-3-0-reference-to-video",
    text: "wan-3-0-text-to-video",
  },
  "wan-3-prime": {
    image: "wan-3-0-prime-image-to-video",
    reference: "wan-3-0-prime-reference-to-video",
    text: "wan-3-0-prime-text-to-video",
  },
  "minimax-h3-max": {
    image: "minimax-h3-max-image-to-video",
    reference: "minimax-h3-max-reference-to-video",
    text: "minimax-h3-max-text-to-video",
  },
};

export function veniceSupports(tab: VideoTabId) {
  return Boolean(VENICE_MODELS[tab]);
}

/* ---------- transport ---------- */

type VeniceResponse = {
  status: number;
  contentType: string;
  json?: Record<string, unknown>;
  /** base64 video bytes (native) */
  base64?: string;
  /** video blob (web) */
  blob?: Blob;
};

function b64ToText(b64: string) {
  try {
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return "";
  }
}

async function venicePost(path: string, body: unknown, binary = false): Promise<VeniceResponse> {
  const key = storedVeniceKey();

  if (Capacitor.isNativePlatform()) {
    if (!key) throw new Error("Add your Venice API key in Settings.");
    const res = await CapacitorHttp.post({
      url: `${VENICE}${path}`,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      data: body,
      responseType: binary ? "blob" : "json",
      connectTimeout: 600000,
      readTimeout: 600000,
    });
    const headers = res.headers || {};
    const contentType = String(headers["Content-Type"] || headers["content-type"] || "");
    if (binary && typeof res.data === "string") {
      const sample = peekBase64(res.data);
      if (/video\/|octet-stream/i.test(contentType) || looksLikeVideo(sample) || (res.data.length > 50_000 && sample.length > 8)) {
        if (looksLikeVideo(sample) || /video\/|octet-stream/i.test(contentType)) {
          return { status: res.status, contentType, base64: res.data };
        }
      }
    }
    let json: Record<string, unknown> | undefined;
    if (res.data && typeof res.data === "object") json = res.data as Record<string, unknown>;
    else if (typeof res.data === "string") {
      for (const text of [res.data, b64ToText(res.data)]) {
        try {
          json = JSON.parse(text);
          break;
        } catch {
          /* try next */
        }
      }
    }
    return { status: res.status, contentType, json };
  }

  // Web: go through the local server proxy (avoids browser CORS limits).
  const res = await fetch(`/api/venice${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "X-Venice-Key": key } : {}) },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") || "";
  if (/video\/|octet-stream/i.test(contentType)) return { status: res.status, contentType, blob: await res.blob() };
  let json: Record<string, unknown> | undefined;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  return { status: res.status, contentType, json };
}

function veniceError(res: VeniceResponse, fallback: string) {
  const j = res.json || {};
  const parts = [j.error, j.message, (j as { details?: unknown }).details ? JSON.stringify(j.details).slice(0, 300) : ""]
    .filter((v) => typeof v === "string" && v)
    .join(" · ");
  if (res.status === 401) return "Venice rejected the API key. Check it in Settings.";
  if (res.status === 402) return "Venice balance is too low. Top up at venice.ai.";
  if (res.status === 413) return "Venice says the photos/clips are too large. Use fewer or smaller files.";
  if (res.status === 422) return `Venice blocked this as a content violation.${parts ? ` ${parts}` : ""}`;
  return `${fallback} (HTTP ${res.status})${parts ? `: ${parts}` : ""}`;
}

/** Fields Venice rejected in a 400 (from its zod-style `details`). */
function rejectedFields(res: VeniceResponse): string[] {
  const details = (res.json?.details || {}) as Record<string, unknown>;
  const fromDetails = Object.keys(details).filter((k) => k !== "_errors");
  const errors = details._errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (item && typeof item === "object" && Array.isArray((item as { path?: unknown }).path)) {
        const path = (item as { path: string[] }).path;
        if (path[0] && typeof path[0] === "string") fromDetails.push(path[0]);
      }
    }
  }
  return [...new Set(fromDetails)];
}

/* ---------- checking + saving the finished video ---------- */

/** First bytes of a base64 string, decoded. */
function peekBase64(b64: string, bytes = 256) {
  try {
    const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    return atob(clean.slice(0, Math.ceil(bytes / 3) * 4));
  } catch {
    return "";
  }
}

/** MP4/MOV files have an `ftyp` box (usually at byte 4). */
function looksLikeVideo(head: string) {
  if (!head) return false;
  if (head.slice(4, 8) === "ftyp") return true;
  return head.includes("ftyp");
}

function notAVideoError(head: string, where: string) {
  const text = head.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 200);
  return new Error(`Venice ${where} did not return a video${text ? `: ${text}` : ""}`);
}

async function assertVideoBlob(blob: Blob, where: string) {
  const head = await blob.slice(0, 256).text();
  if (!looksLikeVideo(head)) throw notAVideoError(head, where);
}

function veniceAspect(aspect: TabState["aspect"]) {
  if (aspect === "9:16" || aspect === "16:9" || aspect === "1:1" || aspect === "4:3" || aspect === "3:4" || aspect === "21:9") {
    return aspect;
  }
  return "16:9";
}

function durationTag(seconds: number) {
  return `${seconds}s`;
}

function pickVariant(frames: string[], refs: string[], videos: string[], audios: string[]): Variant {
  if (frames.length) return "image";
  if (refs.length || videos.length || audios.length) return "reference";
  return "text";
}

export type VeniceVideoInput = {
  tab: VideoTabId;
  state: TabState;
  prompt: string;
  duration: number;
  resolution: string;
  frames: string[];
  refs: string[];
  videos: string[];
  audios: string[];
  onProgress?: (n: number) => void;
};

function safeName(name: string) {
  return name.replace(/[^\w.-]+/g, "_");
}

async function base64ToBlob(b64: string, mime = "video/mp4") {
  const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  const raw = atob(clean);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function saveBase64Video(
  base64: string,
  filename: string,
  where = "result"
): Promise<{ url: string; localPath?: string }> {
  const head = peekBase64(base64);
  if (!looksLikeVideo(head)) throw notAVideoError(head, where);
  console.info(`Venice video ok (${where}), ~${Math.round((base64.length * 0.75) / 1024)} KB`);
  const name = safeName(filename);
  if (isNativeApp()) {
    const written = await Filesystem.writeFile({
      path: `ai-story/${name}`,
      data: base64.replace(/^data:[^,]*,/, "").replace(/\s/g, ""),
      directory: Directory.Data,
      recursive: true,
    });
    const path = written.path || `ai-story/${name}`;
    return { url: Capacitor.convertFileSrc(path), localPath: path };
  }
  const blob = await base64ToBlob(base64);
  return { url: URL.createObjectURL(blob) };
}

async function saveFromDownloadUrl(downloadUrl: string, filename: string): Promise<{ url: string; localPath?: string }> {
  if (isNativeApp()) {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await CapacitorHttp.get({
        url: downloadUrl,
        responseType: "blob",
        connectTimeout: 600000,
        readTimeout: 600000,
      });
      if (res.status < 400 && typeof res.data === "string") {
        return saveBase64Video(res.data, filename, "download link");
      }
      last = `HTTP ${res.status}`;
      if (res.status === 404 || res.status === 410) break;
      await nativeSleep(3000);
    }
    throw new Error(`Could not download the Venice video (${last}).`);
  }
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Could not download the Venice video (HTTP ${res.status}).`);
  const blob = await res.blob();
  await assertVideoBlob(blob, "download link");
  return { url: URL.createObjectURL(blob) };
}

/** Revoke a private pre-signed link (no API key needed). */
async function revokeDownloadUrl(downloadUrl: string) {
  try {
    if (Capacitor.isNativePlatform()) {
      await CapacitorHttp.request({ method: "DELETE", url: downloadUrl, connectTimeout: 60000, readTimeout: 60000 });
    } else {
      await fetch(downloadUrl, { method: "DELETE" });
    }
  } catch {
    /* optional */
  }
}

async function completeOnVenice(model: string, queueId: string) {
  try {
    await venicePost("/video/complete", { model, queue_id: queueId });
  } catch {
    /* retrieve may have already deleted media */
  }
}

/* ---------- paid jobs that did not save yet ---------- */

type VeniceJob = { model: string; queueId: string; downloadUrl: string; filename: string; at: number };
const PENDING_STORAGE = "venice_pending_jobs";

function loadPending(): VeniceJob[] {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_STORAGE) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function savePending(list: VeniceJob[]) {
  localStorage.setItem(PENDING_STORAGE, JSON.stringify(list.slice(-30)));
}

function rememberJob(job: VeniceJob) {
  savePending([...loadPending().filter((j) => j.queueId !== job.queueId), job]);
}

function patchJob(job: VeniceJob, patch: Partial<VeniceJob>) {
  const next = { ...job, ...patch };
  rememberJob(next);
  return next;
}

function downloadUrlForJob(job: VeniceJob, json?: Record<string, unknown>) {
  if (job.downloadUrl) return job.downloadUrl;
  const fromJson = json?.download_url;
  return typeof fromJson === "string" && fromJson ? fromJson : "";
}

function isTerminalVeniceError(msg: string) {
  return /FAILED|ERROR|expired|HTTP 410|not found|content violation|rejected the api key|balance is too low/i.test(msg);
}

function forgetJob(queueId: string) {
  savePending(loadPending().filter((j) => j.queueId !== queueId));
}

export function pendingVeniceCount() {
  return loadPending().length;
}

type FetchOutcome =
  | { kind: "saved"; saved: { url: string; localPath?: string } }
  | { kind: "waiting"; json?: Record<string, unknown> };

/** One retrieve call. The video stays on Venice until we confirm it saved. */
async function fetchJobOnce(job: VeniceJob): Promise<FetchOutcome> {
  const res = await venicePost("/video/retrieve", { model: job.model, queue_id: job.queueId }, true);
  if (res.status === 503) return { kind: "waiting" };
  if (res.status === 404 || res.status === 409) return { kind: "waiting" };
  if (res.status >= 400) throw new Error(veniceError(res, "Venice video failed"));
  if (res.base64) return { kind: "saved", saved: await saveBase64Video(res.base64, job.filename) };
  if (res.blob) {
    if (isNativeApp()) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result || "");
          resolve(raw.includes(",") ? raw.split(",")[1] || "" : raw);
        };
        reader.onerror = () => reject(new Error("Could not read Venice video."));
        reader.readAsDataURL(res.blob!);
      });
      return { kind: "saved", saved: await saveBase64Video(data, job.filename) };
    }
    const head = await res.blob.slice(0, 256).text();
    if (!looksLikeVideo(head)) throw notAVideoError(head, "result");
    return { kind: "saved", saved: { url: URL.createObjectURL(res.blob) } };
  }
  const status = String(res.json?.status || "").toUpperCase();
  if (status === "COMPLETED") {
    const downloadUrl = downloadUrlForJob(job, res.json);
    if (!downloadUrl) {
      console.warn("Venice COMPLETED without download_url", res.json);
      throw new Error(
        "Venice marked the job complete but did not send a video link. Open Settings → Recover Venice videos, or check venice.ai for the job."
      );
    }
    return { kind: "saved", saved: await saveFromDownloadUrl(downloadUrl, job.filename) };
  }
  if (status === "FAILED" || status === "ERROR") throw new Error(veniceError(res, "Venice video failed"));
  return { kind: "waiting", json: res.json };
}

/** Only after the video is safely on the phone: revoke the link and delete it on Venice. */
async function finishJob(job: VeniceJob) {
  if (job.downloadUrl) await revokeDownloadUrl(job.downloadUrl);
  await completeOnVenice(job.model, job.queueId);
  forgetJob(job.queueId);
}

/** Settings → Recover: fetch paid videos that failed to save and put them in the gallery. */
export async function recoverVeniceVideos(): Promise<{ tried: number; saved: number; errors: string[] }> {
  const jobs = loadPending();
  let saved = 0;
  const errors: string[] = [];
  for (const job of jobs) {
    try {
      const out = await fetchJobOnce(job);
      if (out.kind !== "saved") {
        errors.push(`${job.model}: still processing`);
        continue;
      }
      if (isNativeApp() && out.saved.localPath) await saveToDeviceGallery(out.saved.localPath, job.filename, true);
      else {
        const a = document.createElement("a");
        a.href = out.saved.url;
        a.download = job.filename;
        a.click();
      }
      await finishJob(job);
      saved += 1;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${job.model}: ${msg}`);
      if (/HTTP 404|HTTP 410|not found|expired/i.test(msg)) forgetJob(job.queueId);
    }
  }
  return { tried: jobs.length, saved, errors };
}

async function queueVeniceJob(body: Record<string, unknown>, tab: VideoTabId, resolution: string) {
  const alternates: Record<string, unknown[]> = {
    // MiniMax: 480p stays 480p (tries "480P" if Venice wants capitals); 720p maps to MiniMax's 768p.
    resolution:
      tab === "minimax-h3-max"
        ? resolution === "720p"
          ? ["768p", "768P"]
          : [resolution.toUpperCase()]
        : [String(body.resolution || resolution).toUpperCase()],
  };
  const optional = new Set(["resolution", "audio", "aspect_ratio", "end_image_url", "negative_prompt"]);

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await venicePost("/video/queue", body);
    if (res.status < 400) {
      const json = res.json || {};
      const model = String(json.model || body.model || "");
      const queueId = String(json.queue_id || "");
      if (!model || !queueId) throw new Error("Venice queue returned no job id.");
      const downloadUrl = typeof json.download_url === "string" ? json.download_url : undefined;
      return { model, queueId, downloadUrl };
    }
    if (res.status !== 400) throw new Error(veniceError(res, "Venice queue failed"));

    const bad = rejectedFields(res).filter((f) => optional.has(f) && f in body);
    if (!bad.length) throw new Error(veniceError(res, "Venice rejected the request"));
    for (const field of bad) {
      const queue = alternates[field] || [];
      let next = queue.shift();
      while (next !== undefined && next === body[field]) next = queue.shift();
      if (next !== undefined) body[field] = next;
      else delete body[field];
    }
  }
  throw new Error("Venice rejected the request after retries.");
}

export async function generateVeniceVideo(input: VeniceVideoInput): Promise<StudioResult> {
  const variant = pickVariant(input.frames, input.refs, input.videos, input.audios);
  const modelId = VENICE_MODELS[input.tab]?.[variant];
  if (!modelId) throw new Error("That video model is not available on Venice.");

  const body: Record<string, unknown> = {
    model: modelId,
    prompt: input.prompt,
    duration: durationTag(input.duration),
    resolution: input.resolution,
    aspect_ratio: veniceAspect(input.state.aspect),
    audio: input.state.audio,
  };

  if (input.frames.length === 1) body.image_url = input.frames[0];
  else if (input.frames.length >= 2) {
    body.image_url = input.frames[0];
    body.end_image_url = input.frames[1];
  }
  if (input.refs.length) body.reference_image_urls = input.refs;
  if (input.videos.length) body.reference_video_urls = input.videos;
  if (input.audios.length) {
    if (input.audios.length === 1 && !input.refs.length && !input.videos.length) body.audio_url = input.audios[0];
    else body.reference_audio_urls = input.audios;
  }

  const queued = await queueVeniceJob(body, input.tab, input.resolution);
  let job: VeniceJob = {
    model: queued.model,
    queueId: queued.queueId,
    downloadUrl: queued.downloadUrl || "",
    filename: `${input.tab}-venice-${Date.now()}.mp4`,
    at: Date.now(),
  };
  rememberJob(job);
  console.info("Venice queued", job);
  input.onProgress?.(5);

  const deadline = Date.now() + 20 * 60 * 1000;
  let saved: { url: string; localPath?: string } | null = null;
  let saveFailures = 0;
  let polls = 0;
  while (Date.now() < deadline && !saved) {
    if (polls++) await nativeSleep(5000);
    let out: FetchOutcome;
    try {
      out = await fetchJobOnce(job);
      if (out.json?.download_url && !job.downloadUrl) {
        job = patchJob(job, { downloadUrl: String(out.json.download_url) });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const paidAlready = /did not return a video|Could not download|Filesystem|write|memory/i.test(msg);
      if (paidAlready && ++saveFailures < 5) {
        console.warn("Venice save failed, retrying", msg);
        continue;
      }
      if (isTerminalVeniceError(msg)) forgetJob(job.queueId);
      const pending = pendingVeniceCount();
      throw new Error(
        paidAlready
          ? `Venice charged your account but the app could not save the file (${msg}). Open Settings → Recover Venice videos (${pending}).`
          : `${msg}${pending ? ` Recover Venice videos (${pending}) in Settings if this was charged.` : ""}`
      );
    }
    if (out.kind === "saved") saved = out.saved;
    else {
      const avg = Number(out.json?.average_execution_time) || 0;
      const ran = Number(out.json?.execution_duration) || 0;
      if (avg > 0) input.onProgress?.(Math.min(95, Math.round((ran / avg) * 100)));
    }
  }
  if (!saved) {
    throw new Error(
      `Venice is still processing after 20 minutes. Your credits may already be used — open Settings → Recover Venice videos (${pendingVeniceCount()}).`
    );
  }

  await finishJob(job);
  input.onProgress?.(100);
  return {
    kind: "video",
    url: saved.url,
    localPath: saved.localPath,
    filename: job.filename,
  };
}
