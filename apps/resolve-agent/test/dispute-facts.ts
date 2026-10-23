import type { Prepared } from "../src/drafter";

// A `prepare_dispute_evidence` answer as the gate gives it for beat 5's KIK-1037, delivered and
// then disputed, with one completed refund added. Illustrative shop and orders; the carrier is
// simulated. Used by the template tests and by the LIVE=1 drafting check.

const usd = (minor: number, display: string) => ({ minor, currency: "USD", display });

export const RECORDED_FACTS: Prepared = {
  dispute: {
    id: "PP-D-1037",
    status: "WAITING_FOR_SELLER_RESPONSE",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    reason_words: "Item not received",
    life_cycle_stage: "CHARGEBACK",
    amount: usd(24000, "$240.00"),
    seller_response_due_date: "2026-11-01T23:59:59Z",
  },
  capture: {
    id: "CAP-1037",
    amount: usd(24000, "$240.00"),
    status: "COMPLETED",
    time: "2026-10-01T08:00:05Z",
  },
  order_number: "KIK-1037",
  shipping: [
    {
      tracking_number: "TRK1037",
      tracker_status: "SHIPPED",
      carrier: {
        source: "Carrier (simulated)",
        carrier_name: "Illustrative Post",
        status: "delivered",
        scan_events: [
          { at: "2026-10-02T08:00:00Z", description: "Accepted", place: "Nairobi" },
          { at: "2026-10-04T15:30:00Z", description: "Delivered to recipient", place: "Mombasa" },
        ],
      },
    },
  ],
  refunds: [
    {
      id: "RF-1037",
      amount: usd(2000, "$20.00"),
      status: "COMPLETED",
      time: "2026-10-06T09:05:00Z",
    },
  ],
  decisions: [
    {
      at: "2026-10-06T09:00:00Z",
      action_words: "Refund",
      amount: usd(2000, "$20.00"),
      decision: "allow",
      decision_words: "Allowed",
      reasons: [],
      claim_words: "Item damaged",
    },
  ],
  audit: {
    entry_count: 3,
    intact: true,
    head: { seq: 3, hash: "a".repeat(64) },
    export_name: "countersign-evidence-capture-CAP-1037.json",
    export_sha256: "b".repeat(64),
  },
  not_available: [],
  documents: [
    {
      id: "doc_000000000000000000000001",
      kind: "export",
      name: "countersign-evidence-capture-CAP-1037.json",
      size: 2048,
      sha256: "b".repeat(64),
    },
    {
      id: "doc_000000000000000000000002",
      kind: "pdf",
      name: "countersign-evidence-PP-D-1037.pdf",
      size: 4096,
      sha256: "c".repeat(64),
    },
  ],
  suggested: [
    { evidence_type: "PROOF_OF_FULFILLMENT", tracking_numbers: ["TRK1037"], refund_ids: [] },
    { evidence_type: "PROOF_OF_REFUND", tracking_numbers: [], refund_ids: ["RF-1037"] },
  ],
};
