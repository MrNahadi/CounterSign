import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// ADR 0041 and ADR 0044: render.yaml describes the hosted demo. This checks its invariants, not
// every line. `problems(blueprint)` lists what is wrong, so the mutation cases below can show a
// wrong start-command prefix or a paid plan is caught. Since the owner's decision of 8 Nov
// (DECISIONS.md), the demo is hosted for free: every service on Render's free plan, no Render
// database (Neon's connection string is typed in as DATABASE_URL), and no cron service (GitHub
// Actions runs the scheduled jobs). Free services can't take private-network traffic, so they
// reach each other at typed-in public URLs, and Resolve takes calls only with a shared secret
// generated on it and typed in on the gate and the console (PLAN.md F2).

type EnvVar = {
  key: string;
  value?: string;
  sync?: boolean;
  generateValue?: boolean;
  fromDatabase?: { name: string; property: string };
  fromService?: { type: string; name: string; property?: string; envVarKey?: string };
};
type Service = {
  type: string;
  name: string;
  runtime?: string;
  plan: string;
  region: string;
  autoDeployTrigger: string;
  buildCommand: string;
  startCommand: string;
  preDeployCommand?: string;
  healthCheckPath?: string;
  schedule?: string;
  envVars: EnvVar[];
};
type Blueprint = { databases?: unknown[]; services: Service[] };

const GATE = "countersign-gate";
const RESOLVE = "countersign-resolve-agent";
const CONSOLE = "countersign-console";
const STOREFRONT = "countersign-storefront";
const SANDBOX_URL = "https://api-m.sandbox.paypal.com";

const EXPECTED: Record<string, { type: string; keys: string[] }> = {
  [GATE]: {
    type: "web",
    keys: [
      "NODE_VERSION",
      "DATABASE_URL",
      "PAYPAL_BASE_URL",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "PAYPAL_SEED_VAULT_TOKEN",
      "PAYPAL_SEED_VAULT_TOKEN_B",
      "COUNTERSIGN_SUPPORT_AGENT_KEY",
      "COUNTERSIGN_OPS_AGENT_KEY",
      "COUNTERSIGN_APPROVER_KEY",
      "COUNTERSIGN_DEMO_RESET",
      "RESOLVE_AGENT_URL",
      "RESOLVE_SHARED_SECRET",
    ],
  },
  [RESOLVE]: {
    type: "web",
    keys: [
      "NODE_VERSION",
      "PORT",
      "DATABASE_URL",
      "GEMINI_API_KEY",
      "RESOLVE_DAILY_RUN_CAP",
      "RESOLVE_BASELINE",
      "COUNTERSIGN_SUPPORT_AGENT_KEY",
      "RESOLVE_SHARED_SECRET",
      "GATE_URL",
    ],
  },
  [CONSOLE]: {
    type: "web",
    keys: [
      "NODE_VERSION",
      "STOREFRONT_URL",
      "CONSOLE_PUBLIC_URL",
      "GATE_URL",
      "RESOLVE_AGENT_URL",
      "RESOLVE_SHARED_SECRET",
    ],
  },
  [STOREFRONT]: {
    type: "web",
    keys: ["NODE_VERSION", "PAYPAL_BASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"],
  },
};

// Each service's health check path: Render restarts a service that stops answering it.
const HEALTH_CHECKS: Record<string, string> = {
  [GATE]: "/health",
  [RESOLVE]: "/health",
  [CONSOLE]: "/",
  [STOREFRONT]: "/",
};

// Free services can't reach each other privately (PLAN.md F2), so each one is given the others'
// public URLs, typed in. These are the URL variables each service needs, all `sync: false`.
const TYPED_URLS: Record<string, string[]> = {
  [GATE]: ["RESOLVE_AGENT_URL"],
  [RESOLVE]: ["GATE_URL"],
  [CONSOLE]: ["GATE_URL", "RESOLVE_AGENT_URL"],
  [STOREFRONT]: [],
};
// The variables each start command sets. Only Resolve's: its MCP URL from the typed-in gate URL,
// without a doubled slash when the owner types one at the end.
const EXPECTED_PREFIXES: Record<string, string[]> = {
  [GATE]: [],
  [RESOLVE]: [`GATE_MCP_URL=\${GATE_URL%/}/mcp`],
  [CONSOLE]: [],
  [STOREFRONT]: [],
};
// Resolve's shared secret: generated on Resolve, copied by hand to the two services that call it.
const SHARED_SECRET = "RESOLVE_SHARED_SECRET";
const SECRET_CALLERS = [GATE, CONSOLE];

