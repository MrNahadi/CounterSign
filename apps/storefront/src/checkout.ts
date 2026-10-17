// The storefront's checkout: create an order priced from the catalog, and capture only orders this
// shop made. The Next route handlers parse the request, call these and shape the response.
// Storefront orders get no tracker and no row in either seed table (ADR 0023).

import type { Money } from "@countersign/mandate";
import {
  createPayPalClient,
  type FetchLike,
  type PayPalClient,
  PayPalError,
  type PayPalOrder,
  parsePayPalEnv,
} from "@countersign/rail-paypal";
import { z } from "zod";
import { getProduct, type Product } from "./products";

export const CUSTOM_ID_PREFIX = "storefront:";
export const CAPTURE_REQUEST_PREFIX = "countersign-storefront-capture-";
const CREATE_REQUEST_PREFIX = "countersign-storefront-create-";

export type CheckoutError = { error: string };
export type PayPalFailure = { error: string; debugId: string | null };
export type CreateBody = { orderId: string };
export type CaptureBody =
  | { paid: true; orderId: string; captureId: string; amount: Money }
  | { paid: false; status: string };

export type CheckoutResult<T> =
  | { status: 200; body: T }
  | { status: 400 | 503; body: CheckoutError }
  | { status: 502; body: PayPalFailure };

export type CheckoutDeps = {
  // Undefined when the PayPal variables are missing or wrong: both routes answer 503.
  paypal: PayPalClient | undefined;
};

export type CreateDeps = CheckoutDeps & {
  // A fresh random ID per call, for the request ID and the reference ID.
  newId?: () => string;
};

export const NOT_SET_UP_MESSAGE =
  "Checkout isn't set up here. Add the PayPal sandbox variables to take payments.";

const NOT_SET_UP: CheckoutResult<never> = { status: 503, body: { error: NOT_SET_UP_MESSAGE } };

const CreateRequestSchema = z.object({ productId: z.string().min(1).max(64) });
const CaptureRequestSchema = z.object({ orderId: z.string().regex(/^[A-Z0-9]{10,32}$/) });

/** A PayPal client for checkout, or undefined when the sandbox variables are missing or wrong. */
export function checkoutPayPal(
  env: Readonly<Record<string, string | undefined>>,
  fetch?: FetchLike,
): PayPalClient | undefined {
  if (!parsePayPalEnv(env).ok) return undefined;
  return createPayPalClient({ env, fetch });
}

/** Creates a buyer-approved order for one product at its catalog price. Nothing else in the body counts. */
export async function createCheckoutOrder(
  body: unknown,
  deps: CreateDeps,
): Promise<CheckoutResult<CreateBody>> {
  if (!deps.paypal) return NOT_SET_UP;
  const parsed = CreateRequestSchema.safeParse(body);
  const product = parsed.success ? getProduct(parsed.data.productId) : undefined;
  if (!product) return { status: 400, body: { error: "That product isn't in the shop." } };

  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  const reference = `SHOP-${id
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(-8)
    .toUpperCase()}`;
  try {
    const order = await deps.paypal.createOrder({
      requestId: `${CREATE_REQUEST_PREFIX}${id}`,
      referenceId: reference,
      customId: `${CUSTOM_ID_PREFIX}${product.id}`,
      invoiceId: reference,
      items: [{ name: product.name, sku: product.id, quantity: 1, unitAmount: product.price }],
    });
    return { status: 200, body: { orderId: order.id } };
  } catch (error) {
    return paypalFailure(error);
  }
}

/** Captures an order only after reading it and finding it is this shop's, at the catalog price. */
export async function captureCheckoutOrder(
  params: unknown,
  deps: CheckoutDeps,
): Promise<CheckoutResult<CaptureBody>> {
  if (!deps.paypal) return NOT_SET_UP;
  const parsed = CaptureRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { status: 400, body: { error: "That isn't a PayPal order ID." } };
  }
  const { orderId } = parsed.data;
  try {
    const order = await deps.paypal.getOrder(orderId);
    const product = shopProduct(order);
    if (!product) {
      return {
        status: 400,
        body: { error: "This order wasn't made by this shop at its price, so it wasn't captured." },
      };
    }
    const captured = await deps.paypal.captureOrder(orderId, {
      requestId: `${CAPTURE_REQUEST_PREFIX}${orderId}`,
    });
    return { status: 200, body: captureOutcome(captured, product) };
  } catch (error) {
    return paypalFailure(error);
  }
}

// The catalog product an order was made for, only when it has one purchase unit whose custom ID
// names a product and whose amount is exactly that product's price.
function shopProduct(order: PayPalOrder): Product | undefined {
  if (order.purchaseUnits.length !== 1) return undefined;
  const [unit] = order.purchaseUnits;
  if (!unit?.customId?.startsWith(CUSTOM_ID_PREFIX)) return undefined;
  const product = getProduct(unit.customId.slice(CUSTOM_ID_PREFIX.length));
  if (!product || !sameMoney(unit.amount, product.price)) return undefined;
  return product;
}

// Paid only for one COMPLETED capture of the product's price. Anything else is not paid.
function captureOutcome(order: PayPalOrder, product: Product): CaptureBody {
  const captures = order.purchaseUnits.flatMap((unit) => unit.captures);
  const [capture] = captures;
  if (captures.length !== 1 || !capture) return { paid: false, status: order.status };
  if (capture.status !== "COMPLETED" || !sameMoney(capture.amount, product.price)) {
    return { paid: false, status: capture.status };
  }
  return { paid: true, orderId: order.id, captureId: capture.id, amount: capture.amount };
}

function sameMoney(a: Money, b: Money): boolean {
  return a.minor === b.minor && a.currency === b.currency;
}

// A PayPal failure becomes a plain 502 with the debug ID. Anything else is a bug and is rethrown.
function paypalFailure(error: unknown): CheckoutResult<never> {
  if (!(error instanceof PayPalError)) throw error;
  return {
    status: 502,
    body: {
      error: "PayPal couldn't complete the payment step. Try again.",
      debugId: error.debugId,
    },
  };
}
