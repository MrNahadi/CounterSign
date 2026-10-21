# Phase 9 plan: phone step-up approvals

Roadmap item 9, brief §5 item 3. When the gate holds an intent for the merchant, it becomes an itemized card on the merchant's phone, opened by a QR code from the console. One tap approves or denies exactly that intent. Approvals are bound to the intent hash, single-use, and expire as a deny after 15 minutes. An approved refund executes once, as phase 6's allowed refunds do, and this phase adds the invoice-send call. Approved dispute actions, payouts and order captures can't run yet, and their card says so.

## Approach

```text
agent ─ /mcp ─▶ gate: decide ─▶ step_up ─▶ decision entry (the step-up, ADR 0032)
                                                   │
console /approvals (phone or desktop)              ▼
  approver login (cookie) ─ server routes ─▶ gate approval API (bearer COUNTERSIGN_APPROVER_KEY)
  card: action, amount, order,                GET  /approvals        open cards + recent answers
        customer, claim, reasons,             GET  /approvals/:id    one card
        checks, photo, expiry                 POST /approvals/:id    { answer, intent_hash }
  Approve | Deny (40px)                              │
  QR code "Open on your phone"                       ▼
                                   one audit-log transaction under the ledger's lock:
                                   checks (hash, answered, expired, requested, executable,
                                   duplicate) ─▶ `approval` entry ─▶ `execution.requested`
                                                   │ (approve only, after commit)
                                                   ▼
                                   executor (ADR 0033): refund (phase 6) or invoice send (new)
                                                   ▼
                                   `execution.result`; webhook reconciles refunds as before

resolve-agent inbox reads `approval` and execution entries: "Approved by you, refund …" / "Denied" / "Expired"
```

Decisions behind it: ADR 0032 (what a step-up is, its states, the approver key and login, the `approval` entry, the rejection codes, executing the stored intent) and ADR 0033 (one executor per action, the invoice send, and the execution entries' new shapes). Earlier ADRs still hold: 0022 (entry format), 0026 (requests, results, replays), 0027 (intent targets and hashes), 0028 (the MCP surface and principal keys), 0018 (reason words with the code beside them), 0006 (Graphite through Tailwind).

## Modules touched

| Module | What it gains |
|---|---|
| `packages/ledger` | The `approval` entry type (known to appends and `ledger verify`) |
| `packages/rail-paypal` | `sendInvoice` (no request ID, never retried) and `createDraftInvoice` (a non-decision POST with a readable request ID, for live checks and demos) |
| `apps/gate` | Approval entries and the step-up reader; execution entries for approved and non-refund intents; executors (refund, invoice send) shared by `propose` and approvals; `answerStepUp`; the approver key; the approval API; card views; the `approvals` CLI |
| `apps/resolve-agent` | Its execution read gains held calls: approved (with the refund or invoice result), denied, expired |
| `apps/console` | Approval server routes and the approver login cookie; `/approvals` (phone first, works on desktop); the "Open on your phone" QR code; a web app manifest; the Approvals nav item; the inbox's held-call rows |
| root | An `approvals` script. README section |

`packages/mandate`, `packages/verifiers`, `packages/db` and `packages/carrier-mock` stay untouched. No migration: approvals live in the audit log.

## Order of work

1. In any order: the `approval` entry type, its payloads and the step-up reader (T-001); the execution entries' new shapes (T-002); the invoice calls in the rail client (T-003).
2. Executors, and invoice send made executable (T-004), after T-002 and T-003.
3. `answerStepUp` (T-005), after T-001 and T-004.
4. The approver key, card views and approval API (T-006), after T-005. The CLI (T-007) after T-006. End-to-end through MCP (T-008) after T-006.
5. The console: routes and login (T-009) after T-006, then the page (T-010), then the QR code and manifest (T-011).
6. Resolve's held-call rows (T-012) after T-001 and T-002. Live checks (T-013) after T-005. README and glossary (T-014) last.

## New dependencies

- `uqr` 0.1.3 in `@countersign/console`, installed by the planner on 21 Oct 2026 with `--save-exact`. Published 3 Apr 2026, MIT, no dependencies, typed ESM. It turns the approvals URL into a QR module matrix; the console draws the SVG itself with Graphite token classes, so no colour values enter app code. (`qrcode` 1.5.4 was passed over: it pulls in `yargs` and `pngjs` and renders its own hex colours.)

No new workspace links: the gate already reads the ticket store and seed orders through `@countersign/db`, and the console already depends on `@countersign/mandate` for reason words.

## Notes for the loop

- The loop can't reach PayPal or read `.env.*`. Tests use PGlite, the gate's fake sandbox (extend it with invoice send) and env passed explicitly. Never read `process.env` in tests.
- Time is injected everywhere. Expiry tests move the clock past `expires_at`; never sleep.
- Approval API tests run the real gate on `127.0.0.1` port 0, as the MCP tests do. Close servers with `closeAllConnections()` before `close()`.
- Step-ups for tests come from real decisions: propose beat 5 ($240 damaged, above the $50 cap) through `propose()` or `/mcp`, and an invoice send against a fixture invoice. Don't hand-write decision entries except for the "unreadable entry" cases.
- UI tests follow the inbox's pattern: test the view-model and route-handler functions in `apps/console/src/`, plus the Graphite design check. Read `Graphite Design/DESIGN.md`, the Card, Button, Badge, Input and Dialog READMEs, and `brand-book.md` before building a screen.
- Never import `@countersign/mandate` (or a module that does) from a client component: it pulls in `node:crypto`. Build card views on the server and pass plain props down.

## Risks

- **A key in a cookie on a public demo.** Anyone holding the approver key can approve sandbox refunds. It's a sandbox-only judge credential (brief §8); the cookie is `HttpOnly` and `SameSite=Strict`, and the gate never accepts a principal key in its place.
- **Invoice sends have no idempotency key.** The audit log's one-request-per-intent rule is the guarantee (ADR 0033); an `unknown` send isn't retried.
- **No seeded orders or public URL in the cloud yet.** A live approved refund waits for the seed buyers; the phone path over the internet waits for phase 13. The QR code works on a LAN or the hosted URL; a phone can't reach `127.0.0.1`.
- **Expiry while the phone is locked.** The card counts down and turns to "Expired" on the next poll; an answer after expiry is rejected `EXPIRED` and logged, never executed.
