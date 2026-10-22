import "server-only";
import { signInRoute, signOutRoute } from "../../../../src/approval-routes";

// The approver login: sign in with the key (checked by the gate), or sign out (ADR 0032).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return signInRoute(request, { env: process.env });
}

export async function DELETE(request: Request): Promise<Response> {
  return signOutRoute(request);
}
