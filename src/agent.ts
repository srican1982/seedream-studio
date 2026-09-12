import { CapacitorHttp } from "@capacitor/core";
import { brainFromText, completeChat, generateImage, generateVideo, loadBrainModel, saveBrainModel, type ChatContentPart } from "./api";
import { blobToJpegDataUri, isUsableReferenceImage, uuid } from "./media";
import { AGENT_VIDEO_TABS, emptyTabState, findImage, findVideo } from "./models";
import { isNativeApp, localFileToDataUri } from "./native";
import type { Aspect, ImageTabId, LocalImage, StudioResult, TabState, VideoTabId } from "./types";

type VideoResolution = "480p" | "720p" | "1080p";

const MEMORY_KEY = "seedream_agent_memory";
const CHATS_KEY = "seedream_agent_chats";

function chatMemoryKey(id: string) {
  return `seedream_agent_chat_${id}`;
}

export type AgentShotKind = "image" | "video";

export type AgentLock = {
  identity: string;
  wardrobe: string;
  lighting: string;
  camera: string;
  atmosphere: string;
};

export type AgentRefSource = "user" | "created" | "both";

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
  identityRefIds: string[];
  poseRefIds: string[];
  poseFromSecond: boolean;
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
  { id: "qwen-3-pro", kind: "image", label: "Qwen 3.0 Pro", token: "Qwen 3.0 Pro" },
  { id: "wan-3", kind: "video", label: "Wan 3.0", token: "Wan 3.0" },
  { id: "wan-3-prime", kind: "video", label: "Wan 3.0 Prime", token: "Wan 3.0 Prime" },
];

export const AGENT_JOB_PRESETS = [
  {
    id: "stills-then-video",
    label: "Stills → video",
    text: "Using these photos, create the stills I describe. Keep these same uploaded photos as the only reference images until that still set is finished. After I approve the stills, I will ask for a video made from the stills you created. Split long video into clips at the model limit. The first clip uses as many of those stills as fit. Each next clip uses the last frame of the previous clip plus the remaining stills. Ask my approval after each piece. I may say recreate this part.",
  },
  {
    id: "pose-from-second",
    label: "Pose from 2nd",
    text: "Keep the people in the first image exactly: same face, same body, same skin, same hair, same tattoos or no tattoos, same clothes. Take only the body pose from the second image: limb positions and how they sit, stand, or lie. Do not copy clothes, tattoos, jewelry, hair, or identity from the second image. Lighting and location stay from the first image.",
  },
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
  if (kind === "video") {
    if (/wan\s*3(?:\.0)?\s*prime/i.test(text)) return "wan-3-prime";
    if (/\bwan\s*3(?:\.0)?\b/i.test(text)) return "wan-3";
  }
  if (kind === "image" && /\bqwen\b/i.test(text)) return "qwen-3-pro";
  return AGENT_MODEL_CHIPS.filter((chip) => chip.kind === kind)
    .sort((a, b) => b.token.length - a.token.length)
    .find((chip) => chipInText(text, chip.token))?.id;
}

export const VIDEO_REF_LIMIT = 10;

export type AgentMemory = {
  brief: string;
  notes: string;
  lock: AgentLock | null;
  images: LocalImage[];
  userRefs: LocalImage[];
  createdStills: LocalImage[];
  chosenRefs: LocalImage[];
  shots: AgentShot[];
  lastStill: LocalImage | null;
  waitingForApproval: boolean;
  awaitingVideoRefs: boolean;
  awaitingRecreate: boolean;
  recreateShotId: string;
  recreateNote: string;
  hasPickedVideoRefs: boolean;
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
    chosenRefs: [],
    shots: [],
    lastStill: null,
    waitingForApproval: false,
    awaitingVideoRefs: false,
    awaitingRecreate: false,
    recreateShotId: "",
    recreateNote: "",
    hasPickedVideoRefs: false,
    messages: [],
  };
}

export type AgentChatInfo = {
  id: string;
  title: string;
  updatedAt: number;
};

type ChatIndex = {
  activeId: string;
  chats: AgentChatInfo[];
};

export function chatTitleFromMemory(memory: AgentMemory) {
  const first = memory.messages.find((item) => item.role === "user" && item.text.trim());
  if (!first) return "New chat";
  const text = first.text.replace(/\s+/g, " ").trim();
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

function parseStoredMemory(parsed: AgentMemory): AgentMemory {
  const images = Array.isArray(parsed.images) ? parsed.images : [];
  return {
    brief: parsed.brief || "",
    notes: parsed.notes || "",
    lock: parsed.lock || null,
    images,
    userRefs: Array.isArray(parsed.userRefs) && parsed.userRefs.length ? parsed.userRefs : images,
    createdStills: Array.isArray(parsed.createdStills) ? parsed.createdStills : [],
    chosenRefs: Array.isArray(parsed.chosenRefs) ? parsed.chosenRefs : [],
    shots: Array.isArray(parsed.shots)
      ? parsed.shots.map((shot) => ({
          ...shot,
          resolution: "480p" as const,
          model: shot.kind === "image" ? "qwen-3-pro" : isVideoTab(String(shot.model)) ? shot.model : "wan-3-prime",
          refSource: shot.refSource || (shot.kind === "video" ? "created" : "user"),
          useLastFrame: Boolean(shot.useLastFrame),
          frameStillIds: Array.isArray(shot.frameStillIds) ? shot.frameStillIds : [],
          identityRefIds: Array.isArray(shot.identityRefIds) ? shot.identityRefIds : [],
          poseRefIds: Array.isArray(shot.poseRefIds) ? shot.poseRefIds : [],
          poseFromSecond: Boolean(shot.poseFromSecond),
        }))
      : [],
    lastStill: parsed.lastStill || null,
    waitingForApproval: Boolean(parsed.waitingForApproval),
    awaitingVideoRefs: Boolean(parsed.awaitingVideoRefs),
    awaitingRecreate: Boolean(parsed.awaitingRecreate),
    recreateShotId: parsed.recreateShotId || "",
    recreateNote: parsed.recreateNote || "",
    hasPickedVideoRefs: Boolean(parsed.hasPickedVideoRefs),
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
  };
}

function readChatMemory(id: string): AgentMemory | null {
  try {
    const raw = localStorage.getItem(chatMemoryKey(id));
    if (!raw) return null;
    return parseStoredMemory(JSON.parse(raw) as AgentMemory);
  } catch {
    return null;
  }
}

function writeChatMemory(id: string, memory: AgentMemory) {
  try {
    localStorage.setItem(chatMemoryKey(id), JSON.stringify(memory));
  } catch {
    /* quota — keep RAM only */
  }
}

function readChatIndex(): ChatIndex | null {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatIndex;
    if (!parsed.activeId || !Array.isArray(parsed.chats) || !parsed.chats.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeChatIndex(index: ChatIndex) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(index));
  } catch {
    /* quota */
  }
}

