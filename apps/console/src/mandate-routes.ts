import { z } from "zod";
import {
  type Answer,
  type ApprovalDeps,
  callGate,
  readBody,
  readJson,
  refusalOf,
  refuse,
  unreachable,
  withSignIn,
} from "./approval-routes";
import { type Replay, ReplaySchema, type Signed, SignedSchema } from "./mandate-editor";

// `POST /api/mandate/replay` and `POST /api/mandate/sign` (PLAN E2): the console's way to the
// gate's mandate API, behind the approvals sign-in, with the cookie's key as the bearer. The body
// is read with zod before it leaves and the gate's answer is parsed before it's passed on. The
// gate checks the draft again, replays the audit log's decisions with it (no AI), and signs it
// into the log; nothing here decides anything. The draft goes as it came from the compile route.

export const MANDATE_ROUTE_MESSAGES = {
  badReplay: "Send JSON with the draft mandate.",
  badSign: "Send JSON with the draft mandate and the base version's hash.",
} as const;

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const DraftShape = z.object({ id: z.string(), version: z.number().int().positive() }).loose();
export const ReplayRequestSchema = z.strictObject({ mandate: DraftShape });
export const SignRequestSchema = z.strictObject({ mandate: DraftShape, base_hash: Hash });

const GateMessage = z.object({ message: z.string().min(1) });

async function postGate<T>(
  deps: ApprovalDeps,
  key: string,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  accept: (status: number) => boolean,
): Promise<Answer<T>> {
  const response = await callGate(deps, key, path, { json: JSON.stringify(body) });
  if (response !== null && accept(response.status)) {
    const value = await readJson(response, schema);
    return value === null ? unreachable : { ok: true, value };
  }
  // A conflict (a stale base, or the version signed with other rules) carries the gate's sentence.
  if (response?.status === 409) {
    const message = await readJson(response, GateMessage);
    return message === null ? unreachable : refuse(409, message.message);
  }
  return refusalOf(response);
}

/** Replays the audit log's decisions under the mandate in force with the draft. */
export async function loadReplay(
  key: string,
  input: unknown,
  deps: ApprovalDeps,
): Promise<Answer<Replay>> {
  const body = ReplayRequestSchema.safeParse(input);
  if (!body.success) return refuse(400, MANDATE_ROUTE_MESSAGES.badReplay);
  const answer = await postGate(
    deps,
    key,
    "/mandates/replay",
    body.data,
    ReplaySchema,
    (s) => s === 200,
  );
  if (answer.ok && answer.value.draft.version !== body.data.mandate.version) return unreachable;
  return answer;
}

/** Signs the draft into the audit log as the next version. */
export async function sendSignature(
  key: string,
  input: unknown,
  deps: ApprovalDeps,
): Promise<Answer<Signed>> {
  const body = SignRequestSchema.safeParse(input);
  if (!body.success) return refuse(400, MANDATE_ROUTE_MESSAGES.badSign);
  const answer = await postGate(
    deps,
    key,
    "/mandates/sign",
    body.data,
    SignedSchema,
    (s) => s === 200 || s === 201,
  );
  if (answer.ok && answer.value.version !== body.data.mandate.version) return unreachable;
  return answer;
}

/** `POST /api/mandate/replay`. */
export function replayRoute(request: Request, deps: ApprovalDeps): Promise<Response> | Response {
  return withSignIn(request, deps, async (key) => loadReplay(key, await readBody(request), deps));
}

/** `POST /api/mandate/sign`. */
export function signRoute(request: Request, deps: ApprovalDeps): Promise<Response> | Response {
  return withSignIn(request, deps, async (key) =>
    sendSignature(key, await readBody(request), deps),
  );
}
