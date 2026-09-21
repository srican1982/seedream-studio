import type { Aspect } from "./types";

export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const n = (Math.random() * 16) | 0;
    const v = ch === "x" ? n : (n & 0x3) | 0x8;
    return v.toString(16);
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function compressViaCanvas(file: File, maxEdge: number, quality: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Canvas unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Could not decode ${file.name}`));
    };
    img.src = objectUrl;
  });
}

export function isImageFile(file: File) {
  if (file.type.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif|bmp|avif)$/i.test(file.name);
}

export function isSpokenAudioName(name: string) {
  return /^spoken[-_]/i.test(name || "");
}

export function isVideoFile(file: File) {
  if (file.type.startsWith("audio/") || isSpokenAudioName(file.name)) return false;
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}

export function isAudioFile(file: File) {
  if (file.type.startsWith("audio/") || isSpokenAudioName(file.name)) return true;
  return /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
}

export function isWanAudioFormat(value: string, mime = "") {
  const check = `${mime} ${value}`;
  return /audio\/(wav|x-wav|mpeg|mp3)/i.test(check) || /\.(wav|mp3)(\?|$)/i.test(value);
}

function audioContextCtor() {
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext || w.webkitAudioContext;
}

function mixMono(buffer: AudioBuffer, maxSamples: number) {
  const length = Math.min(buffer.length, maxSamples);
  const out = new Float32Array(length);
  const left = buffer.getChannelData(0);
  if (buffer.numberOfChannels < 2) {
    out.set(left.subarray(0, length));
    return out;
  }
  const right = buffer.getChannelData(1);
  for (let i = 0; i < length; i++) out[i] = (left[i] + right[i]) / 2;
  return out;
}

function resampleMono(samples: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = samples[Math.min(samples.length - 1, Math.floor(i * ratio))];
  return out;
}

export function encodeWav(samples: Float32Array, sampleRate: number) {
  const dataSize = samples.length * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([out], { type: "audio/wav" });
}

export async function blobToWavBlob(blob: Blob, maxSecs = 60): Promise<Blob> {
  const Ctor = audioContextCtor();
  if (!Ctor) throw new Error("This device cannot convert audio to WAV.");
  const ctx = new Ctor();
  try {
    const raw = await blob.arrayBuffer();
    const buffer = await ctx.decodeAudioData(raw.slice(0));
    const rate = Math.min(22050, buffer.sampleRate);
    const maxSamples = Math.floor(buffer.sampleRate * maxSecs);
    const mono = resampleMono(mixMono(buffer, maxSamples), buffer.sampleRate, rate);
    return encodeWav(mono, rate);
  } catch {
    throw new Error("Wan needs WAV or MP3. That sound could not be converted.");
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export async function ensureWanAudioDataUri(source: string): Promise<string> {
  const value = source.trim();
  if (!value) throw new Error("Missing audio.");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return value;
  if (isWanAudioFormat(value)) return value;
  const blob = await fetch(value).then((res) => res.blob());
  const wav = await blobToWavBlob(blob);
  return readAsDataUrl(new File([wav], "spoken.wav", { type: "audio/wav" }));
}

export function isUsableReferenceImage(value: string) {
  if (!value) return false;
  if (/^data:image\/(png|jpe?g|webp|heic|heif|avif);base64,/i.test(value)) {
    return (value.split(",")[1] || "").replace(/\s/g, "").length > 32;
  }
  return /^https?:\/\//i.test(value) && !/localhost|_capacitor_file_|_capacitor_content_/i.test(value);
}

export function isImagePreview(value: string) {
  return /^data:image\//i.test(value || "");
}

export async function videoPosterDataUri(source: string): Promise<string> {
  if (!source) return "";
  if (isImagePreview(source)) return source;
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    if (/^https?:\/\//i.test(source) && !/_capacitor_/i.test(source)) video.crossOrigin = "anonymous";
    let settled = false;
    const finish = (uri: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(uri);
    };
    const timer = window.setTimeout(() => finish(""), 8000);
    const snap = () => {
      try {
        const canvas = document.createElement("canvas");
        const width = video.videoWidth || 0;
        const height = video.videoHeight || 0;
        if (!width || !height) {
          finish("");
          return;
        }
        const scale = Math.min(1, 480 / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish("");
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        finish("");
      }
    };
    video.onerror = () => finish("");
    video.onloadeddata = () => {
      try {
        const duration = video.duration || 1;
        video.currentTime = Math.min(0.2, Math.max(0, duration * 0.05));
      } catch {
        snap();
      }
    };
    video.onseeked = () => snap();
    video.src = source;
  });
}

export function isUsableMediaUrl(value: string) {
  if (!value) return false;
  if (/^data:(image|video|audio)\//i.test(value)) {
    return (value.split(",")[1] || "").replace(/\s/g, "").length > 32;
  }
  return /^https?:\/\//i.test(value) && !/localhost|_capacitor_file_|_capacitor_content_/i.test(value);
}

export async function blobToJpegDataUri(blob: Blob, maxEdge = 1400, quality = 0.82): Promise<string | null> {
  const mime = blob.type.startsWith("image/") ? blob.type : "image/jpeg";
  const file = new File([blob], "still.jpg", { type: mime });
  const uri = await fileToDataUri(file, maxEdge, quality);
  return isUsableReferenceImage(uri) ? uri : null;
}

export function aspectRatio(aspect: Aspect) {
  const [wide, high] = aspect.split(":").map(Number);
  return wide > 0 && high > 0 ? wide / high : 16 / 9;
}

export async function fitImageDataUriToAspect(source: string, aspect: Aspect, maxEdge = 1280): Promise<string> {
  if (!source || !/^data:image\//i.test(source)) return source;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const target = aspectRatio(aspect);
        const srcRatio = img.width / Math.max(1, img.height);
        let sx = 0;
        let sy = 0;
        let sw = img.width;
        let sh = img.height;
        if (srcRatio > target) {
          sw = Math.max(1, Math.round(img.height * target));
          sx = Math.round((img.width - sw) / 2);
        } else if (srcRatio < target) {
          sh = Math.max(1, Math.round(img.width / target));
          sy = Math.round((img.height - sh) / 2);
        }
        const scale = Math.min(1, maxEdge / Math.max(sw, sh));
        let dw = Math.max(1, Math.round(sw * scale));
        let dh = Math.max(1, Math.round(sh * scale));
        const minEdge = 240;
        if (Math.min(dw, dh) < minEdge) {
          const up = minEdge / Math.min(dw, dh);
          dw = Math.max(minEdge, Math.round(dw * up));
          dh = Math.max(minEdge, Math.round(dh * up));
        }
        const canvas = document.createElement("canvas");
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(source);
          return;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      } catch {
        resolve(source);
      }
    };
    img.onerror = () => resolve(source);
    img.src = source;
  });
}

export async function fileToDataUri(file: File, maxEdge = 1600, quality = 0.88): Promise<string> {
  if (!isImageFile(file)) return readAsDataUrl(file);
  try {
    return await compressViaCanvas(file, maxEdge, quality);
  } catch {
    return readAsDataUrl(file);
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function downloadDataUri(dataUri: string, filename: string) {
  const res = await fetch(dataUri);
  downloadBlob(await res.blob(), filename);
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function appendTag(prompt: string, tag: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return tag;
  if (trimmed.toLowerCase().includes(tag.toLowerCase())) return prompt;
  return `${trimmed}, ${tag}`;
}
