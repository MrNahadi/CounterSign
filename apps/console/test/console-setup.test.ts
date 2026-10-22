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

  it("keeps Resolve's address out of browser code", () => {
    for (const path of ["../app/console-nav.tsx", "../app/inbox/refresh-while-working.tsx"]) {
      expect(read(path)).not.toContain("RESOLVE_AGENT_URL");
    }
  });
});