const SECRET_PATTERN = /(sk|pk|AIza|EC|A21AA)[A-Za-z0-9_-]{10,}/;

function load(): Blueprint {
  return parse(readFileSync(join(import.meta.dirname, "..", "render.yaml"), "utf8")) as Blueprint;
}

function problems(blueprint: Blueprint): string[] {
  const found: string[] = [];
  const note = (text: string) => found.push(text);

  // No Render database: Postgres is Neon's free plan, reached through a typed-in DATABASE_URL.
  if (blueprint.databases !== undefined) note("the blueprint declares a Render database");

  // The services.
  const services = blueprint.services ?? [];
  const names = services.map((service) => service.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(EXPECTED).sort())) {
    note(`services are ${names.join(", ")}`);
  }
  const byName = new Map(services.map((service) => [service.name, service]));
  const regions = new Set(services.map((service) => service.region));
  if (regions.size !== 1) note("services are not all in one region");

  for (const service of services) {
    const expected = EXPECTED[service.name];
    const who = service.name;
    if (!expected) continue;
    if (service.type !== expected.type) note(`${who} has type ${service.type}`);
    // Free only: a paid plan would spend money the owner chose not to spend.
    if (service.plan !== "free") note(`${who} is not on the free plan`);
    if (service.autoDeployTrigger !== "off") note(`${who} autoDeployTrigger is not off`);
    if (service.healthCheckPath !== HEALTH_CHECKS[who]) {
      note(`${who} health check is not ${HEALTH_CHECKS[who]}`);
    }
    // Render's free plan runs no pre-deploy command, so nothing may depend on one.
    if (service.preDeployCommand !== undefined) note(`${who} has a pre-deploy command`);
    if (service.runtime !== undefined && service.runtime !== "node") note(`${who} is not node`);

    const keys = (service.envVars ?? []).map((envVar) => envVar.key);
    if (new Set(keys).size !== keys.length) note(`${who} repeats a variable`);
    if (JSON.stringify([...keys].sort()) !== JSON.stringify([...expected.keys].sort())) {
      note(`${who} variables are ${[...keys].sort().join(", ")}`);
    }

    const nodeVersion = service.envVars?.find((envVar) => envVar.key === "NODE_VERSION");
    if (String(nodeVersion?.value) !== "26.7.0") note(`${who} NODE_VERSION is not 26.7.0`);

    for (const envVar of service.envVars ?? []) {
      // There is no Render database to take a connection string from.
      if (envVar.fromDatabase) note(`${who} ${envVar.key} comes from a Render database`);
      // The Neon connection string holds a password, so it's typed in, never written here.
      if (envVar.key === "DATABASE_URL" && envVar.sync !== false) {
        note(`${who} DATABASE_URL is not typed in (sync: false)`);
      }
      // References name a declared service of that type.
      if (envVar.fromService) {
        const target = byName.get(envVar.fromService.name);
        if (!target || target.type !== envVar.fromService.type) {
          note(`${who} ${envVar.key} names an undeclared service`);
        }
        if (envVar.fromService.envVarKey) {
          const exists = target?.envVars?.some((v) => v.key === envVar.fromService?.envVarKey);
          if (!exists) note(`${who} ${envVar.key} names a variable its service lacks`);
        }
      }
      // No secret-looking value.
      if (typeof envVar.value === "string" && envVar.value !== SANDBOX_URL) {
        if (SECRET_PATTERN.test(envVar.value) || envVar.value.length > 40) {
          note(`${who} ${envVar.key} looks like a secret`);
        }
      }
      // Whatever is a secret is typed in or generated, never written here.
      if (/(_KEY|_SECRET|_TOKEN|_TOKEN_B|_ID)$/.test(envVar.key) && envVar.value !== undefined) {
        note(`${who} ${envVar.key} has a value in the file`);
      }
    }

    // No private-network addresses: a free service can't receive that traffic.
    if (/HOSTPORT/.test(service.startCommand)) note(`${who} start command uses a hostport`);
    for (const envVar of service.envVars ?? []) {
      if (envVar.fromService?.property !== undefined) {
        note(`${who} ${envVar.key} takes a ${envVar.fromService.property} from a service`);
      }
    }
    // The other services' public URLs are typed in.
    for (const key of TYPED_URLS[who] ?? []) {
      const envVar = service.envVars?.find((candidate) => candidate.key === key);
      if (envVar?.sync !== false || envVar.value !== undefined || envVar.fromService) {
        note(`${who} ${key} is not typed in (sync: false)`);
      }
    }

    // The assignments the start command makes before `npm`, exactly.
    const set = (service.startCommand.split(/\bnpm\b/)[0] ?? "").split(/\s+/).filter(Boolean);
    const want = EXPECTED_PREFIXES[who] ?? [];
    if (JSON.stringify(set) !== JSON.stringify(want)) {
      note(`${who} start command sets ${JSON.stringify(set)}, expected ${JSON.stringify(want)}`);
    }
  }

  // Per-service particulars.
  const gate = byName.get(GATE);
  // With no pre-deploy command, the gate migrates in its build, after the install succeeds.
  if (!/&&\s*npm run db:migrate\s*$/.test(gate?.buildCommand ?? "")) {
    note("gate does not migrate at the end of its build");
  }
  const databaseHolders = services
    .filter((entry) => entry.envVars?.some((envVar) => envVar.key === "DATABASE_URL"))
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(databaseHolders) !== JSON.stringify([GATE, RESOLVE].sort())) {
    note(`DATABASE_URL is on ${databaseHolders.join(", ")}`);
  }

  const resolve = byName.get(RESOLVE);
  const resolveValue = (key: string) => resolve?.envVars?.find((v) => v.key === key)?.value;
  if (resolveValue("PORT") !== "10000") note("resolve PORT is not 10000");
  if (resolveValue("RESOLVE_BASELINE") !== "scenarios") note("resolve baseline is not scenarios");
  if (resolveValue("RESOLVE_DAILY_RUN_CAP") !== "200") note("resolve cap is not 200");
  const gateValue = (key: string) => gate?.envVars?.find((v) => v.key === key)?.value;
  if (gateValue("COUNTERSIGN_DEMO_RESET") !== "on") note("gate reset flag is not on");

  // Where each variable may appear.
  const holders = (test: (key: string) => boolean) =>
    services
      .filter((service) => service.envVars?.some((envVar) => test(envVar.key)))
      .map((service) => service.name);
  if (JSON.stringify(holders((key) => key === "GEMINI_API_KEY")) !== JSON.stringify([RESOLVE])) {
    note("GEMINI_API_KEY is not on Resolve alone");
  }
  if (holders((key) => key.startsWith("PAYPAL_")).includes(RESOLVE)) {
    note("a PAYPAL_ variable is on Resolve");
  }
  if (
    JSON.stringify(holders((key) => key.startsWith("PAYPAL_SEED_VAULT_TOKEN"))) !==
    JSON.stringify([GATE])
  ) {
    note("the vault tokens are not on the gate alone");
  }
  const generated = services.flatMap((service) =>
    (service.envVars ?? [])
      .filter((envVar) => envVar.generateValue === true)
      .map((envVar) => `${service.name}:${envVar.key}`),
  );
  const generatedWanted = [
    `${GATE}:COUNTERSIGN_SUPPORT_AGENT_KEY`,
    `${GATE}:COUNTERSIGN_OPS_AGENT_KEY`,
    `${GATE}:COUNTERSIGN_APPROVER_KEY`,
    `${RESOLVE}:${SHARED_SECRET}`,
  ];
  if (JSON.stringify(generated.sort()) !== JSON.stringify(generatedWanted.sort())) {
    note("the three keys are not generated on the gate, or the shared secret on Resolve");
  }
  // The shared secret: generated on Resolve, typed in on its two callers, and nowhere else.
  const secretHolders = holders((key) => key === SHARED_SECRET).sort();
  if (JSON.stringify(secretHolders) !== JSON.stringify([RESOLVE, ...SECRET_CALLERS].sort())) {
    note(`${SHARED_SECRET} is on ${secretHolders.join(", ")}`);
  }
  for (const name of SECRET_CALLERS) {
    const envVar = byName.get(name)?.envVars?.find((v) => v.key === SHARED_SECRET);
    if (envVar?.sync !== false || envVar.generateValue === true || envVar.fromService) {
      note(`${name} ${SHARED_SECRET} is not typed in (sync: false)`);
    }
  }

  return found;
}

