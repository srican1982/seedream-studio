import { Capacitor, CapacitorHttp } from "@capacitor/core";
import {
  findImage,
  findVideo,
  fitQwenRefSize,
  imageSize,
  qwenPositivePrompt,
  VIDEO_AUDIO_MODELS,
  VIDEO_SAFETY_MODELS,
  VIDEO_WAN_MODELS,
  wanPositivePrompt,
  wanSize,
} from "./models";
import { fileToDataUri, isImageFile, isUsableReferenceImage, sleep, uuid } from "./media";
import { isNativeApp, persistNativeResult, saveAndShare, saveToDeviceGallery } from "./native";
import type { ImageTabId, LocalImage, StudioResult, TabState, VideoTabId } from "./types";

const RUNWARE = "https://api.runware.ai/v1";
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const KEY_STORAGE = "runware_api_key";
const OPENROUTER_KEY_STORAGE = "openrouter_api_key";
const GROK_MODEL = "x-ai/grok-4.6";
const TTL = 60;

type RunwareEnvelope = {
  data?: Array<Record<string, unknown>>;
  errors?: Array<{ code?: string; message?: string; taskUUID?: string }>;
};

export type Health = { ok: boolean; configured: boolean; grok: boolean; native: boolean };

export type EnhancePromptInput = {
  prompt: string;
  kind: "image" | "video";
  family: string;
  refCount: number;
  promptMax: number;
};

function storedKey() {
  return (localStorage.getItem(KEY_STORAGE) || "").trim();
}

export function saveApiKey(key: string) {
  const value = key.trim();
  if (value) localStorage.setItem(KEY_STORAGE, value);
  else localStorage.removeItem(KEY_STORAGE);
}

export function hasLocalApiKey() {
  return Boolean(storedKey());
}

function storedOpenRouterKey() {
  return (localStorage.getItem(OPENROUTER_KEY_STORAGE) || "").trim();
}

export function saveOpenRouterKey(key: string) {
  const value = key.trim();
  if (value) localStorage.setItem(OPENROUTER_KEY_STORAGE, value);
  else localStorage.removeItem(OPENROUTER_KEY_STORAGE);
}

export function hasLocalOpenRouterKey() {
  return Boolean(storedOpenRouterKey());
}

function errorMessage(payload: RunwareEnvelope, fallback = "Runware request failed") {
  return payload.errors?.map((e) => e.message).filter(Boolean).join(" · ") || fallback;
}

async function postDirect(tasks: unknown[], key: string): Promise<RunwareEnvelope> {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.post({
      url: RUNWARE,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      data: tasks,
      connectTimeout: 600000,
      readTimeout: 600000,
    });
    const data = res.data as RunwareEnvelope;
    if (res.status >= 400) {
      throw new Error(errorMessage(data, `Runware HTTP ${res.status}`));
    }
    return data;
  }

  const res = await fetch(RUNWARE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tasks),
  });
  const payload = (await res.json()) as RunwareEnvelope;
  if (!res.ok) throw new Error(errorMessage(payload, `Runware HTTP ${res.status}`));
  return payload;
}

async function loadDeviceConfig() {
  try {
    const res = await fetch("/app-config.json", { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { apiKey?: string; openrouterApiKey?: string };
    if (body.apiKey && !storedKey()) saveApiKey(body.apiKey);
    if (body.openrouterApiKey && !storedOpenRouterKey()) saveOpenRouterKey(body.openrouterApiKey);
  } catch {
    /* optional APK inject */
  }
}

let deviceConfigReady: Promise<void> | null = null;
export function ensureDeviceConfig() {
  if (!deviceConfigReady) deviceConfigReady = loadDeviceConfig();
  return deviceConfigReady;
}

export async function postRunware(tasks: unknown[]): Promise<RunwareEnvelope> {
  await ensureDeviceConfig();
  try {
    const res = await fetch("/api/runware", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tasks),
    });
    if (res.status !== 404 && res.status !== 502) {
      const payload = (await res.json()) as RunwareEnvelope;
      if (payload.errors?.[0]?.code === "missingApiKey" && storedKey()) {
        return postDirect(tasks, storedKey());
      }
      if (!res.ok) throw new Error(errorMessage(payload, `HTTP ${res.status}`));
      return payload;
    }
  } catch (error) {
    if (storedKey() || Capacitor.isNativePlatform()) {
      const key = storedKey();
      if (!key) throw new Error("Add your Runware API key in Settings.");
      return postDirect(tasks, key);
    }
    throw error instanceof Error ? error : new Error("Could not reach the API proxy.");
  }

  const key = storedKey();
  if (!key) throw new Error("Add your Runware API key in Settings.");
  return postDirect(tasks, key);
}