function createFreshIndex(): ChatIndex {
  const id = uuid();
  const index: ChatIndex = { activeId: id, chats: [{ id, title: "New chat", updatedAt: Date.now() }] };
  writeChatMemory(id, emptyAgentMemory());
  writeChatIndex(index);
  return index;
}

function migrateLegacyChat(): ChatIndex | null {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return null;
    const memory = parseStoredMemory(JSON.parse(raw) as AgentMemory);
    const id = uuid();
    const index: ChatIndex = {
      activeId: id,
      chats: [{ id, title: chatTitleFromMemory(memory), updatedAt: Date.now() }],
    };
    writeChatMemory(id, memory);
    writeChatIndex(index);
    localStorage.removeItem(MEMORY_KEY);
    return index;
  } catch {
    return null;
  }
}

function loadChatIndex(): ChatIndex {
  return readChatIndex() || migrateLegacyChat() || createFreshIndex();
}

export function listAgentChats() {
  return loadChatIndex().chats.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function activeChatId() {
  return loadChatIndex().activeId;
}

export function loadAgentMemory(): AgentMemory {
  const index = loadChatIndex();
  return readChatMemory(index.activeId) || emptyAgentMemory();
}

export function saveAgentMemory(memory: AgentMemory) {
  const index = loadChatIndex();
  writeChatMemory(index.activeId, memory);
  writeChatIndex({
    ...index,
    chats: index.chats.map((chat) =>
      chat.id === index.activeId
        ? { ...chat, title: chatTitleFromMemory(memory), updatedAt: Date.now() }
        : chat
    ),
  });
}

export function startNewAgentChat(current: AgentMemory) {
  if (!current.messages.length) return current;
  saveAgentMemory(current);
  const index = loadChatIndex();
  const id = uuid();
  const memory = emptyAgentMemory();
  writeChatMemory(id, memory);
  writeChatIndex({
    activeId: id,
    chats: [{ id, title: "New chat", updatedAt: Date.now() }, ...index.chats],
  });
  return memory;
}

export function openAgentChat(id: string, current: AgentMemory) {
  const index = loadChatIndex();
  if (id === index.activeId || !index.chats.some((chat) => chat.id === id)) return current;
  saveAgentMemory(current);
  writeChatIndex({ ...loadChatIndex(), activeId: id });
  return readChatMemory(id) || emptyAgentMemory();
}

export function deleteAgentChat(id: string, current: AgentMemory) {
  const index = loadChatIndex();
  if (index.activeId !== id) saveAgentMemory(current);
  try {
    localStorage.removeItem(chatMemoryKey(id));
  } catch {
    /* ignore */
  }
  const chats = index.chats.filter((chat) => chat.id !== id);
  if (!chats.length) {
    const fresh = createFreshIndex();
    return readChatMemory(fresh.activeId) || emptyAgentMemory();
  }
  const activeId = index.activeId === id ? chats.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0].id : index.activeId;
  writeChatIndex({ activeId, chats });
  if (activeId === index.activeId && index.activeId !== id) return current;
  return readChatMemory(activeId) || emptyAgentMemory();
}

function isVideoTab(id: string): id is VideoTabId {
  return (AGENT_VIDEO_TABS as string[]).includes(id);
}

function clipVideoDuration(model: VideoTabId, seconds: number) {
  const allowed = findVideo(model).durations;
  const want = Math.max(1, Math.round(seconds || allowed[0]));
  return allowed.reduce((best, d) => (Math.abs(d - want) < Math.abs(best - want) ? d : best), allowed[0]);
}

function clipVideoResolution(_model?: VideoTabId, _asked?: string): VideoResolution {
  return "480p";
}

function defaultImageModel(): ImageTabId {
  return "qwen-3-pro";
}

function defaultVideoModel(): VideoTabId {
  return "wan-3-prime";
}

export function shotPrompt(_lock: AgentLock | null, notes: string, shot: AgentShot, brief = "") {
  let prompt = shot.poseFromSecond ? applyPoseIdentityLock(shot.prompt, shot.identityRefIds.length) : shot.prompt;
  prompt = keepSinhalaDialog(prompt, brief);
  const remembered = notes.trim();
  if (!remembered) return prompt;
  return `${prompt}\nRemembered from the user: ${remembered}`;
}

function poseIdentityLock(identityCount: number) {
  const people =
    identityCount >= 2
      ? `The first ${identityCount} images are the people the user named for identity. Copy those same people exactly: same faces, same body, same skin, same hair, same tattoos or no tattoos, same clothes.`
      : "The first image is the people the user named for identity. Copy those people exactly: same faces, same facial structure, same eyes, nose, mouth, same skin, same hair, same body, same tattoos or no tattoos, same clothes.";
  const pose =
    identityCount >= 2
      ? "The last image is the pose photo they named. Match that body pose: limbs, torso, hips, facing, sit/stand/lie, contact."
      : "The second image is the pose photo they named. Look at how that body is posed and match it: limbs, torso, hips, facing, sit/stand/lie, contact.";
  return `${people} ${pose} STRICT IDENTITY: do not copy, blend, morph, mix, or average any face, hair, clothes, jewelry, tattoos, or body type from the pose photo. The person in the pose photo must not appear.`;
}

