"use client";

import { ImagePlus, LoaderCircle, MessageSquarePlus, Send, ShieldOff, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  BASELINE_NOTE,
  CHANNEL_OPTIONS,
  type ComposerField,
  checkPhoto,
  DEFAULT_MODE,
  MODE_OPTIONS,
  MODE_STORAGE_KEY,
  messageRequest,
  parseMode,
  SIMULATED_NOTE,
  sendMessage,
} from "../../src/composer";
import { MAX_PHOTOS, type Mode } from "../../src/resolve-schemas";

// The inbox header: the Protected | Baseline switch for the next message sent from this
// browser, and the "Simulate a message" dialog (a bottom sheet under 640px). Built from
// Graphite's Tabs (segmented control), Button, Input and Dialog specs.

const BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-body-sm font-medium motion-safe:transition motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.97] disabled:cursor-not-allowed";
const PRIMARY = `${BUTTON} bg-inverted-solid text-on-inverted-foreground hover:bg-inverted-solid-hover disabled:bg-disabled disabled:text-disabled-foreground`;
const SECONDARY = `${BUTTON} bg-component-on-container-strong text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover`;
const FIELD =
  "w-full rounded-lg bg-component-on-container-strong px-2.5 text-body-sm text-primary-foreground shadow-default placeholder:text-tertiary-foreground aria-invalid:inset-ring aria-invalid:inset-ring-danger-border-default";

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <fieldset aria-label={label} className="inline-flex shrink-0 rounded-xl bg-sunken p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`h-7 rounded-lg px-2.5 text-body-sm font-medium motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out ${
            value === option.value
              ? "bg-component-on-sunken text-primary-foreground shadow-default"
              : "text-secondary-foreground hover:text-primary-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-body-sm font-medium text-primary-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-help`} className="text-caption-lg text-danger-foreground">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-caption-lg text-secondary-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
}

const sizeLabel = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

type Problem = { field: ComposerField; problem: string } | null;

