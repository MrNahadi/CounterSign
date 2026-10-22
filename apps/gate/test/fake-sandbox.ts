import type {
  PayPalCapture,
  PayPalClient,
  PayPalDispute,
  PayPalDisputeDetail,
  PayPalDisputeList,
  PayPalInvoice,
  PayPalOrder,
  PayPalRefund,
  PayPalTransaction,
  SendInvoiceInput,
} from "@countersign/rail-paypal";
import { PayPalError } from "@countersign/rail-paypal";

// A stateful fake PayPal sandbox for the gate's tests: records held in memory as the rail
// client returns them, refunds that replay by request ID, and failures a test can inject.

export type FakeCall = keyof PayPalClient;

export type FakeSandbox = PayPalClient & {
  captures: Map<string, PayPalCapture>;
  orders: Map<string, PayPalOrder>;
  disputes: Map<string, PayPalDisputeList>;
  // The merchant's disputes, as the first page of an unfiltered list answers them.
  merchantDisputes: PayPalDispute[];
  // Disputes read by their own ID, as get dispute returns them. Fields left out read as a
  // dispute waiting for the seller: reason not received, inquiry stage, no due date, no links.
  disputeDetails: Map<string, DisputeDetailSeed>;
  invoices: Map<string, PayPalInvoice>;
  // Every transaction search answers with these, filtered by transaction ID when one is given.
  transactions: PayPalTransaction[];
  refunds: Map<string, PayPalRefund>;
  // Thrown by the named call instead of answering.
  failures: Partial<Record<FakeCall, unknown>>;
  // Thrown by the named call after it takes effect, as a lost response would be.
  lostResponses: Partial<Record<FakeCall, unknown>>;
  // The status a new refund is created with.
  refundStatus: PayPalRefund["status"];
  // What the next send invoice calls answer, in order; when empty, `invoiceSendAnswer`.
  invoiceSendAnswers: InvoiceSendAnswer[];
  invoiceSendAnswer: InvoiceSendAnswer;
  // Every send invoice request, in order, as the rail client received it.
  invoiceSends: SendInvoiceInput[];
  // IDs of the draft invoices it created.
  createdInvoices: string[];
  // What a webhook signature verification answers.
  webhookVerification: "pass" | "fail";
  // Every call made, in order, with its first argument.
  calls: { call: FakeCall; arg: unknown }[];
};

// What a send invoice call answers: PayPal's 200 (`SENT`) or 202 (`SCHEDULED`), an error status
// such as a 4xx refusal or a 5xx, or a network failure after the request may have arrived.
export type InvoiceSendAnswer =
  | "SENT"
  | "SCHEDULED"
  | { status: number; name?: string; issues?: string[] }
  | "network";

export type DisputeDetailSeed = Pick<
  PayPalDisputeDetail,
  "id" | "status" | "amount" | "captureIds"
