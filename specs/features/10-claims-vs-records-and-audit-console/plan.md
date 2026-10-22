# Phase 10 plan: claims vs records, and the audit console

Roadmap item 10, brief §5 items 4 and 5. Every decision shows what the message claims beside what the records say, each fact with its source call and sandbox ID, on the phone card, in the console and in the agent's trace. The merchant gets an audit console: every decision with its trace, approvals and rail response, a chain check, and an evidence export anyone can re-check. Nothing here moves money or calls PayPal. It only reads the audit log, the ticket store and the seeded order book.

## Approach

```text
audit_log (decision, approval, execution.*, reconciliation, mandate.version)
   │  read-only, parsed for display, never re-hashed (ADR 0022)
   ▼
gate: audit reader ──▶ decision rows / decision detail (trail of the intent)
      claimsVsRecords(decision, ticket, order number, mandate) ──▶ pairs + verdicts (ADR 0034)
      evidence selection (intent | capture) ──▶ @countersign/ledger export (whole rows + verdict + head)
   │
   ├── GET /audit/decisions | /audit/decisions/:seq | /audit/intents/:id
   │       /audit/entries | /audit/verify | /audit/export      (Bearer COUNTERSIGN_APPROVER_KEY)
   ├── GET /approvals… cards gain `claims` (the same pairs)
   └── npm run audit -- show <seq> | export …        npm run ledger -- check-export <file>
   │
console (server routes, approvals sign-in cookie)
   /decisions            Graphite table: when, ticket, action, amount, decision, why, record;
                         filter by decision, search, chain status
   /decisions/[seq]      Claims vs records, How the gate decided, Why, Suggested reply,
                         What happened (approvals, executions, rail responses), audit entry, Export
   /decisions/intent/[id]  redirect to the intent's newest decision (the inbox links here)
   /audit                every audit-log entry, newest first; Check the chain
   /approvals            card's two columns from `claims`
   /inbox                each guarded call links to its decision
```

Decisions behind it: ADR 0034 (one builder in the gate, the read-only audit API on the approver key, unreadable entries listed, the evidence file, a Graphite table). Earlier ADRs still hold: 0018 (reason words with the code beside them; the canvas boards "Decisions" and "Decision detail" are the layout reference), 0022 (entry format; payloads parsed for display only), 0026 and 0033 (execution entries), 0032 (step-ups, the approver key and its cookie), 0020 (merchant-only details show emails in full).

## Modules touched

| Module | What it gains |
|---|---|
| `packages/ledger` | Reading rows by `seq`; the evidence file (`countersign-evidence-v1`) built from chosen rows, the chain verdict and head; `checkEvidence`; the `check-export` CLI command |
| `apps/gate` | Verifier words; `claimsVsRecords` and the shared "checks that decided" rule (the card's existing narrowing moves into it); the audit reader (decision rows, filters, paging, decision detail with the intent's trail, raw entry pages); evidence selection by intent or capture; the audit API (approver key); approval cards gain `claims`; the `audit` CLI |
| `apps/console` | Audit server routes and zod schemas; the shared sign-in (moved out of the approvals board); `/decisions`, `/decisions/[seq]`, `/decisions/intent/[id]`, `/audit`; the approvals card's two columns; inbox links; sidebar items Decisions and Audit log; the home page points at them |
| root | An `audit` script. README section |

`packages/mandate`, `packages/verifiers`, `packages/db`, `packages/rail-paypal`, `packages/carrier-mock` and `apps/resolve-agent` stay untouched. No migration and no new entry type.

## Order of work

1. In any order: verifier words and `claimsVsRecords` (T-001); the audit reader (T-002); the evidence file in the ledger (T-003).
2. Evidence selection by intent and capture (T-004), after T-002 and T-003.
3. The audit API (T-005), after T-001, T-002 and T-004. Approval cards gain `claims` (T-006) after T-001. The `audit` CLI (T-007) after T-005.
4. The console: routes, schemas and the shared sign-in (T-008) after T-005; then the decision list (T-009), the decision page (T-010) and the audit log page (T-011), each after T-008. The approvals card's two columns (T-012) after T-006. Inbox links (T-013) after T-010.
5. README and glossary (T-014) last.

## New dependencies

None. The console's table is Graphite markup (ADR 0034), the export is JSON, and the gate already reads the ticket store and seeded orders through `@countersign/db`. No new workspace links.

## Notes for the loop

- The loop can't reach PayPal or read `.env.*`. Tests use PGlite and env passed explicitly; never read `process.env` in tests.
- Build test logs from real decisions: propose beats 3, 4 and 5 through `propose()` (the fake sandbox and seeded fixtures, as phases 6 to 9 do), answer a step-up with `answerStepUp`, and reconcile with the webhook fixture. Hand-write entries only for the unreadable-entry and tamper cases (disable the trigger first, as the ledger's tamper test does).
- Time is injected everywhere. Never sleep.
- API tests run the real gate on `127.0.0.1` port 0, as the approval API tests do. Close servers with `closeAllConnections()` before `close()`.
- UI tests follow the inbox's and approvals' pattern: view-model and route-handler functions in `apps/console/src/`, plus the Graphite design check. Read `Graphite Design/DESIGN.md`, the Table, Badge, Card, Breadcrumb, Tabs (segmented control), Button, Input and CodeCard READMEs, and `brand-book.md` before building a screen. The canvas boards are at the URL in ADR 0018; take layout from them, but the brief and this spec win.
- Never import `@countersign/mandate` (or a module that does, such as `inbox-view`) from a client component. Build view models on the server and pass plain props down.
- Payload text is parsed for display only. Never hash, re-serialize or store what was parsed.

## Risks

- **A merchant-only page with customer text.** Ticket excerpts and payer emails show in full. Only the approver key opens the API, and phase 15's public view must mask them (ADR 0034).
- **The verdict words overreach.** "Matches" or "Contradicts" are worked out by a fixed table from the verifier's result and value, never by reading the message. The message row is always "Not used", so the page never claims to have spotted an injection.
- **Large logs.** The reader walks every decision entry on each list request, to count decisions by kind. At demo scale (hundreds of entries) that's fine, and paging bounds what's sent. Phase 14's bench runs write many more entries; if the list gets slow there, that phase adds an index table, not this one.
- **Exports prove rows, not completeness.** Said on the page and in the file (`check` sentence), with the head to compare against `ledger verify`.
