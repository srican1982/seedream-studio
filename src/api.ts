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
import { fileToDataUri, fitImageDataUriToAspect, isImageFile, isUsableMediaUrl, isUsableReferenceImage, uuid } from "./media";
import { nativePollRunware, nativeSleep, withKeepAlive } from "./keep-alive";
import { isNativeApp, persistNativeResult, saveAndShare, saveToDeviceGallery } from "./native";
import type { ImageTabId, LocalImage, StudioResult, TabState, VideoTabId } from "./types";

const RUNWARE = "https://api.runware.ai/v1";
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const KEY_STORAGE = "runware_api_key";
const OPENROUTER_KEY_STORAGE = "openrouter_api_key";
export const BRAIN_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "x-ai/grok-4.6", label: "Grok 4.6" },
] as const;

export type BrainModelId = (typeof BRAIN_MODELS)[number]["id"];
export const DEFAULT_BRAIN: BrainModelId = "deepseek/deepseek-v4.1-flash";
const BRAIN_STORAGE = "seedream_agent_brain";
const TTL = 60;

export function loadBrainModel(): BrainModelId {
  const stored = (typeof localStorage !== "undefined" && localStorage.getItem(BRAIN_STORAGE)) || "";
  return BRAIN_MODELS.some((item) => item.id === stored) ? (stored as BrainModelId) : DEFAULT_BRAIN;
}

export function saveBrainModel(id: BrainModelId) {
  localStorage.setItem(BRAIN_STORAGE, id);
}

export function brainFromText(text: string): BrainModelId | null {
  if (/\b(deepseek|venice)\b/i.test(text)) return "deepseek/deepseek-v4.1-flash";
  if (/\bgrok\b/i.test(text)) return "x-ai/grok-4.6";
  return null;
}

function providerFor(model: string) {
  if (model.startsWith("deepseek/")) return { order: ["venice"], allow_fallbacks: false };
  return { order: ["xai", "x-ai"], allow_fallbacks: false, data_collection: "deny" as const, zdr: true };
}

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

function rowErrorMessage(row: Record<string, unknown>) {
  const err = row.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const parts = [obj.message, obj.error, obj.code].filter((value) => typeof value === "string" && value.trim()) as string[];
    if (parts.length) return parts.join(" · ");
    try {
      return JSON.stringify(err);
    } catch {
      /* ignore */
    }
  }
  if (typeof row.message === "string" && row.message.trim()) return row.message.trim();
  if (typeof row.errorMessage === "string" && row.errorMessage.trim()) return row.errorMessage.trim();
  return "Generation failed.";
}

function scrubWanPrompt(
  prompt: string,
  slots: { frames?: boolean; refs?: boolean; video?: boolean; audio?: boolean }
) {
  let text = prompt.trim();
  if (!slots.refs) text = text.replace(/\bImages?\s*\d+\b/gi, slots.frames ? "the opening picture" : "the subject");
  if (!slots.video) text = text.replace(/\bVideos?\s*\d+\b/gi, "the motion");
  if (!slots.audio) text = text.replace(/\bAudios?\s*\d+\b/gi, "the sound");
  return text;
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
    const data = parseRunwareBody(res.data);
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

function parseRunwareBody(data: unknown): RunwareEnvelope {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as RunwareEnvelope;
    } catch {
      return { errors: [{ message: data }] };
    }
  }
  if (data && typeof data === "object") return data as RunwareEnvelope;
  return { errors: [{ message: "Empty Runware response." }] };
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

