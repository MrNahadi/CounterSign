import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { CHECK_NAMES, type DensityInput, densityChecks, type Finding } from "./checks";
import { FIXTURE_IDS, fixtures } from "./fixtures";
import { HARNESS_KEY, HARNESS_PAIRING_CODE, startUpstream } from "./upstream";

// `npm run ui:shots`: starts the fake gate and Resolve, both built Next apps and Chromium, then
// shoots every screen in light and dark at desktop and phone widths, runs the density checks in
// each page and writes test-results/ui-shots/*.png and report.json. Exit 0 with no findings,
// 1 with findings, 2 when it can't run (no build, no Chromium, a bad flag).

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "test-results", "ui-shots");
const APPROVER_COOKIE = "countersign_approver";
const START_TIMEOUT_MS = 60_000;
const GOTO_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 5_000;
const FONTS_TIMEOUT_MS = 5_000;

const APPS = {
  console: { dir: join(ROOT, "apps", "console"), port: 3100 },
  storefront: { dir: join(ROOT, "apps", "storefront"), port: 3101 },
} as const;
type AppName = keyof typeof APPS;

type Screen = {
  name: string;
  app: AppName;
  path: string;
  signedIn: boolean;
  shell: boolean;
  scope: string | null;
};

const SCREENS: readonly Screen[] = [
  // The start page: scenarios, the phone code (from 768px) and the reset once signed in.
  { name: "start", app: "console", path: "/", signedIn: true, shell: true, scope: null },
  {
    name: "start-signed-out",
    app: "console",
    path: "/",
    signedIn: false,
    shell: true,
    scope: null,
  },
  {
    // The phone opens the QR link after its code was used: the gate's sentence above the sign-in.
    name: "approvals-code-used",
    app: "console",
    path: `/approvals#pair=${HARNESS_PAIRING_CODE}`,
    signedIn: false,
    shell: true,
    scope: null,
  },
  { name: "inbox", app: "console", path: "/inbox", signedIn: true, shell: true, scope: null },
  {
    name: "inbox-thread",
    app: "console",
    path: `/inbox?thread=${FIXTURE_IDS.threadId}`,
    signedIn: true,
    shell: true,
    scope: null,
  },
  {
    name: "approvals",
    app: "console",
    path: "/approvals",
    signedIn: true,
    shell: true,
    scope: null,
  },
  {
    name: "approvals-signed-out",
    app: "console",
    path: "/approvals",
    signedIn: false,
    shell: true,
    scope: null,
  },
  { name: "disputes", app: "console", path: "/disputes", signedIn: true, shell: true, scope: null },
  {
    name: "decisions",
    app: "console",
    path: "/decisions",
    signedIn: true,
    shell: true,
    scope: null,
  },
  {
    name: "decision",
    app: "console",
    path: `/decisions/${FIXTURE_IDS.readableSeq}`,
    signedIn: true,
    shell: true,
    scope: null,
  },
  {
    name: "decision-unreadable",
    app: "console",
    path: `/decisions/${FIXTURE_IDS.unreadableSeq}`,
    signedIn: true,
    shell: true,
    scope: null,
  },
  { name: "audit", app: "console", path: "/audit", signedIn: true, shell: true, scope: null },
  {
    name: "audit-check",
    app: "console",
    path: "/audit?check=1",
    signedIn: true,
    shell: true,
    scope: null,
  },
  // "Attack it yourself": the form under the visitor counter, then a finished attack's thread.
  { name: "attack", app: "console", path: "/attack", signedIn: true, shell: true, scope: null },
  {
    name: "attack-thread",
    app: "console",
    path: `/attack?thread=${FIXTURE_IDS.threadId}`,
    signedIn: true,
    shell: true,
    scope: null,
  },
  // The Risk desk: with no AG Studio key in the harness, the AG Grid Community view.
  { name: "risk", app: "console", path: "/risk", signedIn: true, shell: true, scope: null },
  { name: "chat", app: "console", path: "/chat", signedIn: false, shell: false, scope: null },
  { name: "shop", app: "storefront", path: "/", signedIn: false, shell: false, scope: null },
  {
    name: "product",
    app: "storefront",
    path: `/products/${FIXTURE_IDS.productId}`,
    signedIn: false,
    shell: false,
    scope: null,
  },
];

const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const WIDTHS = {
  desktop: { viewport: { width: 1440, height: 900 }, mobile: false },
  phone: { viewport: { width: 390, height: 844 }, mobile: true },
} as const;
type Width = keyof typeof WIDTHS;

const PHONE_PRIMARY = ["Approve", "Deny", "Sign in"];
const PHONE_PRIMARY_SCREENS = new Set(["approvals", "approvals-signed-out", "approvals-code-used"]);

/** A reason the run can't go ahead: printed as is, exit 2. */
class CantRun extends Error {}

// --- Flags ---------------------------------------------------------------------------------

