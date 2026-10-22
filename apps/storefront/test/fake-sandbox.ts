import { createPayPalClient, type FetchLike } from "@countersign/rail-paypal";

// A stateful fake PayPal sandbox for seed tests: no network. It creates orders paid by vault
// tokens, adds trackers, reads orders back, and replays any POST whose PayPal-Request-Id it has
// already answered, as PayPal does.

export const FAKE_VAULT_A = "fake-vault-token-a-do-not-leak";
export const FAKE_VAULT_B = "fake-vault-token-b-do-not-leak";
export const BUYER_A_EMAIL = "buyer-a@example.com";
export const BUYER_B_EMAIL = "buyer-b@example.com";

export const sandboxEnv = {
  PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "fake-client-id-for-tests",
  PAYPAL_CLIENT_SECRET: "fake-client-secret-do-not-leak",
};

type Json = Record<string, unknown>;
type Answer = { status: number; body: unknown; headers?: Record<string, string> };

export type SeenCall = {
  method: string;
  path: string;
  requestId: string | null;
  body: Json | null;
  replayed: boolean;
};

// A hook may change a fresh create-order answer for one order, or fail a call outright.
export type FakeHooks = {
  // Called with the order number and the answer PayPal would give; may edit the answer.
  createAnswer?: (orderNumber: string, answer: Json) => void;
  // Called with the order number and the answer a get-order would give; may edit the answer.
  getAnswer?: (orderNumber: string, answer: Json) => void;
  // Return an error answer to fail this call for this order.
  fail?: (orderNumber: string, call: "create" | "track" | "get") => Answer | undefined;
};

const usd = (value: unknown) => value as { currency_code: string; value: string };

