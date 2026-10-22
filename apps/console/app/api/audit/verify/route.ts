import "server-only";
import { auditVerifyRoute } from "../../../../src/audit-routes";

// A fresh chain verdict from the gate's audit API, with the approver's cookie (ADR 0034).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return auditVerifyRoute(request, { env: process.env });
}
