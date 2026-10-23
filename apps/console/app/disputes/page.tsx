import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../src/approval-routes";
import { DISPUTE_ROUTE_MESSAGES, loadDisputes } from "../../src/dispute-routes";
import { DISPUTES_COPY, type DisputeRow, disputesView } from "../../src/disputes-view";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { Notice } from "../ui";
import { DraftAgain } from "./draft-again";

// Every dispute PayPal opened and its latest evidence draft (ADR 0035, 0037), read on the server
// from Resolve once the gate has taken the approver's key (ADR 0038). Built from Graphite's Table
// and Button specs.

export const metadata: Metadata = { title: "Disputes · Countersign console" };
export const dynamic = "force-dynamic";

const LINK = "font-medium text-brand-foreground hover:underline";
const HEAD =
  "h-8 px-3 text-left align-middle text-caption-base font-medium tracking-caption-upper whitespace-nowrap text-tertiary-foreground uppercase";
const CELL = "h-10 px-3 py-2 align-top";

function Header() {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-heading-6 font-semibold tracking-heading">{DISPUTES_COPY.title}</h1>
      <p className="text-body-sm text-secondary-foreground">{DISPUTES_COPY.subtitle}</p>
    </header>
  );
}

function Row({ row }: { row: DisputeRow }) {
  return (
    <tr className="hover:bg-transparent-hover">
      <td className={`${CELL} whitespace-nowrap text-tertiary-foreground`}>
        <time dateTime={row.at} title={row.at}>
          {row.when}
        </time>
      </td>
      <td className={CELL}>
        <span className="block font-mono text-code-xs whitespace-nowrap text-primary-foreground">
          {row.disputeId}
        </span>
        {row.reason !== null ? (
          <span className="block whitespace-nowrap text-secondary-foreground">{row.reason}</span>
        ) : null}
      </td>
      <td className={`${CELL} text-right whitespace-nowrap tabular-nums`}>{row.amount}</td>
      <td className={`${CELL} min-w-48`}>
        <div className="flex flex-col items-start gap-1.5">
          {row.draft.href !== null ? (
            <Link href={row.draft.href} className={LINK}>
              {row.draft.words}
            </Link>
          ) : (
            <span className="text-primary-foreground">{row.draft.words}</span>
          )}
          {row.canDraftAgain ? <DraftAgain disputeId={row.disputeId} /> : null}
        </div>
      </td>
      <td className={`${CELL} whitespace-nowrap text-secondary-foreground`}>{row.draftedBy}</td>
      <td className={`${CELL} whitespace-nowrap`}>
        {row.decision !== null ? (
          <Link href={row.decision.href} className={LINK}>
            {row.decision.label}
            <span className="sr-only">{` for ${row.disputeId}`}</span>
          </Link>
        ) : null}
      </td>
    </tr>
  );
}

function DisputeTable({ rows }: { rows: DisputeRow[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl shadow-border">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-border-default">
            <th scope="col" className={HEAD}>
              When
            </th>
            <th scope="col" className={HEAD}>
              Dispute
            </th>
            <th scope="col" className={`${HEAD} text-right`}>
              Amount
            </th>
            <th scope="col" className={HEAD}>
              Draft
            </th>
            <th scope="col" className={HEAD}>
              Drafted by
            </th>
            <th scope="col" className={HEAD}>
              Decision
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const COLUMN = "flex w-full flex-col gap-6 px-4 pt-5 pb-8 md:px-6";

export default async function DisputesPage() {
  const key = approverKeyFromHeader((await headers()).get("cookie"));
  const signIn = (message: string | null) => (
    <ConsoleShell openApprovals={null}>
      <SignIn
        title={DISPUTES_COPY.title}
        line={DISPUTE_ROUTE_MESSAGES.signInLine}
        message={message}
      />
    </ConsoleShell>
  );
  if (key === null) return signIn(null);

  const answer = await loadDisputes(key, { env: process.env });
  if (!answer.ok && answer.status === 401) return signIn(APPROVAL_ROUTE_MESSAGES.signInAgain);
  const view = answer.ok ? disputesView(answer.value, new Date()) : null;
  return (
    <ConsoleShell>
      <div className={COLUMN}>
        <Header />
        {view === null ? (
          <Notice>{answer.ok ? null : answer.message}</Notice>
        ) : view.empty !== null ? (
          <p className="text-body-sm text-secondary-foreground">{view.empty}</p>
        ) : (
          <DisputeTable rows={view.rows} />
        )}
      </div>
    </ConsoleShell>
  );
}
