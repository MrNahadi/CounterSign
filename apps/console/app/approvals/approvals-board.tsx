"use client";

import { Check, Clock, Download, FileText, LogOut, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import {
  APPROVALS_COPY,
  APPROVALS_POLL_INTERVAL_MS,
  type ApprovingView,
  answerCard,
  type CardView,
  type ClaimPairView,
  CONTROL_CLASSES,
  type DocumentView,
  type Outcome,
  type PageView,
  REJECTION_SENTENCES,
  type RecentLine,
  signOut,
} from "../../src/approvals-view";
import {
  ALERT,
  CARD_TITLE,
  DESCRIPTION,
  FIELD_ERROR,
  ICON,
  MONO,
  MONO_BREAK,
  STACK,
  STROKE,
} from "../../src/controls";
import { QR_COPY, type QrView } from "../../src/qr-view";
import { Badge, Card, Code, Notice, Page, PageHeader, Section, Sections, Spinner } from "../ui";

// The approvals page (ADR 0032), phone first: the approver signs in with the key, sees each held
// call as an itemized card, and answers it with one tap. Card views are built on the server and
// arrive as plain props; this file only renders them and talks to the console's own routes.

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
    <PageHeader
      title="Approvals"
      actions={
        signedIn ? (
          <button
            type="button"
            onClick={leave}
            disabled={pending}
            aria-busy={pending ? true : undefined}
            className={CONTROL_CLASSES.signOut}
          >
            {pending ? (
              <Spinner />
            ) : (
              <LogOut size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
            )}
            {APPROVALS_COPY.signOut}
          </button>
        ) : null
      }
    />
  );
}

// A part of a card: a 14px medium heading, 8px above its content.
function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-body-sm font-medium text-primary-foreground">{title}</h3>
      {children}
    </section>
  );
}

const COLUMN_LABEL = "text-caption-lg font-medium text-secondary-foreground";

