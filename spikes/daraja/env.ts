import { z } from "zod";

// Spike S6 settings, loaded with `tsx --env-file=.env.local`. Values are never printed.
const schema = z.object({
  DARAJA_BASE_URL: z.url(),
  DARAJA_CONSUMER_KEY: z.string().min(1),
  DARAJA_CONSUMER_SECRET: z.string().min(1),
  DARAJA_C2B_SHORTCODE: z.string().regex(/^\d+$/),
  DARAJA_B2C_SHORTCODE: z.string().regex(/^\d+$/),
  DARAJA_INITIATOR_NAME: z.string().min(1),
  DARAJA_SECURITY_CREDENTIAL: z.string().min(1),
  DARAJA_TEST_MSISDN: z.string().regex(/^2547\d{8}$|^2541\d{8}$/),
  DARAJA_STK_SHORTCODE: z.string().regex(/^\d+$/).optional(),
  DARAJA_STK_PASSKEY: z.string().min(1).optional(),
  CALLBACK_PATH_SECRET: z.string().min(16),
  CALLBACK_BASE_URL: z.url().or(z.literal("")).optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Name the bad keys only, never their values.
    const keys = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Missing or malformed settings in .env.local: ${keys.join(", ")}`);
  }
  return parsed.data;
}

// Daraja rejects callback URLs containing these words, in any case.
const bannedWords = ["m-pesa", "mpesa", "safaricom", "exec", "exe", "cmd", "sql", "query"];

export function callbackUrl(env: Env, kind: string): string {
  if (!env.CALLBACK_BASE_URL) throw new Error("Set CALLBACK_BASE_URL to the tunnel URL first");
  const url = `${env.CALLBACK_BASE_URL.replace(/\/$/, "")}/${env.CALLBACK_PATH_SECRET}/${kind}`;
  const banned = bannedWords.filter((word) => url.toLowerCase().includes(word));
  if (banned.length > 0) {
    throw new Error(`Callback URL contains words Daraja rejects (${banned.join(", ")})`);
  }
  return url;
}

// For printing: hide the secret path segment.
export function redact(env: Env, text: string): string {
  return text.replaceAll(env.CALLBACK_PATH_SECRET, "<secret>");
}
