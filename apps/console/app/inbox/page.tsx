import "server-only";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { approverKeyFromHeader } from "../../src/approval-routes";
import { button, DESCRIPTION, ICON, STROKE } from "../../src/controls";
import { listIsWorking, POLL_INTERVAL_MS, threadListItems, threadView } from "../../src/inbox-view";
import { INBOX_SIGN_IN, inboxAccess, loadThread, loadThreads } from "../../src/resolve-routes";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { Notice, Page } from "../ui";
import { InboxHeader } from "./inbox-header";
import { ThreadDetail, ThreadList } from "./inbox-parts";
import { RefreshWhileWorking } from "./refresh-while-working";

// The merchant's inbox: simulated customer threads, Resolve's replies and what Resolve did.
// Read from Resolve on the server at each render; a working run re-renders it every 2 seconds.
// The page scrolls as a whole: from 768px up the 360px thread list sits beside the thread, and
// below it one pane shows at a time.

export const metadata: Metadata = { title: "Inbox · Countersign console" };
export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: PageProps<"/inbox">) {
  const { thread } = await searchParams;
  const selectedId = typeof thread === "string" ? thread : null;
  const deps = { env: process.env };
  const access = await inboxAccess(approverKeyFromHeader((await headers()).get("cookie")), deps);
  if (access.state === "signed-out") {
    return (
      <ConsoleShell openApprovals={null}>
        <SignIn title={INBOX_SIGN_IN.title} line={INBOX_SIGN_IN.line} message={access.message} />
      </ConsoleShell>
    );
  }
  if (access.state === "unreachable") {
    return (
      <ConsoleShell>
        <Page>
          <Notice>{access.message}</Notice>
        </Page>
      </ConsoleShell>
    );
  }
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
      <Page>
        <InboxHeader />
        {list.ok ? (
          <div className="flex min-h-0 flex-1 flex-col gap-6 md:flex-row md:gap-0">
            <div
              className={`md:w-90 md:shrink-0 md:pr-6 ${selectedId === null ? "" : "hidden md:block"}`}
            >
              <ThreadList items={threadListItems(list.value, { now, selectedId })} />
            </div>
            <div aria-hidden="true" className="hidden w-px bg-border-default md:block" />
            <div
              className={`min-w-0 flex-1 md:pl-8 ${selectedId === null ? "hidden md:block" : ""}`}
            >
              {selectedId !== null ? (
                <Link
                  href="/inbox"
                  className={`${button("transparent", "md", { icon: "leading" })} -ml-2.5 mb-5 md:hidden`}
                >
                  <ArrowLeft size={ICON.md} strokeWidth={STROKE(ICON.md)} aria-hidden="true" />
                  All threads
                </Link>
              ) : null}
              {detail === null ? (
                <p className={DESCRIPTION}>Pick a thread to read it and see what Resolve did.</p>
              ) : detail.ok && view !== null ? (
                <ThreadDetail view={view} />
              ) : (
                <Notice>{detail.ok ? null : detail.message}</Notice>
              )}
            </div>
          </div>
        ) : (
          <Notice>{list.message}</Notice>
        )}
      </Page>
    </ConsoleShell>
  );
}
