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
      <ul className="mt-7 grid gap-(--grid-gap) sm:grid-cols-2 lg:grid-cols-3">
        {products.map((product) => (
          <li key={product.id}>
            <Link
              href={product.href}
              data-graphite="card"
              className="group flex h-full flex-col gap-5 rounded-3xl bg-container p-(--card-padding) shadow-border"
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-start justify-between gap-2">
                  <span className="text-body-base font-semibold tracking-heading text-primary-foreground">
                    {product.name}
                  </span>
                  <ArrowRight
                    size={16}
                    strokeWidth={1.5}
                    aria-hidden="true"
                    className="shrink-0 text-secondary-foreground transition-colors duration-150 ease-out group-hover:text-primary-foreground"
                  />
                </span>
                <span className="text-caption-lg text-secondary-foreground">
                  {product.description}
                </span>
              </span>
              <span className="font-mono text-code-sm tabular-nums text-primary-foreground">
                {product.price}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
