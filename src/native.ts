import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Camera } from "@capacitor/camera";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { GalleryPick } from "./gallery-pick";
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

export async function pickGalleryMedia(limit: number): Promise<File[]> {
  if (limit <= 0 || !isNativeApp()) return [];
  try {
    const picked = await GalleryPick.pick({ limit });
    const files: File[] = [];
    for (const item of picked.files || []) {
      const src = Capacitor.convertFileSrc(item.path);
      if (!src) continue;
      const res = await fetch(src);
      const blob = await res.blob();
      const mime = item.mime && item.mime !== "application/octet-stream" ? item.mime : blob.type;
      files.push(new File([blob], item.name || `media-${files.length + 1}`, { type: mime || blob.type }));
    }
    return files;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return [];
    throw error instanceof Error ? error : new Error("Could not open the gallery.");
  }
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

function dataPathRelative(localPath: string) {
  const trimmed = localPath.trim();
  const idx = trimmed.indexOf("ai-story/");
  if (idx >= 0) return trimmed.slice(idx);
  return trimmed.startsWith("ai-story/") ? trimmed : `ai-story/${trimmed.replace(/^\/+/, "")}`;
}

/** Path or URI the Android gallery plugin can read (Runware https or Venice app files). */
export async function gallerySourceForResult(result: {
  kind: string;
  url: string;
  localPath?: string;
  remoteUrl?: string;
  filename: string;
}): Promise<string> {
  if (!isNativeApp()) {
    const remote = result.remoteUrl?.trim();
    if (remote) return remote;
    return result.url;
  }

  const remote = result.remoteUrl?.trim();
  if (remote && /^https?:\/\//i.test(remote)) return remote;

  const path = result.localPath?.trim();
  if (path) {
    const rel = dataPathRelative(path);
    try {
      const { uri } = await Filesystem.getUri({ directory: Directory.Data, path: rel });
      if (uri) return uri;
    } catch {
      /* read below */
    }
    if (path.startsWith("/")) return path.startsWith("file://") ? path : `file://${path}`;
    try {
      const read = await Filesystem.readFile({ directory: Directory.Data, path: rel });
      const data = typeof read.data === "string" ? read.data : "";
      if (data) {
        const mime = guessMime(result.filename, result.kind === "video");
        return data.startsWith("data:") ? data : `data:${mime};base64,${data}`;
      }
    } catch {
      /* try play url */
    }
  }

  const play = result.url?.trim() || "";
  if (/^https?:\/\//i.test(play) && !/_capacitor_/i.test(play)) return play;
  if (play.startsWith("file://") || play.startsWith("content://") || play.startsWith("data:")) return play;

  if (play) {
    const res = await fetch(play);
    if (!res.ok) throw new Error("Could not read the video file to save.");
    const blob = await res.blob();
    const mime = blob.type && blob.type !== "application/octet-stream" ? blob.type : guessMime(result.filename, result.kind === "video");
    return `data:${mime};base64,${await blobToBase64(blob)}`;
  }

  throw new Error("Could not read the file to save.");
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
      encoding: Encoding.Base64,
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

export async function localFileToDataUri(path: string, mime = "image/jpeg"): Promise<string | null> {
  if (!path) return null;
  try {
    const read = await Filesystem.readFile({ path });
    const data = read.data;
    if (typeof data !== "string" || !data) return null;
    if (data.startsWith("data:image/")) return data;
    return `data:${mime};base64,${data}`;
  } catch {
    return null;
  }
}

function videoRelPath(filename: string) {
  return `ai-story/${safeName(filename)}`;
}

async function playUrlForRelPath(relPath: string) {
  const { uri } = await Filesystem.getUri({ directory: Directory.Data, path: relPath });
  return { url: Capacitor.convertFileSrc(uri), localPath: relPath };
}

function peekMp4Base64(b64: string) {
  try {
    const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    const raw = atob(clean.slice(0, Math.ceil(256 / 3) * 4));
    return raw.includes("ftyp") || raw.slice(4, 8) === "ftyp";
  } catch {
    return false;
  }
}

/** Save an mp4 into app data the same way Runware does — download HTTPS or write base64 bytes. */
export async function persistNativeVideo(input: {
  httpUrl?: string;
  base64?: string;
  filename: string;
}): Promise<{ url: string; localPath: string; remoteUrl?: string }> {
  const relPath = videoRelPath(input.filename);
  await Filesystem.deleteFile({ directory: Directory.Data, path: relPath }).catch(() => {});

  if (input.httpUrl) {
    try {
      const downloaded = await Filesystem.downloadFile({
        url: input.httpUrl,
        path: relPath,
        directory: Directory.Data,
        recursive: true,
      });
      if (!downloaded.path) throw new Error("download returned no path");
    } catch {
      const res = await CapacitorHttp.get({
        url: input.httpUrl,
        responseType: "blob",
        connectTimeout: 600000,
        readTimeout: 600000,
      });
      if (res.status >= 400 || typeof res.data !== "string" || res.data.length < 1000) {
        throw new Error(`HTTP ${res.status}`);
      }
      const clean = res.data.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
      if (!peekMp4Base64(clean)) throw new Error("response was not an mp4");
      await Filesystem.writeFile({
        path: relPath,
        data: clean,
        directory: Directory.Data,
        recursive: true,
        encoding: Encoding.Base64,
      });
    }
  } else if (input.base64) {
    const clean = input.base64.replace(/^data:[^,]*,/, "").replace(/\s/g, "");
    if (!peekMp4Base64(clean)) throw new Error("response was not an mp4");
    await Filesystem.writeFile({
      path: relPath,
      data: clean,
      directory: Directory.Data,
      recursive: true,
      encoding: Encoding.Base64,
    });
  } else {
    throw new Error("No video source to save.");
  }

  const stat = await Filesystem.stat({ directory: Directory.Data, path: relPath });
  const size = Number(stat.size ?? 0);
  if (!Number.isFinite(size) || size < 500) {
    await Filesystem.deleteFile({ directory: Directory.Data, path: relPath }).catch(() => {});
    throw new Error(`Video file is too small (${size} bytes).`);
  }

  const play = await playUrlForRelPath(relPath);
  return { ...play, remoteUrl: input.httpUrl };
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
    const saved = await persistNativeVideo({ httpUrl: result.url, filename: result.filename });
    return { url: saved.url, localPath: saved.localPath, uuid: undefined };
  } catch {
    return { url: result.url, uuid: result.uuid };
  }
}
