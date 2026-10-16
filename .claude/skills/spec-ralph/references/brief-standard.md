# Brief standard

A brief is "to standard" when every REQUIRED section scores Pass. Optional sections can be Missing without failing the audit, but note them.

Score each section Pass, Weak or Missing, and give the reason in one line.

## Required sections

| Section | Pass when | Weak signs |
|---|---|---|
| 1. Summary | Says what it is, who it's for, and what it enables, in five sentences or fewer | Describes technology instead of an outcome; no user named |
| 2. Problem | Names the current workaround and its cost | Only restates the solution ("there is no app for X") |
| 3. Users | At least one user type marked primary, with needs and prior knowledge | "Everyone", "users" with no type, or needs missing |
| 4. Goals | Every goal has a measure someone could check | Adjectives with no measure: "fast", "intuitive", "robust" |
| 5. Scope | In-scope items are numbered user outcomes; at least three out-of-scope items | Components instead of outcomes; out-of-scope empty |
| 8. Non-negotiables | Concrete constraints, or an explicit "none beyond the tech preferences" | Preferences dressed as constraints; contradicts section 9 |
| 10. Ranked trade-offs | Strict order, 4 to 7 items, no ties | Unranked list, ties, or "all equally important" |
| 12. Definition of done | Checklist items a stranger could verify | "Works well", "users are happy" |
| 14. Working agreement | Every line has one option chosen | Options left as "a / b" |

## Consistency checks

Run these across sections. Each failure makes the sections involved Weak.

- A term used in Scope or Flows that has a special meaning but isn't in the Glossary.
- A tech preference that breaks a non-negotiable (for example "Required: Electron" with "must run on a Raspberry Pi Zero").
- A definition-of-done item that isn't covered by any in-scope item.
- An out-of-scope item that a flow depends on.
- A goal with no in-scope item that serves it.

## Audit output

Show the human a table:

| Section | Score | Reason |
|---|---|---|

Then list the questions that would move each Weak or Missing section to Pass, one question per gap, most important first. Ask them one at a time.

## Rewriting a user's brief into the template

- Save the original untouched as `specs/brief.original.md` before changing anything.
- Move their content into the matching template sections. Keep their wording where it already passes.
- Content that fits no section goes under References with a note, never deleted.
- Mark any line you drafted rather than copied with `(drafted, confirm)`. The human must confirm or rewrite every such line before the brief passes.
- Never draft Goals, Scope, Ranked trade-offs or Definition of done yourself. Ask.
