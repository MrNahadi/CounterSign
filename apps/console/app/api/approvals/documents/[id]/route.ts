import "server-only";
import { documentRoute } from "../../../../../src/approval-routes";

// One evidence document from the gate, downloaded from an approval card (ADR 0035).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/approvals/documents/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return documentRoute(request, id, { env: process.env });
}
