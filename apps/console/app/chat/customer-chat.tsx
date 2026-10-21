"use client";

import { ImagePlus, Info, LoaderCircle, Send, Store, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  CHAT_CONTROLS,
  CHAT_NOTICE,
  CHAT_POLL_MS,
  CHAT_STORAGE_KEY,
  CHAT_WORKING,
  type ChatEntry,
  type ChatField,
  type ChatView,
  chatRequest,
  emailProblem,
  loadChat,
  parseStoredChat,
} from "../../src/chat";
import { checkPhoto, MODE_STORAGE_KEY, parseMode, sendMessage } from "../../src/composer";

// The customer's simulated chat, laid out for a phone (a 448px column on wider screens). Built
// from Graphite's Input, Button and Spinner specs: 40px touch controls, a primary send button,
// and replies as plain text. Shows messages and replies only, never what Resolve did.

type Problem = { field: ChatField; problem: string } | null;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeChat(value: { email: string; threadId: string | null } | null) {
  try {
    if (value === null) localStorage.removeItem(CHAT_STORAGE_KEY);
    else localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be blocked; the chat still works on this page.
  }
}

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <LoaderCircle
      size={size}
      strokeWidth={1.5}
      aria-hidden="true"
      className="shrink-0 motion-safe:animate-[spin_800ms_linear_infinite]"
    />
  );
}

