import "server-only";
import { auditIntentRoute } from "../../../../../src/audit-routes";

// An intent's newest decision from the gate's audit API, with the approver's cookie (ADR 0034).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/audit/intents/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return auditIntentRoute(request, id, { env: process.env });
}