function clone(): Blueprint {
  return structuredClone(load());
}

function service(blueprint: Blueprint, name: string): Service {
  const found = blueprint.services.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no service ${name}`);
  return found;
}

describe("render.yaml", () => {
  it("meets every invariant", () => {
    expect(problems(load())).toEqual([]);
  });

  it("describes four free web services and no database", () => {
    const blueprint = load();
    expect(blueprint.databases).toBeUndefined();
    expect(blueprint.services.map((entry) => `${entry.type}:${entry.plan}:${entry.name}`)).toEqual([
      `web:free:${GATE}`,
      `web:free:${RESOLVE}`,
      `web:free:${CONSOLE}`,
      `web:free:${STOREFRONT}`,
    ]);
  });

  it("holds no secret-looking value", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "render.yaml"), "utf8");
    const values = [...text.matchAll(/^\s*value:\s*(.+)$/gm)].map((m) => m[1]?.replace(/"/g, ""));
    for (const value of values) {
      if (value === SANDBOX_URL) continue;
      expect(value).not.toMatch(SECRET_PATTERN);
      expect(value?.length).toBeLessThanOrEqual(40);
    }
  });

  describe("fails when", () => {
    it("a start-command prefix sets the wrong variable", () => {
      const blueprint = clone();
      const resolve = service(blueprint, RESOLVE);
      resolve.startCommand = resolve.startCommand.replace("GATE_MCP_URL=", "GATE_URL_MCP=");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("Resolve's MCP URL loses its /mcp path", () => {
      const blueprint = clone();
      const resolve = service(blueprint, RESOLVE);
      resolve.startCommand = resolve.startCommand.replace("%/}/mcp", "%/}");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("Resolve's MCP URL is built from Resolve's own address", () => {
      const blueprint = clone();
      const resolve = service(blueprint, RESOLVE);
      resolve.startCommand = resolve.startCommand.replace("GATE_URL%", "RESOLVE_AGENT_URL%");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("the console goes back to a private-network prefix", () => {
      const blueprint = clone();
      const console_ = service(blueprint, CONSOLE);
      console_.startCommand = `GATE_URL=http://$GATE_HOSTPORT ${console_.startCommand}`;
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a service is on a paid plan", () => {
      const blueprint = clone();
      service(blueprint, STOREFRONT).plan = "starter";
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a service has no plan", () => {
      const blueprint = clone();
      service(blueprint, RESOLVE).plan = "";
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a service loses its health check", () => {
      const blueprint = clone();
      delete service(blueprint, RESOLVE).healthCheckPath;
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a service runs a different Node", () => {
      const blueprint = clone();
      const envVar = service(blueprint, CONSOLE).envVars.find((v) => v.key === "NODE_VERSION");
      if (envVar) envVar.value = "22.0.0";
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("the gate relies on a pre-deploy command to migrate", () => {
      const blueprint = clone();
      const gate = service(blueprint, GATE);
      gate.buildCommand = "npm ci --include=dev";
      gate.preDeployCommand = "npm run db:migrate";
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a service auto-deploys", () => {
      const blueprint = clone();
      service(blueprint, CONSOLE).autoDeployTrigger = "commit";
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a PayPal variable reaches Resolve", () => {
      const blueprint = clone();
      service(blueprint, RESOLVE).envVars.push({ key: "PAYPAL_CLIENT_ID", sync: false });
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a typed-in URL is missing", () => {
      const blueprint = clone();
      const console_ = service(blueprint, CONSOLE);
      console_.envVars = console_.envVars.filter((envVar) => envVar.key !== "GATE_URL");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a service URL comes from a private hostport", () => {
      const blueprint = clone();
      const envVar = service(blueprint, GATE).envVars.find((v) => v.key === "RESOLVE_AGENT_URL");
      if (envVar) {
        delete envVar.sync;
        envVar.fromService = { type: "web", name: RESOLVE, property: "hostport" };
      }
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a service URL is written into the file", () => {
      const blueprint = clone();
      const envVar = service(blueprint, RESOLVE).envVars.find((v) => v.key === "GATE_URL");
      if (envVar) {
        delete envVar.sync;
        envVar.value = "https://countersign-gate.onrender.com";
      }
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a reference names a service that isn't declared", () => {
      const blueprint = clone();
      const resolve = service(blueprint, RESOLVE);
      const reference = resolve.envVars.find((v) => v.key === "COUNTERSIGN_SUPPORT_AGENT_KEY");
      if (reference?.fromService) reference.fromService.name = "countersign-missing";
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("Resolve's shared secret isn't generated", () => {
      const blueprint = clone();
      const resolve = service(blueprint, RESOLVE);
      const envVar = resolve.envVars.find((v) => v.key === "RESOLVE_SHARED_SECRET");
      if (envVar) {
        delete envVar.generateValue;
        envVar.sync = false;
      }
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a caller loses the shared secret", () => {
      const blueprint = clone();
      const gate = service(blueprint, GATE);
      gate.envVars = gate.envVars.filter((envVar) => envVar.key !== "RESOLVE_SHARED_SECRET");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a caller generates its own shared secret", () => {
      const blueprint = clone();
      const console_ = service(blueprint, CONSOLE);
      const envVar = console_.envVars.find((v) => v.key === "RESOLVE_SHARED_SECRET");
      if (envVar) {
        delete envVar.sync;
        envVar.generateValue = true;
      }
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("the shared secret reaches the storefront", () => {
      const blueprint = clone();
      service(blueprint, STOREFRONT).envVars.push({ key: "RESOLVE_SHARED_SECRET", sync: false });
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a Render database comes back", () => {
      const blueprint = clone();
      blueprint.databases = [{ name: "countersign-db", plan: "free", region: "oregon" }];
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("DATABASE_URL is taken from a Render database", () => {
      const blueprint = clone();
      const envVar = service(blueprint, GATE).envVars.find((v) => v.key === "DATABASE_URL");
      if (envVar) {
        delete envVar.sync;
        envVar.fromDatabase = { name: "countersign-db", property: "connectionString" };
      }
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("the Neon connection string is written into the file", () => {
      const blueprint = clone();
      const envVar = service(blueprint, RESOLVE).envVars.find((v) => v.key === "DATABASE_URL");
      if (envVar) {
        delete envVar.sync;
        envVar.value = "postgres://u:p@ep-x.neon.tech/db?sslmode=require";
      }
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a cron service comes back", () => {
      const blueprint = clone();
      blueprint.services.push({
        ...structuredClone(service(blueprint, GATE)),
        type: "cron",
        name: "countersign-reconcile",
        schedule: "*/15 * * * *",
      });
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("Resolve goes back to being a private service", () => {
      const blueprint = clone();
      service(blueprint, RESOLVE).type = "pserv";
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a secret is written into the file", () => {
      const blueprint = clone();
      const envVar = service(blueprint, GATE).envVars.find((v) => v.key === "PAYPAL_CLIENT_ID");
      if (envVar) {
        delete envVar.sync;
        envVar.value = "A21AAJabcdefghijklmnopqrstuvwxyz";
      }
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a variable is added to a service", () => {
      const blueprint = clone();
      service(blueprint, STOREFRONT).envVars.push({ key: "EXTRA", value: "x" });
      expect(problems(blueprint)).not.toEqual([]);
    });
  });
});
