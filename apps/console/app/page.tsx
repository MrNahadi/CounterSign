import { ShieldCheck } from "lucide-react";
import { ThemeControl } from "./theme-control";

export default function ConsoleHome() {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col p-4">
        <div className="flex items-center gap-2 text-body-sm font-semibold">
          <ShieldCheck size={16} strokeWidth={1.5} className="text-secondary-foreground" />
          Countersign
        </div>
        <div className="mt-auto">
          <ThemeControl />
        </div>
      </aside>
      <main className="my-2 mr-2 flex-1 rounded-2xl bg-container p-6 shadow-border">
        <h1 className="text-heading-6 font-semibold tracking-heading">Console</h1>
        <p className="mt-1 text-body-sm text-secondary-foreground">
          Decisions, approvals and the audit log will appear here.
        </p>
      </main>
    </div>
  );
}