type Options = {
  only: string[] | null;
  checks: string[] | null;
  theme: Theme | null;
  width: Width | null;
};

function listOf(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function parseFlags(argv: string[]): Options {
  const options: Options = { only: null, checks: null, theme: null, width: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? argv[++index] : arg.slice(eq + 1);
    if (value === undefined) throw new CantRun(`ui-shots: ${flag} needs a value`);
    if (flag === "--only") {
      const names = listOf(value);
      const unknown = names.filter((name) => !SCREENS.some((screen) => screen.name === name));
      if (unknown.length > 0) throw new CantRun(`ui-shots: unknown screen ${unknown.join(", ")}`);
      options.only = names;
    } else if (flag === "--checks") {
      const names = listOf(value);
      const known: readonly string[] = CHECK_NAMES;
      const unknown = names.filter((name) => !known.includes(name));
      if (unknown.length > 0) throw new CantRun(`ui-shots: unknown check ${unknown.join(", ")}`);
      options.checks = names;
    } else if (flag === "--theme") {
      if (value !== "light" && value !== "dark") {
        throw new CantRun(`ui-shots: --theme is light or dark, not ${value}`);
      }
      options.theme = value;
    } else if (flag === "--width") {
      if (value !== "desktop" && value !== "phone") {
        throw new CantRun(`ui-shots: --width is desktop or phone, not ${value}`);
      }
      options.width = value;
    } else {
      throw new CantRun(`ui-shots: unknown flag ${flag}`);
    }
  }
  return options;
}

function screensFor(options: Options): Screen[] {
  if (options.only !== null) {
    const only = options.only;
    return SCREENS.filter((screen) => only.includes(screen.name));
  }
  // `--checks shell,theme` (or `shell` alone) is about the console shell: only its screens.
  const shellOnly =
    options.checks?.includes("shell") === true &&
    options.checks.every((check) => check === "shell" || check === "theme");
  return SCREENS.filter((screen) => !shellOnly || screen.shell);
}

// --- The apps ------------------------------------------------------------------------------

type Started = { name: AppName; child: ChildProcess; exited: Promise<void> };

function startApp(name: AppName, env: NodeJS.ProcessEnv): Started {
  const app = APPS[name];
  const child = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(app.port)], {
    cwd: app.dir,
    env,
    // Its own process group, so stopping it stops next's server under npx too.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(join(OUT, `${name}.log`));
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const exited = new Promise<void>((done) => {
    child.once("exit", () => done());
    child.once("error", () => done());
  });
  return { name, child, exited };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

async function stopApp(app: Started): Promise<void> {
  killGroup(app.child, "SIGTERM");
  const late = await Promise.race([
    app.exited.then(() => false),
    new Promise<boolean>((done) => setTimeout(() => done(true), 5_000)),
  ]);
  if (late) killGroup(app.child, "SIGKILL");
  await Promise.race([app.exited, new Promise((done) => setTimeout(done, 2_000))]);
}

async function waitForHttp(app: Started): Promise<void> {
  const { port } = APPS[app.name];
  const deadline = Date.now() + START_TIMEOUT_MS;
  let gone = false;
  void app.exited.then(() => {
    gone = true;
  });
  while (Date.now() < deadline && !gone) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  throw new CantRun(
    `ui-shots: the ${app.name} didn't answer on port ${port}; see test-results/ui-shots/${app.name}.log`,
  );
}

// --- Shooting ------------------------------------------------------------------------------

type Shot = { name: string; file: string; findings: Finding[] };

const INIT_NAME_SCRIPT = "globalThis.__name = (fn) => fn;";

function wants(options: Options, check: string): boolean {
  return options.checks === null || options.checks.includes(check);
}

async function shoot(
  browser: Browser,
  screen: Screen,
  theme: Theme,
  width: Width,
  options: Options,
  notes: string[],
  backgrounds: Map<string, string>,
): Promise<Shot> {
  const name = `${screen.name}-${theme}-${width}`;
  const file = join("test-results", "ui-shots", `${name}.png`);
  const findings: Finding[] = [];
  const { viewport, mobile } = WIDTHS[width];
  const origin = `http://127.0.0.1:${APPS[screen.app].port}`;
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
  });
  try {
    await context.addInitScript({ content: INIT_NAME_SCRIPT });
    if (screen.signedIn) {
      await context.addCookies([
        {
          name: APPROVER_COOKIE,
          value: HARNESS_KEY,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
    }
    const page = await context.newPage();
    try {
      await page.goto(`${origin}${screen.path}`, {
        waitUntil: "load",
        timeout: GOTO_TIMEOUT_MS,
      });
    } catch (error) {
      findings.push({ check: "load", detail: firstLine(error) });
      return { name, file, findings };
    }
    // The approvals board polls every 3 seconds, so the page may never go idle.
    await page.waitForLoadState("networkidle", { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
    // With no network to Google Fonts the stylesheet never arrives, so no face loads at all.
    const fontsLoaded = await page.evaluate(
      (timeoutMs) =>
        Promise.race([
          document.fonts.ready.then(() => {
            const faces = Array.from(document.fonts);
            return (
              faces.some((font) => font.status === "loaded") &&
              faces.every((font) => font.status !== "error")
            );
          }),
          new Promise<boolean>((done) => setTimeout(() => done(false), timeoutMs)),
        ]),
      FONTS_TIMEOUT_MS,
    );
    if (!fontsLoaded) notes.push(`note ${name} fonts: fallback fonts`);

    const look = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      background: getComputedStyle(document.body).backgroundColor,
    }));
    backgrounds.set(name, look.background);
    if (wants(options, "theme") && look.dark !== (theme === "dark")) {
      findings.push({
        check: "theme",
        detail: `html.dark is ${look.dark ? "set" : "unset"} in the ${theme} theme`,
      });
    }

    const input: DensityInput = {
      width: viewport.width,
      shell: screen.shell,
      phonePrimary: PHONE_PRIMARY_SCREENS.has(screen.name) ? PHONE_PRIMARY : [],
      scope: screen.scope,
      checks: options.checks,
    };
    findings.push(...(await page.evaluate(densityChecks, input)));
    await page.screenshot({ path: join(ROOT, file), fullPage: true });
  } finally {
    await context.close();
  }
  return { name, file, findings };
}

/** Each screen's body background must differ between light and dark, width by width. */
function themeContrast(shots: Shot[], backgrounds: Map<string, string>): void {
  for (const shot of shots) {
    const match = /^(.*)-dark-(desktop|phone)$/.exec(shot.name);
    if (match === null) continue;
    const light = backgrounds.get(`${match[1]}-light-${match[2]}`);
    const dark = backgrounds.get(shot.name);
    if (light === undefined || dark === undefined || light !== dark) continue;
    shot.findings.push({
      check: "theme",
      detail: `the body background is ${dark} in both light and dark`,
    });
  }
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}

async function launch(): Promise<Browser> {
  const executablePath = process.env.UI_SHOTS_CHROMIUM?.trim() || undefined;
  try {
    return await chromium.launch(executablePath === undefined ? {} : { executablePath });
  } catch (error) {
    process.stderr.write(`${firstLine(error)}\n`);
    throw new CantRun(
      "ui-shots: no Chromium. Run npx playwright install chromium, or set UI_SHOTS_CHROMIUM.",
    );
  }
}

// --- The run -------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];

async function cleanUp(): Promise<void> {
  while (cleanups.length > 0) {
    const step = cleanups.pop();
    await step?.().catch(() => {});
  }
}

async function run(): Promise<number> {
  const options = parseFlags(process.argv.slice(2));
  for (const app of Object.values(APPS)) {
    if (!existsSync(join(app.dir, ".next", "BUILD_ID"))) {
      throw new CantRun("ui-shots: run npm run build first");
    }
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const browser = await launch();
  cleanups.push(() => browser.close());

  const upstream = await startUpstream(fixtures(new Date())).catch((error: unknown) => {
    throw new CantRun(`ui-shots: the fake upstreams can't start: ${firstLine(error)}`);
  });
  cleanups.push(() => upstream.close());

  const base = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const started = [
    startApp("console", {
      ...base,
      GATE_URL: upstream.gateUrl,
      RESOLVE_AGENT_URL: upstream.resolveUrl,
    }),
    startApp("storefront", base),
  ];
  for (const app of started) cleanups.push(() => stopApp(app));
  await Promise.all(started.map(waitForHttp));

  const screens = screensFor(options);
  const themes = THEMES.filter((theme) => options.theme === null || options.theme === theme);
  const widths = (Object.keys(WIDTHS) as Width[]).filter(
    (width) => options.width === null || options.width === width,
  );
  const shots: Shot[] = [];
  const notes: string[] = [];
  const backgrounds = new Map<string, string>();
  for (const screen of screens) {
    for (const theme of themes) {
      for (const width of widths) {
        shots.push(await shoot(browser, screen, theme, width, options, notes, backgrounds));
      }
    }
  }
  if (wants(options, "theme")) themeContrast(shots, backgrounds);

  writeFileSync(join(OUT, "report.json"), `${JSON.stringify({ shots }, null, 2)}\n`);
  let failures = 0;
  for (const shot of shots) {
    for (const finding of shot.findings) {
      failures++;
      console.log(`FAIL ${shot.name} ${finding.check}: ${finding.detail}`);
    }
  }
  for (const note of notes) console.log(note);
  console.log(`ui-shots: ${shots.length} shots, ${failures} failures`);
  return failures > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  let code: number;
  try {
    code = await run();
  } catch (error) {
    if (error instanceof CantRun) {
      console.error(error.message);
      code = 2;
    } else {
      console.error(`ui-shots: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
      code = 2;
    }
  } finally {
    await cleanUp();
  }
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void cleanUp().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

await main();
