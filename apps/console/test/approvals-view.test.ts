import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AnswerResult,
  AnswerResultSchema,
  type ApprovalsView,
  ApprovalsViewSchema,
  RecentSummarySchema,
} from "../src/approval-schemas";
import {
  APPROVALS_COPY,
  APPROVALS_POLL_INTERVAL_MS,
  answerCard,
  answerOutcome,
  CONTROL_CLASSES,
  cardView,
  claimPairView,
  DENIED_SENTENCE,
  pageView,
  REJECTION_SENTENCES,
  recentLine,
  signIn,
  signOut,
  timeLeft,
} from "../src/approvals-view";

// The approvals page's view models, fed the gate's answers as the console's routes pass them on.

const NOW = new Date("2026-10-20T08:04:00.000Z");
const HASH = "a".repeat(64);
const INTENT = `int_${"b".repeat(32)}`;
const PHOTO = `att_${"d".repeat(32)}`;

const card = (extra: Record<string, unknown> = {}) => ({
  step_up_id: 7,
  intent_id: INTENT,
  intent_hash: HASH,
  principal: "support-agent",
  action: "paypal.refund",
  action_words: "Refund",
  amount: { minor: 24000, currency: "USD", display: "$240.00" },
  target: { kind: "capture", id: "CAP-1037", order_id: "ORD-1037" },
  order_number: "1037",
  ticket: {
    id: `tkt_${"c".repeat(32)}`,
    channel: "email",
    sender: "payer@example.com",
    subject: "Broken mug",
    excerpt: "It arrived broken.",
    received_at: "2026-10-20T08:00:00.000Z",
    attachment_ids: [PHOTO],
    simulated: true,
  },
  claim: "damaged",
  reasons: [
    {
      code: "AMOUNT_OVER_CAP",
      words: "The refund is over the limit you set.",
      detail: "24000 > 5000",
    },
  ],
  checks: [
    {
      verifier: "capture.refundable",
      result: "pass",
      value: "COMPLETED",
      detail: "Completed.",
      records: [{ call: "GET /v2/payments/captures/CAP-1037", id: "CAP-1037" }],
    },
    {
      verifier: "shipment.status",
      result: "unknown",
      value: null,
      detail: "No tracking.",
      records: [{ call: "carrier lookup", id: null }],
    },
  ],
  claims: [
    {
      check: "evidence.photo_present",
      claim: { text: "1 photo attached", quote: null, simulated: false },
      record: {
        words: "Photo of the damage",
        detail: "One photo on the ticket.",
        value: "1",
        sources: [{ words: "Ticket store", call: "ticket lookup", id: "tkt_1" }],
      },
      verdict: "matches",
    },
    {
      check: "message",
      claim: { text: "Broken mug", quote: "It arrived broken.", simulated: true },
      record: {
        words: "Messages can't approve money. Only your signed rules can.",
        detail: "",
        value: null,
        sources: [],
      },
      verdict: "not_used",
    },
  ],
  params: null,
  decided_at: "2026-10-20T08:01:00.000Z",
  expires_at: "2026-10-20T08:16:00.000Z",
  state: "open",
  answer: null,
  can_execute: true,
  cannot_execute: null,
  ...extra,
});

const DOC = `doc_${"0a".repeat(12)}`;
const SHA = `3f9c2a${"e".repeat(58)}`;

// A held evidence submission, as the gate words its parameters.
const evidenceCard = (documents: unknown[] = [pdf()]) =>
  card({
    action: "paypal.dispute.provide_evidence",
    action_words: "Send dispute evidence",
    target: { kind: "dispute", id: "PP-D-123", order_id: null },
    ticket: null,
    claim: null,
    params: {
      kind: "provide_evidence",
      items: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_type_words: "Proof of fulfillment",
          notes: "Shipped with Carrier under tracking 1ZKIK1042; delivered.\nRecords attached.",
          tracking_numbers: ["1ZKIK1042"],
          tracking_carrier: "Carrier (simulated)",
          refund_ids: [],
        },
        {
          evidence_type: "PROOF_OF_REFUND",
          evidence_type_words: "Proof of refund",
          notes: "Refunded $20.00 (refund RF-1037). Records attached.",
          tracking_numbers: [],
          tracking_carrier: null,
          refund_ids: ["RF-1037", "RF-1038"],
        },
      ],
      documents,
    },
  });

