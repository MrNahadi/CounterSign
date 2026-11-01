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

  it("has Decisions and Audit log after Approvals", () => {
    const nav = read("../app/console-nav.tsx");
    const approvals = nav.indexOf('href: "/approvals"');
    const decisions = nav.indexOf('{ href: "/decisions", label: "Decisions", Icon: Scale }');
    const audit = nav.indexOf('{ href: "/audit", label: "Audit log", Icon: ScrollText }');
    expect(approvals).toBeGreaterThan(-1);
    expect(decisions).toBeGreaterThan(approvals);
    expect(audit).toBeGreaterThan(decisions);
    expect(nav).toMatch(/import \{[^}]*\bScale\b[^}]*\bScrollText\b[^}]*\} from "lucide-react"/);
  });

  it("starts the sidebar with Start here, current on / only", () => {
    const nav = read("../app/console-nav.tsx");
    const start = nav.indexOf('{ href: "/", label: "Start here", Icon: Compass }');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(nav.indexOf('href: "/inbox"'));
    expect(nav).toMatch(/import \{[^}]*\bCompass\b[^}]*\} from "lucide-react"/);
    expect(nav).toContain('href === "/" ? pathname === "/"');
  });

  it("renders the start page at /, with no redirect", () => {
    const page = read("../app/page.tsx");
    expect(page).not.toContain("redirect(");
    expect(page).toContain("title: START_COPY.title");
    for (const key of [
      "START_COPY.heading",
      "START_COPY.line",
      "START_COPY.stepsHeading",
      "START_COPY.steps",
      "START_COPY.real",
      "START_COPY.simulated",
      "START_COPY.storefront",
      "storefrontLink(process.env)",
      "SCENARIO_CARDS",
    ]) {
      expect(page).toContain(key);
    }
    expect(page).toContain("<ConsoleShell");
  });

  it("signs in on the start page with the shared sign-in at level 2", () => {
    const page = read("../app/page.tsx");
    expect(page).toMatch(
      /<SignIn\s+level=\{2\}\s+title=\{START_COPY\.signIn\.title\}\s+line=\{START_COPY\.signIn\.line\}/,
    );
    expect(page).toContain("inboxAccess(key, { env: process.env })");
    const signIn = read("../app/sign-in.tsx");
    expect(signIn).toContain("level?: 1 | 2");
    expect(signIn).toContain('level === 1 ? "h1" : "h2"');
  });

  it("shows the guide and the unreachable notice when the gate can't check the key", () => {
    const page = read("../app/page.tsx");
    const unreachable = page.indexOf('access.state === "unreachable"');
    const notice = page.indexOf("<Notice>{access.message}</Notice>");
    expect(unreachable).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(unreachable);
    // The notice comes before the sign-in and the signed-in parts, and the guide always renders.
    expect(notice).toBeLessThan(page.indexOf("<SignIn"));
    expect(notice).toBeLessThan(page.indexOf("<ScenarioCard"));
    expect(page).toMatch(/<Sections>\s*<Guide \/>\s*\{rest\}\s*<\/Sections>/);
  });

  it("shares Open on your phone between the start page and the approvals board", () => {
    const shared = read("../app/open-on-phone.tsx");
    expect(shared).toContain("export function OpenOnPhone");
    expect(shared).toContain('className="hidden md:block"');
    const board = read("../app/approvals/approvals-board.tsx");
    expect(board).toContain('import { OpenOnPhone } from "../open-on-phone";');
    expect(board).not.toContain("function OpenOnPhone");
    expect(board).toContain("<OpenOnPhone qr={qr} />");
    expect(read("../app/page.tsx")).toContain("<OpenOnPhone");
  });

  it("keeps the start page's client parts free of server code, with a dialog for the reset", () => {
    const parts = read("../app/start-parts.tsx");
    expect(parts.startsWith('"use client";')).toBe(true);
    expect(parts).not.toMatch(/server-only|@countersign\/mandate|inbox-view|demo-routes/);
    expect(parts).toContain("showModal()");
    expect(parts).toContain('role="alert"');
    expect(parts).toContain("<Spinner");
  });

  it("has Disputes after Approvals, behind the shared sign-in, with its empty-state line", () => {
    const nav = read("../app/console-nav.tsx");
    const approvals = nav.indexOf('href: "/approvals"');
    const disputes = nav.indexOf('{ href: "/disputes", label: "Disputes", Icon: ShieldAlert }');
    const decisions = nav.indexOf('href: "/decisions"');
    expect(disputes).toBeGreaterThan(approvals);
    expect(decisions).toBeGreaterThan(disputes);
    expect(nav).toMatch(/import \{[^}]*\bShieldAlert\b[^}]*\} from "lucide-react"/);
    const page = read("../app/disputes/page.tsx");
    expect(page).toContain("line={DISPUTE_ROUTE_MESSAGES.signInLine}");
    expect(page).toContain("APPROVAL_ROUTE_MESSAGES.signInAgain");
    expect(page).toContain("{view.empty}");
    expect(page).toMatch(/className="overflow-x-auto[^"]*"\s*>\s*<table/);
    const button = read("../app/disputes/draft-again.tsx");
    expect(button.startsWith('"use client";')).toBe(true);
    expect(button).not.toMatch(/dispute-routes|server-only|@countersign\/mandate/);
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
