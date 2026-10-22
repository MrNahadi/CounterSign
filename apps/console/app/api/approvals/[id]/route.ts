import "server-only";
import { answerRoute, approvalRoute } from "../../../../src/approval-routes";

// One card from the gate, and the approver's answer to it (ADR 0032).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/approvals/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return approvalRoute(request, id, { env: process.env });
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/approvals/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return answerRoute(request, id, { env: process.env });
}
