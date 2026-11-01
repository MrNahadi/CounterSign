# 0045. Graphite at a comfortable density on every UI, with the owner's updated DESIGN.md as the authority

Status: accepted
Decided-by: owner, 31 Oct 2026 (recorded by the autopilot planner)
Question: The owner asked: "I like the graphite design more, could we use it moving forward. You can do an overhaul of the front end design for what has already been done, basically revamp it to use the graphite design system." They then committed an updated `Graphite Design/DESIGN.md` and `graphite-tokens.css` (commit `ddd1d1f`, with `ab98292` and `5be1c5f` registering the code-sm line height for Tailwind). What does every existing UI change to, and what happens where older documents disagree?
Decision:
- **Graphite runs at a comfortable density from now on.** The values are the owner's `DESIGN.md` and `graphite-tokens.css`:
  - UI text 14px (`body-sm`), body 16px (`body-base`), captions one pixel up (13, 12, 11 and 10px);
  - buttons 24, 28, 32, 36 and 44px (`--control-xs` to `--control-xl`), with 32px (medium) the default button and 36px the default input;
  - table rows 56px (`--table-row-height`) with sentence-case 44px headers (`--table-header-height`);
  - cards with 24px padding (`--card-padding`) and 24px grid gaps (`--grid-gap`), on `--radius-3xl`;
  - page sections 80px apart (`--section-gap`), 56px below 900px;
  - a shell whose main container is inset 8px, padded 48px top, 56px sides and 96px bottom (32, 16 and 64px below 900px), with content centered at most 1120px wide (`--content-max`);
  - a 260px sidebar (`--sidebar-width`) with 36px nav items (`--nav-item-height`).
- **Every existing UI is restyled to it**: the console (every route, the shell, nav, theme control, shared primitives, the approvals page and the customer chat), the storefront, and the AG Studio theme in `packages/graphite/src/ag-theme.ts`. Behaviour, routes and the meaning of copy don't change. Phase 13a builds it (`specs/features/13a-graphite-comfortable/`).
- **`DESIGN.md` is the authority inside `Graphite Design/`.** Where `brand-book.md`, `components/*/README.md`, `components/bundle.css` or `tokens.json` disagree with it, they're brought in line with it, and `DESIGN.md` wins. This replaces `specs/tech-stack.md`'s old note "Don't edit it from app work": app work still never edits `DESIGN.md` or `graphite-tokens.css`, which are the owner's, but it may align the other files with them.
- **This overrides the brief's glossary wording without editing the brief.** Brief §7 describes Graphite as "monochrome first with one blue accent, hairline edges and small type". "Small type" no longer describes the system the owner chose: UI text is now 14px and body text 16px. The brief stays unedited (brief §14). Where its glossary and this ADR disagree on type size or density, this ADR and `DESIGN.md` win. §8's Graphite non-negotiable is unchanged and still holds in full: semantic tokens only, Lucide icons, no emojis, light by default and dark working.
- **Brief §11's accessibility numbers are still met, as floors.** §11 asks for "hit targets of 24px minimum, and 40px buttons for primary actions on the phone approvals page". The new `DESIGN.md` raises both: the minimum hit target is 28px (the small button), and touch layouts use the 44px button for primary actions. Both exceed §11's numbers, so the approvals page's Approve, Deny and Sign in buttons become 44px and every control is at least 28px.
- **This supersedes ADR 0018's sidebar width.** ADR 0018 named "Graphite's 240px" sidebar. The sidebar is now 260px. The rest of ADR 0018 (panels never collapse to strips, one Ask / Edit control, the Risk desk opening as a dashboard, reason codes as words with the code beside them) is unchanged.
Basis:
- The owner's request of 31 Oct 2026, quoted above, and their commits `ddd1d1f`, `ab98292` and `5be1c5f`.
- `Graphite Design/DESIGN.md`: Principles ("Roomy and quiet"), Spacing and layout (the table of values and "Signs a screen is too dense"), the component specs, the Do and don't table, and Appendix B ("Density: Graphite runs one step roomier than the source").
- Brief §7 (Graphite glossary entry), §8 (Graphite on every UI), §11 (accessibility), §14 (the brief is never edited by the agent).
Consequences:
- Phase 13a restyles every screen, adds shared Graphite class recipes and primitives to the console, and checks every route by screenshot in light and dark at desktop and phone widths.
- New UI in later phases (13's start page, 15, 16, 17, 18) uses the comfortable values and the console's shared primitives. Whichever of phases 13 and 13a merges second restyles phase 13's new pages with those primitives.
- The approvals and chat tests that pinned 40px buttons and a 24px minimum change to 44px and 28px.
- Screens show fewer rows at once. That's intended: `DESIGN.md` says "Never pack a screen to fit more in."
