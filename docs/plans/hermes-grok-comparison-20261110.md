# Tupies Engine compared with Hermes Agent and Grok Bot — 10 November 2026

Requested by the owner on 10 November 2026: Hermes Agent is the most versatile agent of the three, and Tupies should become as flexible as Hermes with a better user experience. This note compares the three products area by area and lists what Tupies has to build.

**Sources.**
- **Hermes Agent:** `nousresearch/hermes-agent` at commit `3d4dd10` (10 November 2026), read as source and documentation from a shallow clone. Nothing from it was run. It is MIT-licensed, so mechanisms and even code may be adapted with attribution; it is Python, so in practice Tupies reimplements.
- **Grok Bot:** the official documentation at `docs.x.ai/grok-bot` as served on 10 November 2026 (overview, how it works, skills and routines, approvals and security). No account was used. The documentation does not state the models, limits or prices.
- **Tupies:** branch `feature/engine-capability-20261110` (`origin/main` `7375bb2` plus the uncommitted work of the same day).

Nothing was benchmarked. Counts for Hermes come from its repository; where a claim was only seen in its documentation and not confirmed in code, the note says "documented".

## Short answer

Hermes is flexible for one structural reason: **almost everything is a registry that a plugin can add to**. Model providers, messaging platforms, search backends, browser backends, terminal backends, memory providers, context engines, speech providers and approval transports are all pluggable, and every one of them is selected in configuration. Tupies has the same kinds of parts but, in most areas, exactly one built-in implementation of each.

Hermes pays for that flexibility in user experience. It is configured through a YAML file, an `.env` file, about 108 slash commands and several CLI wizards. Its web dashboard has 24 pages, and its chat page is a terminal embedded in the browser. It has no native phone app. Its default approval mode is a model-based classifier, the checks are skipped on container backends, and there is no spending cap.

Grok Bot is the opposite. It is a hosted product with a polished experience (a persistent cloud computer per user, a secrets vault, review cards, teaching by demonstration, voice calls, phone and desktop apps) and almost no flexibility: no model or provider choice is documented, and it cannot be self-hosted.

Tupies sits between them. Its experience is already closer to Grok Bot than Hermes is (native Apple app, rich chat and real documents, approvals as cards, usage shown per reply). Its flexibility is far behind Hermes. The gap is concentrated in six places, in this order of impact:

1. **Channels.** Hermes has 26 messaging platforms plus an API server and webhooks. Tupies has Telegram, text only.
2. **Extension points.** Hermes has stdio and HTTP MCP with OAuth, a 66-entry MCP catalog, eight skill sources and a plugin system with 48 hook events. Tupies has HTTP MCP through Integrations and a reviewed skills catalog.
3. **Where commands run.** Hermes has six execution backends (local, Docker, SSH, Modal, Daytona, Vercel Sandbox). Tupies runs commands as the engine's own account.
4. **Model routing.** Hermes has about 45 providers, five subscription sign-ins, ordered fallback chains, key pools and a separate model per side task. Tupies has 16 provider types, one subscription sign-in and one fallback.
5. **Automation.** Hermes has cron expressions, natural-language schedules, delivery to any channel, script-only jobs, webhook-triggered jobs and quiet runs. Tupies has four schedule kinds that deliver to the bot's chat.
6. **Session control.** Hermes can branch, rewind, undo, retry, export and hand a session to another channel. Tupies has chats with new, continue, rename and delete.

## Area-by-area comparison

"Gap" rates what Tupies lacks relative to Hermes: **none**, **small**, **medium**, **large**.

### Models and providers

