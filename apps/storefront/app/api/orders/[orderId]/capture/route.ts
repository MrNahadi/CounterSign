import { captureCheckoutOrder } from "../../../../../src/checkout";
import { respond, serverPayPal } from "../../../../../src/checkout-route";

// Capture: only an order this shop made, at its catalog price.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const { orderId } = await context.params;
  return respond(await captureCheckoutOrder({ orderId }, { paypal: serverPayPal() }));
}