export function fakeSandbox(options: { emails?: Record<string, string> } = {}) {
  const emails: Record<string, string> = options.emails ?? {
    [FAKE_VAULT_A]: BUYER_A_EMAIL,
    [FAKE_VAULT_B]: BUYER_B_EMAIL,
  };
  const orders = new Map<string, Json>();
  const orderNumberOf = new Map<string, string>();
  const versions = new Map<string, number>();
  const replies = new Map<string, Answer>();
  const calls: SeenCall[] = [];
  const active = new Map<string, number>();
  let maxActive = 0;
  let trackersAdded = 0;
  let ordersCreated = 0;
  const hooks: FakeHooks = {};

  const enter = (orderNumber: string) => {
    active.set(orderNumber, (active.get(orderNumber) ?? 0) + 1);
    maxActive = Math.max(maxActive, active.size);
  };
  const leave = (orderNumber: string) => {
    const left = (active.get(orderNumber) ?? 1) - 1;
    if (left <= 0) active.delete(orderNumber);
    else active.set(orderNumber, left);
  };

  function createOrder(body: Json): Answer {
    const [unit] = body.purchase_units as Json[];
    if (!unit) return { status: 400, body: { name: "INVALID_REQUEST" } };
    const orderNumber = String(unit.reference_id);
    const failure = hooks.fail?.(orderNumber, "create");
    if (failure) return failure;
    const vaultId = (body.payment_source as { paypal?: { vault_id?: string } } | undefined)?.paypal
      ?.vault_id;
    const email = vaultId ? emails[vaultId] : undefined;
    const digits = orderNumber.replace(/\D/g, "");
    const version = (versions.get(orderNumber) ?? 0) + 1;
    versions.set(orderNumber, version);
    const id = `ORD${digits}V${version}`;
    const amount = usd(unit.amount);
    const order: Json = {
      id,
      intent: "CAPTURE",
      status: "COMPLETED",
      payer: email ? { email_address: email, payer_id: `PAYER${email.length}` } : undefined,
      purchase_units: [
        {
          reference_id: unit.reference_id,
          custom_id: unit.custom_id,
          invoice_id: unit.invoice_id,
          amount: { currency_code: amount.currency_code, value: amount.value },
          payments: {
            captures: [
              {
                id: `CAP${digits}V${version}`,
                status: "COMPLETED",
                amount: { currency_code: amount.currency_code, value: amount.value },
              },
            ],
          },
          shipping: { trackers: [] },
        },
      ],
    };
    hooks.createAnswer?.(orderNumber, order);
    orders.set(id, order);
    orderNumberOf.set(id, orderNumber);
    ordersCreated += 1;
    return { status: 201, body: structuredClone(order) };
  }

  function addTracker(orderId: string, body: Json): Answer {
    const order = orders.get(orderId);
    if (!order) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    const failure = hooks.fail?.(orderNumberOf.get(orderId) ?? "", "track");
    if (failure) return failure;
    const [unit] = order.purchase_units as Json[];
    const shipping = unit?.shipping as { trackers: Json[] };
    shipping.trackers.push({
      id: `${String(body.capture_id)}-${String(body.tracking_number)}`,
      status: "SHIPPED",
    });
    trackersAdded += 1;
    return { status: 201, body: structuredClone(order) };
  }

  function getOrder(orderId: string): Answer {
    const order = orders.get(orderId);
    if (!order) return { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
    const failure = hooks.fail?.(orderNumberOf.get(orderId) ?? "", "get");
    if (failure) return failure;
    const answer = structuredClone(order);
    hooks.getAnswer?.(orderNumberOf.get(orderId) ?? "", answer);
    return { status: 200, body: answer };
  }

  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const headers = new Headers(init.headers);
    const requestId = headers.get("paypal-request-id");
    const body =
      typeof init.body === "string" && path !== "/v1/oauth2/token"
        ? (JSON.parse(init.body) as Json)
        : null;
    if (path === "/v1/oauth2/token") {
      return json({
        status: 200,
        body: { access_token: "FAKE-ACCESS-TOKEN", expires_in: 32400, token_type: "Bearer" },
      });
    }
    const orderPath = /^\/v2\/checkout\/orders\/([^/]+)(\/track)?$/.exec(path);
    const orderNumber =
      path === "/v2/checkout/orders"
        ? String(((body?.purchase_units as Json[]) ?? [])[0]?.reference_id ?? "")
        : (orderNumberOf.get(orderPath?.[1] ?? "") ?? "");
    enter(orderNumber);
    try {
      // Let other orders' calls interleave, as real network calls would.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const replay = requestId ? replies.get(requestId) : undefined;
      calls.push({ method: init.method, path, requestId, body, replayed: replay !== undefined });
      if (replay) return json(replay);
      let answer: Answer;
      if (init.method === "POST" && path === "/v2/checkout/orders")
        answer = createOrder(body ?? {});
      else if (init.method === "POST" && orderPath?.[2])
        answer = addTracker(orderPath[1] ?? "", body ?? {});
      else if (init.method === "GET" && orderPath && !orderPath[2])
        answer = getOrder(orderPath[1] ?? "");
      else answer = { status: 404, body: { name: "RESOURCE_NOT_FOUND" } };
      if (requestId && answer.status < 400) replies.set(requestId, answer);
      return json(answer);
    } finally {
      leave(orderNumber);
    }
  };

  return {
    fetch,
    hooks,
    calls,
    orders,
    client: () =>
      createPayPalClient({ env: sandboxEnv, fetch, sleep: async () => {}, now: () => 0 }),
    maxOrdersInFlight: () => maxActive,
    trackersAdded: () => trackersAdded,
    ordersCreated: () => ordersCreated,
    orderFor: (orderNumber: string) =>
      [...orders.values()].filter(
        (order) => (order.purchase_units as Json[])[0]?.reference_id === orderNumber,
      ),
  };
}

function json(answer: Answer): Response {
  return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json", ...answer.headers },
  });
}

export function paypalError(status: number, name: string, debugId: string): Answer {
  return {
    status,
    body: { name, message: "The request failed.", debug_id: debugId, details: [{ issue: name }] },
  };
}
