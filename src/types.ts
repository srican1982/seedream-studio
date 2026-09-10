export type Mode = "images" | "video" | "agent";
export type Quality = "basic" | "high";
export type ImageFormat = "PNG" | "JPG" | "WEBP";
export type VideoFormat = "MP4" | "WEBM" | "MOV";
export type Aspect = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9";

export type ImageFamily = "seedream" | "qwen";
export type VideoFamily = "seedance" | "wan";

export type ImageTabId =
  | "seedream-5-pro"
  | "seedream-5-lite"
  | "seedream-4-5"
  | "qwen-3"
  | "qwen-3-pro"
  | "qwen-layered";
export type VideoTabId = "seedance-2-5" | "seedance-2-0" | "seedance-1-5" | "wan-3" | "wan-3-prime";
export type TabId = ImageTabId | VideoTabId;

export type LocalImage = {
  id: string;
  name: string;
  preview: string;
  dataUri: string;
};

export type ResultKind = "image" | "video";

export type StudioResult = {
  kind: ResultKind;
  url: string;
  localPath?: string;
  remoteUrl?: string;
  uuid?: string;
  cost?: number;
  filename: string;
};

export type TabState = {
  images: LocalImage[];
  prompt: string;
  aspect: Aspect;
  quality: Quality;
  imageFormat: ImageFormat;
  videoFormat: VideoFormat;
  resolution: "480p" | "720p" | "1080p";
  duration: number;
  audio: boolean;
  safety: boolean;
  enhancePrompt: boolean;
  busy: boolean;
  progress: number | null;
  error: string | null;
  result: StudioResult | null;
};

export type ImageModel = {
  id: ImageTabId;
  kind: "image";
  family: ImageFamily;
  airId: string;
  label: string;
  subtitle: string;
  maxImages: number;
  promptMax: number;
  requiresReference?: boolean;
  skipDimensions?: boolean;
};

export type VideoModel = {
  id: VideoTabId;
  kind: "video";
  family: VideoFamily;
  airId: string;
  label: string;
  subtitle: string;
  maxImages: number;
  promptMax: number;
  durations: number[];
  resolutions: Array<"480p" | "720p" | "1080p">;
  supportsReferenceImages: boolean;
  audioInSettings: boolean;
  usesWidthHeight?: boolean;
};

export type Model = ImageModel | VideoModel;
