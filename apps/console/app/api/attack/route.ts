import "server-only";
import { attackRoute } from "../../../src/attack-routes";

// "Attack it yourself": one visitor message, sent to Resolve in protected mode (ADR 0043).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return attackRoute(request, { env: process.env });
}
