// What the shop's server pages pass to the browser. The environment is read at request time, and
// the only value from it that reaches the client is the public PayPal client ID.

import { formatMoney } from "@countersign/mandate";
import { parsePayPalEnv } from "@countersign/rail-paypal";
import { NOT_SET_UP_MESSAGE } from "./checkout";
import { getProduct, PRODUCTS, type Product } from "./products";

export const SHOP_NOTICE =
  "Kikapu Studio is an illustrative demo shop. Payments use the PayPal sandbox, so no real money moves.";

export type ShopItem = {
  id: string;
  name: string;
  description: string;
  price: string;
  href: string;
};

export type CheckoutSetup = { ready: true; clientId: string } | { ready: false; message: string };

export type ProductPageProps = { product: ShopItem; checkout: CheckoutSetup };

function shopItem(product: Product): ShopItem {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: formatMoney(product.price),
    href: `/products/${product.id}`,
  };
}

export function shopListProps(): ShopItem[] {
  return PRODUCTS.map(shopItem);
}

/** The product page's props, or undefined when no product has this ID. */
export function productPageProps(
  productId: string,
  env: Readonly<Record<string, string | undefined>>,
): ProductPageProps | undefined {
  const product = getProduct(productId);
  if (!product) return undefined;
  const paypal = parsePayPalEnv(env);
  const checkout: CheckoutSetup = paypal.ok
    ? { ready: true, clientId: paypal.config.clientId }
    : { ready: false, message: NOT_SET_UP_MESSAGE };
  return { product: shopItem(product), checkout };
}
