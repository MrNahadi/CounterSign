import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Temp folders a test file makes, removed when the file ends. Close any PGlite handle on a
// folder before the file ends (afterEach), so nothing writes to it while it is removed.
export function trackedTempDirs() {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
}
