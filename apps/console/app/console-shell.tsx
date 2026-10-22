import "server-only";
import { ShieldCheck } from "lucide-react";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { approverKeyFromHeader, loadApprovals } from "../src/approval-routes";
import { ConsoleNav } from "./console-nav";
import { ThemeControl } from "./theme-control";

// The app frame (DESIGN.md's layout model): the sidebar sits on the shell, and the page is one
// container panel inset 8px. On a phone the sidebar becomes a row above the panel.

// A sidebar count shouldn't hold up a page for long when the gate is slow.
const COUNT_TIMEOUT_MS = 2_000;

/** The number of open approval cards, or null when the approver isn't signed in or it can't be read. */
async function openApprovalCount(): Promise<number | null> {
  const key = approverKeyFromHeader((await headers()).get("cookie"));
  if (key === null) return null;
  const answer = await loadApprovals(key, { env: process.env, timeoutMs: COUNT_TIMEOUT_MS });
  return answer.ok ? answer.value.open.length : null;
}

export async function ConsoleShell({
  children,
  openApprovals,
}: {
  children: ReactNode;
  /** The open-card count when the page has already read it; otherwise the shell reads it. */
  openApprovals?: number | null;
}) {
  const count = openApprovals === undefined ? await openApprovalCount() : openApprovals;
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-row items-center gap-2 px-4 pt-3 pb-1 md:w-60 md:flex-col md:items-stretch md:gap-4 md:p-4">
        <div className="flex h-8 items-center gap-2 px-2 text-body-sm font-semibold">
          <ShieldCheck
            size={16}
            strokeWidth={1.5}
            className="text-secondary-foreground"
            aria-hidden="true"
          />
          {/* On a phone the sidebar is one row, so the name gives way to the links. */}
          <span className="sr-only md:not-sr-only">Countersign</span>
        </div>
        <ConsoleNav openApprovals={count} />
        <div className="ml-auto md:mt-auto md:ml-0">
          <ThemeControl />
        </div>
      </aside>
      <main className="m-2 flex min-w-0 flex-1 flex-col rounded-2xl bg-container shadow-border md:ml-0">
        {children}
      </main>
    </div>
  );
}