| | Hermes Agent | Grok Bot | Tupies today | Gap |
| --- | --- | --- | --- | --- |
| Providers | About 45 (40 provider plugins), including Bedrock, Vertex, Azure, NVIDIA NIM, Hugging Face, LM Studio; user-defined named providers; keys minted by a command | Not stated; no choice documented | 16 types: OpenAI, ChatGPT/Codex, Anthropic, xAI, OpenRouter, DeepSeek, Gemini, Groq, Mistral, Together, Fireworks, Z.ai, Moonshot, MiniMax, Ollama, custom | Medium |
| Subscription sign-in | Nous Portal, ChatGPT/Codex, xAI, Qwen, MiniMax; Anthropic by key, setup token or a borrowed Claude Code login (documented as Max with extra credits only) | Built in | ChatGPT/Codex only | Medium |
| Local models | Ollama, LM Studio, vLLM, llama.cpp, SGLang, LiteLLM (documented) | No | Ollama, and anything OpenAI-compatible through "custom" | Small |
| Switching | `/model provider:model` per session, once, or globally; presets and aliases | No | Per-bot model picker in chat; applies to the next task | Small |
| Side-task models | A separate model, with its own fallback chain, for each of 14 side tasks (vision, compression, approval, review, titles and others) | Hidden | One owner-wide auxiliary model for memory and skill reviews, API only | Medium |
| Fallback | Ordered chain of providers; key pools with four rotation strategies before fallback | Hidden | One fallback model per bot, used once; a spent quota goes straight to it | Medium |
| Reasoning | Eight effort levels, per-model overrides, show/hide | Hidden | Effort per bot mapped per provider; Thinking block in chat | None |
| Cost | `/usage`, `/insights` (30 days), `/context`; prices from models.dev; no spending cap found | Weekly usage allowance; details not stated | Usage line under each reply; optional per-bot task budget; prices only from OpenRouter or the provider's report | Small |

### Tools and where they run

| | Hermes Agent | Grok Bot | Tupies today | Gap |
| --- | --- | --- | --- | --- |
| Tool loading | About 27 tools in a default session; toolsets enabled per platform or per session; deferred loading through `tool_search` / `tool_call` | Not stated | 16 core tools; other groups load on demand through `tools_load` / `tool_call`; groups enabled per bot | None |
| Execution backends | Local, Docker, SSH, Modal, Daytona, Vercel Sandbox; Singularity as a plugin | The user's shared cloud computer; optionally the user's own Mac, Windows PC or phone | Local only, as the engine's account, no OS sandbox | Large |
| Shell | Persistent shell; background processes with notify-on-exit and heartbeats | Terminal on the cloud computer | Persistent per-task shell; background commands scoped to the task; nothing wakes the bot when a job ends | Medium |
| Code execution | `execute_code`: Python that can call the agent's own tools, with a persistent kernel | Yes | `execute_code` for Python or Node snippets; cannot call tools | Medium |
| File safety | Protected paths; opt-in checkpoints with `/rollback`, `/undo`, `/diff` | Not stated | Private workspace per bot; exact approvals; no checkpoints | Medium |
| Web search | 11 backends, chosen separately for search and for extraction; keyless rotation | Not stated | Exa, then DuckDuckGo, then an approved Brave/Tavily/SearXNG fallback | Small |
| Browser | Local Chromium, Browserbase, Browser Use, Firecrawl, Lightpanda, or the user's own Chrome; a credentials vault tool | Persistent signed-in browser; live view; the user can take over | Built-in headless Chrome with retained per-bot profiles, actions, owner handoff for sign-in | Small |
| Computer use | `computer_use` on macOS, Windows and Linux with any tool-capable model | Core feature, cloud and local | Local Mac desktop actions through an optional pinned driver, owner chat only | Medium |
| Image and video | Image generation, video generation, vision | Media creation documented | Vision input only | Medium |

### Extension points

