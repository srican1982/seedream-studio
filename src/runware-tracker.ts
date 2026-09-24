import { idbReadChat } from "./chat-store";

const TRACK_KEY = "runware_tracked_uploads_v1";
const CHATS_KEY = "seedream_agent_chats_v2";
const MEMORY_PREFIX = "seedream_agent_memory_";

const RUNWARE_HOST = /runware\.ai/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

export function uuidFromRunwareMediaUrl(url: string) {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i.exec(url)?.[1];
}

function isRunwareId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function harvestRunwareIdsFromText(text: string) {
  const ids = new Set<string>();
  if (!text) return [];
  const urlRe = /https?:\/\/[^\s"'<>]+/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(text))) {
    const url = match[0];
    if (!RUNWARE_HOST.test(url)) continue;
    const id = uuidFromRunwareMediaUrl(url);
    if (id) ids.add(id);
  }
  if (RUNWARE_HOST.test(text)) {
    for (const id of text.match(UUID_RE) || []) {
      if (isRunwareId(id)) ids.add(id);
    }
  }
  return [...ids];
}

export function parseRunwareIdsFromUserInput(raw: string) {
  const ids = new Set<string>();
  for (const line of raw.split(/[\s,;]+/)) {
    const part = line.trim();
    if (!part) continue;
    if (isRunwareId(part)) {
      ids.add(part);
      continue;
    }
    for (const id of harvestRunwareIdsFromText(part)) ids.add(id);
  }
  return [...ids];
}

export function loadTrackedRunwareUploads(): string[] {
  try {
    const raw = localStorage.getItem(TRACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && isRunwareId(id));
  } catch {
    return [];
  }
}

export function rememberRunwareUploads(ids: string[]) {
  const next = new Set(loadTrackedRunwareUploads());
  for (const id of ids) {
    if (isRunwareId(id)) next.add(id);
  }
  if (!next.size) return;
  try {
    localStorage.setItem(TRACK_KEY, JSON.stringify([...next].slice(-500)));
  } catch {
    /* quota */
  }
}

export function forgetTrackedRunwareUploads(ids: string[]) {
  const drop = new Set(ids);
  const kept = loadTrackedRunwareUploads().filter((id) => !drop.has(id));
  try {
    if (kept.length) localStorage.setItem(TRACK_KEY, JSON.stringify(kept));
    else localStorage.removeItem(TRACK_KEY);
  } catch {
    /* ignore */
  }
}

function readChatIndexIds(): string[] {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { chats?: Array<{ id?: string }> };
    if (!Array.isArray(parsed.chats)) return [];
    return parsed.chats.map((chat) => chat.id).filter((id): id is string => typeof id === "string" && Boolean(id));
  } catch {
    return [];
  }
}

export async function collectRunwareIdsOnDevice() {
  const ids = new Set(loadTrackedRunwareUploads());
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (!key.startsWith(MEMORY_PREFIX) && key !== CHATS_KEY) continue;
    const value = localStorage.getItem(key);
    if (!value) continue;
    for (const id of harvestRunwareIdsFromText(value)) ids.add(id);
  }
  for (const chatId of readChatIndexIds()) {
    const memory = await idbReadChat(chatId);
    if (!memory) continue;
    try {
      for (const id of harvestRunwareIdsFromText(JSON.stringify(memory))) ids.add(id);
    } catch {
      /* ignore */
    }
  }
  return [...ids];
}
