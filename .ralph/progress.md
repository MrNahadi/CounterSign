# Progress: phase 11, dispute evidence (specs/features/11-dispute-evidence)

## T-001 (done)
- `@countersign/rail-paypal`: `getDispute` now returns `reason`, `lifeCycleStage`, `sellerResponseDueDate` (null when absent) and `linkNames`; new `acceptClaim`, `makeOffer`, `provideEvidence` (multipart), `requireEvidence`, `adjudicate`, each answering PayPal's HTTP status, no request ID, never retried. `OFFER_TYPES` and input types are exported.
- Gotcha: `FetchLike`'s body is now `string | Uint8Array<ArrayBuffer>` (provide evidence sends bytes). Fakes that `JSON.parse(init.body)` must guard with `typeof init.body === "string"`.
- Gotcha: the multipart body is built by hand (`multipartBody` in client.ts) so the `input` part has `Content-Type: application/json` and no filename, as PayPal's curl example sends it. The rail fake's `provideEvidenceReply` checks the parts; `SeenRequest` has `form` and `bytes`.
- Gotcha: document names allow plain spaces only (PayPal's pattern allows `\s`, which would let a line break into the part headers). Documents must be `application/pdf`, 1 byte to 1 MiB, at most 5.
- Gate fake sandbox: `disputeDetails` takes a `DisputeDetailSeed` (new fields optional, defaulted on read). The five new methods throw "isn't in the fake sandbox" until T-008 gives them behaviour.
- `get_dispute` (MCP read) passes the richer record through; mcp.test.ts expects the new fields.

## T-002 (done)
- `ENTRY_TYPES` gains `dispute.received`. New `apps/gate/src/dispute-log.ts`: `disputeReceivedEntry` (webhook or poll, from a re-read `PayPalDisputeDetail`), `DisputeReceivedPayloadSchema`, `readDisputeState` (returns `{ known, state: { disputes, events } }`, unknown on any unreadable entry or ref mismatch).
- Gotcha: the audit reader (`audit-reader.ts`) does not summarise `dispute.received` yet; that is T-012.

## T-003 (done)
- `@countersign/db`: tables `evidence_documents` (write-once trigger, TRUNCATE allowed) and `dispute_drafts` (`id` PK, `dispute_id` unique, `seq` for order), one migration `0005_absent_screwball.sql`. New `evidence.ts`: `writeEvidenceDocument` (computes `size` and `sha256`; same contents is `unchanged`, other contents throws), `readEvidenceDocument`, `listEvidenceDocuments(disputeId)`, `sha256Hex`.
- Gotcha: `dispute_drafts` has no helpers yet; T-009 adds them. `dispute_id` is unique, so a "Draft again" on a failed draft must replace or update that row, not insert a second.