/** Two columns from 768px up, stacked pairs below; each pair ends with its verdict badge. */
function ClaimPairs({ pairs }: { pairs: ClaimPairView[] }) {
  return (
    <section aria-label={APPROVALS_COPY.claimsHeading} className="flex flex-col gap-2">
      <div className="hidden grid-cols-2 gap-4 md:grid">
        <h3 className={COLUMN_LABEL}>{APPROVALS_COPY.claimsColumn}</h3>
        <h3 className={COLUMN_LABEL}>{APPROVALS_COPY.recordsColumn}</h3>
      </div>
      <ul className="flex flex-col divide-y divide-border-subtle">
        {pairs.map((pair) => (
          <li key={pair.check} className="grid gap-2 py-3 text-body-sm md:grid-cols-2 md:gap-4">
            <div className="flex flex-col gap-1">
              <h3 className={`${COLUMN_LABEL} md:hidden`}>{APPROVALS_COPY.claimsColumn}</h3>
              {pair.claim === null ? (
                <p className="text-secondary-foreground">{APPROVALS_COPY.noClaim}</p>
              ) : (
                <>
                  <p className="text-primary-foreground">{pair.claim.text}</p>
                  {pair.claim.quote !== null ? (
                    <p className="whitespace-pre-wrap break-words text-secondary-foreground">
                      {pair.claim.quote}
                    </p>
                  ) : null}
                  {pair.claim.simulated ? (
                    <span>
                      <Badge tone="neutral">Simulated</Badge>
                    </span>
                  ) : null}
                </>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <h3 className={`${COLUMN_LABEL} md:hidden`}>{APPROVALS_COPY.recordsColumn}</h3>
              <p className="text-primary-foreground">{pair.record.lead}</p>
              {pair.record.detail !== "" ? (
                <p className="text-secondary-foreground">{pair.record.detail}</p>
              ) : null}
              {pair.record.sources.map((source) => (
                <p key={`${source.call}-${source.id}`} className="text-secondary-foreground">
                  {`${source.words}, ${source.call} `}
                  <Code>{source.id}</Code>
                </p>
              ))}
              <span>
                <Badge tone={pair.verdict.tone}>{pair.verdict.label}</Badge>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A short hash with its full value as the tooltip, and in full for screen readers. */
function Hash({ hash }: { hash: DocumentView["sha"] }) {
  return (
    <span title={hash.full} className={`${MONO} text-secondary-foreground`}>
      <span aria-hidden="true">{`SHA-256 ${hash.short}`}</span>
      <span className="sr-only">{`SHA-256 ${hash.full}`}</span>
    </span>
  );
}

function Mono({ values }: { values: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {values.map((value) => (
        <Code key={value}>{value}</Code>
      ))}
    </span>
  );
}

/** What approving sends: the parameters as rows, then each evidence item and document. */
function Approving({ view }: { view: ApprovingView }) {
  return (
    <Part title={APPROVALS_COPY.approvingHeading}>
      {view.line !== null ? <p className={DESCRIPTION}>{view.line}</p> : null}
      {view.rows.length > 0 ? (
        <dl className="flex flex-col divide-y divide-border-subtle">
          {view.rows.map((row) => (
            <div
              key={row.label}
              className="flex flex-col gap-0.5 py-3 text-body-sm sm:flex-row sm:gap-4"
            >
              <dt className="shrink-0 text-secondary-foreground sm:w-32">{row.label}</dt>
              <dd
                className={
                  row.mono
                    ? `${MONO_BREAK} text-primary-foreground`
                    : "whitespace-pre-wrap break-words text-primary-foreground"
                }
              >
                {row.text}
                {row.code !== undefined ? (
                  <span className={`block ${MONO_BREAK} text-secondary-foreground`}>
                    {row.code}
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {view.items.length > 0 ? (
        <ul
          aria-label={APPROVALS_COPY.itemsHeading}
          className="flex flex-col divide-y divide-border-subtle"
        >
          {view.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-1 py-3 text-body-sm">
              <p className="font-medium text-primary-foreground">{item.type}</p>
              <p className="whitespace-pre-wrap break-words text-primary-foreground">
                {item.notes}
              </p>
              {item.tracking !== null ? (
                <p className="text-secondary-foreground">
                  {`${APPROVALS_COPY.tracking}, ${item.tracking.carrier}: `}
                  <Mono values={item.tracking.numbers} />
                </p>
              ) : null}
              {item.refundIds.length > 0 ? (
                <p className="text-secondary-foreground">
                  {`${APPROVALS_COPY.refunds}: `}
                  <Mono values={item.refundIds} />
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view.documents.length > 0 ? (
        <ul
          aria-label={APPROVALS_COPY.documentsHeading}
          className="flex flex-col divide-y divide-border-subtle"
        >
          {view.documents.map((file) => (
            <li
              key={file.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-body-sm"
            >
              <FileText
                size={ICON.md}
                strokeWidth={STROKE(ICON.md)}
                aria-hidden="true"
                className="shrink-0 text-secondary-foreground"
              />
              <span className="min-w-0 break-all font-medium text-primary-foreground">
                {file.name}
              </span>
              {file.size !== null ? (
                <span className="text-secondary-foreground tabular-nums">{file.size}</span>
              ) : null}
              <Hash hash={file.sha} />
              {file.href !== null ? (
                <a
                  href={file.href}
                  download
                  aria-label={`${APPROVALS_COPY.download} ${file.name}`}
                  className={`${CONTROL_CLASSES.download} ml-auto`}
                >
                  <Download size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
                  {APPROVALS_COPY.download}
                </a>
              ) : (
                <span className="basis-full">
                  <Notice>{file.problem}</Notice>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Part>
  );
}

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
    <Card as="article" variant="ring" aria-labelledby={`card-${card.id}`}>
      <header className="flex flex-col gap-1">
        <div className="flex items-start gap-3">
          <h2 id={`card-${card.id}`} className={`mr-auto ${CARD_TITLE} tabular-nums`}>
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
          <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${DESCRIPTION}`}>
            {meta.join(" · ")}
            {card.simulated ? <Badge tone="neutral">Simulated</Badge> : null}
          </p>
        ) : null}
      </header>

      {card.claim !== null || card.excerpt !== null || card.photos.length > 0 ? (
        <Card variant="nested" gap="tight">
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
                    className="size-20 rounded-xl object-cover shadow-border"
                  />
                </a>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {card.reasons.length > 0 ? (
        <Part title="Why it's waiting">
          <ul className="flex flex-col gap-1">
            {card.reasons.map((reason) => (
              <li key={reason.code} className="text-body-sm text-secondary-foreground">
                {reason.words} <Code>{reason.code}</Code>
              </li>
            ))}
          </ul>
        </Part>
      ) : null}

      {card.claims.length > 0 ? <ClaimPairs pairs={card.claims} /> : null}

      {card.approving !== null ? <Approving view={card.approving} /> : null}

      {card.cannotExecute !== null && outcome === null ? (
        <Notice>{card.cannotExecute}</Notice>
      ) : null}

      {outcome !== null ? (
        <p role="status" className={`${ALERT[outcome.tone]} font-medium`}>
          {outcome.sentence}
        </p>
      ) : card.actions.length === 0 ? (
        <Notice>{REJECTION_SENTENCES.EXPIRED}</Notice>
      ) : (
        <footer className="flex flex-col gap-2">
          {error !== null ? (
            <p role="alert" className={FIELD_ERROR}>
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
                className={CONTROL_CLASSES.deny}
              >
                {pending === "deny" ? (
                  <Spinner size={ICON.xl} />
                ) : (
                  <X size={ICON.xl} strokeWidth={STROKE(ICON.xl)} aria-hidden="true" />
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
                className={CONTROL_CLASSES.approve}
              >
                {pending === "approve" ? (
                  <Spinner size={ICON.xl} />
                ) : (
                  <Check size={ICON.xl} strokeWidth={STROKE(ICON.xl)} aria-hidden="true" />
                )}
                Approve
              </button>
            ) : null}
          </div>
        </footer>
      )}
    </Card>
  );
}

function Recent({ lines }: { lines: RecentLine[] }) {
  return (
    <Section id="recent" title="Recent">
      {lines.length === 0 ? (
        <p className={DESCRIPTION}>{APPROVALS_COPY.noRecent}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {lines.map((line) => (
            <li
              key={line.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 py-4 text-body-sm"
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
    </Section>
  );
}

type Answered = { card: CardView; outcome: Outcome };

/** The approvals URL as a QR code, from 768px up: foreground modules on a container background. */
function OpenOnPhone({ qr }: { qr: QrView }) {
  return (
    <div className="hidden md:block">
      <Section id="open-on-phone" title={QR_COPY.heading}>
        <div className="flex flex-col items-start gap-3">
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
          <p className={DESCRIPTION}>{QR_COPY.line}</p>
        </div>
      </Section>
    </div>
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
    <Page width="narrow">
      <Header signedIn={true} />
      <Sections>
        {problem !== null || view !== null ? (
          <Section>
            <div className={STACK}>
              {problem !== null ? <Notice>{problem}</Notice> : null}
              {view !== null && shown.length === 0 ? (
                <p className={DESCRIPTION}>{APPROVALS_COPY.noOpen}</p>
              ) : null}
              {(view !== null ? shown : []).map((card) => (
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
          </Section>
        ) : null}
        {view !== null ? <Recent lines={view.recent} /> : null}
        {qr !== null ? <OpenOnPhone qr={qr} /> : null}
      </Sections>
    </Page>
  );
}
