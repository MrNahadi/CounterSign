import "server-only";
import { parseMandate } from "@countersign/mandate";
import supportMandate from "@countersign/mandate/fixtures/kikapu-studio-v3.json";
import { compileRoute } from "../../../../src/compiler-routes";
import { geminiFromEnv } from "../../../../src/gemini";

// The mandate compiler: plain-English rules in, a draft mandate and its read-back out (PLAN E1).
// The current mandate is the support agent's signed file, the one the gate loads
// (apps/gate/src/principals.ts). The Gemini key is read here, on the server, and never reaches the
// browser (ADR 0016). The draft isn't signed or used: the gate never calls this route.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const generate = geminiFromEnv(process.env);
const current = parseMandate(supportMandate);

export async function POST(request: Request): Promise<Response> {
  return compileRoute(request, {
    env: process.env,
    generate,
    current: current.ok ? current.mandate : null,
  });
}
