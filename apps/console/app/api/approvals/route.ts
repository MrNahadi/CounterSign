import "server-only";
import { approvalsRoute } from "../../../src/approval-routes";

// The open cards and recent answers from the gate, with the approver's cookie (ADR 0032).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return approvalsRoute(request, { env: process.env });
}
