import "server-only";
import { scenarioRoute } from "../../../src/demo-routes";

// One demo scenario, started in protected mode or, through the gate, baseline (ADR 0043).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return scenarioRoute(request, { env: process.env });
}
