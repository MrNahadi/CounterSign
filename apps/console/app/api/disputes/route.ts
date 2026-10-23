import "server-only";
import { disputesRoute, draftAgainRoute } from "../../../src/dispute-routes";

// Resolve's dispute drafts, behind the approvals sign-in checked with the gate (ADR 0035, 0038).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return disputesRoute(request, { env: process.env });
}

export async function POST(request: Request): Promise<Response> {
  return draftAgainRoute(request, { env: process.env });
}
