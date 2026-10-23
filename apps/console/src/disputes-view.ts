import { type DisputeDraft, type DisputeList, ResolveMessageSchema } from "./resolve-schemas";
import { formatTime } from "./time";

// What the Disputes page shows (ADR 0035, 0037), worked out from Resolve's parsed `GET /disputes`
// answer: one row per dispute, with its latest draft. Pure and free of server-only imports, so
// the page only renders it and the "Draft again" button can share the copy. "Waiting for you" is
// shown only when the gate is holding the proposal for approval.

export const DISPUTES_COPY = {
  title: "Disputes",
  subtitle: "Disputes PayPal opened, and the evidence your agent drafted.",
  empty:
    "No disputes yet. They appear here when PayPal opens one, or after npm run disputes -- sync.",
  draftAgain: "Draft again",
  openDecision: "Open decision",
  unreachable: "Resolve isn't reachable. Start it, then try again.",
} as const;

export type DraftWords = { words: string; href: string | null };

export type DisputeRow = {
  id: string;
  disputeId: string;
  /** The reason in words, once the draft has read the dispute; null before. */
  reason: string | null;
  when: string;
  at: string;
  amount: string | null;
  draft: DraftWords;
  canDraftAgain: boolean;
  draftedBy: string | null;
  decision: { href: string; label: string } | null;
};

export type DisputesView = { empty: string | null; rows: DisputeRow[] };

// Why a draft failed, in words. A gate sentence from `prepare_dispute_evidence` is shown as is.
const FAILURE_WORDS: Record<string, string> = {
  gate_unavailable: "the gate wasn't reachable.",
  proposal_rejected: "the gate refused the proposal.",
  interrupted: "Resolve stopped before it finished.",
  not_configured: "drafting isn't set up.",
};

function failureWords(outcome: string | null): string {
  if (outcome === null) return "Couldn't draft";
  const prepared = /^prepare_failed:(.*)$/.exec(outcome);
  if (prepared !== null) {
    const why = prepared[1]?.trim() ?? "";
    return `Couldn't draft: ${/^[A-Z].*\.$/.test(why) ? why : "the evidence couldn't be prepared."}`;
  }
  return `Couldn't draft: ${FAILURE_WORDS[outcome] ?? outcome}`;
}

function draftWords(draft: DisputeDraft): DraftWords {
  switch (draft.status) {
    case "queued":
    case "running":
      return { words: "Drafting", href: null };
    case "proposed":
      return draft.agent_response_status === "pending_approval"
        ? { words: "Waiting for you", href: "/approvals" }
        : { words: "Proposed", href: null };
    case "failed":
      return { words: failureWords(draft.outcome), href: null };
    case "not_run":
      return {
        words: `Not run: ${draft.outcome === "daily_cap" ? "daily limit" : (draft.outcome ?? "no reason given")}`,
        href: null,
      };
  }
}

function draftedByWords(draftedBy: string | null): string | null {
  if (draftedBy === null) return null;
  return draftedBy === "template" ? "Template, no AI" : `Gemini ${draftedBy}`;
}

export function disputesView(list: DisputeList, now: Date): DisputesView {
  if (list.drafts.length === 0) return { empty: DISPUTES_COPY.empty, rows: [] };
  return {
    empty: null,
    rows: list.drafts.map((draft) => ({
      id: draft.draft_id,
      disputeId: draft.dispute_id,
      reason: draft.dispute?.reason_words ?? null,
      when: formatTime(draft.queued_at, now),
      at: draft.queued_at,
      amount: draft.dispute?.amount.display ?? null,
      draft: draftWords(draft),
      canDraftAgain: draft.status === "failed",
      draftedBy: draftedByWords(draft.drafted_by),
      decision:
        draft.intent_id === null
          ? null
          : {
              href: `/decisions/intent/${encodeURIComponent(draft.intent_id)}`,
              label: DISPUTES_COPY.openDecision,
            },
    })),
  };
}

// --- Calls from the page (through the console's own route) ----------------------------------

export type CallResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

/** "Draft again": asks the console's route to queue a new draft for a dispute. */
export async function draftAgain(
  disputeId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CallResult<null>> {
  try {
    const response = await fetchImpl("/api/disputes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispute_id: disputeId }),
      cache: "no-store",
    });
    if (response.status === 200 || response.status === 202) return { ok: true, value: null };
    let refusal: ReturnType<typeof ResolveMessageSchema.safeParse> | null = null;
    try {
      refusal = ResolveMessageSchema.safeParse(await response.json());
    } catch {
      // Not JSON: the fixed sentence stands.
    }
    const message = refusal?.success ? refusal.data.message : DISPUTES_COPY.unreachable;
    return { ok: false, status: response.status, message };
  } catch {
    return { ok: false, status: 502, message: DISPUTES_COPY.unreachable };
  }
}
