// The nudge (ADR 0035): after a new `dispute.received` entry, the gate tells Resolve with
// `POST <RESOLVE_AGENT_URL>/disputes { dispute_id }`. Best effort, at most 2 seconds, and nothing
// depends on it: it never throws, and its outcome changes no answer. No AI.

export const DEFAULT_RESOLVE_AGENT_URL = "http://127.0.0.1:8788";
export const NUDGE_TIMEOUT_MS = 2000;

// Only what the nudge uses of `fetch`, so tests can inject one.
export type NudgeFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean }>;

export type NudgeDeps = {
  env: Readonly<Record<string, string | undefined>>;
  fetch?: NudgeFetch;
};

/** Resolve's base URL, or null when `RESOLVE_AGENT_URL` isn't an http(s) URL. */
export function resolveAgentUrl(env: NudgeDeps["env"]): URL | null {
  const raw = env.RESOLVE_AGENT_URL?.trim() || DEFAULT_RESOLVE_AGENT_URL;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Sends the nudge and answers whether Resolve took it (a 2xx within 2 seconds). Never throws.
export async function nudgeResolve(disputeId: string, deps: NudgeDeps): Promise<boolean> {
  const base = resolveAgentUrl(deps.env);
  if (base === null) return false;
  const send: NudgeFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Settles at the timeout even if the fetch ignores its signal.
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, NUDGE_TIMEOUT_MS);
    timer.unref?.();
  });
  const sent = (async () => {
    try {
      const response = await send(new URL("/disputes", base).toString(), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ dispute_id: disputeId }),
        signal: controller.signal,
      });
      return response.ok === true;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([sent, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