| | Hermes Agent | Grok Bot | Tupies today | Gap |
| --- | --- | --- | --- | --- |
| MCP | stdio and HTTP/SSE; OAuth 2.1; per-server tool filters; sampling; lazy start; 66-entry catalog; can serve as an MCP server through a plugin | "Any MCP server or API" through connectors | Streamable HTTP only, through Integrations; each call approval-gated unless set to automatic for reads | Large |
| Skills | `SKILL.md` with progressive disclosure; 44 bundled and 141 optional skills; eight hub sources; the agent writes and patches its own skills; each skill is a slash command | Skills shared across bots; taught by a recorded demonstration (where available); app catalog; team publishing | Hermes-compatible `SKILL.md` import; reviewed catalog; two bundled packages; skills suggested from finished work | Medium |
| Plugins | A plugin can add tools, hooks, commands, platforms, providers, memory providers, context engines, speech and search backends, terminal backends and more; 48 hook events; a catalog of about 1,580 entries, each pinned to a commit | No | None. The Tool workshop adds isolated pure-computation tools only | Large |
| Connected apps | Through MCP and skills | Named connectors (Drive, Calendar, Gmail, Slack, Notion, Teams and more) | REST and MCP integrations with sealed keys; presets for a few services | Medium |
| Persona and project context | `SOUL.md`, 14 personalities, `AGENTS.md` / `CLAUDE.md` / `.cursorrules` loaded and scanned | Per-bot instructions | Per-bot role and instructions; reference data kept apart from instructions | Small |

### Where the user talks to it

| | Hermes Agent | Grok Bot | Tupies today | Gap |
| --- | --- | --- | --- | --- |
| Own apps | CLI, terminal UI, web dashboard (chat is an embedded terminal), Electron desktop app; no native phone app | Desktop, phone and web apps | Web app, native Mac and iPhone app | None; Tupies is ahead of Hermes |
| Messaging | 26 platforms, including Telegram, Discord, Slack, WhatsApp, Signal, Matrix, email, SMS, Teams, iMessage; media in and out; streaming by editing a message; approval buttons | Slack and X | Telegram, text in and text out; no buttons, media or streaming | Large |
| Machine interfaces | OpenAI-compatible API server; webhooks with signatures and filters; editor integration (ACP); agent-to-agent protocol | Webhook and app-event triggers | Own REST API for its apps; no OpenAI-compatible endpoint, no inbound webhooks | Large |
| Voice | 7 speech-to-text and 11 text-to-speech providers, including local ones; voice mode with interruption; voice messages on platforms | Voice calls and voice notes | Recorded dictation and read-aloud through OpenRouter or the browser | Medium |
| While a task runs | Interrupt, queue or steer a new message; `/bg` for a parallel task | Steering documented | Add direction; Stop; no queued next message | Small |

### Automation and several agents

| | Hermes Agent | Grok Bot | Tupies today | Gap |
| --- | --- | --- | --- | --- |
| Schedules | "in 30m", "every 2h", plain phrases, cron expressions, exact times, a time zone per job | Plain-language schedules, five-minute minimum | Interval (five minutes or more), daily, weekly, once | Medium |
| Per-job settings | Model, effort, skills, toolsets, folder | One owning bot | The bot's own settings; pre-approved commands | Small |
| Delivery | Origin chat, any platform or thread, several at once; a quiet token suppresses a run with nothing to report | The bot's chat | The bot's chat and a notification on every run | Medium |
| Triggers | Webhook routes can start a job; script-only jobs; a pre-check that decides whether to wake the agent; chained jobs | Slack, GitHub, Linear, Sentry, PagerDuty, email to the bot, webhooks | None beyond the clock | Large |
| Sub-agents | `delegate_task`: up to 10 at once, in the background, optional output schema, optional git worktree | A primary bot coordinates others; bots review each other | Named teammates with `delegate_task`, required deliverables and verification; rooms; Missions | Small; Tupies' model is different, not weaker |
| Separate agents | Profiles: each with its own configuration, memory, skills and schedule | Several bots sharing one computer | Bots, each with its own workspace, memory, skills and tools | None |
| Work board | Kanban boards with worker processes | No | Missions with contracts and acceptance checks | None |

### Memory, context and sessions