export async function checkHealth(): Promise<Health> {
  await ensureDeviceConfig();
  try {
    const res = await fetch("/api/health");
    if (res.ok) {
      const body = (await res.json()) as { ok?: boolean; configured?: boolean; grok?: boolean };
      const configured = Boolean(body.configured) || hasLocalApiKey();
      const grok = Boolean(body.grok) || hasLocalOpenRouterKey();
      return { ok: true, configured, grok, native: Capacitor.isNativePlatform() };
    }
  } catch {
    /* proxy unavailable — APK / direct mode */
  }
  return {
    ok: hasLocalApiKey(),
    configured: hasLocalApiKey(),
    grok: hasLocalOpenRouterKey(),
    native: Capacitor.isNativePlatform(),
  };
}

function isFinishedRow(row: Record<string, unknown>) {
  return Boolean(
    row.status === "success" ||
      row.imageURL ||
      row.imageDataURI ||
      row.imageBase64Data ||
      row.videoURL
  );
}

function uuidFromMediaUrl(url: string) {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i.exec(url)?.[1];
}

function collectWipeIds(rows: Array<Record<string, unknown>>) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.imageUUID === "string" && row.imageUUID) ids.add(row.imageUUID);
    if (typeof row.videoUUID === "string" && row.videoUUID) ids.add(row.videoUUID);
    if (typeof row.mediaUUID === "string" && row.mediaUUID) ids.add(row.mediaUUID);
    if (typeof row.imageURL === "string") {
      const fromUrl = uuidFromMediaUrl(row.imageURL);
      if (fromUrl) ids.add(fromUrl);
    }
    if (typeof row.videoURL === "string") {
      const fromUrl = uuidFromMediaUrl(row.videoURL);
      if (fromUrl) ids.add(fromUrl);
    }
  }
  return [...ids];
}

const wipeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleWipe(ids: Array<string | undefined>) {
  for (const id of ids) {
    if (!id) continue;
    const prev = wipeTimers.get(id);
    if (prev) clearTimeout(prev);
    wipeTimers.set(
      id,
      setTimeout(() => {
        wipeTimers.delete(id);
        void deleteMedia(id);
      }, TTL * 1000)
    );
  }
}

type FinishedTask = { row: Record<string, unknown>; wipeIds: string[] };

async function poll(taskUUID: string, onProgress?: (n: number) => void): Promise<FinishedTask> {
  let delay = 2000;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(delay);
    const payload = await postRunware([{ taskType: "getResponse", taskUUID }]);
    if (payload.errors?.length) throw new Error(errorMessage(payload));
    const rows = payload.data || [];
    const failed = rows.find((row) => row.status === "error");
    if (failed) {
      const err = failed.error as { message?: string } | undefined;
      throw new Error(err?.message || "Generation failed.");
    }
    const done = rows.find(isFinishedRow);
    if (done) return { row: done, wipeIds: collectWipeIds(rows) };
    const processing = rows.find((row) => typeof row.progress === "number");
    if (processing && typeof processing.progress === "number") onProgress?.(processing.progress);
    delay = Math.min(Math.round(delay * 1.25), 8000);
  }
  throw new Error("Timed out waiting for Runware.");
}

async function runTask(task: Record<string, unknown>, onProgress?: (n: number) => void): Promise<FinishedTask> {
  const payload = await postRunware([task]);
  if (payload.errors?.length) throw new Error(errorMessage(payload));
  const rows = payload.data || [];
  const first = rows[0];
  if (!first) throw new Error("Empty Runware response.");
  if (isFinishedRow(first)) {
    return { row: first, wipeIds: collectWipeIds(rows) };
  }
  return poll(String(task.taskUUID), onProgress);
}