function pdf(extra: Record<string, unknown> = {}) {
  return {
    id: DOC,
    name: "countersign-evidence-PP-D-123.pdf",
    sha256: SHA,
    size: 12_700,
    available: true,
    ...extra,
  };
}

const approvingOf = (raw: unknown) => cardView(view([raw]).open[0] as never, NOW).approving;

const view = (open: unknown[], recent: unknown[] = []): ApprovalsView =>
  ApprovalsViewSchema.parse({ open, recent });

const result = (extra: Record<string, unknown>): AnswerResult =>
  AnswerResultSchema.parse({
    outcome: "approved",
    code: null,
    step_up_id: 7,
    intent_id: INTENT,
    approval_seq: 9,
    execution: null,
    ...extra,
  });

const execution = (extra: Record<string, unknown>) => ({
  outcome: "executed",
  refund: null,
  invoice: null,
  error: null,
  ...extra,
});

describe("cards", () => {
  it("shows beat 5's card with every part, newest first", () => {
    const older = card({
      step_up_id: 3,
      decided_at: "2026-10-20T07:59:00.000Z",
      intent_hash: "f".repeat(64),
    });
    const page = pageView(view([older, card()]), NOW);
    expect(page.openCount).toBe(2);
    expect(page.cards.map((shown) => shown.id)).toEqual(["7", "3"]);
    expect(page.cards[0]).toEqual({
      id: "7",
      intentHash: HASH,
      title: "Refund $240.00",
      order: "Order 1037",
      sender: "payer@example.com",
      simulated: true,
      subject: "Broken mug",
      excerpt: "It arrived broken.",
      claim: "Says it arrived damaged",
      photos: [{ src: `/api/resolve/attachments/${PHOTO}`, alt: "Photo 1 from the customer" }],
      reasons: [{ words: "The refund is over the limit you set.", code: "AMOUNT_OVER_CAP" }],
      checks: [
        {
          verifier: "Payment can be refunded",
          result: "Passed",
          tone: "positive",
          value: "COMPLETED",
          recordId: "CAP-1037",
        },
        {
          verifier: "Shipment status",
          result: "Unknown",
          tone: "warning",
          value: null,
          recordId: null,
        },
      ],
      claims: [
        {
          check: "evidence.photo_present",
          claim: { text: "1 photo attached", quote: null, simulated: false },
          record: {
            lead: "Photo of the damage: 1",
            detail: "One photo on the ticket.",
            sources: [{ words: "Ticket store", call: "ticket lookup", id: "tkt_1" }],
          },
          verdict: { label: "Matches", tone: "positive" },
        },
        {
          check: "message",
          claim: { text: "Broken mug", quote: "It arrived broken.", simulated: true },
          record: {
            lead: "Messages can't approve money. Only your signed rules can.",
            detail: "",
            sources: [],
          },
          verdict: { label: "Not used", tone: "neutral" },
        },
      ],
      approving: null,
      timeLeft: "Expires in 12 min",
      expired: false,
      cannotExecute: null,
      actions: ["approve", "deny"],
    });
  });

  it("rejects a card answer without claims, and badges every verdict", () => {
    const { claims: _, ...bare } = card();
    expect(ApprovalsViewSchema.safeParse({ open: [bare], recent: [] }).success).toBe(false);
    const verdicts = [
      "matches",
      "contradicts",
      "passes",
      "fails",
      "no_record",
      "not_used",
    ] as const;
    const pair = card().claims[0] as never;
    const shown = verdicts.map((verdict) =>
      claimPairView({ ...(pair as object), verdict } as never),
    );
    expect(shown.map((one) => one.verdict.tone)).toEqual([
      "positive",
      "danger",
      "positive",
      "danger",
      "neutral",
      "neutral",
    ]);
  });

  it("offers only Deny, with its sentence, on a card that can't execute", () => {
    const shown = cardView(
      view([
        card({
          action: "paypal.dispute.accept_claim",
          action_words: "Accept dispute claim",
          can_execute: false,
          cannot_execute: "Countersign can't carry out this action yet.",
        }),
      ]).open[0] as never,
      NOW,
    );
    expect(shown.title).toBe("Accept dispute claim $240.00");
    expect(shown.cannotExecute).toBe("Countersign can't carry out this action yet.");
    expect(shown.actions).toEqual(["deny"]);
  });

  it("works without a ticket, an order or a claim", () => {
    const shown = cardView(
      view([card({ ticket: null, order_number: null, claim: null })]).open[0] as never,
      NOW,
    );
    expect(shown).toMatchObject({
      order: null,
      sender: null,
      simulated: false,
      excerpt: null,
      claim: null,
      photos: [],
    });
  });

  it("counts down in whole minutes, then says Expired and offers nothing", () => {
    expect(timeLeft("2026-10-20T08:16:00.000Z", NOW)).toBe("Expires in 12 min");
    expect(timeLeft("2026-10-20T08:04:01.000Z", NOW)).toBe("Expires in 1 min");
    expect(timeLeft("2026-10-20T08:04:00.000Z", NOW)).toBe("Expired");
    expect(timeLeft("not a time", NOW)).toBe("Expired");
    const late = cardView(view([card()]).open[0] as never, new Date("2026-10-20T08:16:00.001Z"));
    expect(late).toMatchObject({ timeLeft: "Expired", expired: true, actions: [] });
  });

  it("lists recent answers and expiries, one line each", () => {
    const page = pageView(
      view(
        [],
        [
          {
            step_up_id: 5,
            intent_id: `int_${"e".repeat(32)}`,
            action: "paypal.refund",
            action_words: "Refund",
            amount: { minor: 24000, currency: "USD", display: "$240.00" },
            order_number: "1037",
            outcome: "approved",
            at: "2026-10-20T08:00:00.000Z",
            channel: "approvals_page",
            execution: {
              outcome: "executed",
              refund: { id: "4XJ1", status: "COMPLETED" },
              invoice: null,
            },
          },
          {
            step_up_id: 4,
            intent_id: `int_${"f".repeat(32)}`,
            action: "paypal.invoice.send",
            action_words: "Send invoice",
            amount: { minor: 9900, currency: "USD", display: "$99.00" },
            order_number: null,
            outcome: "expired",
            at: "2026-10-20T07:00:00.000Z",
            channel: null,
            execution: null,
          },
        ],
      ),
      NOW,
    );
    expect(page.recent).toEqual([
      {
        id: "5",
        title: "Refund $240.00",
        order: "Order 1037",
        outcome: "Approved",
        tone: "positive",
        detail: "Refund 4XJ1, COMPLETED",
        time: "4m ago",
      },
      {
        id: "4",
        title: "Send invoice $99.00",
        order: null,
        outcome: "Expired, so denied",
        tone: "neutral",
        detail: null,
        time: "1h ago",
      },
    ]);
  });
});

