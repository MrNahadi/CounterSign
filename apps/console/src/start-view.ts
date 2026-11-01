import { APPROVAL_ROUTE_MESSAGES } from "./approval-routes";
import { GateMessageSchema } from "./approval-schemas";
import { type ResetReport, ResetReportSchema, ScenarioAcceptedSchema } from "./demo-schemas";
import { RESOLVE_UNREACHABLE } from "./resolve-routes";
import { durationWords } from "./time";

// What the start page says, in one place a test pins (ADR 0043). The copy follows the brand book:
// plain, short, sentence case, no exclamation marks.

export const START_COPY = {
  title: "Start here · Countersign console",
  heading: "Start here",
  line: "Countersign checks every money action an AI agent proposes against PayPal's records and your rules. The agent's words never approve a payment.",
  stepsHeading: "In about a minute",
  steps: [
    "Sign in with the approver key from the testing instructions.",
    "Run the attack email in baseline mode, then protected, and compare what moved.",
    "Run the stalled parcel and the damaged basket. Each opens in the inbox, linked to its decisions.",
    "Scan the code below to open Approvals on your phone, already signed in, and approve the waiting refund. The Approvals page here works too.",
    "Reset the demo when you're done, so the next person starts fresh.",
  ],
  real: {
    label: "What's real",
    text: "PayPal sandbox orders, captures, refunds, disputes and webhooks, and Countersign's decisions, approvals and audit log.",
  },
  simulated: {
    label: "What's simulated",
    text: "The customers and their messages, the carrier's delivery status, and the shop and its people, who are illustrative.",
  },
  storefront: {
    before: "Want a real sandbox checkout? Buy something on the ",
    link: "Kikapu storefront",
    after: ".",
  },
  signIn: {
    title: "Sign in",
    line: "Sign in with the approver key to run the scenarios and reset the demo.",
  },
  scenariosHeading: "Scenarios",
  phoneHeading: "Open on your phone",
  reset: {
    heading: "Reset the demo",
    line: "Clears the inbox, decisions and audit log, and replaces any order a scenario refunded. It takes up to a minute.",
    button: "Reset demo",
    dialogTitle: "Reset the demo?",
    dialogDescription:
      "Everyone using this demo starts again from the seed orders. The audit log restarts with one entry that records where the old log ended.",
    cancel: "Cancel",
    confirm: "Reset demo",
    pending: "Resetting",
  },
} as const;

export type ScenarioButton = {
  mode: "protected" | "baseline";
  label: string;
  variant: "primary" | "secondary";
};

export type ScenarioCard = {
  id: string;
  title: string;
  line: string;
  lookFor: string;
  buttons: readonly ScenarioButton[];
};

const RUN_PROTECTED: ScenarioButton = {
  mode: "protected",
  label: "Run protected",
  variant: "primary",
};

// The IDs and modes are Resolve's `LAUNCHER_SCENARIOS`; a test checks they agree.
export const SCENARIO_CARDS: readonly ScenarioCard[] = [
  {
    id: "beat-3-attack-email",
    title: "The attack email",
    line: "A customer says KIK-1042 never arrived, and hidden text asks for refunds on four orders other people paid for.",
    lookFor:
      "Baseline: the agent calls PayPal's refund tool directly. Protected: Countersign denies what the records don't support and holds the rest.",
    buttons: [
      { mode: "baseline", label: "Run in baseline mode", variant: "secondary" },
      RUN_PROTECTED,
    ],
  },
  {
    id: "beat-4-stalled-parcel",
    title: "The stalled parcel",
    line: "The payer of KIK-1035 says her $18.00 coaster set never arrived. The carrier shows it stalled for over ten days.",
    lookFor: "The refund runs on its own, with a real sandbox refund ID.",
    buttons: [RUN_PROTECTED],
  },
  {
    id: "beat-5-damaged",
    title: "The damaged basket",
    line: "The payer of KIK-1037 sends a photo of a split basket and asks for her $240.00 back.",
    lookFor: "It waits for you. Approve it on the Approvals page or your phone.",
    buttons: [RUN_PROTECTED],
  },
];

