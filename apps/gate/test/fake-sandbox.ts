import type {
  PayPalCapture,
  PayPalClient,
  PayPalDisputeList,
  PayPalOrder,
  PayPalRefund,
} from "@countersign/rail-paypal";
import { PayPalError } from "@countersign/rail-paypal";

// A stateful fake PayPal sandbox for the gate's tests: records held in memory as the rail
// client returns them, refunds that replay by request ID, and failures a test can inject.

export type FakeCall = keyof PayPalClient;

export type FakeSandbox = PayPalClient & {
  captures: Map<string, PayPalCapture>;
  orders: Map<string, PayPalOrder>;
  disputes: Map<string, PayPalDisputeList>;
  refunds: Map<string, PayPalRefund>;
  // Thrown by the named call instead of answering.
  failures: Partial<Record<FakeCall, unknown>>;
  // Every call made, in order, with its first argument.
  calls: { call: FakeCall; arg: unknown }[];
};

export function httpError(call: string, status: number, name = "ERROR"): PayPalError {
  return new PayPalError({ kind: "http", call, status, paypalName: name, debugId: "fake-debug" });
}

const notFound = (call: string) => httpError(call, 404, "RESOURCE_NOT_FOUND");

export function createFakeSandbox(): FakeSandbox {
  const byRequestId = new Map<string, string>();
  let nextRefund = 1;

  const sandbox: FakeSandbox = {
    captures: new Map(),
    orders: new Map(),
    disputes: new Map(),
    refunds: new Map(),
    failures: {},
    calls: [],
    async createOrder() {
      throw new Error("createOrder isn't in the fake sandbox");
    },
    async captureOrder() {
      throw new Error("captureOrder isn't in the fake sandbox");
    },
    async addTracker() {
      throw new Error("addTracker isn't in the fake sandbox");
    },
    async getOrder(orderId) {
      enter("getOrder", orderId);
      const order = sandbox.orders.get(orderId);
      if (!order) throw notFound("get-order");
      return structuredClone(order);
    },
    async getCapture(captureId) {
      enter("getCapture", captureId);
      const capture = sandbox.captures.get(captureId);
      if (!capture) throw notFound("get-capture");
      return structuredClone(capture);
    },
    async listDisputes(captureId) {
      enter("listDisputes", captureId);
      return structuredClone(sandbox.disputes.get(captureId) ?? { disputes: [], complete: true });
    },
    async refundCapture(input) {
      enter("refundCapture", input);
      const replayed = byRequestId.get(input.requestId);
      if (replayed) return structuredClone(sandbox.refunds.get(replayed) as PayPalRefund);
      if (!sandbox.captures.has(input.captureId)) throw notFound("refund-capture");
      const refund: PayPalRefund = {
        id: `FAKEREFUND${String(nextRefund++).padStart(6, "0")}`,
        status: "COMPLETED",
        amount: input.amount,
        captureId: input.captureId,
      };
      sandbox.refunds.set(refund.id, refund);
      byRequestId.set(input.requestId, refund.id);
      return structuredClone(refund);
    },
    async getRefund(refundId) {
      enter("getRefund", refundId);
      const refund = sandbox.refunds.get(refundId);
      if (!refund) throw notFound("get-refund");
      return structuredClone(refund);
    },
    async verifyWebhookSignature(input) {
      enter("verifyWebhookSignature", input);
      return "pass";
    },
  };

  function enter(call: FakeCall, arg: unknown): void {
    sandbox.calls.push({ call, arg });
    const failure = sandbox.failures[call];
    if (failure !== undefined) throw failure;
  }

  return sandbox;
}
