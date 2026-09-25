import { registerPlugin } from "@capacitor/core";
import { blobToWavBlob } from "./media";
import { isNativeApp } from "./native";

type VoiceRecordPlugin = {
  requestMic(): Promise<void>;
};

const VoiceRecord = registerPlugin<VoiceRecordPlugin>("VoiceRecord");

const PREFERRED = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];

export function recorderMime() {
  if (typeof MediaRecorder === "undefined") return "";
  return PREFERRED.find((item) => MediaRecorder.isTypeSupported(item)) || "";
}

export function recorderExt(mime: string) {
  if (/mp4|aac|m4a/i.test(mime)) return "m4a";
  if (/ogg/i.test(mime)) return "ogg";
  if (/wav/i.test(mime)) return "wav";
  return "webm";
}

export function spokenAudioType(mime: string) {
  const raw = (mime || "audio/webm").split(";")[0].trim().toLowerCase();
  if (raw.startsWith("audio/")) return raw;
  if (raw === "video/webm") return "audio/webm";
  if (raw === "video/mp4") return "audio/mp4";
  if (raw.includes("aac")) return "audio/aac";
  return "audio/webm";
}

export function spokenAudioFile(parts: BlobPart[], mime: string) {
  const type = spokenAudioType(mime);
  return new File(parts, `spoken-${Date.now()}.${recorderExt(type)}`, { type });
}

export async function spokenWavFile(blob: Blob) {
  const wav = await blobToWavBlob(blob);
  return new File([wav], `spoken-${Date.now()}.wav`, { type: "audio/wav" });
}

export function formatRecordSecs(secs: number) {
  const safe = Math.max(0, Math.floor(secs));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export async function requestMicrophone() {
  if (isNativeApp()) {
    await VoiceRecord.requestMic();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This device cannot record audio here. Attach a file instead.");
  }
}

export const VOICE_MAX_SECS = 60;
