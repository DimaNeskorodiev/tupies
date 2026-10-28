# Development and project handoff

Start with `AGENTS.md` and `PROJECT_CONTEXT.md` at the repository root. `CLAUDE.md` points Claude Code to the same instructions. Keep portable documentation relative to the checkout.

## Run locally

Use Node 22 (at least 22.16). From the project root:

```sh
npm ci
cp .env.example .env
npm start
```

Skip the copy when `.env` already exists; do not overwrite the owner's local configuration. `npm start` and `npm run dev` load `.env` when present. With no override the app uses `127.0.0.1:4310` and `data/`. Check the terminal for the actual address. The relocated Mac workspace already has data and a local config using 4311; do not bootstrap or reset it. See `local-workspace.md` if present.

First run against an empty data directory prints a bootstrap token for choosing the workspace password. Existing state uses the existing workspace password. Provider keys/account tokens are configured in Tupies, never in source or documentation.

Only one process may own a data directory; a second engine refuses to start while the first one's `control.sock` answers. `npm run pair` (add `-- --engine` for an engine link) asks the running engine for a pairing link through that socket. Check active tasks before stopping a development instance. A restart invalidates browser sessions and interrupts unfinished work without replaying actions.

## Change and verify

```sh
npm run dev
npm run build
npm run check
npm test
```

The dev command watches the server. Reload the browser after changes. Rebuild after modifying `public/rich-content.mjs`, `public/speech.mjs`, vendor inputs or dependency versions. `public/app.js`, `public/creature-avatars.js` and CSS are served directly. The pearl theme is scoped by `body.pearl-studio` in `public/pearl.css`, loaded after component/phone styles; the default document explicitly selects the requested light appearance. `public/mobile.js` remains the viewport/draft/gesture controller.

Cushion companions use transparent local assets in `public/assets/companions/`. Dedicated portraits are the default for working UI; full-body mascots are requested only by single-bot welcomes/profile heroes. The 24-entry source catalog is `assets/companions/catalog.json`; the builder generates `public/companion-catalog.js`, which must load before the renderer. The twenty new 2×2 pose sheets retain their original alpha and exact prompts under `expansion-a/` and `expansion-b/`. The pipeline registers poses to a shared scale/foot baseline and derives compact portraits without recoloring or color-keying. Sources, alpha/layout metadata and exact generation prompts are in `assets/companions/`. `npm run avatars:build` runs both `scripts/build-roki-assets.mjs` (historical previews) and `scripts/build-companion-assets.mjs`, and is included in `npm run build`. The companion builder exports 32/64/128/256/512px WebP pose frames, 512px idle PNGs for new characters, the original four PNG/WebP sets, portable 256px animated WebPs, and catalog/registration manifests. Never hand-edit exports. `node scripts/build-companion-assets.mjs --only=cloud,tangerine` rebuilds a bounded subset during asset work; the normal command requires the complete catalog. Shared visibility observers pause offscreen animation; CSS handles body motion, pose layers, paused state and Reduce Motion. `/companions-preview.html` uses the production renderer; `/roki-preview.html` remains historical. Ship referenced local images; no runtime image service or CDN is required. `npm run docs:build` rebuilds the browser guide. `npm run build` also bundles assets and collects dependency notices.

Use the tests' temporary stores/local protocol fixtures. Keep real provider credentials and the operational `data/` directory out of tests. UI tests use deterministic DOM/speech stubs; visible workflow changes also need actual browser checks. Consult `verification.md` for the current full-suite baseline and rerun after changes.

Phone typography and layout live in `public/mobile.css`; `public/mobile.js` owns visual viewport sizing, motion/gestures, per-session chat drafts and native haptic requests, and `public/mobile-motion.css` holds the motion CSS it drives (navigation layers, the tab-bar lens, sheet and context-menu motion, press feedback). All three are served directly. Gestures only activate controls the screen already has: the edge swipe commits by clicking the screen's own Back control, and context-menu items carry the same `data-nav`/`data-action` attributes app.js handles. `test/mobile-motion.test.mjs` covers the gesture and transition logic. `app.js` calls its presentation hooks and still owns routing/submission. Test both phone and desktop widths after changing the controller; keep drafts out of persistent browser/server storage, and invalidate pending submission callbacks on sign-out. The native Dynamic Type/haptic bridge is in `apps/apple/Tupies/Views/Web/EngineWebSession.swift`. Browser fixtures do not prove physical iPhone keyboard, safe-area, accessibility or haptic behavior.

Background command and LSP tests launch real local child processes in temporary bot workspaces. The bundled TypeScript server is a pinned runtime dependency; no global compiler or language-server installation is needed for that preset. Commands and custom servers require the Terminal group and exact approval. Both process managers are task-owned, terminate ordinary descendant groups on host loss, and interrupt persisted metadata without replay on restart. See `tool-use.md` for lifecycle, output and protocol limits. Do not reuse production data for process tests.

Use Node 22 explicitly if another Node major is installed in the shell. Avoid debugging native/runtime incompatibility as if it were a provider failure. The container pins Node 22.

## Tupies branding and compatibility

The product and npm package are named **Tupies** (`tupies`). The Apple project and scheme are `apps/apple/Tupies.xcodeproj` and `Tupies`; the app product is `Tupies.app`. `npm run brand:build` derives the web favicon and Apple icons from `assets/brand/tupies-mark.svg`, and runs as part of the full build. Historical design references and exact image-generation prompts retain their original names.

Existing installations keep their stable identifiers: `STUDIO_*` configuration, the `hermes_studio_session` cookie, `hermes-studio://pair` links, engine product `hermes-studio`, cryptographic namespaces, `dev.hermesstudio.app` and its Keychain services, the `hermesStudio` web bridge, `HERMES_STUDIO_LOCAL_ENGINE_FILE`, and `~/Library/Application Support/Hermes Studio/local-engine.json`. The Docker volume remains `hermes-studio-data` so an upgrade continues using its account data. These are compatibility identifiers, not the display name. Existing checkout/service paths need no migration; the sample `docs/tupies.service` uses Tupies paths for new installations. Do not rename a live data directory, installed identity or volume as part of a branding change.

User-visible text never shows these identifiers. Pairing instructions, placeholders and errors in the web UI, engine and Apple app say "pairing link" or "engine link" rather than the URL scheme, and the MCP and LSP clients identify themselves as `Tupies`. The link itself still uses the compatibility scheme. Installed apps and running engines only show the new name after they are updated: an app built before the rename still installs as `Hermes Studio.app`.

Prototype manifests use repository-relative paths and `generated_images/…` provenance references rather than private home-directory paths. Keep the original generation prompt text intact.

## Source and data

`server.mjs`, `lib/`, `public/`, `scripts/`, `test/`, `docs/`, `assets/`, the package lock, notices and agent context files belong to the project. `node_modules/` is installed locally and can be recreated. `data/`, `.env`, `.runtime/` and backups are operational/private and ignored. Never copy them into release archives or agent context files.

Keep tests alongside the behavior they protect. See `architecture.md` for component ownership, `api.md` for requests, and `security.md` before changing authorization, networking, document parsing or process execution.

## Package and deploy

Build and verify first. Releases include source, package/lock, built public assets, fonts, notices and docs. Exclude dependencies, runtime/account data, private files, environment settings, backups and scratch output. A release can install production libraries with `npm ci --omit=dev`; rebuilding source assets needs development dependencies.

`docker compose up --build -d` builds the independent service. The Compose named volume is separate from a native `data/` directory; do not assume it imports the Mac account. Follow `deployment.md` and `operations.md` for ports, TLS, backups and deliberate data migration.
