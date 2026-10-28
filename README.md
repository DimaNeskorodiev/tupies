# Tupies

Your own team of AI bot companions, hosted by you.

For coding-agent handoff, read [AGENTS.md](AGENTS.md) and [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md). Claude Code starts at [CLAUDE.md](CLAUDE.md). See the [development guide](docs/development.md) for the local workflow.

A self-hosted AI product with its own **Tupies Engine**, a bots-first glass interface, and direct model-provider connections. Tupies owns the agent loop, conversations, memory, skills, workspaces, approvals, schedules, integrations and delegation. Hermes Agent is not installed, started or contacted.

The app opens on a **Dashboard** with your teammates, recent outputs and work that needs you. **Bots** opens conversations directly; each bot's profile contains its long-term notes (Brain), core facts (Memory) and private files. The pearl-white glass interface uses distinct cushion companions. Technical bot controls stay under **Advanced settings**. **Settings** starts with Models, Devices & sync and Help; Skills, Integrations, Messaging and Activity are under **More settings**.

Give each bot a role and model, then work with it in a persistent conversation. Chat supports formatted Markdown, tables, highlighted code, mathematics, diagrams, interactive charts and infographic cards. Bots can read and create PDF, Word, PowerPoint, Excel, Markdown, CSV, text and JSON files, remember useful facts, learn approved reusable skills, schedule routines, perform approved API actions and delegate real work to permitted teammates.

For coding work, bots can discover and search private workspace files, read selected lines, make hash-checked exact edits and verify with approved commands. Managed background commands let a bot continue working while builds or tests run, with real output, status and Stop controls. An approved bundled TypeScript/JavaScript language server provides definitions, type definitions, implementations, references, hover text, document/workspace symbols, call hierarchy and diagnostics when advertised; other installed stdio servers can be launched through exact approval. Tupies also supports bounded parallel reads, durable task checklists and paged tool results. See [Tool use](docs/tool-use.md) for workflows, permissions and current limits.

Enable **Workspace** and **Terminal** for a coding bot before asking it to launch code intelligence. Every command and language-server launch needs exact approval. They use the host account's permissions and are not an OS sandbox. Sessions belong to the current task and are cleaned up when it ends; a final answer with commands still running is reported incomplete. The pinned TypeScript server is included in Tupies's runtime dependencies and does not need a separate Claude Code, Codex or language-server installation.

## Start on your Mac

Requires Node.js 22.16 or newer. The release includes the browser assets and fonts; install the pinned runtime libraries once.

```sh
cd /path/to/tupies
npm ci --omit=dev
npm start
```

