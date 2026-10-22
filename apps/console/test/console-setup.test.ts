import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The console's wiring for the inbox: the mandate's reason words are transpiled, and the sidebar
// links to the inbox. Read as text: importing next.config would load the local env file.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("console setup", () => {
  it("transpiles @countersign/mandate", () => {
    expect(read("../next.config.ts")).toMatch(
      /transpilePackages: \[[^\]]*"@countersign\/mandate"[^\]]*\]/,
    );
  });

  it("has a sidebar with Inbox and the theme control", () => {
    expect(read("../app/console-nav.tsx")).toContain(
      '{ href: "/inbox", label: "Inbox", Icon: Inbox }',
    );
    expect(read("../app/console-shell.tsx")).toContain("<ThemeControl />");
  });

  it("has Approvals in the sidebar, with the open-card count", () => {
    const nav = read("../app/console-nav.tsx");
    expect(nav).toContain('{ href: "/approvals", label: "Approvals", Icon: ClipboardCheck }');
    expect(nav).toContain("openApprovals");
    expect(read("../app/console-shell.tsx")).toContain("<ConsoleNav openApprovals={count} />");
  });

  it("has Decisions and Audit log after Approvals, and / redirects to Decisions", () => {
    const nav = read("../app/console-nav.tsx");
    const approvals = nav.indexOf('href: "/approvals"');
    const decisions = nav.indexOf('{ href: "/decisions", label: "Decisions", Icon: Scale }');
    const audit = nav.indexOf('{ href: "/audit", label: "Audit log", Icon: ScrollText }');
    expect(approvals).toBeGreaterThan(-1);
    expect(decisions).toBeGreaterThan(approvals);
    expect(audit).toBeGreaterThan(decisions);
    expect(nav).toMatch(/import \{[^}]*\bScale\b[^}]*\bScrollText\b[^}]*\} from "lucide-react"/);
    expect(read("../app/page.tsx")).toContain('redirect("/decisions")');
  });

  it("shows the shared sign-in with the decisions line, and scrolls the table in its box", () => {
    const page = read("../app/decisions/page.tsx");
    expect(page).toContain("line={AUDIT_ROUTE_MESSAGES.signInLine}");
    expect(page).toContain("APPROVAL_ROUTE_MESSAGES.signInAgain");
    expect(page).toMatch(/className="overflow-x-auto[^"]*"\s*>\s*<table/);
  });

  it("shows a decision's page behind the shared sign-in, stacking pairs at phone width", () => {
    for (const path of [
      "../app/decisions/[seq]/page.tsx",
      "../app/decisions/intent/[id]/page.tsx",
    ]) {
      const page = read(path);
      expect(page).toContain("line={AUDIT_ROUTE_MESSAGES.signInLine}");
      expect(page).toContain("APPROVAL_ROUTE_MESSAGES.signInAgain");
    }
    const page = read("../app/decisions/[seq]/page.tsx");
    expect(page).toContain("max-md:flex max-md:flex-col");
    expect(page).toMatch(/className="overflow-x-auto[^"]*"\s*>\s*<table/);
    expect(read("../app/decisions/intent/[id]/page.tsx")).toContain("redirect(outcome.href)");
    expect(read("../app/decisions/[seq]/copy-reply.tsx")).not.toContain("@countersign/mandate");
  });

  it("shows the audit log behind the shared sign-in, scrolling its table in its box", () => {
    const page = read("../app/audit/page.tsx");
    expect(page).toContain("line={AUDIT_ROUTE_MESSAGES.signInLine}");
    expect(page).toContain("APPROVAL_ROUTE_MESSAGES.signInAgain");
    expect(page).toMatch(/className="overflow-x-auto[^"]*"\s*>\s*<table/);
    expect(page).toContain("title={hash.full}");
  });

  it("keeps Resolve's address out of browser code", () => {
    for (const path of ["../app/console-nav.tsx", "../app/inbox/refresh-while-working.tsx"]) {
      expect(read(path)).not.toContain("RESOLVE_AGENT_URL");
    }
  });
});
