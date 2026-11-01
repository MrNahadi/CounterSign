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
import {
  button,
  DESCRIPTION,
  ICON,
  LINK,
  MONO,
  NUMBER,
  STACK,
  STROKE,
  TABLE,
  TABLE_BODY,
  TABLE_CARD,
  TABLE_HEAD_ROW,
  TD,
  TH,
  TOOLBAR,
  TR,
} from "../../src/controls";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { Badge, Card, Notice, Page, PageHeader } from "../ui";

// Every audit-log entry, newest first (ADR 0034), read on the server with the approver's cookie
// through the read-only audit API. The chain check runs when asked for, as a link to this page
// with `check=1`, so the page stays a server component. Built from Graphite's Table, Badge, Card
// and Button specs, through the shared recipes in `src/controls.ts`.

export const metadata: Metadata = { title: "Audit log · Countersign console" };
export const dynamic = "force-dynamic";

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
    <tr className={TR}>
      <td className={`${TD} ${NUMBER}`}>{row.seq}</td>
      <td className={`${TD} whitespace-nowrap`}>
        <time dateTime={row.at} title={row.at}>
          {row.when}
        </time>
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        <span className={MONO}>{row.type}</span>
      </td>
      <td className={`${TD} min-w-72`}>
        {row.href !== null ? (
          <Link href={row.href} className={LINK}>
            {row.summary}
          </Link>
        ) : (
          row.summary
        )}
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        <span className={MONO}>{row.ref}</span>
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        <Hash hash={row.hash} />
      </td>
    </tr>
  );
}

function Verdict({ view }: { view: NonNullable<AuditView["verdict"]> }) {
  return (
    <Card as="section" aria-label="Chain check" role="status" gap="tight">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
    </Card>
  );
}

function EntryTable({ view }: { view: AuditView }) {
  return (
    <>
      <div data-graphite="table" className={TABLE_CARD}>
        <div data-graphite="toolbar" className={TOOLBAR}>
          <Link href={view.checkHref} className={button("secondary", "md", { icon: "leading" })}>
            <ShieldCheck size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
            {AUDIT_COPY.check}
          </Link>
          <p className={`${DESCRIPTION} flex h-8 items-center`}>{view.total}</p>
        </div>
        {view.empty !== null ? (
          <p className={`${DESCRIPTION} px-5 py-6`}>{view.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th scope="col" className={`${TH} text-right`}>
                    Seq
                  </th>
                  <th scope="col" className={TH}>
                    When
                  </th>
                  <th scope="col" className={TH}>
                    Type
                  </th>
                  <th scope="col" className={TH}>
                    Summary
                  </th>
                  <th scope="col" className={TH}>
                    Ref
                  </th>
                  <th scope="col" className={TH}>
                    Hash
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
          {AUDIT_COPY.older}
        </Link>
      ) : null}
    </>
  );
}

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
      <Page>
        <PageHeader title={AUDIT_COPY.title} description={AUDIT_COPY.subtitle} />
        <div className={STACK}>
          {view !== null ? (
            <>
              {view.verdict !== null ? <Verdict view={view.verdict} /> : null}
              <EntryTable view={view} />
            </>
          ) : (
            <Notice>{entries.ok ? null : entries.message}</Notice>
          )}
        </div>
      </Page>
    </ConsoleShell>
  );
}