describe("what you're approving", () => {
  it("shows every evidence item and document of a held submission", () => {
    expect(approvingOf(evidenceCard())).toEqual({
      line: "Approving sends exactly this evidence to PayPal. Nothing is sent until you approve.",
      rows: [{ label: "Dispute", text: "PP-D-123", mono: true }],
      items: [
        {
          id: "item-1",
          type: "Proof of fulfillment",
          notes: "Shipped with Carrier under tracking 1ZKIK1042; delivered.\nRecords attached.",
          tracking: { carrier: "Carrier (simulated)", numbers: ["1ZKIK1042"] },
          refundIds: [],
        },
        {
          id: "item-2",
          type: "Proof of refund",
          notes: "Refunded $20.00 (refund RF-1037). Records attached.",
          tracking: null,
          refundIds: ["RF-1037", "RF-1038"],
        },
      ],
      documents: [
        {
          id: DOC,
          name: "countersign-evidence-PP-D-123.pdf",
          size: "12.4 KB",
          sha: { short: "3f9c2aeeeeee…", full: SHA },
          href: `/api/approvals/documents/${DOC}`,
          problem: null,
        },
      ],
    });
    expect(APPROVALS_COPY.approvingHeading).toBe("What you're approving");
    expect(APPROVALS_COPY.download).toBe("Download");
  });

  it("offers no download for a document that changed or is gone", () => {
    const shown = approvingOf(evidenceCard([pdf({ size: null, available: false })]));
    expect(shown?.documents).toEqual([
      {
        id: DOC,
        name: "countersign-evidence-PP-D-123.pdf",
        size: null,
        sha: { short: "3f9c2aeeeeee…", full: SHA },
        href: null,
        problem: APPROVALS_COPY.documentGone,
      },
    ]);
    expect(APPROVALS_COPY.documentGone).toBe(
      "This document changed or is gone. Approving sends nothing.",
    );
  });

  it("words document sizes in bytes, KB and MB", () => {
    const sizes = [1, 512, 1024, 1_000_000, 1_048_576].map(
      (size) => approvingOf(evidenceCard([pdf({ size })]))?.documents[0]?.size,
    );
    expect(sizes).toEqual(["1 byte", "512 bytes", "1.0 KB", "976.6 KB", "1.0 MB"]);
  });

  it("refuses a card whose parameters aren't the gate's shape", () => {
    const junk = [
      { kind: "provide_evidence", items: [], documents: [pdf({ id: "doc_1" })] },
      { kind: "provide_evidence", items: [], documents: [pdf({ sha256: "abc" })] },
      {
        kind: "provide_evidence",
        items: [],
        documents: [pdf(), pdf(), pdf(), pdf(), pdf(), pdf()],
      },
      { kind: "refund" },
      { kind: "accept_claim" },
    ];
    for (const params of junk) {
      expect(ApprovalsViewSchema.safeParse({ open: [card({ params })], recent: [] }).success).toBe(
        false,
      );
    }
    const { params: _, ...bare } = card();
    expect(ApprovalsViewSchema.safeParse({ open: [bare], recent: [] }).success).toBe(false);
  });

  it("shows an offer's type, amount and note", () => {
    const offer = (params: Record<string, unknown>) =>
      approvingOf(
        card({
          action: "paypal.dispute.make_offer",
          action_words: "Make dispute offer",
          params: { kind: "make_offer", note: "We can refund half.", ...params },
        }),
      );
    expect(
      offer({
        offer_type: "REFUND",
        offer_type_words: "Refund",
        amount: { minor: 12000, currency: "USD", display: "$120.00" },
      }),
    ).toEqual({
      line: null,
      rows: [
        { label: "Offer", text: "Refund", mono: false },
        { label: "Amount", text: "$120.00", mono: false },
        { label: "Note", text: "We can refund half.", mono: false },
      ],
      items: [],
      documents: [],
    });
    expect(
      offer({
        offer_type: "REPLACEMENT_WITHOUT_REFUND",
        offer_type_words: "Replacement without refund",
        amount: null,
        note: null,
      })?.rows,
    ).toEqual([
      { label: "Offer", text: "Replacement without refund", mono: false },
      { label: "Note", text: "No note", mono: false },
    ]);
    expect(offer({ offer_type: null, offer_type_words: null, amount: null })?.rows[0]).toEqual({
      label: "Offer",
      text: "Not set",
      mono: false,
    });
  });

  it("shows accept claim's dispute and note", () => {
    const claim = (note: string | null) =>
      approvingOf(
        card({
          action: "paypal.dispute.accept_claim",
          target: { kind: "dispute", id: "PP-D-123", order_id: null },
          params: { kind: "accept_claim", note },
        }),
      );
    const dispute = { label: "Dispute", text: "PP-D-123", mono: true };
    expect(claim("Sorry about this.")).toEqual({
      line: null,
      rows: [dispute, { label: "Note", text: "Sorry about this.", mono: false }],
      items: [],
      documents: [],
    });
    expect(claim(null)?.rows).toEqual([dispute, { label: "Note", text: "No note", mono: false }]);
  });

  it("shows an invoice send's recipients and note", () => {
    const invoice = (params: Record<string, unknown>) =>
      approvingOf(
        card({
          action: "paypal.invoice.send",
          params: {
            kind: "invoice_send",
            note: null,
            send_to_recipient: true,
            additional_recipients: [],
            ...params,
          },
        }),
      )?.rows;
    expect(invoice({})).toEqual([
      { label: "Recipient", text: "PayPal emails the invoice's recipient", mono: false },
      { label: "Note", text: "No note", mono: false },
    ]);
    expect(
      invoice({
        send_to_recipient: false,
        additional_recipients: ["a@example.com", "b@example.com"],
        note: "Thanks.",
      }),
    ).toEqual([
      { label: "Recipient", text: "PayPal doesn't email the recipient", mono: false },
      { label: "Also sent to", text: "a@example.com, b@example.com", mono: true },
      { label: "Note", text: "Thanks.", mono: false },
    ]);
  });
});

