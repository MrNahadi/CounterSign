import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { shopListProps } from "../src/shop-props";

export default function ShopPage() {
  const products = shopListProps();
  return (
    <main>
      <h1 className="font-serif text-heading-3 font-medium tracking-heading">Kikapu Studio</h1>
      <p className="mt-2 text-body-base text-secondary-foreground">
        Handwoven baskets and bags from Kisumu.
      </p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {products.map((product) => (
          <li key={product.id}>
            <Link
              href={product.href}
              className="group flex h-full flex-col rounded-2xl bg-container p-4 shadow-border"
            >
              <span className="flex items-start justify-between gap-2">
                <span className="text-body-sm font-medium text-primary-foreground">
                  {product.name}
                </span>
                <ArrowRight
                  size={16}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className="shrink-0 text-secondary-foreground transition-colors duration-150 ease-out group-hover:text-primary-foreground"
                />
              </span>
              <span className="mt-1 text-body-sm text-secondary-foreground">
                {product.description}
              </span>
              <span className="mt-3 font-mono text-code-sm tabular-nums text-primary-foreground">
                {product.price}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
