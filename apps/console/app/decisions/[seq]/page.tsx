import "server-only";
import { Download, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../../src/approval-routes";
import { AUDIT_ROUTE_MESSAGES, loadDecision, loadVerify } from "../../../src/audit-routes";
import {
  button,
  CARD_TITLE,
  ICON,
  LINK,
  MONO,
  MONO_BREAK,
  STACK,
  STROKE,
  SUB_LINE,
} from "../../../src/controls";
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
import { Badge, Card, Code, Notice, Page, PageHeader, Section, Sections } from "../../ui";
import { ClaimsTable, TraceTable } from "../claims-parts";
import { CopyReply } from "./copy-reply";

// One decision (ADR 0034): what the message claims beside what the records say, how the gate
// decided, why, what happened at PayPal, its audit entry and the evidence exports. Read on the
// server with the approver's cookie through the read-only audit API. Built from Graphite's
// Breadcrumb, Badge, Card, Table, CodeCard, Tooltip and Button specs, through the shared recipes
// in `src/controls.ts`.

export const metadata: Metadata = { title: "Decision · Countersign console" };
export const dynamic = "force-dynamic";

type Readable = Extract<DecisionPageView, { readable: true }>;

function Breadcrumb({ view }: { view: DecisionPageView }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center text-body-sm">
      <Link
        href={view.breadcrumb.parent.href}
        className="text-secondary-foreground hover:text-primary-foreground"
      >
        {view.breadcrumb.parent.label}
      </Link>
      <span aria-hidden="true" className="mx-2 text-tertiary-foreground">
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
    <span title={hash.full} className={MONO}>
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
            <span key={key} className={MONO_BREAK}>
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
    <PageHeader
      before={<Breadcrumb view={view} />}
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {view.title}
          <Badge tone={view.badge.tone}>{view.badge.label}</Badge>
        </span>
      }
      description={view.line}
      actions={
        view.ticketHref !== null ? (
          <Link href={view.ticketHref} className={button("secondary", "md", { icon: "leading" })}>
            <ExternalLink size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
            {DECISION_COPY.openTicket}
          </Link>
        ) : null
      }
    />
  );
}

function Why({ view }: { view: Readable }) {
  return (
    <Section id="why" title={view.why.heading}>
      <ul className="flex flex-col gap-3 text-body-sm">
        {view.why.items.map((item) => (
          <li key={`${item.code}-${item.words}`}>
            <span className="text-primary-foreground">{item.words}</span>
            {item.code !== null ? (
              <>
                {" "}
                <Code>{item.code}</Code>
              </>
            ) : null}
            {item.detail !== null ? <span className={SUB_LINE}>{item.detail}</span> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Reply({ reply }: { reply: NonNullable<Readable["reply"]> }) {
  return (
    <Section id="reply" title={DECISION_COPY.replyHeading} description={reply.note}>
      <Card>
        <p className="text-body-sm whitespace-pre-wrap text-primary-foreground">{reply.text}</p>
        <CopyReply text={reply.text} label={DECISION_COPY.copyReply} done={DECISION_COPY.copied} />
      </Card>
    </Section>
  );
}

function Happened({ view }: { view: Readable }) {
  return (
    <Section id="happened" title={DECISION_COPY.happenedHeading}>
      <ol className="flex flex-col gap-3 text-body-sm">
        {view.happened.map((line) => (
          <li key={line.seq} className="flex flex-col gap-x-3 sm:flex-row">
            <time
              dateTime={line.at}
              title={line.at}
              className="shrink-0 text-caption-lg leading-body-sm text-tertiary-foreground tabular-nums sm:w-24"
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
            <span className="shrink-0 sm:w-24" />
            <Link href={view.waiting.href} className={LINK}>
              {view.waiting.words}
            </Link>
          </li>
        ) : null}
      </ol>
    </Section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-secondary-foreground sm:w-36">{label}</dt>
      <dd className="min-w-0 text-primary-foreground">{children}</dd>
    </div>
  );
}

function AuditEntry({ entry }: { entry: DecisionPageView["entry"] }) {
  return (
    <Card as="section" aria-labelledby="entry-heading">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="entry-heading" className={CARD_TITLE}>
          {entry.heading}
        </h2>
        <Badge tone={entry.chain.tone}>{entry.chain.label}</Badge>
        <span className="text-body-sm text-secondary-foreground">{entry.chain.line}</span>
      </div>
      <dl className="flex flex-col gap-3 text-body-sm">
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
    </Card>
  );
}

function Exports({ view }: { view: Readable }) {
  if (view.exports.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {view.exports.map((link) => (
        <a
          key={link.href}
          href={link.href}
          download
          className={button("secondary", "md", { icon: "leading" })}
        >
          <Download size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
          {link.label}
        </a>
      ))}
    </div>
  );
}

// The audit entry and, when there are exports, their buttons 24px below it.
function EntrySection({
  entry,
  exports,
}: {
  entry: DecisionPageView["entry"];
  exports: ReactNode;
}) {
  return (
    <Section id="entry" label="Audit entry">
      <div className={STACK}>
        <AuditEntry entry={entry} />
        {exports}
      </div>
    </Section>
  );
}

function Unreadable({ view }: { view: Extract<DecisionPageView, { readable: false }> }) {
  return (
    <>
      <PageHeader
        before={<Breadcrumb view={view} />}
        title={view.title}
        description={
          <>
            <span className="block text-primary-foreground">{view.line}</span>
            <span className="mt-2 block">{view.problem}</span>
          </>
        }
      />
      <Sections>
        <Section id="payload" title={DECISION_COPY.rawPayload}>
          <pre className="overflow-x-auto rounded-2xl bg-sunken px-5 py-4 font-mono text-code-sm">
            <code>{view.payload}</code>
          </pre>
        </Section>
        <EntrySection entry={view.entry} exports={null} />
      </Sections>
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
      <Page>
        {outcome.kind === "not_found" ? (
          <NotFound view={outcome.view} />
        ) : outcome.kind === "error" ? (
          <Notice>{outcome.message}</Notice>
        ) : !outcome.view.readable ? (
          <Unreadable view={outcome.view} />
        ) : (
          <>
            <Header view={outcome.view} />
            <Sections>
              <ClaimsTable claims={outcome.view.claims} />
              <TraceTable trace={outcome.view.trace} />
              <Why view={outcome.view} />
              {outcome.view.reply !== null ? <Reply reply={outcome.view.reply} /> : null}
              <Happened view={outcome.view} />
              <EntrySection entry={outcome.view.entry} exports={<Exports view={outcome.view} />} />
            </Sections>
          </>
        )}
      </Page>
    </ConsoleShell>
  );
}
