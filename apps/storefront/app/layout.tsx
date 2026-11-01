import { fontsHref, themeScript } from "@countersign/graphite/theme-script";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SHOP_NOTICE } from "../src/shop-props";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kikapu Studio",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a static script that sets the theme before first paint (DESIGN.md) */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={fontsHref} />
      </head>
      <body className="bg-page">
        <div className="mx-auto flex min-h-full w-full max-w-(--content-max) flex-col px-4 pt-8 pb-16 wide:px-14 wide:pt-12 wide:pb-24">
          <header>
            <Link
              href="/"
              className="inline-flex h-9 items-center text-body-sm font-semibold text-primary-foreground transition-colors duration-150 ease-out"
            >
              Kikapu Studio
            </Link>
          </header>
          <div className="flex-1 py-12 wide:py-16">{children}</div>
          <footer>
            <p className="text-caption-lg text-secondary-foreground">{SHOP_NOTICE}</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
