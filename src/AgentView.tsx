import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
  VIDEO_REF_LIMIT,
  askedForVideo,
  askedToGenerate,
  applyRecreateEdits,
  applyReviewedPrompt,
  approvalText,
  activeChatId,
  advanceAttachQuiz,
  beginAttachQuiz,
  beginPromptReview,
  beginRecreate,
  cancelAttachQuiz,
  cancelPromptReview,
  deleteAgentChat,
  describePlan,
  emptyAgentMemory,
  isAttachQuiz,
  isContinue,
  isQuizAdvance,
  isQuizCancel,
  continueStatus,
  isRecreate,
  isForgetPerson,
  isRememberOnly,
  isTrainCommand,
  trainNameFrom,
  lastActionableShot,
  listAgentChats,
  loadAgentMemory,
  mediaKindOf,
  nextPendingShot,
  openAgentChat,
  promptReviewQuestion,
  reviewShot,
  photoLibrary,
  planAgentJob,
  quizAccepts,
  quizButtonLabel,
  quizStepLimit,
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
  WAN_SIZE_OPTIONS,
  pickWanSize,
  parseWanSizeText,
  type AgentChatInfo,
  type AgentMemory,
  type AgentMessage,
  type AgentShot,
  type LibraryPhoto,
} from "./agent";
import { downloadResult } from "./api";
import { withKeepAlive } from "./keep-alive";
import { fileToDataUri, isAudioFile, isImageFile, isImagePreview, isVideoFile, uuid, videoPosterDataUri } from "./media";
import { forgetPerson, getPeople, loadPeople, peopleNames, savePerson } from "./people-store";
import { isNativeApp, pickGalleryMedia } from "./native";
import type { LocalImage, ResultKind, StudioResult } from "./types";
import { formatRecordSecs, recorderMime, requestMicrophone, spokenWavFile, VOICE_MAX_SECS } from "./voice-record";

const COMPOSER_MIN = 40;
const COMPOSER_MAX = 200;
const ATTACH_LIMIT = 25;
const IMAGE_BYTES_MAX = 35_000_000;
const MEDIA_BYTES_MAX = 120_000_000;

type MediaViewer = { kind: ResultKind | "audio"; url: string; alt: string };

