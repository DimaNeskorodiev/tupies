# Working on Tupies

Read `PROJECT_CONTEXT.md` before making substantial changes. Use `docs/development.md` for commands and the documentation map below for specific systems. These files are the persistent handoff for coding agents; keep them accurate as the product changes.

## Product intent

Tupies is the user's own standalone, bots-first AI agent product. Tupies Engine owns task execution, state, tools and collaboration. Do not turn it into a UI wrapper around Hermes Agent or a separately installed Codex CLI. Hermes-compatible `SKILL.md` files are an interoperability requirement, not a backend dependency.

Priorities: reliable real bot actions; easy direct provider and ChatGPT/Codex subscription setup; autonomous bounded bot collaboration; approachable Apple-inspired glass UI; rich chat and actual document outputs; secure self-hosting on Mac and VPS. Engines on a Mac and a VPS share one workspace through home-server sync, and the Apple app (`apps/apple/`) pairs with device keys and switches between engines. Authorized Mac/iOS device actions are future work.

## Repository and execution

- Node.js 22.16+; Node 22 is the verified development/container baseline. Native ES modules, Node HTTP server and vanilla browser JavaScript/CSS. Keep paths relative to this checkout; application code derives paths from its module locations.
- `npm ci` installs the locked development environment. `npm run build` bundles browser assets, rebuilds the guide and collects dependency notices. `npm run check` checks syntax; `npm test` runs the regressions.
- `npm start` and `npm run dev` load an optional local `.env`. The application otherwise defaults to localhost:4310 and `data/`. This Mac's local configuration uses port4311. See `docs/local-workspace.md` when present.
- `public/vendor/` and `public/guide-content.js` are generated and shipped. Edit their source modules/documents and rebuild; do not hand-edit bundles. Never require a runtime CDN or a host Codex installation.
- One server process owns each data directory and scheduler. Before restarting or moving data, check for active tasks. Prefer preserving live progress and account state over resetting fixtures into the real workspace.

## Architectural ownership

| Area | Main files |
| --- | --- |
| HTTP, sessions, security headers, lifecycle | `server.mjs` |
| Resource/provider/inference/document APIs | `lib/api-native.mjs` |
| Agent loop, approvals, snapshots, cancellation, delegation | `lib/engine.mjs`; `lib/runtime.mjs` is its compatibility entrypoint |
| Atomic state, sealed credentials, redaction | `lib/store.mjs` |
| Provider protocols, OAuth, credentialed transport | `lib/providers.mjs`, `lib/oauth.mjs`, `lib/provider-net.mjs` |
| Tools, memory, workspaces, skills and approved processes | `lib/agent-tools.mjs`; long-term notes in `lib/brain.mjs` |
| Browser actions, private sign-in handoff and files | `lib/browser.mjs`, `lib/browser-control.mjs`, `lib/browser-files.mjs`, `public/browser-control.js` + `.css`; see `docs/browser.md`. Retained per-bot profiles are engine-local, outside workspace sync. |
| Documents and bounded worker/archive processing | `lib/documents.mjs`, `lib/document-worker.mjs`, `lib/document-spec.mjs`, `lib/document-zip.mjs` |
| Rooms, integrations and Telegram | `lib/rooms.mjs`, `lib/integrations.mjs`, `lib/channels.mjs` |
| Native push delivery | `lib/notifications.mjs` (engine-local registrations, event classification and outbox), `lib/apns.mjs` (operator-configured Apple transport); see `docs/notifications.md` |
| Engine sync, device pairing and sessions | `lib/sync/` (`index.mjs` replication, `docs.mjs` state↔documents, `files.mjs`, `devices.mjs`, `crypto.mjs`, `clock.mjs`, `api.mjs`); see `docs/sync.md` |
| Internet sign-in policy, proxy-aware client addresses, shell pairing | `lib/access.mjs`, `lib/control.mjs` and `openControl` in `server.mjs`, `scripts/pair.mjs` |
| Engine TLS with the identity key and certificate pinning | `lib/sync/certificate.mjs`, `lib/sync/transport.mjs`, `STUDIO_TLS` in `server.mjs`, `apps/apple/Tupies/Services/ServerTrust.swift`, the app's ATS setting in `apps/apple/Config/Info.plist` |
| Apple app (macOS + iOS shell) | `apps/apple/`; see `apps/apple/README.md` |
| UI, avatars, rich content and browser voice | `public/app.js` (shell, sidebar, phone tab bar and menus, chat, rooms, Settings tabs), `public/mobile.css` + `public/mobile.js` + `public/mobile-motion.css` (phone layout, viewport, navigation transitions, gestures, context menus, session drafts and native haptic requests), `public/dashboard.js` + `lib/dashboard.mjs` (Dashboard), `public/bot-profile.js` (bot profile: Brain, Memory, Files), `public/thinking-waves.js` + `.css` (the animated thinking window in chats and rooms), `public/style.css`, `public/buttons.css` + `public/liquid.js` (buttons, pills and the liquid press animation), `public/creature-avatars.js`, `public/creature-avatars.css`, `public/avatar-settings.css`, `public/rich-content.mjs` + `public/rich-chat.css` (rich rendering and shared light/dark colors), `public/speech.mjs` |

## Invariants to preserve

