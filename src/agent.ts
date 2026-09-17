import { CapacitorHttp } from "@capacitor/core";
import { brainFromText, completeChat, generateImage, generateVideo, loadBrainModel, saveBrainModel, type ChatContentPart } from "./api";
import { cacheChat, cachedChat, dropCachedChat, idbDeleteChat, idbReadChat, idbWriteChat, readLocalChat, writeLocalChat } from "./chat-store";
import { getPeople, loadPeople, peopleNames, type PersonPack } from "./people-store";
import { blobToJpegDataUri, isUsableReferenceImage, uuid } from "./media";
import { AGENT_VIDEO_TABS, emptyTabState, findImage, findVideo } from "./models";
import { isNativeApp, localFileToDataUri } from "./native";
import type { Aspect, ImageTabId, LocalImage, StudioResult, TabState, VideoTabId } from "./types";

type VideoResolution = "480p" | "720p" | "1080p";

const MEMORY_KEY = "seedream_agent_memory_v2";
const CHATS_KEY = "seedream_agent_chats_v2";

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
  shotId?: string;
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
  personIds: string[];
  awaitingTrainName: boolean;
  awaitingTrainPhotos: boolean;
  trainName: string;
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
    personIds: [],
    awaitingTrainName: false,
    awaitingTrainPhotos: false,
    trainName: "",
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
  return sanitizeMemory({
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
    personIds: Array.isArray(parsed.personIds) ? parsed.personIds.filter((id): id is string => typeof id === "string") : [],
    awaitingTrainName: Boolean(parsed.awaitingTrainName),
    awaitingTrainPhotos: Boolean(parsed.awaitingTrainPhotos),
    trainName: parsed.trainName || "",
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
  });
}

function sanitizeMemory(memory: AgentMemory): AgentMemory {
  const target =
    (memory.recreateShotId && memory.shots.find((shot) => shot.id === memory.recreateShotId)) ||
    lastActionableShot(memory);
  const usable = Boolean(target?.result?.url || target?.prompt);
  const canRecreate = Boolean(memory.awaitingRecreate && target && usable);
  const canApprove = Boolean(nextPendingShot(memory) || lastActionableShot(memory));
  return {
    ...memory,
    awaitingRecreate: canRecreate,
    recreateShotId: canRecreate ? memory.recreateShotId || target?.id || "" : "",
    recreateNote: canRecreate ? memory.recreateNote : "",
    waitingForApproval: Boolean(memory.waitingForApproval && canApprove),
  };
}

function parseMaybeMemory(raw: unknown): AgentMemory | null {
  if (!raw || typeof raw !== "object") return null;
  try {
    return parseStoredMemory(raw as AgentMemory);
  } catch {
    return null;
  }
}

function readLocalMemory(id: string): AgentMemory | null {
  return parseMaybeMemory(readLocalChat(id, chatMemoryKey(id)));
}

async function readChatMemory(id: string): Promise<AgentMemory | null> {
  const cached = cachedChat(id);
  if (cached) return parseMaybeMemory(cached);
  const fromIdb = parseMaybeMemory(await idbReadChat(id));
  if (fromIdb) {
    cacheChat(id, fromIdb);
    return fromIdb;
  }
  const fromLocal = readLocalMemory(id);
  if (fromLocal) {
    cacheChat(id, fromLocal);
    void idbWriteChat(id, fromLocal);
    return fromLocal;
  }
  return null;
}

function writeChatMemory(id: string, memory: AgentMemory) {
  cacheChat(id, memory);
  writeLocalChat(chatMemoryKey(id), memory);
  void idbWriteChat(id, memory);
}

