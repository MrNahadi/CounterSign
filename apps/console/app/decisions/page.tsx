import "server-only";
import { ChevronLeft, Search } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../src/approval-routes";
import { AUDIT_ROUTE_MESSAGES, loadDecisions, loadVerify } from "../../src/audit-routes";
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
import { Badge, Code, Notice } from "../ui";

// Every decision the gate recorded (ADR 0034), read on the server with the approver's cookie
// through the read-only audit API. Built from Graphite's Table, Badge, Card, Tabs (segmented
// control), Input and Button specs.

export const metadata: Metadata = { title: "Decisions · Countersign console" };
export const dynamic = "force-dynamic";

const LINK = "font-medium text-brand-foreground hover:underline";
const BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-body-sm font-medium motion-safe:transition motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.97]";
const SECONDARY = `${BUTTON} bg-component-on-container-strong text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover`;
const HEAD =
  "h-8 px-3 text-left align-middle text-caption-base font-medium tracking-caption-upper whitespace-nowrap text-tertiary-foreground uppercase";
const CELL = "h-10 px-3 py-2 align-top";

function Header() {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-heading-6 font-semibold tracking-heading">{DECISIONS_COPY.title}</h1>
      <p className="text-body-sm text-secondary-foreground">{DECISIONS_COPY.subtitle}</p>
    </header>
  );
}

function ChainCard({ chain }: { chain: ChainView }) {
  return (
    <section
      aria-label="Audit chain"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl p-4 shadow-border"
    >
      <Badge tone={chain.tone}>{chain.label}</Badge>
      <p className="text-body-sm text-secondary-foreground">{chain.line}</p>
      {chain.link !== null ? (
        <Link href={chain.link.href} className={`text-body-sm ${LINK}`}>
          {chain.link.label}
        </Link>
      ) : null}
    </section>
  );
}

function Toolbar({ view }: { view: DecisionsView }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      <nav
        aria-label={DECISIONS_COPY.filterLabel}
        className="inline-flex max-w-full shrink-0 self-start overflow-x-auto rounded-xl bg-sunken p-0.5"
      >
        {view.segments.map((segment) => (
          <Link
            key={segment.label}
            href={segment.href}
            aria-current={segment.current ? "page" : undefined}
            className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-body-sm font-medium motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out ${
              segment.current
                ? "bg-component-on-sunken text-primary-foreground shadow-default"
                : "text-secondary-foreground hover:text-primary-foreground"
            }`}
          >
            {segment.label}
            <span className="text-secondary-foreground tabular-nums">{segment.count}</span>
          </Link>
        ))}
      </nav>
      <form action="/decisions" method="get" className="flex w-full gap-2 md:ml-auto md:max-w-sm">
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
          className="h-8 min-w-0 flex-1 rounded-lg bg-component-on-container-strong px-2.5 text-body-sm text-primary-foreground shadow-default placeholder:text-tertiary-foreground"
        />
        <button type="submit" className={`${SECONDARY} pl-2.5`}>
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          {DECISIONS_COPY.search}
        </button>
      </form>
    </div>
  );
}

function Row({ row }: { row: DecisionListRow }) {
  const when = (
    <td className={`${CELL} whitespace-nowrap`}>
      <Link href={row.href} title={row.at} className={LINK}>
        {row.when}
        <span className="sr-only">{`, decision ${row.seq}`}</span>
      </Link>
    </td>
  );
  if (!row.readable) {
    return (
      <tr className="hover:bg-transparent-hover">
        {when}
        <td colSpan={4} className={CELL} />
        <td className={`${CELL} min-w-56`}>
          <span className="block text-primary-foreground">{row.why.words}</span>
          <span className="block text-secondary-foreground">{row.problem}</span>
        </td>
        <td colSpan={2} className={CELL} />
      </tr>
    );
  }
  return (
    <tr className="hover:bg-transparent-hover">
      {when}
      <td className={CELL}>
        <span className="block whitespace-nowrap text-primary-foreground">
          {row.sender ?? DECISIONS_COPY.noTicket}
        </span>
        {row.claim !== null ? (
          <span className="block whitespace-nowrap text-secondary-foreground">{row.claim}</span>
        ) : null}
      </td>
      <td className={`${CELL} whitespace-nowrap`}>{row.action}</td>
      <td className={`${CELL} text-right whitespace-nowrap tabular-nums`}>{row.amount}</td>
      <td className={CELL}>
        <Badge tone={row.decision.tone}>{row.decision.label}</Badge>
      </td>
      <td className={`${CELL} min-w-56`}>
        <span className="text-primary-foreground">{row.why.words}</span>
        {row.why.code !== null ? (
          <>
            {" "}
            <Code>{row.why.code}</Code>
          </>
        ) : null}
      </td>
      <td className={`${CELL} whitespace-nowrap`}>
        {row.status === null ? null : row.status.href !== null ? (
          <Link href={row.status.href} className={LINK}>
            {row.status.words}
          </Link>
        ) : (
          row.status.words
        )}
      </td>
      <td className={`${CELL} font-mono text-code-xs whitespace-nowrap`}>{row.record}</td>
    </tr>
  );
}

function DecisionTable({ view }: { view: DecisionsView }) {
  if (view.empty !== null) {
    return <p className="text-body-sm text-secondary-foreground">{view.empty}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-2xl shadow-border">
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border-default">
              <th scope="col" className={HEAD}>
                When
              </th>
              <th scope="col" className={HEAD}>
                Ticket
              </th>
              <th scope="col" className={HEAD}>
                Action
              </th>
              <th scope="col" className={`${HEAD} text-right`}>
                Amount
              </th>
              <th scope="col" className={HEAD}>
                Decision
              </th>
              <th scope="col" className={HEAD}>
                Why
              </th>
              <th scope="col" className={HEAD}>
                Status
              </th>
              <th scope="col" className={HEAD}>
                Record
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {view.rows.map((row) => (
              <Row key={row.seq} row={row} />
            ))}
          </tbody>
        </table>
      </div>
      {view.olderHref !== null ? (
        <Link href={view.olderHref} className={`${SECONDARY} self-start pl-2`}>
          <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          {DECISIONS_COPY.older}
        </Link>
      ) : null}
    </div>
  );
}

const COLUMN = "flex w-full flex-col gap-6 px-4 pt-5 pb-8 md:px-6";

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
      <div className={COLUMN}>
        <Header />
        <ChainCard chain={chainView(verify, now)} />
        {view !== null ? (
          <>
            <Toolbar view={view} />
            <DecisionTable view={view} />
          </>
        ) : (
          <Notice>{rows.ok ? null : rows.message}</Notice>
        )}
      </div>
    </ConsoleShell>
  );
}
