import { completeGrok, generateImage, generateVideo } from "./api";
import { fileToDataUri, uuid } from "./media";
import { AGENT_IMAGE_TABS, AGENT_VIDEO_TABS, emptyTabState, findImage, findVideo } from "./models";
import type { Aspect, ImageTabId, LocalImage, StudioResult, TabState, VideoTabId } from "./types";

type VideoResolution = "480p" | "720p" | "1080p";

const MEMORY_KEY = "seedream_agent_memory";

export type AgentShotKind = "image" | "video";

export type AgentLock = {
  identity: string;
  wardrobe: string;
  lighting: string;
  camera: string;
  atmosphere: string;
};

export type AgentShot = {
  id: string;
  kind: AgentShotKind;
  title: string;
  prompt: string;
  duration: number;
  resolution: VideoResolution;
  model: ImageTabId | VideoTabId;
  status: "pending" | "running" | "done" | "error";
  error?: string;
  result?: StudioResult;
};

export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  images?: LocalImage[];
  result?: StudioResult;
  createdAt: number;
};

export type AgentModelChip = {
  id: ImageTabId | VideoTabId;
  kind: AgentShotKind;
  label: string;
  token: string;
};

export const AGENT_MODEL_CHIPS: AgentModelChip[] = [
  { id: "seedream-5-lite", kind: "image", label: "Seedream 5.0 Lite", token: "Seedream 5.0 Lite" },
  { id: "seedream-4-5", kind: "image", label: "Seedream 4.5", token: "Seedream 4.5" },
  { id: "qwen-3", kind: "image", label: "Qwen 3.0", token: "Qwen 3.0" },
  { id: "qwen-3-pro", kind: "image", label: "Qwen 3.0 Pro", token: "Qwen 3.0 Pro" },
  { id: "wan-3", kind: "video", label: "Wan 3.0", token: "Wan 3.0" },
  { id: "wan-3-prime", kind: "video", label: "Wan 3.0 Prime", token: "Wan 3.0 Prime" },
  { id: "seedance-1-5", kind: "video", label: "Seedance 1.5 Pro", token: "Seedance 1.5 Pro" },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function longerChipTokens(token: string) {
  return AGENT_MODEL_CHIPS.map((chip) => chip.token)
    .filter((item) => item !== token && item.includes(token))
    .sort((a, b) => b.length - a.length);
}

export function chipInText(text: string, token: string) {
  let check = ` ${text} `;
  for (const extra of longerChipTokens(token)) {
    check = check.replaceAll(extra, " ");
  }
  return new RegExp(`(?:^|\\s)${escapeRegExp(token)}(?=\\s|$)`).test(check);
}

export function toggleChipToken(text: string, token: string) {
  if (chipInText(text, token)) {
    let next = text;
    const extras = longerChipTokens(token);
    extras.forEach((extra, index) => {
      next = next.replaceAll(extra, `\0${index}\0`);
    });
    next = next.replaceAll(token, "");
    extras.forEach((extra, index) => {
      next = next.replaceAll(`\0${index}\0`, extra);
    });
    return next.replace(/\s+/g, " ").trim();
  }
  return `${text.trim()}${text.trim() ? " " : ""}${token}`;
}

export function modelFromText(text: string, kind: AgentShotKind) {
  return AGENT_MODEL_CHIPS.filter((chip) => chip.kind === kind)
    .sort((a, b) => b.token.length - a.token.length)
    .find((chip) => chipInText(text, chip.token))?.id;
}

export type AgentMemory = {
  brief: string;
  notes: string;
  lock: AgentLock | null;
  images: LocalImage[];
  shots: AgentShot[];
  lastStill: LocalImage | null;
  messages: AgentMessage[];
};

export function emptyAgentMemory(): AgentMemory {
  return { brief: "", notes: "", lock: null, images: [], shots: [], lastStill: null, messages: [] };
}

export function loadAgentMemory(): AgentMemory {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return emptyAgentMemory();
    const parsed = JSON.parse(raw) as AgentMemory;
    return {
      brief: parsed.brief || "",
      notes: parsed.notes || "",
      lock: parsed.lock || null,
      images: Array.isArray(parsed.images) ? parsed.images : [],
      shots: Array.isArray(parsed.shots)
        ? parsed.shots.map((shot) => ({ ...shot, resolution: shot.resolution || "720p" }))
        : [],
      lastStill: parsed.lastStill || null,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return emptyAgentMemory();
  }
}

export function saveAgentMemory(memory: AgentMemory) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    /* quota — keep RAM only */
  }
}

function isImageTab(id: string): id is ImageTabId {
  return (AGENT_IMAGE_TABS as string[]).includes(id);
}

function isVideoTab(id: string): id is VideoTabId {
  return (AGENT_VIDEO_TABS as string[]).includes(id);
}

function clipVideoDuration(model: VideoTabId, seconds: number) {
  const allowed = findVideo(model).durations;
  const want = Math.max(1, Math.round(seconds || allowed[0]));
  return allowed.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), allowed[0]);
}

