import "server-only";
import { threadsRoute } from "../../../../src/resolve-routes";

// Resolve's thread list, parsed (ADR 0030).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return threadsRoute({ env: process.env });
}
