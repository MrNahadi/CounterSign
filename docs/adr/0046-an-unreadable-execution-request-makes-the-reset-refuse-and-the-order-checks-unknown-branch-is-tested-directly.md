# 0046. An unreadable execution request makes the reset refuse 409 before the order check; the order check's "unknown history replaces all 30" branch stays and is tested directly

Status: accepted
Decided-by: answerer (inferred)
Question: T-007 (phase 13, `specs/features/13-hosted-judge-path/tickets.md`). Acceptance says "an unreadable request replaces all 30" and also that an unreadable result "is refused 409 before any PayPal call". The busy check runs first (requirements "Order of work" step 1, design item 9 step 4). It uses `countUnansweredRequests`, which reads every `execution.requested` with the same schema as `requestedCaptureIds` and answers `known: false` for any unreadable request or result, so the reset refuses 409 `executing`. Through `resetDemo(deps)`, "an unreadable request replaces all 30" can never happen. How should the builder implement and test it?
Decision:
1. The order of work doesn't change. Through `resetDemo(deps)`, an unreadable `execution.requested` is refused with 409 `executing` before any PayPal call, with no reseed and nothing changed. This is what the seam test asserts.
2. The order check keeps its defensive branch: when `requestedCaptureIds` is unknown, every capture counts as touched. That logic moves into one exported function in `demo-reset.ts`, which `resetDemo` calls. It takes the `seed_orders` rows, the `requestedCaptureIds` read and an injected `getCapture`, and returns the kept and replaced orders. A unit test calls it directly: with `known: false` and 30 good rows, all 30 are replaced and `getCapture` is never called. Together, these two tests meet validation check 4's "an unreadable execution request replaces all 30" and design.md's coverage line ("unreadable history").
3. The builder doesn't add a test-only hook between the busy check and the order check (option a). It also doesn't move the order check ahead of the busy check (option c).
4. T-008's in-lock check works the same way. The busy check runs again inside the lock before `seededCaptureTouched`, so an unreadable request written during the replacements gives 409 `executing`, not `changed`. The seam test asserts that. `seededCaptureTouched`'s unknown branch is covered directly if it needs coverage.
Basis:
- requirements.md, "The demo reset (gate)": 409 `executing` covers "an `execution.requested` from the last 10 minutes with no `execution.result`, or one that can't be read". "Order of work": "(1) the checks above that need no lock, before any write: ... then the busy check ...; (2) the order check". "The order check": "an unreadable request names every capture".
- design.md item 8: an unreadable entry of either type makes `countUnansweredRequests` unknown, and "the reset then refuses, failing closed". Item 9 step 5: "the capture is read only when the earlier rules keep it". Verification Plan: every order-check branch, "unreadable history" included, has a test.
- T-005 (done): "an unreadable request or result makes the answer unknown". This is in `apps/gate/src/execution-log.ts` (`countUnansweredRequests` and `requestedCaptureIds` both parse with `ExecutionRequestedPayloadSchema`).
- ADR 0044 decision 1 ("an unreadable request replaces all 30") states the order check's rule, and the rule stays in the code. Decision 2 puts the busy check before the order check.
- Brief §10 trade-off 1 (fail-closed money safety) and §8 ("Fail closed"). Refusing is the stricter of the two outcomes: no PayPal call, no new orders, and the log, including the unreadable entry, isn't cleared.
- Option (c) would let `getCapture` (a PayPal call) run before the busy check. That breaks the stated order of work and acceptance's "refused 409 before any PayPal call".
Consequences:
- While the log holds an unreadable execution entry, the demo can't be reset until the owner repairs the log. This is intended: trade-off 1 outranks trade-off 3.
- `demo-reset.ts` exports one more function, the order check. Its signature is the builder's choice.
- The builder notes this ADR in T-007's Notes when it ticks the acceptance item. Validation round 1 reads check 4's "unreadable execution request replaces all 30" through this ADR.