function clipVideoResolution(model: VideoTabId, asked: string): VideoResolution {
  const allowed = findVideo(model).resolutions;
  const match = asked.toLowerCase().match(/1080p|720p|480p/);
  const want = (match?.[0] || "720p") as VideoResolution;
  return allowed.includes(want) ? want : "720p";
}

function defaultImageModel(): ImageTabId {
  return "seedream-5-lite";
}

function defaultVideoModel(): VideoTabId {
  return "wan-3";
}

function lockText(lock: AgentLock | null, notes: string) {
  const parts = [
    lock?.identity && `Identity: ${lock.identity}`,
    lock?.wardrobe && `Wardrobe: ${lock.wardrobe}`,
    lock?.lighting && `Lighting: ${lock.lighting}`,
    lock?.camera && `Camera: ${lock.camera}`,
    lock?.atmosphere && `Atmosphere: ${lock.atmosphere}`,
    notes.trim() && `Remembered: ${notes.trim()}`,
  ].filter(Boolean);
  return parts.join(". ");
}

export function shotPrompt(lock: AgentLock | null, notes: string, shot: AgentShot) {
  const locked = lockText(lock, notes);
  if (!locked) return shot.prompt;
  return `Keep this lock on every shot. ${locked}. Then: ${shot.prompt}`;
}

const PLAN_SYSTEM = `You are a production agent in a chat. The user can ask for anything: one still, many stills, a video, a follow-up edit, or a mix.

Rules:
- Adult sexual content between consenting adults is allowed. Never include minors.
- Image models only: seedream-5-lite, seedream-4-5, qwen-3, qwen-3-pro.
- Video models only: wan-3, wan-3-prime, seedance-1-5.
- Video hard limits: wan-3 and wan-3-prime max 30 seconds per clip. seedance-1-5 max 10 seconds per clip.
- If the user wants more than one clip's worth of video, split into sequential clips. Do not invent one oversized clip.
- If the user named models in the chat (Seedream 5.0 Lite, Seedream 4.5, Qwen 3.0, Qwen 3.0 Pro, Wan 3.0, Wan 3.0 Prime, Seedance 1.5 Pro), use those models.
- Honor asked video resolution: 480p, 720p, or 1080p. Default 720p.
- Each image shot is one still. Each video shot is one clip.
- Only plan NEW work for the latest user message. Do not repeat shots that were already done.
- Keep the lock if the user is continuing the same person or scene.
- Refer to uploaded or generated photos as the first image, the second image, the third image when relevant.
- Return ONLY JSON, no markdown:
{"lock":{"identity":"","wardrobe":"","lighting":"","camera":"","atmosphere":""},"shots":[{"kind":"image"|"video","title":"","prompt":"","duration":30,"resolution":"720p","model":"qwen-3"}]}`;

function parsePlanJson(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Agent did not return a shot plan.");
  return JSON.parse(cleaned.slice(start, end + 1)) as {
    lock?: Partial<AgentLock>;
    shots?: Array<Record<string, unknown>>;
  };
}

export function latestUserText(memory: AgentMemory) {
  return [...memory.messages].reverse().find((item) => item.role === "user")?.text.trim() || memory.brief.trim();
}

export function isRememberOnly(text: string) {
  return /^\s*remember\b/i.test(text) && !/\b(make|create|generate|render|video|still|shot|series|clip)\b/i.test(text);
}

