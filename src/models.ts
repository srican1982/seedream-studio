import type { Aspect, ImageModel, ImageTabId, Quality, TabId, TabState, VideoModel, VideoTabId } from "./types";

export const IMAGE_MODELS: ImageModel[] = [
  {
    id: "seedream-5-pro",
    kind: "image",
    airId: "bytedance:seedream@5.0-pro",
    label: "5.0 Pro",
    subtitle: "Flagship",
    maxImages: 10,
    promptMax: 3000,
  },
  {
    id: "seedream-5-lite",
    kind: "image",
    airId: "bytedance:seedream@5.0-lite",
    label: "5.0 Lite",
    subtitle: "Ultra Fast",
    maxImages: 14,
    promptMax: 3000,
  },
  {
    id: "seedream-4-5",
    kind: "image",
    airId: "bytedance:seedream@4.5",
    label: "4.5",
    subtitle: "Classic",
    maxImages: 14,
    promptMax: 3000,
  },
];

export const VIDEO_MODELS: VideoModel[] = [
  {
    id: "seedance-2-5",
    kind: "video",
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
];

export const IMAGE_TAGS = [
  "Cinematic",
  "Photorealistic 8K",
  "Cyberpunk neon",
  "Anime style",
  "Studio portrait",
];

export const VIDEO_TAGS = ["Cinematic", "Slow motion", "Dolly zoom", "Aerial drone", "Golden hour"];

export const ASPECTS: Aspect[] = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"];

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
};

export const VIDEO_SAFETY_MODELS: VideoTabId[] = ["seedance-2-5"];
export const VIDEO_AUDIO_MODELS: VideoTabId[] = ["seedance-2-5", "seedance-2-0"];

export function imageSize(tab: ImageTabId, aspect: Aspect, quality: Quality) {
  const table = DIMENSIONS[tab][quality];
  return table[aspect] ?? table["1:1"];
}

export function emptyTabState(kind: "image" | "video"): TabState {
  return {
    images: [],
    prompt: "",
    aspect: "1:1",
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
