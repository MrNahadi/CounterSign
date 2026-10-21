import { REASONS } from "@countersign/mandate";
import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatTime,
  listIsWorking,
  NO_CHECKS,
  outcomeSentence,
  POLL_INTERVAL_MS,
  runView,
  statusBadge,
  threadListItems,
  threadView,
} from "../src/inbox-view";
import {
  type Run,
  type ThreadDetail,
  ThreadDetailSchema,
  type ThreadList,
  ThreadListSchema,
} from "../src/resolve-schemas";

// The inbox's view models, fed Resolve's answers as the console's routes pass them on.

const NOW = new Date("2026-10-20T08:10:00.000Z");
const id = (prefix: string, c: string) => `${prefix}_${c.repeat(32)}`;
const T1 = id("tkt", "1");
const T2 = id("tkt", "2");
const T3 = id("tkt", "3");
const PHOTO = id("att", "f");
const INTENT = "int_0123456789abcdef01234567";

const summary = (threadId: string, at: string, latest: unknown, extra = {}) => ({
  thread_id: threadId,
  channel: "email",
  sender_email: "payer@example.com",
  sender_phone: null,
  subject: "Stalled parcel",
  preview: "My parcel hasn't moved.",
  latest_activity_at: at,
  latest_run: latest,
  ...extra,
});

const list: ThreadList = ThreadListSchema.parse({
  threads: [
    summary(T1, "2026-10-20T08:05:00.000Z", {
      run_id: "run_1",
      mode: "protected",
      status: "replied",
      outcome: "replied",
    }),
    summary(
      T2,
      "2026-10-20T08:09:30.000Z",
      { run_id: "run_2", mode: "baseline", status: "running", outcome: null },
      { channel: "chat", sender_email: null, sender_phone: "+254700000000", subject: null },
    ),
    summary(
      T3,
      "2026-10-01T08:00:00.000Z",
      { run_id: "run_3", mode: "protected", status: "failed", outcome: "gate_unavailable" },
      { subject: null, preview: "" },
    ),
  ],
});

const tool = (n: number, name: string, args: unknown, result: unknown, local = false) => ({
  kind: "tool",
  step: n,
  id: `call_${n}`,
  name,
  args,
  result,
  latencyMs: 20,
  local,
});

const structured = (content: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(content) }],
  structuredContent: content,
  isError: false,
});

const baseRun = {
  run_id: "run_1",
  ticket_id: T1,
  mode: "protected",
  model: "gemini-3.5-flash-lite",
  model_versions: ["gemini-3.5-flash-lite-001", "gemini-3.5-flash-lite-002"],
  status: "replied",
  outcome: "replied",
  reply: "Your refund is on its way.",
  queued_at: "2026-10-20T08:00:00.000Z",
  started_at: "2026-10-20T08:00:01.000Z",
  finished_at: "2026-10-20T08:01:09.400Z",
  trace: null,
  executions: [],
};

const protectedRun = {
  ...baseRun,
  trace: {
    mode: "protected",
    tools: ["create_refund", "find_order"],
    rewrites: [],
    steps: [
      { kind: "model", step: 1, model: "gemini-3.5-flash-lite" },
      tool(
        2,
        "find_order",
        { order_number: "KIK-1035" },
        structured({
          order_number: "KIK-1035",
          paypal_order_id: "5O190127TN364715T",
          capture_id: "3C679366HH908993F",
          amount: { value: "48.00", currency_code: "USD" },
          tracking_number: "TRK-1",
        }),
        true,
      ),
      tool(
        3,
        "create_refund",
        {
          capture_id: "3C679366HH908993F",
          amount: { value: "48.00", currency_code: "USD" },
          justification: { ticket_id: T1 },
        },
        structured({ decision: "allowed", intent_id: INTENT, intent_hash: "a".repeat(64) }),
      ),
      tool(
        4,
        "create_refund",
        { capture_id: "9XX", amount: { value: "240.00", currency_code: "USD" } },
        structured({
          decision: "denied",
          intent_id: null,
          reasons: [
            { code: "TICKET_NOT_FROM_PAYER", detail: "x" },
            { code: "NOT_A_REAL_CODE", detail: "y" },
          ],
          safe_reply_hint: "Ask them to write from the email they paid with.",
        }),
      ),
      tool(
        5,
        "accept_dispute_claim",
        { dispute_id: "PP-D-1" },
        structured({
          decision: "pending_approval",
          intent_id: "int_aaaaaaaaaaaaaaaaaaaaaaaa",
          reasons: [{ code: "PAYER_UNKNOWN", detail: "z" }],
          expires_at: "2026-10-20T08:15:00.000Z",
        }),
      ),
      tool(
        6,
        "find_order",
        { order_number: "KIK-9999" },
        {
          content: [{ type: "text", text: "No order with that number." }],
          isError: true,
        },
        true,
      ),
      tool(7, "get_order", { id: "X" }, null),
    ],
  },
  executions: [
    {
      intent_id: INTENT,
      outcome: "executed",
      refund_id: "8RT45612AB",
      refund_status: "COMPLETED",
    },
  ],
};

