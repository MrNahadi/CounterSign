import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// PLAN.md F3: Render's free plan has no cron jobs, so GitHub Actions runs the scheduled jobs.
// reconcile.yml does what the cron's start command did (reconcile, then sync disputes even when
// reconcile failed, failing if either fails), every 15 minutes. smoke.yml runs the smoke test
// daily at 06:17 UTC and on demand, at public URLs from repository variables. `problems()` lists
// what is wrong, so the mutation cases below show each invariant is checked.

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  "runs-on": string;
  "timeout-minutes"?: number;
  env?: Record<string, unknown>;
  steps: Step[];
};
type Workflow = {
  name: string;
  // `on` parses as the key "on" in YAML 1.2 (the yaml package's default).
  on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown; [key: string]: unknown };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const ROOT = join(import.meta.dirname, "..");
const SANDBOX_URL = "https://api-m.sandbox.paypal.com";
const NODE_VERSION = "26.7.0";

// The secrets each workflow may read, and the repository variables. OWNER.md lists the secrets.
const SECRETS = [
  "DATABASE_URL",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "RESOLVE_SHARED_SECRET",
];
const SMOKE_VARS = {
  GATE_URL: "--gate",
  RESOLVE_AGENT_URL: "--resolve",
  CONSOLE_URL: "--console",
  STOREFRONT_URL: "--storefront",
} as const;

const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;

function load(file: string): Workflow {
  return parse(readFileSync(join(ROOT, ".github", "workflows", file), "utf8")) as Workflow;
}

function onlyJob(workflow: Workflow): Job | undefined {
  const jobs = Object.values(workflow.jobs ?? {});
  return jobs.length === 1 ? jobs[0] : undefined;
}

// Invariants both workflows share.
function common(workflow: Workflow, note: (text: string) => void): Job | undefined {
  const job = onlyJob(workflow);
  if (!job) {
    note("does not have exactly one job");
    return undefined;
  }
  // Read-only token: neither job writes to the repository.
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) {
    note("token permissions are not contents: read");
  }
  if (typeof job["timeout-minutes"] !== "number" || job["timeout-minutes"] > 15) {
    note("has no timeout of 15 minutes or less");
  }
  const steps = job.steps ?? [];
  for (const step of steps) {
    // Every action pinned to a full commit SHA, so a moved tag can't change what runs.
    if (step.uses !== undefined && !PINNED.test(step.uses)) note(`${step.uses} is not pinned`);
  }
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  if (!checkout) note("does not check out the repository");
  else if (checkout.with?.["persist-credentials"] !== false) note("checkout keeps its token");
  const setup = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  if (String(setup?.with?.["node-version"]) !== NODE_VERSION) {
    note(`does not set up Node ${NODE_VERSION}`);
  }
  const install = steps.findIndex((step) => step.run?.trim() === "npm ci");
  if (install === -1) note("does not run npm ci");
  if (setup && install !== -1 && steps.indexOf(setup) > install) note("installs before Node");

  // Secrets only from repository secrets, never a value in the file.
  for (const [key, value] of Object.entries({ ...job.env })) {
    if (SECRETS.includes(key) && value !== `\${{ secrets.${key} }}`) {
      note(`${key} is not the repository secret of that name`);
    }
  }
  for (const step of steps) {
    if (step.env !== undefined) note(`step ${step.name ?? step.uses ?? step.run} sets env`);
  }
  return job;
}

function names(text: string): string[] {
  return [...text.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].map((match) => match[1] ?? "");
}

// The configuration check: a step before any work that fails on each of these names when empty.
function checksConfig(job: Job, wanted: string[], note: (text: string) => void): void {
  const first = job.steps?.[0];
  const loop =
    first?.run
      ?.match(/for name in ([\w ]+); do/)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  if (!/-z "\$\{!name\}"/.test(first?.run ?? "") || !/exit "\$missing"/.test(first?.run ?? "")) {
    note("the first step does not fail on missing configuration");
  }
  if (JSON.stringify([...loop].sort()) !== JSON.stringify([...wanted].sort())) {
    note(`the configuration check covers ${loop.join(", ")}`);
  }
}

