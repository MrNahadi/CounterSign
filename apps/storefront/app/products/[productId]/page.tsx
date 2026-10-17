import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { productPageProps } from "../../../src/shop-props";
import { PayPalCheckout } from "./paypal-checkout";

// Read the environment per request, so the build holds no PayPal value.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ productId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const props = productPageProps((await params).productId, {});
  return { title: props ? `${props.product.name} · Kikapu Studio` : "Kikapu Studio" };
}

export default async function ProductPage({ params }: Params) {
  const props = productPageProps((await params).productId, process.env);
  if (!props) notFound();
  const { product, checkout } = props;

  return (
    <main className="max-w-xl">
      <Link
        href="/"
        className="-ml-1.5 inline-flex h-6 items-center gap-1 rounded-lg px-2 pl-1.5 text-body-sm font-medium text-secondary-foreground transition-colors duration-150 ease-out hover:bg-transparent-hover hover:text-primary-foreground"
      >
        <ArrowLeft size={14} strokeWidth={1.5} aria-hidden="true" />
        <span>Back to shop</span>
      </Link>
      <h1 className="mt-6 text-heading-4 font-medium tracking-heading">{product.name}</h1>
      <p className="mt-2 text-body-base text-secondary-foreground">{product.description}</p>
      <p className="mt-4 font-mono text-code-sm tabular-nums text-primary-foreground">
        {product.price}
      </p>
      <section aria-label="Checkout" className="mt-8">
        {checkout.ready ? (
          <PayPalCheckout productId={product.id} clientId={checkout.clientId} />
        ) : (
          <p className="text-body-sm text-secondary-foreground">{checkout.message}</p>
        )}
      </section>
    </main>
  );
}
