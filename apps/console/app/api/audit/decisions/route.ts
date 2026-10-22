import "server-only";
import { auditDecisionsRoute } from "../../../../src/audit-routes";

// Decision rows from the gate's audit API, with the approver's cookie (ADR 0034).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return auditDecisionsRoute(request, { env: process.env });
}
