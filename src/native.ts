import { Capacitor } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { GallerySave } from "./gallery-save";
import { downloadBlob } from "./media";

export type SaveMethod = "gallery" | "share" | "file";

export function isNativeApp() {
  return Capacitor.isNativePlatform();
}

function safeName(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_") || `seedream-${Date.now()}`;
}

function guessMime(filename: string, video: boolean) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return video ? "video/mp4" : "image/jpeg";
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
  if (limit <= 0 || !isNativeApp()) return [];

  try {
    const current = await Camera.checkPermissions();
    if (current.photos !== "granted" && current.photos !== "limited") {
      await Camera.requestPermissions({ permissions: ["photos"] });
    }
  } catch {
    /* Android 13+ Photo Picker can work without this. */
  }

  try {
    return await photosFromPicker(limit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return [];
    throw error instanceof Error ? error : new Error("Could not open the gallery.");
  }
}

async function shareFile(uri: string, filename: string): Promise<SaveMethod> {
  try {
    await Share.share({
      title: filename,
      files: [uri],
      dialogTitle: "Save to gallery",
    });
    return "share";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return "share";
    throw error;
  }
}

export async function saveToDeviceGallery(source: string, filename: string, video: boolean): Promise<SaveMethod> {
  const name = safeName(filename);
  const mime = guessMime(name, video);
  try {
    await GallerySave.save({ source, filename: name, mime, video });
    return "gallery";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || "Could not save to the gallery.");
  }
}

export async function saveAndShare(blob: Blob, filename: string): Promise<SaveMethod> {
  if (!isNativeApp()) {
    downloadBlob(blob, filename);
    return "file";
  }

  const name = safeName(filename);
  const video = blob.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(name);
  const mime = blob.type && blob.type !== "application/octet-stream" ? blob.type : guessMime(name, video);
  const dataUri = `data:${mime};base64,${await blobToBase64(blob)}`;

  try {
    return await saveToDeviceGallery(dataUri, name, video);
  } catch (first) {
    const saved = await Filesystem.writeFile({
      path: name,
      data: dataUri.split(",")[1] || "",
      directory: Directory.Cache,
      recursive: true,
    });
    try {
      return await saveToDeviceGallery(saved.uri, name, video);
    } catch {
      try {
        return await shareFile(saved.uri, name);
      } catch {
        throw first instanceof Error ? first : new Error("Could not save to the gallery.");
      }
    }
  }
}

export async function persistNativeResult(result: {
  url: string;
  filename: string;
  uuid?: string;
}): Promise<{ url: string; localPath?: string; uuid?: string }> {
  if (!isNativeApp() || !/^https?:/i.test(result.url)) {
    return { url: result.url, uuid: result.uuid };
  }

  try {
    const downloaded = await Filesystem.downloadFile({
      url: result.url,
      path: safeName(result.filename),
      directory: Directory.Cache,
      recursive: true,
    });
    if (!downloaded.path) return { url: result.url, uuid: result.uuid };
    return {
      url: Capacitor.convertFileSrc(downloaded.path),
      localPath: downloaded.path,
      uuid: result.uuid,
    };
  } catch {
    return { url: result.url, uuid: result.uuid };
  }
}
