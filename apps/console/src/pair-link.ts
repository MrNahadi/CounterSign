import { z } from "zod";
import { APPROVAL_ROUTE_MESSAGES } from "./approval-routes";
import { GateMessageSchema } from "./approval-schemas";

// Phone pairing on the approvals page (ADR 0044): the start page's QR link carries a single-use
// code in its fragment (`/approvals#pair=<code>`), so no server logs it. The page drops it from
// the address bar first, then trades it once through the console's pairing route, which sets the
// sign-in's cookies. Plain Web APIs only: the page's client component runs this.

export const PAIR_ROUTE = "/api/approvals/pair";

const PairedSchema = z.object({ ok: z.literal(true) });

/** The pairing code in a URL fragment (`#pair=<code>`), or null when there's none. */
export function pairingCodeFromHash(hash: string): string | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment === "") return null;
  return new URLSearchParams(fragment).get("pair");
}

export type PairBrowser = {
  /** The address bar's fragment, as `location.hash` gives it. */
  readonly hash: string;
  /** Removes the fragment from the address bar without a navigation. */
  clearHash(): void;
  fetch: typeof fetch;
};

export type PairOutcome = { paired: true } | { paired: false; message: string };

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Trades the fragment's pairing code, if there is one: null when there's none (nothing to show);
 * paired on the route's 200; otherwise the sentence to show above the sign-in. Anything that
 * isn't a readable 200 is never paired.
 */
export async function pairFromLink(browser: PairBrowser): Promise<PairOutcome | null> {
  const code = pairingCodeFromHash(browser.hash);
  if (code === null) return null;
  // Drop the code before anything else, so it can't be shared, bookmarked or posted twice.
  browser.clearHash();
  const failed: PairOutcome = { paired: false, message: APPROVAL_ROUTE_MESSAGES.unreachable };
  let response: Response;
  try {
    response = await browser.fetch(PAIR_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      cache: "no-store",
    });
  } catch {
    return failed;
  }
  const body = await readBody(response);
  if (response.status === 200)
    return PairedSchema.safeParse(body).success ? { paired: true } : failed;
  const refusal = GateMessageSchema.safeParse(body);
  return refusal.success ? { paired: false, message: refusal.data.message } : failed;
}
