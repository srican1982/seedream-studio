import type {
  Aspect,
  ImageFamily,
  ImageModel,
  ImageTabId,
  Quality,
  TabId,
  TabState,
  VideoFamily,
  VideoModel,
  VideoTabId,
} from "./types";

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: "seedream-5-pro",
    kind: "image",
    family: "seedream",
    airId: "bytedance:seedream@5.0-pro",
    label: "5.0 Pro",
    subtitle: "Flagship",
    maxImages: 10,
    promptMax: 3000,
  },
  {
    id: "seedream-5-lite",
    kind: "image",
    family: "seedream",
    airId: "bytedance:seedream@5.0-lite",
    label: "5.0 Lite",
    subtitle: "Ultra Fast",
    maxImages: 14,
    promptMax: 3000,
  },
  {
    id: "seedream-4-5",
    kind: "image",
    family: "seedream",
    airId: "bytedance:seedream@4.5",
    label: "4.5",
    subtitle: "Classic",
    maxImages: 14,
    promptMax: 3000,
  },
  {
    id: "qwen-3",
    kind: "image",
    family: "qwen",
    airId: "alibaba:qwen-image@3.0",
    label: "3.0",
    subtitle: "Balanced",
    maxImages: 3,
    promptMax: 32000,
  },
  {
    id: "qwen-3-pro",
    kind: "image",
    family: "qwen",
    airId: "alibaba:qwen-image@3.0-pro",
    label: "3.0 Pro",
    subtitle: "Highest",
    maxImages: 3,
    promptMax: 32000,
  },
  {
    id: "qwen-layered",
    kind: "image",
    family: "qwen",
    airId: "alibaba:qwen-image@layered",
    label: "Layered",
    subtitle: "Qwen Image",
    maxImages: 1,
    promptMax: 32000,
    requiresReference: true,
    skipDimensions: true,
  },
];

export const VIDEO_MODELS: VideoModel[] = [
  {
    id: "seedance-2-5",
    kind: "video",
    family: "seedance",
    airId: "bytedance:seedance@2.5",
    label: "2.5 Pro",
    subtitle: "30s",
    maxImages: 30,
    promptMax: 10000,
    durations: [5, 10, 15, 30],
    resolutions: ["480p", "720p", "1080p"],
    supportsReferenceImages: true,
    audioInSettings: true,
  },
  {
    id: "seedance-2-0",
    kind: "video",
    family: "seedance",
    airId: "bytedance:seedance@2.0",
    label: "2.0 Lite",
    subtitle: "Multimodal",
    maxImages: 9,
    promptMax: 10000,
    durations: [5, 10, 15],
    resolutions: ["480p", "720p", "1080p"],
    supportsReferenceImages: true,
    audioInSettings: true,
  },
  {
    id: "seedance-1-5",
    kind: "video",
    family: "seedance",
    airId: "bytedance:seedance@1.5-pro",
    label: "1.5 Pro",
    subtitle: "Cinematic",
    maxImages: 2,
    promptMax: 3000,
    durations: [5, 10],
    resolutions: ["480p", "720p", "1080p"],
    supportsReferenceImages: false,
    audioInSettings: false,
  },
  {
    id: "wan-3",
    kind: "video",
    family: "wan",
    airId: "alibaba:wan@3.0",
    label: "3.0",
    subtitle: "Wan",
    maxImages: 10,
    promptMax: 20000,
    durations: [5, 10, 15, 30],
    resolutions: ["480p", "720p", "1080p"],
    supportsReferenceImages: true,
    audioInSettings: true,
    usesWidthHeight: true,
  },
  {
    id: "wan-3-prime",
    kind: "video",
    family: "wan",
    airId: "alibaba:wan@3.0-prime",
    label: "3.0 Prime",
    subtitle: "Faster",
    maxImages: 10,
    promptMax: 20000,
    durations: [5, 10, 15, 30],
    resolutions: ["480p", "720p", "1080p"],
    supportsReferenceImages: true,
    audioInSettings: true,
    usesWidthHeight: true,
  },
];

export const IMAGE_TAGS = [
  "Cinematic",
  "Photorealistic 8K",
  "Cyberpunk neon",
  "Anime style",
  "Studio portrait",
];

export const QWEN_TAGS = [
  "The first image is the person",
  "The second image is the pose only",
  "Create a new photo",
  "Keep identity from the first image",
];

export const VIDEO_TAGS = ["Cinematic", "Slow motion", "Dolly zoom", "Aerial drone", "Golden hour"];
export const WAN_TAGS = ["No background music", "Spoken dialogue", "Natural ambience", "Locked camera", "Product close-up"];

export const ASPECTS: Aspect[] = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"];
export const WAN_ASPECTS: Aspect[] = ["1:1", "16:9", "9:16", "4:3", "3:4"];

