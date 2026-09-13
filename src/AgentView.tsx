import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  VIDEO_REF_LIMIT,
  askedForVideo,
  applyRecreateEdits,
  approvalText,
  activeChatId,
  beginRecreate,
  deleteAgentChat,
  describePlan,
  emptyAgentMemory,
  isContinue,
  isRecreate,
  isRememberOnly,
  lastActionableShot,
  listAgentChats,
  loadAgentMemory,
  nextPendingShot,
  openAgentChat,
  photoLibrary,
  planAgentJob,
  recreateChangeText,
  recreateQuestion,
  recreateRefLimit,
  recreateShot,
  removeLibraryPhoto,
  resultToStill,
  runAgentShot,
  saveAgentMemory,
  startNewAgentChat,
  videoRefQuestion,
  type AgentChatInfo,
  type AgentMemory,
  type AgentMessage,
  type AgentShot,
  type LibraryPhoto,
} from "./agent";
import { downloadResult } from "./api";
import { fileToDataUri, uuid } from "./media";
import { isNativeApp, pickGalleryImages } from "./native";
import type { LocalImage, ResultKind, StudioResult } from "./types";

const COMPOSER_MIN = 40;
const COMPOSER_MAX = 200;

type MediaViewer = { kind: ResultKind; url: string; alt: string };

type AgentViewProps = {
  chatsOpen?: boolean;
  onChatsOpenChange?: (open: boolean) => void;
};

