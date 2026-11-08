import "server-only";
import { replayRoute } from "../../../../src/mandate-routes";

// Replays the audit log's decisions under the mandate in force with a compiled draft, through the
// gate's mandate API with the approver's cookie (PLAN E2). No AI: the gate runs its own rule step.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return replayRoute(request, { env: process.env });
}