async function persistChatMemory(id: string, memory: AgentMemory) {
  cacheChat(id, memory);
  writeLocalChat(chatMemoryKey(id), memory);
  await idbWriteChat(id, memory);
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

export async function loadAgentMemory(): Promise<AgentMemory> {
  const index = loadChatIndex();
  return (await readChatMemory(index.activeId)) || emptyAgentMemory();
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

async function persistActive(memory: AgentMemory) {
  const index = loadChatIndex();
  writeChatIndex({
    ...index,
    chats: index.chats.map((chat) =>
      chat.id === index.activeId
        ? { ...chat, title: chatTitleFromMemory(memory), updatedAt: Date.now() }
        : chat
    ),
  });
  await persistChatMemory(index.activeId, memory);
}

export async function startNewAgentChat(current: AgentMemory) {
  if (!current.messages.length) return current;
  await persistActive(current);
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

export async function openAgentChat(id: string, current: AgentMemory) {
  const index = loadChatIndex();
  if (id === index.activeId || !index.chats.some((chat) => chat.id === id)) return current;
  await persistActive(current);
  writeChatIndex({ ...loadChatIndex(), activeId: id });
  return (await readChatMemory(id)) || emptyAgentMemory();
}

export async function deleteAgentChat(id: string, current: AgentMemory) {
  const index = loadChatIndex();
  if (index.activeId !== id) await persistActive(current);
  dropCachedChat(id);
  try {
    localStorage.removeItem(chatMemoryKey(id));
  } catch {
    /* ignore */
  }
  await idbDeleteChat(id);
  const chats = index.chats.filter((chat) => chat.id !== id);
  if (!chats.length) {
    const fresh = createFreshIndex();
    return (await readChatMemory(fresh.activeId)) || emptyAgentMemory();
  }
  const activeId = index.activeId === id ? chats.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0].id : index.activeId;
  writeChatIndex({ activeId, chats });
  if (activeId === index.activeId && index.activeId !== id) return current;
  return (await readChatMemory(activeId)) || emptyAgentMemory();
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

export function shotPrompt(lock: AgentLock | null, notes: string, shot: AgentShot, brief = "") {
  let prompt = shot.poseFromSecond ? applyPoseIdentityLock(shot.prompt, shot.identityRefIds.length) : shot.prompt;
  prompt = keepSinhalaDialog(prompt, brief);
  const bits: string[] = [];
  if (notes.trim()) bits.push(`Remembered from the user: ${notes.trim()}`);
  if (lock?.atmosphere) bits.push(`Keep this place unless they asked to change it: ${lock.atmosphere}.`);
  if (lock?.wardrobe) bits.push(`Keep clothes unless they asked to change them: ${lock.wardrobe}.`);
  if (shot.kind === "video" && shot.useLastFrame) {
    bits.push(
      "Use the attached picture as the first frame. Continue from those exact pixels. Same person, same place, same clothes, same light until the last second. Do not start a new shot of a different person. Do not change location."
    );
  }
  if (shot.kind === "video" && !askedForSpokenWords(brief)) {
    bits.push("No spoken dialogue. Do not have anyone say the user's Sinhala, Singlish, or English instructions. Scene sound only.");
  }
  const named = peopleInText(`${brief}\n${notes}\n${shot.prompt}`, getPeople());
  if (named.length || (shot.useLastFrame && getPeople().length)) {
    const who = named.length ? named.map((person) => person.name).join(", ") : "the saved people";
    bits.push(
      `${who} is already in that first frame. Keep that same face and body. If they turn, it is this same person turning in this place — not a new face and not a bedroom.`
    );
  }
  if (!bits.length) return prompt;
  return `${prompt}\n${bits.join(" ")}`;
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

function askedForSpokenWords(text: string) {
  return (
    /\b(say|says|said|saying|speak|speaks|speaking|spoken|dialogue|dialog|voiceover|voice over|lines?\s*:)\b/i.test(text) ||
    /කියන්න|කියලා\s*දෙන්න|මේ\s*(වචන|කතාව)|බයන/.test(text)
  );
}

function sinhalaDialogs(text: string) {
  if (!askedForSpokenWords(text)) return [] as string[];
  const quoted = [...text.matchAll(/[“"']([^“"']*[\u0D80-\u0DFF][^“"']*)[”"']/g)].map((m) => m[1].trim());
  const afterSay = text.split(/\b(?:say|says|said|saying|speak|speaks|speaking)\b|කියන්න\s*:?/i).slice(1).join(" ");
  const source = quoted.length ? quoted.join("\n") : afterSay || text;
  const runs = [...source.matchAll(/[\u0D80-\u0DFF][^\n]*/g)].map((m) => m[0].trim()).filter((item) => item.length >= 2);
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
- Sinhala, Singlish, and English in the chat are DIRECTIONS to you, not lines for the characters. Translate the scene into English for Qwen/Wan. Do not have anyone speak the user's instructions.
- Spoken words only if they clearly asked to say/speak them ("say", "speak", "dialogue", "කියන්න", or quoted lines meant to be said). Then copy those exact words. Sinhala spoken words stay in Sinhala letters. Do not romanize them.
- If they did not ask for spoken words, put no dialogue in shot.prompt. No invented lines. Scene sound is fine.
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
- This chat may be one movie. If a movie lock place is given, keep that place, clothes, and people unless they named a change. "part 3", "next clip", "continue the movie", or another video in the same chat is the same movie: refs is both (uploaded people + clip-start/clip-end). clip-end is where the last clip stopped. clip-start is who appeared at the start of the last clip, including friends who are gone by the ending frame.
- Named saved people: look at their saved photos for face, body, front, and back. Write that into shot.prompt. Wan cannot take a last-frame pin and training photos in the same call. The last frame is the opening frame so it stays the same person. If they ask to turn or show the front, a still of that same person in the last-frame place is made first, then animated.
- Training photos often come from another room. Never copy those rooms into the movie. If clip-end exists, that place is the whole clip. Do not open or end in a bedroom.
- Qwen 3.0 Pro can only take 3 reference images. Wan can take 10. If there are more, keep the ones the user cares about most, usually new uploads first.
- For video, describe the motion they asked in the same explicit way. Include scene sound. Add spoken words only if they asked someone to say them.
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

export function askedToGenerate(text: string) {
  return askedForVideo(text) || /\b(make|create|generate|image|photo|still|picture|render)\b/i.test(text) || /හදන්න/.test(text);
}

export function latestUserText(memory: AgentMemory) {
  return [...memory.messages].reverse().find((item) => item.role === "user")?.text.trim() || memory.brief.trim();
}

export function isRememberOnly(text: string) {
  return /^\s*remember\b/i.test(text) && !/\b(make|create|generate|render|video|still|shot|series|clip)\b/i.test(text);
}

function wordDistance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1][j - 1]
          : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  return rows[a.length][b.length];
}

function trainWord(raw: string) {
  return raw.toLowerCase().replace(/[^a-z]/g, "");
}

function isTrainTypo(raw: string) {
  const word = trainWord(raw);
  if (word.length < 4 || word.length > 12) return false;
  if (/^(travel|travels|transfer|transit|triangle|trend|trends|tracker|track)$/.test(word)) return false;
  const folded = word.replace(/ei|ie/g, "ai").replace(/d(?=in)/g, "").replace(/(.)\1+/g, "$1");
  return (
    /^(train|training|trainin|traini|trainig|trining)$/.test(folded) ||
    wordDistance(folded, "training") <= 2 ||
    wordDistance(folded, "train") <= 1
  );
}

export function isTrainCommand(text: string) {
  const t = text.trim();
  if (/^\s*(please\s+)?(train|training|save person|save people|learn person)\b/i.test(t)) return true;
  const first = t.split(/\s+/)[0] || "";
  return isTrainTypo(first);
}

export function isForgetPerson(text: string) {
  return /^\s*forget\b/i.test(text.trim());
}

export function trainNameFrom(text: string) {
  let cut = text
    .replace(/^\s*(please\s+)?(train|training|save person|save people|learn person|forget)\b[:\s-]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cut === text.replace(/\s+/g, " ").trim()) {
    const words = text.trim().split(/\s+/);
    if (words[0] && isTrainTypo(words[0])) cut = words.slice(1).join(" ");
  }
  return cut && !/^(him|her|them|this|that|person|people)$/i.test(cut) ? cut : "";
}

function nameInText(name: string, text: string) {
  const n = name.trim();
  if (n.length < 2) return false;
  try {
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}_])`, "iu").test(
      text
    );
  } catch {
    return text.toLowerCase().includes(n.toLowerCase());
  }
}

export function peopleInText(text: string, packs = getPeople()): PersonPack[] {
  return packs.filter((person) => nameInText(person.name, text));
}

function peopleForMemory(memory: AgentMemory): PersonPack[] {
  const packs = getPeople();
  const text = [memory.brief, memory.notes, ...memory.messages.slice(-8).map((item) => item.text)].join("\n");
  const named = peopleInText(text, packs);
  if (named.length) return named;
  const locked = packs.filter((person) => memory.personIds.includes(person.id));
  if (locked.length) return locked;
  const movieFollow =
    Boolean(memory.lastStill) ||
    memory.createdStills.some((img) => img.name === CLIP_START || img.name === CLIP_END);
  return movieFollow && packs.length === 1 ? packs : [];
}

function personPhotoIdSet() {
  return new Set(getPeople().flatMap((person) => person.photos.map((img) => img.id)));
}

function isPersonPackPhoto(img: LocalImage) {
  return personPhotoIdSet().has(img.id);
}

function personRefImages(memory: AgentMemory, max: number) {
  const packs = peopleForMemory(memory);
  if (!packs.length) return [] as LocalImage[];
  const per = packs.length >= 3 ? 1 : packs.length === 2 ? 2 : Math.min(3, max);
  const out: LocalImage[] = [];
  for (const pack of packs) {
    for (const img of pack.photos.slice(0, per)) pushRef(out, img);
  }
  return out.slice(0, max);
}

export function isContinue(text: string) {
  return /^(ok|okay|k|yes|yep|yeah|continue|next|go|good|fine|approved|looks good|do it|proceed|හරි|ඔව්|ඔව්නේ|හොඳයි|ඉදිරියට)(?:\s*[.!])*$/i.test(text.trim());
}

const CLIP_START = "clip-start";
const CLIP_END = "clip-end";

function isFreshMovie(text: string) {
  return /\b(new movie|new story|different (movie|story|people)|start over)\b/i.test(text);
}

function shouldContinueMovie(memory: AgentMemory, brief: string) {
  if (memory.hasPickedVideoRefs || isFreshMovie(brief)) return false;
  if (latestUserPhotos(memory).length) return false;
  const hasClip =
    Boolean(memory.lastStill) ||
    memory.createdStills.some((img) => img.name === CLIP_START || img.name === CLIP_END) ||
    memory.shots.some((shot) => shot.kind === "video" && shot.status === "done");
  if (!hasClip) return false;
  return /\b(part\s*\d+|next (part|clip|scene)|continue (the )?(movie|story|scene|video)|same movie|from (the )?last|another (clip|part)|clip-end|last frame)\b/i.test(
    brief
  );
}

function extractPlace(text: string) {
  const places = [
    "park",
    "beach",
    "hotel",
    "bedroom",
    "kitchen",
    "street",
    "garden",
    "car",
    "club",
    "pool",
    "forest",
    "house",
    "apartment",
    "room",
    "restaurant",
    "bar",
    "office",
    "shop",
    "temple",
    "school",
    "bus",
    "train",
    "lake",
    "mountain",
    "village",
    "city",
  ];
  const lower = text.toLowerCase();
  const hit = places.find((place) => new RegExp(`\\b${place}\\b`, "i").test(lower));
  if (hit) return hit;
  if (/උයන|පාර්ක්/.test(text)) return "park";
  if (/වෙරළ|බීච්/.test(text)) return "beach";
  if (/හෝටල්/.test(text)) return "hotel";
  if (/ගෙදර|නිවස/.test(text)) return "house";
  return "";
}

function mergeMovieLock(prev: AgentLock | null, brief: string): AgentLock {
  const place = extractPlace(brief);
  return {
    identity: prev?.identity || "",
    wardrobe: prev?.wardrobe || "",
    lighting: prev?.lighting || "",
    camera: prev?.camera || "",
    atmosphere: place || prev?.atmosphere || "",
  };
}

export function isRecreate(text: string) {
  const t = text.trim();
  if (!t) return false;
  if (
    /^(please\s+)?(recreate|redo|retry|remake)(\s+this)?(\s+(one|part|clip|shot|video|still|picture|image|it))?(\s*[.!]*)?$/i.test(
      t
    )
  ) {
    return true;
  }
  return /^(ආයෙ(\s+හදන්න)?|නැවත(\s+හදන්න)?|නැවතත්(\s+හදන්න)?)(\s*[.!]*)?$/i.test(t);
}

export function nextPendingShot(memory: AgentMemory) {
  return memory.shots.find((shot) => shot.status === "pending") || null;
}

export function continueStatus(memory: AgentMemory): { memory: AgentMemory; next: AgentShot | null; text: string } {
  const cleared: AgentMemory = {
    ...memory,
    awaitingRecreate: false,
    recreateShotId: "",
    recreateNote: "",
    awaitingVideoRefs: false,
    waitingForApproval: false,
    hasPickedVideoRefs: false,
  };
  const next = nextPendingShot(cleared);
  const last = lastActionableShot(cleared);
  const waiting = cleared.shots.filter((shot) => shot.status === "pending");
  if (next) {
    const kind = next.kind === "video" ? `${next.duration}s video` : "still";
    const queue = waiting.length > 1 ? ` ${waiting.length} pieces are still in the queue.` : "";
    return {
      memory: cleared,
      next,
      text: `Moving forward.\n\nNow: ${next.title} (${kind}).${queue}`,
    };
  }
  const lastBit =
    last?.status === "done" ? `${last.title} is done.` : last?.status === "error" ? `${last.title} failed.` : "Nothing is in the queue.";
  return {
    memory: cleared,
    next: null,
    text: `Moving forward. ${lastBit}\n\nNow: tell me the next scene, or attach a new photo and ask for a video.`,
  };
}

export function lastActionableShot(memory: AgentMemory) {
  return [...memory.shots].reverse().find((shot) => shot.status === "done" || shot.status === "error") || null;
}

export function recreateShot(memory: AgentMemory, text: string) {
  if (memory.recreateShotId) {
    const current = memory.shots.find((item) => item.id === memory.recreateShotId);
    if (current) return current;
  }
  const numbered = text.match(/\b(?:shot|still|clip|part)\s*(\d+)\b/i);
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
    ? "What should I change in this video? Type it in the box below if you want. You can leave it empty to remake the same clip. Tap different pictures on the bar if you want those too. Then tap Recreate."
    : "What should I change in this picture? Type it in the box below if you want. You can leave it empty to remake the same still. Tap different photos on the bar if you want those too. Then tap Recreate.";
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
If they typed spoken dialog in Sinhala letters after asking someone to say it, those spoken words must stay in those exact Sinhala letters. Do not romanize.
If they did not ask for spoken words, do not add dialogue.
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
    const useLastFrame = index > 0 || shot.useLastFrame;
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
      ? `That one failed. Continue skips it and makes ${pending.title} next. Recreate this only if you want this piece remade.`
      : `That one failed. Continue to move on, or recreate this if you want it remade.`;
  }
  if (pending) {
    return `Now: ${pending.title} is next. Continue to make that. Recreate this only if you want this last piece remade.`;
  }
  const stills = memory.createdStills.filter((img) => img.name !== CLIP_START && img.name !== CLIP_END).length;
  const videos = memory.shots.filter((item) => item.kind === "video" && item.status === "done").length;
  if (videos > 1) {
    return `Those clips are ready. Play them in order for the full video.\n\nNow: tell me the next scene, or attach a new photo and ask for a video.`;
  }
  if (stills) {
    return `Those stills are ready.\n\nNow: tell me the next scene, or attach a new photo and ask for a video.`;
  }
  return `Done.\n\nNow: tell me the next scene, or attach a new photo and ask for a video.`;
}

function askedForBoth(text: string) {
  return /\b(both|use both|all of them together|plus the (stills|ones|images|photos)|and the (stills|images|photos) (you |we )?(already )?(made|created|generated)|those stills (too|as well)|previous stills|created stills|දෙකම|ඔක්කොම)\b/i.test(text);
}

export function askedForVideo(text: string) {
  return /\b(video|videos|clip|clips|animate|animation|movie|film)\b/i.test(text) || /වීඩියෝ|වීඩියෝව|ක්ලිප්/.test(text);
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
  const hasCreated = memory.createdStills.length > 0 || Boolean(memory.lastStill);
  const hasUploads = freshUploads.length > 0 || memory.userRefs.length > 0 || memory.images.length > 0;
  if (shouldContinueMovie(memory, brief) && hasUploads) return "both";
  if (/\b(both|all)\b/.test(raw) && hasCreated && hasUploads) return "both";
  if (/\b(created|stills|generated)\b/.test(raw) && hasCreated) return "created";
  if (/\b(attached|uploaded|user|new)\b/.test(raw)) return "user";
  if (freshUploads.length && hasCreated && askedForBoth(brief)) return "both";
  if (freshUploads.length) return "user";
  if (hasCreated && askedForVideo(brief) && hasUploads) return "both";
  if (hasCreated && askedForVideo(brief)) return "created";
  return "user";
}

export async function planAgentJob(memory: AgentMemory): Promise<{ lock: AgentLock; shots: AgentShot[]; reply: string; personIds: string[] }> {
  await loadPeople();
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
    .slice(-12)
    .map((item) => `${item.role}: ${item.text}`)
    .join("\n");
  const uploadedParts = picked
    ? await plannerImages(userRefs, 10, "selected in tap order")
    : await plannerLibrary(library);
  const createdParts = picked || library.length ? [] : memory.createdStills.length ? await plannerImages(memory.createdStills, 6, "created earlier in this chat") : [];
  const namedPeople = peopleInText(`${brief}\n${memory.notes}\n${history}`);
  const personIds = [...new Set([...memory.personIds, ...namedPeople.map((person) => person.id), ...peopleForMemory(memory).map((person) => person.id)])];
  const savedPacks = getPeople().filter((person) => personIds.includes(person.id));
  const personParts = savedPacks.length
    ? await plannerImages(
        savedPacks.flatMap((person) => person.photos.slice(0, 3)),
        6,
        "saved person — face, body, front, back only. Ignore this room. Last-frame side view is the real place"
      )
    : [];
  if ((picked ? userRefs : library).length && !uploadedParts.some((part) => part.type === "image_url")) {
    throw new Error("Could not encode the photos as JPEG Base64 for Gemini. Attach them again.");
  }
  const text = [
    picked
      ? `The user picked ${memory.chosenRefs.length} photo(s) in tap order. First tapped is the starting frame. Attach saved-person photos AFTER that as identity only. A picked last-frame side view is pose/camera in the current place — do not replace that place with a training-photo room.`
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
    memory.lock?.atmosphere ? `Movie lock — keep this place unless they named a change: ${memory.lock.atmosphere}.` : "",
    savedPacks.length
      ? `Saved people for this job: ${savedPacks.map((person) => person.name).join(", ")}. You can see their photos. Write face, body, front, and back into shot.prompt. Wan will not get those training pixels when a last frame exists. A last-frame side view is pose/camera in the CURRENT place from start to end — never open or finish in a training-photo room.`
      : peopleNames().length
        ? `Saved people available: ${peopleNames().join(", ")}. Use them if the user names them.`
        : "",
    shouldContinueMovie(memory, brief)
      ? "This is the next part of the same movie. clip-end is the only place picture. Keep friends from clip-start even if they are missing from clip-end. Do not change location to match a training photo at the start or the end."
      : "",
    history ? `Recent chat:\n${history}` : "",
    SINHALA.test(brief)
      ? askedForSpokenWords(brief)
        ? "They asked for spoken words. Copy those exact Sinhala letters into shot.prompt as dialogue. Do not romanize."
        : "This request has Sinhala or Singlish as instructions only. Write the scene in English. Do not make anyone speak those Sinhala or Singlish words."
      : "",
    `Latest request:\n${brief}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const askedBrain = brainFromText(brief);
  if (askedBrain) saveBrainModel(askedBrain);
  const brain = askedBrain || loadBrainModel();
  const content: ChatContentPart[] = [{ type: "text", text }, ...personParts, ...uploadedParts, ...createdParts];
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
  const movieFollow = shouldContinueMovie(memory, brief);
  const lock: AgentLock = mergeMovieLock(memory.lock, brief);
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
      useLastFrame: kind === "video" && movieFollow,
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
        useLastFrame: kind === "video" && movieFollow,
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
    personIds,
    shots: !memory.hasPickedVideoRefs && shots.some((shot) => shot.refSource === "created")
      ? assignCreatedStillFrames(shots, memory.createdStills)
      : shots,
  };
}

function pushRef(out: LocalImage[], img: LocalImage | null | undefined) {
  if (!img || !isUsableReferenceImage(img.dataUri) || out.some((item) => item.id === img.id)) return;
  out.push(img);
}

function withPersonRefs(memory: AgentMemory, images: LocalImage[], max: number, sceneFirst: boolean) {
  const scene = images.filter((img) => !isPersonPackPhoto(img));
  const out: LocalImage[] = [];
  if (sceneFirst) {
    for (const img of scene) pushRef(out, img);
    return out.slice(0, Math.max(1, max));
  }
  for (const img of personRefImages(memory, max)) pushRef(out, img);
  for (const img of scene) {
    if (out.length >= max) break;
    pushRef(out, img);
  }
  return out.slice(0, Math.max(1, max));
}

function movieCastRefs(memory: AgentMemory, max: number) {
  const people = (memory.userRefs.length ? memory.userRefs : memory.images).filter(
    (img) => isUsableReferenceImage(img.dataUri) && !isPersonPackPhoto(img)
  );
  const start = memory.createdStills.find((img) => img.name === CLIP_START);
  const end =
    memory.lastStill ||
    memory.createdStills.find((img) => img.name === CLIP_END);
  const extras = memory.createdStills.filter((img) => img.name !== CLIP_START && img.name !== CLIP_END);
  const scene: LocalImage[] = [];
  pushRef(scene, end);
  pushRef(scene, start);
  for (const img of extras) pushRef(scene, img);
  for (const img of people) pushRef(scene, img);
  return withPersonRefs(memory, scene, max, true);
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
    return withPersonRefs(
      memory,
      memory.chosenRefs.filter((img) => isUsableReferenceImage(img.dataUri)),
      max,
      shot.kind === "video"
    );
  }
  if (
    shot.kind === "video" &&
    (shot.useLastFrame || memory.lastStill || memory.createdStills.some((img) => img.name === CLIP_START || img.name === CLIP_END))
  ) {
    const movie = movieCastRefs(memory, max);
    if (movie.length) return movie;
  }
  const uploads = (memory.userRefs.length ? memory.userRefs : memory.images).filter((img) => isUsableReferenceImage(img.dataUri));
  if (shot.refSource === "both") {
    const combined = [...uploads];
    for (const still of memory.createdStills) {
      if (isUsableReferenceImage(still.dataUri) && !combined.some((img) => img.id === still.id)) combined.push(still);
    }
    return withPersonRefs(memory, combined, max, shot.kind === "video" || Boolean(memory.lastStill));
  }
  if (shot.refSource === "user") {
    return withPersonRefs(memory, uploads, max, shot.kind === "video" && Boolean(memory.lastStill || shot.useLastFrame));
  }
  if (shot.refSource === "created" && !shot.frameStillIds.length && !shot.useLastFrame) {
    return withPersonRefs(
      memory,
      memory.createdStills.filter((img) => isUsableReferenceImage(img.dataUri)),
      max,
      shot.kind === "video"
    );
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
  return withPersonRefs(memory, frames, max, true);
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
  if (result.kind !== "image") {
    const frames = await captureVideoFrames(result.url);
    return frames.end || frames.start;
  }
  const sources = [result.remoteUrl, result.url, result.localPath].filter((item): item is string => Boolean(item));
  for (const source of sources) {
    try {
      const dataUri = await sourceToJpegDataUri(source);
      if (dataUri) return { id: uuid(), name: CLIP_END, preview: dataUri, dataUri };
    } catch {
      /* try next source */
    }
  }
  return null;
}

function snapFrame(video: HTMLVideoElement, name: string): LocalImage {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 720;
  canvas.height = video.videoHeight || 1280;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(video, 0, 0);
  const dataUri = canvas.toDataURL("image/jpeg", 0.82);
  return { id: uuid(), name, preview: dataUri, dataUri };
}

async function captureVideoFrames(url: string): Promise<{ start: LocalImage | null; end: LocalImage | null }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    if (/^https?:\/\//i.test(url) && !/_capacitor_/i.test(url)) video.crossOrigin = "anonymous";
    let start: LocalImage | null = null;
    let step: "start" | "end" = "start";
    const done = (end: LocalImage | null = null) => resolve({ start, end });
    const timer = window.setTimeout(() => done(null), 12000);
    const finish = (end: LocalImage | null) => {
      window.clearTimeout(timer);
      done(end);
    };
    video.onerror = () => finish(null);
    video.onloadeddata = () => {
      try {
        const duration = video.duration || 1;
        video.currentTime = Math.min(0.12, Math.max(0, duration * 0.04));
      } catch {
        finish(null);
      }
    };
    video.onseeked = () => {
      try {
        if (step === "start") {
          start = snapFrame(video, CLIP_START);
          step = "end";
          const endTime = Math.max(0, (video.duration || 1) - 0.08);
          if (Math.abs(endTime - video.currentTime) < 0.05) {
            finish({ id: uuid(), name: CLIP_END, preview: start.preview, dataUri: start.dataUri });
            return;
          }
          video.currentTime = endTime;
          return;
        }
        finish(snapFrame(video, CLIP_END));
      } catch {
        finish(start);
      }
    };
    video.src = url;
  });
}

