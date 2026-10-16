# 0017. The Gemini model comes from `GEMINI_MODEL`, defaulting to `gemini-3.5-flash-lite`

Status: accepted
Decided-by: owner, in session on 16 Oct 2026 (recorded by Claude)
Question: Which Gemini model should product AI use while we build on the free tier, and how does the owner switch to a larger model later?
Decision:
- Every product AI role (Resolve agent, mandate compiler, Risk desk analyst) reads its model ID from `GEMINI_MODEL`. The default is `gemini-3.5-flash-lite`. In the owner's words, "most of the time the flash lite models typically work better", and a higher model may follow "in case I pay".
- `GEMINI_FALLBACK_MODEL` is optional and defaults to `gemini-3.1-flash-lite`. It's used only between ticket runs, under ADR 0015's rules. Empty means no fallback.
- Both are validated at startup by the zod env schema: an exact `gemini-…` ID, never a `-latest` alias.
- Thinking levels stay as ADR 0013 sets them: `MEDIUM` for the agent, `HIGH` for the compiler, `LOW` for the Risk desk. Spike S8 showed `gemini-3.5-flash-lite` accepts `MEDIUM` and `HIGH`.
Basis:
- The owner's instruction on 16 Oct 2026: "use the Gemini flash lite model", and "in the env file, give me an option to select the kind of model I want".
- Spike S8 (`docs/spikes.md`): both `gemini-3.8-flash` and `gemini-3.5-flash-lite` ran the agent loop and the compiler. Flash hit HTTP 503 "high demand" on the free tier until the SDK retried.
- ADR 0013 G6: free-tier Flash is reported at about 20 requests a day, Flash-Lite at about 500.
Consequences:
- Supersedes ADR 0013's choice of `gemini-3.8-flash` for every role, and ADR 0015's fallback ID (`gemini-3.6-flash`). The rest of both ADRs stands.
- Every model call records `modelVersion`, and every bench results file names the model it ran. Results from different models aren't compared as if they were one run.
- Flash-Lite is easier to talk into things. In S8 it proposed a full refund on an order its own lookup showed as delivered, which Flash declined to do. That sharpens the baseline-vs-protected contrast, but it may lower the share of genuine cases resolved correctly (G3). Bench v1 measures it, and the owner can switch models through the env file.
