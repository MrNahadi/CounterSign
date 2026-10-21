import "server-only";
import { messagesRoute } from "../../../../src/resolve-routes";

// One simulated customer message, checked, then sent to Resolve (ADR 0030).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return messagesRoute(request, { env: process.env });
}
