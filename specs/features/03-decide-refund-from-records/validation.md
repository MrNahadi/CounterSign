# Phase 3 validation: decide a refund from records

## Automated checks

All run from the repo root and are part of the Feedback commands.

1. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass.
2. **Verifiers:** each verifier in requirements.md has a test file with its pass, fail and unknown cases. `shipment.status` has no fail case. Every trace entry names its source call and record ID.
3. **Rule evaluation:** each of the six steps in brief §6 has at least one named test in `@countersign/mandate`.
4. **Fail closed:** a seeded randomized test generates mandates, traces and usage. It shows that every allow has a matched allow rule whose requirements all passed, with no escalation. It runs at least 1,000 combinations with a fixed seed, so failures reproduce.
5. **Hashing:** canonical JSON matches the RFC 8785 examples that fall in our JSON subset. Key order doesn't change the intent hash, and changing the amount, target or ticket does. Changing the claim or mandate version doesn't.
6. **Schema:** the fixture mandate parses, and each forbidden shape in requirements.md is rejected with the path of the bad field.
7. **Reason codes:** a test lists every code the verifiers and evaluator can emit, and fails if any lacks words, or lacks a reply hint where the table gives one.
8. **Fixture cases:** every case in `apps/gate/fixtures/cases/` returns its expected decision and reason codes. The suite includes beats 3, 4 and 5 and every reachable code.
9. **CLI:** a test runs the CLI as a child process on the beat 3 case and checks its output: 4 denials with `TICKET_NOT_FROM_PAYER` and 1 step-up with `SHIPMENT_DELIVERED`. `--json` output validates against the agent response schema, and an invalid case file exits with code 2.
10. The existing "no AI in the decision path" test still passes.
11. **Review fixes (T-011 to T-018, ADR 0020):**
    - No fixture case makes `decide` throw. The overflow case gives step-up `DAILY_LIMIT_UNKNOWN` and exit code 0.
    - `2026-02-31` is rejected in case files and in usage alike.
    - An intent with no capture record can't pass `ticket.from_payer` or `shipment.status`.
    - The intent hash ignores the order ID, and every hash comes back with its canonical JSON.
    - `NO_DAILY_LIMIT` is reached, and the suite covers 23 codes.
    - `SHIPMENT_DELIVERED` details name the tracking number.

## Manual checks for the human

1. Run `npm run decide -- apps/gate/fixtures/cases/beat-3-attack-email.json`. Check that a stranger could read each decision: the words make sense, the code sits beside them, and each trace line names a record you could find in the sandbox.
2. Run the beat 4 and beat 5 cases. Check that the amounts and the cap read correctly (`$240.00`, `$50.00`).
3. Read the reason-code words and reply hints in the output against the brand book's voice. Flag any you'd want reworded before they reach the phone card.
4. Edit a copy of a case so the sender's email changes case or gains spaces, and confirm it still passes `ticket.from_payer`. Then change one letter and confirm it's denied.
5. Gate G1 (Sun 25 Oct) needs phases 4 to 6 as well. This phase covers its first half: a refund intent gets allow, step-up or deny from the CLI.
