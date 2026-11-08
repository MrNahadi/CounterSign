// The hosted baseline launch (ADR 0044): `POST /baseline/launch`, approver key only. The gate mints
// one sandbox access token and hands it to Resolve's `POST /scenarios/<id>` with the shared
// secret (PLAN.md F2), so Resolve needs no PayPal credential of its own. The token is never logged, stored or
// answered: the answer is rebuilt from Resolve's parsed body, which never holds it. No AI.

import type { PayPalClient } from "@countersign/rail-paypal";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { approverOnly } from "./approvals-api";
import type { Approver } from "./approver";
import { resolveAgentUrl, resolveSecretHeaders } from "./nudge";
import type { Environment } from "./principals";

export const BASELINE_LAUNCH_PATH = "/baseline/launch";
export const BASELINE_LAUNCH_BODY_LIMIT = "1kb";
export const LAUNCH_TIMEOUT_MS = 10_000;

export const BASELINE_LAUNCH_MESSAGES = {
  badBody: "Send JSON with scenario_id.",
  noResolve: "The gate can't reach Resolve, so baseline mode can't start.",
  noPayPal: "PayPal isn't set up on the gate, so baseline mode can't start.",
  noToken: "PayPal didn't issue a token. Try again in a minute.",
  resolveUnreachable: "Resolve couldn't be reached. Try again in a minute.",
} as const;

const LaunchBody = z.strictObject({ scenario_id: z.string().regex(/^[a-z0-9-]{1,40}$/) });

// What Resolve's scenario route answers. Anything else is treated as Resolve not being reached.
// Unknown keys are dropped, so only these fields are ever passed on.
const Accepted = z.object({
  ticket_id: z.string().regex(/^tkt_[0-9a-f]{32}$/),
  thread_id: z.string().regex(/^tkt_[0-9a-f]{32}$/),
  run_id: z.string().min(1).max(64),
});
const Refusal = z.object({ message: z.string().min(1).max(500) });
const PASSED_REFUSALS = new Set([400, 404, 409, 500, 503]);

export type BaselineLaunchDeps = {
  approver: Approver;
  rail: () => PayPalClient;
  env: Environment;
  fetch?: typeof fetch;
};

type Answer = { status: number; body: unknown };

const say = (status: number, message: string): Answer => ({ status, body: { message } });

// Resolve's answer, read in full within the timeout, then checked against the two shapes.
async function askResolve(
  send: typeof fetch,
  url: string,
  payload: string,
  secretHeaders: Record<string, string>,
): Promise<Answer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LAUNCH_TIMEOUT_MS);
  try {
    const response = await send(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...secretHeaders },
      body: payload,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    if (response.status === 202) {
      const accepted = Accepted.safeParse(json);
      return accepted.success ? { status: 202, body: accepted.data } : null;
    }
    if (!PASSED_REFUSALS.has(response.status)) return null;
    const refusal = Refusal.safeParse(json);
    return refusal.success ? { status: response.status, body: refusal.data } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function launchBaseline(deps: BaselineLaunchDeps, input: unknown): Promise<Answer> {
  const body = LaunchBody.safeParse(input);
  if (!body.success) return say(400, BASELINE_LAUNCH_MESSAGES.badBody);
  const base = resolveAgentUrl(deps.env);
  if (base === null) return say(503, BASELINE_LAUNCH_MESSAGES.noResolve);
  let rail: PayPalClient;
  try {
    rail = deps.rail();
  } catch {
    return say(503, BASELINE_LAUNCH_MESSAGES.noPayPal);
  }
  let issued: { accessToken: string; expiresAt: number };
  try {
    issued = await rail.issueAccessToken();
  } catch {
    return say(502, BASELINE_LAUNCH_MESSAGES.noToken);
  }
  const payload = JSON.stringify({
    mode: "baseline",
    paypal_token: { access_token: issued.accessToken, expires_at: issued.expiresAt },
  });
  const url = new URL(`/scenarios/${body.data.scenario_id}`, base).toString();
  const answer = await askResolve(
    deps.fetch ?? fetch,
    url,
    payload,
    resolveSecretHeaders(deps.env),
  );
  return answer ?? say(502, BASELINE_LAUNCH_MESSAGES.resolveUnreachable);
}

export function mountBaselineLaunch(app: Express, deps: BaselineLaunchDeps): void {
  app.post(
    BASELINE_LAUNCH_PATH,
    approverOnly(deps.approver),
    express.json({ limit: BASELINE_LAUNCH_BODY_LIMIT, strict: true }),
    async (req: Request, res: Response) => {
      const answer = await launchBaseline(deps, req.body).catch(() =>
        say(502, BASELINE_LAUNCH_MESSAGES.resolveUnreachable),
      );
      res.status(answer.status).json(answer.body);
    },
    // A body the JSON reader refused (not JSON, or over 1 KB). Never echoed.
    (_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(400).json({ message: BASELINE_LAUNCH_MESSAGES.badBody });
    },
  );
}
