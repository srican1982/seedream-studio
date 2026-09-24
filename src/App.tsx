import { useEffect, useRef, useState } from "react";
declare const __APP_BUILD__: string;
import {
  checkHealth,
  ensureDeviceConfig,
  hasLocalApiKey,
  hasLocalOpenRouterKey,
  purgeRunwareServerCopies,
  saveApiKey,
  saveOpenRouterKey,
  type Health,
} from "./api";
import AgentView from "./AgentView";

export default function App() {
  const [health, setHealth] = useState<Health>({ ok: false, configured: false, grok: false, native: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [grokDraft, setGrokDraft] = useState("");
  const [runwarePurgeDraft, setRunwarePurgeDraft] = useState("");
  const [runwarePurgeStatus, setRunwarePurgeStatus] = useState("");
  const [runwarePurgeBusy, setRunwarePurgeBusy] = useState(false);
  const [runwarePurgeFocus, setRunwarePurgeFocus] = useState(false);
  const runwarePurgeRef = useRef<HTMLTextAreaElement>(null);

  const appBuildLabel =
    typeof __APP_BUILD__ === "string" && __APP_BUILD__ !== "dev" ? __APP_BUILD__.slice(0, 7) : "dev";

  function openSettings(runware = false) {
    setRunwarePurgeFocus(runware);
    setSettingsOpen(true);
  }

  useEffect(() => {
    if (!settingsOpen || !runwarePurgeFocus) return;
    const scroll = () => runwarePurgeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    requestAnimationFrame(scroll);
    const t = window.setTimeout(scroll, 120);
    return () => window.clearTimeout(t);
  }, [settingsOpen, runwarePurgeFocus]);

  useEffect(() => {
    void (async () => {
      await ensureDeviceConfig();
      const h = await checkHealth();
      setHealth(h);
      if (!h.configured) setSettingsOpen(true);
    })();
    setKeyDraft(hasLocalApiKey() ? "••••••••••••" : "");
    setGrokDraft(hasLocalOpenRouterKey() ? "••••••••••••" : "");
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const vv = window.visualViewport;
      const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      root.style.setProperty("--kb", `${Math.round(covered)}px`);
      document.body.classList.toggle("kb-open", covered > 80);
    };
    sync();
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("focusin", sync);
    return () => {
      window.visualViewport?.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("focusin", sync);
      root.style.removeProperty("--kb");
      document.body.classList.remove("kb-open");
    };
  }, []);

  return (
    <div className="app app-chat">
      <header className="top chat-header">
        <div className="top-left">
          <button className="icon-btn" type="button" aria-label="Chats" onClick={() => setChatsOpen((open) => !open)}>
            <ChatsIcon />
          </button>
          <div>
            <div className="brand">AI Story</div>
          </div>
        </div>
        <div className="top-actions">
          <span className={`status ${health.configured ? "on" : "off"}`}>
            <i />
            {health.configured ? "API Online" : "API Key"}
          </span>
          <button className="icon-btn" onClick={() => openSettings(false)} aria-label="Settings">
            <Gear />
          </button>
        </div>
      </header>

      <div className="scroll chat-mode">
        <AgentView chatsOpen={chatsOpen} onChatsOpenChange={setChatsOpen} onOpenRunwareCleanup={() => openSettings(true)} />
      </div>

      {settingsOpen && (
        <div className="sheet" onClick={() => setSettingsOpen(false)}>
          <form
            className="sheet-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (keyDraft && !keyDraft.includes("•")) saveApiKey(keyDraft);
              if (grokDraft && !grokDraft.includes("•")) saveOpenRouterKey(grokDraft);
              setSettingsOpen(false);
              void checkHealth().then(setHealth);
            }}
          >
            <h2>Settings</h2>
            <p>
              Web uses keys from <code>.env</code>. On the phone APK, paste keys here — they stay on this device only.
            </p>
            <label>Runware API key</label>
            <input
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder="rw_..."
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            <label>OpenRouter API key</label>
            <input
              type="password"
              autoComplete="off"
              value={grokDraft}
              placeholder="sk-or-v1-..."
              onChange={(e) => setGrokDraft(e.target.value)}
            />
            <hr className="sheet-divider" />
            <h3 id="runware-server-photos">Delete photos on Runware server</h3>
            <p className="sheet-note">
              Paste links from Runware&apos;s site (<code>mm.runware.ai/.../id/…</code>) or the file UUID, one per line. New Wan uploads are removed automatically after each video.
            </p>
            <label htmlFor="runware-purge">Paste Runware links or IDs here</label>
            <textarea
              id="runware-purge"
              ref={runwarePurgeRef}
              rows={3}
              placeholder="https://mm.runware.ai/media-storage/.../id/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              value={runwarePurgeDraft}
              onChange={(e) => setRunwarePurgeDraft(e.target.value)}
            />
            <button
              type="button"
              className="ghost"
              disabled={runwarePurgeBusy || !health.configured}
              onClick={() => {
                setRunwarePurgeBusy(true);
                setRunwarePurgeStatus("");
                void purgeRunwareServerCopies(runwarePurgeDraft)
                  .then(({ requested, removed }) => {
                    setRunwarePurgeStatus(
                      requested
                        ? `Sent delete for ${requested} file${requested === 1 ? "" : "s"} (${removed} accepted by Runware).`
                        : "No Runware file IDs found on this phone. Paste links from the Runware site above, or open a photo there and copy its URL."
                    );
                  })
                  .catch((error) => {
                    setRunwarePurgeStatus(error instanceof Error ? error.message : "Could not delete Runware files.");
                  })
                  .finally(() => setRunwarePurgeBusy(false));
              }}
            >
              {runwarePurgeBusy ? "Deleting…" : "Delete Runware copies this phone knows"}
            </button>
            {runwarePurgeStatus ? <p className="sheet-status">{runwarePurgeStatus}</p> : null}
            <button type="submit">Save API keys</button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                saveApiKey("");
                saveOpenRouterKey("");
                setKeyDraft("");
                setGrokDraft("");
                setSettingsOpen(false);
                void checkHealth().then(setHealth);
              }}
            >
              Clear device keys
            </button>
            <p className="sheet-build">App build {appBuildLabel}</p>
          </form>
        </div>
      )}
    </div>
  );
}

function ChatsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
    </svg>
  );
}

function Gear() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.7.9 1.2 1.6 1.3H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
