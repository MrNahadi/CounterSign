import "server-only";
import { Download, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../../src/approval-routes";
import { AUDIT_ROUTE_MESSAGES, loadDecision, loadVerify } from "../../../src/audit-routes";
import {
  DECISION_COPY,
  type DecisionPageView,
  decisionPageOf,
  type HashView,
  type NotFoundView,
  type Piece,
} from "../../../src/decision-view";
import { DECISIONS_COPY } from "../../../src/decisions-view";
import { ConsoleShell } from "../../console-shell";
import { SignIn } from "../../sign-in";
import { Badge, Code, Notice } from "../../ui";
import { CopyReply } from "./copy-reply";

// One decision (ADR 0034): what the message claims beside what the records say, how the gate
// decided, why, what happened at PayPal, its audit entry and the evidence exports. Read on the
// server with the approver's cookie through the read-only audit API. Built from Graphite's
// Breadcrumb, Badge, Card, Table, CodeCard, Tooltip and Button specs.

export const metadata: Metadata = { title: "Decision · Countersign console" };
export const dynamic = "force-dynamic";

type Readable = Extract<DecisionPageView, { readable: true }>;

const LINK = "font-medium text-brand-foreground hover:underline";
const BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-body-sm font-medium motion-safe:transition motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.97]";
const SECONDARY = `${BUTTON} bg-component-on-container-strong text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover`;
const HEAD =
  "h-8 px-3 text-left align-middle text-caption-base font-medium tracking-caption-upper whitespace-nowrap text-tertiary-foreground uppercase";
const CELL = "h-10 px-3 py-2 align-top";
const MONO = "font-mono text-code-xs break-all";
const SECTION = "flex flex-col gap-3";
const H2 = "text-body-sm font-medium text-primary-foreground";
const COLUMN = "flex w-full max-w-5xl flex-col gap-8 px-4 pt-5 pb-8 md:px-6";

function Breadcrumb({ view }: { view: DecisionPageView }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center text-body-sm">
      <Link
        href={view.breadcrumb.parent.href}
        className="text-secondary-foreground hover:text-primary-foreground"
      >
        {view.breadcrumb.parent.label}
      </Link>
      <span aria-hidden="true" className="mx-1.5 text-tertiary-foreground">
        /
      </span>
      <span aria-current="page" className="font-medium text-primary-foreground">
        {view.breadcrumb.current}
      </span>
    </nav>
  );
}

function Hash({ hash }: { hash: HashView }) {
  return (
    <span title={hash.full} className="font-mono text-code-xs">
      <span aria-hidden="true">{hash.short}</span>
      <span className="sr-only">{hash.full}</span>
    </span>
  );
}

function Sentence({ pieces }: { pieces: Piece[] }) {
  return (
    <>
      {pieces.map((piece, index) => {
        const key = `${index}`;
        if ("mono" in piece) {
          return (
            <span key={key} className={MONO}>
              {piece.mono}
            </span>
          );
        }
        if ("code" in piece) return <Code key={key}>{piece.code}</Code>;
        return <span key={key}>{piece.text}</span>;
      })}
    </>
  );
}

function Header({ view }: { view: Readable }) {
  return (
    <header className="flex flex-col gap-2">
      <Breadcrumb view={view} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-heading-6 font-semibold tracking-heading">{view.title}</h1>
        <Badge tone={view.badge.tone}>{view.badge.label}</Badge>
      </div>
      <p className="text-body-sm text-secondary-foreground">{view.line}</p>
      {view.ticketHref !== null ? (
        <Link href={view.ticketHref} className={`${SECONDARY} self-start pl-2.5`}>
          <ExternalLink size={16} strokeWidth={1.5} aria-hidden="true" />
          {DECISION_COPY.openTicket}
        </Link>
      ) : null}
    </header>
  );
}

// At phone width each pair stacks: the header row hides and each cell carries its own label.
const STACK_TABLE = "w-full border-collapse text-body-sm max-md:block";
const STACK_ROW = "hover:bg-transparent-hover max-md:flex max-md:flex-col max-md:gap-2 max-md:py-3";
const STACK_CELL = `${CELL} max-md:h-auto max-md:py-0`;
const STACK_LABEL =
  "mb-0.5 block text-caption-base font-medium tracking-caption-upper text-tertiary-foreground uppercase md:hidden";

