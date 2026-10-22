import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import {
  APPROVAL_ROUTE_MESSAGES,
  approverKeyFromHeader,
  loadApprovals,
} from "../../src/approval-routes";
import { APPROVALS_COPY, pageView } from "../../src/approvals-view";
import { approvalsUrl, qrView, requestOrigin } from "../../src/qr-view";
import { ConsoleShell } from "../console-shell";
import { SignIn } from "../sign-in";
import { ApprovalsBoard } from "./approvals-board";

// The approvals page (ADR 0032): read from the gate on the server with the approver's cookie, at
// each render. The board re-renders it every 3 seconds while it's open.

export const metadata: Metadata = { title: "Approvals · Countersign console" };
export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const requestHeaders = await headers();
  const key = approverKeyFromHeader(requestHeaders.get("cookie"));
  if (key === null) {
    return (
      <ConsoleShell openApprovals={null}>
        <SignIn title="Approvals" line={APPROVALS_COPY.signInLine} message={null} />
      </ConsoleShell>
    );
  }
  const answer = await loadApprovals(key, { env: process.env });
  if (!answer.ok && answer.status === 401) {
    return (
      <ConsoleShell openApprovals={null}>
        <SignIn
          title="Approvals"
          line={APPROVALS_COPY.signInLine}
          message={APPROVAL_ROUTE_MESSAGES.signInAgain}
        />
      </ConsoleShell>
    );
  }
  if (!answer.ok) {
    return (
      <ConsoleShell openApprovals={null}>
        <ApprovalsBoard view={null} problem={answer.message} />
      </ConsoleShell>
    );
  }
  const url = approvalsUrl({
    publicUrl: process.env.CONSOLE_PUBLIC_URL,
    origin: requestOrigin(requestHeaders),
  });
  const qr = url === null ? null : qrView(url);
  const view = pageView(answer.value, new Date());
  return (
    <ConsoleShell openApprovals={view.openCount}>
      <ApprovalsBoard view={view} problem={null} qr={qr} />
    </ConsoleShell>
  );
}
