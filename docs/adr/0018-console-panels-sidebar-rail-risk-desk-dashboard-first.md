# 0018. Console panels open one at a time and never collapse to strips; the sidebar collapses to an icon rail; the Risk desk opens as a dashboard

Status: accepted
Decided-by: owner, in the design session on 16 Oct 2026 (recorded by Claude)
Question: Design pass 1 on the "Countersign screens" canvas. How do the console's side panels, the sidebar and the Risk desk behave, given that AG Studio's own editing UI isn't Graphite (spike S9), and how do decisions, reason codes and the analyst's work read on screen?
Decision:
- **Side panels never collapse to vertical strips.** A side panel is either fully open or gone. Only one is open at a time. The owner disliked AG Studio's collapsed vertical panels.
- **One control opens them.** An Ask / Edit segmented control sits in the page header (Graphite segmented control). Pressing the active segment again closes its panel, so the control can show neither segment pressed.
- **The Risk desk opens as a dashboard.** It loads in Studio's view mode with no side panel. AG Studio allows only the `filters` panel in view mode; `ai`, `edit` and `data` exist only in edit mode (`AgViewModePanelType`, `AgEditModePanelType`). So the header control maps to Studio's props like this:

  | Header control | `mode` | `panels` |
  |---|---|---|
  | Neither pressed (default) | `view` | `{ view: {} }` |
  | Ask | `edit` | `{ edit: { right: ['ai'] } }` |
  | Edit | `edit` | `{ edit: { right: ['edit', 'data'] } }` |

  Once either mode is named in `panels`, Studio leaves an unnamed mode empty (`resolvePanelPositions`), which is what keeps view mode bare. The console never writes `collapsed: true` into a panel's state, and drops any it reads back.
- **The sidebar collapses to an icon rail, not to nothing.** The rail keeps every nav item as an icon-only transparent button with an `aria-label` and a tooltip, plus the count badges. The expanded sidebar is Graphite's 240px.
- **The analyst chat reads as Graphite.**
  - Studio's AI panel takes the Graphite theme (ADR 0006).
  - Each Studio tool call shows as one row in plain words through `aiToolDisplay`: a short label, and a `pill` for counts, such as "Read widgets" with "2", or "Added a chart" with "Column chart". Noisy internal calls, such as delegating to Studio's page and widget agents, set `hidden`.
  - Errors are plain words, never raw JSON. The ADR 0016 route turns every failure into one sentence that says what happened and what to do, following the brand book ("The analyst couldn't reach Gemini. Try again in a minute."). The raw error goes to the server log only.
- **Reason codes show as words, with the code beside them.** For example, "Over your $60 auto-refund cap" followed by `ABOVE_AUTO_LIMIT` in inline code. This holds everywhere a decision is shown: the phone card, the console and the agent trace.
Basis:
- The owner's decisions in the 16 Oct 2026 design session, recorded in the session handoff: panels never collapse to strips, one side panel at a time from an Ask / Edit control, an icon-rail sidebar, the Risk desk as a dashboard with Studio's panels behind Edit, a Graphite-styled analyst with summarized steps and plain errors, and reason codes as words with the code beside them.
- Spike S9 (`docs/spikes.md`): "Studio's editing UI isn't Graphite. Theme parameters color it, but its panels, palette icons and chat keep AG's own layout. Phase 16 should open in view mode, with editing behind a toggle." Also: "Studio shows the raw JSON error, which needs a plain message."
- AG Studio 3.0.0 types in `node_modules/ag-studio/dist/types/`:
  - `api/agPanels.d.ts`: `AgViewModePanelType = 'filters'`, `AgEditModePanelType = 'filters' | 'edit' | 'data' | 'ai'`, and `AgPanelConfig { edit?, view? }` with `left` / `right` lists per mode;
  - `studio/panels/panelService.d.ts`: a config that names either mode owns the layout, and a mode it omits stays empty;
  - `api/state/agPanelState.d.ts`: per-panel state has `width` and `collapsed`;
  - `api/agStudioProperties.d.ts`: `mode` defaults to `view`, and changing it keeps the active state; `aiToolDisplay` sets each tool's row label;
  - `api/ai/agAiChat.d.ts`: `AgBaseAiToolDisplay` has `label` returning `{ text, pill? }`, an optional `detail` and `hidden`.
- Brief §8 (Graphite on every UI; "pick the option that adds the least visual weight"), §5 items 4 and 11, and §11 (focus ring, hit targets, 40px primary buttons on the phone).
- `Graphite Design/DESIGN.md`: segmented control, transparent icon buttons ("Icon-only buttons need an `aria-label` and a tooltip"), sidebar width 240px. `Graphite Design/brand-book.md`: errors say what happened and what to do.
Consequences:
- Roadmap phase 16 builds the Risk desk this way. Its acceptance checks: Studio mounts in view mode with no panel; Ask and Edit each open exactly their panels; pressing the active segment returns to the bare dashboard; no panel ever renders collapsed; a forced route failure shows one plain sentence in the chat and no JSON.
- Studio's edit mode also turns on its widget editing affordances. Opening Ask therefore makes the dashboard editable too. That's accepted: the analyst builds widgets, so the merchant should be able to adjust them. If it proves confusing in phase 16, Ask can return to view mode once the turn ends.
- Phase 16 still checks how Studio lays out two panels on one side (`['edit', 'data']`). If they don't share the side cleanly, Edit uses `{ left: ['data'], right: ['edit'] }`. That is still one control and one open state, never a strip.
- Phases 9, 10 and 16 take their layout from the canvas boards: Decisions, Decision detail, Risk desk and Phone approval (https://claude.ai/artifact/SubrKf4K5DnUNYinZ5rQ6o). The canvas is a design reference. Where it and the brief disagree, the brief wins.
- Every new UI applies the reason-code rule. A reason code never appears alone, and a sentence never appears without its code where a decision is shown.
