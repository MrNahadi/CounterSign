# 0038. Console routes to Resolve that need the approvals sign-in check the key with the gate first, and never send it to Resolve

Status: accepted
Decided-by: answerer (inferred)
Question: T-014 (specs/features/11-dispute-evidence/tickets.md): what does "need the approvals sign-in" mean for `GET /api/disputes` and `POST /api/disputes`, which call Resolve (no auth of its own) rather than the gate? A well-formed cookie only, or the key checked with the gate too? And which sentence answers a 502 when Resolve is unreachable?
Decision: These routes run `withKey` (cookie present and well-formed), then check the key with the gate by `GET /approvals` with the bearer, using the same acceptance rule as `signInRoute` (a parsed 200, or a 503 carrying the gate's sentence, means the key is right). Only then do they validate the request and call Resolve, without the key.
Basis:
- requirements.md, "The console": "It needs the approvals sign-in like Decisions." and the routes "behave as the existing routes do for a missing sign-in, a 401 and an unreachable service." Decisions' routes send the key to the gate, so the gate checks it on every request. A cookie that's only well-formed isn't a sign-in.
- ADR 0032: "The console never reads the key from its own environment". Only the gate can tell whether a key is right.
- Brief §10 #1 (fail closed, absolute) and §8: "The public demo can't run up unbounded AI cost". `POST /api/disputes` can start a Gemini draft.
Consequences:
- Each request costs one extra gate round trip, and the Disputes page needs the gate running. The page links to approvals and decisions anyway, so it already depends on the gate.
- Don't use `/audit/verify` for the check, because it walks the whole chain.
- If the gate answers 401, the route answers 401 "Sign in again." and clears the cookie. A missing cookie gets "Sign in with the approver key." (from `withKey`). If the gate can't be reached or its answer can't be read, the route answers 502 with `APPROVAL_ROUTE_MESSAGES.unreachable`. If Resolve can't be reached or its answer can't be read, the route answers 502 with `RESOLVE_UNREACHABLE` from resolve-routes.ts.
- The approver key is never forwarded to Resolve, in a header, body or log.
- Any later console route to Resolve that needs the sign-in follows the same pattern. Put it in one helper, not a copy in each route.
