import "server-only";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { listIsWorking, POLL_INTERVAL_MS, threadListItems, threadView } from "../../src/inbox-view";
import { loadThread, loadThreads } from "../../src/resolve-routes";
import { ConsoleShell } from "../console-shell";
import { Notice, ThreadDetail, ThreadList } from "./inbox-parts";
import { RefreshWhileWorking } from "./refresh-while-working";

// The merchant's inbox: simulated customer threads, Resolve's replies and what Resolve did.
// Read from Resolve on the server at each render; a working run re-renders it every 2 seconds.

export const metadata: Metadata = { title: "Inbox · Countersign console" };
export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const { thread } = await searchParams;
  const selectedId = typeof thread === "string" ? thread : null;
  const deps = { env: process.env };
  const now = new Date();
  const [list, detail] = await Promise.all([
    loadThreads(deps),
    selectedId === null ? Promise.resolve(null) : loadThread(selectedId, deps),
  ]);
  const view = detail?.ok ? threadView(detail.value, { now }) : null;
  const working = (list.ok && listIsWorking(list.value)) || (view?.working ?? false);

  return (
    <ConsoleShell>
      <RefreshWhileWorking active={working} intervalMs={POLL_INTERVAL_MS} />
      <header className="flex items-center gap-3 px-6 pt-5 pb-4">
        <h1 className="text-heading-6 font-semibold tracking-heading">Inbox</h1>
      </header>
      {list.ok ? null : (
        <div className="px-6 pb-6">
          <Notice>{list.message}</Notice>
        </div>
      )}
      {list.ok ? (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div
            className={`md:w-80 md:shrink-0 md:overflow-y-auto ${selectedId === null ? "" : "hidden md:block"}`}
          >
            <ThreadList items={threadListItems(list.value, { now, selectedId })} />
          </div>
          <div aria-hidden="true" className="hidden w-px bg-border-default md:block" />
          <div
            className={`min-w-0 flex-1 px-4 pb-6 md:overflow-y-auto md:px-6 md:pt-2 ${selectedId === null ? "hidden md:block" : ""}`}
          >
            {selectedId !== null ? (
              <Link
                href="/inbox"
                className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-lg pr-2 text-body-sm font-medium text-secondary-foreground hover:text-primary-foreground md:hidden"
              >
                <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
                All threads
              </Link>
            ) : null}
            {detail === null ? (
              <p className="pt-2 text-body-sm text-secondary-foreground">
                Pick a thread to read it and see what Resolve did.
              </p>
            ) : detail.ok && view !== null ? (
              <ThreadDetail view={view} />
            ) : (
              <Notice>{detail.ok ? null : detail.message}</Notice>
            )}
          </div>
        </div>
      ) : null}
    </ConsoleShell>
  );
}
