import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// ADR 0041 and ADR 0044: render.yaml describes the hosted demo. This checks its invariants, not
// every line. `problems(blueprint)` lists what is wrong, so the mutation cases below can show a
// wrong start-command prefix or a free plan is caught.

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
type Database = {
  name: string;
  plan: string;
  region: string;
  postgresMajorVersion: string;
  ipAllowList: unknown[];
  diskSizeGB: number;
};
type Blueprint = { databases: Database[]; services: Service[] };

const GATE = "countersign-gate";
const RESOLVE = "countersign-resolve-agent";
const CONSOLE = "countersign-console";
const STOREFRONT = "countersign-storefront";
const CRON = "countersign-reconcile";
const DATABASE = "countersign-db";
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
      "RESOLVE_AGENT_HOSTPORT",
    ],
  },
  [RESOLVE]: {
    type: "pserv",
    keys: [
      "NODE_VERSION",
      "PORT",
      "DATABASE_URL",
      "GEMINI_API_KEY",
      "RESOLVE_DAILY_RUN_CAP",
      "RESOLVE_BASELINE",
      "COUNTERSIGN_SUPPORT_AGENT_KEY",
      "GATE_HOSTPORT",
    ],
  },
  [CONSOLE]: {
    type: "web",
    keys: [
      "NODE_VERSION",
      "STOREFRONT_URL",
      "CONSOLE_PUBLIC_URL",
      "GATE_HOSTPORT",
      "RESOLVE_AGENT_HOSTPORT",
    ],
  },
  [STOREFRONT]: {
    type: "web",
    keys: ["NODE_VERSION", "PAYPAL_BASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"],
  },
  [CRON]: {
    type: "cron",
    keys: [
      "NODE_VERSION",
      "DATABASE_URL",
      "PAYPAL_BASE_URL",
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "RESOLVE_AGENT_HOSTPORT",
    ],
  },
};

// The URL variables each start command sets, and the service whose hostport each one uses.
const HOSTPORT_OWNER: Record<string, string> = {
  GATE_HOSTPORT: GATE,
  RESOLVE_AGENT_HOSTPORT: RESOLVE,
};
const EXPECTED_PREFIXES: Record<string, Record<string, { hostport: string; suffix: string }>> = {
  [GATE]: { RESOLVE_AGENT_URL: { hostport: "RESOLVE_AGENT_HOSTPORT", suffix: "" } },
  [RESOLVE]: { GATE_MCP_URL: { hostport: "GATE_HOSTPORT", suffix: "/mcp" } },
  [CONSOLE]: {
    GATE_URL: { hostport: "GATE_HOSTPORT", suffix: "" },
    RESOLVE_AGENT_URL: { hostport: "RESOLVE_AGENT_HOSTPORT", suffix: "" },
  },
  [STOREFRONT]: {},
  [CRON]: { RESOLVE_AGENT_URL: { hostport: "RESOLVE_AGENT_HOSTPORT", suffix: "" } },
};

const SECRET_PATTERN = /(sk|pk|AIza|EC|A21AA)[A-Za-z0-9_-]{10,}/;

function load(): Blueprint {
  return parse(readFileSync(join(import.meta.dirname, "..", "render.yaml"), "utf8")) as Blueprint;
}

