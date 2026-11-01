import "server-only";
import { threadRoute } from "../../../../../src/resolve-routes";

// One thread from Resolve, parsed (ADR 0030).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext<"/api/resolve/threads/[id]">,
): Promise<Response> {
  const { id } = await context.params;
  return threadRoute(request, id, { env: process.env });
}
