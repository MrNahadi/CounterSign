// The density checks the harness runs inside each page with Playwright's `page.evaluate`.
// `densityChecks` is serialized into the browser, so it must stay self-contained: no imports and
// no closures over this module. Named inner functions are fine, because `shoot.ts` gives every
// page the `__name` that tsx's keepNames wraps them in.

export type Finding = { check: string; detail: string };

export type DensityInput = {
  width: number;
  shell: boolean;
  phonePrimary: string[];
  /** A CSS selector: element-level checks look only inside it. `null` checks the whole page. */
  scope: string | null;
  /** Only these checks run. `null` runs them all. */
  checks: string[] | null;
};

/** Every check `--checks` may name. `theme` runs in `shoot.ts`; the rest in `densityChecks`. */
export const CHECK_NAMES = [
  "table-header",
  "table-rows",
  "hit-target",
  "small-text",
  "cards",
  "toolbar",
  "shell",
  "page",
  "overflow",
  "emoji",
  "uppercase",
  "theme",
] as const;

/** The density findings for the page it runs in. The checks themselves arrive in T-003. */
export function densityChecks(_input: DensityInput): Finding[] {
  return [];
}