describe("outcome sentences", () => {
  it("says what an approved dispute action did", () => {
    const sentence = (dispute: unknown) =>
      answerOutcome(result({ execution: execution({ dispute }) })).sentence;
    expect(sentence({ id: "PP-D-123", status: "UNDER_REVIEW" })).toBe(
      "Approved. Dispute PP-D-123 is under review.",
    );
    expect(sentence({ id: "PP-D-123", status: null })).toBe(
      "Approved. PayPal took it for dispute PP-D-123.",
    );
    const line = recentLine(
      RecentSummarySchema.parse({
        step_up_id: 6,
        intent_id: INTENT,
        action: "paypal.dispute.provide_evidence",
        action_words: "Send dispute evidence",
        amount: { minor: 24000, currency: "USD", display: "$240.00" },
        order_number: null,
        outcome: "approved",
        at: "2026-10-20T08:00:00.000Z",
        channel: "approvals_page",
        execution: {
          outcome: "executed",
          refund: null,
          invoice: null,
          dispute: { id: "PP-D-123", status: "UNDER_REVIEW" },
        },
      }),
      NOW,
    );
    expect(line.detail).toBe("Dispute PP-D-123, UNDER_REVIEW");
  });

  it("says what an approval did", () => {
    const sentence = (extra: Record<string, unknown>) => answerOutcome(result(extra)).sentence;
    expect(
      sentence({ execution: execution({ refund: { id: "4XJ1", status: "COMPLETED" } }) }),
    ).toBe("Approved. Refund 4XJ1 is done.");
    expect(sentence({ execution: execution({ invoice: { id: "INV2-AB", status: "SENT" } }) })).toBe(
      "Approved. Invoice INV2-AB is sent.",
    );
    expect(
      sentence({
        execution: execution({
          outcome: "failed",
          error: { name: "UNPROCESSABLE_ENTITY", issues: ["REFUND_AMOUNT_EXCEEDED"] },
        }),
      }),
    ).toBe("Approved, but PayPal refused it: UNPROCESSABLE_ENTITY, REFUND_AMOUNT_EXCEEDED.");
    expect(sentence({ execution: execution({ outcome: "failed" }) })).toBe(
      "Approved, but PayPal refused it: it gave no reason.",
    );
    expect(sentence({ execution: execution({ outcome: "unknown" }) })).toBe(
      "Approved. PayPal hasn't confirmed it yet.",
    );
    expect(sentence({ execution: null })).toBe("Approved. PayPal hasn't confirmed it yet.");
  });

  it("says a deny sent nothing", () => {
    expect(answerOutcome(result({ outcome: "denied" })).sentence).toBe(DENIED_SENTENCE);
    expect(DENIED_SENTENCE).toBe("Denied. Nothing was sent.");
  });

  it("maps every rejection code to its sentence", () => {
    expect(REJECTION_SENTENCES).toEqual({
      HASH_MISMATCH: "This card changed. Nothing was sent.",
      ALREADY_ANSWERED: "This was already answered.",
      EXPIRED: "This card expired, so it counts as denied.",
      ALREADY_REQUESTED: "This was already carried out.",
      ACTION_UNAVAILABLE: "Countersign can't carry out this action yet.",
      DUPLICATE_REFUND: "Another refund already went to this payment.",
    });
    for (const [code, sentence] of Object.entries(REJECTION_SENTENCES)) {
      expect(answerOutcome(result({ outcome: "rejected", code }))).toEqual({
        sentence,
        tone: "warning",
      });
    }
  });
});