/** The storefront's URL when `STOREFRONT_URL` is an http(s) URL, else null. */
export function storefrontLink(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env.STOREFRONT_URL?.trim() ?? "";
  if (raw === "") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export type ResetSentence = { sentence: string; tone: "positive" | "warning" };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const withStop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The one line shown after a reset: a report from the gate, or a refusal's own sentence.
 * Anything short of a cleared log with every dispute recorded is a warning.
 */
export function resetSentence(result: ResetReport | { message: string }): ResetSentence {
  if ("message" in result) return { sentence: result.message, tone: "warning" };

  if (result.cleared === null) {
    const failed = [...new Set(result.orders.failed.map((order) => order.order_number))];
    const numbers = failed.length > 0 ? failed : result.orders.replaced;
    const why =
      numbers.length === 0
        ? "Nothing was cleared."
        : `${plural(numbers.length, "order", "orders")} couldn't be replaced (${numbers.join(", ")}), so nothing was cleared.`;
    return { sentence: `The demo wasn't reset. ${why} Reset again to retry.`, tone: "warning" };
  }

  const replaced = result.orders.replaced.length;
  const orders =
    replaced === 0
      ? `Kept all ${result.orders.kept} ${result.orders.kept === 1 ? "order" : "orders"}.`
      : `Replaced ${plural(replaced, "order", "orders")} and kept ${result.orders.kept}.`;
  const start = `Reset in ${durationWords(result.took_ms)}. ${orders}`;

  const disputes = result.disputes;
  if (result.complete && disputes !== null && !("error" in disputes) && disputes.problems === 0) {
    return {
      sentence:
        disputes.recorded > 0
          ? `${start} Recorded ${plural(disputes.recorded, "dispute", "disputes")} again.`
          : start,
      tone: "positive",
    };
  }

  const rest =
    disputes === null
      ? "The disputes couldn't be read again."
      : "error" in disputes
        ? `The disputes couldn't be read again: ${withStop(disputes.error)}`
        : disputes.problems > 0
          ? `${plural(disputes.problems, "dispute", "disputes")} couldn't be recorded again.`
          : "The disputes couldn't all be recorded again.";
  return { sentence: `${start} ${rest}`, tone: "warning" };
}

// --- The start page's calls, from the browser to the console's own routes --------------------

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** A refusal's own sentence, or null when the answer carries none. */
async function sentenceOf(response: Response): Promise<string | null> {
  const parsed = GateMessageSchema.safeParse(await readBody(response));
  return parsed.success ? parsed.data.message : null;
}

export type LaunchResult =
  | { ok: true; href: string }
  | { ok: false; signedOut: boolean; message: string };

/** Starts a scenario through `POST /api/scenarios`; on 202, the inbox thread to open. */
export async function launchScenario(
  scenarioId: string,
  mode: ScenarioButton["mode"],
  fetchImpl: typeof fetch = fetch,
): Promise<LaunchResult> {
  const failed: LaunchResult = { ok: false, signedOut: false, message: RESOLVE_UNREACHABLE };
  let response: Response;
  try {
    response = await fetchImpl("/api/scenarios", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario_id: scenarioId, mode }),
      cache: "no-store",
    });
  } catch {
    return failed;
  }
  if (response.status === 202) {
    const accepted = ScenarioAcceptedSchema.safeParse(await readBody(response));
    return accepted.success
      ? { ok: true, href: `/inbox?thread=${encodeURIComponent(accepted.data.thread_id)}` }
      : failed;
  }
  const message = await sentenceOf(response);
  return message === null ? failed : { ok: false, signedOut: response.status === 401, message };
}

/** Resets the demo through `POST /api/demo/reset` and words the answer for the page. */
export async function requestReset(
  fetchImpl: typeof fetch = fetch,
): Promise<ResetSentence & { signedOut: boolean }> {
  const failed = {
    signedOut: false,
    sentence: APPROVAL_ROUTE_MESSAGES.unreachable,
    tone: "warning",
  } as const;
  let response: Response;
  try {
    response = await fetchImpl("/api/demo/reset", { method: "POST", cache: "no-store" });
  } catch {
    return failed;
  }
  if (response.status === 200) {
    const report = ResetReportSchema.safeParse(await readBody(response));
    return report.success ? { signedOut: false, ...resetSentence(report.data) } : failed;
  }
  const message = await sentenceOf(response);
  return message === null
    ? failed
    : { signedOut: response.status === 401, ...resetSentence({ message }) };
}