function reconcileProblems(workflow: Workflow, text: string): string[] {
  const found: string[] = [];
  const note = (message: string) => found.push(`reconcile: ${message}`);
  const crons = (workflow.on?.schedule ?? []).map((entry) => entry.cron);
  if (JSON.stringify(crons) !== JSON.stringify(["*/15 * * * *"])) note(`schedule is ${crons}`);
  const job = common(workflow, note);
  if (!job) return found;

  const env = job.env ?? {};
  const keys = Object.keys(env).sort();
  const wantedKeys = [...SECRETS, "PAYPAL_BASE_URL", "RESOLVE_AGENT_URL"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wantedKeys)) note(`env is ${keys.join(", ")}`);
  // Sandbox only.
  if (env.PAYPAL_BASE_URL !== SANDBOX_URL) note("PAYPAL_BASE_URL is not PayPal's sandbox");
  if (env.RESOLVE_AGENT_URL !== `\${{ vars.RESOLVE_AGENT_URL }}`) {
    note("RESOLVE_AGENT_URL is not the repository variable");
  }
  const used = [...new Set(names(text))].sort();
  if (JSON.stringify(used) !== JSON.stringify([...SECRETS].sort())) {
    note(`reads secrets ${used.join(", ")}`);
  }
  // Without DATABASE_URL the jobs would use a local PGlite database and report success.
  checksConfig(job, [...SECRETS, "RESOLVE_AGENT_URL"], note);

  const steps = job.steps ?? [];
  const reconcile = steps.findIndex((step) => step.run?.trim() === "npm run reconcile");
  const disputes = steps.findIndex((step) => step.run?.trim() === "npm run disputes -- sync");
  if (reconcile === -1) note("does not run npm run reconcile");
  if (disputes === -1) note("does not run npm run disputes -- sync");
  if (reconcile !== -1 && disputes !== -1 && disputes < reconcile) note("syncs disputes first");
  // As the cron did: disputes sync runs even when reconcile failed. `!cancelled()` keeps the
  // step running after a failure, and the job still fails when either step fails.
  const sync = steps[disputes];
  if (sync && sync.if?.replace(/\s/g, "") !== `\${{!cancelled()}}`) {
    note("disputes sync does not run after a failed reconcile");
  }
  for (const step of steps) {
    if (step.uses === undefined && step.run === undefined) note("a step does nothing");
    if (/continue-on-error/.test(JSON.stringify(step))) note("a step ignores its failure");
  }
  return found;
}

function smokeProblems(workflow: Workflow, text: string): string[] {
  const found: string[] = [];
  const note = (message: string) => found.push(`smoke: ${message}`);
  const crons = (workflow.on?.schedule ?? []).map((entry) => entry.cron);
  if (JSON.stringify(crons) !== JSON.stringify(["17 6 * * *"])) note(`schedule is ${crons}`);
  if (!Object.hasOwn(workflow.on ?? {}, "workflow_dispatch")) note("cannot be run by hand");
  const job = common(workflow, note);
  if (!job) return found;

  // URLs only from repository variables, and no secrets at all: the checks are public pages.
  const env = job.env ?? {};
  const keys = Object.keys(env).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(SMOKE_VARS).sort())) {
    note(`env is ${keys.join(", ")}`);
  }
  for (const key of Object.keys(SMOKE_VARS)) {
    if (env[key] !== `\${{ vars.${key} }}`) note(`${key} is not the repository variable`);
  }
  if (names(text).length > 0) note("reads a secret");
  checksConfig(job, Object.keys(SMOKE_VARS), note);

  const steps = job.steps ?? [];
  const smoke = steps.find((step) => /^npm run smoke --(\s|$)/.test(step.run?.trim() ?? ""));
  if (!smoke) note("does not run npm run smoke");
  for (const [key, flag] of Object.entries(SMOKE_VARS)) {
    if (!smoke?.run?.includes(`${flag} "$${key}"`)) note(`smoke does not pass ${flag} "$${key}"`);
  }
  // The smoke test decides; nothing else may swallow its result.
  if (smoke?.if !== undefined || /continue-on-error/.test(JSON.stringify(smoke ?? {}))) {
    note("the smoke step can be skipped or ignored");
  }
  return found;
}

function text(file: string): string {
  return readFileSync(join(ROOT, ".github", "workflows", file), "utf8");
}

