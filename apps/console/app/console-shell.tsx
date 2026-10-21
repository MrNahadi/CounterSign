import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { ConsoleNav } from "./console-nav";
import { ThemeControl } from "./theme-control";

// The app frame (DESIGN.md's layout model): the sidebar sits on the shell, and the page is one
// container panel inset 8px. On a phone the sidebar becomes a row above the panel.
export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-row items-center gap-4 px-4 pt-3 pb-1 md:w-60 md:flex-col md:items-stretch md:p-4">
        <div className="flex h-8 items-center gap-2 px-2 text-body-sm font-semibold">
          <ShieldCheck
            size={16}
            strokeWidth={1.5}
            className="text-secondary-foreground"
            aria-hidden="true"
          />
          Countersign
        </div>
        <ConsoleNav />
        <div className="ml-auto md:mt-auto md:ml-0">
          <ThemeControl />
        </div>
      </aside>
      <main className="m-2 flex min-w-0 flex-1 flex-col rounded-2xl bg-container shadow-border md:ml-0">
        {children}
      </main>
    </div>
  );
}
