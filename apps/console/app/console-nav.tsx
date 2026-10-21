"use client";

import { Inbox, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items: { href: string; label: string; Icon: LucideIcon }[] = [
  { href: "/inbox", label: "Inbox", Icon: Inbox },
];

// The sidebar's links. The current page's link is marked, never coloured blue (DESIGN.md).
export function ConsoleNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Console" className="flex flex-row gap-1 md:flex-col">
      {items.map(({ href, label, Icon }) => {
        const current = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`flex h-8 items-center gap-2 rounded-lg px-2 text-body-sm font-semimedium motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out ${
              current
                ? "bg-transparent-hover text-primary-foreground"
                : "text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground"
            }`}
          >
            <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