const DIMENSIONS: Record<ImageTabId, Record<Quality, Record<Aspect, { width: number; height: number }>>> = {
  "seedream-5-pro": {
    basic: {
      "1:1": { width: 1024, height: 1024 },
      "4:3": { width: 1152, height: 864 },
      "3:4": { width: 864, height: 1152 },
      "16:9": { width: 1424, height: 800 },
      "9:16": { width: 800, height: 1424 },
      "21:9": { width: 1568, height: 672 },
    },
    high: {
      "1:1": { width: 2048, height: 2048 },
      "4:3": { width: 2368, height: 1776 },
      "3:4": { width: 1776, height: 2368 },
      "16:9": { width: 2816, height: 1584 },
      "9:16": { width: 1584, height: 2816 },
      "21:9": { width: 3136, height: 1344 },
    },
  },
  "seedream-5-lite": {
    basic: {
      "1:1": { width: 2048, height: 2048 },
      "4:3": { width: 2304, height: 1728 },
      "3:4": { width: 1728, height: 2304 },
      "16:9": { width: 2848, height: 1600 },
      "9:16": { width: 1600, height: 2848 },
      "21:9": { width: 3136, height: 1344 },
    },
    high: {
      "1:1": { width: 3072, height: 3072 },
      "4:3": { width: 3456, height: 2592 },
      "3:4": { width: 2592, height: 3456 },
      "16:9": { width: 4096, height: 2304 },
      "9:16": { width: 2304, height: 4096 },
      "21:9": { width: 4704, height: 2016 },
    },
  },
  "seedream-4-5": {
    basic: {
      "1:1": { width: 2048, height: 2048 },
      "4:3": { width: 2304, height: 1728 },
      "3:4": { width: 1728, height: 2304 },
      "16:9": { width: 2560, height: 1440 },
      "9:16": { width: 1440, height: 2560 },
      "21:9": { width: 3024, height: 1296 },
    },
    high: {
      "1:1": { width: 4096, height: 4096 },
      "4:3": { width: 4608, height: 3456 },
      "3:4": { width: 3456, height: 4608 },
      "16:9": { width: 5120, height: 2880 },
      "9:16": { width: 2880, height: 5120 },
      "21:9": { width: 6048, height: 2592 },
    },
  },
  "qwen-3": {
    basic: {
      "1:1": { width: 1024, height: 1024 },
      "4:3": { width: 1152, height: 864 },
      "3:4": { width: 864, height: 1152 },
      "16:9": { width: 1280, height: 720 },
      "9:16": { width: 720, height: 1280 },
      "21:9": { width: 1344, height: 576 },
    },
    high: {
      "1:1": { width: 1664, height: 1664 },
      "4:3": { width: 1664, height: 1248 },
      "3:4": { width: 1248, height: 1664 },
      "16:9": { width: 1920, height: 1080 },
      "9:16": { width: 1080, height: 1920 },
      "21:9": { width: 2048, height: 880 },
    },
  },
  "qwen-3-pro": {
    basic: {
      "1:1": { width: 1024, height: 1024 },
      "4:3": { width: 1152, height: 864 },
      "3:4": { width: 864, height: 1152 },
      "16:9": { width: 1280, height: 720 },
      "9:16": { width: 720, height: 1280 },
      "21:9": { width: 1344, height: 576 },
    },
    high: {
      "1:1": { width: 1664, height: 1664 },
      "4:3": { width: 1664, height: 1248 },
      "3:4": { width: 1248, height: 1664 },
      "16:9": { width: 1920, height: 1080 },
      "9:16": { width: 1080, height: 1920 },
      "21:9": { width: 2048, height: 880 },
    },
  },
  "qwen-layered": {
    basic: {
      "1:1": { width: 1024, height: 1024 },
      "4:3": { width: 1024, height: 768 },
      "3:4": { width: 768, height: 1024 },
      "16:9": { width: 1024, height: 576 },
      "9:16": { width: 576, height: 1024 },
      "21:9": { width: 1024, height: 440 },
    },
    high: {
      "1:1": { width: 1024, height: 1024 },
      "4:3": { width: 1024, height: 768 },
      "3:4": { width: 768, height: 1024 },
      "16:9": { width: 1024, height: 576 },
      "9:16": { width: 576, height: 1024 },
      "21:9": { width: 1024, height: 440 },
    },
  },
};

