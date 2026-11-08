import "server-only";
import { signRoute } from "../../../../src/mandate-routes";

// Signs a compiled draft as the next mandate version: the gate writes it and its hash to the audit
// log (PLAN E2). The gate keeps deciding with the version it loaded at startup.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return signRoute(request, { env: process.env });
}
