import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The runner's flag errors, through its command line. They exit 2 before it looks for a build,
// so they need neither the built apps nor Chromium. The full run is `npm run ui:shots`.

const SHOOT = resolve(import.meta.dirname, "shoot.ts");

function shoot(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SHOOT, ...args], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 60_000,
  });
}

describe("ui-shots flags", () => {
  it("exits 2 on an unknown screen", () => {
    const result = shoot("--only", "decisions,nope");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ui-shots: unknown screen nope");
  }, 60_000);

  it("exits 2 on an unknown check", () => {
    const result = shoot("--checks=shell,density");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ui-shots: unknown check density");
  }, 60_000);

  it("exits 2 on a theme or width it doesn't shoot", () => {
    expect(shoot("--theme", "sepia").status).toBe(2);
    expect(shoot("--width", "tablet").status).toBe(2);
  }, 60_000);
});
