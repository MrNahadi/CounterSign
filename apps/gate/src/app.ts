import type { Database } from "@countersign/db";
import type { PayPalClient } from "@countersign/rail-paypal";
import express, { type NextFunction, type Request, type Response } from "express";
import { ANSWERS, handlePayPalWebhook, WEBHOOK_BODY_LIMIT, type WebhookAnswer } from "./webhook";

export type AppDeps = {
  db?: Database;
  // Builds the rail client from the environment, never from a request. Called once, when first
  // needed; a factory that throws (PayPal's variables missing) is tried again next time.
  rail?: () => PayPalClient;
  env?: Readonly<Record<string, string | undefined>>;
  clock?: () => Date;
};

function send(res: Response, answer: WebhookAnswer): void {
  res.status(answer.status).json({ message: answer.message });
}

// The gate's HTTP surface. Later phases add /mcp, the approval API and Daraja callbacks.
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
  };

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
