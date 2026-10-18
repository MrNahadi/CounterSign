# 0029. Tickets live in a Postgres `tickets` table that Resolve writes and the gate reads by the ID the agent names

Status: accepted
Decided-by: autopilot (delegated), phase 7 feature spec, 18 Oct 2026, under brief §14 v1.4. The answerer's rules escalate it, because it's a data model shared by two services. The planner session couldn't reach the answerer agent, so it applied the answerer's rules itself. Decided by brief §10 trade-off 1 (fail closed). The owner can overturn it (`.ralph/human.md`, Decided for you)
Question: In phase 6 the propose CLI hands the gate a ticket snapshot (sender and attachments) with each proposal. Over MCP the caller is the agent, which reads untrusted customer text. Where does the gate get the ticket that `ticket.from_payer` and `evidence.photo_present` check?
Decision:
- **A `tickets` table in `@countersign/db`**: the ticket ID (primary key), channel (`email` or `chat`), sender email (nullable), sender phone (nullable), subject, body, attachments (ID and content type each), the time received, and whether it's simulated. A migration adds it. Phase 8 may add columns; nothing here is hashed.
- **Written once.** A writer in `@countersign/db` inserts a ticket; writing the same ID again with different contents is refused, and with the same contents is a no-op, so reruns are safe. Nothing updates or deletes a ticket except the demo reset (phase 13).
- **Who writes it.** Resolve (phase 8) writes every incoming email or chat message. Until then the propose CLI and the stand-in agent CLI write their simulated tickets, labelled simulated. The gate itself never writes one, and no MCP tool can.
- **Who reads it.** The gate reads the ticket by the proposal's `justification.ticket_id` before deciding, outside the ledger transaction like the other live reads, and maps it to a `TicketSnapshot`. An unknown ID or a failed read leaves the ticket snapshot out, so the ticket verifiers are `unknown` and a rule that requires them denies.
- **`proposeRefund`'s `ticket` input goes away;** the gate reads the store in every path, so the CLI and MCP paths can't differ.
Basis:
- Brief §8: "Fail closed", and the agent's words never authorize money (§1: "The agent's words never authorize money; the records do."). If the agent supplied the sender, a hidden instruction could make it claim the payer's address.
- Brief §5 item 6 (Resolve takes email and chat) and §6 beat 3 (`TICKET_NOT_FROM_PAYER` needs the real sender).
- Original brief §8: `evidence.photo_present` reads the "Resolve ticket store"; §12 data model lists Postgres as the shared store.
- ADR 0023 (seed and carrier data in Postgres alongside the audit log).
Consequences:
- Resolve and the gate share the database (they already share it through Render's Postgres). Resolve needs write access to `tickets` only.
- Beat 3's demo needs its attack email in the store with buyer A as sender; the propose CLI's simulated tickets cover that until Resolve exists.
- The demo reset (phase 13) truncates `tickets` with the audit log.