| | Hermes Agent | Grok Bot | Tupies today | Gap |
| --- | --- | --- | --- | --- |
| Built-in memory | `MEMORY.md` (2,200 characters) and `USER.md` (1,375) | Preferences, rules and a dated work log per bot | Core facts with provenance, an Obsidian-compatible notes vault, task notes | None; Tupies is richer |
| External memory | One provider at a time out of about nine (Honcho, Mem0, Supermemory and others) | No | None | Small |
| History search | SQLite full-text search and a `session_search` tool | Not stated | `session_search` / `session_read` and owner transcript search | None |
| Compaction | Starts at 50% of the window, targets 20%, protects the first 3 and last 20 messages, side model, `/compress`; context engines are pluggable | Automatic, no control | Starts at 55% (128K ceiling), targets 20%, clears old tool outputs first, manual Compact | None |
| Session control | Resume by name, branch, fork, rewind, undo, retry, export, hand off to another channel, import from Claude Code and Codex | Reset a conversation and keep memory | New, list, continue, rename, delete | Medium |

### Safety and control

| | Hermes Agent | Grok Bot | Tupies today | Gap |
| --- | --- | --- | --- | --- |
| Approvals | Dangerous-command patterns; a model-based classifier by default, manual or off; a hard blocklist; allow and deny lists; skipped on container backends | Model-based Auto Review, on by default; up to 20 allow and 20 ask rules; team rules | Exact, digest-bound approvals owned by the engine; a deterministic command classifier; three review modes per bot | None; Tupies is stricter |
| Where approvals can be answered | Terminal, dashboard, chat platforms with buttons | Desktop, phone, Slack thread | The Tupies apps only | Medium |
| Secrets | `.env`; redaction; a browser vault tool | Vault and secure forms; values never shown to the model | Sealed credentials for providers and integrations; no vault for site logins | Medium |
| Isolation | Docker, SSH or cloud sandbox backends | A cloud computer per user, shared by that user's bots | None at the operating-system level | Large |
| Limits | Turn limit optional; no spending cap found | Weekly allowance; routine rate limits | Optional task budget; stall and refused-site check-ins | None |

## What Tupies should keep

These are deliberate strengths, and neither competitor matches all of them:

- **Approvals that belong to the engine.** Exact, bound to the action's digest, never widened by model output. Hermes' default is a model that guesses; Grok's own documentation calls Auto Review a risk reducer, not a boundary.
- **A real app.** A native Mac and iPhone app with paired device keys, push notifications and two engines sharing one workspace. Hermes has no phone app and a terminal for a chat page.
- **Finished work.** Verified PDF, Word, Excel and PowerPoint files, rich chat, artifact cards.
- **Bots as a team.** Named teammates with their own workspaces, required deliverables that are verified, rooms and Missions.
- **Cost visibility.** A usage line on every reply and an optional budget per task.

## What to build, as flexible as Hermes with a better experience

The rule for every item: **Hermes offers a registry and a configuration file; Tupies offers the same registry behind a settings screen with a working default.** No item should require editing a file or learning a command.

### F1 — A real messaging gateway (largest gap)

- One adapter interface (receive, send, edit, typing, media, buttons), with Telegram rebuilt on it.
  - Media in and out, replies that stream by editing one message, approval and question buttons bound to the owner's account.
  - One shared lane per group chat, with sender names.
- Then Discord, Slack, WhatsApp and email. These four cover most of what Hermes users actually connect.
- Delivery targets for routines and a `message_send` tool with a remembered idempotency key.
- **Better than Hermes:** each channel is connected from a card in Settings with a test button. Hermes needs environment variables and allowlists typed by hand. Approvals from chat stay exact and owner-only.

### F2 — Open extension points

- **MCP over stdio** next to HTTP, with OAuth sign-in, per-tool automatic/ask policy and a catalog of known servers. Hermes ships 66 manifests; Tupies can start with the 15 most used.
- **More skill sources.** GitHub, skills.sh and ClawHub next to the reviewed catalog, behind the existing scanner, plus skills the bot writes and patches itself under review.
- **Engine registries** for search backends, speech providers and execution backends, so adding one is a small module and a settings entry. A general third-party plugin system with hooks is not needed yet; the registries deliver most of the flexibility without the security surface.
- **Better than Hermes:** a server or skill is added from a gallery with its permissions shown before it is enabled.

