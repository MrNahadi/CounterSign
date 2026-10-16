import { callbackUrl, type Env, loadEnv, redact } from "./env";

// Spike S6 driver. Usage:
//   tsx --env-file=.env.local spikes/daraja/s6.ts <token | register | simulate [amount] | status <receipt> | b2c [amount]>
// Prints Daraja's responses, never the access token, the security credential or the callback secret.

const env = loadEnv();

async function accessToken(): Promise<{ token: string; expiresIn: string }> {
  const basic = Buffer.from(`${env.DARAJA_CONSUMER_KEY}:${env.DARAJA_CONSUMER_SECRET}`).toString(
    "base64",
  );
  const res = await fetch(
    `${env.DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { authorization: `Basic ${basic}` },
    },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { access_token?: string; expires_in?: string };
  if (!body.access_token) throw new Error("OAuth response had no access_token");
  return { token: body.access_token, expiresIn: String(body.expires_in) };
}

async function post(path: string, payload: Record<string, unknown>): Promise<void> {
  const { token } = await accessToken();
  const started = Date.now();
  const res = await fetch(`${env.DARAJA_BASE_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  // Firewall pages embed the caller's IP address; print only their incident ID.
  const incident = raw.match(/incident ID: ([\d-]+)/)?.[1];
  const text = raw.trimStart().startsWith("<") ? `HTML page (firewall incident ${incident})` : raw;
  const shown = { ...payload };
  if ("SecurityCredential" in shown) shown.SecurityCredential = "<hidden>";
  if ("Password" in shown) shown.Password = "<hidden>";
  console.log(redact(env, `POST ${path}\n${JSON.stringify(shown, null, 2)}`));
  console.log(`HTTP ${res.status} in ${Date.now() - started} ms\n${redact(env, text)}`);
}

const commands: Record<string, (env: Env, args: string[]) => Promise<void>> = {
  async token() {
    const { token, expiresIn } = await accessToken();
    console.log(`OAuth ok: token of ${token.length} characters, expires_in ${expiresIn}`);
  },

  async register(env, [version = "v1"]) {
    await post(`/mpesa/c2b/${version}/registerurl`, {
      ShortCode: Number(env.DARAJA_C2B_SHORTCODE),
      ResponseType: "Completed",
      ConfirmationURL: callbackUrl(env, "c2b-confirmation"),
      ValidationURL: callbackUrl(env, "c2b-validation"),
    });
  },

  // Registers plain URLs under a base, without the secret, to isolate why registration fails.
  async probe(env, [base = "https://example.com/countersign"]) {
    await post("/mpesa/c2b/v1/registerurl", {
      ShortCode: Number(env.DARAJA_C2B_SHORTCODE),
      ResponseType: "Completed",
      ConfirmationURL: `${base}/confirmation`,
      ValidationURL: `${base}/validation`,
    });
  },

  async simulate(env, [amount = "1500", kind = "paybill"]) {
    const till = kind === "till";
    await post("/mpesa/c2b/v2/simulate", {
      ShortCode: Number(env.DARAJA_C2B_SHORTCODE),
      CommandID: till ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
      Amount: Number(amount),
      Msisdn: Number(env.DARAJA_TEST_MSISDN),
      BillRefNumber: till ? null : "KIK-1001",
    });
  },

  // M-Pesa Express: the customer approves on their phone, and the result (with the receipt)
  // is posted to the CallBackURL in this request. No URL registration is involved.
  async stk(env, [amount = "1"]) {
    if (!env.DARAJA_STK_SHORTCODE || !env.DARAJA_STK_PASSKEY) {
      throw new Error("Set DARAJA_STK_SHORTCODE and DARAJA_STK_PASSKEY in .env.local");
    }
    // Daraja expects Kenyan local time (UTC+3) as yyyyMMddHHmmss.
    const timestamp = new Date(Date.now() + 3 * 3600 * 1000)
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 14);
    const password = Buffer.from(
      `${env.DARAJA_STK_SHORTCODE}${env.DARAJA_STK_PASSKEY}${timestamp}`,
    ).toString("base64");
    await post("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: env.DARAJA_STK_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Number(amount),
      PartyA: env.DARAJA_TEST_MSISDN,
      PartyB: env.DARAJA_STK_SHORTCODE,
      PhoneNumber: env.DARAJA_TEST_MSISDN,
      CallBackURL: callbackUrl(env, "stk-result"),
      AccountReference: "KIK-1003",
      TransactionDesc: "Kikapu order",
    });
  },

  async status(env, [receipt, partyA = env.DARAJA_C2B_SHORTCODE]) {
    if (!receipt) throw new Error("Pass the M-Pesa receipt (TransID) to check");
    await post("/mpesa/transactionstatus/v1/query", {
      Initiator: env.DARAJA_INITIATOR_NAME,
      SecurityCredential: env.DARAJA_SECURITY_CREDENTIAL,
      CommandID: "TransactionStatusQuery",
      TransactionID: receipt,
      OriginalConversationID: "",
      PartyA: partyA,
      IdentifierType: "4",
      ResultURL: callbackUrl(env, "status-result"),
      QueueTimeOutURL: callbackUrl(env, "status-timeout"),
      Remarks: "Countersign spike S6",
      Occasion: "Receipt check",
    });
  },

  async b2c(env, [amount = "10"]) {
    await post("/mpesa/b2c/v3/paymentrequest", {
      OriginatorConversationID: `countersign-s6-${Date.now()}`,
      InitiatorName: env.DARAJA_INITIATOR_NAME,
      SecurityCredential: env.DARAJA_SECURITY_CREDENTIAL,
      CommandID: "BusinessPayment",
      Amount: Number(amount),
      PartyA: env.DARAJA_B2C_SHORTCODE,
      PartyB: env.DARAJA_TEST_MSISDN,
      Remarks: "Countersign spike S6 refund",
      QueueTimeOutURL: callbackUrl(env, "b2c-timeout"),
      ResultURL: callbackUrl(env, "b2c-result"),
      Occassion: "Overpayment refund test",
    });
  },
};

const [name = "", ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error(`Unknown command "${name}". Use one of: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
command(env, args).catch((error: unknown) => {
  console.error(redact(env, error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
