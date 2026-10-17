import { createCheckoutOrder } from "../../../src/checkout";
import { readJson, respond, serverPayPal } from "../../../src/checkout-route";

// Create order: the body names a product; the price comes from the catalog.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return respond(await createCheckoutOrder(await readJson(request), { paypal: serverPayPal() }));
}
