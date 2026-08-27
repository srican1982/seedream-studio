import { registerPlugin } from "@capacitor/core";

export type GallerySaveOptions = {
  source: string;
  filename: string;
  mime?: string;
  video?: boolean;
};

type GallerySavePlugin = {
  save(options: GallerySaveOptions): Promise<{ uri: string }>;
};

export const GallerySave = registerPlugin<GallerySavePlugin>("GallerySave");