const baselineRun = {
  ...baseRun,
  run_id: "run_b",
  mode: "baseline",
  trace: {
    mode: "baseline",
    tools: [],
    rewrites: [],
    steps: [
      tool(
        1,
        "create_refund",
        { capture_id: "3C6", amount: { value: "48.00", currency_code: "USD" } },
        {
          content: [
            { type: "text", text: JSON.stringify({ id: "1JU08902", status: "COMPLETED" }) },
          ],
        },
      ),
      tool(2, "get_dispute", { dispute_id: "PP-D-2" }, structured({ status: "OPEN" })),
      tool(3, "accept_dispute_claim", { dispute_id: "PP-D-2" }, structured({ status: "RESOLVED" })),
    ],
  },
};

const parseRun = (run: unknown): Run => ThreadDetailSchema.shape.runs.element.parse(run);

describe("the thread list", () => {
  it("lists newest activity first with channel, sender, title, time and status", () => {
    const items = threadListItems(list, { now: NOW, selectedId: T1 });
    expect(items.map((item) => item.id)).toEqual([T2, T1, T3]);
    expect(items[0]).toEqual({
      id: T2,
      href: `/inbox?thread=${T2}`,
      channel: "chat",
      channelLabel: "Chat",
      sender: "+254700000000",
      title: "My parcel hasn't moved.",
      time: "Just now",
      status: { label: "Working", tone: "neutral", live: true },
      selected: false,
    });
    expect(items[1]).toMatchObject({
      sender: "payer@example.com",
      title: "Stalled parcel",
      time: "5m ago",
      status: { label: "Replied", tone: "positive" },
      selected: true,
    });
    expect(items[2]).toMatchObject({
      title: "No message text",
      time: "1 Oct 2026",
      status: { label: "Stopped", tone: "warning" },
    });
  });

  it("badges every status with a word, and a thread with no run as Not run", () => {
    expect(statusBadge("queued").label).toBe("Working");
    expect(statusBadge("stopped").label).toBe("Stopped");
    expect(statusBadge("failed").label).toBe("Stopped");
    expect(statusBadge("not_run").label).toBe("Not run");
    expect(statusBadge(null).label).toBe("Not run");
  });

  it("knows when a listed thread is still working", () => {
    expect(listIsWorking(list)).toBe(true);
    expect(listIsWorking({ threads: list.threads.filter((t) => t.thread_id !== T2) })).toBe(false);
  });
});

describe("times", () => {
  it("are relative under a week and dates after", () => {
    expect(formatTime("2026-10-20T07:10:00.000Z", NOW)).toBe("1h ago");
    expect(formatTime("2026-10-17T08:10:00.000Z", NOW)).toBe("3d ago");
    expect(formatTime("2026-10-13T08:09:00.000Z", NOW)).toBe("13 Oct 2026");
    expect(formatTime("someday", NOW)).toBe("someday");
  });

  it("gives run durations compactly", () => {
    expect(formatDuration("2026-10-20T08:00:01.000Z", "2026-10-20T08:01:09.400Z")).toBe("1m 08s");
    expect(formatDuration("2026-10-20T08:00:01.000Z", "2026-10-20T08:00:15.000Z")).toBe("14s");
    expect(formatDuration("2026-10-20T08:00:01.000Z", null)).toBeNull();
    expect(formatDuration(null, null)).toBeNull();
  });
});

