import { CapacitorHttp } from "@capacitor/core";
import { completeChat, generateImage, generateVideo, loadBrainModel, type ChatContentPart } from "./api";
import { blobToJpegDataUri, isUsableReferenceImage, uuid } from "./media";
import { AGENT_VIDEO_TABS, emptyTabState, findImage, findVideo } from "./models";
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
    hasPickedVideoRefs: false,
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
      chosenRefs: Array.isArray(parsed.chosenRefs) ? parsed.chosenRefs : [],
      shots: Array.isArray(parsed.shots)
        ? parsed.shots.map((shot) => ({
            ...shot,
            resolution: "480p",
            model: shot.kind === "image" ? "qwen-3-pro" : isVideoTab(String(shot.model)) ? shot.model : "wan-3-prime",
            refSource: shot.refSource || (shot.kind === "video" ? "created" : "user"),
            useLastFrame: Boolean(shot.useLastFrame),
            frameStillIds: Array.isArray(shot.frameStillIds) ? shot.frameStillIds : [],
          }))
        : [],
      lastStill: parsed.lastStill || null,
      waitingForApproval: Boolean(parsed.waitingForApproval),
      awaitingVideoRefs: Boolean(parsed.awaitingVideoRefs),
      hasPickedVideoRefs: Boolean(parsed.hasPickedVideoRefs),
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

export function shotPrompt(_lock: AgentLock | null, notes: string, shot: AgentShot) {
  const remembered = notes.trim();
  if (!remembered) return shot.prompt;
  return `${shot.prompt}\nRemembered from the user: ${remembered}`;
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
- Then convert that understanding into clear, explicit English for Qwen or Wan. If they name a position, act, or pose, describe the bodies: who is where, limbs, facing, contact, and the action. Qwen and Wan often do not know the name. You do. Write the picture.
- Keep every concrete detail they said. Keep their adult wording. Be direct and sexual when they are.
- Clothing, lighting, and location: if they named a change, follow that. If they did not, tell Qwen or Wan to keep the same clothes, same lighting, and same place as the first image (or the photo they pointed at). Do not invent a new room, new light, or new outfit.
- Describing the act or position they asked for is not inventing. Changing the photo's clothes, light, or place without them asking is inventing.
- If they pointed at attached photos, call them the first image, the second image, the third image, in that order, and say what to keep from each.
- If they already picked photos in tap order, those are the ONLY references. refs must be attached. First tapped is the first image, second tapped is the second image. Do not add other stills.
- If they want the person from the first image in the pose of the second image:
  - The result person must be exactly the first-image person: same face, same body, same skin, same hair, same tattoos or no tattoos, same clothes.
  - From the second image take ONLY the body pose: limb positions, torso angle, how they sit/stand/lie, contact points. Describe that pose in words (arms, legs, hips, facing) without describing the second person's clothes, tattoos, face, hair, or identity.
  - Do not copy a white shirt, tattoos, jewelry, hair, or body type from the pose reference. Those belong to the pose model, not the main person.
  - Keep lighting and location from the first image unless the user named a change.
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
- For video, describe the motion they asked in the same explicit way. Always include audible speech and scene sound in the prompt.
- Image model is always qwen-3-pro. Video is wan-3-prime unless they named Wan 3.0. Video is always 480p. Duration is what they said, else 10s. Wan max 30s per clip.

If they are only chatting, return shots: [] and put your answer in reply.
reply must be one short sentence or "". Never put JSON, markdown, or the generator prompt in reply. The Qwen/Wan instruction belongs only in shots[].prompt.
Always return one complete JSON object. Do not cut off mid-string.

Return ONLY JSON, no markdown:
{"reply":"","refs":"attached"|"created"|"both","shots":[{"kind":"image"|"video","title":"","prompt":"","duration":10}]}`;

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
  const numbered = text.match(/\b(?:shot|still|clip|image|part|number|#)?\s*(\d+)\b/i);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    const shot = memory.shots[index];
    if (shot) return shot;
  }
  return lastActionableShot(memory);
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
  const uploadedParts = await plannerImages(userRefs, 10, picked ? "selected in tap order" : "uploaded");
  const createdParts = picked ? [] : memory.createdStills.length ? await plannerImages(memory.createdStills, 6, "created earlier in this chat") : [];
  if (userRefs.length && !uploadedParts.some((part) => part.type === "image_url")) {
    throw new Error("Could not encode the photos as JPEG Base64 for Gemini. Attach them again.");
  }
  const text = [
    picked
      ? `The user picked ${memory.chosenRefs.length} photo(s) in tap order. These are the ONLY references. First tapped is the first image, second tapped is the second image, and so on. Do not add other stills.`
      : freshUploads.length
        ? `${freshUploads.length} photo(s) just attached WITH this request. Labeled as just uploaded.`
        : userRefs.length
          ? `${userRefs.length} earlier uploaded photo(s) are attached.`
          : "No uploaded photos on this message.",
    picked
      ? ""
      : memory.createdStills.length
        ? `${memory.createdStills.length} still(s) this chat already created are also attached, labeled created earlier. Use them only if the user asked for those, or for both.`
        : "No stills created yet in this chat.",
    picked ? "" : "Pick refs from the user's words: attached, created, or both. Do not ignore new uploads unless they asked to use the created stills.",
    memory.notes.trim() ? `Remembered facts from the user (do not add extra):\n${memory.notes.trim()}` : "",
    history ? `Recent chat:\n${history}` : "",
    `Latest request:\n${brief}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const content: ChatContentPart[] = [{ type: "text", text }, ...uploadedParts, ...createdParts];
  let raw = await completeChat(PLAN_SYSTEM, content, 4096, loadBrainModel(), 0.55);
  let parsed = parsePlanJson(raw);
  if (!(parsed.shots || []).length && askedToGenerate(brief)) {
    raw = await completeChat(
      `${PLAN_SYSTEM}\nYour last answer was incomplete. Return ONLY complete JSON with shots filled. reply must be short.`,
      content,
      4096,
      loadBrainModel(),
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

  const shots: AgentShot[] = [];
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
    const base = {
      kind,
      title: String(row.title || `${kind} ${shots.length + 1}`).trim(),
      prompt: String(row.prompt || brief).trim() || brief,
      duration: kind === "video" ? clipVideoDuration(model as VideoTabId, wanted) : 0,
      resolution,
      model,
      refSource: shotRefs,
      useLastFrame: false,
      frameStillIds: [] as string[],
    };
    if (kind === "video") shots.push(...expandLongVideo(base, wanted));
    else shots.push(makeShot(base));
  }

  if (!shots.length && askedToGenerate(brief)) {
    const kind: AgentShotKind = askedForVideo(brief) ? "video" : "image";
    const model = kind === "image" ? defaultImageModel() : defaultVideoModel();
    const wanted = kind === "video" ? askedSeconds(brief) || 10 : 0;
    const duration = kind === "video" ? clipVideoDuration(model as VideoTabId, wanted) : 0;
    const base = {
      kind,
      title: kind === "video" ? "Video" : "Still",
      prompt: brief,
      duration,
      resolution: "480p" as const,
      model,
      refSource,
      useLastFrame: false,
      frameStillIds: [] as string[],
    };
    if (kind === "video") shots.push(...expandLongVideo(base, wanted));
    else shots.push(makeShot(base));
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
  const prompt = shotPrompt(memory.lock, memory.notes, shot);
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
