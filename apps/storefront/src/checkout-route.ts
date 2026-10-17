// Shared by the storefront's route handlers: one PayPal client per server process, so its token
// cache is reused, made from the environment at request time so the build holds no value.

import type { PayPalClient } from "@countersign/rail-paypal";
import { checkoutPayPal } from "./checkout";

let client: PayPalClient | undefined;

export function serverPayPal(): PayPalClient | undefined {
  client ??= checkoutPayPal(process.env);
  return client;
}

/** The request's JSON body, or undefined when it has none or it isn't JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function respond(result: { status: number; body: unknown }): Response {
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