function resultUrl(row: Record<string, unknown>): { url: string; uuid?: string; kind: "image" | "video" } {
  if (typeof row.imageDataURI === "string") {
    return { url: row.imageDataURI, uuid: String(row.imageUUID || ""), kind: "image" };
  }
  if (typeof row.imageBase64Data === "string") {
    return { url: `data:image/png;base64,${row.imageBase64Data}`, uuid: String(row.imageUUID || ""), kind: "image" };
  }
  if (typeof row.imageURL === "string") {
    return {
      url: row.imageURL,
      uuid: String(row.imageUUID || uuidFromMediaUrl(row.imageURL) || ""),
      kind: "image",
    };
  }
  if (typeof row.videoURL === "string") {
    return {
      url: row.videoURL,
      uuid: String(row.videoUUID || uuidFromMediaUrl(row.videoURL) || ""),
      kind: "video",
    };
  }
  throw new Error("Runware returned no media.");
}

export async function deleteMedia(mediaUUID: string) {
  if (!mediaUUID) return;
  try {
    await postRunware([
      {
        taskType: "mediaStorage",
        taskUUID: uuid(),
        operation: "delete",
        media: mediaUUID,
      },
    ]);
  } catch {
    /* TTL 60s still wipes it */
  }
}

const GROK_SYSTEM = `You expand user prompts for AI image and video generators.
Adult sexual content between consenting adults is allowed. Keep explicit wording when the user is explicit. Do not switch to euphemisms.
Never include minors or anyone who appears under 18.
If the user mentions the first image, second image, or third image, keep those roles and do not drop them.
Add concrete camera, lighting, body, setting, and action detail that helps the generator.
Return only the enhanced prompt. No title, no quotes, no markdown, no explanation.`;

function grokEnhanceMessages(input: EnhancePromptInput) {
  const refs =
    input.refCount < 1
      ? "No reference images."
      : `${input.refCount} reference image${input.refCount === 1 ? "" : "s"} attached. Refer to them as the first image, the second image, the third image.`;
  return [
    { role: "system", content: GROK_SYSTEM },
    {
      role: "user",
      content: `Target: ${input.kind} generation (${input.family}).
${refs}
Max length: ${input.promptMax} characters.
Expand this prompt:\n${input.prompt.trim()}`,
    },
  ];
}

function grokOutputText(payload: Record<string, unknown>) {
  const choices = payload.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const fromChat = choices?.[0]?.message?.content;
  if (typeof fromChat === "string" && fromChat.trim()) return fromChat;
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  return "";
}

function cleanEnhancedPrompt(text: string, promptMax: number) {
  let next = text.trim();
  next = next.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
  next = next.replace(/^["']|["']$/g, "").trim();
  if (next.length > promptMax) next = next.slice(0, promptMax).trim();
  return next;
}

function grokErrorMessage(payload: Record<string, unknown>, fallback: string) {
  const err = payload.error as { message?: string } | string | undefined;
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object" && typeof err.message === "string" && err.message.trim()) return err.message;
  return fallback;
}

function enhanceBody(messages: Array<{ role: string; content: string }>, maxTokens: number) {
  return {
    model: GROK_MODEL,
    messages,
    stream: false,
    temperature: 0.7,
    max_tokens: maxTokens,
    provider: { order: ["xai", "x-ai"], allow_fallbacks: false },
  };
}

function openRouterHeaders(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/srican1982/seedream-studio",
    "X-Title": "Seedream Agent",
  };
}

async function openRouterRequest(body: Record<string, unknown>, key: string) {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.post({
      url: OPENROUTER,
      headers: openRouterHeaders(key),
      data: body,
      connectTimeout: 120000,
      readTimeout: 120000,
    });
    const data = (typeof res.data === "string" ? JSON.parse(res.data) : res.data) as Record<string, unknown>;
    if (res.status >= 400) throw new Error(grokErrorMessage(data, `OpenRouter HTTP ${res.status}`));
    return data;
  }
  const res = await fetch(OPENROUTER, {
    method: "POST",
    headers: openRouterHeaders(key),
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(grokErrorMessage(data, `OpenRouter HTTP ${res.status}`));
  return data;
}

async function postOpenRouterDirect(messages: Array<{ role: string; content: string }>, maxTokens: number, key: string) {
  const body = enhanceBody(messages, maxTokens);
  try {
    return await openRouterRequest(body, key);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/no endpoints? found/i.test(message)) throw error;
    const { provider: _ignored, ...fallback } = body;
    return openRouterRequest(fallback, key);
  }
}

async function postOpenRouter(messages: Array<{ role: string; content: string }>, maxTokens: number) {
  await ensureDeviceConfig();
  const missingKey = "Add your OpenRouter API key in Settings.";
  try {
    const res = await fetch("/api/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enhanceBody(messages, maxTokens)),
    });
    if (res.status !== 404 && res.status !== 502) {
      const payload = (await res.json()) as Record<string, unknown>;
      if (payload.error === "missingOpenRouterKey") {
        if (storedOpenRouterKey()) return postOpenRouterDirect(messages, maxTokens, storedOpenRouterKey());
        throw new Error(missingKey);
      }
      if (!res.ok) throw new Error(grokErrorMessage(payload, `OpenRouter HTTP ${res.status}`));
      return payload;
    }
  } catch (error) {
    if (storedOpenRouterKey() || Capacitor.isNativePlatform()) {
      const key = storedOpenRouterKey();
      if (!key) throw new Error(missingKey);
      return postOpenRouterDirect(messages, maxTokens, key);
    }
    throw error instanceof Error ? error : new Error("Could not reach the OpenRouter proxy.");
  }
  const key = storedOpenRouterKey();
  if (!key) throw new Error(missingKey);
  return postOpenRouterDirect(messages, maxTokens, key);
}

