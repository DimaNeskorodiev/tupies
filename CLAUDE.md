# Tupies — Claude Code context

Read `AGENTS.md` first, then `PROJECT_CONTEXT.md`. They are the canonical project instructions and handoff; avoid duplicating architecture or status in this file.

This is a standalone, bots-first product with its own Tupies Engine. It is not a Hermes backend addon and does not require a Codex CLI. Hermes `SKILL.md` compatibility remains important. Preserve the user's emphasis on reliable bots, direct providers/subscriptions, bounded collaboration, rich chat/documents, simple glass UI and secure Mac/VPS deployment.

Start with `docs/development.md` for commands. Node22 is the verified baseline. `npm ci`, `npm run build`, `npm run check`, and `npm test` are the standard development workflow. `npm start` loads the optional local `.env`; check `docs/local-workspace.md` if present for this machine's setup.

Never expose or reset real account data. Keep `data/`, `.env`, vault keys, private workspaces and backups out of commits and release packages. Use temporary fixture data for automated tests. Keep authorization in the engine, preserve exact approvals and cancellation semantics, and never silently replay side effects.

Keep `PROJECT_CONTEXT.md`, the relevant documentation and `docs/roadmap.md` current. Distinguish shipped functionality from planned desktop/mobile/computer-use work. The recorded baseline is 192 tests; verification must follow the current changes rather than relying only on that historical count.