function applyPoseIdentityLock(prompt: string, identityCount = 1) {
  const text = prompt.trim();
  if (/STRICT IDENTITY/i.test(text)) return text;
  return `${text}\n\n${poseIdentityLock(identityCount)}`;
}

const SINHALA = /[\u0D80-\u0DFF]/;

function sinhalaDialogs(text: string) {
  const quoted = [...text.matchAll(/[“"']([^“"']*[\u0D80-\u0DFF][^“"']*)[”"']/g)].map((m) => m[1].trim());
  const runs = [...text.matchAll(/[\u0D80-\u0DFF][^\n]*/g)].map((m) => m[0].trim()).filter((item) => item.length >= 2);
  const out: string[] = [];
  for (const item of [...quoted, ...runs]) {
    if (item && !out.some((kept) => kept.includes(item) || item.includes(kept))) out.push(item);
  }
  return out;
}

function keepSinhalaDialog(prompt: string, brief: string) {
  const dialogs = sinhalaDialogs(brief);
  if (!dialogs.length) return prompt;
  const missing = dialogs.filter((line) => !prompt.includes(line));
  if (!missing.length) return prompt;
  return `${prompt.trim()}\n\nThe people must speak these exact Sinhala letters. Do not speak an English or romanized version of these lines:\n${missing.map((line) => `"${line}"`).join("\n")}`;
}

const PLAN_SYSTEM = `You are the same Gemini the user would talk to in a normal chat. Read their words and look at the attached photos. Understand the request the way you would if they messaged you directly.

Language:
- Read Sinhala and English, including spoken Sri Lankan Sinhala mixed with common English words.
- If they are only chatting, answer in "reply" in their language.

Adult content:
- Consensual adult sexual content between adults 18 or older is allowed. Never include minors or anyone who appears under 18.
- Do not lecture, moralize, refuse, or add safety sermons. Keep their explicit wording.

The photos are attached as JPEG Base64. Look at them carefully the way you would in a normal Gemini chat. You can see people, clothes, lighting, location, pose, and adult detail. Describe what you see when that helps Qwen or Wan.

Then write the exact prompt that will be sent to Qwen 3.0 Pro (images) or Wan (video). That prompt is the whole job. Qwen and Wan will not see this chat — they only get your written prompt plus the reference pixels. You must turn what you understood from the words and the photos into better generator language.

How to write shot.prompt:
- First understand them the way you would in a normal Gemini chat: slang, Sinhala, shorthand, sex-position names, and what they mean by the attached photos.
- Write the picture and motion in clear, explicit English so Qwen or Wan understand bodies, camera, and action. If they name a position, act, or pose, describe the bodies: who is where, limbs, facing, contact, and the action. Qwen and Wan often do not know the name. You do. Write the picture.
- Spoken dialog is different. If they typed spoken lines in Sinhala letters (සිංහල), copy those exact Sinhala letters into shot.prompt as the words that are said. Do not translate that dialog into English. Do not romanize it into English letters (never write "mama" for මම). Scene description stays English. Only the spoken words they wrote in Sinhala stay in Sinhala.
- Keep every concrete detail they said. Keep their adult wording. Be direct and sexual when they are.
- Clothing, lighting, and location: if they named a change, follow that. If they did not, tell Qwen or Wan to keep the same clothes, same lighting, and same place as the first image (or the photo they pointed at). Do not invent a new room, new light, or new outfit.
- Describing the act or position they asked for is not inventing. Changing the photo's clothes, light, or place without them asking is inventing.
- If they pointed at photos, use the bar numbers they said, and keep those roles.
- If they already picked photos in tap order, those are the ONLY references. refs must be attached. First tapped is the first image, second tapped is the second image. Do not add other stills.
- If they name some photos for the people and other photos for poses, follow what they said. Do not assume photo 1 is people or photo 2 is pose unless they said that.
  - identity = the bar numbers they named for the people. pose = the bar number they named for that still's pose.
  - One still per pose they asked for.
  - Qwen can take 3 reference images. Each still uses the identity photos plus THAT pose photo only. Do not put two pose photos in the same still.
  - The result people must be exactly the identity-photo people: same faces, body, skin, hair, tattoos or no tattoos, clothes.
  - Never blend, morph, mix, or average faces. The pose-photo person must not appear.
  - From the pose photo take ONLY the body pose. Write that pose clearly. Do not describe the pose person's face, hair, clothes, tattoos, jewelry, or identity.
  - Keep lighting and location from the identity photos unless the user named a change.
  - Fill identity and pose with the numbers they named.
- One shot per still they asked for. Each shot.prompt is that still's full instruction.
- Never add a video shot unless THIS message asks for a video or clip.
- There are two photo sets unless they already picked photos in tap order:
  - attached = photos they just added with this message (or "use what I am attaching")
  - created = stills this chat already made ("use the one you created", "the pictures you made")
  - both = new uploads AND created stills ("use the picture you created and what I am attaching")
- If they already picked photos in tap order, refs is attached and those are the only photos.
- If they attached new photos and did not mention the created stills, refs is attached.
- If they attached no new photos and asked for a video, refs is created — unless they already picked photos.
- Qwen 3.0 Pro can only take 3 reference images. Wan can take 10. If there are more, keep the ones the user cares about most, usually new uploads first.
- For video, describe the motion they asked in the same explicit way. Always include audible speech and scene sound in the prompt. If they wrote dialog in Sinhala letters, those spoken words in the prompt must stay in Sinhala letters.
- Image model is always qwen-3-pro. Video is wan-3-prime unless they named Wan 3.0. Video is always 480p. Duration is what they said, else 10s. Wan max 30s per clip.

If they are only chatting, return shots: [] and put your answer in reply.
reply must be one short sentence or "". Never put JSON, markdown, or the generator prompt in reply. The Qwen/Wan instruction belongs only in shots[].prompt.
Always return one complete JSON object. Do not cut off mid-string.

Return ONLY JSON, no markdown:
{"reply":"","refs":"attached"|"created"|"both","shots":[{"kind":"image"|"video","title":"","prompt":"","duration":10,"identity":[],"pose":0}]}`;

function parsePlanJson(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) {
    return { lock: {}, reply: looksLikeJson(cleaned) ? "" : cleaned, shots: [] as Array<Record<string, unknown>> };
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as {
      lock?: Partial<AgentLock>;
      reply?: string;
      refs?: string;
      shots?: Array<Record<string, unknown>>;
    };
  } catch {
    return { lock: {}, reply: "", shots: [] as Array<Record<string, unknown>> };
  }
}

function looksLikeJson(text: string) {
  return /^\s*[{[]/.test(text);
}

function cleanReply(text: string) {
  const next = text.trim();
  if (!next || looksLikeJson(next)) return "";
  return next.replace(/\{[\s\S]*$/, "").trim();
}

function askedToGenerate(text: string) {
  return askedForVideo(text) || /\b(make|create|generate|image|photo|still|picture|render|හදන්න)\b/i.test(text);
}

export function latestUserText(memory: AgentMemory) {
  return [...memory.messages].reverse().find((item) => item.role === "user")?.text.trim() || memory.brief.trim();
}

export function isRememberOnly(text: string) {
  return /^\s*remember\b/i.test(text) && !/\b(make|create|generate|render|video|still|shot|series|clip)\b/i.test(text);
}

export function isContinue(text: string) {
  return /^(ok|okay|k|yes|yep|yeah|continue|next|go|good|fine|approved|looks good|do it|proceed|හරි|ඔව්|ඔව්නේ|හොඳයි|ඉදිරියට)(?:\s*[.!])*$/i.test(text.trim());
}

export function isRecreate(text: string) {
  return /\b(recreate|redo|retry|remake|again)\b/i.test(text) || /ආයෙ|නැවත|නැවතත්/.test(text);
}

export function nextPendingShot(memory: AgentMemory) {
  return memory.shots.find((shot) => shot.status === "pending") || null;
}

export function lastActionableShot(memory: AgentMemory) {
  return [...memory.shots].reverse().find((shot) => shot.status === "done" || shot.status === "error") || null;
}

export function recreateShot(memory: AgentMemory, text: string) {
  if (memory.recreateShotId) {
    const current = memory.shots.find((item) => item.id === memory.recreateShotId);
    if (current) return current;
  }
  const numbered = text.match(/\b(?:shot|still|clip|image|part|number|#)?\s*(\d+)\b/i);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    const shot = memory.shots[index];
    if (shot) return shot;
  }
  return lastActionableShot(memory);
}

export function recreateChangeText(text: string) {
  return text
    .replace(/^\s*(please\s+)?(recreate(\s+this(\s+(one|part|clip|shot|video|still))?)?|redo|retry|remake|again)\s*[,.:;\-–—]?\s*/i, "")
    .replace(/ආයෙ(\s+හදන්න)?|නැවත(\s+හදන්න)?/g, "")
    .trim();
}

export function recreateRefLimit(kind: AgentShotKind) {
  return kind === "image" ? 3 : VIDEO_REF_LIMIT;
}

export function recreateQuestion(kind: AgentShotKind) {
  return kind === "video"
    ? "What should I change in this video? Type it below. If you want different pictures, tap them in order on the bar, or attach new ones. Then tap Recreate."
    : "What should I change in this still? Type it below. Tap different photos on the bar if you want, then tap Recreate.";
}

export function beginRecreate(memory: AgentMemory, shot: AgentShot, note = ""): AgentMemory {
  const refs = refsForShot(memory, shot);
  return {
    ...memory,
    awaitingRecreate: true,
    recreateShotId: shot.id,
    recreateNote: note,
    awaitingVideoRefs: false,
    waitingForApproval: false,
    hasPickedVideoRefs: false,
    chosenRefs: refs.slice(0, recreateRefLimit(shot.kind)),
  };
}

const REVISE_SYSTEM = `You revise a prompt for Qwen 3.0 Pro (images) or Wan (video). Keep the whole scene the same except the user's requested change.
Return only the revised prompt. No title, no quotes, no markdown, no explanation.
If they typed spoken dialog in Sinhala letters, those spoken words must stay in those exact Sinhala letters. Do not romanize.
Scene and action stay in clear English unless they asked otherwise.`;

export async function applyRecreateEdits(
  memory: AgentMemory,
  change: string,
  extraPhotos: LocalImage[] = []
): Promise<{ memory: AgentMemory; shot: AgentShot }> {
  const target = recreateShot(memory, change);
  if (!target) throw new Error("Nothing to recreate yet.");
  const limit = recreateRefLimit(target.kind);
  const picked = [...memory.chosenRefs];
  for (const img of extraPhotos) {
    if (isUsableReferenceImage(img.dataUri) && !picked.some((item) => item.id === img.id)) picked.push(img);
  }
  const photos = picked.filter((img) => isUsableReferenceImage(img.dataUri)).slice(0, limit);
  const note = recreateChangeText(change) || memory.recreateNote.trim();
  let prompt = target.prompt;
  if (note) {
    try {
      const raw = await completeChat(
        REVISE_SYSTEM,
        `Current prompt:\n${target.prompt}\n\nUser change:\n${note}`,
        2048,
        loadBrainModel(),
        0.3
      );
      const cleaned = raw.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").replace(/^["']|["']$/g, "").trim();
      if (cleaned) prompt = cleaned;
    } catch {
      prompt = `${target.prompt}\n\nChange this: ${note}`;
    }
    prompt = keepSinhalaDialog(prompt, note);
  }
  const reset = resetShot(memory, target.id);
  const next: AgentMemory = {
    ...reset,
    brief: note || reset.brief,
    awaitingRecreate: false,
    recreateShotId: "",
    recreateNote: "",
    awaitingVideoRefs: false,
    waitingForApproval: false,
    chosenRefs: photos,
    userRefs: photos,
    hasPickedVideoRefs: true,
    shots: reset.shots.map((item) =>
      item.id === target.id
        ? {
            ...item,
            prompt,
            refSource: "user" as const,
            identityRefIds: [],
            poseRefIds: [],
            poseFromSecond: false,
          }
        : item
    ),
  };
  const shot = next.shots.find((item) => item.id === target.id);
  if (!shot) throw new Error("Nothing to recreate yet.");
  return { memory: next, shot };
}

function askedSeconds(text: string) {
  const seconds = text.match(/(\d+)\s*(?:s|sec|secs|second|seconds)\b/i);
  if (seconds) return Math.max(1, Number(seconds[1]));
  const minutes = text.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (minutes) return Math.max(1, Number(minutes[1]) * 60);
  return 0;
}

function makeShot(partial: Omit<AgentShot, "id" | "status" | "error" | "result">): AgentShot {
  return { ...partial, id: uuid(), status: "pending" };
}

function expandLongVideo(base: Omit<AgentShot, "id" | "status" | "error" | "result">, wanted: number): AgentShot[] {
  const model = base.model as VideoTabId;
  const max = Math.max(...findVideo(model).durations);
  const total = Math.max(1, wanted);
  const count = Math.max(1, Math.ceil(total / max));
  return Array.from({ length: count }, (_, index) =>
    makeShot({
      ...base,
      title: count > 1 ? `${base.title} ${index + 1}/${count}` : base.title,
      duration: clipVideoDuration(model, Math.min(max, total - index * max)),
      useLastFrame: index > 0 || base.useLastFrame,
    })
  );
}

function assignCreatedStillFrames(shots: AgentShot[], stills: LocalImage[]) {
  const usable = stills.filter((img) => isUsableReferenceImage(img.dataUri));
  const videos = shots.filter((shot) => shot.kind === "video");
  if (!videos.length || !usable.length) return shots;
  let offset = 0;
  return shots.map((shot) => {
    if (shot.kind !== "video" || shot.refSource === "user" || shot.refSource === "both" || shot.frameStillIds.length) return shot;
    const index = videos.indexOf(shot);
    const maxPer = Math.max(1, findVideo(shot.model as VideoTabId).maxImages);
    const useLastFrame = index > 0;
    const room = Math.max(1, useLastFrame ? maxPer - 1 : maxPer);
    const remainingClips = videos.length - index;
    const remainingStills = Math.max(0, usable.length - offset);
    const take = Math.min(room, Math.ceil(remainingStills / remainingClips) || 0);
    const slice = usable.slice(offset, offset + take);
    offset += take;
    return { ...shot, refSource: "created" as const, useLastFrame, frameStillIds: slice.map((img) => img.id) };
  });
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
      ? `That one failed. Reply recreate this / ආයෙ හදන්න, or continue / හරි to skip it.`
      : `That one failed. Reply recreate this / ආයෙ හදන්න, or tell me what to do next.`;
  }
  if (pending) {
    return `Reply continue / හරි for the next one, or recreate this part / මේක ආයෙ හදන්න.`;
  }
  const stills = memory.createdStills.length;
  const videos = memory.shots.filter((item) => item.kind === "video" && item.status === "done").length;
  if (videos > 1) {
    return `Those clips are ready. Play them in order for the full video, or recreate one.`;
  }
  if (stills) {
    return `Those ${stills} stills are ready. Tell me what you want next, or recreate one of them.`;
  }
  return `Done. Tell me the next job, or recreate this.`;
}

function askedForBoth(text: string) {
  return /\b(both|use both|all of them together|plus the (stills|ones|images|photos)|and the (stills|images|photos) (you |we )?(already )?(made|created|generated)|those stills (too|as well)|previous stills|created stills|දෙකම|ඔක්කොම)\b/i.test(text);
}

export function askedForVideo(text: string) {
  return /\b(video|videos|clip|clips|animate|animation|movie|film|වීඩියෝ|වීඩියෝව|ක්ලිප්)\b/i.test(text);
}

export function askedForPeopleAndPose(text: string) {
  return /\b(people|person|identity|faces?|අය)\b/i.test(text) && /\b(pose|poses|posture|ඉරියව්)\b/i.test(text);
}

const PHOTO_TOKEN = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|one|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|10|[1-9])\b/gi;
const PHOTO_TOKEN_MAP: Record<string, number> = {
  first: 1,
  one: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
  sixth: 6,
  "6th": 6,
  seventh: 7,
  "7th": 7,
  eighth: 8,
  "8th": 8,
  ninth: 9,
  "9th": 9,
  tenth: 10,
  "10th": 10,
};

function photoTokenToNum(raw: string) {
  const key = raw.toLowerCase();
  if (PHOTO_TOKEN_MAP[key]) return PHOTO_TOKEN_MAP[key];
  const n = Number(key);
  return n >= 1 && n <= 10 ? n : 0;
}

function numbersIn(text: string, max: number) {
  const out: number[] = [];
  for (const match of text.matchAll(PHOTO_TOKEN)) {
    const n = photoTokenToNum(match[1]);
    if (n >= 1 && n <= max && !out.includes(n)) out.push(n);
  }
  return out;
}

function clauses(text: string, trigger: RegExp) {
  return [...text.matchAll(trigger)].map((match) => match[1]).join(" ");
}

export function parseIdentityPoseJob(text: string, photoCount: number): { identity: number[]; poses: number[] } | null {
  if (photoCount < 1) return null;
  const cleaned = text.replace(/\b(?:create|make|generate|හදන්න)\s+\d+\s+(?:photo|image|still|picture)s?\b/gi, " ");
  const poseBits = clauses(cleaned, /(.{0,64}(?:pose|poses|posture|ඉරියව්).{0,64})/gi);
  const peopleBits = clauses(cleaned, /(.{0,64}(?:people|person|identity|faces?|අය).{0,64})/gi);
  const poses = numbersIn(poseBits, photoCount);
  const identity = numbersIn(peopleBits, photoCount).filter((n) => !poses.includes(n));
  if (!identity.length || !poses.length) return null;
  return { identity, poses };
}

export function videoRefQuestion() {
  return "Which photos should go in the video? Tap them in order on the bar above. First tap is the first image, second tap is the second image. If you tap a wrong one, remove it from the row below. Then tap Use these. You can pick up to 10.\n\nවීඩියෝවට මොන පොටෝද? උඩ තීරුවේ ඕන පිළිවෙලට tap කරන්න. පළවෙනි tap එක පළවෙනි image එක. වැරදි එකක් නම් යටින් × තියලා අයින් කරන්න. ඊට පස්සේ Use these.";
}

async function toGeminiJpegBase64(source: string): Promise<string | null> {
  if (!source) return null;
  try {
    let blob: Blob | null = null;
    if (!source.startsWith("http") && !source.startsWith("data:") && isNativeApp()) {
      const local = await localFileToDataUri(source);
      if (local) blob = await fetchImageBlob(local);
    }
    if (!blob) blob = await fetchImageBlob(source);
    const jpeg = blob ? await blobToJpegDataUri(blob, 1024, 0.85) : null;
    if (jpeg && /^data:image\/jpeg;base64,/i.test(jpeg) && isUsableReferenceImage(jpeg)) return jpeg;
    if (/^data:image\/jpeg;base64,/i.test(source) && isUsableReferenceImage(source)) return source;
  } catch {
    /* try next */
  }
  return null;
}

async function plannerLibrary(library: LibraryPhoto[]): Promise<ChatContentPart[]> {
  const parts: ChatContentPart[] = [];
  for (const photo of library.slice(0, 10)) {
    const url = await toGeminiJpegBase64(photo.image.dataUri || photo.image.preview);
    if (!url) continue;
    parts.push({
      type: "text",
      text: `This is photo ${photo.label} on the bar (${photo.kind === "made" ? "created in this chat" : "uploaded"}). Look at it carefully.`,
    });
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

async function plannerImages(images: LocalImage[], max = 6, label = "uploaded"): Promise<ChatContentPart[]> {
  const ordinals = ["first", "second", "third", "fourth", "fifth", "sixth"];
  const parts: ChatContentPart[] = [];
  let index = 0;
  for (const img of images.slice(0, max)) {
    const url = await toGeminiJpegBase64(img.dataUri || img.preview);
    if (!url) continue;
    parts.push({ type: "text", text: `This is the ${ordinals[index] || `${index + 1}th`} image (${label}). Look at it carefully.` });
    parts.push({ type: "image_url", image_url: { url } });
    index += 1;
  }
  return parts;
}

export type LibraryPhoto = {
  id: string;
  label: string;
  kind: "upload" | "made";
  image: LocalImage;
};

export function photoLibrary(memory: AgentMemory, extra: LocalImage[] = []): LibraryPhoto[] {
  const seen = new Set<string>();
  const out: LibraryPhoto[] = [];
  const add = (img: LocalImage, kind: "upload" | "made") => {
    if (!img?.dataUri && !img?.preview) return;
    const key = img.id || (img.dataUri || img.preview).slice(0, 64);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: img.id,
      label: String(out.length + 1),
      kind,
      image: img,
    });
  };
  for (const msg of memory.messages) {
    if (msg.role !== "user") continue;
    for (const img of msg.images || []) add(img, "upload");
  }
  for (const img of extra) add(img, "upload");
  for (const img of memory.createdStills) add(img, "made");
  return out;
}

export function removeLibraryPhoto(memory: AgentMemory, id: string): AgentMemory {
  const drop = (imgs: LocalImage[] | undefined) => (imgs || []).filter((img) => img.id !== id);
  return {
    ...memory,
    images: drop(memory.images),
    userRefs: drop(memory.userRefs),
    createdStills: drop(memory.createdStills),
    chosenRefs: drop(memory.chosenRefs),
    lastStill: memory.lastStill?.id === id ? null : memory.lastStill,
    messages: memory.messages.map((msg) => ({ ...msg, images: drop(msg.images) })),
  };
}

function numsFromUnknown(value: unknown, max: number) {
  const raw = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  const out: number[] = [];
  for (const item of raw) {
    const n = Number(item);
    if (n >= 1 && n <= max && !out.includes(n)) out.push(n);
  }
  return out;
}

function libraryIds(library: LibraryPhoto[], nums: number[]) {
  return nums.map((n) => library[n - 1]?.id).filter((id): id is string => Boolean(id));
}

function imagesFromIds(memory: AgentMemory, ids: string[]) {
  const pool = [
    ...photoLibrary(memory).map((photo) => photo.image),
    ...memory.chosenRefs,
    ...memory.userRefs,
    ...memory.images,
    ...memory.createdStills,
  ];
  const out: LocalImage[] = [];
  for (const id of ids) {
    const img = pool.find((item) => item.id === id);
    if (img && isUsableReferenceImage(img.dataUri) && !out.some((item) => item.id === img.id)) out.push(img);
  }
  return out;
}

function latestUserPhotos(memory: AgentMemory) {
  return [...memory.messages].reverse().find((item) => item.role === "user")?.images || [];
}

function pickRefSource(
  parsed: { refs?: string },
  memory: AgentMemory,
  brief: string,
  freshUploads: LocalImage[]
): AgentRefSource {
  if (memory.hasPickedVideoRefs) return "user";
  const raw = `${parsed.refs || ""}`.toLowerCase();
  const hasCreated = memory.createdStills.length > 0;
  const hasUploads = freshUploads.length > 0 || memory.userRefs.length > 0 || memory.images.length > 0;
  if (/\b(both|all)\b/.test(raw) && hasCreated && hasUploads) return "both";
  if (/\b(created|stills|generated)\b/.test(raw) && hasCreated) return "created";
  if (/\b(attached|uploaded|user|new)\b/.test(raw)) return "user";
  if (freshUploads.length && hasCreated && askedForBoth(brief)) return "both";
  if (freshUploads.length) return "user";
  if (hasCreated && askedForVideo(brief)) return "created";
  return "user";
}

export async function planAgentJob(memory: AgentMemory): Promise<{ lock: AgentLock; shots: AgentShot[]; reply: string }> {
  const brief = latestUserText(memory);
  if (brief.length < 2) throw new Error("Type what you want in the chat.");

  const picked = memory.hasPickedVideoRefs;
  const library = photoLibrary(memory);
  const split = parseIdentityPoseJob(brief, library.length);
  const freshUploads = picked ? memory.chosenRefs : latestUserPhotos(memory);
  const userRefs = picked
    ? memory.chosenRefs
    : freshUploads.length
      ? freshUploads
      : memory.userRefs.length
        ? memory.userRefs
        : memory.images;
  const history = memory.messages
    .slice(-8)
    .map((item) => `${item.role}: ${item.text}`)
    .join("\n");
  const uploadedParts = picked
    ? await plannerImages(userRefs, 10, "selected in tap order")
    : await plannerLibrary(library);
  const createdParts = picked || library.length ? [] : memory.createdStills.length ? await plannerImages(memory.createdStills, 6, "created earlier in this chat") : [];
  if ((picked ? userRefs : library).length && !uploadedParts.some((part) => part.type === "image_url")) {
    throw new Error("Could not encode the photos as JPEG Base64 for Gemini. Attach them again.");
  }
  const text = [
    picked
      ? `The user picked ${memory.chosenRefs.length} photo(s) in tap order. These are the ONLY references. First tapped is the first image, second tapped is the second image, and so on. Do not add other stills.`
      : library.length
        ? `Photos on the bar, numbered as the user sees them: ${library.map((photo) => `${photo.label}=${photo.kind}`).join(", ")}.`
        : "No photos on the bar.",
    picked ? "" : "Pick refs from the user's words: attached, created, or both. Do not ignore new uploads unless they asked to use the created stills.",
    split
      ? `CRITICAL: the user named identity photos ${split.identity.join(", ")} and pose photos ${split.poses.join(", ")}. Follow those bar numbers. One still per pose photo. Each still's refs = identity photos + that pose photo only. Describe each pose in words. Do not describe the pose person's face. Do not blend faces.`
      : askedForPeopleAndPose(brief)
        ? "CRITICAL: they named some photos for the people and others for poses. Read the bar numbers they said. Do not assume photo 1 is people or photo 2 is pose. One still per pose they named. Identity photos + that pose photo only. Do not blend faces."
        : "",
    memory.notes.trim() ? `Remembered facts from the user (do not add extra):\n${memory.notes.trim()}` : "",
    history ? `Recent chat:\n${history}` : "",
    SINHALA.test(brief)
      ? "The latest request has Sinhala letters. Any spoken dialog they typed in Sinhala must stay in those exact Sinhala letters in shot.prompt. Do not convert those spoken words to English letters."
      : "",
    `Latest request:\n${brief}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const askedBrain = brainFromText(brief);
  if (askedBrain) saveBrainModel(askedBrain);
  const brain = askedBrain || loadBrainModel();
  const content: ChatContentPart[] = [{ type: "text", text }, ...uploadedParts, ...createdParts];
  let raw = await completeChat(PLAN_SYSTEM, content, 4096, brain, 0.55);
  let parsed = parsePlanJson(raw);
  if (!(parsed.shots || []).length && askedToGenerate(brief)) {
    raw = await completeChat(
      `${PLAN_SYSTEM}\nYour last answer was incomplete. Return ONLY complete JSON with shots filled. reply must be short.`,
      content,
      4096,
      brain,
      0.2
    );
    parsed = parsePlanJson(raw);
  }
  const lock: AgentLock = {
    identity: "",
    wardrobe: "",
    lighting: "",
    camera: "",
    atmosphere: "",
  };
  const refSource = memory.hasPickedVideoRefs ? "user" : pickRefSource(parsed, memory, brief, freshUploads);
  const emptyIds: string[] = [];

  const shots: AgentShot[] = [];
  let poseShotIndex = 0;
  for (const row of parsed.shots || []) {
    if (row.kind === "video" && !askedForVideo(brief)) continue;
    const kind: AgentShotKind = row.kind === "video" ? "video" : "image";
    const asked = String(row.model || "");
    const tagged = modelFromText(brief, kind);
    const model = kind === "image"
      ? defaultImageModel()
      : tagged && isVideoTab(tagged)
        ? tagged
        : isVideoTab(asked) ? asked : defaultVideoModel();
    const wanted = kind === "video" ? askedSeconds(brief) || 10 : 0;
    const resolution = kind === "video" ? clipVideoResolution() : "480p";
    const rowRefs = String(row.refs || "").toLowerCase();
    const shotRefs = memory.hasPickedVideoRefs
      ? "user"
      : rowRefs
        ? pickRefSource({ refs: rowRefs }, memory, brief, freshUploads)
        : refSource;
    const identityNums = kind === "image" ? numsFromUnknown(row.identity, library.length) : [];
    const poseNums = kind === "image" ? numsFromUnknown(row.pose, library.length) : [];
    const identity = identityNums.length ? identityNums : split?.identity || [];
    const pose = poseNums.length
      ? poseNums.slice(0, 1)
      : split?.poses[poseShotIndex]
        ? [split.poses[poseShotIndex]]
        : [];
    const poseJob = kind === "image" && (identity.length > 0 && pose.length > 0);
    if (kind === "image" && poseJob) poseShotIndex += 1;
    const identityRefIds = poseJob ? libraryIds(library, identity) : emptyIds;
    const poseRefIds = poseJob ? libraryIds(library, pose) : emptyIds;
    const base = {
      kind,
      title: String(row.title || `${kind} ${shots.length + 1}`).trim(),
      prompt: keepSinhalaDialog(
        poseJob ? applyPoseIdentityLock(String(row.prompt || brief).trim() || brief, identity.length) : String(row.prompt || brief).trim() || brief,
        brief
      ),
      duration: kind === "video" ? clipVideoDuration(model as VideoTabId, wanted) : 0,
      resolution,
      model,
      refSource: poseJob ? "user" as const : shotRefs,
      useLastFrame: false,
      frameStillIds: [] as string[],
      identityRefIds,
      poseRefIds,
      poseFromSecond: poseJob,
    };
    if (kind === "video") shots.push(...expandLongVideo(base, wanted));
    else shots.push(makeShot(base));
  }

  if (split?.poses.length) {
    const imageShots = shots.filter((shot) => shot.kind === "image");
    if (imageShots.length < split.poses.length) {
      const template = imageShots[0];
      const extras = split.poses.slice(imageShots.length).map((poseNum, index) =>
        makeShot({
          kind: "image",
          title: `Still ${imageShots.length + index + 1} · pose ${poseNum}`,
          prompt: keepSinhalaDialog(applyPoseIdentityLock(template?.prompt || brief, split.identity.length), brief),
          duration: 0,
          resolution: "480p",
          model: defaultImageModel(),
          refSource: "user",
          useLastFrame: false,
          frameStillIds: [],
          identityRefIds: libraryIds(library, split.identity),
          poseRefIds: libraryIds(library, [poseNum]),
          poseFromSecond: true,
        })
      );
      shots.push(...extras);
    }
  }

  if (!shots.length && askedToGenerate(brief)) {
    const kind: AgentShotKind = askedForVideo(brief) ? "video" : "image";
    const model = kind === "image" ? defaultImageModel() : defaultVideoModel();
    const wanted = kind === "video" ? askedSeconds(brief) || 10 : 0;
    const duration = kind === "video" ? clipVideoDuration(model as VideoTabId, wanted) : 0;
    const poseJob = kind === "image" && Boolean(split?.poses.length);
    const poses = split?.poses || [];
    const identity = split?.identity || [];
    for (const poseNum of poses.length ? poses : [0]) {
      const base = {
        kind,
        title: kind === "video" ? "Video" : poses.length > 1 ? `Still · pose ${poseNum}` : "Still",
        prompt: keepSinhalaDialog(poseJob ? applyPoseIdentityLock(brief, identity.length) : brief, brief),
        duration,
        resolution: "480p" as const,
        model,
        refSource: poseJob ? "user" as const : refSource,
        useLastFrame: false,
        frameStillIds: [] as string[],
        identityRefIds: poseJob ? libraryIds(library, identity) : emptyIds,
        poseRefIds: poseJob && poseNum ? libraryIds(library, [poseNum]) : emptyIds,
        poseFromSecond: poseJob,
      };
      if (kind === "video") {
        shots.push(...expandLongVideo(base, wanted));
        break;
      }
      shots.push(makeShot(base));
    }
  }

  const reply = cleanReply(String(parsed.reply || ""));
  if (!shots.length && !reply) throw new Error("The agent returned no shots.");
  return {
    lock,
    reply,
    shots: !memory.hasPickedVideoRefs && shots.some((shot) => shot.refSource === "created")
      ? assignCreatedStillFrames(shots, memory.createdStills)
      : shots,
  };
}

function refsForShot(memory: AgentMemory, shot: AgentShot) {
  const max = shot.kind === "image" ? findImage(shot.model as ImageTabId).maxImages : findVideo(shot.model as VideoTabId).maxImages;
  if (shot.kind === "image" && (shot.identityRefIds.length || shot.poseRefIds.length)) {
    const poseImgs = imagesFromIds(memory, shot.poseRefIds);
    const room = Math.max(1, max - poseImgs.length);
    const identityImgs = imagesFromIds(memory, shot.identityRefIds).slice(0, room);
    const combined = [...identityImgs];
    for (const img of poseImgs) {
      if (!combined.some((item) => item.id === img.id)) combined.push(img);
    }
    return combined.slice(0, Math.max(1, max));
  }
  if (memory.hasPickedVideoRefs) {
    return memory.chosenRefs.filter((img) => isUsableReferenceImage(img.dataUri)).slice(0, Math.max(1, max));
  }
  const uploads = (memory.userRefs.length ? memory.userRefs : memory.images).filter((img) => isUsableReferenceImage(img.dataUri));
  if (shot.refSource === "both") {
    const combined = [...uploads];
    for (const still of memory.createdStills) {
      if (isUsableReferenceImage(still.dataUri) && !combined.some((img) => img.id === still.id)) combined.push(still);
    }
    return combined.slice(0, Math.max(1, max));
  }
  if (shot.refSource === "user") {
    return uploads.slice(0, Math.max(1, max));
  }
  if (shot.refSource === "created" && !shot.frameStillIds.length && !shot.useLastFrame) {
    return memory.createdStills.filter((img) => isUsableReferenceImage(img.dataUri)).slice(0, Math.max(1, max));
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
  const prompt = shotPrompt(memory.lock, memory.notes, shot, memory.brief);
  const state: TabState = {
    ...emptyTabState(shot.kind),
    images,
    prompt,
    aspect: (shot.kind === "video" ? "16:9" : "3:4") as Aspect,
    quality: "high",
    duration: shot.duration || 10,
    enhancePrompt: false,
    safety: false,
    audio: true,
    resolution: "480p",
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

export function describePlan(_lock: AgentLock, shots: AgentShot[]) {
  const shotLines = shots.map((shot, index) => {
    const extra =
      shot.kind === "video"
        ? `${shot.duration}s 480p${shot.useLastFrame ? " · last frame + remaining stills" : shot.refSource === "both" ? " · uploaded photos + created stills" : shot.refSource === "user" ? " · the photos you picked, in tap order" : " · created stills"}`
        : shot.refSource === "both"
          ? "still · uploaded photos + created stills"
          : shot.refSource === "created"
            ? "still · created stills"
            : "still · uploaded refs";
    return `${index + 1}. ${shot.title} — ${extra} · ${chipLabel(shot.model)}\n${shot.prompt}`;
  });
  return [
    `I'll do one piece at a time. This is the instruction that will go to Qwen/Wan:`,
    "",
    ...shotLines,
    "",
    "Reply continue after each one, or recreate that part.",
  ].join("\n");
}
