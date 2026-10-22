# Phase 11 validation: dispute evidence

## Automated checks

All run from the repo root and are part of the Feedback commands.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Rail client:** against the fake PayPal, get dispute parses reason, life-cycle stage, due date, captures and link names; accept claim, make offer, require evidence and adjudicate send the bodies requirements.md lists; provide evidence sends `multipart/form-data` with an `input` JSON part and `file1…` PDF parts with their names; none sends `PayPal-Request-Id` or retries after a 5xx; bad inputs (a document over 1 MB, more than 5, a bad name, notes over 2000 characters) are refused before sending.
3. **Intake:** a signed `CUSTOMER.DISPUTE.CREATED` fixture appends one `dispute.received` from the re-read dispute (not the body); a redelivery writes nothing; a bad signature, an unreadable dispute and a broken log answer as specified; `.UPDATED` is ignored; refund webhooks still reconcile. `disputes sync` logs only unrecorded disputes, says when PayPal had more pages, and a second run logs nothing. The nudge is sent once per new entry, and a failing or slow Resolve (fake fetch past 2 s) changes no answer or exit code.
4. **Facts and documents:** for a dispute on a delivered, tracked seed capture with one earlier step-up decision and one refund, the facts hold the dispute, capture, order number, tracker, simulated status and scans, refund and decision, and never the payer email or ticket text; the stored export passes `checkEvidence`; the PDF reads back with the sections, the "simulated" and "illustrative" lines, and the export's SHA-256; the suggested items follow the fixed table; an unreadable tracker read is listed as not available; updating or deleting an `evidence_documents` row is rejected.
5. **MCP:** `prepare_dispute_evidence` is listed as an extension, answers the masked facts and documents, and its errors are fixed sentences; `provide_dispute_evidence` with the PDF steps up under the shipped mandate; a missing, non-PDF or other-dispute document is `INVALID_PROPOSAL`; changing one character of a note or swapping the document changes the intent hash; refund and invoice intent hashes in the existing tests are unchanged.
6. **Executors:** approving the step-up sends the multipart call once and records `dispute: { id, status }`; approving again, or re-proposing the same intent, sends nothing; a document whose bytes changed records `failed` `DOCUMENT_CHANGED` and sends nothing; a 4xx is `failed`, a 5xx `unknown`; accept claim and make offer execute when approved; executed dispute actions count in today's usage.
7. **Drafter:** with a fake model, a draft calls `prepare_dispute_evidence`, then one model call, then proposes with code-set types, tracking numbers, refund IDs and the PDF and the model's notes, and stores `proposed` with `pending_approval`; a blocked response, a non-STOP finish, invalid JSON, no API key and the daily cap each fall back to (or stop as) requirements.md says; a second `POST /disputes` for the same dispute queues nothing; the system instruction is byte-stable (a test pins it).
8. **Cards and reader:** a provide-evidence card carries `params` with items and documents; the document route answers the bytes to the approver key and 401 to anyone else; entry summaries and trail lines read as requirements.md says.
9. **Console:** view models turn recorded answers into the card's "What you're approving" section and the Disputes table (status words, drafted-by words, links); routes forward the sign-in, refuse bad input, never expose a key, and answer 401 and 502 with their fixed sentences; the design check passes on every new file.
10. **No AI in the decision path:** the no-AI test still passes, and the gate imports no AI SDK.

## Live checks (`LIVE=1`, not in the Feedback commands)

1. `LIVE=1 npm test -- packages/rail-paypal`: lists the merchant's disputes and, when one exists, reads it.
2. With `PAYPAL_LIVE_DISPUTE_ID` set to a sandbox dispute in `UNDER_REVIEW` or waiting for the seller: `LIVE=1 npm test -- apps/gate/test/disputes-live.test.ts` moves it to `WAITING_FOR_SELLER_RESPONSE` with require evidence, builds the pack, proposes `provide_dispute_evidence`, approves the step-up, checks PayPal took the PDF, then adjudicates `SELLER_FAVOR` (spike S3). It skips with a reason when the variable isn't set.
3. With `GEMINI_API_KEY` set: `LIVE=1 npm test -- apps/resolve-agent/test/dispute-draft-live.test.ts` runs one real draft call on recorded facts and checks the notes validate and `modelVersion` is recorded.

## Manual checks for the human

1. Open a sandbox dispute as a seed buyer on a delivered seeded order (`.ralph/human.md`), then run `npm run disputes -- sync` with the gate and resolve-agent running, and check the draft appears on `/disputes` and the card on `/approvals`.
2. On the phone card, read the notes as the merchant: do they say only what the records say, and is the simulated carrier labelled? Download the PDF and check it opens and reads cleanly.
3. Approve it, then check the dispute in the sandbox dashboard shows the evidence and the PDF, and that the decision page's trail shows the submission.
4. Once phase 13's public URL exists, register `CUSTOMER.DISPUTE.CREATED` on the sandbox webhook and check a new dispute is recorded and drafted without `sync`.
5. Check `/disputes` and the card's evidence section in light and dark, at desktop and phone width, and read the copy against the brand book.
