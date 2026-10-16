# 0019. Decision path shapes: verifiers read normalized record snapshots, shared decision types live in `@countersign/mandate`, and hashes use in-house RFC 8785 over integer-only JSON

Status: accepted
Decided-by: Claude, writing the phase 3 feature spec on 16 Oct 2026 (strong inferences from the brief, tech-stack.md and ADR 0003). The owner approved it with the phase 3 tickets on 17 Oct 2026
Question: Phase 3 builds the first decision path from fixtures. What do verifiers read, where do the types shared by the gate, the verifiers and the evaluator live, how are intents and mandates hashed, and how does a step-up or deny rule say why?
Decision:
- **Verifiers read normalized record snapshots, not raw rail JSON.** Each snapshot carries only the fields a verifier needs, plus the call it came from and its record ID, such as `GET /v2/payments/captures/{id}` and `7YL89768KH2865638`.
  - Phase 3 builds the snapshot types and fills them from fixtures.
  - Phase 6 adds the mappers from raw PayPal responses to snapshots in `@countersign/rail-paypal`, with contract tests on recorded sandbox responses. The carrier mock (phase 5) returns carrier snapshots directly.
- **Shared decision types live in `@countersign/mandate`:** the known action names, the verifier names, the intent, a verifier result, the reason-code catalog and the decision. `@countersign/verifiers` depends on `@countersign/mandate`, never the reverse, so there's no import cycle.
- **Canonical JSON is RFC 8785 (JCS), implemented in `@countersign/mandate` for the JSON we hash.** That JSON is objects, arrays, strings, booleans, null and safe integers. Money is always integer minor units, so a non-integer, non-finite or unsafe number is rejected rather than serialized. Keys are sorted by UTF-16 code units, and strings use JSON escaping as RFC 8785 specifies. No new dependency.
- **The intent hash covers what executes,** and nothing that only explains it: principal, rail, action, amount, currency, target and ticket ID. The claim and the mandate version are stored with the intent but not hashed. So the same refund proposed under mandate v3 and v4 keeps one `PayPal-Request-Id`, and can't refund twice by changing its justification.
- **The mandate hash is the SHA-256 of the mandate's canonical JSON.** Phase 4 writes it to the audit log, and phase 17 shows it on signing.
- **A rule whose `decide` is `step_up` or `deny` must name a reason code** from the catalog, such as `SHIPMENT_DELIVERED` or `ALWAYS_NEEDS_APPROVAL`. The merchant and the agent then see why a rule held or refused an intent, not only that it did. Escalations (`ABOVE_AUTO_LIMIT`, `DAILY_LIMIT_REACHED`), failed requirements and the fallback carry their own codes.
- **Daily limits count calendar days in the mandate's time zone,** an IANA name that defaults to `Africa/Nairobi`. Only executed money actions count toward the limits.
Basis:
- tech-stack.md: "Verifiers are pure functions over record snapshots ... All I/O lives in the rail packages and the gate", "Money is an integer count of minor units", "The intent hash is SHA-256 over an RFC 8785 canonical JSON serialization", and `packages/mandate` holds the "Mandate schema, rule evaluator".
- ADR 0003: hash a canonical serialization computed in the app, store exactly what was hashed, and keep money in integer minor units.
- RFC 8785 sections 3.2.2 (no whitespace, ECMAScript string and number serialization) and 3.2.3 (sorting by UTF-16 code units): https://www.rfc-editor.org/rfc/rfc8785
- Brief §6 (normalize into an intent of rail, action, amount, currency, target and ticket; the idempotency key is the intent hash), §8 ("What you approve is what executes"), §5 item 4 (each fact names its source call and sandbox ID), and §15 (the demo hold shows "carrier: delivered").
- Spike S5 (`docs/spikes.md`) hashed a flat object with sorted keys. That was enough for one tool but isn't canonical for nested values.
Consequences:
- Phase 4's audit-log chain and phase 9's approval binding reuse `canonicalJson` and the intent hash from `@countersign/mandate`. Ledger then depends on mandate, which fits, because it records mandate versions.
- The mandate compiler (phase 17) targets this schema, including the rule `reason` field and minor-unit amounts. Spike S8's compiler output already used minor units.
- A verifier named in the schema but not built yet (the M-Pesa verifiers, `payee.allowlisted`, `ledger.velocity`) returns `unknown`. Any rule that requires it therefore denies until its phase builds it.
- Replays of an already executed intent are phase 6's job. Phase 6 answers them before deciding, by returning the original execution. Phase 3's `ledger.not_duplicate` fails on any earlier execution against the same capture.