export async function enhancePrompt(input: EnhancePromptInput): Promise<string> {
  const source = input.prompt.trim();
  if (source.length < 2) throw new Error("Write a prompt first.");
  const maxTokens = Math.min(2048, Math.max(256, Math.ceil(input.promptMax / 2.5)));
  const payload = await postOpenRouter(grokEnhanceMessages(input), maxTokens);
  const text = cleanEnhancedPrompt(grokOutputText(payload), input.promptMax);
  if (!text) throw new Error("Grok returned no enhanced prompt.");
  return text;
}

export function canAutoEnhancePrompt(prompt: string) {
  return prompt.trim().length >= 2;
}

export async function completeGrok(system: string, user: string, maxTokens = 2500): Promise<string> {
  const payload = await postOpenRouter(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens
  );
  const text = grokOutputText(payload).trim();
  if (!text) throw new Error("Grok returned no text.");
  return text;
}

export async function generateImage(
  tab: ImageTabId,
  state: TabState,
  onProgress?: (n: number) => void
): Promise<StudioResult> {
  const model = findImage(tab);
  const refs = state.images.map((img) => img.dataUri).filter(isUsableReferenceImage);
  if (model.requiresReference && refs.length < 1) {
    throw new Error("Add one reference image for Qwen Layered.");
  }
  const taskUUID = uuid();
  const qwenRefs = model.family === "qwen" && tab !== "qwen-layered";
  const task: Record<string, unknown> = {
    taskType: "imageInference",
    taskUUID,
    model: model.airId,
    positivePrompt: qwenRefs ? qwenPositivePrompt(state.prompt, refs.length) : state.prompt.trim(),
    outputType: "URL",
    outputFormat: tab === "qwen-layered" ? "TIFF" : state.imageFormat,
    safety: { checkContent: state.safety },
    ttl: TTL,
    deliveryMethod: "async",
  };
  if (!model.skipDimensions) {
    const size = imageSize(tab, state.aspect, state.quality);
    const fitted = qwenRefs && refs.length ? fitQwenRefSize(size.width, size.height) : size;
    task.width = fitted.width;
    task.height = fitted.height;
  }
  if (refs.length) {
    task.inputs = { referenceImages: refs };
    if (qwenRefs) {
      task.providerSettings = { alibaba: { promptExtend: false } };
    }
  }
  if (tab === "seedream-5-pro" && state.quality === "high") {
    task.settings = { thinking: true };
  }

  const { row, wipeIds } = await runTask(task, onProgress);
  const media = resultUrl(row);
  scheduleWipe([...wipeIds, media.uuid]);
  const result: StudioResult = {
    kind: "image",
    url: media.url,
    uuid: media.uuid,
    cost: typeof row.cost === "number" ? row.cost : undefined,
    filename: `${tab}-${Date.now()}.${tab === "qwen-layered" ? "tiff" : state.imageFormat.toLowerCase()}`,
  };
  const persisted = await persistNativeResult(result);
  return {
    ...result,
    url: persisted.url,
    localPath: persisted.localPath,
    remoteUrl: /^https?:\/\//i.test(result.url) ? result.url : undefined,
    uuid: persisted.localPath ? undefined : result.uuid,
  };
}

