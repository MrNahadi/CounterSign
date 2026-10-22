import "server-only";
import { ChevronLeft, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../src/approval-routes";
import { AUDIT_ROUTE_MESSAGES, loadEntries, loadVerify } from "../../src/audit-routes";
import {
  AUDIT_COPY,
  type AuditView,
  auditParamsOf,
  auditView,
  type EntryRow,
} from "../../src/audit-view";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { Badge, Notice } from "../ui";

// Every audit-log entry, newest first (ADR 0034), read on the server with the approver's cookie
// through the read-only audit API. The chain check runs when asked for, as a link to this page
// with `check=1`, so the page stays a server component. Built from Graphite's Table, Badge and
// Button specs.

export const metadata: Metadata = { title: "Audit log · Countersign console" };
export const dynamic = "force-dynamic";

const LINK = "font-medium text-brand-foreground hover:underline";
const BUTTON =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-body-sm font-medium motion-safe:transition motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.97]";
const SECONDARY = `${BUTTON} bg-component-on-container-strong text-primary-foreground shadow-default hover:bg-component-on-container-strong-hover`;
const HEAD =
  "h-8 px-3 text-left align-middle text-caption-base font-medium tracking-caption-upper whitespace-nowrap text-tertiary-foreground uppercase";
const CELL = "h-10 px-3 py-2 align-top";
const MONO = "font-mono text-code-xs";

function Hash({ hash }: { hash: EntryRow["hash"] }) {
  return (
    <span title={hash.full} className={MONO}>
      <span aria-hidden="true">{hash.short}</span>
      <span className="sr-only">{hash.full}</span>
    </span>
  );
}

function Row({ row }: { row: EntryRow }) {
  return (
    <tr className="hover:bg-transparent-hover">
      <td className={`${CELL} tabular-nums whitespace-nowrap`}>{row.seq}</td>
      <td className={`${CELL} whitespace-nowrap`}>
        <time dateTime={row.at} title={row.at}>
          {row.when}
        </time>
      </td>
      <td className={`${CELL} whitespace-nowrap`}>
        <span className={MONO}>{row.type}</span>
      </td>
      <td className={`${CELL} min-w-64`}>
        {row.href !== null ? (
          <Link href={row.href} className={LINK}>
            {row.summary}
          </Link>
        ) : (
          row.summary
        )}
      </td>
      <td className={`${CELL} ${MONO} whitespace-nowrap`}>{row.ref}</td>
      <td className={`${CELL} whitespace-nowrap`}>
        <Hash hash={row.hash} />
      </td>
    </tr>
  );
}

function Verdict({ view }: { view: NonNullable<AuditView["verdict"]> }) {
  return (
    <section
      aria-label="Chain check"
      role="status"
      className="flex flex-col gap-2 rounded-2xl p-4 shadow-border"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={view.tone}>
          {view.tone === "positive" ? "Intact" : view.tone === "danger" ? "Broken" : "Not checked"}
        </Badge>
        <p className="min-w-0 text-body-sm break-all text-primary-foreground">{view.heading}</p>
      </div>
      {view.problems.length > 0 ? (
        <ul className="flex flex-col gap-1 text-body-sm text-secondary-foreground">
          {view.problems.map((problem) => (
            <li key={`${problem.seq}-${problem.code}`}>
              <span className={MONO}>{`#${problem.seq}`}</span>{" "}
              <span className={MONO}>{problem.code}</span> {problem.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function EntryTable({ view }: { view: AuditView }) {
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
                Seq
              </th>
              <th scope="col" className={HEAD}>
                When
              </th>
              <th scope="col" className={HEAD}>
                Type
              </th>
              <th scope="col" className={HEAD}>
                Summary
              </th>
              <th scope="col" className={HEAD}>
                Ref
              </th>
              <th scope="col" className={HEAD}>
                Hash
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
          {AUDIT_COPY.older}
        </Link>
      ) : null}
    </div>
  );
}

const COLUMN = "flex w-full flex-col gap-6 px-4 pt-5 pb-8 md:px-6";

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const key = approverKeyFromHeader((await headers()).get("cookie"));
  const signIn = (message: string | null) => (
    <ConsoleShell openApprovals={null}>
      <SignIn title={AUDIT_COPY.title} line={AUDIT_ROUTE_MESSAGES.signInLine} message={message} />
    </ConsoleShell>
  );
  if (key === null) return signIn(null);

  const params = auditParamsOf(await searchParams);
  const deps = { env: process.env };
  const [entries, verify] = await Promise.all([
    loadEntries(key, params.before === undefined ? {} : { before: params.before }, deps),
    params.check ? loadVerify(key, deps) : Promise.resolve(null),
  ]);
  if (
    (!entries.ok && entries.status === 401) ||
    (verify !== null && !verify.ok && verify.status === 401)
  ) {
    return signIn(APPROVAL_ROUTE_MESSAGES.signInAgain);
  }
  const view = entries.ok ? auditView(entries.value, verify, new Date()) : null;
  return (
    <ConsoleShell>
      <div className={COLUMN}>
        <header className="flex flex-col gap-1">
          <h1 className="text-heading-6 font-semibold tracking-heading">{AUDIT_COPY.title}</h1>
          <p className="text-body-sm text-secondary-foreground">{AUDIT_COPY.subtitle}</p>
        </header>
        {view !== null ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Link href={view.checkHref} className={SECONDARY}>
                <ShieldCheck size={16} strokeWidth={1.5} aria-hidden="true" />
                {AUDIT_COPY.check}
              </Link>
              <p className="text-body-sm text-secondary-foreground">{view.total}</p>
            </div>
            {view.verdict !== null ? <Verdict view={view.verdict} /> : null}
            <EntryTable view={view} />
          </>
        ) : (
          <Notice>{entries.ok ? null : entries.message}</Notice>
        )}
      </div>
    </ConsoleShell>
  );
}