function ClaimsTable({ view }: { view: Readable }) {
  return (
    <section aria-labelledby="claims-heading" className={SECTION}>
      <h2 id="claims-heading" className={H2}>
        {DECISION_COPY.claimsHeading}
      </h2>
      <div className="overflow-x-auto rounded-2xl shadow-border">
        <table className={STACK_TABLE}>
          <thead className="max-md:hidden">
            <tr className="border-b border-border-default">
              <th scope="col" className={HEAD}>
                {DECISION_COPY.claimsColumn}
              </th>
              <th scope="col" className={HEAD}>
                {DECISION_COPY.recordsColumn}
              </th>
              <th scope="col" className={HEAD}>
                {DECISION_COPY.resultColumn}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle max-md:block">
            {view.claims.map((pair) => (
              <tr key={pair.check} className={STACK_ROW}>
                <td className={`${STACK_CELL} md:w-2/5`}>
                  <span className={STACK_LABEL}>{DECISION_COPY.claimsColumn}</span>
                  {pair.claim === null ? (
                    <span className="text-secondary-foreground">{DECISION_COPY.noClaim}</span>
                  ) : (
                    <span className="flex flex-col gap-1">
                      <span className="text-primary-foreground">{pair.claim.text}</span>
                      {pair.claim.quote !== null ? (
                        <span className="text-secondary-foreground break-words">
                          {pair.claim.quote}
                        </span>
                      ) : null}
                      {pair.claim.simulated ? (
                        <span>
                          <Badge tone="neutral">{DECISION_COPY.simulated}</Badge>
                        </span>
                      ) : null}
                    </span>
                  )}
                </td>
                <td className={STACK_CELL}>
                  <span className={STACK_LABEL}>{DECISION_COPY.recordsColumn}</span>
                  <span className="flex flex-col gap-1">
                    <span className="text-primary-foreground">{pair.record.lead}</span>
                    {pair.record.detail !== "" ? (
                      <span className="text-secondary-foreground">{pair.record.detail}</span>
                    ) : null}
                    {pair.record.sources.map((source) => (
                      <span
                        key={`${source.call}-${source.id}`}
                        className="text-secondary-foreground"
                      >
                        {`${source.words}, ${source.call} `}
                        <span className={MONO}>{source.id}</span>
                      </span>
                    ))}
                  </span>
                </td>
                <td className={STACK_CELL}>
                  <span className={STACK_LABEL}>{DECISION_COPY.resultColumn}</span>
                  <Badge tone={pair.verdict.tone}>{pair.verdict.label}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TraceTable({ view }: { view: Readable }) {
  return (
    <section aria-labelledby="trace-heading" className={SECTION}>
      <h2 id="trace-heading" className={H2}>
        {DECISION_COPY.traceHeading}
      </h2>
      <div className="overflow-x-auto rounded-2xl shadow-border">
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border-default">
              <th scope="col" className={HEAD}>
                {DECISION_COPY.traceCheck}
              </th>
              <th scope="col" className={HEAD}>
                {DECISION_COPY.traceRecords}
              </th>
              <th scope="col" className={HEAD}>
                {DECISION_COPY.traceResult}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {view.trace.map((entry) => (
              <tr key={entry.verifier} className="hover:bg-transparent-hover">
                <td className={`${CELL} min-w-48`}>
                  <span className="block text-primary-foreground">{entry.words}</span>
                  <span className="block font-mono text-code-xs text-secondary-foreground">
                    {entry.verifier}
                  </span>
                  <span className="block text-secondary-foreground">{entry.detail}</span>
                </td>
                <td className={`${CELL} min-w-56`}>
                  {entry.records.length === 0 ? (
                    <span className="text-secondary-foreground">{DECISION_COPY.noRecordsRead}</span>
                  ) : (
                    entry.records.map((record) => (
                      <span
                        key={`${record.call}-${record.id}`}
                        className="block text-secondary-foreground"
                      >
                        {`${record.words}, ${record.call} `}
                        <span className={MONO}>{record.id}</span>
                      </span>
                    ))
                  )}
                </td>
                <td className={CELL}>
                  <Badge tone={entry.result.tone}>{entry.result.label}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Why({ view }: { view: Readable }) {
  return (
    <section aria-labelledby="why-heading" className={SECTION}>
      <h2 id="why-heading" className={H2}>
        {view.why.heading}
      </h2>
      <ul className="flex flex-col gap-2 text-body-sm">
        {view.why.items.map((item) => (
          <li key={`${item.code}-${item.words}`}>
            <span className="text-primary-foreground">{item.words}</span>
            {item.code !== null ? (
              <>
                {" "}
                <Code>{item.code}</Code>
              </>
            ) : null}
            {item.detail !== null ? (
              <span className="block text-secondary-foreground">{item.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Reply({ reply }: { reply: NonNullable<Readable["reply"]> }) {
  return (
    <section aria-labelledby="reply-heading" className={SECTION}>
      <div className="flex flex-col gap-0.5">
        <h2 id="reply-heading" className={H2}>
          {DECISION_COPY.replyHeading}
        </h2>
        <p className="text-body-sm text-secondary-foreground">{reply.note}</p>
      </div>
      <div className="flex flex-col gap-3 rounded-2xl p-4 shadow-border">
        <p className="text-body-sm text-primary-foreground whitespace-pre-wrap">{reply.text}</p>
        <CopyReply text={reply.text} label={DECISION_COPY.copyReply} done={DECISION_COPY.copied} />
      </div>
    </section>
  );
}

function Happened({ view }: { view: Readable }) {
  return (
    <section aria-labelledby="happened-heading" className={SECTION}>
      <h2 id="happened-heading" className={H2}>
        {DECISION_COPY.happenedHeading}
      </h2>
      <ol className="flex flex-col gap-2 text-body-sm">
        {view.happened.map((line) => (
          <li key={line.seq} className="flex flex-col gap-x-3 sm:flex-row">
            <time
              dateTime={line.at}
              title={line.at}
              className="shrink-0 text-tertiary-foreground tabular-nums sm:w-20"
            >
              {line.when}
            </time>
            <span className="text-primary-foreground">
              <Sentence pieces={line.pieces} />
            </span>
          </li>
        ))}
        {view.waiting !== null ? (
          <li className="flex flex-col gap-x-3 sm:flex-row">
            <span className="shrink-0 sm:w-20" />
            <Link href={view.waiting.href} className={LINK}>
              {view.waiting.words}
            </Link>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-secondary-foreground sm:w-32">{label}</dt>
      <dd className="min-w-0 text-primary-foreground">{children}</dd>
    </div>
  );
}

function AuditEntry({ entry }: { entry: DecisionPageView["entry"] }) {
  return (
    <section
      aria-labelledby="entry-heading"
      className="flex flex-col gap-3 rounded-2xl p-4 shadow-border"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="entry-heading" className={H2}>
          {entry.heading}
        </h2>
        <Badge tone={entry.chain.tone}>{entry.chain.label}</Badge>
        <span className="text-body-sm text-secondary-foreground">{entry.chain.line}</span>
      </div>
      <dl className="flex flex-col gap-2 text-body-sm">
        {"intentHash" in entry && entry.intentHash !== null ? (
          <Field label={DECISION_COPY.intentHash}>
            <Hash hash={entry.intentHash} />
          </Field>
        ) : null}
        <Field label={DECISION_COPY.hash}>
          <Hash hash={entry.hash} />
        </Field>
        <Field label={DECISION_COPY.prevHash}>
          <Hash hash={entry.prevHash} />
        </Field>
        {"mandate" in entry ? <Field label={DECISION_COPY.mandate}>{entry.mandate}</Field> : null}
      </dl>
      <Link href={entry.checkHref} className={`text-body-sm ${LINK} self-start`}>
        {DECISION_COPY.checkChain}
      </Link>
    </section>
  );
}

function Exports({ view }: { view: Readable }) {
  if (view.exports.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {view.exports.map((link) => (
        <a key={link.href} href={link.href} download className={`${SECONDARY} pl-2.5`}>
          <Download size={16} strokeWidth={1.5} aria-hidden="true" />
          {link.label}
        </a>
      ))}
    </div>
  );
}

function Unreadable({ view }: { view: Extract<DecisionPageView, { readable: false }> }) {
  return (
    <>
      <header className="flex flex-col gap-2">
        <Breadcrumb view={view} />
        <h1 className="text-heading-6 font-semibold tracking-heading">{view.title}</h1>
        <p className="text-body-sm text-primary-foreground">{view.line}</p>
        <p className="text-body-sm text-secondary-foreground">{view.problem}</p>
      </header>
      <section aria-labelledby="payload-heading" className={SECTION}>
        <h2 id="payload-heading" className={H2}>
          {DECISION_COPY.rawPayload}
        </h2>
        <pre className="overflow-x-auto rounded-2xl bg-sunken px-4 py-3 font-mono text-code-sm">
          <code>{view.payload}</code>
        </pre>
      </section>
      <AuditEntry entry={view.entry} />
    </>
  );
}

function NotFound({ view }: { view: NotFoundView }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body-sm text-primary-foreground">{view.message}</p>
      <Link href={view.link.href} className={`text-body-sm ${LINK} self-start`}>
        {view.link.label}
      </Link>
    </div>
  );
}

export default async function DecisionPage({ params }: PageProps<"/decisions/[seq]">) {
  const key = approverKeyFromHeader((await headers()).get("cookie"));
  const signIn = (message: string | null) => (
    <ConsoleShell openApprovals={null}>
      <SignIn
        title={DECISIONS_COPY.title}
        line={AUDIT_ROUTE_MESSAGES.signInLine}
        message={message}
      />
    </ConsoleShell>
  );
  if (key === null) return signIn(null);

  const { seq } = await params;
  const deps = { env: process.env };
  const [detail, verify] = await Promise.all([loadDecision(key, seq, deps), loadVerify(key, deps)]);
  const outcome = decisionPageOf(detail, verify, new Date());
  if (outcome.kind === "sign_in") return signIn(APPROVAL_ROUTE_MESSAGES.signInAgain);
  return (
    <ConsoleShell>
      <div className={COLUMN}>
        {outcome.kind === "not_found" ? (
          <NotFound view={outcome.view} />
        ) : outcome.kind === "error" ? (
          <Notice>{outcome.message}</Notice>
        ) : !outcome.view.readable ? (
          <Unreadable view={outcome.view} />
        ) : (
          <>
            <Header view={outcome.view} />
            <ClaimsTable view={outcome.view} />
            <TraceTable view={outcome.view} />
            <Why view={outcome.view} />
            {outcome.view.reply !== null ? <Reply reply={outcome.view.reply} /> : null}
            <Happened view={outcome.view} />
            <AuditEntry entry={outcome.view.entry} />
            <Exports view={outcome.view} />
          </>
        )}
      </div>
    </ConsoleShell>
  );
}
