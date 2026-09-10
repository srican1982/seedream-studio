import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  AGENT_MODEL_CHIPS,
  describePlan,
  emptyAgentMemory,
  isRememberOnly,
  loadAgentMemory,
  planAgentJob,
  runAgentShot,
  saveAgentMemory,
  type AgentMemory,
  type AgentMessage,
} from "./agent";
import { downloadResult } from "./api";
import { fileToDataUri, uuid } from "./media";
import { isNativeApp, pickGalleryImages } from "./native";
import type { LocalImage } from "./types";

function toggleToken(text: string, token: string) {
  if (text.includes(token)) {
    return text.replaceAll(token, "").replace(/\s+/g, " ").trim();
  }
  return `${text.trim()}${text.trim() ? " " : ""}${token} `.replace(/\s+$/, " ");
}

export default function AgentView() {
  const [memory, setMemory] = useState<AgentMemory>(emptyAgentMemory);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<LocalImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const memoryRef = useRef(memory);
  memoryRef.current = memory;

  useEffect(() => {
    setMemory(loadAgentMemory());
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [memory.messages.length, progress, busy]);

  function commit(next: AgentMemory) {
    memoryRef.current = next;
    setMemory(next);
    saveAgentMemory(next);
  }

  function pushMessage(next: AgentMemory, message: AgentMessage) {
    return { ...next, messages: [...next.messages, message] };
  }

  async function addFiles(list: File[] | FileList | null) {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    const extra: LocalImage[] = [];
    for (const file of files.slice(0, Math.max(0, 6 - pending.length))) {
      const dataUri = await fileToDataUri(file);
      extra.push({ id: uuid(), name: file.name || "photo", preview: dataUri, dataUri });
    }
    setPending((prev) => [...prev, ...extra].slice(0, 6));
  }

  async function pickPhotos() {
    if (isNativeApp()) {
      const files = await pickGalleryImages(Math.max(1, 6 - pending.length));
      await addFiles(files);
      return;
    }
    fileRef.current?.click();
  }

  function addChip(token: string) {
    setDraft((prev) => toggleToken(prev, token));
    inputRef.current?.focus();
  }

  async function onSend() {
    const text = draft.trim();
    if ((!text && pending.length === 0) || busy) return;
    const images = pending;
    const userMessage: AgentMessage = {
      id: uuid(),
      role: "user",
      text: text || "Use these photos.",
      images,
      createdAt: Date.now(),
    };
    let current = pushMessage(
      {
        ...memoryRef.current,
        brief: userMessage.text,
        images: [...memoryRef.current.images, ...images].slice(-6),
        notes: isRememberOnly(userMessage.text)
          ? [memoryRef.current.notes, userMessage.text.replace(/^\s*remember\b[:\s-]*/i, "")].filter(Boolean).join("\n")
          : memoryRef.current.notes,
      },
      userMessage
    );
    commit(current);
    setDraft("");
    setPending([]);
    setBusy(true);
    setProgress(null);

    try {
      if (isRememberOnly(userMessage.text)) {
        commit(
          pushMessage(current, {
            id: uuid(),
            role: "assistant",
            text: "Saved. I’ll keep that in memory for the next shots.",
            createdAt: Date.now(),
          })
        );
        return;
      }

      setProgress("Planning shots…");
      const planned = await planAgentJob(current);
      current = pushMessage(
        { ...current, lock: planned.lock, shots: planned.shots },
        {
          id: uuid(),
          role: "assistant",
          text: describePlan(planned.lock, planned.shots),
          createdAt: Date.now(),
        }
      );
      commit(current);

      for (const shot of current.shots) {
        if (shot.status === "done") continue;
        setProgress(`Running ${shot.title}…`);
        current = {
          ...current,
          shots: current.shots.map((item) => (item.id === shot.id ? { ...item, status: "running" } : item)),
        };
        commit(current);
        current = await runAgentShot(current, shot.id);
        const done = current.shots.find((item) => item.id === shot.id);
        current = pushMessage(current, {
          id: uuid(),
          role: "assistant",
          text: done?.status === "done" ? `Done: ${shot.title}` : `Failed: ${shot.title}`,
          result: done?.result,
          createdAt: Date.now(),
        });
        commit(current);
      }
      const videos = current.shots.filter((shot) => shot.kind === "video" && shot.result).length;
      if (videos > 1) {
        current = pushMessage(current, {
          id: uuid(),
          role: "assistant",
          text: `Attached ${videos} clips in order. Play them one after another for the full video.`,
          createdAt: Date.now(),
        });
        commit(current);
      }
    } catch (error) {
      commit(
        pushMessage(memoryRef.current, {
          id: uuid(),
          role: "assistant",
          text: error instanceof Error ? error.message : "Something went wrong.",
          createdAt: Date.now(),
        })
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSend();
    }
  }

  return (
    <div className="chat">
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept="image/*"
        multiple
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const picked = Array.from(e.target.files || []);
          e.target.value = "";
          void addFiles(picked);
        }}
      />

      <div className="chat-top">
        <span>Agent chat</span>
        <button
          className="link"
          type="button"
          onClick={() => {
            commit(emptyAgentMemory());
            setDraft("");
            setPending([]);
          }}
        >
          New chat
        </button>
      </div>

      <div className="chat-thread" ref={threadRef}>
        {memory.messages.length === 0 ? (
          <div className="chat-empty">
            <p>Tell me the whole job. Tap a model placeholder to drop it into the message.</p>
            <div className="chat-empty-chips">
              {AGENT_MODEL_CHIPS.map((chip) => (
                <button key={chip.id} type="button" onClick={() => addChip(chip.token)}>
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          memory.messages.map((message) => (
            <article key={message.id} className={`bubble ${message.role}`}>
              {message.images?.length ? (
                <div className="bubble-photos">
                  {message.images.map((img) => (
                    <img key={img.id} src={img.preview} alt={img.name} />
                  ))}
                </div>
              ) : null}
              {message.text ? <p>{message.text}</p> : null}
              {message.result ? (
                <div className="bubble-media">
                  {message.result.kind === "video" ? (
                    <video src={message.result.url} controls playsInline />
                  ) : (
                    <img src={message.result.url} alt="Generated shot" />
                  )}
                  <button
                    className="link"
                    type="button"
                    disabled={savingId === message.id}
                    onClick={() => {
                      setSavingId(message.id);
                      void downloadResult(message.result!).finally(() => setSavingId(null));
                    }}
                  >
                    {savingId === message.id ? "Saving…" : isNativeApp() ? "Save" : "Download"}
                  </button>
                </div>
              ) : null}
            </article>
          ))
        )}
        {progress ? <p className="chat-status">{progress}</p> : null}
      </div>

      <div className="chat-dock">
        <div className="chat-chips">
          {AGENT_MODEL_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={draft.includes(chip.token) ? "on" : ""}
              onClick={() => addChip(chip.token)}
            >
              {chip.label}
            </button>
          ))}
        </div>
        {pending.length > 0 ? (
          <div className="chat-pending">
            {pending.map((img) => (
              <span key={img.id} className="chat-pending-thumb">
                <img src={img.preview} alt="" />
                <button type="button" onClick={() => setPending((prev) => prev.filter((item) => item.id !== img.id))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="composer">
          <button className="composer-icon" type="button" onClick={() => void pickPhotos()} aria-label="Add photo">
            +
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="Message the agent…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <button className="composer-send" type="button" disabled={busy || (!draft.trim() && pending.length === 0)} onClick={() => void onSend()}>
            {busy ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
