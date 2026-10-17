import { z } from "zod";

// Sandbox only (brief §8). The client refuses to start against any other host.
export const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

export const PAYPAL_ENV_NAMES = [
  "PAYPAL_BASE_URL",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
] as const;

export type PayPalConfig = { baseUrl: string; clientId: string; clientSecret: string };

export type PayPalEnvParse =
  | { ok: true; config: PayPalConfig }
  | { ok: false; missing: string[]; problems: string[] };

const SANDBOX_ONLY = `PAYPAL_BASE_URL must be ${SANDBOX_BASE_URL}. Only the PayPal sandbox is allowed.`;

// Messages are fixed text, so a problem never echoes a value.
const present = (name: string) =>
  z.string({ error: `${name} is missing.` }).min(1, { error: `${name} is missing.`, abort: true });

const envSchema = z.object({
  PAYPAL_BASE_URL: present("PAYPAL_BASE_URL").refine(
    (url) => url === SANDBOX_BASE_URL || url === `${SANDBOX_BASE_URL}/`,
    { error: SANDBOX_ONLY },
  ),
  PAYPAL_CLIENT_ID: present("PAYPAL_CLIENT_ID"),
  PAYPAL_CLIENT_SECRET: present("PAYPAL_CLIENT_SECRET"),
});

export function parsePayPalEnv(env: Readonly<Record<string, string | undefined>>): PayPalEnvParse {
  const parsed = envSchema.safeParse({
    PAYPAL_BASE_URL: env.PAYPAL_BASE_URL,
    PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET,
  });
  if (parsed.success) {
    return {
      ok: true,
      config: {
        baseUrl: SANDBOX_BASE_URL,
        clientId: parsed.data.PAYPAL_CLIENT_ID,
        clientSecret: parsed.data.PAYPAL_CLIENT_SECRET,
      },
    };
  }
  const missing = PAYPAL_ENV_NAMES.filter((name) => !env[name]);
  const problems = PAYPAL_ENV_NAMES.flatMap((name) =>
    parsed.error.issues.filter((issue) => issue.path[0] === name).map((issue) => issue.message),
  );
  return { ok: false, missing, problems: [...new Set(problems)] };
}

export class PayPalConfigError extends Error {
  override readonly name = "PayPalConfigError";
  readonly missing: string[];
  readonly problems: string[];

  constructor(missing: string[], problems: string[]) {
    super(`The PayPal client can't start. ${problems.join(" ")}`);
    this.missing = missing;
    this.problems = problems;
  }
}