### F3 — A place to run commands safely

- Execution backends chosen per bot: **local sandbox** (Seatbelt on the Mac, bubblewrap on the server), **Docker**, and **SSH** to another machine.
- Work inside the sandbox runs unattended in every lane; leaving it needs approval. This is item R3 of the OpenBot reuse plan and unblocks routines and Telegram bots.
- Background jobs that wake the bot when they finish, and `execute_code` that can call the bot's own tools.
- File checkpoints with one-click undo of a task's file changes.
- **Better than Hermes:** Hermes skips its command checks inside containers; Tupies keeps exact approval for anything that leaves the sandbox.

### F4 — Model routing

- An ordered list of backup models instead of one, and several keys per provider with rotation.
- A model per side task (summaries, reviews, titles, vision), set on one Settings screen. Today the auxiliary model has no interface.
- More sign-ins where the provider allows them: xAI first, then the Anthropic paths Hermes documents.
- Presets for LM Studio, vLLM and llama.cpp, plus Bedrock, Vertex and Azure.
- Prices for direct providers from models.dev, so the usage line shows dollars beyond OpenRouter.
- **Better than Hermes:** a provider is added on one screen with a model picker that shows window, price and reasoning support.

### F5 — Automation

- Cron expressions and plain-language schedules ("weekdays at 9") with a time zone per routine.
- Delivery to any connected channel; quiet runs that send nothing when there is nothing to report.
- Triggers: a signed inbound webhook per routine, email to the bot, and events from connected apps.
- Script-only routines and a cheap pre-check that decides whether to wake the model at all. Both save money.
- **Better than Hermes and Grok:** the routine is created by describing it in chat and confirmed on a card that shows the schedule, the trigger, the destination and the pre-approved commands.

### F6 — Session control and machine interfaces

- Retry, edit-and-resend, branch from a message, undo the last task, export a chat.
- A queued next message while a task runs.
- An OpenAI-compatible endpoint per bot, so other tools can call a Tupies bot as a model.
- **Better than Hermes:** message actions in the chat instead of 108 slash commands.

### Later, by demand

- Image and video generation; local speech-to-text and more voices; a live voice call (Grok's strongest phone feature).
- Computer use beyond the local Mac driver; a vault for site logins with secure forms, as Grok has.
- Teaching a skill by recording a demonstration, as Grok documents.
- External memory providers; an editor integration (ACP).

## Suggested order

| Phase | Content | Why first |
| --- | --- | --- |
| 1 | F3 sandbox and backends | Unblocks unattended work in every lane; the other phases add lanes |
| 2 | F1 gateway: Telegram rebuilt, then Discord and Slack | The largest visible gap; needs phase 1 to be useful without the owner present |
| 3 | F5 automation and F4 model routing | Both are mostly engine work on existing structures |
| 4 | F2 extension points | Larger security review; benefits from the sandbox |
| 5 | F6 session control and the OpenAI-compatible endpoint | Mostly interface work |

## Decisions for the owner

1. **Plugins.** Engine-side registries only (recommended), or a third-party plugin system like Hermes'?
2. **Channels after Telegram.** Discord and Slack first (recommended), or WhatsApp and email?
3. **Execution.** Local sandbox first (recommended), or Docker first?
4. **Subscriptions.** Which sign-ins matter beyond ChatGPT: xAI, Claude, others?

## Limits of this comparison

- No product was run side by side; nothing here measures answer quality, speed or cost.
- Hermes counts are from its repository at one commit; its documentation is stale in places (it still describes 27 hooks where the code has 48, and five search backends where there are eleven).
- Grok Bot facts are from public documentation only. Models, limits, prices and the strength of its isolation are not documented.
- The Tupies column includes work from 10 November 2026 that is not yet committed or installed.
