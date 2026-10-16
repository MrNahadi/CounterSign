import { z } from "zod";

// Spike S1 driver: PayPal order -> capture -> partial refund, and refund idempotency. Usage:
//   tsx --env-file=.env.local spikes/paypal/s1.ts <token | create [usd] | show <order> | capture <order>
//                                                | refund <capture> <usd> <request-id> | capture-status <capture>>
// Prints PayPal's responses, never the access token or the client secret.

const env = z
  .object({
    PAYPAL_BASE_URL: z.url(),
    PAYPAL_CLIENT_ID: z.string().min(1),
    PAYPAL_CLIENT_SECRET: z.string().min(1),
  })
  .parse(process.env);

let cachedToken: string | undefined;

async function token(): Promise<string> {
  if (cachedToken) return cachedToken;
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString(
    "base64",
  );
  const res = await fetch(`${env.PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`OAuth failed: HTTP ${res.status} ${body.error_description ?? ""}`);
  }
  cachedToken = body.access_token;
  return cachedToken;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; requestId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; debugId: string | null }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await token()}`,
    "content-type": "application/json",
    prefer: "return=representation",
  };
  if (options.requestId) headers["paypal-request-id"] = options.requestId;
  const res = await fetch(`${env.PAYPAL_BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    debugId: res.headers.get("paypal-debug-id"),
  };
}

function print(label: string, result: Awaited<ReturnType<typeof call>>, pick?: unknown) {
  console.log(`${label}: HTTP ${result.status} (debug id ${result.debugId})`);
  console.log(JSON.stringify(pick ?? result.body, null, 2));
}

type Order = {
  id?: string;
  status?: string;
  payer?: { email_address?: string; payer_id?: string; name?: unknown };
  links?: { rel: string; href: string }[];
  purchase_units?: {
    reference_id?: string;
    amount?: unknown;
    payments?: { captures?: { id: string; status: string; amount: unknown }[] };
  }[];
};

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async token() {
    const value = await token();
    console.log(`OAuth ok: token of ${value.length} characters`);
  },

  async create([usd = "48.00"]) {
    const result = await call("POST", "/v2/checkout/orders", {
      requestId: `countersign-s1-create-${Date.now()}`,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: "KIK-2001",
            description: "Kikapu Studio: woven market basket",
            amount: { currency_code: "USD", value: usd },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Kikapu Studio",
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: "https://example.com/kikapu/return",
              cancel_url: "https://example.com/kikapu/cancel",
            },
          },
        },
      },
    });
    const order = result.body as Order;
    print("create order", result, {
      id: order.id,
      status: order.status,
      approve: order.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")
        ?.href,
    });
  },

  async show([orderId]) {
    if (!orderId) throw new Error("Pass the order ID");
    const result = await call("GET", `/v2/checkout/orders/${orderId}`);
    const order = result.body as Order;
    print("order", result, { id: order.id, status: order.status, payer: order.payer });
  },

  async capture([orderId]) {
    if (!orderId) throw new Error("Pass the order ID");
    const result = await call("POST", `/v2/checkout/orders/${orderId}/capture`, {
      requestId: `countersign-s1-capture-${orderId}`,
    });
    const order = result.body as Order;
    print("capture", result, {
      id: order.id,
      status: order.status,
      payer: order.payer,
      captures: order.purchase_units?.[0]?.payments?.captures?.map(({ id, status, amount }) => ({
        id,
        status,
        amount,
      })),
      error: result.status >= 400 ? result.body : undefined,
    });
  },

  async refund([captureId, usd, requestId]) {
    if (!captureId || !usd || !requestId)
      throw new Error("Pass the capture ID, amount and request ID");
    const result = await call("POST", `/v2/payments/captures/${captureId}/refund`, {
      requestId,
      body: { amount: { currency_code: "USD", value: usd }, note_to_payer: "Countersign spike S1" },
    });
    const refund = result.body as {
      id?: string;
      status?: string;
      amount?: unknown;
      create_time?: string;
    };
    print(`refund (request id ${requestId})`, result, {
      id: refund.id,
      status: refund.status,
      amount: refund.amount,
      create_time: refund.create_time,
      error: result.status >= 400 ? result.body : undefined,
    });
  },

  // Spike S2: add a tracker through Orders v2, then read it back from the order.
  async track([orderId, captureId, trackingNumber = `KIK${Date.now()}`]) {
    if (!orderId || !captureId) throw new Error("Pass the order ID and capture ID");
    const added = await call("POST", `/v2/checkout/orders/${orderId}/track`, {
      requestId: `countersign-s2-track-${orderId}-${trackingNumber}`,
      body: {
        capture_id: captureId,
        tracking_number: trackingNumber,
        carrier: "OTHER",
        carrier_name_other: "Kisumu Couriers",
        notify_payer: false,
      },
    });
    print(
      "add tracker",
      added,
      added.status >= 400 ? added.body : { status: (added.body as Order).status },
    );
    const read = await call("GET", `/v2/checkout/orders/${orderId}`);
    const order = read.body as {
      purchase_units?: { shipping?: { trackers?: unknown[] } }[];
    };
    print("trackers on the order", read, order.purchase_units?.[0]?.shipping?.trackers ?? []);
  },

  async "capture-status"([captureId]) {
    if (!captureId) throw new Error("Pass the capture ID");
    const result = await call("GET", `/v2/payments/captures/${captureId}`);
    const capture = result.body as {
      status?: string;
      amount?: unknown;
      seller_receivable_breakdown?: unknown;
    };
    print("capture status", result, {
      status: capture.status,
      amount: capture.amount,
      breakdown: capture.seller_receivable_breakdown,
    });
  },

  // Account capability probes: does this sandbox merchant have Payouts and Disputes?
  async payout([email, usd = "1.00"]) {
    if (!email) throw new Error("Pass the recipient's sandbox email");
    const batchId = `countersign-s1-payout-${Date.now()}`;
    const result = await call("POST", "/v1/payments/payouts", {
      requestId: batchId,
      body: {
        sender_batch_header: {
          sender_batch_id: batchId,
          email_subject: "Kikapu Studio supplier payout",
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: email,
            amount: { value: usd, currency: "USD" },
            note: "Countersign spike S1",
          },
        ],
      },
    });
    const batch = result.body as {
      batch_header?: { payout_batch_id?: string; batch_status?: string };
    };
    print("payout", result, result.status >= 400 ? result.body : batch.batch_header);
  },

  async disputes() {
    const result = await call("GET", "/v1/customer/disputes?page_size=5");
    const list = result.body as {
      items?: { dispute_id: string; status: string; reason: string }[];
    };
    print("disputes", result, result.status >= 400 ? result.body : { items: list.items ?? [] });
  },

  // Seeding route: the buyer approves once to save their PayPal account, then orders charge it
  // directly. Step 1 returns an approval link.
  async "vault-setup"() {
    const result = await call("POST", "/v3/vault/setup-tokens", {
      requestId: `countersign-s1-vault-${Date.now()}`,
      body: {
        payment_source: {
          paypal: {
            usage_type: "MERCHANT",
            description: "Kikapu Studio demo orders",
            experience_context: {
              brand_name: "Kikapu Studio",
              return_url: "https://example.com/kikapu/return",
              cancel_url: "https://example.com/kikapu/cancel",
            },
          },
        },
      },
    });
    const token = result.body as {
      id?: string;
      status?: string;
      links?: { rel: string; href: string }[];
    };
    print("vault setup token", result, {
      id: token.id,
      status: token.status,
      approve: token.links?.find((link) => link.rel === "approve")?.href,
      error: result.status >= 400 ? result.body : undefined,
    });
  },

  // Step 2, after approval: exchange the setup token for a reusable payment token.
  async "vault-token"([setupTokenId]) {
    if (!setupTokenId) throw new Error("Pass the setup token ID");
    const result = await call("POST", "/v3/vault/payment-tokens", {
      requestId: `countersign-s1-vault-token-${setupTokenId}`,
      body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
    });
    const token = result.body as { id?: string; customer?: unknown; payment_source?: unknown };
    print("vault payment token", result, {
      id: token.id,
      customer: token.customer,
      payment_source: token.payment_source,
      error: result.status >= 400 ? result.body : undefined,
    });
  },

  // Step 3: an order paid with the saved account, captured with no buyer approval.
  async "vault-order"([paymentTokenId, usd = "36.00", reference = "KIK-2002"]) {
    if (!paymentTokenId) throw new Error("Pass the payment token ID");
    const result = await call("POST", "/v2/checkout/orders", {
      requestId: `countersign-s1-vault-order-${reference}-${Date.now()}`,
      body: {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: reference, amount: { currency_code: "USD", value: usd } }],
        payment_source: { paypal: { vault_id: paymentTokenId } },
      },
    });
    const order = result.body as Order;
    print("vault order", result, {
      id: order.id,
      status: order.status,
      payer: order.payer,
      captures: order.purchase_units?.[0]?.payments?.captures?.map(({ id, status, amount }) => ({
        id,
        status,
        amount,
      })),
      error: result.status >= 400 ? result.body : undefined,
    });
  },
};

const [name = "", ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error(`Unknown command "${name}". Use one of: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}
command(args).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
