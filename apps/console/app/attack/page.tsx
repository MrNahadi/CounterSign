import "server-only";
import { RotateCcw } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../src/approval-routes";
import {
  ATTACK_COPY,
  type AttackProposalView,
  type AttackView,
  type VisitorCounterView,
  visitorCounter,
} from "../../src/attack";
import { loadAttack } from "../../src/attack-routes";
import { loadVisitorMoney } from "../../src/audit-routes";
import { button, CARD_TITLE, ICON, MONO, STROKE, SUB_LINE } from "../../src/controls";
import { POLL_INTERVAL_MS } from "../../src/inbox-view";
import { inboxAccess } from "../../src/resolve-routes";
import { ConsoleShell } from "../console-shell";
import { ClaimsTable, TraceTable } from "../decisions/claims-parts";
import { RefreshWhileWorking } from "../inbox/refresh-while-working";
import { SignIn } from "../sign-in";
import { Badge, Card, Code, Notice, Page, PageHeader, Section, Sections, Working } from "../ui";
import { AttackForm } from "./attack-form";

// "Attack it yourself" (brief §6; ADR 0043): write any message from any sender, Resolve answers
// it in protected mode, and the page shows what Resolve proposed, Countersign's decision, and the
// message's claims beside the records, with the shared claims-vs-records tables, under a counter
// of money moved by visitors read from the audit log. Read on the server at each render; a
// working run re-renders it every 2 seconds. Emails are masked.

export const metadata: Metadata = { title: "Attack it yourself · Countersign console" };
export const dynamic = "force-dynamic";

// The counter of money moved by visitors, read from the audit log at each render.
function VisitorCounter({ view }: { view: VisitorCounterView }) {
  return (
    <Card aria-labelledby="visitor-counter-title" aria-live="polite" gap="tight">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="visitor-counter-title" className={CARD_TITLE}>
          {ATTACK_COPY.counterTitle}
        </h2>
        <Badge tone={view.badge.tone}>{view.badge.label}</Badge>
      </div>
      <p className="text-heading-5 font-semibold tracking-heading tabular-nums text-primary-foreground">
        {view.value}
      </p>
      <p className={SUB_LINE}>{view.line}</p>
      <p className={SUB_LINE}>{ATTACK_COPY.limits}</p>
    </Card>
  );
}

function Message({ view }: { view: AttackView }) {
  return (
    <Section id="message" title={ATTACK_COPY.yourMessage}>
      <Card gap="tight">
        <p className="flex flex-wrap items-center gap-2 text-body-sm text-secondary-foreground">
          <Badge tone="neutral">{view.channelLabel}</Badge>
          <span className={MONO}>{view.sender}</span>
        </p>
        <p className="whitespace-pre-wrap break-words text-body-sm text-primary-foreground">
          {view.body}
        </p>
      </Card>
    </Section>
  );
}

