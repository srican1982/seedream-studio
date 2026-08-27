import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Media } from "@capacitor-community/media";
import { Share } from "@capacitor/share";
import { downloadBlob } from "./media";

export type SaveMethod = "gallery" | "share" | "file";

export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

function safeName(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_") || `seedream-${Date.now()}`;
}

function mimeFromName(filename: string, blob: Blob) {
  if (blob.type && blob.type !== "application/octet-stream") return blob.type;
  if (/\.mp4$/i.test(filename)) return "video/mp4";
  if (/\.webm$/i.test(filename)) return "video/webm";
  if (/\.mov$/i.test(filename)) return "video/quicktime";
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.webp$/i.test(filename)) return "image/webp";
  if (/\.gif$/i.test(filename)) return "image/gif";
  return "image/jpeg";
}

async function blobToBase64(blob: Blob) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not encode file"));
    reader.readAsDataURL(blob);
  });
  return dataUrl.split(",")[1] || "";
}

async function photosFromPicker(limit: number) {
  const picked = await Camera.pickImages({
    quality: 90,
    limit,
    correctOrientation: true,
  });

  const files: File[] = [];
  for (const [index, photo] of (picked.photos || []).entries()) {
    const src = photo.webPath || (photo.path ? Capacitor.convertFileSrc(photo.path) : "");
    if (!src) continue;
    const res = await fetch(src);
    const blob = await res.blob();
    const ext = (photo.format || "jpeg").toLowerCase();
    files.push(new File([blob], `gallery-${Date.now()}-${index}.${ext}`, { type: blob.type || `image/${ext}` }));
  }
  return files;
}

export async function pickGalleryImages(limit: number): Promise<File[]> {
  if (limit <= 0) return [];
  if (!isNativeApp()) return [];

  try {
    const current = await Camera.checkPermissions();
    if (current.photos !== "granted" && current.photos !== "limited") {
      await Camera.requestPermissions({ permissions: ["photos"] });
    }
  } catch {
    // Android 13+ Photo Picker can still work without a storage permission.
  }

  try {
    return await photosFromPicker(limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return [];
    try {
      await Camera.requestPermissions({ permissions: ["photos"] });
    } catch {
      /* ignore */
    }
    try {
      return await photosFromPicker(limit);
    } catch {
      throw error instanceof Error ? error : new Error("Could not open the gallery.");
    }
  }
}

async function ensureAlbumId() {
  const albumName = "Seedream Studio";
  const { albums } = await Media.getAlbums();
  let match = albums.find((album) => album.name === albumName);

  if (Capacitor.getPlatform() === "android") {
    try {
      const { path } = await Media.getAlbumsPath();
      match = albums.find((album) => album.name === albumName && album.identifier.startsWith(path)) ?? match;
    } catch {
      /* name match is enough */
    }
  }

  if (!match) {
    await Media.createAlbum({ name: albumName });
    const again = await Media.getAlbums();
    match = again.albums.find((album) => album.name === albumName);
  }

  if (!match) throw new Error("Could not create a gallery album.");
  return match.identifier;
}

async function saveUriToGallery(path: string, filename: string, video: boolean) {
  const name = filename.replace(/\.[^.]+$/, "");
  const save = (albumIdentifier?: string) =>
    video
      ? Media.saveVideo({ path, albumIdentifier, fileName: name })
      : Media.savePhoto({ path, albumIdentifier, fileName: name });

  try {
    await save();
  } catch {
    await save(await ensureAlbumId());
  }
}

async function shareOrThrow(uri: string, filename: string) {
  try {
    await Share.share({
      title: filename,
      files: [uri],
      dialogTitle: "Save to gallery",
    });
    return "share" as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return "share" as const;
    throw new Error("Could not save to the gallery. Allow Photos access and try again.");
  }
}

export async function saveRemoteUrl(url: string, filename: string, video: boolean): Promise<SaveMethod> {
  const name = safeName(filename);
  const downloaded = await Filesystem.downloadFile({
    url,
    path: name,
    directory: Directory.Cache,
    recursive: true,
  });
  const uri = downloaded.path;
  if (!uri) throw new Error("Could not download media.");

  try {
    await saveUriToGallery(uri, name, video);
    return "gallery";
  } catch {
    return shareOrThrow(uri, name);
  }
}

export async function saveAndShare(blob: Blob, filename: string): Promise<SaveMethod> {
  if (!isNativeApp()) {
    downloadBlob(blob, filename);
    return "file";
  }

  const name = safeName(filename);
  const base64 = await blobToBase64(blob);
  const saved = await Filesystem.writeFile({
    path: name,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  });

  try {
    await saveUriToGallery(saved.uri, name, blob.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(name));
    return "gallery";
  } catch {
    try {
      const mime = mimeFromName(name, blob);
      await saveUriToGallery(`data:${mime};base64,${base64}`, name, blob.type.startsWith("video/"));
      return "gallery";
    } catch {
      return shareOrThrow(saved.uri, name);
    }
  }
}
