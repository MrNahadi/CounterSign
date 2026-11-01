import {
  type Answer,
  type ApprovalDeps,
  callGate,
  readJson,
  refusalOf,
  refusalResponse,
  refuse,
  unreachable,
  withKey,
  withSignIn,
} from "./approval-routes";
import { GateMessageSchema } from "./approval-schemas";
import {
  type ResetReport,
  ResetReportSchema,
  SCENARIO_BODY_LIMIT,
  type ScenarioAccepted,
  ScenarioAcceptedSchema,
  type ScenarioRequest,
  ScenarioRequestSchema,
} from "./demo-schemas";
import { callResolve, RESOLVE_UNREACHABLE, type ResolveDeps, readLimited } from "./resolve-routes";
import { ResolveMessageSchema } from "./resolve-schemas";
import { limitSession } from "./session-limits";

// The console's routes for the start page (ADR 0043): launch a scenario and reset the demo. Both
// are signed in with the approver key and counted against the session (brief §8). Resolve's and
// the gate's answers are parsed before they're passed on; anything else is one sentence and 502.

export const DEMO_ROUTE_MESSAGES = {
  badScenario: "Send JSON with scenario_id and mode.",
  resetOff: "The demo reset is off on this gate.",
} as const;

// A reset can take up to a minute (brief §11); the gate's own limits end it before this does.
export const RESET_TIMEOUT_MS = 120_000;

export type DemoRouteDeps = ResolveDeps & ApprovalDeps;

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const noService = refuse(502, RESOLVE_UNREACHABLE);

// The gate sends its own 502 and 503 sentences for a baseline launch; Resolve's are not passed on.
async function launched(
  response: Response | null,
  fromGate: boolean,
): Promise<Answer<ScenarioAccepted>> {
  if (response === null) return noService;
  if (response.status === 202) {
    const accepted = await readJson(response, ScenarioAcceptedSchema);
    return accepted === null ? noService : { ok: true, value: accepted };
  }
  const passed =
    response.status === 400 ||
    response.status === 404 ||
    response.status === 409 ||
    (fromGate && (response.status === 502 || response.status === 503));
  if (!passed) return noService;
  const refusal = await readJson(response, ResolveMessageSchema);
  if (refusal === null) return noService;
  return refuse(response.status as 400 | 404 | 409 | 502 | 503, refusal.message);
}

async function launch(
  key: string,
  request: ScenarioRequest,
  deps: DemoRouteDeps,
): Promise<Answer<ScenarioAccepted>> {
  if (request.mode === "baseline") {
    // The gate mints the token, so the key and the token never meet Resolve (ADR 0043).
    const response = await callGate(deps, key, "/baseline/launch", {
      json: JSON.stringify({ scenario_id: request.scenario_id }),
    });
    return launched(response, true);
  }
  const response = await callResolve(deps, `/scenarios/${request.scenario_id}`, {
    json: JSON.stringify({ mode: request.mode }),
  });
  return launched(response, false);
}

/** `POST /api/scenarios`: one demo scenario, started in protected mode or (through the gate) baseline. */
export async function scenarioRoute(request: Request, deps: DemoRouteDeps): Promise<Response> {
  const bad = refusalResponse(request, refuse(400, DEMO_ROUTE_MESSAGES.badScenario));
  let text: string | null;
  try {
    text = await readLimited(request, SCENARIO_BODY_LIMIT);
  } catch {
    return bad;
  }
  if (text === null) return bad;
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return bad;
  }
  const scenario = ScenarioRequestSchema.safeParse(input);
  if (!scenario.success) return bad;
  return withSignIn(
    request,
    deps,
    async (key) => limitSession(request, "run") ?? launch(key, scenario.data, deps),
    (req, answer) => (answer.ok ? json(202, answer.value) : refusalResponse(req, answer)),
  );
}

async function sendReset(key: string, deps: DemoRouteDeps): Promise<Answer<ResetReport>> {
  const response = await callGate({ ...deps, timeoutMs: RESET_TIMEOUT_MS }, key, "/demo/reset", {
    json: "{}",
  });
  if (response?.status === 200) {
    const report = await readJson(response, ResetReportSchema);
    return report === null ? unreachable : { ok: true, value: report };
  }
  if (response?.status === 404) return refuse(404, DEMO_ROUTE_MESSAGES.resetOff);
  if (response?.status === 409) {
    const refusal = await readJson(response, GateMessageSchema);
    return refusal === null ? unreachable : refuse(409, refusal.message);
  }
  return refusalOf(response);
}

/**
 * `POST /api/demo/reset`: the cookie's key goes to the gate's reset, which checks it, so there's no
 * check of our own. The session's limit comes right after the cookie.
 */
export function resetRoute(request: Request, deps: DemoRouteDeps): Promise<Response> | Response {
  return withKey(request, async (key) => limitSession(request, "reset") ?? sendReset(key, deps));
}
