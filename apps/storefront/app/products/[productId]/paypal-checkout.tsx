"use client";

import { loadCoreSdkScript, type OneTimePaymentSession } from "@paypal/paypal-js/sdk-v6";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type PaymentResult,
  readCaptureResponse,
  readCreateResponse,
} from "../../../src/checkout-client";

// The PayPal button, from JS SDK v6 in the sandbox. It gets the public client ID and nothing else
// from the server. The button is PayPal's own component, the one exception to Graphite styling.

type Phase =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready" }
  | { kind: "confirming" }
  | { kind: "done"; result: PaymentResult };

type Notice = { message: string; debugId: string | null };

const LOAD_FAILED = "We couldn't load PayPal. Reload the page to try again.";
const NOT_ELIGIBLE = "PayPal isn't available for this purchase.";
const CONFIRM_FAILED =
  "We couldn't confirm the payment with the shop. Check the order in the PayPal sandbox before you try again.";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

class CreateOrderFailed extends Error {
  readonly notice: Notice;
  constructor(notice: Notice) {
    super(notice.message);
    this.notice = notice;
  }
}

export function PayPalCheckout({ productId, clientId }: { productId: string; clientId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let session: OneTimePaymentSession | undefined;
    let button: HTMLElement | undefined;

    async function createOrder(): Promise<{ orderId: string }> {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const created = readCreateResponse(response.status, await readJson(response));
      if (!created.ok) throw new CreateOrderFailed(created);
      return { orderId: created.orderId };
    }

    async function capture(orderId: string) {
      setPhase({ kind: "confirming" });
      let result: PaymentResult;
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/capture`, {
          method: "POST",
        });
        result = readCaptureResponse(response.status, await readJson(response));
      } catch {
        result = { kind: "failed", message: CONFIRM_FAILED, debugId: null };
      }
      if (active) setPhase({ kind: "done", result });
    }

    async function pay() {
      if (!session) return;
      setNotice(null);
      try {
        await session.start({ presentationMode: "auto" }, createOrder());
      } catch (error) {
        if (!active) return;
        setNotice(
          error instanceof CreateOrderFailed
            ? error.notice
            : { message: "PayPal couldn't start the payment. Try again.", debugId: null },
        );
      }
    }

    async function setUp() {
      try {
        const paypal = await loadCoreSdkScript({ environment: "sandbox" });
        if (!paypal) throw new Error("PayPal didn't load");
        const sdk = await paypal.createInstance({
          clientId,
          components: ["paypal-payments"],
          pageType: "checkout",
        });
        const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
        if (!active) return;
        if (!methods.isEligible("paypal")) {
          setPhase({ kind: "unavailable", message: NOT_ELIGIBLE });
          return;
        }
        session = sdk.createPayPalOneTimePaymentSession({
          onApprove: ({ orderId }) => capture(orderId),
          onCancel: () => {
            if (active)
              setNotice({ message: "Payment cancelled. You can try again.", debugId: null });
          },
          onError: () => {
            if (active) {
              setNotice({
                message: "PayPal couldn't finish the payment. Try again.",
                debugId: null,
              });
            }
          },
        });
        const element = document.createElement("paypal-button");
        element.type = "pay";
        element.addEventListener("click", pay);
        slot.current?.append(element);
        button = element;
        setPhase({ kind: "ready" });
      } catch {
        if (active) setPhase({ kind: "unavailable", message: LOAD_FAILED });
      }
    }

    setUp();
    return () => {
      active = false;
      button?.remove();
      session?.destroy();
    };
  }, [clientId, productId]);

  return (
    <div>
      {phase.kind === "loading" && <Pending label="Loading PayPal" />}
      {phase.kind === "confirming" && <Pending label="Confirming payment" />}
      {phase.kind === "unavailable" && (
        <p className="text-body-sm text-secondary-foreground">{phase.message}</p>
      )}
      <div ref={slot} hidden={phase.kind !== "ready"} className="max-w-xs" />
      {phase.kind === "ready" && notice && <NoticeLine notice={notice} />}
      {phase.kind === "done" && <Outcome result={phase.result} />}
    </div>
  );
}

function Pending({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-body-sm text-secondary-foreground">
      <LoaderCircle
        size={16}
        strokeWidth={1.5}
        role="status"
        aria-label={label}
        className="animate-spin [animation-duration:800ms] motion-reduce:animate-none"
      />
      <span>{label}</span>
    </p>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <p className="mt-3 text-body-sm text-secondary-foreground">
      {notice.message}
      {notice.debugId && <DebugId id={notice.debugId} />}
    </p>
  );
}

function DebugId({ id }: { id: string }) {
  return (
    <>
      {" "}
      PayPal debug ID <span className="font-mono text-code-xs">{id}</span>.
    </>
  );
}

function Badge({ tone, label }: { tone: "positive" | "warning" | "danger"; label: string }) {
  const tones = {
    positive: "bg-positive-subtle text-on-positive-subtle-foreground",
    warning: "bg-warning-subtle text-on-warning-subtle-foreground",
    danger: "bg-danger-subtle text-on-danger-subtle-foreground",
  } as const;
  return (
    <span
      className={`inline-flex h-5 items-center rounded-md px-1.5 text-caption-lg font-medium ${tones[tone]}`}
    >
      {label}
    </span>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-body-sm text-secondary-foreground">{term}</dt>
      <dd className="font-mono text-code-sm tabular-nums text-primary-foreground">{value}</dd>
    </div>
  );
}

function Outcome({ result }: { result: PaymentResult }) {
  return (
    <div role="status" className="rounded-2xl bg-container p-4 shadow-border">
      {result.kind === "paid" && (
        <>
          <Badge tone="positive" label="Paid" />
          <dl className="mt-2 divide-y divide-border-subtle">
            <Detail term="Order ID" value={result.orderId} />
            <Detail term="Capture ID" value={result.captureId} />
            <Detail term="Amount" value={result.amount} />
          </dl>
        </>
      )}
      {result.kind === "not_paid" && (
        <>
          <Badge tone="warning" label="Payment not completed" />
          <p className="mt-2 text-body-sm text-secondary-foreground">
            PayPal status <span className="font-mono text-code-xs">{result.status}</span>.
          </p>
        </>
      )}
      {result.kind === "failed" && (
        <>
          <Badge tone="danger" label="Payment not completed" />
          <p className="mt-2 text-body-sm text-secondary-foreground">
            {result.message}
            {result.debugId && <DebugId id={result.debugId} />}
          </p>
        </>
      )}
    </div>
  );
}
