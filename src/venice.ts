import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { nativeSleep } from "./keep-alive";
import { isNativeApp, persistNativeResult } from "./native";
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
    if (
      binary &&
      typeof res.data === "string" &&
      (/video\/|octet-stream/i.test(contentType) || looksLikeVideo(peekBase64(res.data)))
    ) {
      return { status: res.status, contentType, base64: res.data };
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

/** MP4/MOV files have "ftyp" at byte 4. */
function looksLikeVideo(head: string) {
  return head.slice(4, 8) === "ftyp";
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

async function base64ToBlob(b64: string, mime = "video/mp4") {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function studioFromVideoBlob(blob: Blob, tab: VideoTabId, state: TabState): Promise<StudioResult> {
  await assertVideoBlob(blob, "result");
  const ext = state.videoFormat.toLowerCase();
  const filename = `${tab}-${Date.now()}.${ext}`;
  const mime = blob.type && blob.type !== "application/octet-stream" ? blob.type : "video/mp4";
  console.info(`Venice video ok (result), ~${Math.round(blob.size / 1024)} KB`);

  if (isNativeApp()) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read Venice video."));
      reader.readAsDataURL(blob);
    });
    const b64 = data.split(",")[1] || "";
    const path = `ai-story/${filename}`;
    await Filesystem.writeFile({
      path,
      data: b64,
      directory: Directory.Data,
      recursive: true,
    });
    return {
      kind: "video",
      url: Capacitor.convertFileSrc(path),
      localPath: path,
      filename,
    };
  }

  const url = URL.createObjectURL(blob);
  const remote = { kind: "video" as const, url, filename };
  const persisted = await persistNativeResult(remote);
  return { ...remote, url: persisted.url, localPath: persisted.localPath };
}

async function downloadVeniceUrl(url: string) {
  if (Capacitor.isNativePlatform()) {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await CapacitorHttp.get({
        url,
        responseType: "blob",
        connectTimeout: 600000,
        readTimeout: 600000,
      });
      if (res.status < 400 && typeof res.data === "string") {
        const head = peekBase64(res.data);
        if (!looksLikeVideo(head)) throw notAVideoError(head, "download link");
        console.info(`Venice video ok (download link), ~${Math.round((res.data.length * 0.75) / 1024)} KB`);
        return base64ToBlob(res.data);
      }
      last = `HTTP ${res.status}`;
      if (res.status === 404 || res.status === 410) break;
      await nativeSleep(3000);
    }
    throw new Error(`Could not download the Venice video (${last}).`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the Venice video (HTTP ${res.status}).`);
  const blob = await res.blob();
  await assertVideoBlob(blob, "download link");
  return blob;
}

async function pollVeniceVideo(
  model: string,
  queueId: string,
  downloadUrl?: string,
  onProgress?: (n: number) => void
) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await venicePost(
      "/video/retrieve",
      { model, queue_id: queueId, delete_media_on_completion: true },
      true
    );
    if (res.status >= 400 && res.status !== 200) throw new Error(veniceError(res, "Venice retrieve failed"));

    if (res.blob) {
      await assertVideoBlob(res.blob, "result");
      return res.blob;
    }
    if (res.base64) {
      const head = peekBase64(res.base64);
      if (!looksLikeVideo(head)) throw notAVideoError(head, "result");
      return base64ToBlob(res.base64, res.contentType || "video/mp4");
    }

    const status = String(res.json?.status || "");
    if (status === "COMPLETED") {
      const url = downloadUrl || (typeof res.json?.download_url === "string" ? res.json.download_url : "");
      if (url) return downloadVeniceUrl(url);
      throw new Error("Venice finished but returned no video.");
    }

    if (status === "PROCESSING") {
      const avg = Number(res.json?.average_execution_time || 0);
      const elapsed = Number(res.json?.execution_duration || 0);
      if (avg > 0 && onProgress) onProgress(Math.min(95, Math.round((elapsed / avg) * 100)));
      await nativeSleep(5000);
      continue;
    }

    if (res.json && !status) throw new Error(veniceError(res, "Venice retrieve failed"));
    await nativeSleep(4000);
  }
  throw new Error("Timed out waiting for Venice.");
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
  console.info("Venice queued", { model: queued.model, queueId: queued.queueId, privateLink: Boolean(queued.downloadUrl) });
  input.onProgress?.(5);
  const blob = await pollVeniceVideo(queued.model, queued.queueId, queued.downloadUrl, input.onProgress);
  input.onProgress?.(100);
  try {
    await venicePost("/video/complete", { model: queued.model, queue_id: queued.queueId });
  } catch {
    /* retrieve may have already deleted media */
  }
  return studioFromVideoBlob(blob, input.tab, input.state);
}