function MediaThumb({ item }: { item: LocalImage }) {
  const kind = mediaKindOf(item);
  const [poster, setPoster] = useState(() => (kind === "video" && isImagePreview(item.preview) ? item.preview : ""));
  useEffect(() => {
    if (kind !== "video") return;
    if (isImagePreview(item.preview)) {
      setPoster(item.preview);
      return;
    }
    let alive = true;
    void videoPosterDataUri(item.preview || item.dataUri).then((uri) => {
      if (alive && uri) setPoster(uri);
    });
    return () => {
      alive = false;
    };
  }, [item.dataUri, item.preview, kind]);
  if (kind === "video") {
    if (poster) return <img src={poster} alt="" />;
    return <video src={item.dataUri || item.preview} muted playsInline preload="metadata" />;
  }
  if (kind === "audio") return <span className="photo-bar-audio">{item.name || "Audio"}</span>;
  return <img src={item.preview || item.dataUri} alt="" />;
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" strokeLinecap="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

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
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const memoryRef = useRef(memory);
  const viewerOpen = useRef(false);
  const chatsOpenRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimer = useRef<number | null>(null);
  const stoppingRef = useRef(false);
  memoryRef.current = memory;
  chatsOpenRef.current = chatsOpen;

  useEffect(() => {
    let alive = true;
    void Promise.all([loadAgentMemory(), loadPeople()]).then(([next]) => {
      if (!alive) return;
      memoryRef.current = next;
      setMemory(next);
      const pendingShot = reviewShot(next);
      if (pendingShot) setDraft(pendingShot.prompt);
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
    if (memory.awaitingRecreate || memory.awaitingPromptReview) {
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
  }, [draft, memory.awaitingRecreate, memory.awaitingPromptReview]);

  useEffect(() => {
    return () => {
      if (recordTimer.current) window.clearInterval(recordTimer.current);
      try {
        recorderRef.current?.stop();
      } catch {
        /* already stopped */
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

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
    setDraft(reviewShot(next)?.prompt || "");
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

  async function addFiles(list: File[] | FileList | null, forceKind?: LocalImage["mediaKind"]) {
    const files = list ? Array.from(list) : [];
    if (!files.length) return [];
    const extra: LocalImage[] = [];
    const room = Math.max(0, ATTACH_LIMIT - pending.length);
    for (const file of files.slice(0, room)) {
      const kind = forceKind || (isAudioFile(file) ? "audio" : isVideoFile(file) ? "video" : isImageFile(file) ? "image" : null);
      if (!kind) continue;
      if (kind === "image" && file.size > IMAGE_BYTES_MAX) continue;
      if (kind !== "image" && file.size > MEDIA_BYTES_MAX) continue;
      const dataUri = await fileToDataUri(file);
      let preview = kind === "audio" ? "" : dataUri;
      if (kind === "video") {
        const objectUrl = URL.createObjectURL(file);
        preview = (await videoPosterDataUri(objectUrl)) || dataUri;
        URL.revokeObjectURL(objectUrl);
      }
      extra.push({
        id: uuid(),
        name: file.name || kind,
        preview,
        dataUri,
        mediaKind: kind,
        mime: file.type,
      });
    }
    if (!extra.length) return [];
    setPending((prev) => [...prev, ...extra].slice(0, ATTACH_LIMIT));
    const current = memoryRef.current;
    const merged = [...current.userRefs];
    for (const img of extra) {
      if (!merged.some((item) => item.id === img.id)) merged.push(img);
    }
    commit({
      ...current,
      userRefs: merged.slice(0, ATTACH_LIMIT),
      images: [...current.images, ...extra.filter((img) => img.mediaKind === "image" || !img.mediaKind)].slice(-ATTACH_LIMIT),
    });
    return extra;
  }

  async function pickPhotos() {
    const room = Math.max(1, ATTACH_LIMIT - pending.length);
    if (isNativeApp()) {
      try {
        const files = await pickGalleryMedia(room);
        if (files.length) await addFiles(files);
        return;
      } catch {
        /* fall back to the HTML picker */
      }
    }
    fileRef.current?.click();
  }

  function clearRecordTimer() {
    if (recordTimer.current) {
      window.clearInterval(recordTimer.current);
      recordTimer.current = null;
    }
  }

  function stopMicTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function resetRecorder() {
    clearRecordTimer();
    stopMicTracks();
    recorderRef.current = null;
    chunksRef.current = [];
    stoppingRef.current = false;
    setRecording(false);
    setRecordSecs(0);
  }

  function speakError(error: unknown) {
    const raw = error instanceof Error ? error.message : "Could not use the microphone.";
    const text = /notallowed|permission|denied|blocked/i.test(raw)
      ? "Microphone is blocked. Allow it, then tap Speak again."
      : /notfound|not found|no microphone|requested device/i.test(raw)
        ? "No microphone found."
        : raw;
    commit(
      pushMessage(memoryRef.current, {
        id: uuid(),
        role: "assistant",
        text,
        createdAt: Date.now(),
      })
    );
  }

  async function startSpeak() {
    if (busy || recording || memoryRef.current.awaitingPromptReview || stoppingRef.current) return;
    try {
      await requestMicrophone();
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("This device cannot record audio here. Attach a file instead.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = recorderMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.start(250);
      setRecordSecs(0);
      setRecording(true);
      recordTimer.current = window.setInterval(() => {
        setRecordSecs((secs) => {
          if (secs + 1 >= VOICE_MAX_SECS) {
            void stopSpeak();
            return VOICE_MAX_SECS;
          }
          return secs + 1;
        });
      }, 1000);
    } catch (error) {
      resetRecorder();
      speakError(error);
    }
  }

  async function stopSpeak() {
    const recorder = recorderRef.current;
    if (!recorder || stoppingRef.current) {
      if (!recorder) resetRecorder();
      return;
    }
    stoppingRef.current = true;
    clearRecordTimer();
    let file: File;
    try {
      const raw = await new Promise<Blob>((resolve, reject) => {
        recorder.onstop = () => {
          const mime = recorder.mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type: mime.split(";")[0] || mime });
          if (blob.size < 200) {
            reject(new Error("That recording was empty. Try Speak again."));
            return;
          }
          resolve(blob);
        };
        recorder.onerror = () => reject(new Error("Could not finish the recording."));
        try {
          recorder.stop();
        } catch (error) {
          reject(error instanceof Error ? error : new Error("Could not finish the recording."));
        }
      });
      file = await spokenWavFile(raw);
    } catch (error) {
      resetRecorder();
      speakError(error);
      return;
    }
    stopMicTracks();
    recorderRef.current = null;
    chunksRef.current = [];
    stoppingRef.current = false;
    setRecording(false);
    setRecordSecs(0);
    try {
      const extra = await addFiles([file], "audio");
      const current = memoryRef.current;
      if (isAttachQuiz(current) && current.attachQuiz === "audio" && extra.length) {
        const limit = quizStepLimit("audio");
        const merged = [...current.chosenRefs];
        for (const img of extra) {
          if (quizAccepts("audio", img) && !merged.some((item) => item.id === img.id) && merged.length < limit) {
            merged.push(img);
          }
        }
        commit({ ...current, chosenRefs: merged });
      }
    } catch (error) {
      speakError(error);
    }
  }

  function toggleSpeak() {
    if (recording) void stopSpeak();
    else void startSpeak();
  }

  async function useResult(result: StudioResult) {
    const still = await resultToStill(result);
    if (!still) return;
    setPending((prev) => {
      if (prev.some((img) => img.preview === still.preview || img.dataUri === still.dataUri)) return prev;
      return [...prev, still].slice(0, ATTACH_LIMIT);
    });
    inputRef.current?.focus();
  }

  async function runOne(current: AgentMemory, shot: AgentShot) {
    setProgress(`Running ${shot.title}…`);
    current = {
      ...current,
      waitingForApproval: false,
      awaitingPromptReview: false,
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
      text:
        done?.status === "done"
          ? `Done: ${shot.title}\n\n${approvalText(current, done)}`
          : `Failed: ${shot.title}${done?.error ? `\n\n${done.error}` : ""}\n\n${approvalText(current, done || shot)}`,
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
        chosenRefs: attached.filter((img) => mediaKindOf(img) === "image").slice(0, VIDEO_REF_LIMIT),
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

  function askAttachQuiz(current: AgentMemory, attached: LocalImage[]) {
    const started = beginAttachQuiz(current, attached);
    commit(
      pushMessage(started.memory, {
        id: uuid(),
        role: "assistant",
        text: started.question,
        createdAt: Date.now(),
      })
    );
  }

  function cancelQuiz() {
    if (busy || !isAttachQuiz(memoryRef.current)) return;
    const started = cancelAttachQuiz(memoryRef.current);
    commit(
      pushMessage(started.memory, {
        id: uuid(),
        role: "assistant",
        text: started.question,
        createdAt: Date.now(),
      })
    );
  }

  async function finishQuizStep() {
    if (busy || !isAttachQuiz(memoryRef.current)) return;
    const step = advanceAttachQuiz(memoryRef.current);
    if (!step.done) {
      commit(
        pushMessage(step.memory, {
          id: uuid(),
          role: "assistant",
          text: step.question,
          createdAt: Date.now(),
        })
      );
      return;
    }
    commit(step.memory);
    setBusy(true);
    setProgress(null);
    try {
      await withKeepAlive("Working… You can switch apps.", () => planAndRun(memoryRef.current));
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

  function tapLibraryPhoto(photo: LibraryPhoto) {
    const current = memoryRef.current;
    const quiz = isAttachQuiz(current);
    if ((!current.awaitingVideoRefs && !current.awaitingRecreate && !quiz) || busy) return;
    if (quiz && !quizAccepts(current.attachQuiz, photo.image)) return;
    if (current.chosenRefs.some((img) => img.id === photo.id)) return;
    const shot = current.shots.find((item) => item.id === current.recreateShotId);
    const limit = quiz
      ? quizStepLimit(current.attachQuiz)
      : current.awaitingRecreate
        ? recreateRefLimit(shot?.kind || "video")
        : VIDEO_REF_LIMIT;
    const nextChosen = limit <= 1 ? [photo.image] : current.chosenRefs.length >= limit ? current.chosenRefs : [...current.chosenRefs, photo.image];
    if (limit > 1 && current.chosenRefs.length >= limit) return;
    commit({ ...current, chosenRefs: nextChosen });
    if (quiz && current.attachQuiz === "frames" && nextChosen.length >= quizStepLimit("frames")) {
      void finishQuizStep();
    }
  }

  function removeChosen(id: string) {
    const current = memoryRef.current;
    if ((!current.awaitingVideoRefs && !current.awaitingRecreate && !isAttachQuiz(current)) || busy) return;
    commit({ ...current, chosenRefs: current.chosenRefs.filter((img) => img.id !== id) });
  }

  function askToRecreate(current: AgentMemory, text = "", shot?: AgentShot | null) {
    const target = shot || recreateShot(current, text);
    if (!target) {
      commit(
        pushMessage(
          {
            ...current,
            awaitingRecreate: false,
            recreateShotId: "",
            recreateNote: "",
            waitingForApproval: false,
          },
          {
            id: uuid(),
            role: "assistant",
            text: "Nothing to remake yet. Attach a photo and tell me what to make.",
            createdAt: Date.now(),
          }
        )
      );
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
      await withKeepAlive("Updating… You can switch apps.", async () => {
        const edited = await applyRecreateEdits(current, text, extra);
        const reviewing = beginPromptReview(edited.memory, edited.shot);
        commit(
          pushMessage(reviewing, {
            id: uuid(),
            role: "assistant",
            text: promptReviewQuestion(edited.shot),
            createdAt: Date.now(),
          })
        );
        setDraft(edited.shot.prompt);
        inputRef.current?.focus();
      });
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

  function cancelReviewedPrompt() {
    if (busy || !memoryRef.current.awaitingPromptReview) return;
    const next = cancelPromptReview(memoryRef.current);
    commit(
      pushMessage(next, {
        id: uuid(),
        role: "assistant",
        text: "Okay. I did not send that prompt.",
        createdAt: Date.now(),
      })
    );
    setDraft("");
  }

  async function sendReviewedPrompt(prompt?: string) {
    const current = memoryRef.current;
    if (busy || !current.awaitingPromptReview) return;
    let applied: { memory: AgentMemory; shot: AgentShot };
    try {
      applied = applyReviewedPrompt(current, prompt ?? draft);
    } catch (error) {
      commit(
        pushMessage(current, {
          id: uuid(),
          role: "assistant",
          text: error instanceof Error ? error.message : "Nothing to send yet.",
          createdAt: Date.now(),
        })
      );
      return;
    }
    commit(applied.memory);
    setDraft("");
    setBusy(true);
    setProgress(null);
    try {
      await withKeepAlive("Working… You can switch apps.", () => runOne(applied.memory, applied.shot));
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

  function trainSavedText(name: string, count: number) {
    return `Saved ${name} with ${count} photo${count === 1 ? "" : "s"}. The next clip starts on the last frame so it stays this ${name}. If you ask them to turn, I paint that same person onto that place first — bedroom photos never become a second location.`;
  }

  async function handleTrain(current: AgentMemory, text: string, images: LocalImage[]) {
    const reply = (next: AgentMemory, message: string) => {
      commit(
        pushMessage(next, {
          id: uuid(),
          role: "assistant",
          text: message,
          createdAt: Date.now(),
        })
      );
      return true as const;
    };
    const finish = async (name: string, photos: LocalImage[]) => {
      const person = await savePerson(name, photos);
      return reply(
        {
          ...current,
          awaitingTrainName: false,
          awaitingTrainPhotos: false,
          trainName: "",
          personIds: [...new Set([...current.personIds, person.id])],
        },
        trainSavedText(person.name, person.photos.length)
      );
    };

    if (isForgetPerson(text)) {
      const name = trainNameFrom(text);
      if (!name) {
        const known = peopleNames();
        return reply(current, known.length ? `Who should I forget? You have ${known.join(", ")}.` : "No saved people yet.");
      }
      await forgetPerson(name);
      return reply(
        { ...current, personIds: current.personIds.filter((id) => getPeople().some((person) => person.id === id)) },
        `Forgot ${name}.`
      );
    }

    if (current.awaitingTrainName) {
      if (askedForVideo(text) && !isTrainCommand(text)) {
        commit({ ...current, awaitingTrainName: false, awaitingTrainPhotos: false, trainName: "" });
        return false;
      }
      const name = trainNameFrom(text) || (!isTrainCommand(text) ? text.trim() : "");
      if (!name) return reply({ ...current, awaitingTrainName: true }, "What name should I save these photos under?");
      if (images.length) return finish(name, images);
      return reply(
        { ...current, awaitingTrainName: false, awaitingTrainPhotos: true, trainName: name },
        `Okay, ${name}. Send 2–3 photos: front, side, and back if you have them. That way a side-view last frame still knows the rest of the body.`
      );
    }

    if (current.awaitingTrainPhotos) {
      if (images.length) return finish(current.trainName || trainNameFrom(text) || "Person", images);
      const maybeName = trainNameFrom(text) || (!isTrainCommand(text) && !askedForVideo(text) ? text.trim() : "");
      if (maybeName && !askedForVideo(text)) {
        return reply(
          { ...current, trainName: maybeName, awaitingTrainPhotos: true },
          `Okay, ${maybeName}. Still need photos — front, side, and back if you have them.`
        );
      }
      if (askedForVideo(text)) {
        commit({ ...current, awaitingTrainName: false, awaitingTrainPhotos: false, trainName: "" });
        return false;
      }
      return reply(
        current,
        `Still waiting for photos of ${current.trainName || "that person"}. Front, side, and back work best.`
      );
    }

    if (!isTrainCommand(text)) return false;

    const name = trainNameFrom(text);
    if (name && images.length) return finish(name, images);
    if (name) {
      return reply(
        { ...current, awaitingTrainName: false, awaitingTrainPhotos: true, trainName: name },
        `Okay, ${name}. Send 2–3 photos: front, side, and back if you have them. That way a side-view last frame still knows the rest of the body.`
      );
    }
    if (images.length) {
      return reply(
        { ...current, awaitingTrainName: true, awaitingTrainPhotos: false, trainName: "" },
        "What name should I save these photos under?"
      );
    }
    const known = peopleNames();
    return reply(
      { ...current, awaitingTrainName: true, awaitingTrainPhotos: false, trainName: "" },
      known.length ? `Who are we training? You already have ${known.join(", ")}.` : "What is the person's name?"
    );
  }

  async function planAndRun(current: AgentMemory) {
    setProgress("Planning…");
    const planned = await planAgentJob(current);
    if (!planned.shots.length) {
      commit(
        pushMessage(
          {
            ...current,
            personIds: planned.personIds,
            waitingForApproval: false,
            awaitingVideoRefs: false,
            attachQuiz: "",
            awaitingRecreate: false,
            awaitingPromptReview: false,
            recreateShotId: "",
            recreateNote: "",
          },
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
        personIds: planned.personIds,
        shots: [...kept, ...planned.shots],
        waitingForApproval: false,
        awaitingVideoRefs: false,
        attachQuiz: "",
        awaitingRecreate: false,
        awaitingPromptReview: false,
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
    const first = planned.shots[0];
    if (first) {
      current = beginPromptReview(current, first);
      commit(current);
      setDraft(first.prompt);
      inputRef.current?.focus();
      return;
    }
    commit(current);
  }

  async function usePickedPhotos() {
    if (busy || !memoryRef.current.awaitingVideoRefs) return;
    const current = { ...memoryRef.current, awaitingVideoRefs: false, hasPickedVideoRefs: true };
    commit(current);
    setBusy(true);
    setProgress(null);
    try {
      await withKeepAlive("Working… You can switch apps.", () => planAndRun(current));
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

  async function onSend(preset?: string, asRecreate = false) {
    const text = (preset ?? draft).trim();
    if (memoryRef.current.awaitingPromptReview && !asRecreate) {
      if (isQuizCancel(text)) {
        cancelReviewedPrompt();
        return;
      }
      await sendReviewedPrompt(text || draft);
      return;
    }
    const recreating = memoryRef.current.awaitingRecreate && Boolean(recreateShot(memoryRef.current, ""));
    if ((!text && pending.length === 0 && !recreating) || busy) return;
    const images = pending;
    const userMessage: AgentMessage = {
      id: uuid(),
      role: "user",
      text: text || (images.length ? "Use these photos." : recreating ? "Recreate this" : "Use these photos."),
      images,
      createdAt: Date.now(),
    };
    const attached = images.length
      ? [...memoryRef.current.userRefs.filter((img) => !images.some((item) => item.id === img.id)), ...images]
      : memoryRef.current.userRefs;
    let current = pushMessage(
      {
        ...memoryRef.current,
        brief: userMessage.text,
        images: images.length ? images : memoryRef.current.images,
        userRefs: attached.slice(0, ATTACH_LIMIT),
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

    const trained = await handleTrain(current, userMessage.text, images);
    if (trained) return;
    current = memoryRef.current;

    if (images.length) {
      current = {
        ...current,
        awaitingRecreate: false,
        awaitingPromptReview: false,
        recreateShotId: "",
        recreateNote: "",
        waitingForApproval: false,
      };
      commit(current);
    }

    if (isContinue(userMessage.text) && !images.length && !isAttachQuiz(current)) {
      const step = continueStatus(current);
      if (!step.next) {
        commit(
          pushMessage(step.memory, {
            id: uuid(),
            role: "assistant",
            text: step.text,
            createdAt: Date.now(),
          })
        );
        return;
      }
      const reviewing = beginPromptReview(step.memory, step.next);
      commit(
        pushMessage(reviewing, {
          id: uuid(),
          role: "assistant",
          text: step.text,
          createdAt: Date.now(),
        })
      );
      setDraft(step.next.prompt);
      inputRef.current?.focus();
      return;
    }

    if (current.awaitingRecreate && (asRecreate || isRecreate(userMessage.text))) {
      await finishRecreate(current, userMessage.text || "recreate this", images);
      return;
    }
    if (current.awaitingRecreate) {
      current = { ...current, awaitingRecreate: false, awaitingPromptReview: false, recreateShotId: "", recreateNote: "", waitingForApproval: false };
      commit(current);
    }

    if (isAttachQuiz(current) && !isRecreate(userMessage.text) && !asRecreate) {
      if (isQuizCancel(userMessage.text)) {
        cancelQuiz();
        return;
      }
      if (current.attachQuiz === "size") {
        const sized = parseWanSizeText(userMessage.text);
        if (sized) current = pickWanSize(current, sized.id);
        commit(current);
        if (sized || isQuizAdvance(userMessage.text) || !userMessage.text.trim()) {
          await finishQuizStep();
          return;
        }
        commit(
          pushMessage(current, {
            id: uuid(),
            role: "assistant",
            text: "Tap a size, or Skip / None.",
            createdAt: Date.now(),
          })
        );
        return;
      }
      if (isQuizAdvance(userMessage.text) || !userMessage.text.trim()) {
        await finishQuizStep();
        return;
      }
      if (askedForVideo(userMessage.text) || askedToGenerate(userMessage.text)) {
        askAttachQuiz(current, images);
        return;
      }
      const merged = [...current.chosenRefs];
      for (const img of images) {
        if (quizAccepts(current.attachQuiz, img) && !merged.some((item) => item.id === img.id)) merged.push(img);
      }
      commit(
        pushMessage(
          { ...current, chosenRefs: merged.slice(0, quizStepLimit(current.attachQuiz)) },
          {
            id: uuid(),
            role: "assistant",
            text: images.length
              ? "Added. Tap more on the bar, or tap Skip / None."
              : "Tap the bar, then Skip / None or Next.",
            createdAt: Date.now(),
          }
        )
      );
      return;
    }

    if (current.awaitingVideoRefs && !isRecreate(userMessage.text) && !asRecreate) {
      if (isContinue(userMessage.text) || /use these/i.test(userMessage.text)) {
        current = { ...current, awaitingVideoRefs: false, hasPickedVideoRefs: true };
        commit(current);
        setBusy(true);
        setProgress(null);
        try {
          await withKeepAlive("Working… You can switch apps.", () => planAndRun(current));
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
      if (askedToGenerate(userMessage.text)) {
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

    if (askedForVideo(userMessage.text) && !isContinue(userMessage.text) && !asRecreate && !(isRecreate(userMessage.text) && !images.length)) {
      askAttachQuiz(current, images);
      return;
    }

    if (askedToGenerate(userMessage.text) && !isContinue(userMessage.text) && !asRecreate && !(isRecreate(userMessage.text) && !images.length)) {
      askForVideoPhotos(current, images);
      return;
    }

    setBusy(true);
    setProgress(null);

    try {
      await withKeepAlive("Working… You can switch apps.", async () => {
        if (isRecreate(userMessage.text) && !images.length && lastActionableShot(current)) {
          askToRecreate(current, userMessage.text);
          return;
        }

        current = { ...current, chosenRefs: [], hasPickedVideoRefs: false };
        commit(current);
        await planAndRun(current);
      });
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
    if (memoryRef.current.awaitingPromptReview) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSend();
    }
  }

  const library = photoLibrary(memory, pending);
  const quiz = isAttachQuiz(memory) && !busy;
  const reviewing = Boolean(reviewShot(memory)) && !busy;
  const recreating = memory.awaitingRecreate && !busy && Boolean(recreateShot(memory, "")) && !reviewing;
  const picking = (memory.awaitingVideoRefs || memory.awaitingRecreate || quiz) && !busy && !reviewing;
  const showQueueContinue = Boolean(nextPendingShot(memory)) && memory.waitingForApproval && !busy && !quiz && !memory.awaitingVideoRefs && !reviewing;
  const showRecreateThis = Boolean(lastActionableShot(memory)) && memory.waitingForApproval && !busy && !quiz && !memory.awaitingVideoRefs && !reviewing;
  const reviewKind = reviewShot(memory)?.kind || "video";
  const recreateKind = memory.shots.find((item) => item.id === memory.recreateShotId)?.kind || "video";
  const photoLimit = recreating ? recreateRefLimit(recreateKind) : quiz ? quizStepLimit(memory.attachQuiz) : VIDEO_REF_LIMIT;
  const quizTitle =
    memory.attachQuiz === "frames"
      ? "Frames"
      : memory.attachQuiz === "people"
        ? "Ref photos"
        : memory.attachQuiz === "clip"
          ? "Ref video"
          : memory.attachQuiz === "audio"
            ? "Ref audio"
            : memory.attachQuiz === "pose"
              ? "Pose ref"
              : memory.attachQuiz === "size"
              ? "Video size"
              : "";

  return (
    <div className="chat">
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const picked = Array.from(e.target.files || []);
          e.target.value = "";
          void addFiles(picked);
        }}
      />

      <div className="chat-toolbar">
        <span>
          {recording
            ? `Listening · ${formatRecordSecs(recordSecs)}`
            : reviewing
            ? reviewKind === "image"
              ? "Edit the Qwen prompt"
              : "Edit the Wan prompt"
            : recreating
            ? `Change photos · ${memory.chosenRefs.length}/${photoLimit}`
            : quiz
              ? memory.attachQuiz === "size"
                ? memory.wanSizeId
                  ? WAN_SIZE_OPTIONS.find((item) => item.id === memory.wanSizeId)?.label || "Video size"
                  : "Video size"
                : `${quizTitle} · ${memory.chosenRefs.length}/${photoLimit}`
              : picking
                ? `Tap photos in order · ${memory.chosenRefs.length}/${VIDEO_REF_LIMIT}`
                : library.length
                  ? "Files"
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
                const dimmed = quiz && !quizAccepts(memory.attachQuiz, photo.image);
                return (
                  <div key={photo.id} className={`photo-bar-item${order >= 0 ? " on" : ""}${dimmed ? " dim" : ""}`} role="listitem">
                    <button
                      type="button"
                      className="photo-bar-hit"
                      disabled={!picking || dimmed}
                      onClick={() => tapLibraryPhoto(photo)}
                    >
                      <MediaThumb item={photo.image} />
                    </button>
                    <span className="photo-bar-num">{photo.label}</span>
                    <span className="photo-bar-kind">
                      {photo.mediaKind === "video" ? "Clip" : photo.mediaKind === "audio" ? "Sound" : photo.kind === "made" ? "Made" : "Yours"}
                    </span>
                    {order >= 0 ? <span className="photo-bar-order">{order + 1}</span> : null}
                    <button
                      type="button"
                      className="photo-bar-del"
                      aria-label="Delete file"
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
                : memory.attachQuiz === "size"
                  ? "Tap a size below, or Skip / None."
                  : quiz
                    ? memory.attachQuiz === "frames"
                      ? "Tap 1 photo = first frame, or 2 photos = first then last. That skips ref photos, video, and audio. Pose ref is still asked. Or Skip to ref photos. Cancel starts over."
                      : memory.attachQuiz === "people"
                        ? "Tap up to 10 ref photos, or Skip / None. Cancel starts over."
                        : memory.attachQuiz === "clip"
                          ? "Tap up to 5 ref videos, or Skip / None. Cancel starts over."
                          : memory.attachQuiz === "audio"
                            ? "Tap up to 5 ref audios, or Speak to record one. Skip / None. Cancel starts over."
                            : memory.attachQuiz === "pose"
                              ? "Tap pose photos. Those are for the prompt only — Wan does not get them. Or Skip / None. Cancel starts over."
                            : "Attach files if you want, or tap Skip / None."
                    : "No photos yet. Attach some, or tap Skip / None."}
            </p>
          )}
          {picking ? (
            <div className="photo-picked">
              {memory.attachQuiz === "size" ? (
                <div className="size-picks">
                  {WAN_SIZE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={memory.wanSizeId === opt.id ? "on" : ""}
                      onClick={() => commit(pickWanSize(memoryRef.current, opt.id))}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ) : memory.chosenRefs.length ? (
                memory.chosenRefs.map((img, index) => (
                  <span key={img.id} className="photo-picked-thumb">
                    <MediaThumb item={img} />
                    <em>{index + 1}</em>
                    <button type="button" onClick={() => removeChosen(img.id)} aria-label="Remove file">
                      ×
                    </button>
                  </span>
                ))
              ) : (
                <p className="photo-picked-empty">Nothing selected yet</p>
              )}
              {quiz && memory.attachQuiz === "audio" ? (
                <button
                  className={`photo-speak${recording ? " on" : ""}`}
                  type="button"
                  disabled={busy}
                  onClick={() => toggleSpeak()}
                >
                  {recording ? `Stop · ${formatRecordSecs(recordSecs)}` : "Speak"}
                </button>
              ) : null}
              {quiz ? (
                <button className="photo-cancel" type="button" disabled={recording} onClick={() => cancelQuiz()}>
                  Cancel
                </button>
              ) : null}
              <button
                className="photo-use"
                type="button"
                disabled={recording}
                onClick={() => (recreating ? void onSend(draft || "recreate this", true) : quiz ? void finishQuizStep() : void usePickedPhotos())}
              >
                {recreating ? "Recreate" : quiz ? quizButtonLabel(memory) : memory.chosenRefs.length ? "Next" : "Skip / None"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="chat-thread" ref={threadRef}>
        {memory.messages.length === 0 ? (
          <div className="chat-empty">
            <p className="ask-title">Ask anything</p>
            <p>Ask anything in Sinhala or English. Photos use Qwen 3.0 Pro. Video uses Wan 3.0 Prime. Frames: 1st photo first frame, 2nd photo last frame (2 max). Skip frames to pick up to 10 ref photos, 5 videos, and 5 audios together. On audio, Speak records your voice in the app. Pose ref photos are for the prompt only — Wan does not get them. Cancel before generate to start the quiz over.</p>
          </div>
        ) : (
          memory.messages.map((message) => (
            <article key={message.id} className={`bubble ${message.role}`}>
              {message.images?.length ? (
                <div className="bubble-photos">
                  {message.images.map((img) => {
                    const kind = mediaKindOf(img);
                    return (
                      <button
                        key={img.id}
                        type="button"
                        className="media-hit"
                        aria-label={`Open ${img.name || kind}`}
                        onClick={() =>
                          openMedia({
                            kind: kind === "audio" ? "audio" : kind === "video" ? "video" : "image",
                            url: img.preview || img.dataUri,
                            alt: img.name,
                          })
                        }
                      >
                        <MediaThumb item={img} />
                      </button>
                    );
                  })}
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
        {reviewing ? (
          <div className="recreate-box">
            <label htmlFor="prompt-review">
              {reviewKind === "image" ? "Prompt for Qwen — edit or send" : "Prompt for Wan — edit or send"}
            </label>
            <textarea
              id="prompt-review"
              ref={inputRef}
              rows={6}
              value={draft}
              className="prompt-review"
              placeholder="The prompt that will be sent"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
            />
            <div className="recreate-box-actions">
              <button className="ghost-btn" type="button" onClick={() => cancelReviewedPrompt()}>
                Cancel
              </button>
              <button type="button" onClick={() => void sendReviewedPrompt(draft)}>
                Send
              </button>
            </div>
          </div>
        ) : recreating ? (
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
              <button type="button" onClick={() => void onSend(draft || "recreate this", true)}>
                Recreate
              </button>
            </div>
          </div>
        ) : showQueueContinue || showRecreateThis ? (
          <div className="chat-approve">
            {showQueueContinue ? (
              <button type="button" onClick={() => void onSend("continue")}>
                Continue
              </button>
            ) : null}
            {showRecreateThis ? (
              <button type="button" onClick={() => void onSend("recreate this")}>
                Recreate this
              </button>
            ) : null}
          </div>
        ) : null}
        {pending.length > 0 ? (
          <div className="chat-pending">
            {pending.map((img) => (
              <span key={img.id} className="chat-pending-thumb">
                <MediaThumb item={img} />
                <button type="button" onClick={() => setPending((prev) => prev.filter((item) => item.id !== img.id))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {recreating || reviewing ? null : (
          <div className="composer">
            <button className="composer-icon" type="button" onClick={() => void pickPhotos()} aria-label="Add file">
              +
            </button>
            <button
              className={`composer-icon${recording ? " speaking" : ""}`}
              type="button"
              disabled={busy}
              aria-label={recording ? "Stop recording" : "Speak"}
              onClick={() => toggleSpeak()}
            >
              {recording ? <StopIcon /> : <MicIcon />}
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              value={draft}
              placeholder={picking ? "Tap files above, or Skip / None" : "Ask anything"}
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
        <div className="media-viewer" role="dialog" aria-modal="true" aria-label={viewer.kind === "video" ? "Video" : viewer.kind === "audio" ? "Audio" : "Image"}>
          <div className="media-viewer-bar">
            <button type="button" className="media-viewer-back" onClick={() => closeMedia()}>
              Back
            </button>
          </div>
          <div className="media-viewer-stage">
            {viewer.kind === "video" ? (
              <video src={viewer.url} controls autoPlay playsInline />
            ) : viewer.kind === "audio" ? (
              <audio src={viewer.url} controls autoPlay />
            ) : (
              <img src={viewer.url} alt={viewer.alt} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
