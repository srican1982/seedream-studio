const DB_NAME = "ai_story_chats";
const STORE = "chats";

type ChatBlob = Record<string, unknown>;
type ImageBlob = { id?: string; name?: string; preview?: string; dataUri?: string };
type ResultBlob = { url?: string; remoteUrl?: string };

const memoryCache = new Map<string, ChatBlob>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function shrinkImage(img: ImageBlob, dropBytes: boolean): ImageBlob {
  if (dropBytes) return { ...img, preview: "", dataUri: "" };
  const src = img.preview || img.dataUri || "";
  const keep = src.length < 140_000 ? src : "";
  return { ...img, preview: keep, dataUri: keep };
}

function shrinkResult(result: ResultBlob | undefined) {
  if (!result) return undefined;
  const url = result.remoteUrl && /^https?:/i.test(result.remoteUrl) ? result.remoteUrl : result.url || "";
  if (url.startsWith("data:")) return { ...result, url: result.remoteUrl || "" };
  return { ...result, url };
}

function slimMemory(memory: ChatBlob, dropBytes: boolean): ChatBlob {
  const img = (item: ImageBlob) => shrinkImage(item, dropBytes);
  const list = (items: unknown) => (Array.isArray(items) ? items.map((item) => img(item as ImageBlob)) : []);
  const shots = Array.isArray(memory.shots)
    ? memory.shots.map((shot) => ({ ...(shot as ChatBlob), result: shrinkResult((shot as ChatBlob).result as ResultBlob | undefined) }))
    : [];
  const messages = Array.isArray(memory.messages)
    ? memory.messages.map((message) => {
        const row = message as ChatBlob;
        return {
          ...row,
          images: Array.isArray(row.images) ? row.images.map((item) => img(item as ImageBlob)) : undefined,
          result: shrinkResult(row.result as ResultBlob | undefined),
        };
      })
    : [];
  return {
    ...memory,
    images: list(memory.images),
    userRefs: list(memory.userRefs),
    createdStills: list(memory.createdStills),
    chosenRefs: list(memory.chosenRefs),
    wanFrames: list(memory.wanFrames),
    wanPeople: list(memory.wanPeople),
    wanPoseRefs: list(memory.wanPoseRefs),
    wanClips: list(memory.wanClips),
    wanAudios: list(memory.wanAudios),
    wanClip: null,
    wanAudio: null,
    lastStill: memory.lastStill ? img(memory.lastStill as ImageBlob) : null,
    shots,
    messages,
  };
}

function textOnlyMemory(memory: ChatBlob): ChatBlob {
  const slim = slimMemory(memory, true);
  return {
    ...slim,
    images: [],
    userRefs: [],
    createdStills: [],
    chosenRefs: [],
    wanFrames: [],
    wanPeople: [],
    wanPoseRefs: [],
    wanClips: [],
    wanAudios: [],
    wanClip: null,
    wanAudio: null,
    lastStill: null,
    messages: Array.isArray(slim.messages)
      ? slim.messages.map((message) => ({ ...(message as ChatBlob), images: undefined }))
      : [],
  };
}

export function cacheChat(id: string, memory: ChatBlob) {
  memoryCache.set(id, memory);
}

export function cachedChat(id: string) {
  return memoryCache.get(id) || null;
}

export function dropCachedChat(id: string) {
  memoryCache.delete(id);
}

export function readLocalChat(_id: string, key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeLocalChat(key: string, memory: ChatBlob) {
  const attempts = [memory, slimMemory(memory, false), slimMemory(memory, true), textOnlyMemory(memory)];
  for (const item of attempts) {
    try {
      localStorage.setItem(key, JSON.stringify(item));
      return;
    } catch {
      /* try a smaller copy */
    }
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export async function idbReadChat(id: string): Promise<ChatBlob | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as ChatBlob) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function idbWriteChat(id: string, memory: ChatBlob) {
  const attempts = [memory, slimMemory(memory, false), slimMemory(memory, true)];
  for (const item of attempts) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.objectStore(STORE).put(item, id);
      });
      return;
    } catch {
      /* try a smaller copy */
    }
  }
}

export async function idbDeleteChat(id: string) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).delete(id);
    });
  } catch {
    /* ignore */
  }
}