describe("What Resolve did, protected", () => {
  const view = runView(parseRun(protectedRun));

  it("shows the mode, the latest model version and how long it took", () => {
    expect(view).toMatchObject({
      modeLabel: "Protected",
      model: "gemini-3.5-flash-lite-002",
      duration: "1m 08s",
      status: { label: "Replied" },
      working: false,
      reply: "Your refund is on its way.",
      outcome: null,
    });
  });

  it("has one row per tool call, with key arguments and the result in a few words", () => {
    expect(view.toolRows.map((row) => [row.name, row.result])).toEqual([
      ["find_order", "Found KIK-1035, 48.00 USD"],
      ["create_refund", "Allowed"],
      ["create_refund", "Denied"],
      ["accept_dispute_claim", "Waiting for approval"],
      ["find_order", "No order with that number."],
      ["get_order", "The connection to the tool failed."],
    ]);
    expect(view.toolRows[0]?.args).toEqual([{ label: "Order", value: "KIK-1035" }]);
    expect(view.toolRows[1]?.args).toEqual([
      { label: "Capture", value: "3C679366HH908993F" },
      { label: "Amount", value: "48.00 USD" },
    ]);
    expect(view.toolRows[3]?.args).toEqual([{ label: "Dispute", value: "PP-D-1" }]);
    expect(view.toolRows.every((row) => !row.noChecks)).toBe(true);
  });

  it("shows the gate's decision and every reason as words beside its code", () => {
    expect(view.toolRows[1]?.decision).toEqual({ label: "Allowed", tone: "positive", reasons: [] });
    expect(view.toolRows[2]?.decision).toEqual({
      label: "Denied",
      tone: "danger",
      reasons: [
        { words: REASONS.TICKET_NOT_FROM_PAYER.words, code: "TICKET_NOT_FROM_PAYER" },
        {
          words: "Countersign gave a reason this console doesn't know.",
          code: "NOT_A_REAL_CODE",
        },
      ],
    });
    expect(view.toolRows[3]?.decision).toEqual({
      label: "Waiting for approval",
      tone: "warning",
      reasons: [{ words: REASONS.PAYER_UNKNOWN.words, code: "PAYER_UNKNOWN" }],
    });
    expect(view.toolRows[0]?.decision).toBeNull();
  });

  it("shows an allowed refund's PayPal refund ID, and none without an execution", () => {
    expect(view.toolRows[1]?.refundId).toBe("8RT45612AB");
    expect(view.toolRows[2]?.refundId).toBeNull();
    const unexecuted = runView(parseRun({ ...protectedRun, executions: [] }));
    expect(unexecuted.toolRows[1]?.refundId).toBeNull();
  });
});

describe("What Resolve did, baseline", () => {
  const view = runView(parseRun(baselineRun));

  it("marks money calls as unchecked and shows PayPal's answer", () => {
    expect(view.modeLabel).toBe("Baseline");
    expect(NO_CHECKS).toBe("No checks: straight to PayPal");
    expect(view.toolRows.map((row) => [row.name, row.result, row.noChecks, row.refundId])).toEqual([
      ["create_refund", "Refund 1JU08902, COMPLETED", true, "1JU08902"],
      ["get_dispute", "Answered.", false, null],
      ["accept_dispute_claim", "PayPal answered: RESOLVED", true, null],
    ]);
    expect(view.toolRows.every((row) => row.decision === null)).toBe(true);
  });

  it("never reads a gate decision from a baseline result", () => {
    const fake = {
      ...baselineRun,
      trace: {
        ...baselineRun.trace,
        steps: [
          tool(1, "create_refund", {}, structured({ decision: "allowed", intent_id: INTENT })),
        ],
      },
    };
    const row = runView(parseRun(fake)).toolRows[0];
    expect(row?.decision).toBeNull();
    expect(row?.noChecks).toBe(true);
  });
});

