# Phase 11 plan: dispute evidence

Roadmap item 11, brief §5 item 13, §6 beat 7. When PayPal tells the gate a dispute was opened, Resolve's agent drafts an evidence pack from the audit log and tracking, the merchant approves exactly that pack on the phone, and the gate submits it with `provide-evidence`. The pack is a PDF built from records, with phase 10's capture-scoped evidence export beside it. This phase also builds spike S3's checks (require-evidence, provide-evidence with a PDF, adjudicate) as sandbox operator commands, and gives the other two dispute actions (accept claim, make offer) their executors, so every approved dispute action can run.

## Approach

```text
PayPal ── CUSTOMER.DISPUTE.CREATED ──▶ gate /webhooks/paypal (signature, re-read dispute)
npm run disputes -- sync (polling, until phase 13's public URL) ─┘
        │  append dispute.received (once per event / per dispute)
        └─ nudge ─▶ resolve-agent POST /disputes { dispute_id }   (best effort, 2 s)
                         │ one dispute draft per dispute (dispute_drafts)
                         ▼
          MCP prepare_dispute_evidence (extension, not guarded)
             gate: facts from dispute, capture, order, trackers, carrier mock (simulated),
                   refunds, decisions on the capture, capture-scoped export
                   ──▶ evidence_documents: export JSON + evidence PDF (pdf-lib), write-once
             ◀── masked facts, documents {id, name, size, sha256}, suggested items
                         │ one Gemini structured call: notes only (template if unavailable)
                         ▼
          MCP provide_dispute_evidence { dispute_id, evidence[], document_ids[] }
             gate: hash covers evidence + documents {id, name, sha256}
             mandate rule dispute-and-invoice-actions ──▶ STEP_UP
                         ▼
          phone card: dispute, items, notes, documents (download)  ──approve──▶
             executor: multipart provide-evidence (input + PDF), sent once, no request ID
             execution.result { dispute: { id, status (re-read) } }
```

Decisions behind it: ADR 0035 (intake, the nudge, write-once evidence documents, `prepare_dispute_evidence`, document hashes in the intent, the drafter writes only notes with a template fallback, the three dispute executors, sandbox helpers). Earlier ADRs still hold: 0025 (webhook signature over the raw body; re-read, never trust the body), 0027 (dispute targets and hashed parameters), 0028 (the MCP surface; extensions named as such), 0030 and 0031 (Resolve owns agent runs; one at a time; the daily run cap), 0032 and 0033 (approvals execute the stored intent; one executor per action; sent at most once without a request ID), 0034 (the evidence export and the approver key's audit API), 0013 to 0017 (Gemini call shape and fail-closed response checks).

## Modules touched

| Module | What it gains |
|---|---|
| `packages/rail-paypal` | Dispute detail with reason, life-cycle stage, seller response due date and links; accept claim, make offer, provide evidence (multipart), and the sandbox-only require evidence and adjudicate |
| `packages/ledger` | The `dispute.received` entry type |
| `packages/db` | The write-once `evidence_documents` table; the `dispute_drafts` table for Resolve; one migration each |
| `apps/gate` | The dispute webhook and the nudge; the `disputes` CLI (`sync`, `list`, `show`, `require-evidence`, `adjudicate`); evidence facts and the PDF; `prepare_dispute_evidence`; `provide_dispute_evidence` with documents and refund IDs; executors for accept claim, make offer and provide evidence; approval cards with the parameters that execute (the evidence pack, notes, offers); document download on the approval API; audit-reader summaries and trail lines for the new entry and results |
| `apps/resolve-agent` | `POST /disputes`, `GET /disputes`; the dispute drafter (one structured Gemini call or the template); `npm run resolve -- dispute <id>` |
| `apps/console` | The approval card's evidence pack and document download; a Disputes page listing drafts; sidebar item |
| root | A `disputes` script. README section |

`packages/mandate` and `packages/verifiers` stay untouched: the shipped mandate already steps every dispute action up.

## Order of work

1. In any order: the rail client's dispute calls (T-001); the `dispute.received` entry (T-002); the two tables (T-003).
2. The webhook and the nudge (T-004) after T-001 and T-002; the `disputes` CLI (T-005) after T-004.
3. Evidence facts and documents (T-006) after T-001 and T-003; `prepare_dispute_evidence` and the documents in `provide_dispute_evidence` (T-007) after T-006.
4. The dispute executors (T-008) after T-001 and T-007.
5. Resolve's dispute intake (T-009) after T-003; the drafter (T-010) after T-007 and T-009.
6. Approval cards with parameters and document download (T-011) after T-007 and T-008; audit-reader lines (T-012) after T-002 and T-008.
7. Console: the card's evidence pack (T-013) after T-011; the Disputes page (T-014) after T-009.
8. Demo files, live checks and README (T-015) last.

## New dependencies

| Package | Version | Workspace | Why |
|---|---|---|---|
| pdf-lib | 1.17.1 (published 6 Nov 2021, MIT, no native code) | `apps/gate` | Builds the evidence PDF; PayPal takes only image and PDF documents |

Installed by the planner. Multipart bodies use Node 26's built-in `FormData` and `Blob`.

## Notes for the loop

- The loop can't reach PayPal, Gemini or read `.env.*`. Tests use PGlite, the fake sandbox (`apps/gate/test/fake-sandbox.ts`, `packages/rail-paypal/test/fake-paypal.ts`), a fake model, and env passed explicitly.
- Dispute fixtures: build them from the Disputes v1 shapes in ADR 0035's sources and keep them in `packages/rail-paypal/test/fixtures/`. A sandbox dispute's ID looks like `PP-D-12345`. A seeded capture can be disputed in the fake sandbox; use beat 3's delivered KIK-1042 or beat 4's stalled order so the facts have a tracker and scans.
- The PDF test reads the produced bytes back with `pdf-lib` and checks the text and page count, never a byte-for-byte snapshot. Set the PDF's creation and modification dates from the injected clock.
- Time is injected everywhere. Never sleep. The nudge's timeout uses an injected fetch.
- Never import `@google/genai` in the gate. The drafter is in resolve-agent and uses its existing model wrapper and fail-closed checks.
- UI tickets: read `Graphite Design/DESIGN.md`, the Card, Badge, Table, Button, Breadcrumb and Code READMEs and `brand-book.md` first. Build view models in `apps/console/src/` and test them there.

## Risks

- **The model writes something false in a note.** Types, tracking numbers, refund IDs and documents are set by code; the model writes only notes from the masked facts, and the merchant reads every note on the card before approving. The template fallback keeps the flow working without the model.
- **Sandbox dispute behaviour.** Creating a dispute needs a sandbox buyer login, so the live path waits for the owner. If S3 fails live, the cut line applies: the pack plus a recorded sandbox submission, labelled.
- **Multipart details.** The part names come from PayPal's guide; the fake sandbox checks them, and the live check under `LIVE=1` confirms them.
- **PDF size and fonts.** Standard Helvetica can't print every character; text outside WinAnsi is replaced before drawing, and the PDF stays under 1 MB.