describe(".github/workflows", () => {
  it("reconcile.yml meets every invariant", () => {
    expect(reconcileProblems(load("reconcile.yml"), text("reconcile.yml"))).toEqual([]);
  });

  it("smoke.yml meets every invariant", () => {
    expect(smokeProblems(load("smoke.yml"), text("smoke.yml"))).toEqual([]);
  });

  it("OWNER.md lists every secret and variable the workflows read", () => {
    const owner = readFileSync(join(ROOT, "OWNER.md"), "utf8");
    for (const name of [...SECRETS, ...Object.keys(SMOKE_VARS)]) {
      expect(owner).toContain(`\`${name}\``);
    }
  });

  describe("fails when", () => {
    const reconcile = () => structuredClone(load("reconcile.yml"));
    const smoke = () => structuredClone(load("smoke.yml"));
    const job = (workflow: Workflow): Job => {
      const found = onlyJob(workflow);
      if (!found) throw new Error("no job");
      return found;
    };
    const step = (workflow: Workflow, run: string): Step => {
      const found = job(workflow).steps.find((candidate) => candidate.run?.trim() === run);
      if (!found) throw new Error(`no step ${run}`);
      return found;
    };
    const reconcileText = text("reconcile.yml");
    const smokeText = text("smoke.yml");

    it("an action is pinned to a tag", () => {
      const workflow = reconcile();
      const checkout = job(workflow).steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      if (checkout) checkout.uses = "actions/checkout@v4";
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("an action is pinned to a short SHA", () => {
      const workflow = smoke();
      const setup = job(workflow).steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
      if (setup) setup.uses = "actions/setup-node@49933ea";
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("reconcile runs on another schedule", () => {
      const workflow = reconcile();
      workflow.on.schedule = [{ cron: "*/10 * * * *" }];
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("smoke loses its manual run", () => {
      const workflow = smoke();
      delete workflow.on.workflow_dispatch;
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("smoke runs at another time", () => {
      const workflow = smoke();
      workflow.on.schedule = [{ cron: "0 6 * * *" }];
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("disputes sync is skipped after a failed reconcile", () => {
      const workflow = reconcile();
      delete step(workflow, "npm run disputes -- sync").if;
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("disputes sync runs whatever happens, even when cancelled", () => {
      const workflow = reconcile();
      step(workflow, "npm run disputes -- sync").if = `\${{ always() }}`;
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("reconcile ignores its own failure", () => {
      const workflow = reconcile();
      Object.assign(step(workflow, "npm run reconcile"), { "continue-on-error": true });
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("a job runs on live PayPal", () => {
      const workflow = reconcile();
      job(workflow).env = { ...job(workflow).env, PAYPAL_BASE_URL: "https://api-m.paypal.com" };
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("a secret is written into the file", () => {
      const workflow = reconcile();
      job(workflow).env = { ...job(workflow).env, PAYPAL_CLIENT_SECRET: "EC-not-a-real-secret" };
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("a secret is read under another name", () => {
      const workflow = reconcile();
      job(workflow).env = { ...job(workflow).env, DATABASE_URL: `\${{ secrets.NEON_URL }}` };
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("reconcile reads a secret it doesn't need", () => {
      const workflow = reconcile();
      const extra = `${reconcileText}\n# \${{ secrets.GEMINI_API_KEY }}\n`;
      expect(reconcileProblems(workflow, extra)).not.toEqual([]);
    });

    it("smoke reads any secret", () => {
      const workflow = smoke();
      expect(smokeProblems(workflow, `${smokeText}\n# \${{ secrets.DATABASE_URL }}\n`)).not.toEqual(
        [],
      );
    });

    it("the configuration check leaves out DATABASE_URL", () => {
      const workflow = reconcile();
      const check = job(workflow).steps[0];
      if (check?.run) check.run = check.run.replace("DATABASE_URL ", "");
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("the configuration check comes after the jobs", () => {
      const workflow = reconcile();
      const steps = job(workflow).steps;
      const first = steps.shift();
      if (first) steps.push(first);
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("the configuration check doesn't fail", () => {
      const workflow = smoke();
      const check = job(workflow).steps[0];
      if (check?.run) check.run = check.run.replace('exit "$missing"', "exit 0");
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("a job runs another Node", () => {
      const workflow = smoke();
      const setup = job(workflow).steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
      if (setup?.with) setup.with["node-version"] = "24";
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("the token can write", () => {
      const workflow = reconcile();
      workflow.permissions = { contents: "write" };
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });

    it("checkout keeps its token", () => {
      const workflow = smoke();
      const checkout = job(workflow).steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      if (checkout?.with) delete checkout.with["persist-credentials"];
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("smoke passes a URL to the wrong flag", () => {
      const workflow = smoke();
      const run = job(workflow).steps.find((s) => s.run?.includes("npm run smoke"));
      if (run?.run) run.run = run.run.replace('--console "$CONSOLE_URL"', '--console "$GATE_URL"');
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("smoke's URL is typed into the file", () => {
      const workflow = smoke();
      job(workflow).env = { ...job(workflow).env, GATE_URL: "https://gate.example.com" };
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("the smoke step's failure is ignored", () => {
      const workflow = smoke();
      const run = job(workflow).steps.find((s) => s.run?.includes("npm run smoke"));
      if (run) Object.assign(run, { "continue-on-error": true });
      expect(smokeProblems(workflow, smokeText)).not.toEqual([]);
    });

    it("a job has no timeout", () => {
      const workflow = reconcile();
      delete job(workflow)["timeout-minutes"];
      expect(reconcileProblems(workflow, reconcileText)).not.toEqual([]);
    });
  });
});