describe("answering", () => {
  const respond = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json(body, { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };
  const shown = { id: "7", intentHash: HASH };

  it("sends the card's hash and reads the outcome", async () => {
    const { calls, fetchImpl } = respond(
      200,
      result({ execution: execution({ refund: { id: "4XJ1", status: "COMPLETED" } }) }),
    );
    expect(await answerCard(shown, "approve", fetchImpl)).toEqual({
      ok: true,
      value: { sentence: "Approved. Refund 4XJ1 is done.", tone: "positive" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/approvals/7");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      answer: "approve",
      intent_hash: HASH,
    });
  });

  it("passes on the route's sentence, and treats junk or no answer as unreachable", async () => {
    expect(
      await answerCard(shown, "deny", respond(401, { message: "Sign in again." }).fetchImpl),
    ).toEqual({ ok: false, status: 401, message: "Sign in again." });
    expect(await answerCard(shown, "deny", respond(200, { outcome: "yes" }).fetchImpl)).toEqual({
      ok: false,
      status: 502,
      message: APPROVALS_COPY.unreachable,
    });
    expect(
      await answerCard(shown, "deny", respond(200, result({ step_up_id: 8 })).fetchImpl),
    ).toMatchObject({ ok: false, status: 502 });
    const broken = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await answerCard(shown, "deny", broken)).toMatchObject({ ok: false, status: 502 });
  });

  it("signs in, says a wrong key isn't right, and signs out", async () => {
    const good = respond(200, { signed_in: true });
    expect(await signIn("k".repeat(40), good.fetchImpl)).toEqual({ ok: true, value: null });
    expect(good.calls[0]?.url).toBe("/api/approvals/session");
    expect(JSON.parse(String(good.calls[0]?.init?.body))).toEqual({ key: "k".repeat(40) });
    expect(await signIn("nope", respond(401, { message: "x" }).fetchImpl)).toEqual({
      ok: false,
      status: 401,
      message: "That key isn't right.",
    });
    expect(
      await signIn("k".repeat(40), respond(502, { message: APPROVALS_COPY.unreachable }).fetchImpl),
    ).toEqual({ ok: false, status: 502, message: APPROVALS_COPY.unreachable });
    const out = respond(200, { signed_in: false });
    expect(await signOut(out.fetchImpl)).toBe(true);
    expect(out.calls[0]?.init?.method).toBe("DELETE");
  });

  it("polls every 3 seconds", () => {
    expect(APPROVALS_POLL_INTERVAL_MS).toBe(3_000);
  });
});

describe("controls", () => {
  const height = (classes: string) => {
    const match = /(?:^| )h-(\d+)(?: |$)/.exec(classes);
    return match === null ? 0 : Number(match[1]) * 4;
  };

  it("makes Approve and Deny 40px and every other control at least 24px", () => {
    expect(height(CONTROL_CLASSES.approve)).toBe(40);
    expect(height(CONTROL_CLASSES.deny)).toBe(40);
    expect(CONTROL_CLASSES.approve).toContain("bg-inverted-solid");
    expect(CONTROL_CLASSES.deny).toContain("bg-component-on-container-strong");
    for (const classes of Object.values(CONTROL_CLASSES)) {
      expect(height(classes)).toBeGreaterThanOrEqual(24);
    }
  });

  it("keeps the view model free of server-only imports", () => {
    const source = readFileSync(new URL("../src/approvals-view.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    for (const name of imports)
      expect(["./approval-schemas", "./audit-schemas", "./payout-words", "./time"]).toContain(name);
    const words = readFileSync(new URL("../src/payout-words.ts", import.meta.url), "utf8");
    expect(words).not.toMatch(/\bimport\b/);
  });

  it("keeps the approver key and the gate's address out of the page's client code", () => {
    for (const path of [
      "../app/approvals/approvals-board.tsx",
      "../app/console-nav.tsx",
      "../app/sign-in.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source).not.toContain("GATE_URL");
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("document.cookie");
    }
  });
});
