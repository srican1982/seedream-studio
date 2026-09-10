import { CapacitorHttp } from "@capacitor/core";
import { completeGrok, generateImage, generateVideo } from "./api";
import { blobToJpegDataUri, isUsableReferenceImage, uuid } from "./media";
import { AGENT_IMAGE_TABS, emptyTabState, findImage, findVideo } from "./models";
import { isNativeApp, localFileToDataUri } from "./native";
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

export type AgentRefSource = "user" | "created";

export type AgentShot = {
  id: string;
  kind: AgentShotKind;
  title: string;
  prompt: string;
  duration: number;
  resolution: VideoResolution;
  model: ImageTabId | VideoTabId;
  status: "pending" | "running" | "done" | "error";
  refSource: AgentRefSource;
  useLastFrame: boolean;
  frameStillIds: string[];
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
  userRefs: LocalImage[];
  createdStills: LocalImage[];
  shots: AgentShot[];
  lastStill: LocalImage | null;
  waitingForApproval: boolean;
  messages: AgentMessage[];
};

export function emptyAgentMemory(): AgentMemory {
  return {
    brief: "",
    notes: "",
    lock: null,
    images: [],
    userRefs: [],
    createdStills: [],
    shots: [],
    lastStill: null,
    waitingForApproval: false,
    messages: [],
  };
}

