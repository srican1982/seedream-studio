import { Capacitor, registerPlugin } from "@capacitor/core";

type KeepAlivePlugin = {
  start(options?: { title?: string; text?: string }): Promise<void>;
  stop(): Promise<void>;
  sleep(options: { ms: number }): Promise<void>;
  pollRunware(options: {
    taskUUID: string;
    apiKey: string;
    timeoutMs?: number;
  }): Promise<{
    row: Record<string, unknown>;
    wipeIds?: unknown;
    localPath?: string;
  }>;
};

const KeepAlive = registerPlugin<KeepAlivePlugin>("KeepAlive");

export async function startKeepAlive(text = "Generating… You can switch apps.") {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await KeepAlive.start({ title: "AI Story", text });
  } catch {
    /* permission denied or older WebView — generation can still run in-app */
  }
}

export async function stopKeepAlive() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await KeepAlive.stop();
  } catch {
    /* ignore */
  }
}

export async function withKeepAlive<T>(text: string, work: () => Promise<T>): Promise<T> {
  await startKeepAlive(text);
  try {
    return await work();
  } finally {
    await stopKeepAlive();
  }
}

export async function nativeSleep(ms: number) {
  if (!Capacitor.isNativePlatform()) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  try {
    await KeepAlive.sleep({ ms });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export async function nativePollRunware(taskUUID: string, apiKey: string, timeoutMs = 15 * 60 * 1000) {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const done = await KeepAlive.pollRunware({ taskUUID, apiKey, timeoutMs });
    if (!done?.row || typeof done.row !== "object") return null;
    const wipeIds = Array.isArray(done.wipeIds)
      ? done.wipeIds.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    return {
      row: done.row,
      wipeIds,
      localPath: typeof done.localPath === "string" ? done.localPath : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unimplemented|not implemented|plugin/i.test(message)) return null;
    throw error instanceof Error ? error : new Error("Generation failed.");
  }
}
