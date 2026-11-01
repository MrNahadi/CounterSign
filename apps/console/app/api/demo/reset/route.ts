import "server-only";
import { resetRoute } from "../../../../src/demo-routes";

// The demo reset, passed to the gate with the cookie's key (ADR 0042).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return resetRoute(request, { env: process.env });
}
