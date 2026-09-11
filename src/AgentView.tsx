import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  AGENT_JOB_PRESETS,
  AGENT_MODEL_CHIPS,
  approvalText,
  chipInText,
  describePlan,
  emptyAgentMemory,
  isContinue,
  isRecreate,
  isRememberOnly,
  lastActionableShot,
  loadAgentMemory,
  nextPendingShot,
  planAgentJob,
  recreateShot,
  resetShot,
  resultToStill,
  runAgentShot,
  saveAgentMemory,
  toggleChipToken,
  type AgentMemory,
  type AgentMessage,
  type AgentShot,
} from "./agent";
import { BRAIN_MODELS, downloadResult, loadBrainModel, saveBrainModel, type BrainModelId } from "./api";
import { fileToDataUri, uuid } from "./media";
import { isNativeApp, pickGalleryImages } from "./native";
import type { LocalImage, StudioResult } from "./types";

export default function AgentView() {
  const [memory, setMemory] = useState<AgentMemory>(emptyAgentMemory);
  const [draft, setDraft] = useState("");
  const [brain, setBrain] = useState<BrainModelId>(loadBrainModel);
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
    for (const file of files.slice(0, Math.max(0, 8 - pending.length))) {
      const dataUri = await fileToDataUri(file);
      extra.push({ id: uuid(), name: file.name || "photo", preview: dataUri, dataUri });
    }
    setPending((prev) => [...prev, ...extra].slice(0, 6));
  }

  async function pickPhotos() {
    if (isNativeApp()) {
      const files = await pickGalleryImages(Math.max(1, 8 - pending.length));
      await addFiles(files);
      return;
    }
    fileRef.current?.click();
  }

  function addChip(token: string) {
    setDraft((prev) => toggleChipToken(prev, token));
    inputRef.current?.focus();
  }

  function addPreset(text: string) {
    setDraft((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
    inputRef.current?.focus();
  }

  function pickBrain(id: BrainModelId) {
    saveBrainModel(id);
    setBrain(id);
  }

  async function useResult(result: StudioResult) {
    const still = await resultToStill(result);
    if (!still) return;
    setPending((prev) => {
      if (prev.some((img) => img.preview === still.preview || img.dataUri === still.dataUri)) return prev;
      return [...prev, still].slice(0, 8);
    });
    inputRef.current?.focus();
  }

  async function runOne(current: AgentMemory, shot: AgentShot) {
    setProgress(`Running ${shot.title}…`);
    current = {
      ...current,
      waitingForApproval: false,
      shots: current.shots.map((item) => (item.id === shot.id ? { ...item, status: "running" } : item)),
    };
    commit(current);
    try {
      current = await runAgentShot(current, shot.id);
    } catch (error) {
      current = {
        ...current,
        waitingForApproval: true,
        shots: current.shots.map((item) =>
          item.id === shot.id
            ? { ...item, status: "error", error: error instanceof Error ? error.message : "Failed." }
            : item
        ),
      };
    }
    const done = current.shots.find((item) => item.id === shot.id);
    current = pushMessage(current, {
      id: uuid(),
      role: "assistant",
      text: `${done?.status === "done" ? "Done" : "Failed"}: ${shot.title}\n\n${approvalText(current, done || shot)}`,
      result: done?.result,
      createdAt: Date.now(),
    });
    commit(current);
    return current;
  }

  async function onSend(preset?: string) {
    const text = (preset ?? draft).trim();
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
        images: images.length ? images : memoryRef.current.images,
        userRefs: images.length ? images : memoryRef.current.userRefs,
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

      if (isRecreate(userMessage.text)) {
        const target = recreateShot(current, userMessage.text);
        if (!target) {
          commit(pushMessage(current, { id: uuid(), role: "assistant", text: "Nothing to recreate yet.", createdAt: Date.now() }));
          return;
        }
        current = resetShot(current, target.id);
        commit(current);
        await runOne(current, { ...target, status: "pending" });
        return;
      }

      if (isContinue(userMessage.text)) {
        const next = nextPendingShot(current);
        if (!next) {
          commit(
            pushMessage(current, {
              id: uuid(),
              role: "assistant",
              text: lastActionableShot(current)
                ? "Nothing waiting. Tell me what to make next, or recreate a part."
                : "Nothing waiting. Tell me what to make.",
              createdAt: Date.now(),
            })
          );
          return;
        }
        await runOne(current, next);
        return;
      }

      setProgress("Planning…");
      const planned = await planAgentJob(current);
      if (!planned.shots.length) {
        commit(
          pushMessage(current, {
            id: uuid(),
            role: "assistant",
            text: planned.reply || "Okay. Tell me what to make.",
            createdAt: Date.now(),
          })
        );
        return;
      }
      const kept = current.shots.filter((shot) => shot.status === "done");
      current = pushMessage(
        { ...current, lock: planned.lock, shots: [...kept, ...planned.shots], waitingForApproval: true },
        {
          id: uuid(),
          role: "assistant",
          text: planned.reply ? `${planned.reply}\n\n${describePlan(planned.lock, planned.shots)}` : describePlan(planned.lock, planned.shots),
          createdAt: Date.now(),
        }
      );
      commit(current);
      const first = planned.shots[0];
      if (first) await runOne(current, first);
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

      <div className="chat-models">
        <div className="chat-models-head">
          <span>Brain</span>
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
        <div className="chat-chips top">
          {BRAIN_MODELS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={brain === item.id ? "on" : ""}
              onClick={() => pickBrain(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="chat-models-head">
          <span>Models</span>
        </div>
        <div className="chat-chips">
          {AGENT_JOB_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={draft.includes(preset.text) ? "on preset" : "preset"}
              onClick={() => addPreset(preset.text)}
            >
              {preset.label}
            </button>
          ))}
          {AGENT_MODEL_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={chipInText(draft, chip.token) ? "on" : ""}
              onClick={() => addChip(chip.token)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chat-thread" ref={threadRef}>
        {memory.messages.length === 0 ? (
          <div className="chat-empty">
            <p className="ask-title">Ask anything</p>
            <p>Ask anything in Sinhala or English. Photos use Qwen 3.0 Pro. Video uses Wan 3.0 Prime at 480p unless you pick Wan 3.0. I’ll do one piece at a time so you can continue or recreate.</p>
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
                  <div className="bubble-actions">
                    <button className="link" type="button" onClick={() => void useResult(message.result!)}>
                      Use in chat
                    </button>
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
                </div>
              ) : null}
            </article>
          ))
        )}
        {progress ? <p className="chat-status">{progress}</p> : null}
      </div>

      <div className="chat-dock">
        {memory.waitingForApproval && !busy ? (
          <div className="chat-approve">
            <button type="button" onClick={() => void onSend("continue")}>
              Continue
            </button>
            <button type="button" onClick={() => void onSend("recreate this")}>
              Recreate this
            </button>
          </div>
        ) : null}
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
            placeholder="Ask anything"
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
