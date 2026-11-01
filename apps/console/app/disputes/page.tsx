import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../src/approval-routes";
import {
  DESCRIPTION,
  LINK,
  MONO,
  NUMBER,
  SUB_LINE,
  TABLE,
  TABLE_BODY,
  TABLE_CARD,
  TABLE_HEAD_ROW,
  TD,
  TH,
  TR,
} from "../../src/controls";
import { DISPUTE_ROUTE_MESSAGES, loadDisputes } from "../../src/dispute-routes";
import { DISPUTES_COPY, type DisputeRow, disputesView } from "../../src/disputes-view";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { Notice, Page, PageHeader } from "../ui";
import { DraftAgain } from "./draft-again";

// Every dispute PayPal opened and its latest evidence draft (ADR 0035, 0037), read on the server
// from Resolve once the gate has taken the approver's key (ADR 0038). Built from Graphite's Table
// and Button specs, through the shared recipes in `src/controls.ts`.

export const metadata: Metadata = { title: "Disputes · Countersign console" };
export const dynamic = "force-dynamic";

function Row({ row }: { row: DisputeRow }) {
  return (
    <tr className={TR}>
      <td className={`${TD} whitespace-nowrap`}>
        <time dateTime={row.at} title={row.at} className="text-caption-lg text-tertiary-foreground">
          {row.when}
        </time>
      </td>
      <td className={TD}>
        <span className={`block whitespace-nowrap text-primary-foreground ${MONO}`}>
          {row.disputeId}
        </span>
        {row.reason !== null ? (
          <span className={`${SUB_LINE} whitespace-nowrap`}>{row.reason}</span>
        ) : null}
      </td>
      <td className={`${TD} ${NUMBER}`}>{row.amount}</td>
      <td className={`${TD} min-w-48`}>
        <div className="flex flex-col items-start gap-2">
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
      <td className={`${TD} whitespace-nowrap text-secondary-foreground`}>{row.draftedBy}</td>
      <td className={`${TD} whitespace-nowrap`}>
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
    <div data-graphite="table" className={TABLE_CARD}>
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th scope="col" className={TH}>
                When
              </th>
              <th scope="col" className={TH}>
                Dispute
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Amount
              </th>
              <th scope="col" className={TH}>
                Draft
              </th>
              <th scope="col" className={TH}>
                Drafted by
              </th>
              <th scope="col" className={TH}>
                Decision
              </th>
            </tr>
          </thead>
          <tbody className={TABLE_BODY}>
            {rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
      <Page>
        <PageHeader title={DISPUTES_COPY.title} description={DISPUTES_COPY.subtitle} />
        {view === null ? (
          <Notice>{answer.ok ? null : answer.message}</Notice>
        ) : view.empty !== null ? (
          <p className={DESCRIPTION}>{view.empty}</p>
        ) : (
          <DisputeTable rows={view.rows} />
        )}
      </Page>
    </ConsoleShell>
  );
}
