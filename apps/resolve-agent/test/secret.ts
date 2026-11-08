import { SHARED_SECRET_HEADER } from "../src/shared-secret";

// The shared secret Resolve's tests run with (PLAN.md F2), and a `fetch` that sends it, as the
// gate and the console do. Illustrative only: 32 or more characters, never a real secret.

export const TEST_SECRET = "resolve-test-shared-secret-0123456789abcdef";

/** `fetch` with Resolve's shared-secret header added. */
export const authed = (url: string | URL, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      [SHARED_SECRET_HEADER]: TEST_SECRET,
    },
  });
