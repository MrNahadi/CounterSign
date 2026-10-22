import type { z } from "zod";
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
} from "./approval-routes";
import {
  type ChainVerdict,
  ChainVerdictSchema,
  type DecisionDetail,
  DecisionDetailSchema,
  DecisionQuerySchema,
  type DecisionRowsPage,
  DecisionRowsPageSchema,
  DecisionSeqSchema,
  type EntryPage,
  EntryPageSchema,
  EntryQuerySchema,
  EvidenceHeadSchema,
  type ExportScope,
  ExportScopeSchema,
  type IntentDecision,
  IntentDecisionSchema,
  IntentIdSchema,
} from "./audit-schemas";

// The console's way to the gate's read-only audit API (ADR 0034), from server code only. Each
// request is read with zod before it leaves, the approvals cookie's key goes as the bearer, and
// every answer is parsed so only what the schemas allow is passed on. Signed out, a refused key,
// an unreachable gate and junk behave as the approval routes do. Nothing here writes anything.
// Plain Web APIs only, so a client component can import the sentences.

export const AUDIT_ROUTE_MESSAGES = {
  signInLine: "Sign in with the approver key to see decisions.",
  badQuery: "One of the query parameters isn't valid.",
  badSeq: "A decision is named by its entry number.",
  badIntent: "That isn't an intent ID.",
  badExport: "Ask for exactly one of intent or capture, with a valid ID.",
} as const;

export type AuditDeps = ApprovalDeps;

export type EvidenceDownload = { filename: string; body: string };

const badQuery = refuse(400, AUDIT_ROUTE_MESSAGES.badQuery);

/**
 * A request's query parameters as an object for a strict schema. A parameter given twice becomes
 * an array, so it fails the schema rather than one value being picked.
 */
export function queryOf(request: Request): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  let params: URLSearchParams;
  try {
    params = new URL(request.url).searchParams;
  } catch {
    return query;
  }
  for (const [name, value] of params) {
    const seen = query[name];
    query[name] = seen === undefined ? value : [...(Array.isArray(seen) ? seen : [seen]), value];
  }
  return query;
}

const isEmpty = (query: unknown) =>
  typeof query === "object" && query !== null && Object.keys(query).length === 0;

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, value);
  }
  const text = params.toString();
  return text === "" ? path : `${path}?${text}`;
}