async function uploadRunwareMedia(media: string): Promise<string> {
  const value = media.trim();
  if (!value) throw new Error("Missing file.");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  if (isUsableMediaUrl(value) && /^https?:\/\//i.test(value)) return value;
  const payload = await postRunware([
    {
      taskType: "mediaStorage",
      taskUUID: uuid(),
      operation: "upload",
      media: value,
    },
  ]);
  if (payload.errors?.length) throw new Error(errorMessage(payload, "Could not upload the file."));
  const row = payload.data?.[0] || {};
  const url = String(row.mediaURL || "");
  const id = String(row.mediaUUID || "");
  if (/^https?:\/\//i.test(url)) return url;
  if (id) return id;
  if (url) return url;
  throw new Error("Could not upload the file.");
}

async function uploadRunwareImage(image: string): Promise<string> {
  const value = image.trim();
  if (!value) throw new Error("Missing image.");
  if (isUsableMediaUrl(value) && /^https?:\/\//i.test(value)) return value;
  try {
    return await uploadRunwareMedia(value);
  } catch {
    /* imageUpload next */
  }
  try {
    const payload = await postRunware([
      {
        taskType: "imageUpload",
        taskUUID: uuid(),
        image: value,
      },
    ]);
    if (!payload.errors?.length) {
      const row = payload.data?.[0] || {};
      const uploaded = String(row.imageURL || row.imageUUID || "");
      if (uploaded) return uploaded;
    }
  } catch {
    /* keep the data URI — native upload can fail while inference still accepts it */
  }
  return value;
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

type FinishedTask = { row: Record<string, unknown>; wipeIds: string[]; localPath?: string };

async function poll(taskUUID: string, onProgress?: (n: number) => void): Promise<FinishedTask> {
  const key = storedKey();
  if (key && Capacitor.isNativePlatform()) {
    const native = await nativePollRunware(taskUUID, key);
    if (native) return native;
  }
  let delay = 2000;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await nativeSleep(delay);
    const payload = await postRunware([{ taskType: "getResponse", taskUUID }]);
    if (payload.errors?.length) throw new Error(errorMessage(payload));
    const rows = payload.data || [];
    const failed = rows.find((row) => row.status === "error");
    if (failed) {
      throw new Error(rowErrorMessage(failed));
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

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: string;
  content: string | ChatContentPart[];
};

const GROK_SYSTEM = `You convert a user request into a better prompt for an image or video generator.
Read Sinhala and English, including spoken Sri Lankan Sinhala mixed with common English words.
Adult sexual content between consenting adults 18 or older is allowed. Keep explicit wording. Do not lecture, moralize, refuse, or add safety sermons.
Never include minors or anyone who appears under 18.
If they name a position, act, or pose, describe the bodies and action clearly. The generator may not know the name.
If the user mentions the first image, second image, or third image, keep those roles.
If they name some photos for the people and other photos for poses, follow those roles. Copy the named people's faces exactly. From pose photos take only the body pose. Do not blend, morph, mix, or average faces. Do not copy a pose photo's face, hair, clothes, tattoos, or identity.
If they did not mention clothes, lighting, or location, keep those the same as the first image. Do not invent a new outfit, light, or place.
Return only the prompt. No title, no quotes, no markdown, no explanation.`;

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

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (typeof value === "object") {
    const part = value as Record<string, unknown>;
    return collectText(part.text ?? part.content ?? part.output_text ?? "");
  }
  return "";
}

function grokOutputText(payload: Record<string, unknown>) {
  const choices = payload.choices as Array<{ text?: unknown; message?: Record<string, unknown> }> | undefined;
  const message = choices?.[0]?.message;
  const content = collectText(message?.content || choices?.[0]?.text || payload.output_text).trim();
  if (content) return content;
  const reasoning = collectText(message?.reasoning || message?.reasoning_content).trim();
  if (reasoning && /[{[]/.test(reasoning)) return reasoning;
  return "";
}

function emptyChatError(payload: Record<string, unknown>) {
  const choices = payload.choices as Array<{ finish_reason?: string; message?: { refusal?: string } }> | undefined;
  const finish = choices?.[0]?.finish_reason || "";
  const refusal = choices?.[0]?.message?.refusal?.trim();
  if (refusal) return refusal;
  if (finish === "length") return "The chat model ran out of space. Send that again.";
  if (payload.error) return grokErrorMessage(payload, "The chat model came back empty. Send that again.");
  return "The chat model came back empty. Send that again.";
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

function enhanceBody(messages: ChatMessage[], maxTokens: number, model: string, temperature = 0.7) {
  return {
    model,
    messages,
    stream: false,
    temperature,
    max_tokens: maxTokens,
    provider: providerFor(model),
  };
}

function openRouterHeaders(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/srican1982/seedream-studio",
    "X-Title": "AI Story",
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
    const data =
      typeof res.data === "string"
        ? (JSON.parse(res.data) as Record<string, unknown>)
        : ((res.data || {}) as Record<string, unknown>);
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

async function postOpenRouterDirect(
  messages: ChatMessage[],
  maxTokens: number,
  key: string,
  model: string,
  temperature = 0.7
) {
  const body = enhanceBody(messages, maxTokens, model, temperature);
  try {
    return await openRouterRequest(body, key);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/no endpoints? found/i.test(message)) throw error;
    const { provider: _ignored, ...fallback } = body;
    return openRouterRequest(fallback, key);
  }
}

async function postOpenRouter(
  messages: ChatMessage[],
  maxTokens: number,
  model = loadBrainModel(),
  temperature = 0.7
) {
  await ensureDeviceConfig();
  const missingKey = "Add your OpenRouter API key in Settings.";
  try {
    const res = await fetch("/api/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enhanceBody(messages, maxTokens, model, temperature)),
    });
    if (res.status !== 404 && res.status !== 502) {
      const payload = (await res.json()) as Record<string, unknown>;
      if (payload.error === "missingOpenRouterKey") {
        if (storedOpenRouterKey()) return postOpenRouterDirect(messages, maxTokens, storedOpenRouterKey(), model, temperature);
        throw new Error(missingKey);
      }
      if (!res.ok) throw new Error(grokErrorMessage(payload, `OpenRouter HTTP ${res.status}`));
      return payload;
    }
  } catch (error) {
    if (storedOpenRouterKey() || Capacitor.isNativePlatform()) {
      const key = storedOpenRouterKey();
      if (!key) throw new Error(missingKey);
      return postOpenRouterDirect(messages, maxTokens, key, model, temperature);
    }
    throw error instanceof Error ? error : new Error("Could not reach the OpenRouter proxy.");
  }
  const key = storedOpenRouterKey();
  if (!key) throw new Error(missingKey);
  return postOpenRouterDirect(messages, maxTokens, key, model, temperature);
}

export async function enhancePrompt(input: EnhancePromptInput): Promise<string> {
  const source = input.prompt.trim();
  if (source.length < 2) throw new Error("Write a prompt first.");
  const maxTokens = Math.min(2048, Math.max(256, Math.ceil(input.promptMax / 2.5)));
  const messages = grokEnhanceMessages(input);
  for (const extra of [0, 1024]) {
    const payload = await postOpenRouter(messages, maxTokens + extra);
    const text = cleanEnhancedPrompt(grokOutputText(payload), input.promptMax);
    if (text) return text;
  }
  throw new Error("The chat model came back empty. Send that again.");
}

export function canAutoEnhancePrompt(prompt: string) {
  return prompt.trim().length >= 2;
}

export async function completeChat(
  system: string,
  user: string | ChatContentPart[],
  maxTokens = 2500,
  model = loadBrainModel(),
  temperature = 0.4
): Promise<string> {
  return withKeepAlive("Thinking… You can switch apps.", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let lastEmpty = "The chat model came back empty. Send that again.";
    for (const extra of [0, 2048]) {
      try {
        const payload = await postOpenRouter(messages, maxTokens + extra, model, extra ? 0.2 : temperature);
        const text = grokOutputText(payload).trim();
        if (text) return text;
        lastEmpty = emptyChatError(payload);
      } catch (error) {
        lastEmpty = error instanceof Error ? error.message : lastEmpty;
        if (!extra) continue;
        throw error instanceof Error ? error : new Error(lastEmpty);
      }
    }
    throw new Error(lastEmpty);
  });
}

export async function completeGrok(system: string, user: string, maxTokens = 2500): Promise<string> {
  return completeChat(system, user, maxTokens, loadBrainModel());
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

  return withKeepAlive("Generating a picture… You can switch apps.", async () =>
    toStudioResult("image", tab, state, await runTask(task, onProgress))
  );
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
    const stillSrc = (img: { dataUri?: string; preview?: string }) => img.dataUri || img.preview || "";
    const frames = (state.wanFrames || [])
      .map((img) => stillSrc(img))
      .filter(isUsableReferenceImage);
    const refs = images.length ? images : state.images.map((img) => stillSrc(img)).filter(isUsableReferenceImage);
    const fittedFrames = frames.length ? await Promise.all(frames.slice(0, 2).map((image) => fitImageDataUriToAspect(image, state.aspect))) : [];
    const videos = fittedFrames.length
      ? []
      : await Promise.all((state.wanVideos || []).filter(Boolean).slice(0, 5).map((item) => uploadRunwareMedia(item)));
    const audios = fittedFrames.length
      ? []
      : await Promise.all((state.wanAudios || []).filter(Boolean).slice(0, 5).map((item) => uploadRunwareMedia(item)));
    if (fittedFrames.length) {
      task.model = findVideo("wan-3").airId;
      task.inputs = { frameImages: await Promise.all(fittedFrames.map(uploadRunwareImage)) };
      task.resolution = resolution;
      task.positivePrompt = scrubWanPrompt(state.prompt.trim(), { frames: true });
      task.numberResults = 1;
      task.outputQuality = 95;
      task.includeCost = false;
      delete task.ttl;
    } else {
      const fittedRefs = refs.length ? await Promise.all(refs.slice(0, 10).map((image) => fitImageDataUriToAspect(image, state.aspect))) : [];
      const inputs: Record<string, unknown> = {};
      if (fittedRefs.length) inputs.referenceImages = fittedRefs;
      if (videos.length) inputs.referenceVideos = videos;
      if (audios.length) inputs.referenceAudios = audios;
      if (Object.keys(inputs).length) task.inputs = inputs;
      task.positivePrompt = scrubWanPrompt(String(task.positivePrompt || ""), {
        refs: Boolean(fittedRefs.length),
        video: Boolean(videos.length),
        audio: Boolean(audios.length),
      });
      if (fittedRefs.length || videos.length) task.resolution = resolution;
      else {
        const size = wanSize(state.aspect, resolution);
        task.width = size.width;
        task.height = size.height;
      }
      task.safety = { checkContent: state.safety, mode: "fast" };
      task.settings = {
        promptExtend: false,
        audio: state.audio,
      };
    }
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

  const resultTab = String(task.model) === findVideo("wan-3").airId ? "wan-3" : tab;
  return withKeepAlive("Generating a video… You can switch apps.", async () =>
    toStudioResult("video", resultTab, state, await runTask(task, onProgress))
  );
}

async function toStudioResult(
  kind: "image" | "video",
  tab: string,
  state: TabState,
  finished: FinishedTask
): Promise<StudioResult> {
  const media = resultUrl(finished.row);
  scheduleWipe([...finished.wipeIds, media.uuid]);
  const ext =
    kind === "video"
      ? state.videoFormat.toLowerCase()
      : tab === "qwen-layered"
        ? "tiff"
        : state.imageFormat.toLowerCase();
  const result: StudioResult = {
    kind,
    url: media.url,
    uuid: media.uuid,
    cost: typeof finished.row.cost === "number" ? finished.row.cost : undefined,
    filename: `${tab}-${Date.now()}.${ext}`,
  };
  if (finished.localPath) {
    return {
      ...result,
      url: Capacitor.convertFileSrc(finished.localPath),
      localPath: finished.localPath,
      remoteUrl: /^https?:\/\//i.test(result.url) ? result.url : undefined,
      uuid: undefined,
    };
  }
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
