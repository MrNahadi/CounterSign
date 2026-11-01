import "server-only";
import { ChevronLeft, Search } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../src/approval-routes";
import { AUDIT_ROUTE_MESSAGES, loadDecisions, loadVerify } from "../../src/audit-routes";
import {
  button,
  DESCRIPTION,
  ICON,
  INPUT,
  INPUT_HEIGHT,
  LINK,
  MONO,
  NUMBER,
  SEGMENT,
  SEGMENT_OFF,
  SEGMENT_ON,
  SEGMENTED,
  STACK,
  STROKE,
  SUB_LINE,
  TABLE,
  TABLE_BODY,
  TABLE_CARD,
  TABLE_HEAD_ROW,
  TD,
  TH,
  TOOLBAR,
  TR,
} from "../../src/controls";
import {
  type ChainView,
  chainView,
  DECISIONS_COPY,
  type DecisionListRow,
  type DecisionsView,
  decisionFiltersOf,
  decisionsView,
} from "../../src/decisions-view";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { Badge, Card, Code, Notice, Page, PageHeader } from "../ui";

// Every decision the gate recorded (ADR 0034), read on the server with the approver's cookie
// through the read-only audit API. Built from Graphite's Table, Badge, Card, Tabs (segmented
// control), Input and Button specs, through the shared recipes in `src/controls.ts`.

export const metadata: Metadata = { title: "Decisions · Countersign console" };
export const dynamic = "force-dynamic";

function ChainCard({ chain }: { chain: ChainView }) {
  return (
    <Card as="section" aria-label="Audit chain">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone={chain.tone}>{chain.label}</Badge>
        <p className={DESCRIPTION}>{chain.line}</p>
        {chain.link !== null ? (
          <Link href={chain.link.href} className={`text-body-sm ${LINK}`}>
            {chain.link.label}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

function Toolbar({ view }: { view: DecisionsView }) {
  return (
    <div data-graphite="toolbar" className={TOOLBAR}>
      <nav aria-label={DECISIONS_COPY.filterLabel} className={SEGMENTED}>
        {view.segments.map((segment) => (
          <Link
            key={segment.label}
            href={segment.href}
            aria-current={segment.current ? "page" : undefined}
            className={`${SEGMENT} ${segment.current ? SEGMENT_ON : SEGMENT_OFF}`}
          >
            {segment.label}
            <span className="text-secondary-foreground tabular-nums">{segment.count}</span>
          </Link>
        ))}
      </nav>
      <form action="/decisions" method="get" className="flex w-full gap-2 md:ml-auto md:w-auto">
        {view.search.decision !== null ? (
          <input type="hidden" name="decision" value={view.search.decision} />
        ) : null}
        <label htmlFor="decisions-q" className="sr-only">
          {DECISIONS_COPY.searchLabel}
        </label>
        <input
          id="decisions-q"
          name="q"
          type="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          defaultValue={view.search.q}
          placeholder={DECISIONS_COPY.searchPlaceholder}
          className={`${INPUT} ${INPUT_HEIGHT.toolbar} md:w-72`}
        />
        <button type="submit" className={button("secondary", "md", { icon: "leading" })}>
          <Search size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
          {DECISIONS_COPY.search}
        </button>
      </form>
    </div>
  );
}

function Row({ row }: { row: DecisionListRow }) {
  const when = (
    <td className={`${TD} whitespace-nowrap`}>
      <Link href={row.href} title={row.at} className={LINK}>
        {row.when}
        <span className="sr-only">{`, decision ${row.seq}`}</span>
      </Link>
    </td>
  );
  if (!row.readable) {
    return (
      <tr className={TR}>
        {when}
        <td colSpan={4} className={TD} />
        <td className={`${TD} min-w-64`}>
          <span className="block text-primary-foreground">{row.why.words}</span>
          <span className={SUB_LINE}>{row.problem}</span>
        </td>
        <td colSpan={2} className={TD} />
      </tr>
    );
  }
  return (
    <tr className={TR}>
      {when}
      <td className={TD}>
        <span className="block whitespace-nowrap text-primary-foreground">
          {row.sender ?? DECISIONS_COPY.noTicket}
        </span>
        {row.claim !== null ? (
          <span className={`${SUB_LINE} whitespace-nowrap`}>{row.claim}</span>
        ) : null}
      </td>
      <td className={`${TD} whitespace-nowrap`}>{row.action}</td>
      <td className={`${TD} ${NUMBER}`}>{row.amount}</td>
      <td className={TD}>
        <Badge tone={row.decision.tone}>{row.decision.label}</Badge>
      </td>
      <td className={`${TD} min-w-64`}>
        <span className="block text-primary-foreground">{row.why.words}</span>
        {row.why.code !== null ? (
          <span className="mt-0.5 block">
            <Code>{row.why.code}</Code>
          </span>
        ) : null}
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        {row.status === null ? null : row.status.href !== null ? (
          <Link href={row.status.href} className={LINK}>
            {row.status.words}
          </Link>
        ) : (
          row.status.words
        )}
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        <span className={MONO}>{row.record}</span>
      </td>
    </tr>
  );
}

function DecisionTable({ view }: { view: DecisionsView }) {
  return (
    <>
      <div data-graphite="table" className={TABLE_CARD}>
        <Toolbar view={view} />
        {view.empty !== null ? (
          <p className={`${DESCRIPTION} px-5 py-6`}>{view.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th scope="col" className={TH}>
                    When
                  </th>
                  <th scope="col" className={TH}>
                    Ticket
                  </th>
                  <th scope="col" className={TH}>
                    Action
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Amount
                  </th>
                  <th scope="col" className={TH}>
                    Decision
                  </th>
                  <th scope="col" className={TH}>
                    Why
                  </th>
                  <th scope="col" className={TH}>
                    Status
                  </th>
                  <th scope="col" className={TH}>
                    Record
                  </th>
                </tr>
              </thead>
              <tbody className={TABLE_BODY}>
                {view.rows.map((row) => (
                  <Row key={row.seq} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {view.olderHref !== null ? (
        <Link
          href={view.olderHref}
          className={`${button("secondary", "md", { icon: "leading" })} self-start`}
        >
          <ChevronLeft size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
          {DECISIONS_COPY.older}
        </Link>
      ) : null}
    </>
  );
}

export default async function DecisionsPage({ searchParams }: PageProps<"/decisions">) {
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

  const filters = decisionFiltersOf(await searchParams);
  const deps = { env: process.env };
  const [rows, verify] = await Promise.all([
    loadDecisions(key, filters, deps),
    loadVerify(key, deps),
  ]);
  if ((!rows.ok && rows.status === 401) || (!verify.ok && verify.status === 401)) {
    return signIn(APPROVAL_ROUTE_MESSAGES.signInAgain);
  }
  const now = new Date();
  const view = rows.ok ? decisionsView(rows.value, filters, now) : null;
  return (
    <ConsoleShell>
      <Page>
        <PageHeader title={DECISIONS_COPY.title} description={DECISIONS_COPY.subtitle} />
        <div className={STACK}>
          <ChainCard chain={chainView(verify, now)} />
          {view !== null ? (
            <DecisionTable view={view} />
          ) : (
            <Notice>{rows.ok ? null : rows.message}</Notice>
          )}
        </div>
      </Page>
    </ConsoleShell>
  );
}
