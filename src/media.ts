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

export function isVideoFile(file: File) {
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}

export function isAudioFile(file: File) {
  if (file.type.startsWith("audio/")) return true;
  return /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
}

export function isUsableReferenceImage(value: string) {
  if (!value) return false;
  if (/^data:image\/(png|jpe?g|webp|heic|heif|avif);base64,/i.test(value)) {
    return (value.split(",")[1] || "").replace(/\s/g, "").length > 32;
  }
  return /^https?:\/\//i.test(value) && !/localhost|_capacitor_file_|_capacitor_content_/i.test(value);
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