function SimulateDialog({
  dialogRef,
  mode,
  onClose,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  mode: Mode;
  onClose: () => void;
}) {
  const router = useRouter();
  const ids = useId();
  const id = (name: string) => `${ids}-${name}`;
  const fileInput = useRef<HTMLInputElement>(null);
  const [channel, setChannel] = useState<"email" | "chat">("email");
  const [senderEmail, setSenderEmail] = useState("");
  const [senderPhone, setSenderPhone] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [photos, setPhotos] = useState<{ key: string; file: File }[]>([]);
  const nextKey = useRef(0);
  const [problem, setProblem] = useState<Problem>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const errorFor = (field: ComposerField) => (problem?.field === field ? problem.problem : null);
  const invalid = (field: ComposerField) => ({
    "aria-invalid": problem?.field === field ? true : undefined,
    "aria-describedby": id(`${field}-help`),
  });

  function addPhotos(files: FileList | null) {
    if (files === null) return;
    const picked = [...files];
    if (fileInput.current) fileInput.current.value = "";
    if (photos.length + picked.length > MAX_PHOTOS) {
      setProblem({ field: "photos", problem: `Add up to ${MAX_PHOTOS} photos.` });
      return;
    }
    for (const file of picked) {
      const reason = checkPhoto(file);
      if (reason !== null) {
        setProblem({ field: "photos", problem: reason });
        return;
      }
    }
    setProblem(null);
    setPhotos([
      ...photos,
      ...picked.map((file) => {
        nextKey.current += 1;
        return { key: `photo-${nextKey.current}`, file };
      }),
    ]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setSendError(null);
    const read = await Promise.all(
      photos.map(async ({ file }) => ({
        name: file.name,
        type: file.type,
        size: file.size,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const composed = messageRequest(
      { channel, senderEmail, senderPhone, subject, body, photos: read },
      mode,
    );
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
    setSubject("");
    setBody("");
    setPhotos([]);
    onClose();
    router.push(`/inbox?thread=${encodeURIComponent(sent.threadId)}`);
  }

  const modeLabel = MODE_OPTIONS.find((option) => option.value === mode)?.label ?? "";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={id("title")}
      aria-describedby={id("desc")}
      onClose={onClose}
      className="mx-0 mt-auto mb-0 max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-3xl bg-modal p-5 text-primary-foreground shadow-xl backdrop:bg-overlay sm:m-auto sm:w-[512px] sm:max-w-[calc(100vw-32px)] sm:rounded-3xl"
    >
      <div
        aria-hidden="true"
        className="mx-auto -mt-2 mb-3 h-1 w-8 rounded-full bg-border-strong sm:hidden"
      />
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 id={id("title")} className="text-heading-6 font-semibold tracking-heading">
            Simulate a message
          </h2>
          <p id={id("desc")} className="text-body-sm text-secondary-foreground">
            {SIMULATED_NOTE} Resolve answers it in {modeLabel} mode.
          </p>
        </header>

        <div className="flex flex-col gap-1.5">
          <span className="text-body-sm font-medium">Channel</span>
          <div>
            <Segmented
              label="Channel"
              options={CHANNEL_OPTIONS}
              value={channel}
              onChange={(next) => {
                setChannel(next);
                setProblem(null);
              }}
            />
          </div>
        </div>

        <Field
          id={id("senderEmail")}
          label="Sender's email"
          help={channel === "chat" ? "A chat needs an email address or a phone number." : undefined}
          error={errorFor("senderEmail")}
        >
          <input
            id={id("senderEmail")}
            type="email"
            autoComplete="off"
            placeholder="customer@example.com"
            value={senderEmail}
            onChange={(event) => setSenderEmail(event.target.value)}
            className={`${FIELD} h-8`}
            {...invalid("senderEmail")}
          />
        </Field>

        {channel === "chat" ? (
          <Field id={id("senderPhone")} label="Sender's phone" error={errorFor("senderPhone")}>
            <input
              id={id("senderPhone")}
              type="tel"
              autoComplete="off"
              placeholder="+254 700 000000"
              value={senderPhone}
              onChange={(event) => setSenderPhone(event.target.value)}
              className={`${FIELD} h-8`}
              {...invalid("senderPhone")}
            />
          </Field>
        ) : (
          <Field id={id("subject")} label="Subject" error={errorFor("subject")}>
            <input
              id={id("subject")}
              type="text"
              autoComplete="off"
              maxLength={200}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              className={`${FIELD} h-8`}
              {...invalid("subject")}
            />
          </Field>
        )}

        <Field id={id("body")} label="Message" error={errorFor("body")}>
          <textarea
            id={id("body")}
            rows={5}
            maxLength={4000}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className={`${FIELD} resize-y py-2`}
            {...invalid("body")}
          />
        </Field>

        <Field
          id={id("photos")}
          label="Photos"
          help={`Up to ${MAX_PHOTOS} JPEG, PNG or WebP images, 2 MB each.`}
          error={errorFor("photos")}
        >
          <input
            ref={fileInput}
            id={id("photos")}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => addPhotos(event.target.files)}
            {...invalid("photos")}
          />
          {photos.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {photos.map(({ key, file }) => (
                <li
                  key={key}
                  className="flex h-8 items-center gap-2 rounded-lg bg-card pr-1 pl-2.5 text-body-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="shrink-0 text-caption-lg text-tertiary-foreground tabular-nums">
                    {sizeLabel(file.size)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    title={`Remove ${file.name}`}
                    onClick={() => setPhotos(photos.filter((photo) => photo.key !== key))}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground"
                  >
                    <X size={14} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {photos.length < MAX_PHOTOS ? (
            <div>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className={`${SECONDARY} pl-2.5`}
              >
                <ImagePlus size={16} strokeWidth={1.5} aria-hidden="true" />
                Add photos
              </button>
            </div>
          ) : null}
        </Field>

        {sendError !== null ? (
          <p
            role="alert"
            className="rounded-lg bg-danger-subtle px-3 py-2 text-body-sm text-on-danger-subtle-foreground"
          >
            {sendError}
          </p>
        ) : null}

        <footer className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          <button
            type="submit"
            aria-busy={pending ? true : undefined}
            disabled={pending}
            className={`${PRIMARY} pl-2.5`}
          >
            {pending ? (
              <LoaderCircle
                size={16}
                strokeWidth={1.5}
                aria-hidden="true"
                className="motion-safe:animate-[spin_800ms_linear_infinite]"
              />
            ) : (
              <Send size={16} strokeWidth={1.5} aria-hidden="true" />
            )}
            Send message
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function InboxHeader() {
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      setMode(parseMode(localStorage.getItem(MODE_STORAGE_KEY)));
    } catch {
      // Storage can be blocked; the default applies.
    }
  }, []);

  function chooseMode(next: Mode) {
    setMode(next);
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Storage can be blocked; the choice still applies on this page.
    }
  }

  function close() {
    if (dialogRef.current?.open) dialogRef.current.close();
    trigger.current?.focus();
  }

  return (
    <header className="flex flex-col gap-3 px-4 pt-5 pb-4 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-heading-6 font-semibold tracking-heading">Inbox</h1>
        <Segmented
          label="Mode for the next message"
          options={MODE_OPTIONS}
          value={mode}
          onChange={chooseMode}
        />
        <button
          ref={trigger}
          type="button"
          onClick={() => dialogRef.current?.showModal()}
          className={`${PRIMARY} pl-2.5`}
        >
          <MessageSquarePlus size={16} strokeWidth={1.5} aria-hidden="true" />
          Simulate a message
        </button>
      </div>
      {mode === "baseline" ? (
        <p className="flex items-start gap-2 rounded-lg bg-warning-subtle px-3 py-2 text-body-sm text-on-warning-subtle-foreground">
          <ShieldOff size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
          {BASELINE_NOTE}
        </p>
      ) : null}
      <SimulateDialog dialogRef={dialogRef} mode={mode} onClose={close} />
    </header>
  );
}