export async function generateVideo(
  tab: VideoTabId,
  state: TabState,
  onProgress?: (n: number) => void
): Promise<StudioResult> {
  const model = findVideo(tab);
  const taskUUID = uuid();
  const duration = model.durations.includes(state.duration) ? state.duration : model.durations[0];
  const resolution = model.resolutions.includes(state.resolution) ? state.resolution : model.resolutions[0];
  const images = state.images.map((img) => img.dataUri).filter(isUsableReferenceImage);
  const task: Record<string, unknown> = {
    taskType: "videoInference",
    taskUUID,
    model: model.airId,
    positivePrompt: VIDEO_WAN_MODELS.includes(tab)
      ? wanPositivePrompt(state.prompt, state.audio)
      : state.prompt.trim(),
    duration,
    outputType: "URL",
    outputFormat: state.videoFormat,
    ttl: TTL,
    deliveryMethod: "async",
  };

  if (VIDEO_WAN_MODELS.includes(tab)) {
    if (images.length) {
      task.inputs = { referenceImages: images };
      task.resolution = resolution;
    } else {
      const size = wanSize(state.aspect, resolution);
      task.width = size.width;
      task.height = size.height;
    }
    task.safety = { checkContent: state.safety, mode: "fast" };
    task.settings = {
      promptExtend: false,
      audio: state.audio,
    };
  } else {
    task.resolution = resolution;
    if (images.length) task.inputs = { frameImages: images };
    if (VIDEO_SAFETY_MODELS.includes(tab)) {
      task.safety = { checkContent: state.safety };
    }
    if (state.audio && VIDEO_AUDIO_MODELS.includes(tab)) {
      task.settings = { audio: true };
    }
  }

  const { row, wipeIds } = await runTask(task, onProgress);
  const media = resultUrl(row);
  scheduleWipe([...wipeIds, media.uuid]);
  const result: StudioResult = {
    kind: "video",
    url: media.url,
    uuid: media.uuid,
    cost: typeof row.cost === "number" ? row.cost : undefined,
    filename: `${tab}-${Date.now()}.${state.videoFormat.toLowerCase()}`,
  };
  const persisted = await persistNativeResult(result);
  return {
    ...result,
    url: persisted.url,
    localPath: persisted.localPath,
    remoteUrl: /^https?:\/\//i.test(result.url) ? result.url : undefined,
    uuid: persisted.localPath ? undefined : result.uuid,
  };
}

export async function downloadResult(result: StudioResult) {
  if (isNativeApp()) {
    const source = result.localPath || result.remoteUrl || result.url;
    try {
      const how = await saveToDeviceGallery(source, result.filename, result.kind === "video");
      if (result.uuid) void deleteMedia(result.uuid);
      return how;
    } catch (error) {
      if (result.remoteUrl && result.remoteUrl !== source) {
        const how = await saveToDeviceGallery(result.remoteUrl, result.filename, result.kind === "video");
        if (result.uuid) void deleteMedia(result.uuid);
        return how;
      }
      throw error;
    }
  }

  if (result.url.startsWith("data:")) {
    const res = await fetch(result.url);
    const how = await saveAndShare(await res.blob(), result.filename);
    if (result.uuid) void deleteMedia(result.uuid);
    return how;
  }

  const proxy = `/api/media?url=${encodeURIComponent(result.url)}`;
  let blob: Blob | null = null;
  try {
    const res = await fetch(proxy);
    if (res.ok) blob = await res.blob();
  } catch {
    blob = null;
  }

  if (!blob) {
    if (isNativeApp()) {
      const http = await CapacitorHttp.get({ url: result.url, responseType: "blob", readTimeout: 600000 });
      const raw = String(http.data || "");
      blob = await (await fetch(`data:application/octet-stream;base64,${raw}`)).blob();
    } else {
      const res = await fetch(result.url);
      if (!res.ok) throw new Error("Could not download media.");
      blob = await res.blob();
    }
  }

  const how = await saveAndShare(blob, result.filename);
  if (result.uuid) void deleteMedia(result.uuid);
  return how;
}

export async function addImages(existing: LocalImage[], files: FileList | File[], max: number): Promise<LocalImage[]> {
  const room = Math.max(0, max - existing.length);
  const incoming = Array.from(files).slice(0, room);
  const next: LocalImage[] = [];
  for (const file of incoming) {
    if (file.type && !isImageFile(file)) continue;
    const dataUri = await fileToDataUri(file);
    if (!dataUri) continue;
    next.push({
      id: uuid(),
      name: file.name || `image-${existing.length + next.length + 1}`,
      preview: dataUri,
      dataUri,
    });
  }
  return [...existing, ...next];
}
