import "server-only";
import { auditDecisionRoute } from "../../../../../src/audit-routes";

// One decision from the gate's audit API, with the approver's cookie (ADR 0034).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/audit/decisions/[seq]">,
): Promise<Response> {
  const { seq } = await context.params;
  return auditDecisionRoute(request, seq, { env: process.env });
}