export default function AgentView({ chatsOpen = false, onChatsOpenChange }: AgentViewProps) {
  const [memory, setMemory] = useState<AgentMemory>(emptyAgentMemory);
  const [chats, setChats] = useState<AgentChatInfo[]>([]);
  const [chatId, setChatId] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<LocalImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<MediaViewer | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const memoryRef = useRef(memory);
  const viewerOpen = useRef(false);
  const chatsOpenRef = useRef(false);
  memoryRef.current = memory;
  chatsOpenRef.current = chatsOpen;

  useEffect(() => {
    let alive = true;
    void loadAgentMemory().then((next) => {
      if (!alive) return;
      memoryRef.current = next;
      setMemory(next);
      setChats(listAgentChats());
      setChatId(activeChatId());
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [memory.messages.length, progress, busy]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (memory.awaitingRecreate) {
      el.style.height = "";
      el.scrollTop = el.scrollHeight;
      return;
    }
    const room = window.visualViewport ? Math.floor(window.visualViewport.height * 0.32) : COMPOSER_MAX;
    const maxH = Math.max(COMPOSER_MIN, Math.min(COMPOSER_MAX, room));
    el.style.height = `${COMPOSER_MIN}px`;
    if (draft) el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: "end", inline: "nearest" });
    });
  }, [draft, memory.awaitingRecreate]);

  function openMedia(next: MediaViewer) {
    setViewer(next);
    if (!viewerOpen.current) {
      viewerOpen.current = true;
      history.pushState({ mediaViewer: 1 }, "");
    }
  }

  function closeMedia() {
    setViewer(null);
    if (viewerOpen.current && history.state && (history.state as { mediaViewer?: number }).mediaViewer) {
      viewerOpen.current = false;
      history.back();
      return;
    }
    viewerOpen.current = false;
  }

  useEffect(() => {
    function onPop() {
      if (viewerOpen.current) {
        viewerOpen.current = false;
        setViewer(null);
        return;
      }
      if (chatsOpenRef.current) {
        chatsOpenRef.current = false;
        onChatsOpenChange?.(false);
      }
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (viewerOpen.current) closeMedia();
      else if (chatsOpenRef.current) closeChats();
    }
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
    };
  }, [onChatsOpenChange]);

  useEffect(() => {
    if (chatsOpen) {
      chatsOpenRef.current = true;
      if (!(history.state as { chatsPanel?: number } | null)?.chatsPanel) {
        history.pushState({ chatsPanel: 1 }, "");
      }
      return;
    }
    if (chatsOpenRef.current && (history.state as { chatsPanel?: number } | null)?.chatsPanel) {
      chatsOpenRef.current = false;
      history.back();
      return;
    }
    chatsOpenRef.current = false;
  }, [chatsOpen]);

  function refreshChats() {
    setChats(listAgentChats());
    setChatId(activeChatId());
  }

  function closeChats() {
    onChatsOpenChange?.(false);
  }

  function showChat(next: AgentMemory, keepPanel = false) {
    memoryRef.current = next;
    setMemory(next);
    setDraft("");
    setPending([]);
    refreshChats();
    if (!keepPanel) closeChats();
  }

  function commit(next: AgentMemory) {
    memoryRef.current = next;
    setMemory(next);
    saveAgentMemory(next);
    refreshChats();
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
      shotId: shot.id,
      createdAt: Date.now(),
    });
    commit(current);
    return current;
  }

  function askForVideoPhotos(current: AgentMemory, attached: LocalImage[]) {
    const next = pushMessage(
      {
        ...current,
        awaitingVideoRefs: true,
        hasPickedVideoRefs: false,
        chosenRefs: attached.slice(0, VIDEO_REF_LIMIT),
      },
      {
        id: uuid(),
        role: "assistant",
        text: videoRefQuestion(),
        createdAt: Date.now(),
      }
    );
    commit(next);
  }

  function tapLibraryPhoto(photo: LibraryPhoto) {
    const current = memoryRef.current;
    if ((!current.awaitingVideoRefs && !current.awaitingRecreate) || busy) return;
    if (current.chosenRefs.some((img) => img.id === photo.id)) return;
    const shot = current.shots.find((item) => item.id === current.recreateShotId);
    const limit = current.awaitingRecreate ? recreateRefLimit(shot?.kind || "video") : VIDEO_REF_LIMIT;
    if (current.chosenRefs.length >= limit) return;
    commit({ ...current, chosenRefs: [...current.chosenRefs, photo.image] });
  }

  function removeChosen(id: string) {
    const current = memoryRef.current;
    if ((!current.awaitingVideoRefs && !current.awaitingRecreate) || busy) return;
    commit({ ...current, chosenRefs: current.chosenRefs.filter((img) => img.id !== id) });
  }

  function askToRecreate(current: AgentMemory, text = "", shot?: AgentShot | null) {
    const target = shot || recreateShot(current, text);
    if (!target) {
      commit(pushMessage(current, { id: uuid(), role: "assistant", text: "Nothing to recreate yet.", createdAt: Date.now() }));
      return;
    }
    commit(
      pushMessage(beginRecreate(current, target, recreateChangeText(text)), {
        id: uuid(),
        role: "assistant",
        text: recreateQuestion(target.kind),
        createdAt: Date.now(),
      })
    );
    setDraft("");
    inputRef.current?.focus();
  }

  function recreateFromMessage(message: AgentMessage) {
    if (busy) return;
    const current = memoryRef.current;
    const shot =
      (message.shotId && current.shots.find((item) => item.id === message.shotId)) ||
      current.shots.find((item) => item.result && message.result && item.result.url === message.result.url) ||
      null;
    askToRecreate(current, "", shot);
  }

  async function finishRecreate(current: AgentMemory, text: string, extra: LocalImage[]) {
    setBusy(true);
    setProgress("Updating…");
    try {
      const edited = await applyRecreateEdits(current, text, extra);
      commit(edited.memory);
      await runOne(edited.memory, edited.shot);
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

  function deleteLibraryPhoto(id: string) {
    setPending((prev) => prev.filter((img) => img.id !== id));
    commit(removeLibraryPhoto(memoryRef.current, id));
  }

  async function planAndRun(current: AgentMemory) {
    setProgress("Planning…");
    const planned = await planAgentJob(current);
    if (!planned.shots.length) {
      commit(
        pushMessage(
          { ...current, waitingForApproval: false, awaitingVideoRefs: false, awaitingRecreate: false, recreateShotId: "", recreateNote: "" },
          {
            id: uuid(),
            role: "assistant",
            text: planned.reply || "Okay. Tell me what to make.",
            createdAt: Date.now(),
          }
        )
      );
      return;
    }
    const kept = current.shots.filter((shot) => shot.status === "done");
    current = pushMessage(
      {
        ...current,
        lock: planned.lock,
        shots: [...kept, ...planned.shots],
        waitingForApproval: true,
        awaitingVideoRefs: false,
        awaitingRecreate: false,
        recreateShotId: "",
        recreateNote: "",
      },
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
  }

  async function usePickedPhotos() {
    if (busy || !memoryRef.current.awaitingVideoRefs) return;
    const current = { ...memoryRef.current, awaitingVideoRefs: false, hasPickedVideoRefs: true };
    commit(current);
    setBusy(true);
    setProgress(null);
    try {
      await planAndRun(current);
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

  async function onSend(preset?: string) {
    const text = (preset ?? draft).trim();
    const recreating = memoryRef.current.awaitingRecreate;
    if ((!text && pending.length === 0 && !recreating) || busy) return;
    const images = pending;
    const userMessage: AgentMessage = {
      id: uuid(),
      role: "user",
      text: text || (recreating ? "Recreate this" : "Use these photos."),
      images,
      createdAt: Date.now(),
    };
    let current = pushMessage(
      {
        ...memoryRef.current,
        brief: userMessage.text,
        images: images.length ? images : memoryRef.current.images,
        userRefs: images.length ? images : memoryRef.current.userRefs,
        waitingForApproval: false,
        notes: isRememberOnly(userMessage.text)
          ? [memoryRef.current.notes, userMessage.text.replace(/^\s*remember\b[:\s-]*/i, "")].filter(Boolean).join("\n")
          : memoryRef.current.notes,
      },
      userMessage
    );
    commit(current);
    setDraft("");
    setPending([]);

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

    if (current.awaitingRecreate) {
      await finishRecreate(current, userMessage.text, images);
      return;
    }

    if (current.awaitingVideoRefs && !isRecreate(userMessage.text)) {
      if (isContinue(userMessage.text) || /use these/i.test(userMessage.text)) {
        current = { ...current, awaitingVideoRefs: false, hasPickedVideoRefs: true };
        commit(current);
        setBusy(true);
        setProgress(null);
        try {
          await planAndRun(current);
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
        return;
      }
      if (askedForVideo(userMessage.text)) {
        askForVideoPhotos(current, images);
        return;
      }
      const merged = [...current.chosenRefs];
      for (const img of images) {
        if (!merged.some((item) => item.id === img.id)) merged.push(img);
      }
      commit(
        pushMessage(
          { ...current, chosenRefs: merged.slice(0, VIDEO_REF_LIMIT) },
          {
            id: uuid(),
            role: "assistant",
            text: images.length
              ? "Added that photo. Tap more on the bar, or tap Use these."
              : "Tap the photos on the bar in order, then tap Use these.",
            createdAt: Date.now(),
          }
        )
      );
      return;
    }

    if (askedForVideo(userMessage.text) && !isContinue(userMessage.text) && !isRecreate(userMessage.text)) {
      askForVideoPhotos(current, images);
      return;
    }

    setBusy(true);
    setProgress(null);

    try {
      if (isRecreate(userMessage.text)) {
        askToRecreate(current, userMessage.text);
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

      current = { ...current, chosenRefs: [], hasPickedVideoRefs: false };
      commit(current);
      await planAndRun(current);
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

  const library = photoLibrary(memory, pending);
  const recreating = memory.awaitingRecreate && !busy;
  const picking = (memory.awaitingVideoRefs || memory.awaitingRecreate) && !busy;
  const recreateKind = memory.shots.find((item) => item.id === memory.recreateShotId)?.kind || "video";
  const photoLimit = recreating ? recreateRefLimit(recreateKind) : VIDEO_REF_LIMIT;

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

      <div className="chat-toolbar">
        <span>
          {recreating
            ? `Change photos · ${memory.chosenRefs.length}/${photoLimit}`
            : picking
              ? `Tap photos in order · ${memory.chosenRefs.length}/${VIDEO_REF_LIMIT}`
              : library.length
                ? "Photos"
                : ""}
        </span>
        <button
          className="link"
          type="button"
          disabled={busy}
          onClick={() => {
            void startNewAgentChat(memoryRef.current).then((next) => showChat(next));
          }}
        >
          New chat
        </button>
      </div>

      {chatsOpen ? (
        <div className="chats-overlay" role="dialog" aria-modal="true" aria-label="Chats">
          <button type="button" className="chats-backdrop" aria-label="Close chats" onClick={closeChats} />
          <aside className="chats-panel">
            <div className="chats-panel-head">
              <strong>Chats</strong>
              <button type="button" className="link" onClick={closeChats}>
                Close
              </button>
            </div>
            <button
              className="chats-new"
              type="button"
              disabled={busy}
              onClick={() => void startNewAgentChat(memoryRef.current).then((next) => showChat(next))}
            >
              New chat
            </button>
            <div className="chats-list" role="list">
              {chats.length ? (
                chats.map((chat) => (
                  <div key={chat.id} className={`chats-item${chat.id === chatId ? " on" : ""}`} role="listitem">
                    <button
                      type="button"
                      className="chats-item-open"
                      disabled={busy || chat.id === chatId}
                      onClick={() => void openAgentChat(chat.id, memoryRef.current).then((next) => showChat(next))}
                    >
                      {chat.title}
                    </button>
                    <button
                      type="button"
                      className="chats-item-del"
                      disabled={busy}
                      aria-label={`Delete ${chat.title}`}
                      onClick={() => void deleteAgentChat(chat.id, memoryRef.current).then((next) => showChat(next, true))}
                    >
                      ×
                    </button>
                  </div>
                ))
              ) : (
                <p className="chats-empty">No chats yet</p>
              )}
            </div>
          </aside>
        </div>
      ) : null}

      {library.length || picking ? (
        <div className={`photo-tray${picking ? " picking" : ""}`}>
          {library.length ? (
            <div className="photo-bar" role="list">
              {library.map((photo) => {
                const order = memory.chosenRefs.findIndex((img) => img.id === photo.id);
                return (
                  <div key={photo.id} className={`photo-bar-item${order >= 0 ? " on" : ""}`} role="listitem">
                    <button
                      type="button"
                      className="photo-bar-hit"
                      disabled={!picking}
                      onClick={() => tapLibraryPhoto(photo)}
                    >
                      <img src={photo.image.preview || photo.image.dataUri} alt="" />
                    </button>
                    <span className="photo-bar-num">{photo.label}</span>
                    <span className="photo-bar-kind">{photo.kind === "made" ? "Made" : "Yours"}</span>
                    {order >= 0 ? <span className="photo-bar-order">{order + 1}</span> : null}
                    <button
                      type="button"
                      className="photo-bar-del"
                      aria-label="Delete photo"
                      onClick={() => deleteLibraryPhoto(photo.id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="photo-picked-empty">
              {recreating
                ? "No photos yet. Attach some, or tap Recreate to keep the same pictures."
                : "No photos yet. Attach some, or tap Use these for a video with no stills."}
            </p>
          )}
          {picking ? (
            <div className="photo-picked">
              {memory.chosenRefs.length ? (
                memory.chosenRefs.map((img, index) => (
                  <span key={img.id} className="photo-picked-thumb">
                    <img src={img.preview || img.dataUri} alt="" />
                    <em>{index + 1}</em>
                    <button type="button" onClick={() => removeChosen(img.id)} aria-label="Remove photo">
                      ×
                    </button>
                  </span>
                ))
              ) : (
                <p className="photo-picked-empty">No photos selected yet</p>
              )}
              <button
                className="photo-use"
                type="button"
                onClick={() => (recreating ? void onSend(draft || "recreate this") : void usePickedPhotos())}
              >
                {recreating ? "Recreate" : "Use these"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="chat-thread" ref={threadRef}>
        {memory.messages.length === 0 ? (
          <div className="chat-empty">
            <p className="ask-title">Ask anything</p>
            <p>Ask anything in Sinhala or English. Photos use Qwen 3.0 Pro. Video uses Wan 3.0 Prime at 480p. Type Wan 3.0, Grok, or Gemini 2.5 Pro if you want a different model. I’ll do one piece at a time so you can continue or recreate.</p>
          </div>
        ) : (
          memory.messages.map((message) => (
            <article key={message.id} className={`bubble ${message.role}`}>
              {message.images?.length ? (
                <div className="bubble-photos">
                  {message.images.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      className="media-hit"
                      aria-label={`Open ${img.name || "photo"}`}
                      onClick={() => openMedia({ kind: "image", url: img.preview || img.dataUri, alt: img.name })}
                    >
                      <img src={img.preview} alt={img.name} />
                    </button>
                  ))}
                </div>
              ) : null}
              {message.text ? <p>{message.text}</p> : null}
              {message.result ? (
                <div className="bubble-media">
                  <div
                    className="media-hit"
                    role="button"
                    tabIndex={0}
                    aria-label={message.result.kind === "video" ? "Open video" : "Open image"}
                    onClick={() =>
                      openMedia({
                        kind: message.result!.kind,
                        url: message.result!.url,
                        alt: message.result!.kind === "video" ? "Generated video" : "Generated shot",
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      openMedia({
                        kind: message.result!.kind,
                        url: message.result!.url,
                        alt: message.result!.kind === "video" ? "Generated video" : "Generated shot",
                      });
                    }}
                  >
                    {message.result.kind === "video" ? (
                      <video src={message.result.url} muted playsInline preload="metadata" />
                    ) : (
                      <img src={message.result.url} alt="Generated shot" />
                    )}
                  </div>
                  <div className="bubble-actions">
                    <button className="link" type="button" disabled={busy} onClick={() => recreateFromMessage(message)}>
                      Recreate
                    </button>
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
        {recreating ? (
          <div className="recreate-box">
            <label htmlFor="recreate-change">What should I change?</label>
            <textarea
              id="recreate-change"
              ref={inputRef}
              rows={3}
              value={draft}
              placeholder={recreateKind === "image" ? "Type the picture change, or leave empty" : "Type the video change, or leave empty"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
            />
            <div className="recreate-box-actions">
              <button className="ghost-btn" type="button" onClick={() => void pickPhotos()}>
                Change photos
              </button>
              <button type="button" onClick={() => void onSend(draft || "recreate this")}>
                Recreate
              </button>
            </div>
          </div>
        ) : memory.waitingForApproval && !busy && !memory.awaitingVideoRefs ? (
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
        {recreating ? null : (
          <div className="composer">
            <button className="composer-icon" type="button" onClick={() => void pickPhotos()} aria-label="Add photo">
              +
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              placeholder={picking ? "Tap photos above, or add another" : "Ask anything"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
            />
            <button className="composer-send" type="button" disabled={busy || (!draft.trim() && pending.length === 0)} onClick={() => void onSend()}>
              {busy ? "…" : "Send"}
            </button>
          </div>
        )}
      </div>

      {viewer ? (
        <div className="media-viewer" role="dialog" aria-modal="true" aria-label={viewer.kind === "video" ? "Video" : "Image"}>
          <div className="media-viewer-bar">
            <button type="button" className="media-viewer-back" onClick={() => closeMedia()}>
              Back
            </button>
          </div>
          <div className="media-viewer-stage">
            {viewer.kind === "video" ? (
              <video src={viewer.url} controls autoPlay playsInline />
            ) : (
              <img src={viewer.url} alt={viewer.alt} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
