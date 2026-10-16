# Project brief: <project name>

<!--
How to use this template
- Fill every section marked REQUIRED. The others are optional but help.
- Write in plain sentences. Specific beats complete: "loads a 30-day voyage log in under 2 seconds" beats "fast".
- If you don't know something yet, put it under Open questions instead of leaving a section vague.
- These comments are guidance. Delete them or leave them; the agent ignores them.
-->

| Field | Value |
|---|---|
| Version | 1.0 |
| Date | YYYY-MM-DD |
| Owner | <your name> |
| Project type | greenfield / brownfield (existing code at <repo or path>) |

## 1. Summary (REQUIRED)

<!-- Three to five sentences. What it is, who it's for, and what it lets them do that they can't do well today. -->

## 2. Problem and why now (REQUIRED)

<!-- The pain, in the user's terms. What people do today instead and what that costs them. Why build this now. -->

## 3. Users (REQUIRED)

<!-- Each user type and what they need. Mark one as primary. Say what they already know: skill level, tools, jargon. -->

| User | Primary? | What they need | What they already know |
|---|---|---|---|
| | yes | | |

## 4. Goals and success measures (REQUIRED)

<!-- Each goal gets a measure you could check. "Users trust the numbers" is a goal. "Results match the official calculator to 3 decimal places on the 10 reference cases" is its measure. -->

| Goal | How we'll know |
|---|---|
| | |

## 5. Scope (REQUIRED)

### In scope

<!-- Features as user outcomes, not components. "A chief engineer can export a monthly report as PDF", not "PDF module". Number them; the roadmap will refer to the numbers. -->

1.

### Out of scope

<!-- Things someone might reasonably expect that you are deliberately not doing, at least for now. This list stops the agent from adding extras. At least three items. -->

-

## 6. Key user flows

<!-- The two to five journeys that matter most, as numbered steps. -->

### Flow: <name>

1.

## 7. Glossary

<!-- Domain words and exactly what you mean by them. Seeds CONTEXT.md. Include words that mean something different in your field than in everyday use. -->

| Term | Meaning in this project |
|---|---|
| | |

## 8. Non-negotiables (REQUIRED)

<!-- Hard constraints. Breaking one means the project failed. Platforms, languages, licence, regulations or standards to comply with, hardware, offline use, data residency, budget, accessibility level. -->

-

## 9. Tech preferences

<!-- Separate required from preferred. "No opinion" is a useful answer: it tells the agent it may choose. -->

| Area | Required | Preferred | Avoid | No opinion |
|---|---|---|---|---|
| Language | | | | |
| Framework | | | | |
| Storage | | | | |
| Testing | | | | |
| Hosting / distribution | | | | |

## 10. Ranked trade-offs (REQUIRED)

<!-- The most useful section for the agent. When it hits a judgment call you didn't cover, it decides by this ranking. Strict order, no ties. Edit the list to fit; keep 4 to 7 items. -->

1. Correctness
2. Simplicity of the code
3. User experience
4. Performance
5. Speed of delivery

<!-- Optional: one line on how far apart they are, e.g. "Correctness is far above everything else; the rest are close." -->

## 11. Quality bar

- Tests:
- Performance:
- Accessibility:
- Docs:
- Supported environments:

## 12. Definition of done for the first release (REQUIRED)

<!-- A checklist someone could tick without asking you anything. -->

- [ ]
- [ ]

## 13. Known phases

<!-- Optional. If you already see a sensible build order, list it. The roadmap starts from this. -->

1.

## 14. Working agreement with the agent (REQUIRED)

<!-- How much the agent may do on its own. Keep one option per line, or write your own. -->

- Feature spec gate: I approve tickets before the loop runs / automatic
- Answerer may decide: technical questions only / technical questions and strong inferences from this brief
- Loop budget per feature: <N> iterations
- Merging to main: always me / agent may merge after I sign off

## 15. Open questions

<!-- Things you know you haven't decided. The agent will raise these before they block work. -->

-

## 16. References

<!-- Links, existing docs, datasets, standards, screenshots, similar products, earlier attempts. Say what each is for. -->

-