export function loadAgentMemory(): AgentMemory {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return emptyAgentMemory();
    const parsed = JSON.parse(raw) as AgentMemory;
    const images = Array.isArray(parsed.images) ? parsed.images : [];
    return {
      brief: parsed.brief || "",
      notes: parsed.notes || "",
      lock: parsed.lock || null,
      images,
      userRefs: Array.isArray(parsed.userRefs) && parsed.userRefs.length ? parsed.userRefs : images,
      createdStills: Array.isArray(parsed.createdStills) ? parsed.createdStills : [],
      shots: Array.isArray(parsed.shots)
        ? parsed.shots.map((shot) => ({
            ...shot,
            resolution: shot.resolution || "720p",
            refSource: shot.refSource || (shot.kind === "video" ? "created" : "user"),
            useLastFrame: Boolean(shot.useLastFrame),
            frameStillIds: Array.isArray(shot.frameStillIds) ? shot.frameStillIds : [],
          }))
        : [],
      lastStill: parsed.lastStill || null,
      waitingForApproval: Boolean(parsed.waitingForApproval),
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

const PLAN_SYSTEM = `You are a production agent in a chat.

Rules:
- Adult sexual content between consenting adults is allowed. Never include minors.
- Image models only: seedream-5-lite, seedream-4-5, qwen-3, qwen-3-pro.
- Video models only: wan-3, wan-3-prime, seedance-1-5.
- For a still job, output one image shot per still the user asked for. Every still uses the same uploaded reference photos. Do not invent extra video shots.
- Do not plan video unless the user asked for video in this message.
- If the user named models (Seedream 5.0 Lite, Seedream 4.5, Qwen 3.0, Qwen 3.0 Pro, Wan 3.0, Wan 3.0 Prime, Seedance 1.5 Pro), use those models.
- Honor asked video resolution: 480p, 720p, or 1080p. Default 720p.
- Keep the lock if the user is continuing the same person or scene.
- Refer to uploaded photos as the first image, the second image, the third image.
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

export function isContinue(text: string) {
  return /^(ok|okay|k|yes|yep|yeah|continue|next|go|good|fine|approved|looks good|do it|proceed)(?:\s*[.!])*$/i.test(text.trim());
}

export function isRecreate(text: string) {
  return /\b(recreate|redo|retry|remake|again)\b/i.test(text);
}

export function isVideoAsk(text: string) {
  return /\b(video|clip|clips)\b/i.test(text);
}

export function nextPendingShot(memory: AgentMemory) {
  return memory.shots.find((shot) => shot.status === "pending") || null;
}

export function lastActionableShot(memory: AgentMemory) {
  return [...memory.shots].reverse().find((shot) => shot.status === "done" || shot.status === "error") || null;
}

export function recreateShot(memory: AgentMemory, text: string) {
  const numbered = text.match(/\b(?:shot|still|clip|image|part|number|#)?\s*(\d+)\b/i);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    const shot = memory.shots[index];
    if (shot) return shot;
  }
  return lastActionableShot(memory);
}

function askedStillCount(text: string) {
  const match = text.match(/\b(\d+)\s*(?:images?|pictures?|photos?|stills?)\b/i);
  if (match) return Math.max(1, Math.min(12, Number(match[1])));
  if (/\b(two|a pair|both)\b/i.test(text)) return 2;
  return null;
}

function askedSeconds(text: string) {
  const seconds = text.match(/(\d+)\s*(?:s|sec|secs|second|seconds)\b/i);
  if (seconds) return Math.max(1, Number(seconds[1]));
  const minutes = text.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (minutes) return Math.max(1, Number(minutes[1]) * 60);
  return 30;
}

function makeShot(partial: Omit<AgentShot, "id" | "status" | "error" | "result">): AgentShot {
  return { ...partial, id: uuid(), status: "pending" };
}

function maxVideoSeconds(model: VideoTabId) {
  return Math.max(...findVideo(model).durations);
}

function buildVideoShots(memory: AgentMemory, brief: string): AgentShot[] {
  const model = (modelFromText(brief, "video") || defaultVideoModel()) as VideoTabId;
  const total = askedSeconds(brief);
  const clipLen = clipVideoDuration(model, Math.min(total, maxVideoSeconds(model)));
  const clipCount = Math.max(1, Math.ceil(total / clipLen));
  const resolution = clipVideoResolution(model, brief);
  const stills = memory.createdStills.filter((img) => isUsableReferenceImage(img.dataUri));
  const maxPer = Math.max(1, findVideo(model).maxImages);
  const shots: AgentShot[] = [];
  let offset = 0;
  for (let index = 0; index < clipCount; index += 1) {
    const useLastFrame = index > 0;
    const room = Math.max(1, useLastFrame ? maxPer - 1 : maxPer);
    const remainingClips = clipCount - index;
    const remainingStills = Math.max(0, stills.length - offset);
    const take = Math.min(room, Math.max(useLastFrame ? 0 : 1, Math.ceil(remainingStills / remainingClips) || 0));
    const slice = stills.slice(offset, offset + take);
    offset += take;
    shots.push(
      makeShot({
        kind: "video",
        title: `Video ${index + 1}/${clipCount}`,
        prompt: `${brief}. Clip ${index + 1} of ${clipCount}, ${clipLen} seconds. ${
          useLastFrame ? "Continue from the last frame of the previous clip. " : "Start the action. "
        }Use the attached stills as the look and key moments.`,
        duration: clipLen,
        resolution,
        model,
        refSource: "created",
        useLastFrame,
        frameStillIds: slice.map((img) => img.id),
      })
    );
  }
  return shots;
}

export function resetShot(memory: AgentMemory, shotId: string): AgentMemory {
  const shot = memory.shots.find((item) => item.id === shotId);
  return {
    ...memory,
    createdStills: shot?.kind === "image" ? memory.createdStills.filter((img) => img.name !== `still-${shotId}`) : memory.createdStills,
    waitingForApproval: false,
    shots: memory.shots.map((item) =>
      item.id === shotId ? { ...item, status: "pending", result: undefined, error: undefined } : item
    ),
  };
}

export function approvalText(memory: AgentMemory, shot: AgentShot) {
  const pending = nextPendingShot(memory);
  if (shot.status !== "done") {
    return pending
      ? `That one failed. Reply recreate this, or continue to skip it.`
      : `That one failed. Reply recreate this, or tell me what to do next.`;
  }
  if (pending) {
    return `Reply continue for the next one, or recreate this part.`;
  }
  const stills = memory.createdStills.length;
  const videos = memory.shots.filter((item) => item.kind === "video" && item.status === "done").length;
  if (videos > 1) {
    return `Those clips are ready. Play them in order for the full video, or recreate one.`;
  }
  if (stills) {
    return `Those ${stills} stills are ready. Ask for a video, or recreate one of them.`;
  }
  return `Done. Tell me the next job, or recreate this.`;
}

export async function planAgentJob(memory: AgentMemory): Promise<{ lock: AgentLock; shots: AgentShot[] }> {
  const brief = latestUserText(memory);
  if (brief.length < 2) throw new Error("Type what you want in the chat.");

  if (isVideoAsk(brief) && memory.createdStills.length && !askedStillCount(brief)) {
    return {
      lock: memory.lock || {
        identity: "Keep the same person from the created stills.",
        wardrobe: "",
        lighting: "",
        camera: "",
        atmosphere: "",
      },
      shots: buildVideoShots(memory, brief),
    };
  }

  const history = memory.messages
    .slice(-8)
    .map((item) => `${item.role}: ${item.text}`)
    .join("\n");
  const user = [
    memory.notes.trim() ? `Remembered facts:\n${memory.notes.trim()}` : "",
    memory.lock ? `Existing lock (update if the new job needs it):\n${JSON.stringify(memory.lock)}` : "",
    `${memory.userRefs.length || memory.images.length} uploaded reference photo(s). Use those same photos for every still.`,
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

  let shots: AgentShot[] = [];
  for (const row of parsed.shots || []) {
    if (row.kind === "video") continue;
    const asked = String(row.model || "");
    const tagged = modelFromText(brief, "image");
    const model = tagged || (isImageTab(asked) ? asked : defaultImageModel());
    shots.push(
      makeShot({
        kind: "image",
        title: String(row.title || `Still ${shots.length + 1}`).trim(),
        prompt: String(row.prompt || brief).trim(),
        duration: 0,
        resolution: "720p",
        model,
        refSource: "user",
        useLastFrame: false,
        frameStillIds: [],
      })
    );
  }

  const want = askedStillCount(brief);
  if (want) {
    if (!shots.length) {
      const model = modelFromText(brief, "image") || defaultImageModel();
      shots = Array.from({ length: want }, (_, index) =>
        makeShot({
          kind: "image",
          title: `Still ${index + 1}/${want}`,
          prompt: brief,
          duration: 0,
          resolution: "720p",
          model,
          refSource: "user",
          useLastFrame: false,
          frameStillIds: [],
        })
      );
    } else if (shots.length < want) {
      const last = shots[shots.length - 1];
      while (shots.length < want) {
        shots.push(
          makeShot({
            ...last,
            title: `Still ${shots.length + 1}/${want}`,
          })
        );
      }
    } else if (shots.length > want) {
      shots = shots.slice(0, want);
    }
  }

  if (!shots.length) throw new Error("Agent returned no shots.");
  return { lock, shots };
}

function refsForShot(memory: AgentMemory, shot: AgentShot) {
  const max = shot.kind === "image" ? findImage(shot.model as ImageTabId).maxImages : findVideo(shot.model as VideoTabId).maxImages;
  if (shot.kind === "image" || shot.refSource === "user") {
    const refs = (memory.userRefs.length ? memory.userRefs : memory.images).filter((img) => isUsableReferenceImage(img.dataUri));
    return refs.slice(0, Math.max(1, max));
  }
  const frames: LocalImage[] = [];
  if (shot.useLastFrame && memory.lastStill && isUsableReferenceImage(memory.lastStill.dataUri)) {
    frames.push(memory.lastStill);
  }
  for (const id of shot.frameStillIds) {
    const still = memory.createdStills.find((img) => img.id === id);
    if (still && isUsableReferenceImage(still.dataUri) && !frames.some((img) => img.id === still.id)) {
      frames.push(still);
    }
  }
  return frames.slice(0, Math.max(1, max));
}

async function fetchImageBlob(url: string): Promise<Blob | null> {
  if (url.startsWith("data:image/")) {
    const res = await fetch(url);
    return res.blob();
  }
  const publicHttp = /^https?:\/\//i.test(url) && !/localhost|_capacitor_file_|_capacitor_content_/i.test(url);
  if (isNativeApp() && publicHttp) {
    const http = await CapacitorHttp.get({ url, responseType: "blob", readTimeout: 60000 });
    if (http.status >= 400) return null;
    const raw = String(http.data || "");
    if (!raw) return null;
    const header = http.headers && typeof http.headers === "object" ? (http.headers as Record<string, string>) : {};
    const mime = String(header["content-type"] || header["Content-Type"] || "image/jpeg").split(";")[0];
    const safeMime = /^image\//i.test(mime) ? mime : "image/jpeg";
    return (await fetch(`data:${safeMime};base64,${raw}`)).blob();
  }
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.blob();
}

async function sourceToJpegDataUri(source: string): Promise<string | null> {
  if (!source) return null;
  if (isUsableReferenceImage(source) && source.startsWith("data:image/jpeg")) return source;
  if (!source.startsWith("http") && !source.startsWith("data:") && isNativeApp()) {
    const local = await localFileToDataUri(source);
    if (local) {
      const blob = await fetchImageBlob(local);
      if (blob) return blobToJpegDataUri(blob);
    }
  }
  const blob = await fetchImageBlob(source);
  if (!blob) return null;
  return blobToJpegDataUri(blob);
}

export async function resultToStill(result: StudioResult): Promise<LocalImage | null> {
  if (result.kind !== "image") return captureVideoStill(result.url);
  const sources = [result.remoteUrl, result.url, result.localPath].filter((item): item is string => Boolean(item));
  for (const source of sources) {
    try {
      const dataUri = await sourceToJpegDataUri(source);
      if (dataUri) return { id: uuid(), name: "last-still", preview: dataUri, dataUri };
    } catch {
      /* try next source */
    }
  }
  return null;
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
  const images = refsForShot(memory, shot);
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

  const still = await resultToStill(result);
  return {
    ...memory,
    lastStill: shot.kind === "video" ? still || memory.lastStill : memory.lastStill,
    createdStills:
      shot.kind === "image" && still
        ? [...memory.createdStills.filter((img) => img.name !== `still-${shotId}`), { ...still, name: `still-${shotId}` }]
        : memory.createdStills,
    waitingForApproval: true,
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
  const shotLines = shots.map((shot, index) => {
    const extra =
      shot.kind === "video"
        ? `${shot.duration}s ${shot.resolution}${shot.useLastFrame ? " · last frame + remaining stills" : " · created stills"}`
        : "still · same uploaded refs";
    return `${index + 1}. ${shot.title} — ${extra} · ${chipLabel(shot.model)}`;
  });
  return [
    `I'll lock the look and do one shot at a time.`,
    ...lockLines,
    "",
    ...shotLines,
    "",
    "Reply continue after each one, or recreate that part.",
  ].join("\n");
}
