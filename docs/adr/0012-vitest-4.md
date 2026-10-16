# 0012. Vitest 4.1.12, not Vitest 5

Status: accepted
Decided-by: Claude in Phase 1, owner present, from the answerer's note after Q11
Question: Which Vitest major should the tests use, given that tests are the loop's only feedback?
Decision: Pin `vitest` 4.1.12 in every workspace and configure workspaces through `test.projects` in one root config.
Basis: Vitest 5.0 shipped on 3 Sep 2026, after the loop model's training cutoff (June 2026). It changes defaults the loop would otherwise misread: mocks are cleared between tests, un-awaited assertions fail, and config is no longer read from parent folders. Vitest 4.1.12 supports Node `^20 || ^22 || >=24` (npm registry), so it runs on Node 26 (ADR 0008). This follows the same reasoning that kept MCP SDK v2, TypeScript 7 and Drizzle 1.0 out (ADRs 0001, 0004, 0003).
Consequences: Upgrade to Vitest 5 only after submission. Test helpers written now must not rely on Vitest 5-only APIs.
