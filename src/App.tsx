import { useEffect, useState } from "react";
import { checkHealth, ensureDeviceConfig, hasLocalApiKey, hasLocalOpenRouterKey, saveApiKey, saveOpenRouterKey, type Health } from "./api";
import AgentView from "./AgentView";

export default function App() {
  const [health, setHealth] = useState<Health>({ ok: false, configured: false, grok: false, native: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [grokDraft, setGrokDraft] = useState("");

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
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            <Gear />
          </button>
        </div>
      </header>

      <div className="scroll chat-mode">
        <AgentView chatsOpen={chatsOpen} onChatsOpenChange={setChatsOpen} />
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
            <button type="submit">Save</button>
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