> &
  Partial<PayPalDisputeDetail>;

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
    merchantDisputes: [],
    disputeDetails: new Map(),
    invoices: new Map(),
    transactions: [],
    refunds: new Map(),
    failures: {},
    invoiceSendAnswers: [],
    invoiceSendAnswer: "SENT",
    invoiceSends: [],
    createdInvoices: [],
    lostResponses: {},
    refundStatus: "COMPLETED",
    webhookVerification: "pass",
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
    async acceptClaim() {
      throw new Error("acceptClaim isn't in the fake sandbox");
    },
    async makeOffer() {
      throw new Error("makeOffer isn't in the fake sandbox");
    },
    async provideEvidence() {
      throw new Error("provideEvidence isn't in the fake sandbox");
    },
    // The sandbox-only helpers answer 200 unless a failure is injected.
    async requireEvidence(input) {
      enter("requireEvidence", input);
      if (!sandbox.disputeDetails.has(input.disputeId)) throw notFound("require-evidence");
      return 200;
    },
    async adjudicate(input) {
      enter("adjudicate", input);
      if (!sandbox.disputeDetails.has(input.disputeId)) throw notFound("adjudicate");
      return 200;
    },
    async issueAccessToken() {
      throw new Error("issueAccessToken isn't in the fake sandbox");
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
    async listMerchantDisputes(input) {
      enter("listMerchantDisputes", input);
      const disputes = sandbox.merchantDisputes.slice(0, input.pageSize);
      return structuredClone({
        disputes,
        complete: disputes.length === sandbox.merchantDisputes.length,
      });
    },
    async getDispute(disputeId) {
      enter("getDispute", disputeId);
      const dispute = sandbox.disputeDetails.get(disputeId);
      if (!dispute) throw notFound("get-dispute");
      return structuredClone({
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        lifeCycleStage: "INQUIRY",
        sellerResponseDueDate: null,
        linkNames: [],
        ...dispute,
      });
    },
    async getInvoice(invoiceId) {
      enter("getInvoice", invoiceId);
      const invoice = sandbox.invoices.get(invoiceId);
      if (!invoice) throw notFound("get-invoice");
      return structuredClone(invoice);
    },
    async sendInvoice(input) {
      enter("sendInvoice", input);
      sandbox.invoiceSends.push(structuredClone(input));
      const next = sandbox.invoiceSendAnswers.shift() ?? sandbox.invoiceSendAnswer;
      if (next === "network") {
        throw new PayPalError({ kind: "network", call: "send-invoice", status: null });
      }
      if (typeof next === "object") {
        throw new PayPalError({
          kind: "http",
          call: "send-invoice",
          status: next.status,
          paypalName: next.name ?? "ERROR",
          issues: next.issues ?? [],
          debugId: "fake-debug",
        });
      }
      return answer("sendInvoice", next);
    },
    async createDraftInvoice(input) {
      enter("createDraftInvoice", input);
      const id = `INV2-FAKE-${String(sandbox.createdInvoices.length + 1).padStart(4, "0")}`;
      sandbox.createdInvoices.push(id);
      return answer("createDraftInvoice", id);
    },
    async searchTransactions(input) {
      enter("searchTransactions", input);
      const transactions = sandbox.transactions.filter(
        (t) => input.transactionId === undefined || t.id === input.transactionId,
      );
      return structuredClone({ transactions, complete: true });
    },
    async refundCapture(input) {
      enter("refundCapture", input);
      const replayed = byRequestId.get(input.requestId);
      if (replayed) return answer("refundCapture", sandbox.refunds.get(replayed) as PayPalRefund);
      if (!sandbox.captures.has(input.captureId)) throw notFound("refund-capture");
      const refund: PayPalRefund = {
        id: `FAKEREFUND${String(nextRefund++).padStart(6, "0")}`,
        status: sandbox.refundStatus,
        amount: input.amount,
        captureId: input.captureId,
      };
      sandbox.refunds.set(refund.id, refund);
      byRequestId.set(input.requestId, refund.id);
      // The order shows the refund on the unit holding the capture, as PayPal's does.
      for (const order of sandbox.orders.values()) {
        for (const unit of order.purchaseUnits) {
          if (unit.captures.some((capture) => capture.id === input.captureId)) {
            unit.refunds.push(structuredClone(refund));
          }
        }
      }
      return answer("refundCapture", refund);
    },
    async getRefund(refundId) {
      enter("getRefund", refundId);
      const refund = sandbox.refunds.get(refundId);
      if (!refund) throw notFound("get-refund");
      return structuredClone(refund);
    },
    async verifyWebhookSignature(input) {
      enter("verifyWebhookSignature", input);
      return sandbox.webhookVerification;
    },
  };

  function enter(call: FakeCall, arg: unknown): void {
    sandbox.calls.push({ call, arg });
    const failure = sandbox.failures[call];
    if (failure !== undefined) throw failure;
  }

  function answer<T>(call: FakeCall, value: T): T {
    const lost = sandbox.lostResponses[call];
    if (lost !== undefined) throw lost;
    return structuredClone(value);
  }

  return sandbox;
}