function upsertClipStills(existing: LocalImage[], start: LocalImage | null, end: LocalImage | null) {
  const next = existing.filter((img) => img.name !== CLIP_START && img.name !== CLIP_END && img.name !== "last-still");
  if (start) next.push(start);
  if (end) next.push(end);
  return next;
}

function needsUnseenAngle(text: string) {
  return /\b(turn\w*|facing|face the|to the front|from the front|from the back|look at (the )?camera|towards? (the )?camera|හරව|ඉස්සරහට|මුහුණ)\b/i.test(
    text
  );
}

function clipEndImage(memory: AgentMemory) {
  const end = memory.lastStill || memory.createdStills.find((img) => img.name === CLIP_END);
  return end && isUsableReferenceImage(end.dataUri) ? end : null;
}

function identityOnScenePrompt(memory: AgentMemory, action: string) {
  const who = peopleForMemory(memory).map((person) => person.name).join(", ") || "the same person";
  return [
    `The last image is the current scene. Keep that exact place, clothes, lighting, and camera world.`,
    `The earlier images are ${who} from other angles — same face, same body, same hair, same skin.`,
    `One still of ${who} in the last image's place, matching: ${action}.`,
    `Same face as those photos and as the person already in the last image. Do not invent a new person.`,
    `Ignore any bedroom, bed, wall, or indoor light in the earlier images. Those rooms must not appear.`,
  ].join(" ");
}

