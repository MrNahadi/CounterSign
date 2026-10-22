"use client";

import { Check, Clock, LogOut, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import {
  APPROVALS_COPY,
  APPROVALS_POLL_INTERVAL_MS,
  answerCard,
  type CardView,
  CONTROL_CLASSES,
  type Outcome,
  type PageView,
  REJECTION_SENTENCES,
  type RecentLine,
  signOut,
} from "../../src/approvals-view";
import { QR_COPY, type QrView } from "../../src/qr-view";
import { Badge, Code, Notice, Spinner } from "../ui";

// The approvals page (ADR 0032), phone first: the approver signs in with the key, sees each held
// call as an itemized card, and answers it with one tap. Card views are built on the server and
// arrive as plain props; this file only renders them and talks to the console's own routes.

const COLUMN = "mx-auto flex w-full max-w-xl flex-col gap-6 px-4 pt-5 pb-8 md:px-6";

function Header({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function leave() {
    if (pending) return;
    setPending(true);
    await signOut();
    setPending(false);
    router.refresh();
  }
  return (
    <header className="flex items-center gap-3">
      <h1 className="mr-auto text-heading-6 font-semibold tracking-heading">Approvals</h1>
      {signedIn ? (
        <button
          type="button"
          onClick={leave}
          disabled={pending}
          aria-busy={pending ? true : undefined}
          className={`${CONTROL_CLASSES.signOut} pl-2`}
        >
          {pending ? <Spinner /> : <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />}
          {APPROVALS_COPY.signOut}
        </button>
      ) : null}
    </header>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-body-sm font-medium text-primary-foreground">{title}</h3>
      {children}
    </section>
  );
}

const OUTCOME_TONES: Record<Outcome["tone"], string> = {
  neutral: "bg-card text-primary-foreground",
  positive: "bg-positive-subtle text-on-positive-subtle-foreground",
  warning: "bg-warning-subtle text-on-warning-subtle-foreground",
  danger: "bg-danger-subtle text-on-danger-subtle-foreground",
};

function ApprovalCard({
  card,
  outcome,
  pending,
  error,
  onAnswer,
}: {
  card: CardView;
  outcome: Outcome | null;
  pending: "approve" | "deny" | null;
  error: string | null;
  onAnswer: (answer: "approve" | "deny") => void;
}) {
  const meta = [card.order, card.sender].filter((part) => part !== null);
  return (
    <article
      aria-labelledby={`card-${card.id}`}
      className="flex flex-col gap-4 rounded-2xl bg-container p-4 shadow-border"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-start gap-3">
          <h2
            id={`card-${card.id}`}
            className="mr-auto text-body-base font-semibold text-primary-foreground tabular-nums"
          >
            {card.title}
          </h2>
          {outcome === null ? (
            <Badge tone="neutral">
              <Clock size={12} strokeWidth={1.5} aria-hidden="true" />
              <span className="tabular-nums">{card.timeLeft}</span>
            </Badge>
          ) : null}
        </div>
        {meta.length > 0 || card.simulated ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-secondary-foreground">
            {meta.join(" · ")}
            {card.simulated ? <Badge tone="neutral">Simulated</Badge> : null}
          </p>
        ) : null}
      </header>

      {card.claim !== null || card.excerpt !== null || card.photos.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg bg-card p-3">
          {card.claim !== null ? <p className="text-body-sm font-medium">{card.claim}</p> : null}
          {card.subject !== null ? (
            <p className="text-body-sm text-secondary-foreground">{card.subject}</p>
          ) : null}
          {card.excerpt !== null ? (
            <p className="whitespace-pre-wrap break-words text-body-sm">{card.excerpt}</p>
          ) : null}
          {card.photos.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {card.photos.map((photo) => (
                <a key={photo.src} href={photo.src} target="_blank" rel="noreferrer">
                  {/* biome-ignore lint/performance/noImgElement: photos come from Resolve through our own route, at their own size */}
                  <img
                    src={photo.src}
                    alt={photo.alt}
                    className="size-16 rounded-md object-cover shadow-border"
                  />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {card.reasons.length > 0 ? (
        <Section title="Why it's waiting">
          <ul className="flex flex-col gap-1">
            {card.reasons.map((reason) => (
              <li key={reason.code} className="text-body-sm text-secondary-foreground">
                {reason.words} <Code>{reason.code}</Code>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {card.checks.length > 0 ? (
        <Section title="What the records say">
          <ul className="flex flex-col divide-y divide-border-subtle">
            {card.checks.map((check) => (
              <li
                key={`${check.verifier}-${check.recordId ?? ""}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-body-sm"
              >
                <span className="text-primary-foreground">{check.verifier}</span>
                <Badge tone={check.tone}>{check.result}</Badge>
                {check.value !== null ? (
                  <span className="font-mono text-code-xs text-secondary-foreground">
                    {check.value}
                  </span>
                ) : null}
                {check.recordId !== null ? <Code>{check.recordId}</Code> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {card.cannotExecute !== null && outcome === null ? (
        <Notice>{card.cannotExecute}</Notice>
      ) : null}

      {outcome !== null ? (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-body-sm font-medium ${OUTCOME_TONES[outcome.tone]}`}
        >
          {outcome.sentence}
        </p>
      ) : card.actions.length === 0 ? (
        <Notice>{REJECTION_SENTENCES.EXPIRED}</Notice>
      ) : (
        <footer className="flex flex-col gap-2">
          {error !== null ? (
            <p role="alert" className="text-caption-lg text-danger-foreground">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            {card.actions.includes("deny") ? (
              <button
                type="button"
                onClick={() => onAnswer("deny")}
                disabled={pending !== null}
                aria-busy={pending === "deny" ? true : undefined}
                className={`${CONTROL_CLASSES.deny} pl-3`}
              >
                {pending === "deny" ? (
                  <Spinner size={20} />
                ) : (
                  <X size={20} strokeWidth={1.75} aria-hidden="true" />
                )}
                Deny
              </button>
            ) : null}
            {card.actions.includes("approve") ? (
              <button
                type="button"
                onClick={() => onAnswer("approve")}
                disabled={pending !== null}
                aria-busy={pending === "approve" ? true : undefined}
                className={`${CONTROL_CLASSES.approve} pl-3`}
              >
                {pending === "approve" ? (
                  <Spinner size={20} />
                ) : (
                  <Check size={20} strokeWidth={1.75} aria-hidden="true" />
                )}
                Approve
              </button>
            ) : null}
          </div>
        </footer>
      )}
    </article>
  );
}

function Recent({ lines }: { lines: RecentLine[] }) {
  return (
    <section aria-labelledby="recent" className="flex flex-col gap-2">
      <h2 id="recent" className="text-body-sm font-medium text-primary-foreground">
        Recent
      </h2>
      {lines.length === 0 ? (
        <p className="text-body-sm text-secondary-foreground">{APPROVALS_COPY.noRecent}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {lines.map((line) => (
            <li
              key={line.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-body-sm"
            >
              <span className="font-semimedium text-primary-foreground tabular-nums">
                {line.title}
              </span>
              {line.order !== null ? (
                <span className="text-secondary-foreground">{line.order}</span>
              ) : null}
              <Badge tone={line.tone}>{line.outcome}</Badge>
              {line.detail !== null ? (
                <span className="text-secondary-foreground">{line.detail}</span>
              ) : null}
              <span className="ml-auto text-caption-lg text-tertiary-foreground tabular-nums">
                {line.time}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Answered = { card: CardView; outcome: Outcome };

/** The approvals URL as a QR code, from 768px up: foreground modules on a container background. */
function OpenOnPhone({ qr }: { qr: QrView }) {
  return (
    <section className="hidden flex-col items-start gap-3 md:flex" aria-label={QR_COPY.heading}>
      <h2 className="text-body-sm font-medium">{QR_COPY.heading}</h2>
      <svg
        role="img"
        aria-label={qr.label}
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
        className="size-40 rounded-lg bg-container text-primary-foreground shadow-border"
      >
        <title>{qr.label}</title>
        {qr.rects.map((rect) => (
          <rect
            key={`${rect.x}-${rect.y}`}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={1}
            className="fill-current"
          />
        ))}
      </svg>
      <p className="text-body-sm text-secondary-foreground">{QR_COPY.line}</p>
    </section>
  );
}

/** Signed in: the open cards, newest first, and the recent answers, re-read every 3 seconds. */
export function ApprovalsBoard({
  view,
  problem,
  qr = null,
}: {
  view: PageView | null;
  problem: string | null;
  qr?: QrView | null;
}) {
  const router = useRouter();
  const [answered, setAnswered] = useState<Record<string, Answered>>({});
  const [pending, setPending] = useState<Record<string, "approve" | "deny">>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, APPROVALS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [router]);

  async function answer(card: CardView, choice: "approve" | "deny") {
    if (pending[card.id] !== undefined || answered[card.id] !== undefined) return;
    setPending((all) => ({ ...all, [card.id]: choice }));
    setErrors(({ [card.id]: _, ...rest }) => rest);
    const result = await answerCard(card, choice);
    setPending(({ [card.id]: _, ...rest }) => rest);
    if (result.ok) {
      setAnswered((all) => ({ ...all, [card.id]: { card, outcome: result.value } }));
    } else {
      setErrors((all) => ({ ...all, [card.id]: result.message }));
    }
    router.refresh();
  }

  // Answered cards stay in place with their outcome after the next poll drops them.
  const open = view?.cards ?? [];
  const shown = [
    ...open.map((card) => answered[card.id]?.card ?? card),
    ...Object.values(answered)
      .map(({ card }) => card)
      .filter((card) => !open.some((other) => other.id === card.id)),
  ].sort((a, b) => Number(b.id) - Number(a.id));

  return (
    <div className={COLUMN}>
      <Header signedIn={true} />
      {problem !== null ? <Notice>{problem}</Notice> : null}
      {view !== null ? (
        <>
          {shown.length === 0 ? (
            <p className="text-body-sm text-secondary-foreground">{APPROVALS_COPY.noOpen}</p>
          ) : (
            <div className="flex flex-col gap-4">
              {shown.map((card) => (
                <ApprovalCard
                  key={card.id}
                  card={card}
                  outcome={answered[card.id]?.outcome ?? null}
                  pending={pending[card.id] ?? null}
                  error={errors[card.id] ?? null}
                  onAnswer={(choice) => answer(card, choice)}
                />
              ))}
            </div>
          )}
          <Recent lines={view.recent} />
        </>
      ) : null}
      {qr !== null ? <OpenOnPhone qr={qr} /> : null}
    </div>
  );
}
