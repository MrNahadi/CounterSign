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

/**
 * The density findings for the page it runs in, measured against DESIGN.md's rules (design.md
 * step 2b). Element-level checks look only inside `scope` when it's set; `overflow` and `shell`
 * always look at the whole page.
 */
export function densityChecks(input: DensityInput): Finding[] {
  const findings: Finding[] = [];
  // Sub-pixel layout: a measured 55.99px row is a 56px row.
  const EPSILON = 0.5;

  function runs(check: string): boolean {
    return input.checks === null || input.checks.includes(check);
  }

  function fail(check: string, detail: string): void {
    findings.push({ check, detail });
  }

  function px(value: number): string {
    return `${Math.round(value * 10) / 10}px`;
  }

  function label(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const text = (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") return `${tag} "${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`;
    return el.id === "" ? tag : `${tag}#${el.id}`;
  }

  function visible(el: Element): boolean {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && el.closest(".sr-only") === null;
  }

  function roots(): Element[] {
    if (input.scope === null) return [document.body];
    return Array.from(document.querySelectorAll(input.scope));
  }

  /** Visible elements matching `selector` inside the scope (the root itself included). */
  function find(selector: string): Element[] {
    const found = new Set<Element>();
    for (const root of roots()) {
      if (root.matches(selector)) found.add(root);
      for (const el of Array.from(root.querySelectorAll(selector))) found.add(el);
    }
    return Array.from(found).filter(visible);
  }

  function ownText(el: Element): boolean {
    return Array.from(el.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
    );
  }

  function fontSize(el: Element): number {
    return Number.parseFloat(getComputedStyle(el).fontSize);
  }

  if (runs("table-header")) {
    for (const th of find("thead th")) {
      const style = getComputedStyle(th);
      if (style.display !== "table-cell") continue;
      const height = th.getBoundingClientRect().height;
      const problems: string[] = [];
      if (Math.abs(height - 44) > 1) problems.push(`${px(height)} tall, not 44px`);
      if (Math.abs(fontSize(th) - 13) > 0.1) problems.push(`${px(fontSize(th))} text, not 13px`);
      if (Number(style.fontWeight) !== 500) problems.push(`weight ${style.fontWeight}, not 500`);
      if (style.textTransform !== "none") problems.push(`text-transform ${style.textTransform}`);
      if (problems.length > 0) fail("table-header", `${label(th)}: ${problems.join(", ")}`);
    }
  }

  if (runs("table-rows")) {
    for (const tr of find("tbody tr")) {
      if (getComputedStyle(tr).display !== "table-row") continue;
      const height = tr.getBoundingClientRect().height;
      if (height < 56 - EPSILON) fail("table-rows", `${label(tr)}: ${px(height)} tall, under 56px`);
      for (const td of Array.from(tr.querySelectorAll(":scope > td")).filter(visible)) {
        const size = fontSize(td);
        if (size < 14 - 0.1) fail("table-rows", `${label(td)}: ${px(size)} text, under 14px`);
      }
    }
  }

  if (runs("hit-target")) {
    const primary = new Set(input.phonePrimary);
    const targets = find('button, input:not([type="hidden"]), select, textarea, a').filter((el) => {
      if (el.tagName !== "A") return true;
      const display = getComputedStyle(el).display;
      return display === "flex" || display === "inline-flex";
    });
    for (const el of targets) {
      const height = el.getBoundingClientRect().height;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const floor = el.tagName === "BUTTON" && primary.has(text) ? 44 : 28;
      if (height < floor - EPSILON) {
        fail("hit-target", `${label(el)}: ${px(height)} tall, under ${floor}px`);
      }
    }
  }

  if (runs("small-text")) {
    for (const el of find("*")) {
      if (!ownText(el)) continue;
      const size = fontSize(el);
      if (size < 12 - 0.1) fail("small-text", `${label(el)}: ${px(size)} text, under 12px`);
    }
  }

  if (runs("cards")) {
    const minimums: [string, number][] = [
      ['[data-graphite="card"]', 24],
      ['[data-graphite="card-nested"]', 16],
    ];
    for (const [selector, minimum] of minimums) {
      for (const card of find(selector)) {
        const style = getComputedStyle(card);
        const sides: [string, string][] = [
          ["top", style.paddingTop],
          ["right", style.paddingRight],
          ["bottom", style.paddingBottom],
          ["left", style.paddingLeft],
        ];
        const thin = sides.filter(([, value]) => Number.parseFloat(value) < minimum - EPSILON);
        if (thin.length > 0) {
          const list = thin.map(([side, value]) => `${side} ${value}`).join(", ");
          fail("cards", `${label(card)}: padding ${list}, under ${minimum}px`);
        }
      }
    }
    // Cards in a stack or grid sit 24px apart (--grid-gap). Nested cards sit inside a card's
    // 20px block gap, so only top-level cards are paired here.
    const cards = find('[data-graphite="card"]');
    const groups = new Map<Element, Element[]>();
    for (const card of cards) {
      const parent = card.parentElement;
      if (parent === null) continue;
      // A grid item wrapping a lone card (the storefront's `li`) groups by the grid instead.
      const key =
        parent.children.length === 1 && parent.parentElement ? parent.parentElement : parent;
      const group = groups.get(key) ?? [];
      group.push(card);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i].getBoundingClientRect();
          const b = group[j].getBoundingClientRect();
          const gap = Math.max(
            b.left - a.right,
            a.left - b.right,
            b.top - a.bottom,
            a.top - b.bottom,
          );
          if (gap < 24 - EPSILON) {
            fail(
              "cards",
              `${label(group[i])} and ${label(group[j])}: ${px(gap)} apart, under 24px`,
            );
          }
        }
      }
    }
  }

  if (runs("toolbar") && input.width >= 768) {
    for (const bar of find('[data-graphite="toolbar"]')) {
      const tops = Array.from(bar.children)
        .filter(visible)
        .map((child) => child.getBoundingClientRect().top);
      if (tops.length < 2) continue;
      const spread = Math.max(...tops) - Math.min(...tops);
      if (spread > 4)
        fail("toolbar", `${label(bar)}: wraps, its children's tops ${px(spread)} apart`);
    }
  }

  if (runs("shell") && input.shell) {
    const view = document.documentElement.clientWidth;
    const main = document.querySelector("main");
    if (main === null) {
      fail("shell", "no main element");
    } else {
      const box = main.getBoundingClientRect();
      const top = box.top + window.scrollY;
      const right = view - box.right;
      const left = box.left;
      if (input.width >= 768) {
        const aside = document.querySelector("aside");
        const asideWidth = aside === null ? 0 : aside.getBoundingClientRect().width;
        if (aside === null) fail("shell", "no aside element");
        else if (Math.abs(asideWidth - 260) > EPSILON) {
          fail("shell", `aside is ${px(asideWidth)} wide, not 260px`);
        }
        for (const link of Array.from(document.querySelectorAll('nav[aria-label="Console"] a'))) {
          const height = link.getBoundingClientRect().height;
          if (Math.abs(height - 36) > EPSILON) {
            fail("shell", `nav ${label(link)}: ${px(height)} tall, not 36px`);
          }
        }
        if (Math.abs(top - 8) > EPSILON) fail("shell", `main is ${px(top)} from the top, not 8px`);
        if (Math.abs(right - 8) > EPSILON) {
          fail("shell", `main is ${px(right)} from the right, not 8px`);
        }
        const radius = Number.parseFloat(getComputedStyle(main).borderTopLeftRadius);
        if (Math.abs(radius - 12) > EPSILON)
          fail("shell", `main's radius is ${px(radius)}, not 12px`);
      } else {
        if (Math.abs(left - 8) > EPSILON)
          fail("shell", `main is ${px(left)} from the left, not 8px`);
        if (Math.abs(right - 8) > EPSILON) {
          fail("shell", `main is ${px(right)} from the right, not 8px`);
        }
      }
    }
  }

  if (runs("page")) {
    const wide = input.width >= 900;
    const wantTop = wide ? 48 : 32;
    const wantSide = wide ? 56 : 16;
    for (const el of find('[data-graphite="page"]')) {
      const style = getComputedStyle(el);
      const top = Number.parseFloat(style.paddingTop);
      const left = Number.parseFloat(style.paddingLeft);
      const right = Number.parseFloat(style.paddingRight);
      if (
        Math.abs(top - wantTop) > EPSILON ||
        Math.abs(left - wantSide) > EPSILON ||
        Math.abs(right - wantSide) > EPSILON
      ) {
        fail(
          "page",
          `padding ${px(top)} top, ${px(left)} left, ${px(right)} right; not ${wantTop}px top and ${wantSide}px sides`,
        );
      }
    }
  }

  if (runs("overflow")) {
    // The layout viewport, not `innerWidth`: on a mobile viewport Chromium zooms out to fit
    // overflowing content, which grows `innerWidth` to the page's width and hides the overflow.
    const view = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    if (scrollWidth > view) {
      fail("overflow", `the page is ${scrollWidth}px wide in a ${view}px viewport`);
    }
  }

  if (runs("emoji")) {
    const pictographic = /\p{Extended_Pictographic}/gu;
    for (const root of roots()) {
      const text = root instanceof HTMLElement ? root.innerText : (root.textContent ?? "");
      const hits = text.match(pictographic);
      if (hits !== null) {
        const count =
          hits.length === 1 ? "1 pictographic character" : `${hits.length} pictographic characters`;
        fail("emoji", `${count}: ${hits.join(" ")}`);
      }
    }
  }

  if (runs("uppercase")) {
    for (const el of find("*")) {
      if (!ownText(el)) continue;
      if (getComputedStyle(el).textTransform === "uppercase") {
        fail("uppercase", `${label(el)}: text-transform uppercase`);
      }
    }
  }

  return findings;
}
