# 0023. Seed state and carrier shipments live in Postgres, the carrier mock stores an explicit status, and each seed run is named and resumable

Status: accepted
Decided-by: autopilot (delegated), phase 5 feature spec, 17 Oct 2026, under brief §14 v1.4. The answerer's rules escalate it, because a stored data model is expensive to reverse. The owner can overturn it (`.ralph/human.md`, Decided for you)
Question: Phase 5's seed creates about 30 real sandbox orders, and the carrier mock reports their shipment status. Where do the seeded orders and the shipment statuses live so that the gate (phase 6), Resolve (phase 8), the demo reset (phase 13) and the bench (phase 14) all read the same thing? Is a status stored, or worked out from dates? What happens when the seed runs again?
Decision:
- **Two new tables in `@countersign/db`,** in the second migration:
  - `carrier_shipments`: one row per tracking number. It holds the shipment status (`lost`, `stalled_10d`, `in_transit` or `delivered`, enforced by a CHECK constraint), the carrier's display name, the scan events (time, description, place) and when the row was written. The carrier mock reads only this table.
  - `seed_orders`: one row per demo order number (`KIK-1013` to `KIK-1042`). It holds the run ID, the PayPal order ID and capture ID (both UNIQUE), the amount in integer minor units and its currency, the payer's email as PayPal returned it, which seed buyer paid, the tracking number, the order's demo role, and when it was seeded.
  - Neither table is hashed, so ordinary columns and jsonb are fine. Neither is append-only: a new seed run replaces the `seed_orders` rows and adds its own shipments.
- **The status is stored, never derived from the clock.** Scan events carry real dates, worked out from offsets at seed time, so a card can say "delivered 3 Oct". A parcel seeded as in transit doesn't turn into stalled_10d by itself ten days into judging. Only a seed run, or a later phase's scenario tooling, changes a status.
- **Every seed run has a run ID.** Each PayPal call in it uses a request ID made from the run ID, the order number and the step, so a run that stops halfway is resumed by running it again with the same ID, and nothing is charged twice. Tracking numbers and invoice IDs include the run ID, so two runs never collide.
- **Two seed buyers.** The orders named in beat 3's injected text (`KIK-1038` to `KIK-1041`) are paid by a second sandbox buyer, and `KIK-1042` by the first, who sends that email. Without a second payer, `TICKET_NOT_FROM_PAYER` couldn't fire. The seed refuses to start unless both vault tokens are set (`PAYPAL_SEED_VAULT_TOKEN` and `PAYPAL_SEED_VAULT_TOKEN_B`).
- **The storefront's own sales aren't seed state.** An order a shopper places on the storefront is real and captured, but it gets no tracker and no row in either table in this phase.
Basis:
- Brief §5 item 7 ("a seed script creates about 30 real sandbox orders with captures and trackers"), §5 item 8 (reset to the seed state), §6 beat 3 (#1038–1041 denied as not from the payer, #1042 held as delivered), §10 trade-off 3 (the judge path works every time), §11 (reset in ≤ 60 seconds).
- Original brief §11 ("some delivered, some lost or stalled, via the carrier mock") and §12's data model.
- `docs/spikes.md` S1 (the vault route; "for attack cases that need a different payer, vault a second sandbox personal account") and S2 (PayPal's tracker only says shipped or cancelled; the tracker ID is the capture ID plus the tracking number).
- ADR 0003 (Postgres with Drizzle, PGlite in tests) and ADR 0022 (only `audit_log` is hashed and append-only).
Consequences:
- Phase 6's gate reads the shipment status from `carrier_shipments` through `@countersign/carrier-mock`, by the tracking number on the order's PayPal tracker.
- Phase 13's reset can start a fresh seed run, or reuse the current one when its captures are still unrefunded, and truncate these tables with the audit log.
- The owner has to vault a second sandbox buyer once, as in spike S1 (`.ralph/human.md`).
- A real tracking API would replace the mock behind the same adapter interface; the tables would then only hold the demo's own shipments.
