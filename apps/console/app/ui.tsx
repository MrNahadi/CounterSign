import { CircleAlert, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

// Small pieces shared by the console's screens, built from Graphite's Badge, inline code and
// Spinner specs. No server-only imports, so client components can use them.

export type Tone = "neutral" | "positive" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-component text-secondary-foreground",
  positive: "bg-positive-subtle text-on-positive-subtle-foreground",
  warning: "bg-warning-subtle text-on-warning-subtle-foreground",
  danger: "bg-danger-subtle text-on-danger-subtle-foreground",
};

export function Badge({
  tone,
  live = false,
  children,
}: {
  tone: Tone;
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-caption-lg font-medium ${TONES[tone]}`}
    >
      {live ? (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
        />
      ) : null}
      {children}
    </span>
  );
}

export const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-sm bg-component px-1 py-0.5 font-mono text-code-xs break-all">
    {children}
  </code>
);

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <LoaderCircle
      size={size}
      strokeWidth={size > 16 ? 1.75 : 1.5}
      aria-hidden="true"
      className="motion-safe:animate-[spin_800ms_linear_infinite]"
    />
  );
}

export function Working({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-body-sm text-secondary-foreground">
      <Spinner />
      {label}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-body-sm text-secondary-foreground">
      <CircleAlert size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
