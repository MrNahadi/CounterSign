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

## T-004 (done)
- `webhook.ts`: `CUSTOMER.DISPUTE.CREATED` reads `resource.dispute_id`, re-reads with `getDispute`, appends `dispute.received` (once per event ID, checked again under the lock) and answers "Recorded." / "Already recorded."; `.UPDATED`/`.RESOLVED` stay "Event type not handled."; unreadable dispute or log is 503. Refund handling moved unchanged into `reconcileRefund`.
- New `apps/gate/src/nudge.ts`: `nudgeResolve(disputeId, { env, fetch? })` returns whether Resolve took it (2xx within `NUDGE_TIMEOUT_MS` 2000), never throws; `resolveAgentUrl(env)` defaults to `http://127.0.0.1:8788`. The webhook fires it without awaiting. `AppDeps` and `WebhookDeps` gain `fetch?: NudgeFetch`.
- Gotcha for T-005: the CLI should `await nudgeResolve` and print the "Resolve wasn't reachable" line when it answers false. A new event ID for an already-recorded dispute appends again (ADR 0035: one entry per webhook event ID); only polling dedupes per dispute.

## T-005 (done)
- New `apps/gate/src/disputes-cli.ts` (`runDisputes(args, env, { rail, fetch, nudgeFetch, now })`) and `disputes-main.ts`; root `disputes` script. `sync` lists `disputeState: REQUIRED_ACTION`, page size 50, records poll entries (rechecked under the lock), awaits the nudge; `list` (unfiltered) and `show` re-read each dispute; `require-evidence`/`adjudicate` exit 1 on a 4xx, 2 on anything else (outcome unknown). Arguments parsed with a zod tuple union.
- `readDisputeState` now also returns `firstSeqs` (dispute ID to its first `dispute.received` seq).
- Fake sandbox: `requireEvidence`/`adjudicate` answer 200 (404 for an unknown dispute, injected failures apply). accept claim, make offer and provide evidence still throw until T-008.
- `list`/`show` print PayPal's raw reason codes; there are no dispute reason words yet (T-006/T-012 will need them, `words.ts` is the place).

## T-006 (done)
- New `apps/gate/src/dispute-evidence.ts`: `buildEvidencePack(disputeId, { db, rail, carrier, now })` answers `{ ok, facts, documents, suggested }` or `{ ok: false, code: DISPUTE_UNREADABLE | NO_CAPTURE | STORE_FAILED, message }` (fixed sentences in `PACK_MESSAGES`, for T-007's tool errors). Facts are camelCase; T-007 maps them to snake_case. New `evidence-pdf.ts` (`buildEvidencePdf`, `winAnsi`, section/label constants). `words.ts` gains `DECISION_WORDS` and `disputeReasonWords`.
- Decisions come from `readDecisionRows` (q = capture ID, exact target match), so they carry no sender or ticket text. Document IDs are `doc_` + 24 hex of sha256([disputeId, kind, sha256, createdAt]); a rebuild at the same time with the same bytes is `unchanged`.
- Gotcha: a capture with no Countersign decisions has no export (`exportEvidence` is `not_found`), so that pack stores only the PDF and `facts.audit` is null. The PDF still prints the Audit log section saying so.
- Gotcha: `PayPalCapture` gains optional `createTime` (from `create_time`, only on get capture; a malformed one is dropped, never fails the read). It is the facts' capture time.
- Gotcha: the PDF test reads text by decoding content streams and the `<hex> Tj` strings (see `pdfText` in dispute-evidence.test.ts); `save({ useObjectStreams: false })` keeps that simple.
- Fulfilment is suggested only for a SHIPPED tracker whose carrier status is delivered.
