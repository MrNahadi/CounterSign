import {
  type CarrierAdapter,
  createDatabaseShipmentStore,
  createMockCarrier,
} from "@countersign/carrier-mock";
import type { Database } from "@countersign/db";
import type { PayPalClient } from "@countersign/rail-paypal";
import express, { type NextFunction, type Request, type Response } from "express";
import { mountApprovals } from "./approvals-api";
import { approverLines, loadApprover } from "./approver";
import { mountAudit } from "./audit-api";
import { mountMcp } from "./mcp";
import type { NudgeFetch } from "./nudge";
import { loadPrincipals, MIN_KEY_LENGTH, PRINCIPAL_LABELS, type Principals } from "./principals";
import { ANSWERS, handlePayPalWebhook, WEBHOOK_BODY_LIMIT, type WebhookAnswer } from "./webhook";

export type AppDeps = {
  db?: Database;
  // Builds the rail client from the environment, never from a request. Called once, when first
  // needed; a factory that throws (PayPal's variables missing) is tried again next time.
  rail?: () => PayPalClient;
  // The carrier the guarded tools read shipments from. Defaults to the carrier mock over `db`.
  carrier?: CarrierAdapter;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: () => Date;
  // The principals, for tests. Defaults to the keys in `env` and each principal's mandate.
  principals?: Principals;
  // Where startup lines go. Never given a secret's value.
  log?: (line: string) => void;
  // The dispute nudge's way to Resolve, for tests. Defaults to the global fetch.
  fetch?: NudgeFetch;
};

// The startup lines about principal keys and the mandate: variable names only, never values.
export function principalLines(principals: Principals): string[] {
  const lines: string[] = [];
  const { unset, mandateProblems } = principals;
  if (unset.length > 0) {
    const keys = unset.length === 1 ? "Principal key" : "Principal keys";
    lines.push(
      `${keys} unset: ${unset.join(", ")} (needs ${MIN_KEY_LENGTH} or more characters, and no two principal keys may be the same). /mcp answers 401 for ${unset.length === 1 ? "it" : "them"}.`,
    );
  }
  for (const { principal, problem } of mandateProblems) {
    lines.push(
      `The ${PRINCIPAL_LABELS[principal]}'s mandate didn't load, so /mcp answers 401 for ${principal}: ${problem}`,
    );
  }
  return lines;
}

function send(res: Response, answer: WebhookAnswer): void {
  res.status(answer.status).json({ message: answer.message });
}

// The gate's HTTP surface: health, /mcp, the approval and audit APIs and the PayPal webhook. Later phases
// add Daraja callbacks.
// Every dependency is optional, so /health works with none.
export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  let rail: PayPalClient | undefined;
  const factory = deps.rail;
  const railOnce =
    factory &&
    (() => {
      rail ??= factory();
      return rail;
    });
  const webhookDeps = {
    ...(deps.db ? { db: deps.db } : {}),
    ...(railOnce ? { rail: railOnce } : {}),
    env: deps.env ?? {},
    clock: deps.clock ?? (() => new Date()),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };

  const principals = deps.principals ?? loadPrincipals({ env: webhookDeps.env });
  for (const line of principalLines(principals)) deps.log?.(line);
  const carrier =
    deps.carrier ?? (deps.db ? createMockCarrier(createDatabaseShipmentStore(deps.db)) : undefined);
  mountMcp(app, {
    principals,
    ...(deps.db ? { db: deps.db } : {}),
    ...(railOnce ? { rail: railOnce } : {}),
    ...(carrier ? { carrier } : {}),
    clock: webhookDeps.clock,
  });

  const approver = loadApprover(webhookDeps.env);
  for (const line of approverLines(approver)) deps.log?.(line);
  mountApprovals(app, {
    approver,
    ...(deps.db ? { db: deps.db } : {}),
    ...(railOnce ? { rail: railOnce } : {}),
    mandates: principals.mandates,
    clock: webhookDeps.clock,
  });
  mountAudit(app, {
    approver,
    ...(deps.db ? { db: deps.db } : {}),
    mandates: principals.mandates,
    clock: webhookDeps.clock,
  });

  // The body is read raw, whatever its content type, so the signature is checked over the
  // exact bytes PayPal signed.
  app.post(
    "/webhooks/paypal",
    express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT, inflate: false }),
    async (req: Request, res: Response) => {
      const answer = await handlePayPalWebhook(
        { headers: req.headers, body: req.body },
        webhookDeps,
      ).catch(() => ANSWERS.unavailable);
      send(res, answer);
    },
    // A body the raw reader refused: too large, compressed, or cut short. Never echoed.
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const status = (error as { status?: unknown } | null)?.status;
      send(res, status === 413 ? ANSWERS.tooLarge : ANSWERS.badRequest);
    },
  );
  return app;
}