async function getJson<T>(
  deps: AuditDeps,
  key: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<Answer<T>> {
  const response = await callGate(deps, key, path);
  if (response?.status !== 200) return refusalOf(response);
  const value = await readJson(response, schema);
  return value === null ? unreachable : { ok: true, value };
}

// --- Loaders, for routes and server components -----------------------------------------------

/** Decision rows, newest first, with counts and the next page's cursor. */
export async function loadDecisions(
  key: string,
  query: unknown,
  deps: AuditDeps,
): Promise<Answer<DecisionRowsPage>> {
  const filters = DecisionQuerySchema.safeParse(query);
  if (!filters.success) return badQuery;
  return getJson(deps, key, withQuery("/audit/decisions", filters.data), DecisionRowsPageSchema);
}

/** One decision by its entry's `seq`: the detail, or `readable: false` with its problem. */
export async function loadDecision(
  key: string,
  seq: unknown,
  deps: AuditDeps,
): Promise<Answer<DecisionDetail>> {
  const parsed = DecisionSeqSchema.safeParse(seq);
  if (!parsed.success) return refuse(400, AUDIT_ROUTE_MESSAGES.badSeq);
  const answer = await getJson(deps, key, `/audit/decisions/${parsed.data}`, DecisionDetailSchema);
  if (answer.ok && String(answer.value.seq) !== parsed.data) return unreachable;
  return answer;
}

/** The `seq` of an intent's newest decision. */
export async function loadIntentDecision(
  key: string,
  id: unknown,
  deps: AuditDeps,
): Promise<Answer<IntentDecision>> {
  const parsed = IntentIdSchema.safeParse(id);
  if (!parsed.success) return refuse(400, AUDIT_ROUTE_MESSAGES.badIntent);
  return getJson(deps, key, `/audit/intents/${parsed.data}`, IntentDecisionSchema);
}

/** Every audit-log entry, newest first, a page at a time. */
export async function loadEntries(
  key: string,
  query: unknown,
  deps: AuditDeps,
): Promise<Answer<EntryPage>> {
  const page = EntryQuerySchema.safeParse(query);
  if (!page.success) return badQuery;
  return getJson(deps, key, withQuery("/audit/entries", page.data), EntryPageSchema);
}

/** A fresh chain verdict. */
export async function loadVerify(key: string, deps: AuditDeps): Promise<Answer<ChainVerdict>> {
  return getJson(deps, key, "/audit/verify", ChainVerdictSchema);
}

const filenameOf = (scope: ExportScope) => `countersign-evidence-${scope.kind}-${scope.id}.json`;

/**
 * The evidence file for one intent or capture, as the gate wrote it. It's passed on only when it
 * says `countersign-evidence-v1` and names the scope that was asked for.
 */
export async function loadExport(
  key: string,
  query: unknown,
  deps: AuditDeps,
): Promise<Answer<EvidenceDownload>> {
  const scope = ExportScopeSchema.safeParse(query);
  if (!scope.success) return refuse(400, AUDIT_ROUTE_MESSAGES.badExport);
  const path = withQuery("/audit/export", { [scope.data.kind]: scope.data.id });
  const response = await callGate(deps, key, path);
  if (response?.status !== 200) return refusalOf(response);
  let body: string;
  let head: ReturnType<typeof EvidenceHeadSchema.safeParse>;
  try {
    body = await response.text();
    head = EvidenceHeadSchema.safeParse(JSON.parse(body));
  } catch {
    return unreachable;
  }
  if (!head.success) return unreachable;
  if (head.data.scope.kind !== scope.data.kind || head.data.scope.id !== scope.data.id) {
    return unreachable;
  }
  return { ok: true, value: { filename: filenameOf(scope.data), body } };
}

// --- Route handlers ------------------------------------------------------------------------

/** `GET /api/audit/decisions`. */
export function auditDecisionsRoute(
  request: Request,
  deps: AuditDeps,
): Promise<Response> | Response {
  return withKey(request, (key) => loadDecisions(key, queryOf(request), deps));
}

/** `GET /api/audit/decisions/[seq]`. */
export function auditDecisionRoute(
  request: Request,
  seq: unknown,
  deps: AuditDeps,
): Promise<Response> | Response {
  return withKey(request, async (key) =>
    isEmpty(queryOf(request)) ? loadDecision(key, seq, deps) : badQuery,
  );
}

/** `GET /api/audit/intents/[id]`. */
export function auditIntentRoute(
  request: Request,
  id: unknown,
  deps: AuditDeps,
): Promise<Response> | Response {
  return withKey(request, async (key) =>
    isEmpty(queryOf(request)) ? loadIntentDecision(key, id, deps) : badQuery,
  );
}

/** `GET /api/audit/entries`. */
export function auditEntriesRoute(request: Request, deps: AuditDeps): Promise<Response> | Response {
  return withKey(request, (key) => loadEntries(key, queryOf(request), deps));
}

/** `GET /api/audit/verify`. */
export function auditVerifyRoute(request: Request, deps: AuditDeps): Promise<Response> | Response {
  return withKey(request, async (key) =>
    isEmpty(queryOf(request)) ? loadVerify(key, deps) : badQuery,
  );
}

function download(request: Request, answer: Answer<EvidenceDownload>): Response {
  if (!answer.ok) return refusalResponse(request, answer);
  return new Response(answer.value.body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${answer.value.filename}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** `GET /api/audit/export?intent=<id>` or `?capture=<id>`: the evidence file, as an attachment. */
export function auditExportRoute(request: Request, deps: AuditDeps): Promise<Response> | Response {
  return withKey(request, (key) => loadExport(key, queryOf(request), deps), download);
}
