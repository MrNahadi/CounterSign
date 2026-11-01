// The Kikapu Studio product catalog, shared by the storefront and the seed. Prices are USD minor units.

import type { Money } from "@countersign/mandate";

export type Product = {
  id: string;
  name: string;
  description: string;
  price: Money;
};

const usd = (minor: number): Money => ({ minor, currency: "USD" });

export const PRODUCTS: readonly Product[] = [
  {
    id: "market-basket",
    name: "Market basket",
    description: "A sturdy sisal basket with two handles, made for the weekly shop.",
    price: usd(4800),
  },
  {
    id: "woven-tote",
    name: "Woven tote",
    description: "A soft, wide-mouthed tote in natural and indigo raffia.",
    price: usd(3600),
  },
  {
    id: "coaster-set",
    name: "Coaster set",
    description: "Four small coiled coasters in undyed sisal.",
    price: usd(1800),
  },
  {
    id: "floor-basket",
    name: "Floor basket",
    description: "A large lidded basket for blankets, toys or firewood.",
    price: usd(24000),
  },
  {
    id: "laundry-hamper",
    name: "Laundry hamper",
    description: "A tall hamper with a lid and a cotton liner.",
    price: usd(12000),
  },
  {
    id: "bread-basket",
    name: "Bread basket",
    description: "A shallow oval basket with a linen cloth for the table.",
    price: usd(2400),
  },
  {
    id: "clutch-bag",
    name: "Clutch bag",
    description: "A flat woven clutch with a leather strap.",
    price: usd(5600),
  },
  {
    id: "wall-plate",
    name: "Wall plate",
    description: "A round coiled plate to hang, in three natural tones.",
    price: usd(6400),
  },
];

/** The product with this ID, or undefined. Never guesses a near match. */
export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((product) => product.id === id);
}