const WAN_SIZES: Record<"480p" | "720p" | "1080p", Record<Aspect, { width: number; height: number }>> = {
  "480p": {
    "16:9": { width: 832, height: 480 },
    "9:16": { width: 480, height: 832 },
    "1:1": { width: 624, height: 624 },
    "4:3": { width: 720, height: 544 },
    "3:4": { width: 544, height: 720 },
    "21:9": { width: 832, height: 480 },
  },
  "720p": {
    "16:9": { width: 1280, height: 720 },
    "9:16": { width: 720, height: 1280 },
    "1:1": { width: 960, height: 960 },
    "4:3": { width: 1104, height: 832 },
    "3:4": { width: 832, height: 1104 },
    "21:9": { width: 1280, height: 720 },
  },
  "1080p": {
    "16:9": { width: 1920, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
    "1:1": { width: 1440, height: 1440 },
    "4:3": { width: 1648, height: 1248 },
    "3:4": { width: 1248, height: 1648 },
    "21:9": { width: 1920, height: 1080 },
  },
};

export const VIDEO_SAFETY_MODELS: VideoTabId[] = ["seedance-2-5", "wan-3", "wan-3-prime"];
export const VIDEO_AUDIO_MODELS: VideoTabId[] = ["seedance-2-5", "seedance-2-0", "wan-3", "wan-3-prime"];
export const VIDEO_WAN_MODELS: VideoTabId[] = ["wan-3", "wan-3-prime"];

export function imageModelsFor(family: ImageFamily) {
  return IMAGE_MODELS.filter((model) => model.family === family);
}

export function videoModelsFor(family: VideoFamily) {
  return VIDEO_MODELS.filter((model) => model.family === family);
}

export function imageSize(tab: ImageTabId, aspect: Aspect, quality: Quality) {
  const table = DIMENSIONS[tab][quality];
  return table[aspect] ?? table["1:1"];
}

export function wanSize(aspect: Aspect, resolution: "480p" | "720p" | "1080p") {
  const table = WAN_SIZES[resolution];
  return table[aspect] ?? table["16:9"];
}

export function wanPositivePrompt(prompt: string, audio: boolean) {
  const text = prompt.trim();
  if (!audio) return text;
  const lower = text.toLowerCase();
  const mentionsMusic = /\b(music|soundtrack|score|song|songs|beat|bpm|melody)\b/.test(lower);
  const mentionsAudio = /\b(audio|sound|speech|says|said|saying|dialogue|voice|foley|ambience|ambient|spoken)\b/.test(
    lower
  );
  const extras: string[] = [];
  if (!mentionsMusic) extras.push("Audio: no background music, no soundtrack, no songs.");
  if (!mentionsAudio) extras.push("Use only natural speech, Foley, and room ambience that match the prompt.");
  return extras.length ? `${text} ${extras.join(" ")}` : text;
}

const QWEN_REF_MAX_PIXELS = 2_250_000;

export function fitQwenRefSize(width: number, height: number) {
  if (width * height <= QWEN_REF_MAX_PIXELS) return { width, height };
  const scale = Math.sqrt(QWEN_REF_MAX_PIXELS / (width * height));
  const snap = (n: number) => Math.max(512, Math.round((n * scale) / 16) * 16);
  let nextWidth = snap(width);
  let nextHeight = snap(height);
  while (nextWidth * nextHeight > QWEN_REF_MAX_PIXELS && (nextWidth > 512 || nextHeight > 512)) {
    if (nextWidth >= nextHeight && nextWidth > 512) nextWidth -= 16;
    else if (nextHeight > 512) nextHeight -= 16;
    else break;
  }
  return { width: nextWidth, height: nextHeight };
}

export function qwenPositivePrompt(prompt: string, refCount: number) {
  let text = prompt.trim();
  if (refCount < 1) return text;

  text = text
    .replace(/\bimages?\s*#?\s*1\b/gi, "the first image")
    .replace(/\bimages?\s*#?\s*2\b/gi, "the second image")
    .replace(/\bimages?\s*#?\s*3\b/gi, "the third image")
    .replace(/\bthe\s+the\s+(first|second|third)\s+image\b/gi, "the $1 image");

  if (refCount < 2) return text;

  if (/\bpose\b/i.test(text)) {
    text = `${text} Keep the identity, face, body, and clothes from the first image. Use only the body pose from the second image. Ignore the face and clothes in the second image.`;
  }
  if (!/\b(compose|combine|create (one |a )?new|new (photo|image|photograph))\b/i.test(text)) {
    text = `${text} Create one new image using every reference.`;
  }
  if (!/\bdo not (copy|return|output)\b/i.test(text)) {
    text = `${text} Do not return a copy of any input image.`;
  }
  return text;
}

export function emptyTabState(kind: "image" | "video"): TabState {
  return {
    images: [],
    prompt: "",
    aspect: kind === "video" ? "16:9" : "1:1",
    quality: "basic",
    imageFormat: "PNG",
    videoFormat: "MP4",
    resolution: kind === "video" ? "720p" : "480p",
    duration: 5,
    audio: false,
    safety: false,
    busy: false,
    progress: null,
    error: null,
    result: null,
  };
}

export function initialStates(): Record<TabId, TabState> {
  const image = Object.fromEntries(IMAGE_MODELS.map((m) => [m.id, emptyTabState("image")]));
  const video = Object.fromEntries(VIDEO_MODELS.map((m) => [m.id, emptyTabState("video")]));
  return { ...image, ...video } as Record<TabId, TabState>;
}

export function findImage(id: ImageTabId) {
  return IMAGE_MODELS.find((m) => m.id === id)!;
}

export function findVideo(id: VideoTabId) {
  return VIDEO_MODELS.find((m) => m.id === id)!;
}
