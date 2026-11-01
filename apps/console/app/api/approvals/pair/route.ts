import "server-only";
import { pairRoute } from "../../../../src/approval-routes";

// The phone's pairing: trades a QR link's code with the gate for the sign-in cookie (ADR 0044).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return pairRoute(request, { env: process.env });
}