async function firstFrameForVideo(
  memory: AgentMemory,
  shot: AgentShot,
  prompt: string,
  onProgress?: (n: number) => void
): Promise<LocalImage | null> {
  const end = clipEndImage(memory);
  if (!end) return null;
  const packs = personRefImages(memory, 2);
  if (!packs.length || !needsUnseenAngle(`${memory.brief}\n${shot.prompt}\n${prompt}`)) return end;
  const still = await generateImage(
    defaultImageModel(),
    {
      ...emptyTabState("image"),
      images: [...packs, end].slice(0, 3),
      prompt: identityOnScenePrompt(memory, shot.prompt || memory.brief),
      aspect: "16:9" as Aspect,
      quality: "high",
      enhancePrompt: false,
      safety: false,
    },
    onProgress
  );
  return (await resultToStill(still)) || end;
}

export async function runAgentShot(
  memory: AgentMemory,
  shotId: string,
  onProgress?: (n: number) => void
): Promise<AgentMemory> {
  await loadPeople();
  const shot = memory.shots.find((item) => item.id === shotId);
  if (!shot) throw new Error("Shot missing.");
  const images = refsForShot(memory, shot);
  const prompt = shotPrompt(memory.lock, memory.notes, shot, memory.brief);
  const wanFrame = shot.kind === "video" ? await firstFrameForVideo(memory, shot, prompt, onProgress) : null;
  const state: TabState = {
    ...emptyTabState(shot.kind),
    images: wanFrame ? [wanFrame] : images,
    wanFrames: wanFrame ? [wanFrame] : undefined,
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

  const still = result.kind === "image" ? await resultToStill(result) : null;
  const clipFrames = result.kind === "video" ? await captureVideoFrames(result.url) : { start: null, end: null };
  const clipEnd = clipFrames.end || clipFrames.start;
  return {
    ...memory,
    lastStill: shot.kind === "video" ? clipEnd || memory.lastStill : memory.lastStill,
    createdStills:
      shot.kind === "video"
        ? upsertClipStills(memory.createdStills, clipFrames.start, clipEnd)
        : still
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
        ? `${shot.duration}s 480p${shot.useLastFrame ? " · last frame + people photos" : shot.refSource === "both" ? " · uploaded photos + created stills" : shot.refSource === "user" ? " · the photos you picked, in tap order" : " · created stills"}`
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