`npm start` loads an optional `.env`; its port/data settings take effect automatically. With no overrides, open [http://127.0.0.1:4310](http://127.0.0.1:4310); otherwise use the address printed in the terminal. Copy the one-time token from the terminal, choose your workspace password, then open **Model providers**. Add an API key or choose **Continue with ChatGPT** for eligible subscription access. Discover available models and choose a default. Your first provider is assigned to bots without a provider; individual bot settings can override it.

Open a bot and send a task. Its own engine will call the selected model, execute permitted tools, and show progress. Change the role, skills, tool groups, teammates and model in the bot's settings. Bots know the whole team and can ask each other for help by default; a bot's settings can limit it to selected teammates. Memory and files belong to that bot even when multiple bots use the same provider account.

## Chat model and voice controls

Change the current bot’s model and supported reasoning effort from Chat options beside the composer. Use OpenRouter AI voices with ElevenLabs defaults, model/voice selectors and comparison previews. Dictate an editable draft with the microphone and use the speaker controls to read replies aloud. OpenRouter speech requires an API-key connection and explicit processing consent; browser system voices remain available. Microphone permission and recording support are required; see [Models, reasoning and voice](docs/chat-controls.md) for privacy, supported browsers and deployment details.

## Rich chat and documents

Attach up to five files, write the task, and send it. Bots can extract text from PDFs and Office documents, analyze workbook data, and produce real files with **Preview** and **Download** cards. For example: “Read this spreadsheet, show a chart and an executive summary, then create a PDF report and a PowerPoint presentation.” See the [rich chat and file guide](docs/rich-chat.md) for formats, examples, exports and reading limits.

## Providers and subscription setup

OpenAI Responses, Anthropic Messages, xAI, OpenRouter, Ollama and compatible APIs are supported directly. **ChatGPT / Codex subscription** uses the documented Sign in with ChatGPT flow and the public Responses API, without a Codex CLI or Hermes dependency. It requires the account's eligible plan, consent and model access. Paid or remotely hosted offerings require OpenAI's separate onboarding; self-hosted open-source registration is supported by the local flow.

The [provider guide](docs/hermes-setup.md) explains setup, SSH callbacks, account renewal, integrations and portable skills. No existing Codex/Hermes credential files are imported.

## Messaging bots

Connect a Telegram bot under **Settings › More settings › Messaging**, bind it to a Tupies bot, and explicitly allow both chat IDs and user IDs. Enabled channels receive authorized text and return the actual bot result. New channels start disabled; tool approvals remain in Tupies. See the [setup guide](docs/hermes-setup.md) for the permission and delivery boundaries.

## Mac, server and iPhone in sync

Run Tupies on your VPS as the always-on **home server** and on your Mac as a full local engine. They keep bots, chats, memory, notes and settings in sync within a second or two, end-to-end encrypted between your engines. Pair the Apple app with a QR code, then switch between **This Mac** and **Home server** in one click. See [Engines, devices and sync](docs/sync.md) and the [Apple app](apps/apple/README.md).

## Deploy on a VPS

```sh
docker compose up --build -d
docker compose logs studio
```

From your Mac, forward the same port:

```sh
ssh -N -L 4310:127.0.0.1:4310 user@your-vps
```

For phone access from anywhere and engine sync, give the server an HTTPS address and pair with `npm run pair`, as described in [deployment](docs/deployment.md#home-server-and-mac-in-sync). Open `http://127.0.0.1:4310`. Tupies is the complete server; a separate agent gateway is not required. The container publishes loopback only and runs as a non-root user with a read-only application filesystem. Data, workspaces and credentials stay in its persistent volume. See [deployment](docs/deployment.md) for native services, OAuth callbacks and optional HTTPS.

## Documentation

- [Project context and handoff](PROJECT_CONTEXT.md)
- [Development workflow](docs/development.md)
- [Future product roadmap](docs/roadmap.md)

- [Implemented capabilities and boundaries](docs/capabilities.md)
- [Rich chat, visualizations and documents](docs/rich-chat.md)
- [Coding tools, plans and execution](docs/tool-use.md)
- [Architecture and future device clients](docs/architecture.md)
- [Providers, subscription login, integrations and skills](docs/hermes-setup.md)
- [Operations, backups and upgrades](docs/operations.md)
- [Mac/VPS deployment](docs/deployment.md)
- [Engines, devices and sync](docs/sync.md)
- [iPhone notification setup](docs/notifications.md)
- [HTTP API](docs/api.md)
- [Security and execution permissions](docs/security.md)
- [Primary references and research](docs/research.md)
- [Verification record](docs/verification.md)

The guide is also available inside Tupies at `/guide.html`.

## Development

```sh
npm ci
npm run build
npm run check
npm test
```

`npm ci` installs the pinned runtime and development packages. The full build bundles local rich chat/PDF assets, regenerates the guide and collects dependency notices. `npm run dev` watches the server; rebuild browser assets after frontend changes and run `npm run docs:build` after documentation changes. Release users can use `npm ci --omit=dev` because browser assets and fonts are already shipped. No Codex or Hermes installation is needed to build or run Tupies.

One process owns a data directory and its scheduler; do not run two engines against the same volume. Separate engines sync through a home server instead.

The Apple app is a native shell around the engine interface (see [apps/apple](apps/apple/README.md)). Live computer control and Mac/iOS action permissions are planned. This version does not take over the host computer or an iOS device. The [capability map](docs/capabilities.md) separates implemented engine features from those future surfaces.
