"use client";

import { ClipboardCheck, Inbox, type LucideIcon, Scale, ScrollText } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items: { href: string; label: string; Icon: LucideIcon }[] = [
  { href: "/inbox", label: "Inbox", Icon: Inbox },
  { href: "/approvals", label: "Approvals", Icon: ClipboardCheck },
  { href: "/decisions", label: "Decisions", Icon: Scale },
  { href: "/audit", label: "Audit log", Icon: ScrollText },
];

const openCards = (count: number) => ` open ${count === 1 ? "card" : "cards"}`;

// The sidebar's links. The current page's link is marked, never coloured blue (DESIGN.md).
// Approvals carries a neutral count badge of open cards when the approver is signed in.
export function ConsoleNav({ openApprovals = null }: { openApprovals?: number | null }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Console"
      className="flex min-w-0 flex-row gap-1 overflow-x-auto md:flex-col md:overflow-visible"
    >
      {items.map(({ href, label, Icon }) => {
        const current = pathname === href || pathname.startsWith(`${href}/`);
        const count =
          href === "/approvals" && openApprovals !== null && openApprovals > 0
            ? openApprovals
            : null;
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2 text-body-sm font-semimedium motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out ${
              current
                ? "bg-transparent-hover text-primary-foreground"
                : "text-secondary-foreground hover:bg-transparent-hover hover:text-primary-foreground"
            }`}
          >
            <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
            {label}
            {count !== null ? (
              <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-component px-1.5 text-caption-lg font-medium text-secondary-foreground tabular-nums">
                {count}
                <span className="sr-only">{openCards(count)}</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