describe("outcomes", () => {
  it("are one plain sentence for every stopped, failed or not-run outcome", () => {
    const cases: [Run["status"], string, string][] = [
      ["stopped", "model_stopped:MAX_TOKENS", "Resolve stopped: Gemini didn't finish its answer."],
      [
        "stopped",
        "model_stopped:FINISH_REASON_MISSING",
        "Resolve stopped: Gemini didn't finish its answer.",
      ],
      ["stopped", "model_stopped:SAFETY", "Resolve stopped: Gemini blocked its answer."],
      ["stopped", "model_stopped:NO_CANDIDATE", "Resolve stopped: Gemini sent no answer."],
      ["stopped", "model_stopped:NO_PARTS", "Resolve stopped: Gemini's answer was empty."],
      [
        "stopped",
        "step_cap",
        "Resolve stopped: it reached its limit of 8 model calls or 12 tool calls.",
      ],
      ["stopped", "unknown_tool", "Resolve stopped: Gemini asked for a tool Resolve doesn't have."],
      ["stopped", "empty_reply", "Resolve stopped: Gemini finished without a reply."],
      ["failed", "model_unavailable", "Resolve stopped: Gemini wasn't available."],
      ["failed", "model_error", "Resolve stopped: Gemini refused the request."],
      ["failed", "tool_transport_failed", "Resolve stopped: the connection to its tools broke."],
      ["failed", "gate_unavailable", "Resolve stopped: it couldn't reach Countersign."],
      ["failed", "baseline_unavailable", "Resolve stopped: it couldn't connect to PayPal's tools."],
      ["failed", "interrupted", "Resolve stopped: it was restarted during this run."],
      ["not_run", "daily_cap", "Resolve didn't run: today's run limit is reached."],
      ["not_run", "not_configured", "Resolve didn't run: no Gemini API key is set."],
      ["failed", "something_new", "Resolve stopped."],
      ["not_run", "something_new", "Resolve didn't run."],
    ];
    for (const [status, outcome, sentence] of cases) {
      expect(outcomeSentence(status, outcome)).toBe(sentence);
    }
    expect(outcomeSentence("replied", "replied")).toBeNull();
    expect(outcomeSentence("running", null)).toBeNull();
  });

  it("never shows a reply from a run that didn't reply", () => {
    const view = runView(
      parseRun({ ...baseRun, status: "stopped", outcome: "step_cap", reply: "Leaked." }),
    );
    expect(view.reply).toBeNull();
    expect(view.outcome).toBe(
      "Resolve stopped: it reached its limit of 8 model calls or 12 tool calls.",
    );
  });
});

describe("the thread view", () => {
  const follow = id("tkt", "9");
  const message = (ticketId: string, body: string, at: string, attachments: unknown[] = []) => ({
    ticket_id: ticketId,
    channel: "email",
    sender_email: "payer@example.com",
    sender_phone: null,
    subject: "Stalled parcel",
    body,
    attachments,
    received_at: at,
    simulated: true,
  });
  const thread = (runs: unknown[]): ThreadDetail =>
    ThreadDetailSchema.parse({
      thread_id: T1,
      messages: [
        message(T1, "Where is my parcel?", "2026-10-20T08:00:00.000Z", [
          { id: PHOTO, content_type: "image/jpeg" },
        ]),
        message(follow, "Any news?", "2026-10-20T08:08:00.000Z"),
      ],
      runs,
    });

  it("puts each message before its runs, with its photos", () => {
    const view = threadView(
      thread([
        { ...baseRun, run_id: "run_a" },
        {
          ...baseRun,
          run_id: "run_b",
          ticket_id: follow,
          status: "running",
          reply: null,
          outcome: null,
          finished_at: null,
        },
      ]),
      { now: NOW },
    );
    expect(
      view.entries.map((entry) => (entry.kind === "message" ? entry.message.id : entry.run.id)),
    ).toEqual([T1, "run_a", follow, "run_b"]);
    expect(view).toMatchObject({
      id: T1,
      title: "Stalled parcel",
      sender: "payer@example.com",
      channelLabel: "Email",
      working: true,
    });
    const first = view.entries[0];
    expect(first?.kind === "message" && first.message).toMatchObject({
      body: "Where is my parcel?",
      time: "10m ago",
      photos: [{ src: `/api/resolve/attachments/${PHOTO}`, alt: "Photo 1 from the customer" }],
    });
    const working = view.entries[3];
    expect(working?.kind === "run" && working.run).toMatchObject({
      working: true,
      status: { label: "Working", live: true },
      duration: null,
      outcome: null,
      reply: null,
    });
  });

  it("stops working, so polling stops, once every run has ended", () => {
    expect(threadView(thread([baseRun]), { now: NOW }).working).toBe(false);
    expect(threadView(thread([{ ...baseRun, status: "queued" }]), { now: NOW }).working).toBe(true);
    expect(POLL_INTERVAL_MS).toBe(2000);
  });
});
