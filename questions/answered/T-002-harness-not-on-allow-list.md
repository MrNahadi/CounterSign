# Answer: T-002, the screenshot harness

Answered by the conductor with the owner's approval, 1 Nov 2026.

`.ralph/settings.json` now allows `npm run ui:shots` (with any arguments) and sets `UI_SHOTS_CHROMIUM` for every loop session through its `env` block. Run the harness as plain `npm run ui:shots ...`, with no env prefix on the command. Don't add a wrapper. Pick the parked stash `T-002 parked` back up and finish the ticket.
