import "server-only";
import { analystRoute } from "../../../../src/analyst-routes";
import { geminiFromEnv } from "../../../../src/gemini";

// The Risk desk analyst: a question in, a widget spec from the fixed allowlist out (PLAN D2).
// The Gemini key is read here, on the server, and never reaches the browser (ADR 0016).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const generate = geminiFromEnv(process.env);

export async function POST(request: Request): Promise<Response> {
  return analystRoute(request, { env: process.env, generate });
}