export async function planAgentJob(memory: AgentMemory): Promise<{ lock: AgentLock; shots: AgentShot[] }> {
  const brief = latestUserText(memory);
  if (brief.length < 2) throw new Error("Type what you want in the chat.");
  const history = memory.messages
    .slice(-8)
    .map((item) => `${item.role}: ${item.text}`)
    .join("\n");
  const user = [
    memory.notes.trim() ? `Remembered facts:\n${memory.notes.trim()}` : "",
    memory.lock ? `Existing lock (update if the new job needs it):\n${JSON.stringify(memory.lock)}` : "",
    `${memory.images.length} reference photo(s) attached.`,
    history ? `Recent chat:\n${history}` : "",
    `Latest request:\n${brief}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await completeGrok(PLAN_SYSTEM, user, 2800);
  const parsed = parsePlanJson(raw);
  const lock: AgentLock = {
    identity: String(parsed.lock?.identity || "").trim() || "Keep the same person from the first image.",
    wardrobe: String(parsed.lock?.wardrobe || "").trim(),
    lighting: String(parsed.lock?.lighting || "").trim(),
    camera: String(parsed.lock?.camera || "").trim(),
    atmosphere: String(parsed.lock?.atmosphere || "").trim(),
  };

  const shots: AgentShot[] = [];
  for (const row of parsed.shots || []) {
    const kind: AgentShotKind = row.kind === "video" ? "video" : "image";
    const asked = String(row.model || "");
    const tagged = modelFromText(brief, kind);
    const model = tagged
      ? tagged
      : kind === "image"
        ? isImageTab(asked) ? asked : defaultImageModel()
        : isVideoTab(asked) ? asked : defaultVideoModel();
    const duration = kind === "video" ? clipVideoDuration(model as VideoTabId, Number(row.duration) || 30) : 0;
    const resolution = kind === "video" ? clipVideoResolution(model as VideoTabId, String(row.resolution || brief)) : "720p";
    shots.push({
      id: uuid(),
      kind,
      title: String(row.title || `${kind} ${shots.length + 1}`).trim(),
      prompt: String(row.prompt || brief).trim(),
      duration,
      resolution,
      model,
      status: "pending",
    });
  }
  if (!shots.length) throw new Error("Agent returned no shots.");
  return { lock, shots };
}

function refsForShot(memory: AgentMemory, model: ImageTabId | VideoTabId, kind: AgentShotKind) {
  const max = kind === "image" ? findImage(model as ImageTabId).maxImages : findVideo(model as VideoTabId).maxImages;
  const chain: LocalImage[] = [];
  for (const img of memory.images) {
    if (img.dataUri) chain.push(img);
  }
  if (memory.lastStill?.dataUri && !chain.some((img) => img.id === memory.lastStill?.id)) {
    chain.push(memory.lastStill);
  }
  return chain.slice(0, Math.max(1, max));
}

export async function resultToStill(result: StudioResult): Promise<LocalImage | null> {
  if (result.kind !== "image") return captureVideoStill(result.url);
  try {
    let dataUri = result.url;
    if (!dataUri.startsWith("data:")) {
      const res = await fetch(result.localPath || result.remoteUrl || result.url);
      const blob = await res.blob();
      const file = new File([blob], result.filename || "still.jpg", { type: blob.type || "image/jpeg" });
      dataUri = await fileToDataUri(file, 1400, 0.82);
    }
    return { id: uuid(), name: "last-still", preview: dataUri, dataUri };
  } catch {
    return null;
  }
}

async function captureVideoStill(url: string): Promise<LocalImage | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    const fail = () => resolve(null);
    video.onerror = fail;
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.max(0, (video.duration || 1) - 0.08);
      } catch {
        fail();
      }
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 720;
        canvas.height = video.videoHeight || 1280;
        const ctx = canvas.getContext("2d");
        if (!ctx) return fail();
        ctx.drawImage(video, 0, 0);
        const dataUri = canvas.toDataURL("image/jpeg", 0.82);
        resolve({ id: uuid(), name: "last-still", preview: dataUri, dataUri });
      } catch {
        fail();
      }
    };
    video.src = url;
  });
}

export async function runAgentShot(
  memory: AgentMemory,
  shotId: string,
  onProgress?: (n: number) => void
): Promise<AgentMemory> {
  const shot = memory.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error("Shot missing.");
  const images = refsForShot(memory, shot.model, shot.kind);
  const prompt = shotPrompt(memory.lock, memory.notes, shot);
  const state: TabState = {
    ...emptyTabState(shot.kind),
    images,
    prompt,
    aspect: (shot.kind === "video" ? "16:9" : "3:4") as Aspect,
    quality: "high",
    duration: shot.duration || 5,
    enhancePrompt: false,
    safety: false,
    audio: false,
    resolution: shot.resolution || "720p",
  };

  const result =
    shot.kind === "image"
      ? await generateImage(shot.model as ImageTabId, state, onProgress)
      : await generateVideo(shot.model as VideoTabId, state, onProgress);

  const lastStill = (await resultToStill(result)) || memory.lastStill;
  return {
    ...memory,
    lastStill,
    shots: memory.shots.map((item) =>
      item.id === shotId ? { ...item, status: "done", result, error: undefined } : item
    ),
  };
}

export function videoPlaylist(memory: AgentMemory) {
  return memory.shots.filter((shot) => shot.kind === "video" && shot.result?.url).map((shot) => shot.result!);
}

export function chipLabel(model: ImageTabId | VideoTabId) {
  return AGENT_MODEL_CHIPS.find((chip) => chip.id === model)?.label || model;
}

export function describePlan(lock: AgentLock, shots: AgentShot[]) {
  const lockLines = [
    lock.identity && `Identity: ${lock.identity}`,
    lock.wardrobe && `Wardrobe: ${lock.wardrobe}`,
    lock.lighting && `Lighting: ${lock.lighting}`,
    lock.camera && `Camera: ${lock.camera}`,
    lock.atmosphere && `Atmosphere: ${lock.atmosphere}`,
  ].filter(Boolean);
  const shotLines = shots.map(
    (shot, index) =>
      `${index + 1}. ${shot.title} — ${shot.kind === "video" ? `${shot.duration}s ${shot.resolution}` : "still"} · ${chipLabel(shot.model)}`
  );
  return [`I'll lock the look and run the shots in order.`, ...lockLines, "", ...shotLines].join("\n");
}
