import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { APPROVAL_ROUTE_MESSAGES, approverKeyFromHeader } from "../../../../src/approval-routes";
import { AUDIT_ROUTE_MESSAGES, loadIntentDecision } from "../../../../src/audit-routes";
import { LINK } from "../../../../src/controls";
import { intentPageOf } from "../../../../src/decision-view";
import { DECISIONS_COPY } from "../../../../src/decisions-view";
import { ConsoleShell } from "../../../console-shell";
import { SignIn } from "../../../sign-in";
import { Notice, Page } from "../../../ui";

// An intent's decision (ADR 0034): the inbox links here, and this redirects to the intent's
// newest decision entry.

export const metadata: Metadata = { title: "Decision · Countersign console" };
export const dynamic = "force-dynamic";

export default async function IntentDecisionPage({ params }: PageProps<"/decisions/intent/[id]">) {
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

  const { id } = await params;
  const outcome = intentPageOf(await loadIntentDecision(key, id, { env: process.env }));
  if (outcome.kind === "redirect") redirect(outcome.href);
  if (outcome.kind === "sign_in") return signIn(APPROVAL_ROUTE_MESSAGES.signInAgain);
  return (
    <ConsoleShell>
      <Page>
        {outcome.kind === "not_found" ? (
          <div className="flex flex-col gap-2">
            <p className="text-body-sm text-primary-foreground">{outcome.view.message}</p>
            <Link href={outcome.view.link.href} className={`self-start text-body-sm ${LINK}`}>
              {outcome.view.link.label}
            </Link>
          </div>
        ) : (
          <Notice>{outcome.message}</Notice>
        )}
      </Page>
    </ConsoleShell>
  );
}
