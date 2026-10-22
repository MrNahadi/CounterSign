import "server-only";
import { auditEntriesRoute } from "../../../../src/audit-routes";

// Audit-log entries from the gate's audit API, with the approver's cookie (ADR 0034).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return auditEntriesRoute(request, { env: process.env });
}
