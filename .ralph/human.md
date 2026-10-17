# For the owner

The autopilot builds everything it can and lists here what only you can do, or what it decided on your behalf. Nothing here blocks the build unless it says so. Tick or delete lines as you deal with them.

## Open

- **Render (phase 13 onward):** paid plans for the four web services and Postgres, then a `RENDER_API_KEY` in the Dev cloud environment, so the autopilot can deploy through Render's API. Until then, deployment is built and tested as config only.
- **AG Studio licence (phase 16):** request the trial key, ask the AG Grid team on the PayPal Discord for cover to 22 Dec, then add `AG_STUDIO_LICENSE_KEY` to the Dev environment.
- **Gemini tier (phase 14):** decide free or paid for the bench and the hosted demo (brief §15). The free tier can't carry a bench run.
- **Interviews (G7):** 5 merchants and 2 developers, logged in `docs/validation.md` with consent.
- **Sandbox disputes (phase 11):** open them as the sandbox buyer before recording and judging, if the autopilot's Playwright flow can't.
- **LICENSE:** confirm Apache-2.0, and make the repo public with the licence in the About sidebar.
- **Video, comprehension check, README cold read and the Devpost submission (phase 20).**
- **Phase 4, `.env.example`:** add a `DATABASE_URL=` line (Render Postgres connection string). A deny rule stops agents reading `.env.*`, so they can't edit it.
- **Phase 4, live Postgres check:** once the Render Postgres 18 database exists (phase 13), set `DATABASE_URL` in the Dev environment and run `LIVE=1 npm test -- packages/ledger` (20 concurrent appends in a throwaway schema), then `npm run db:migrate` and `npm run ledger -- verify` on the hosted database (brief §12).

## Decided for you

- **Phase 4, audit-log format (ADR 0022):** one `audit_log` table, payloads stored as their hashed canonical text, an envelope hash, an append-only trigger (TRUNCATE allowed for the demo reset), raw proposals kept as JSON text, and `mandate.version` entries written once per version. A hash chain can't detect a cut-off tail, so `ledger verify` prints the head.

## Done
