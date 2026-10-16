# Sponsor resources review

The hackathon's [resources page](https://paypalaihackathon.devpost.com/resources), checked on 16 Oct 2026 against the brief. A project can win one grand prize or Honorable Mention, plus one sponsor prize. Our sponsor prize is AG Grid's ($5,000 for first place), so the other sponsors matter only if they make Countersign better.

| Sponsor | What it offers | Verdict for Countersign |
|---|---|---|
| AG Grid | AG Studio, the boilerplate, a 45-day trial licence. Prize: $5,000 / $2,000 / 3 × $1,000 | **In use.** The Risk desk (phase 16) is our sponsor-prize entry |
| Render | Hosting credit. Prize: Render credits | **In use.** Our host (spike S7). Its prize doesn't stack with AG Grid's |
| APIMatic | A Context Plugin for coding agents, free subscriptions. Prize: 3 × $1,000 | **Not adopted.** Its skills teach the APIMatic-generated PayPal Server SDK, while we use direct REST (we control `PayPal-Request-Id`, and the SDK doesn't cover all our calls). The repo calls itself experimental and \"may be removed at any time\" |
| KERNEL | Cloud browsers for agents, $50 credit | **Maybe later.** It could run the hosted daily smoke test (phase 19), or pre-create sandbox disputes before recording and judging, which is otherwise a manual chore |
| Zapier | Zapier MCP, 9,000+ apps, 14-day trial then a free plan | **Maybe later, as a stretch.** It could send step-up alerts by SMS, WhatsApp or Slack beside the phone approval page. The free plan's task limit is small |
| Postman | PayPal's API collection | **Optional, by hand.** Useful for exploring PayPal endpoints; nothing to build in |
| Elastic | Elasticsearch, Agent Builder, a 14 + 30-day trial | **Skip.** Postgres and AG Studio already cover the audit log and analytics. It would add a service without strengthening the claim |
| Astropods | A platform for running agents with guardrails | **Skip.** Our gate is the guardrail, and our architecture is settled |
| Bryntum | Gantt, Scheduler, Calendar. Prize: 3 × $1,000 | **Skip.** A dispute-deadline timeline would be nice, but it adds a second UI library and its prize doesn't stack with AG Grid's |
| Channel3 | Product search across retailers. Prize: $1,500 | **Skip.** Kikapu sells its own products; there's nothing to search |

From PayPal's own list:

- **PayPal AI Toolkit (github.com/paypal/AI-Toolkit)** is a plugin for coding agents (Claude Code, Codex, Cursor) backed by PayPal's sandbox MCP server. It's a build aid, not a product dependency; our spikes already call the APIs directly.
- **The MCP server quickstart and agent tools reference** have moved (the `docs.paypal.ai` links return 404). Spike S4 lists the server's 28 tools directly, which is the source we trust.
- **Webhooks and Disputes docs** feed spikes S3 and S7.
- **Discord** is where to ask the AG Grid team about licence cover to 22 Dec (brief §15).
