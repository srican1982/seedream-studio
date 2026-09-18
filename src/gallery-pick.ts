import { registerPlugin } from "@capacitor/core";

export type PickedMedia = {
  path: string;
  name: string;
  mime: string;
  kind: "image" | "video" | "audio";
};

type GalleryPickPlugin = {
  pick(options: { limit: number }): Promise<{ files: PickedMedia[] }>;
};

export const GalleryPick = registerPlugin<GalleryPickPlugin>("GalleryPick");
