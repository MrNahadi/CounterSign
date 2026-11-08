# Decisions

One line each, newest last: the date, what was decided, why, and who decided (owner or agent). Agents add a line whenever they choose between options the brief doesn't settle, picking the option that fails closed. The owner can overrule any agent line. Older decisions are in `docs/adr/` (0001 to 0046) and `OWNER.md` under "Decided for you".

- 2026-11-08 (owner): Switch to a lean loop. `PLAN.md`, `PROMPT.md` and `loop.sh` replace the spec, review and ticket process, because planning cost more than twice the building and the deadline is 11 Nov.
- 2026-11-08 (owner): Cut the M-Pesa rail (old phase 18) and bench families A8–A10 with it, reported as not run. Brief §5's cut line already allows a labeled fallback for it.
- 2026-11-08 (owner): Trim old phase 19 to a smoke test. The uptime monitor and CI secret scan are dropped unless time remains.
- 2026-11-08 (owner): The Risk desk ships three widgets plus the spike alert and analyst; the mandate compiler (section E) is built only if time remains.
- 2026-11-08 (owner): Hosting stays on Render for submission; Cloudflare is revisited after it.
