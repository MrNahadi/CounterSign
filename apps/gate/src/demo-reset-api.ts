// The demo reset over HTTP (ADR 0042): `POST /demo/reset`, approver key only, checked before
// anything else. No body is read. The route exists only when the gate runs with
// COUNTERSIGN_DEMO_RESET=on (see `app.ts`); otherwise Express answers 404. No AI.

import type { Express, Request, Response } from "express";
import { approverOnly } from "./approvals-api";
import type { Approver } from "./approver";
import { RESET_MESSAGES, type ResetDeps, type ResetReport, resetDemo } from "./demo-reset";

export const DEMO_RESET_PATH = "/demo/reset";

export type DemoResetRouteDeps = { approver: Approver } & ResetDeps;

// The report as the API shows it: snake_case, as requirements.md lays it out.
export function reportView(report: ResetReport) {
  const { cleared, disputes } = report;
  return {
    complete: report.complete,
    reset_at: report.resetAt,
    took_ms: report.tookMs,
    orders: {
      kept: report.orders.kept,
      replaced: report.orders.replaced,
      run_id: report.orders.runId,
      failed: report.orders.failed.map(({ orderNumber, call, reason }) => ({
        order_number: orderNumber,
        call,
        reason,
      })),
    },
    cleared:
      cleared === null
        ? null
        : {
            previous_head: cleared.previousHead,
            entries: cleared.entries,
            tickets: cleared.tickets,
            attachments: cleared.attachments,
            runs: cleared.runs,
            drafts: cleared.drafts,
            documents: cleared.documents,
          },
    disputes:
      disputes === null
        ? null
        : "error" in disputes
          ? { error: disputes.error }
          : {
              recorded: disputes.recorded,
              already_recorded: disputes.alreadyRecorded,
              problems: disputes.problems,
            },
  };
}

export function mountDemoReset(app: Express, deps: DemoResetRouteDeps): void {
  const { approver, ...reset } = deps;
  app.post(DEMO_RESET_PATH, approverOnly(approver), async (_req: Request, res: Response) => {
    try {
      const result = await resetDemo(reset);
      if (result.ok) {
        res.status(200).json(reportView(result.report));
      } else {
        res.status(result.status).json({ message: result.message });
      }
    } catch {
      // resetDemo answers its own failures; this is the last guard, and says nothing about why.
      res.status(503).json({ message: RESET_MESSAGES.notCleared });
    }
  });
}
