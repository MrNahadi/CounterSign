import { describe, expect, it } from "vitest";
import manifest from "../app/manifest";
import { approvalsUrl, QUIET_ZONE, qrView, requestOrigin } from "../src/qr-view";

describe("approvalsUrl", () => {
  it("uses CONSOLE_PUBLIC_URL when set", () => {
    expect(
      approvalsUrl({ publicUrl: "https://countersign.example/", origin: "http://localhost:3000" }),
    ).toBe("https://countersign.example/approvals");
  });
  it("falls back to the request origin", () => {
    expect(approvalsUrl({ publicUrl: undefined, origin: "http://192.168.1.5:3000" })).toBe(
      "http://192.168.1.5:3000/approvals",
    );
    expect(approvalsUrl({ publicUrl: "  ", origin: "http://192.168.1.5:3000" })).toBe(
      "http://192.168.1.5:3000/approvals",
    );
  });
  it("ignores a public URL that isn't http(s)", () => {
    expect(approvalsUrl({ publicUrl: "javascript:alert(1)", origin: "http://h:1" })).toBe(
      "http://h:1/approvals",
    );
  });
  it("is null when nothing usable is given", () => {
    expect(approvalsUrl({ publicUrl: "nope", origin: null })).toBeNull();
  });
});

describe("requestOrigin", () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? null });
  it("reads the forwarded protocol and host", () => {
    expect(requestOrigin(headers({ host: "a:1", "x-forwarded-proto": "https" }))).toBe(
      "https://a:1",
    );
    expect(requestOrigin(headers({ host: "a:1" }))).toBe("http://a:1");
    expect(requestOrigin(headers({}))).toBeNull();
  });
});

describe("qrView", () => {
  const view = qrView("https://countersign.example/approvals");
  it("draws rects inside the quiet zone, one module tall", () => {
    expect(view.rects.length).toBeGreaterThan(0);
    for (const r of view.rects) {
      expect(r.x).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(r.y).toBeGreaterThanOrEqual(QUIET_ZONE);
      expect(r.x + r.width).toBeLessThanOrEqual(view.size - QUIET_ZONE);
      expect(r.y).toBeLessThan(view.size - QUIET_ZONE);
    }
  });
  it("has the finder pattern's corner dark and labels the URL", () => {
    expect(view.rects).toContainEqual({ x: QUIET_ZONE, y: QUIET_ZONE, width: 7 });
    expect(view.label).toContain("https://countersign.example/approvals");
  });
  it("is deterministic", () => {
    expect(qrView(view.url)).toEqual(view);
  });
});

describe("manifest", () => {
  it("names the approvals app and carries no colours", () => {
    const m = manifest();
    expect(m).toMatchObject({
      name: "Countersign approvals",
      short_name: "Approvals",
      start_url: "/approvals",
      display: "standalone",
    });
    expect(m).not.toHaveProperty("theme_color");
    expect(m).not.toHaveProperty("background_color");
  });
});