function Proposal({ proposal, index }: { proposal: AttackProposalView; index: number }) {
  return (
    <div className="flex flex-col gap-7">
      <Card as="article" aria-labelledby={`proposal-${index}-heading`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 id={`proposal-${index}-heading`} className={CARD_TITLE}>
            <Code>{proposal.action}</Code>
          </h3>
          <Badge tone={proposal.decision.tone}>{proposal.decision.label}</Badge>
        </div>
        {proposal.args.length > 0 ? (
          <dl className="flex flex-col gap-1 text-body-sm">
            {proposal.args.map((arg) => (
              <div key={arg.label} className="flex gap-3">
                <dt className="w-24 shrink-0 text-secondary-foreground">{arg.label}</dt>
                <dd className={`min-w-0 ${MONO} text-primary-foreground`}>{arg.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {proposal.decision.reasons.length > 0 ? (
          <ul className="flex flex-col gap-2 text-body-sm">
            {proposal.decision.reasons.map((reason) => (
              <li key={reason.code}>
                <span className="text-primary-foreground">{reason.words}</span>{" "}
                <Code>{reason.code}</Code>
              </li>
            ))}
          </ul>
        ) : null}
        {proposal.note !== null ? <span className={SUB_LINE}>{proposal.note}</span> : null}
      </Card>
      {proposal.claims.length > 0 ? (
        <ClaimsTable claims={proposal.claims} id={`claims-${index}`} />
      ) : null}
      {proposal.trace.length > 0 ? (
        <TraceTable trace={proposal.trace} id={`trace-${index}`} />
      ) : null}
    </div>
  );
}

function Result({ view }: { view: AttackView }) {
  return (
    <Sections>
      <Message view={view} />
      <Section id="proposed" title={ATTACK_COPY.proposed}>
        {view.working ? (
          <Working label={ATTACK_COPY.working} />
        ) : view.proposals.length > 0 ? (
          <div className="flex flex-col gap-14">
            {view.proposals.map((proposal, index) => (
              <Proposal key={proposal.id} proposal={proposal} index={index} />
            ))}
          </div>
        ) : (
          <Notice tone="positive">{view.noProposal}</Notice>
        )}
        {!view.working && view.outcome !== null ? (
          <p className={`mt-5 ${SUB_LINE}`}>{view.outcome}</p>
        ) : null}
      </Section>
      {view.reply !== null ? (
        <Section id="reply" title={ATTACK_COPY.reply}>
          <Card>
            <p className="whitespace-pre-wrap break-words text-body-sm text-primary-foreground">
              {view.reply}
            </p>
          </Card>
        </Section>
      ) : null}
    </Sections>
  );
}

export default async function AttackPage({ searchParams }: PageProps<"/attack">) {
  const { thread } = await searchParams;
  const threadId = typeof thread === "string" ? thread : null;
  const key = approverKeyFromHeader((await headers()).get("cookie"));
  const deps = { env: process.env };
  const access = await inboxAccess(key, deps);
  const signIn = (message: string | null) => (
    <ConsoleShell openApprovals={null}>
      <SignIn title={ATTACK_COPY.title} line={ATTACK_COPY.signInLine} message={message} />
    </ConsoleShell>
  );
  if (access.state === "signed-out" || key === null) {
    return signIn(access.state === "signed-out" ? access.message : null);
  }
  const open = access.state === "open";
  const [loaded, moved] = await Promise.all([
    open && threadId !== null ? loadAttack(key, threadId, deps) : null,
    open ? loadVisitorMoney(key, deps) : null,
  ]);
  if (
    (loaded !== null && !loaded.ok && loaded.status === 401) ||
    (moved !== null && !moved.ok && moved.status === 401)
  ) {
    return signIn(APPROVAL_ROUTE_MESSAGES.signInAgain);
  }

  return (
    <ConsoleShell>
      <RefreshWhileWorking
        active={loaded?.ok === true && loaded.value.working}
        intervalMs={POLL_INTERVAL_MS}
      />
      <Page>
        <PageHeader
          title={ATTACK_COPY.title}
          description={ATTACK_COPY.description}
          actions={
            threadId !== null ? (
              <Link href="/attack" className={button("secondary", "md", { icon: "leading" })}>
                <RotateCcw size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
                {ATTACK_COPY.newAttack}
              </Link>
            ) : null
          }
        />
        <div className="mb-7 flex flex-col gap-5">
          <Notice>{ATTACK_COPY.simulated}</Notice>
          {moved !== null ? <VisitorCounter view={visitorCounter(moved)} /> : null}
        </div>
        {access.state === "unreachable" ? (
          <Notice>{access.message}</Notice>
        ) : loaded === null ? (
          <AttackForm />
        ) : loaded.ok ? (
          <Result view={loaded.value} />
        ) : (
          <Notice>{loaded.message}</Notice>
        )}
      </Page>
    </ConsoleShell>
  );
}
