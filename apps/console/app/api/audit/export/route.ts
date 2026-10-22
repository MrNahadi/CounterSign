import "server-only";
import { auditExportRoute } from "../../../../src/audit-routes";

// The evidence file for an intent or a capture, from the gate's audit API, as an attachment
// (ADR 0034).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return auditExportRoute(request, { env: process.env });
}