function problems(blueprint: Blueprint): string[] {
  const found: string[] = [];
  const note = (text: string) => found.push(text);

  // The database.
  if (blueprint.databases?.length !== 1) note("expected exactly one database");
  const database = blueprint.databases?.[0];
  if (database) {
    if (database.name !== DATABASE) note(`database is named ${database.name}`);
    if (String(database.postgresMajorVersion) !== "18") note("database is not Postgres 18");
    if (!Array.isArray(database.ipAllowList) || database.ipAllowList.length !== 0) {
      note("database allow list is not empty");
    }
    if (!(database.diskSizeGB > 0)) note("database has no disk");
    if (!database.plan || database.plan === "free") note("database is not on a paid plan");
  }

  // The services.
  const services = blueprint.services ?? [];
  const names = services.map((service) => service.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(EXPECTED).sort())) {
    note(`services are ${names.join(", ")}`);
  }
  const byName = new Map(services.map((service) => [service.name, service]));
  const regions = new Set(services.map((service) => service.region));
  if (database) regions.add(database.region);
  if (regions.size !== 1) note("services and database are not all in one region");

  for (const service of services) {
    const expected = EXPECTED[service.name];
    const who = service.name;
    if (!expected) continue;
    if (service.type !== expected.type) note(`${who} has type ${service.type}`);
    if (!service.plan || service.plan === "free") note(`${who} is not on a paid plan`);
    if (service.autoDeployTrigger !== "off") note(`${who} autoDeployTrigger is not off`);
    if (service.runtime !== undefined && service.runtime !== "node") note(`${who} is not node`);

    const keys = (service.envVars ?? []).map((envVar) => envVar.key);
    if (new Set(keys).size !== keys.length) note(`${who} repeats a variable`);
    if (JSON.stringify([...keys].sort()) !== JSON.stringify([...expected.keys].sort())) {
      note(`${who} variables are ${[...keys].sort().join(", ")}`);
    }

    const nodeVersion = service.envVars?.find((envVar) => envVar.key === "NODE_VERSION");
    if (String(nodeVersion?.value) !== "26.7.0") note(`${who} NODE_VERSION is not 26.7.0`);

    for (const envVar of service.envVars ?? []) {
      // References name a declared service of that type, or the declared database.
      if (envVar.fromDatabase && envVar.fromDatabase.name !== database?.name) {
        note(`${who} ${envVar.key} names an undeclared database`);
      }
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

    // Hostports: each one a start command uses is declared here and points at the right service.
    const used = [...service.startCommand.matchAll(/\$([A-Z_]+_HOSTPORT)\b/g)].map((m) => m[1]);
    for (const name of used) {
      const declared = service.envVars?.find((envVar) => envVar.key === name);
      const owner = HOSTPORT_OWNER[name ?? ""];
      if (declared?.fromService?.property !== "hostport" || declared.fromService.name !== owner) {
        note(`${who} uses $${name} without declaring it from ${owner}`);
      }
    }

    // The URL each prefix sets is the one the code reads, from the service that serves it.
    const prefixes = [
      ...service.startCommand.matchAll(
        /\b([A-Z][A-Z_]*)=http:\/\/\$([A-Z_]+_HOSTPORT)(\/mcp)?(?=\s)/g,
      ),
    ];
    const wanted = EXPECTED_PREFIXES[service.name] ?? {};
    const set = Object.fromEntries(prefixes.map((m) => [m[1], `${m[2]}${m[3] ?? ""}`]));
    const want = Object.fromEntries(
      Object.entries(wanted).map(([variable, { hostport, suffix }]) => [
        variable,
        `${hostport}${suffix}`,
      ]),
    );
    if (JSON.stringify(set) !== JSON.stringify(want)) {
      note(`${who} start command sets ${JSON.stringify(set)}, expected ${JSON.stringify(want)}`);
    }
  }

  // Per-service particulars.
  const gate = byName.get(GATE);
  if (gate?.healthCheckPath !== "/health") note("gate health check is not /health");
  if (gate?.preDeployCommand !== "npm run db:migrate") note("gate does not migrate before deploy");

  const resolve = byName.get(RESOLVE);
  const resolveValue = (key: string) => resolve?.envVars?.find((v) => v.key === key)?.value;
  if (resolveValue("PORT") !== "10000") note("resolve PORT is not 10000");
  if (resolveValue("RESOLVE_BASELINE") !== "scenarios") note("resolve baseline is not scenarios");
  if (resolveValue("RESOLVE_DAILY_RUN_CAP") !== "200") note("resolve cap is not 200");
  const gateValue = (key: string) => gate?.envVars?.find((v) => v.key === key)?.value;
  if (gateValue("COUNTERSIGN_DEMO_RESET") !== "on") note("gate reset flag is not on");

  const cron = byName.get(CRON);
  if (cron?.schedule !== "*/10 * * * *") note("cron does not run every 10 minutes");
  if (
    !/;\s*status=\$\?;/.test(cron?.startCommand ?? "") ||
    !/&&\s*exit \$status\s*$/.test(cron?.startCommand ?? "")
  ) {
    note("cron does not fail when either command fails");
  }

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
  ];
  if (JSON.stringify(generated.sort()) !== JSON.stringify(generatedWanted.sort())) {
    note("the three Countersign keys are not generated on the gate alone");
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

  it("describes one database and five services", () => {
    const blueprint = load();
    expect(blueprint.databases.map((database) => database.name)).toEqual([DATABASE]);
    expect(blueprint.services.map((entry) => `${entry.type}:${entry.name}`)).toEqual([
      `web:${GATE}`,
      `pserv:${RESOLVE}`,
      `web:${CONSOLE}`,
      `web:${STOREFRONT}`,
      `cron:${CRON}`,
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
      const gate = service(blueprint, GATE);
      gate.startCommand = gate.startCommand.replace("RESOLVE_AGENT_URL=", "RESOLVE_URL=");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("the console's prefix uses the other service's hostport", () => {
      const blueprint = clone();
      const console_ = service(blueprint, CONSOLE);
      console_.startCommand = console_.startCommand.replace(
        "GATE_URL=http://$GATE_HOSTPORT",
        "GATE_URL=http://$RESOLVE_AGENT_HOSTPORT",
      );
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("Resolve's MCP URL loses its /mcp path", () => {
      const blueprint = clone();
      const resolve = service(blueprint, RESOLVE);
      resolve.startCommand = resolve.startCommand.replace("$GATE_HOSTPORT/mcp", "$GATE_HOSTPORT");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a service is on the free plan", () => {
      const blueprint = clone();
      service(blueprint, STOREFRONT).plan = "free";
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

    it("a hostport is used but not declared", () => {
      const blueprint = clone();
      const console_ = service(blueprint, CONSOLE);
      console_.envVars = console_.envVars.filter((envVar) => envVar.key !== "GATE_HOSTPORT");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a reference names a service that isn't declared", () => {
      const blueprint = clone();
      const gate = service(blueprint, GATE);
      const reference = gate.envVars.find((envVar) => envVar.key === "RESOLVE_AGENT_HOSTPORT");
      if (reference?.fromService) reference.fromService.name = "countersign-missing";
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("the database allows outside connections", () => {
      const blueprint = clone();
      const [database] = blueprint.databases;
      if (database) database.ipAllowList = [{ source: "0.0.0.0/0", description: "everywhere" }];
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

    it("the cron job ignores a failed command", () => {
      const blueprint = clone();
      const cron = service(blueprint, CRON);
      cron.startCommand = cron.startCommand.replace(" && exit $status", "");
      expect(problems(blueprint)).not.toEqual([]);
    });

    it("a variable is added to a service", () => {
      const blueprint = clone();
      service(blueprint, STOREFRONT).envVars.push({ key: "EXTRA", value: "x" });
      expect(problems(blueprint)).not.toEqual([]);
    });
  });
});
