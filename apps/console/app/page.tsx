import { ConsoleShell } from "./console-shell";

export default function ConsoleHome() {
  return (
    <ConsoleShell>
      <div className="p-6">
        <h1 className="text-heading-6 font-semibold tracking-heading">Console</h1>
        <p className="mt-1 text-body-sm text-secondary-foreground">
          Decisions, approvals and the audit log will appear here.
        </p>
      </div>
    </ConsoleShell>
  );
}