function Entry({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "customer") {
    return (
      <li className="flex flex-col items-end gap-1.5">
        {entry.photos.map((photo) => (
          // biome-ignore lint/performance/noImgElement: the photo comes from the console's own route, at its stored size
          <img
            key={photo.id}
            src={photo.src}
            alt="What you sent"
            className="max-h-48 max-w-[75%] rounded-2xl object-cover shadow-border"
          />
        ))}
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-component px-3 py-2 text-body-base text-primary-foreground">
          {entry.body}
        </p>
      </li>
    );
  }
  if (entry.kind === "reply") {
    return (
      <li className="flex flex-col items-start gap-1">
        <span className="text-caption-lg font-medium text-secondary-foreground">Resolve</span>
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-container px-3 py-2 text-body-base text-primary-foreground shadow-border">
          {entry.text}
        </p>
      </li>
    );
  }
  if (entry.kind === "working") {
    return (
      <li className="flex items-center gap-2 text-body-sm text-secondary-foreground">
        <span role="status" className="inline-flex items-center gap-2">
          <Spinner />
          {CHAT_WORKING}
        </span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 text-body-sm text-secondary-foreground">
      <Info size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      {entry.text}
    </li>
  );
}

export function CustomerChat() {
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [view, setView] = useState<ChatView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [body, setBody] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const stored = parseStoredChat(readStorage(CHAT_STORAGE_KEY));
    if (stored !== null) {
      setEmail(stored.email);
      setThreadId(stored.threadId);
    }
  }, []);

  const working = view?.working ?? false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` asks for a fresh read after a send
  useEffect(() => {
    if (threadId === null) return;
    let cancelled = false;
    async function read(id: string) {
      const result = await loadChat(id);
      if (cancelled) return;
      if (result.ok) {
        setView(result.view);
        setLoadError(null);
        return;
      }
      setLoadError(result.message);
      if (result.missing) {
        setThreadId(null);
        setView(null);
        if (email !== null) writeChat({ email, threadId: null });
      }
    }
    void read(threadId);
    const timer = working ? setInterval(() => void read(threadId), CHAT_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [threadId, working, reload, email]);

  const entryCount = view?.entries.length ?? 0;
  useEffect(() => {
    if (entryCount > 0) end.current?.scrollIntoView({ block: "end" });
  }, [entryCount]);

  const id = (name: string) => `${ids}-${name}`;
  const invalid = (field: ChatField) => ({
    "aria-invalid": problem?.field === field ? true : undefined,
    "aria-describedby": problem?.field === field ? id("problem") : undefined,
  });

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = emailProblem(emailDraft);
    if (reason !== null) {
      setProblem({ field: "email", problem: reason });
      return;
    }
    const chosen = emailDraft.trim();
    setProblem(null);
    setEmail(chosen);
    setThreadId(null);
    setView(null);
    writeChat({ email: chosen, threadId: null });
  }

  function startOver() {
    writeChat(null);
    setEmailDraft(email ?? "");
    setEmail(null);
    setThreadId(null);
    setView(null);
    setLoadError(null);
    setSendError(null);
    setProblem(null);
    setBody("");
    setPhoto(null);
  }

  function pickPhoto(files: FileList | null) {
    const file = files?.[0];
    if (fileInput.current) fileInput.current.value = "";
    if (file === undefined) return;
    const reason = checkPhoto(file);
    if (reason !== null) {
      setProblem({ field: "photo", problem: reason });
      return;
    }
    setProblem(null);
    setPhoto(file);
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || email === null) return;
    setSendError(null);
    const picked =
      photo === null
        ? null
        : {
            name: photo.name,
            type: photo.type,
            size: photo.size,
            bytes: new Uint8Array(await photo.arrayBuffer()),
          };
    const mode = parseMode(readStorage(MODE_STORAGE_KEY));
    const composed = chatRequest({ email, body, photo: picked, threadId }, mode);
    if (!composed.ok) {
      setProblem({ field: composed.field, problem: composed.problem });
      return;
    }
    setProblem(null);
    setPending(true);
    const sent = await sendMessage(composed.request);
    setPending(false);
    if (!sent.ok) {
      setSendError(sent.message);
      return;
    }
    setBody("");
    setPhoto(null);
    setThreadId(sent.threadId);
    writeChat({ email, threadId: sent.threadId });
    setReload((n) => n + 1);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-page text-primary-foreground">
      <div className="mx-auto flex w-full max-w-[448px] flex-1 flex-col">
        <header className="sticky top-0 z-10 flex flex-col gap-1 bg-page px-4 pt-4 pb-3 shadow-[0_1px_0_0_var(--color-border-default)]">
          <div className="flex items-center gap-2">
            <Store
              size={16}
              strokeWidth={1.5}
              aria-hidden="true"
              className="text-secondary-foreground"
            />
            <h1 className="mr-auto text-body-base font-semibold">Kikapu Studio</h1>
            {email !== null ? (
              <button type="button" onClick={startOver} className={CHAT_CONTROLS.startOver}>
                Start over
              </button>
            ) : null}
          </div>
          <p className="text-caption-lg text-secondary-foreground">{CHAT_NOTICE}</p>
        </header>

        {email === null ? (
          <form noValidate onSubmit={start} className="flex flex-col gap-4 px-4 pt-6 pb-8">
            <div className="flex flex-col gap-1">
              <h2 className="text-heading-6 font-semibold tracking-heading">Chat with the shop</h2>
              <p className="text-body-base text-secondary-foreground">
                Ask about an order, a delivery or a refund. Resolve, the shop's assistant, replies
                here.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={id("email")} className="text-body-sm font-medium">
                Your email
              </label>
              <input
                id={id("email")}
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="name@example.com"
                value={emailDraft}
                onChange={(event) => setEmailDraft(event.target.value)}
                className={CHAT_CONTROLS.email}
                {...invalid("email")}
              />
              {problem?.field === "email" ? (
                <p id={id("problem")} className="text-caption-lg text-danger-foreground">
                  {problem.problem}
                </p>
              ) : (
                <p className="text-caption-lg text-secondary-foreground">
                  Use the address you paid with, so the shop can find your order.
                </p>
              )}
            </div>
            <div>
              <button type="submit" className={CHAT_CONTROLS.start}>
                Start chat
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-1 flex-col gap-3 px-4 pt-4 pb-4">
              <p className="text-caption-lg text-tertiary-foreground">Chatting as {email}</p>
              {view === null || view.entries.length === 0 ? (
                <p className="text-body-sm text-secondary-foreground">
                  Write your first message below. Add a photo if something arrived damaged.
                </p>
              ) : (
                <ol aria-label="Messages" aria-live="polite" className="flex flex-col gap-3">
                  {view.entries.map((entry) => (
                    <Entry key={`${entry.kind}-${entry.key}`} entry={entry} />
                  ))}
                </ol>
              )}
              {loadError !== null ? (
                <p
                  role="alert"
                  className="rounded-lg bg-danger-subtle px-3 py-2 text-body-sm text-on-danger-subtle-foreground"
                >
                  {loadError}
                </p>
              ) : null}
              <div ref={end} />
            </div>

            <form
              noValidate
              onSubmit={send}
              className="sticky bottom-0 flex flex-col gap-2 bg-page px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-[0_-1px_0_0_var(--color-border-default)]"
            >
              {sendError !== null ? (
                <p
                  role="alert"
                  className="rounded-lg bg-danger-subtle px-3 py-2 text-body-sm text-on-danger-subtle-foreground"
                >
                  {sendError}
                </p>
              ) : null}
              {problem !== null && problem.field !== "email" ? (
                <p id={id("problem")} className="text-caption-lg text-danger-foreground">
                  {problem.problem}
                </p>
              ) : null}
              {photo !== null ? (
                <div className="flex h-8 items-center gap-2 rounded-lg bg-card pr-1 pl-2.5 text-body-sm">
                  <span className="min-w-0 flex-1 truncate">{photo.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${photo.name}`}
                    title={`Remove ${photo.name}`}
                    onClick={() => setPhoto(null)}
                    className={CHAT_CONTROLS.removePhoto}
                  >
                    <X size={14} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => pickPhoto(event.target.files)}
                />
                <button
                  type="button"
                  aria-label="Add a photo"
                  title="Add a photo"
                  disabled={photo !== null}
                  onClick={() => fileInput.current?.click()}
                  className={CHAT_CONTROLS.attach}
                  {...invalid("photo")}
                >
                  <ImagePlus size={20} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <label htmlFor={id("body")} className="sr-only">
                  Message
                </label>
                <input
                  id={id("body")}
                  type="text"
                  autoComplete="off"
                  enterKeyHint="send"
                  maxLength={4000}
                  placeholder="Message"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  className={CHAT_CONTROLS.message}
                  {...invalid("body")}
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  title="Send message"
                  aria-busy={pending ? true : undefined}
                  disabled={pending}
                  className={CHAT_CONTROLS.send}
                >
                  {pending ? (
                    <Spinner size={20} />
                  ) : (
                    <Send size={20} strokeWidth={1.75} aria-hidden="true" />
                  )}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
