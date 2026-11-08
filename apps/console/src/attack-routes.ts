import { type Answer, refusalResponse, refuse, withSignIn } from "./approval-routes";
import {
  ATTACK_COPY,
  type AttackRecords,
  AttackRequestSchema,
  type AttackView,
  attackView,
  guardedSteps,
  latestRun,
  toMessageRequest,
} from "./attack";
import { type AuditDeps, loadDecision, loadIntentDecision } from "./audit-routes";
import {
  BAD_MESSAGE,
  loadThread,
  MESSAGE_TOO_LARGE,
  type RouteDeps,
  readLimited,
  sendToResolve,
} from "./resolve-routes";
import { limitSession } from "./session-limits";

// The attack page's server side (ADR 0043's "Attack it yourself"): `POST /api/attack` sends a
// visitor's message to Resolve in protected mode, and `loadAttack` reads the thread back with the
// gate's records for each guarded call. Both open with the approvals sign-in, as every console
// route to Resolve does; a run counts against the session's limit. The mode never comes from the
// visitor. Nothing here decides anything: the gate's answers are only read back and shown.

/** A visitor's attack is text only, so its body is small. */
export const MAX_ATTACK_BYTES = 16 * 1024;

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** `POST /api/attack`: one visitor message, checked, then sent to Resolve in protected mode. */
export function attackRoute(request: Request, deps: RouteDeps): Promise<Response> | Response {
  return withAttackSignIn(request, deps, async () => {
    // Counted after the key is checked, before the body is read, as `POST /api/resolve/messages`.
    const limited = limitSession(request, "run");
    if (limited !== null) return limited;
    let text: string | null;
    try {
      text = await readLimited(request, MAX_ATTACK_BYTES);
    } catch {
      return refuse(400, BAD_MESSAGE);
    }
    if (text === null) return refuse(400, MESSAGE_TOO_LARGE);
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return refuse(400, BAD_MESSAGE);
    }
    const attack = AttackRequestSchema.safeParse(input);
    if (!attack.success) return refuse(400, BAD_MESSAGE);
    return sendToResolve(
      toMessageRequest({
        channel: attack.data.channel,
        senderEmail: attack.data.sender_email,
        body: attack.data.body,
      }),
      deps,
    );
  });
}

function withAttackSignIn<T>(
  request: Request,
  deps: RouteDeps,
  run: () => Promise<Answer<T>>,
): Promise<Response> | Response {
  return withSignIn(request, deps, run, (req, answer) =>
    answer.ok ? json(202, answer.value) : refusalResponse(req, answer),
  );
}

async function recordsOf(
  key: string,
  intentId: string | null,
  deps: AuditDeps,
): Promise<Answer<AttackRecords>> {
  if (intentId === null) return { ok: true, value: { kind: "no_intent" } };
  const intent = await loadIntentDecision(key, intentId, deps);
  if (!intent.ok) {
    return intent.status === 401 ? intent : { ok: true, value: { kind: "unread" } };
  }
  const detail = await loadDecision(key, String(intent.value.decision_seq), deps);
  if (!detail.ok) {
    return detail.status === 401 ? detail : { ok: true, value: { kind: "unread" } };
  }
  return { ok: true, value: { kind: "shown", detail: detail.value } };
}

/**
 * One attack's view: the thread from Resolve and, once its run is done, the gate's records for
 * each guarded call, read with the approver's key. A key the gate refuses is a 401; a record that
 * can't be read only says so on its card.
 */
export async function loadAttack(
  key: string,
  threadId: unknown,
  deps: RouteDeps,
): Promise<Answer<AttackView>> {
  const thread = await loadThread(threadId, deps);
  if (!thread.ok) {
    return thread.status === 404 ? refuse(404, ATTACK_COPY.noThread) : thread;
  }
  const records = new Map<string, AttackRecords>();
  const run = latestRun(thread.value);
  const done = run !== undefined && run.status !== "queued" && run.status !== "running";
  if (done) {
    const steps = guardedSteps(run);
    const answers = await Promise.all(steps.map(({ intentId }) => recordsOf(key, intentId, deps)));
    for (const [index, answer] of answers.entries()) {
      if (!answer.ok) return answer;
      const step = steps[index];
      if (step !== undefined) records.set(step.step.id, answer.value);
    }
  }
  return { ok: true, value: attackView(thread.value, records) };
}