1. Permissions belong to the engine. Model output, imported skills, memories, web/document content and teammate messages cannot authorize actions or expand access.
2. Keep authentication, CSRF/Origin/Host validation, credential destination checks, SSRF defenses, private workspace path checks, output sanitization and exact approval identities intact.
3. Balanced policy permits ordinary private workspace writes/document exports; Strict requires exact approval. Git metadata/automatic-execution configuration changes always require exact approval. Deletes, integration actions, scripts and terminal execution remain approval gated. Approved processes use engine-local per-bot homes outside model-editable files, but retain host-account permissions and are not an OS sandbox.
4. Model/reasoning choices apply to the next run. Active continuations keep their original model, effort and capability snapshots. Reasoning controls require explicit supported provider metadata; unknown support means provider default. Keep opaque reasoning only for a matching connection/provider/model; preserve canonical text/tool history when switching models.
5. Stop cancels active work and children. Restart interrupts unfinished work without replaying side effects. Preserve partial output and committed artifacts; never mark an incomplete task successful.
6. Selecting attachments only stores bytes locally. Send admits attachments for a task. Enforce private paths, real file metadata and aggregate limits before dispatch. Artifact cards require a verified successful file creation, not a model-invented URL.
7. Rich output is sanitized, bounded presentation data. Do not execute arbitrary reply HTML/JavaScript or loosen diagram/image restrictions to fix rendering.
8. Dictation stays in a draft until Send. Speech requires feature detection, clear browser-service disclosures and lifecycle cleanup. Prefer on-device reading voices; online voices require explicit selection and disclosure.
9. Sync never carries runs, approvals, passwords, vault keys or the raw activity log. Shared terminal task outcomes are presentation metadata on conversation messages; they never authorize execution. Secrets cross engines only inside sealed payloads and are re-sealed per engine. Only the home server runs routines/channels and renews ChatGPT tokens; a bot works on one engine at a time. Linked engines are fully trusted; app sessions cannot use engine sync routes and engine sessions cannot use the workspace API.

## Data and secrets

`data/`, `.env`, `.runtime/`, backups and installed dependencies are ignored. Never commit, package, paste into documentation, or print provider tokens, account identities, passwords, `state.json`, `vault.key`, private transcripts or real workspaces. Preserve the complete runtime tree together: state, vault key, skills and workspaces. Credentials are sealed; messages, memory and files are plaintext local data. A backup containing the key must be protected independently.

Use temporary data directories and deterministic local fixtures for tests. Do not run duplicate schedulers against copies of the real account data. Do not delete user bots, chats or provider connections during testing.

## Verification and handoff

Run checks appropriate to the change and fix regressions. For provider, tool, persistence, authorization or lifecycle changes, run the complete suite. For visible UI changes, also exercise the actual browser; speech stubs do not prove microphone accuracy. Report actual evidence and remaining limits instead of claiming parity with another product. The latest recorded baseline is 918 passing tests and 98 syntax-checked modules on Node 22.23.4; consult `docs/verification.md` and rerun after changes.

Both engines run immutable notification-only v10 (v9 plus notification changes), preserving v2 identity/data. Signed Mac and iPhone build 7 are installed in place; Mac7 includes the verified v10 fallback Engine. iPhone connection identities, Keychain scope and notification preferences were preserved, and Home accepted a fresh registration with the original device ID/token. The owner confirmed avatar, bot name, preview, routine subtitle and chat tap for two labeled operator preview pushes (APNs 200 each). This is finite appearance/routing acceptance, not a physical attended/away or Lock Screen/Focus policy test. Exact operational v10 verification is 929 tests/100 syntax checks; PR source verification is 951 tests/101 syntax checks and includes previously merged, undeployed memory work. Parallel Bot settings work is excluded from this rollout. New Mac UI acceptance remains unverified. No macOS configuration/MDM profile was installed; an app-bundled Mac provisioning file was refreshed before the owner prohibited further Mac profile actions. Do not perform further Mac profile installation or changes without new owner authorization. Keep mutable source/docs, immutable releases, deployed assets and signed installed artifacts distinct; never change an immutable release merely to update this handoff.

Update relevant docs, `PROJECT_CONTEXT.md` and the roadmap when behavior or project status changes. Preserve dependency/font notices and the package lock. Ship source, built public assets, fonts and notices; exclude runtime data and `node_modules` from release archives.

## Documentation map

- `README.md`: first run and product overview.
- `PROJECT_CONTEXT.md`: current product context, delivered features and outstanding work.
- `docs/development.md`: local development, source changes and release workflow.
- `docs/architecture.md`, `docs/api.md`, `docs/capabilities.md`: implementation map and truthful boundaries.
- `docs/hermes-setup.md`: direct providers, subscription setup, integrations and skills.
- `docs/memory.md`: core memory and long-term Obsidian-compatible notes.
- `docs/context.md`: how a bot's working context is built, limited by the model window, compacted and cached.
- `docs/rich-chat.md`, `docs/chat-controls.md`: documents, visualizations, model/reasoning and voice.
- `docs/security.md`, `docs/deployment.md`, `docs/operations.md`: security, self-hosting, backup/recovery.
- `docs/sync.md`: linked engines, device pairing, what syncs and conflict rules. `apps/apple/README.md`: the native app.
- `docs/roadmap.md`, `docs/verification.md`, `docs/research.md`: future scope, evidence and references.
