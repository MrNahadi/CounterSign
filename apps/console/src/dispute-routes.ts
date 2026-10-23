import {
  type Answer,
  type ApprovalDeps,
  checkKey,
  readBody,
  refusalResponse,
  refuse,
  withKey,
} from "./approval-routes";
import { callResolve, RESOLVE_UNREACHABLE, readJson } from "./resolve-routes";
import {
  type DisputeDraft,
  DisputeDraftSchema,
  type DisputeList,
  DisputeListSchema,
  DraftRequestSchema,
  ResolveMessageSchema,
} from "./resolve-schemas";

// The console's way to Resolve's dispute drafts (ADR 0035, 0037), from server code only. They
// open with the approvals sign-in like Decisions, and the key is checked with the gate before
// Resolve is asked (ADR 0038); the key itself never goes to Resolve. Requests and answers are
// read with zod, and Resolve unreachable or answering junk is one sentence and 502.

export const DISPUTE_ROUTE_MESSAGES = {
  signInLine: "Sign in with the approver key to see disputes.",
  badRequest: "Send JSON with dispute_id, a PayPal dispute ID.",
} as const;

export type DisputeDeps = ApprovalDeps;

/** A draft as Resolve answered it, with its status: 202 for a new draft, 200 for a live one. */
export type Drafted = { status: 200 | 202; draft: DisputeDraft };

const resolveUnreachable = refuse(502, RESOLVE_UNREACHABLE);

/** Each dispute's latest draft, newest first, once the gate has taken the key. */
export async function loadDisputes(key: string, deps: DisputeDeps): Promise<Answer<DisputeList>> {
  const checked = await checkKey(key, deps);
  if (!checked.ok) return checked;
  const response = await callResolve(deps, "/disputes");
  if (response?.status !== 200) return resolveUnreachable;
  const list = await readJson(response, DisputeListSchema);
  return list === null ? resolveUnreachable : { ok: true, value: list };
}

/** Asks Resolve to draft a dispute again; Resolve answers the live draft if there is one. */
export async function draftAgain(
  key: string,
  input: unknown,
  deps: DisputeDeps,
): Promise<Answer<Drafted>> {
  const checked = await checkKey(key, deps);
  if (!checked.ok) return checked;
  const request = DraftRequestSchema.safeParse(input);
  if (!request.success) return refuse(400, DISPUTE_ROUTE_MESSAGES.badRequest);
  const response = await callResolve(deps, "/disputes", { json: JSON.stringify(request.data) });
  if (response?.status === 400) {
    const refusal = await readJson(response, ResolveMessageSchema);
    return refusal === null ? resolveUnreachable : refuse(400, refusal.message);
  }
  if (response?.status !== 200 && response?.status !== 202) return resolveUnreachable;
  const draft = await readJson(response, DisputeDraftSchema);
  if (draft === null || draft.dispute_id !== request.data.dispute_id) return resolveUnreachable;
  return { ok: true, value: { status: response.status, draft } };
}

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** `GET /api/disputes`. */
export function disputesRoute(request: Request, deps: DisputeDeps): Promise<Response> | Response {
  return withKey(request, (key) => loadDisputes(key, deps));
}

/** `POST /api/disputes` with `{ dispute_id }`: "Draft again". */
export function draftAgainRoute(request: Request, deps: DisputeDeps): Promise<Response> | Response {
  return withKey(
    request,
    async (key) => draftAgain(key, await readBody(request), deps),
    (req, answer) =>
      answer.ok ? json(answer.value.status, answer.value.draft) : refusalResponse(req, answer),
  );
}
