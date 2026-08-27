import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  checkHealth,
  downloadResult,
  ensureDeviceConfig,
  generateImage,
  generateVideo,
  hasLocalApiKey,
  saveApiKey,
  type Health,
} from "./api";
import { appendTag, fileToDataUri, uuid } from "./media";
import {
  ASPECTS,
  IMAGE_MODELS,
  IMAGE_TAGS,
  VIDEO_AUDIO_MODELS,
  VIDEO_MODELS,
  VIDEO_SAFETY_MODELS,
  VIDEO_TAGS,
  findImage,
  findVideo,
  initialStates,
} from "./models";
import type { ImageTabId, Mode, TabId, TabState, VideoTabId } from "./types";
import { isNativeApp, pickGalleryImages } from "./native";

export default function App() {
  const [mode, setMode] = useState<Mode>("images");
  const [imageTab, setImageTab] = useState<ImageTabId>("seedream-5-pro");
  const [videoTab, setVideoTab] = useState<VideoTabId>("seedance-2-5");
  const [tabs, setTabs] = useState(initialStates);
  const [health, setHealth] = useState<Health>({ ok: false, configured: false, native: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeId: TabId = mode === "images" ? imageTab : videoTab;
  const state = tabs[activeId];
  const imageModel = mode === "images" ? findImage(imageTab) : null;
  const videoModel = mode === "video" ? findVideo(videoTab) : null;
  const model = imageModel ?? videoModel!;
  const maxImages = model.maxImages;
  const tags = mode === "images" ? IMAGE_TAGS : VIDEO_TAGS;

  useEffect(() => {
    void (async () => {
      await ensureDeviceConfig();
      const h = await checkHealth();
      setHealth(h);
      if (!h.configured) setSettingsOpen(true);
    })();
    setKeyDraft(hasLocalApiKey() ? "••••••••••••" : "");
  }, []);

  function patch(partial: Partial<TabState>) {
    setTabs((prev) => ({ ...prev, [activeId]: { ...prev[activeId], ...partial } }));
  }

  async function onFiles(list: File[] | FileList | null) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    const tabId = activeId;
    try {
      const existing = tabsRef.current[tabId].images;
      const room = Math.max(0, maxImages - existing.length);
      const incoming = files.slice(0, room);
      if (incoming.length === 0) {
        patch({ error: `This tab already has ${maxImages} images.` });
        return;
      }

      const placeholders = incoming.map((file) => ({
        id: uuid(),
        name: file.name || "photo",
        preview: URL.createObjectURL(file),
        dataUri: "",
        file,
      }));

      setTabs((prev) => ({
        ...prev,
        [tabId]: {
          ...prev[tabId],
          images: [
            ...existing,
            ...placeholders.map(({ id, name, preview, dataUri }) => ({ id, name, preview, dataUri })),
          ],
          error: null,
        },
      }));
      setAdding(true);

      const encoded = await Promise.all(
        placeholders.map(async (item) => {
          const dataUri = await fileToDataUri(item.file);
          return { id: item.id, name: item.name, preview: dataUri || item.preview, dataUri, old: item.preview };
        })
      );
      setTabs((prev) => {
        const merged = prev[tabId].images.map((img) => {
          const row = encoded.find((item) => item.id === img.id);
          if (!row) return img;
          return { id: row.id, name: row.name, preview: row.preview, dataUri: row.dataUri };
        });
        return { ...prev, [tabId]: { ...prev[tabId], images: merged, error: null } };
      });
      encoded.forEach((row) => {
        if (row.dataUri && row.old.startsWith("blob:")) URL.revokeObjectURL(row.old);
      });
    } catch (error) {
      setTabs((prev) => ({
        ...prev,
        [tabId]: {
          ...prev[tabId],
          error: error instanceof Error ? error.message : "Could not read images.",
        },
      }));
    } finally {
      setAdding(false);
    }
  }

  async function onGenerate() {
    const prompt = state.prompt.trim();
    if (prompt.length < (mode === "video" ? 2 : 1)) {
      patch({ error: "Write a prompt first." });
      return;
    }
    if (state.images.some((img) => !img.dataUri)) {
      patch({ error: "Wait a moment — photos are still loading." });
      return;
    }
    patch({ busy: true, error: null, progress: 0, result: null });
    try {
      const result =
        mode === "images"
          ? await generateImage(imageTab, { ...state, prompt }, (n) => patch({ progress: n }))
          : await generateVideo(videoTab, { ...state, prompt }, (n) => patch({ progress: n }));
      patch({ busy: false, progress: 100, result });
    } catch (error) {
      patch({
        busy: false,
        progress: null,
        error: error instanceof Error ? error.message : "Generation failed.",
      });
    }
  }

  async function pickPhotos() {
    if (state.images.length >= maxImages) return;
    if (isNativeApp()) {
      try {
        const files = await pickGalleryImages(maxImages - tabsRef.current[activeId].images.length);
        await onFiles(files);
      } catch (error) {
        patch({
          error: error instanceof Error ? error.message : "Could not open the gallery.",
        });
      }
      return;
    }
    fileRef.current?.click();
  }

  async function onDownload() {
    if (!state.result || saving) return;
    setSaving(true);
    setSavedNote(null);
    try {
      const how = await downloadResult(state.result);
      patch({ error: null });
      setSavedNote(
        how === "gallery"
          ? "Saved to Photos in the Seedream Studio album."
          : how === "share"
            ? "Use Save to Photos or Files in the share sheet."
            : "Download started."
      );
    } catch (error) {
      patch({
        error: error instanceof Error ? error.message : "Download failed.",
      });
    } finally {
      setSaving(false);
    }
  }

  const generateLabel = useMemo(() => {
    if (mode === "images") return `Generate · Seedream ${imageModel?.label}`;
    return `Generate · Seedance ${videoModel?.label}`;
  }, [mode, imageModel, videoModel]);

  return (
    <div className="app">
      <div className="chrome">
        <header className="top">
          <div>
            <div className="brand">Seedream Studio</div>
            <div className="sub">Runware · Text / Image to {mode === "images" ? "Image" : "Video"}</div>
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

        <div className="mode-switch">
          <button className={mode === "images" ? "on" : ""} onClick={() => setMode("images")}>
            <Landscape /> Images
          </button>
          <button className={mode === "video" ? "on" : ""} onClick={() => setMode("video")}>
            <Camera /> Video
          </button>
        </div>

        <div className="model-tabs">
          {(mode === "images" ? IMAGE_MODELS : VIDEO_MODELS).map((item) => (
            <button
              key={item.id}
              className={item.id === activeId ? "on" : ""}
              onClick={() => {
                if (item.kind === "image") setImageTab(item.id);
                else setVideoTab(item.id);
              }}
            >
              <b>{item.label}</b>
              <small>{item.subtitle}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="scroll">
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept="image/*"
        multiple
        disabled={state.images.length >= maxImages}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const picked = Array.from(e.target.files || []);
          e.target.value = "";
          void onFiles(picked);
        }}
      />

      <section className="card">
        <div className="row-head">
          <span>
            <Photos /> Reference Images {mode === "video" ? "(optional)" : ""}
          </span>
          {state.images.length > 0 ? (
            <button className="link" type="button" onClick={() => patch({ images: [] })}>
              Clear all ({state.images.length})
            </button>
          ) : (
            <small>
              {state.images.length} / {maxImages}
            </small>
          )}
        </div>

        <button
          className={`drop ${state.images.length >= maxImages ? "full" : ""}`}
          type="button"
          onClick={() => void pickPhotos()}
        >
          <Upload />
          <strong>{adding ? "Adding photos…" : "Tap to add images"}</strong>
          <em>Allow gallery access · add several · they all go in one request</em>
        </button>

        <div className="photo-row">
          {state.images.length === 0 ? (
            <div className="photo-empty">Added pictures show in this row</div>
          ) : (
            state.images.map((img, index) => (
              <div key={img.id} className="thumb">
                <img src={img.preview} alt={img.name} />
                <span className="thumb-num">{index + 1}</span>
                <button
                  type="button"
                  aria-label={`Remove image ${index + 1}`}
                  onClick={() => patch({ images: state.images.filter((x) => x.id !== img.id) })}
                >
                  ×
                </button>
              </div>
            ))
          )}
          {state.images.length > 0 && state.images.length < maxImages && (
            <button className="thumb add" type="button" onClick={() => void pickPhotos()}>
              +
            </button>
          )}
        </div>
        <p className="privacy">
          <Shield /> Zero-retention · inputs inline · outputs auto-wiped from Runware in 60s
        </p>
      </section>

      <section className="card">
        <div className="row-head">
          <span>
            <Pen /> Your Prompt
          </span>
          <small>
            {state.prompt.length} / {model.promptMax}
          </small>
        </div>
        <textarea
          value={state.prompt}
          maxLength={model.promptMax}
          placeholder={
            mode === "images"
              ? "Describe how you want to transform the reference images..."
              : "Describe the scene, motion, and camera work..."
          }
          onChange={(e) => patch({ prompt: e.target.value })}
        />
        <div className="chips">
          {tags.map((tag) => (
            <button key={tag} type="button" onClick={() => patch({ prompt: appendTag(state.prompt, tag) })}>
              {tag}
            </button>
          ))}
        </div>
      </section>

      {mode === "images" ? (
        <section className="card">
          <label>Aspect Ratio</label>
          <div className="aspects">
            {ASPECTS.map((ratio) => (
              <button
                key={ratio}
                className={state.aspect === ratio ? "on" : ""}
                type="button"
                onClick={() => patch({ aspect: ratio })}
              >
                <span className={`box r-${ratio.replace(":", "-")}`} />
                {ratio}
              </button>
            ))}
          </div>
          <div className="split">
            <div>
              <label>Quality</label>
              <div className="seg">
                {(["basic", "high"] as const).map((q) => (
                  <button key={q} className={state.quality === q ? "on" : ""} type="button" onClick={() => patch({ quality: q })}>
                    {q === "basic" ? "Basic" : "High"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label>Format</label>
              <select value={state.imageFormat} onChange={(e) => patch({ imageFormat: e.target.value as TabState["imageFormat"] })}>
                <option>PNG</option>
                <option>JPG</option>
                <option>WEBP</option>
              </select>
            </div>
          </div>
        </section>
      ) : (
        <section className="card">
          <label>Resolution</label>
          <div className="seg">
            {videoModel!.resolutions.map((r) => (
              <button key={r} className={state.resolution === r ? "on" : ""} type="button" onClick={() => patch({ resolution: r })}>
                {r}
              </button>
            ))}
          </div>
          <label>Duration</label>
          <div className="seg">
            {videoModel!.durations.map((d) => (
              <button key={d} className={state.duration === d ? "on" : ""} type="button" onClick={() => patch({ duration: d })}>
                {d}s
              </button>
            ))}
          </div>
          <div className="split">
            <div>
              <label>Format</label>
              <select value={state.videoFormat} onChange={(e) => patch({ videoFormat: e.target.value as TabState["videoFormat"] })}>
                <option>MP4</option>
                <option>WEBM</option>
                <option>MOV</option>
              </select>
            </div>
            {VIDEO_AUDIO_MODELS.includes(videoTab) && (
              <div className="toggle-row">
                <div>
                  <label>Sound</label>
                  <small>Off unless you turn it on</small>
                </div>
                <Switch on={state.audio} onChange={(audio) => patch({ audio })} />
              </div>
            )}
          </div>
        </section>
      )}

      {(mode === "images" || VIDEO_SAFETY_MODELS.includes(videoTab)) && (
        <section className="card safety">
          <div className="toggle-row">
            <div>
              <label>
                <Warn /> Safety Checker
              </label>
              <small>Off by default</small>
            </div>
            <Switch on={state.safety} onChange={(safety) => patch({ safety })} />
          </div>
        </section>
      )}

      {state.error && <p className="error">{state.error}</p>}

      <button className="generate" disabled={state.busy} onClick={() => void onGenerate()}>
        {mode === "images" ? <Spark /> : <Clap />}
        {state.busy ? (state.progress ? `Generating · ${state.progress}%` : "Generating…") : generateLabel}
      </button>

      <section className="card result">
        <div className="row-head">
          <span>Generated {mode === "images" ? "Image" : "Video"}</span>
          {state.result?.cost != null && <small>${state.result.cost.toFixed(4)}</small>}
        </div>
        {state.result ? (
          <>
            {state.result.kind === "video" ? (
              <video src={state.result.url} controls playsInline />
            ) : (
              <img src={state.result.url} alt="Generated output" />
            )}
            <button className="download" type="button" disabled={saving} onClick={() => void onDownload()}>
              {saving ? "Saving…" : isNativeApp() ? "Save to gallery" : "Download"}
            </button>
            {savedNote && <p className="saved-note">{savedNote}</p>}
          </>
        ) : (
          <div className="placeholder">{state.busy ? "Working on it…" : "Your result will show up here."}</div>
        )}
      </section>
      <div className="nav-spacer" aria-hidden="true" />
      </div>

      {settingsOpen && (
        <div className="sheet" onClick={() => setSettingsOpen(false)}>
          <form
            className="sheet-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (keyDraft && !keyDraft.includes("•")) saveApiKey(keyDraft);
              setSettingsOpen(false);
              void checkHealth().then(setHealth);
            }}
          >
            <h2>Settings</h2>
            <p>
              The server uses <code>RUNWARE_API_KEY</code>. For the phone APK, paste your key here — it stays on
              this device only.
            </p>
            <label>Runware API key</label>
            <input
              type="password"
              autoComplete="off"
              value={keyDraft}
              placeholder="rw_..."
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            <button type="submit">Save</button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                saveApiKey("");
                setKeyDraft("");
                setSettingsOpen(false);
                void checkHealth().then(setHealth);
              }}
            >
              Clear device key
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} aria-pressed={on}>
      <span />
    </button>
  );
}

function Gear() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.7.9 1.2 1.6 1.3H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
function Landscape() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="m3 15 5-5 4 4 3-3 6 6" />
    </svg>
  );
}
function Camera() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="7" width="13" height="10" rx="2" />
      <path d="m16 10 5-3v10l-5-3z" />
    </svg>
  );
}
function Photos() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="6" width="14" height="12" rx="2" />
      <path d="M8 18h12V8" />
    </svg>
  );
}
function Upload() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 16V7M8 10l4-4 4 4" />
      <path d="M5 18h14" />
    </svg>
  );
}
function Shield() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3 5 6v6c0 5 3.4 7.7 7 9 3.6-1.3 7-4 7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
function Pen() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  );
}
function Warn() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 9v5M12 17h.01" />
    </svg>
  );
}
function Spark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12 2l1.4 6.6L20 10l-6.6 1.4L12 18l-1.4-6.6L4 10l6.6-1.4z" />
    </svg>
  );
}
function Clap() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 10h16v10H4zM7 6l10 4M9 4l10 4" />
    </svg>
  );
}
