# Development and project handoff

Saved action review is implemented in `lib/action-review.mjs` and the central `NativeEngine.approve` path. Test with `node --test test/action-review.test.mjs test/pearl-ui.test.mjs test/setup-tools.test.mjs`, then `test/browser-actions.test.mjs` separately and the complete release test runner. Keep both policy snapshots, exact browser identities, denied-call replay protection and Stop/resource barriers. Test only disposable workspaces; a source edit does not change the operational Engine.


## Engine candidate verification

Maintainers can plan and explicitly run exported Engine candidates with `scripts/verify-engine-candidate.mjs`, a separately prepared pinned Docker image and a new local receipt. This is operator-only; no Engine tool gains Docker access. See [Tool workshop](tool-workshop.md#operator-container-verification-source-only) for clean-image preparation, exact CLI flags, isolation policy and the real-container CI acceptance procedure. Do not build the image from live data or treat protocol-fixture success as Linux/container validation.

## Workshop development and contribution intake

Engine candidates live in `lib/engine-workshop.mjs`; `engine-candidate-checks.mjs` owns fixed syntax parsing and worker lifecycle, and `engine-candidate-worker.mjs` owns the in-memory-only QuickJS loader. `engine_workshop` is separately owner-only. Never import/evaluate candidate modules in Node, inherit `NODE_OPTIONS` into syntax parsing, resolve guest imports from disk or apply patches to the installed tree. Preserve before/after base checks and visible evidence limits. `test/engine-workshop.test.mjs` covers disposable patch applicability, isolation, stale sources, revocation, Stop and maintainer rechecks; Engine/API/browser regressions cover admission and review/export. Full Engine suites still need normal reviewed development/release execution.

`lib/workshop-grants.mjs` owns bounded-read authority and its local ledger. Never place grants in workspace manifests, synced state documents, checkpoint snapshots or model arguments. `workshop_poll_api` is routed by Engine; direct AgentTools calls cannot supply authority. Its owner controls use the current approval identity, finite limits and explicit participants. Tests cover concurrent reservation, restart, pending activation, denial aliases and receipt-write failure. Revalidate the full suite and actual approval/Workshop browser flows after changes.

The stage-2 gateway lives in `lib/workshop-gateway.mjs`; `test/workshop-gateway.test.mjs` uses disposable localhost APIs and `test/workshop-engine.test.mjs` covers exact approval/denial/Stop. It composes the existing credentialed integration transport with a pure guest; keep request dispatch out of guest callbacks and never classify it as an automatically retryable read.

See [Tool workshop](tool-workshop.md) for runtime boundaries and `scripts/review-contribution.mjs`. Run focused `node --test test/workshop*.test.mjs`, then the full suite for Engine/tool/security changes. Ship `assets/tool-catalog/`, the pinned QuickJS dependencies/lock and dependency notices. Build/install/proposals remain engine-local; do not use real runtime data for fixtures. Native packaging includes catalog JSON but a source change does not update installed apps.


## Coordinating an Apple release with its engines

Mac/VPS update source, bootstrap, signed publication and recovery are documented in [Automatic updates](updates.md). `scripts/verify-release-tests.mjs` runs every regression with existing timing-sensitive groups isolated. Publishing source does not enable an operational updater.

For a standalone Mac installer, use the [Mac distribution runbook](macos-release.md) and `scripts/release-macos.mjs`. Installation on a new Mac, Developer ID/Keychain provisioning and notarization are distinct from updating an existing development installation.

A native build number does not identify the selected engine or the Mac bundled fallback. Pin one GitHub commit in an isolated checkout, record each engine source root/commit and the app build/fallback commit, run verification, then update the idle engines with complete protected stopped backups and install signed apps in place. Keep existing identities, Keychain groups and profiles. Pass an explicitly increasing `CURRENT_PROJECT_VERSION` to both native targets and the extension; do not reset installed builds to a stale repository default. The 30 October checkpoint is GitHub `02aaf2e` with signed Mac/iPhone build 10. Update the mutable handoff after deployment without editing an immutable release. Existing local unfinished work is not a release source.

Start with `AGENTS.md` and `PROJECT_CONTEXT.md` at the repository root. `CLAUDE.md` points Claude Code to the same instructions. Keep portable documentation relative to the checkout.

## Mission development


`lib/mission-effort.mjs` owns versioned Low/Medium/High/Ultra policies. All inference/tool reservations and delegation scheduling must share the existing Mission ledger, preserve cumulative usage across retries/promotion/resume, and leave model reasoning/capability snapshots intact. Inferred admission uses the existing QuestionManager with an Engine-owned exact choice; no Mission exists until the authenticated owner answers. Mechanical milestone refresh and bounded independent rubric review update verified progress before final acceptance; retain contract/evidence digests and the separate100% gate. Focused cases live in `mission-effort`, `mission-resource-runtime`, `missions-engine`, `missions-ui` and `missions-notifications`. Use a disposable synthetic provider for budget exhaustion/upgrade and33→66→100 browser checks; real-model allowance calibration remains separate.

Research efficiency uses `lib/task-context.mjs` for model-only earlier-tool projection and snapshotted run history policy, and `work_records_read` in `lib/work-quality.mjs` for exact retained-observation paging. Preserve current task pairs, existing compaction handoffs, Maximum opt-out, legacy continuation behavior and bot/Telegram visibility. Missing/shortened history cannot become current proof or authorize action replay. `missionResponsePacket` in `mission-evidence.mjs` bounds exact cited-source evidence; identical rubric text is reviewed once and incomplete/unchanged failed input must stop author retries without accepting the result. `task-context`, `mission-response-packet`, `missions-engine` and `work-quality-outcomes` regressions supplement the unchanged summary/8K tests. Tests use physical locked dependencies in the checkout because document-worker filesystem permissions correctly reject an external dependency symlink.

`lib/mission-intent.mjs` owns conservative first-step recognition guidance, its tool schema and structural/source admission checks. An inferred `clear_goal` proposal requires at least three substantive dependent outcomes and a separate durable-process requirement quoted from the current owner message, then an authenticated owner choice of effort; ordinary search/comparison/recommendation tasks stay chat. Keep missing-evidence refusal recoverable in the same chat, explicit owner controls available, and saved admission evidence separate from execution authority. Cover mistaken model calls, unanswered/declined proposals and successful promotion with `mission-intent` and `missions-engine` regressions; fixture labels alone do not measure real-model classification quality.

Mission A–D plus independent G source ownership is in `lib/missions.mjs` (controller/admission), `mission-contract.mjs`, `mission-evidence.mjs`, `mission-verifier.mjs`, `mission-presentation.mjs`, `mission-attention.mjs` and `mission-api.mjs`; UI is `public/missions.js` + `.css`. Shared resource admission is in `mission-resources.mjs`/`mission-resource-runtime.mjs`; startup trusted pricing in `mission-pricing.mjs`; typed waits/family checkpoint safety in `mission-waits.mjs`; reusable inert observations in `mission-learning.mjs`. `eval/missions-runner.mjs` writes a deterministic labelled report and explicitly separates unmeasured real-model/human quality. The e2e fixture also supports **E2E Mission timer**, **E2E Mission pause** and **E2E Mission watch** through normal Engine tools. Never use operational data or paid inference for these fixtures. Use `node --test test/mission-*.test.mjs test/missions-*.test.mjs`, then the complete suite for persistence/lifecycle/auth changes. `scripts/e2e-fixture.mjs` includes **E2E Mission document**: real disposable Engine, real DOCX, exact saved download and deterministic independent reviewer. It measures machinery, not real-model quality. Check owner questions/approval/Stop, source-bound recognition, same-run promotion, safe restart, exact immutable downloads and read-only remote projections. See [Missions](missions.md). The full unchanged-source receipt isolates `browser-actions`, `browser-control`, `lsp`, `questions-history`, `team` and the18 new `missions-durable` cases sequentially, then runs every other `test/*.test.mjs` file at concurrency4. This preserves existing timing budgets and assertions; no tests are skipped. Chrome startup isolation addresses measured competing fixture load, not a product timeout extension.

## Desktop actions

Mac desktop support is in `lib/desktop.mjs`, `desktop-driver.mjs`, `desktop-tools.mjs` and `desktop-api.mjs`, with setup in `public/desktop.js` + `.css`. Follow [Desktop on this Mac](desktop.md). Run `node --test test/desktop*.test.mjs`, the existing coding/browser/security suites and the complete release test runner. Tests use disposable data and fake app state; real native-driver acceptance is separate. Never test by sending messages into existing owner conversations or enabling production bot tools implicitly.

## Run locally

Use Node 22 (at least 22.16).

Release validation and the standalone Mac payload use the patched **22.23.4** runtime; the container pins its official multi-platform image digest. Older compatible Node 22 versions are not the current release security baseline. Revalidate a runtime update against the complete suite and retain its official archive hash/license. From the project root:

```sh
npm ci
cp .env.example .env
npm start
```

Skip the copy when `.env` already exists; do not overwrite the owner's local configuration. `npm start` and `npm run dev` load `.env` when present. With no override the app uses `127.0.0.1:4310` and `data/`. Check the terminal for the actual address. The relocated Mac workspace already has data and a local config using 4311; do not bootstrap or reset it. See `local-workspace.md` if present.

First run against an empty data directory prints a bootstrap token for choosing the workspace password. Existing state uses the existing workspace password. Provider keys/account tokens are configured in Tupies, never in source or documentation.

Only one process may own a data directory; a second engine refuses to start while the first one's `control.sock` answers. `npm run pair` (add `-- --engine` for an engine link) asks the running engine for a pairing link through that socket. Check active tasks before stopping a development instance. A restart invalidates browser sessions and interrupts unfinished work without replaying actions.

For owner-operated headless linking, `node scripts/link-engine.mjs connect --confirm` reads one exact trusted engine link from stdin. `node scripts/link-engine.mjs disconnect --confirm` deliberately unlinks the engine and suspends copied automation/subscription ownership. Both use the same private same-user socket and normal sync methods as the UI, including idle checks, protocol validation and TLS pinning. Set the existing absolute `STUDIO_DATA_DIR`; never put a pairing secret in command arguments or shell history. The command prints only confirmation, never the link or credentials. An uncertain response requires inspecting connection status before retrying.

## Change and verify

```sh
npm run dev
npm run build
npm run check
npm test
```

`npm run eval:agent -- --mode fixture --repeat 3` runs the eight-family agent evaluation on disposable data. See [evaluation](evaluation.md) for explicit live-provider execution, budgets, source identities and the limits of scripted fixtures. Evaluations never use operational data as their execution directory. The optional, explicitly authorized ChatGPT subscription reader obtains a short-lived access grant read-only from the running home engine; that engine alone retains renewal ownership.

`npm run verify:runtime -- --state-mib 22 --batches 3 --output output/runtime-verification/report.json` runs disposable large-state, crash and recovery verification. `npm run runtime:backup -- create --source STOPPED_RUNTIME --target NEW_SNAPSHOT` creates a complete offline snapshot. See [operations](operations.md) for verification and restore commands, private storage and the required stopped-engine checks.

`npm run eval:retrieval` measures the actual fact, note and scoped-history rankers against 12 versioned public fixture queries without a model, network or operational data. Its labels await human review; candidate retrieval scores do not establish answer quality.

`npm run eval:assimilation -- --k 4 --output output/eval/assimilation-report.json` exercises source-only native study/publication/retrieval against 13 public synthetic materials and controlled provider recipes. It uses a disposable store and no account/network; human/real-model usefulness is unmeasured, and the recorded unmapped Ukrainian miss remains visible. See [evaluation](evaluation.md#specialist-knowledge-assimilation).

The dev command watches the server. Reload the browser after changes. Rebuild after modifying `public/rich-content.mjs`, `public/speech.mjs`, vendor inputs or dependency versions. `public/app.js`, `public/creature-avatars.js` and CSS are served directly. The pearl theme is scoped by `body.pearl-studio` in `public/pearl.css`, loaded after component/phone styles; the default document explicitly selects the requested light appearance. `public/rich-chat.css` loads after shell themes and owns the shared rich-reply/table/code palette, including phone/system dark and explicit host appearances. `public/mobile.js` remains the viewport/draft/gesture controller.

For a disposable full-stack browser/native walkthrough, run `node scripts/e2e-fixture.mjs`. It creates a new OS temporary store, disables scheduling and supplies a deterministic local model provider; the printed password is synthetic. It never loads `.env` or accepts a real data-directory argument. Stop with Ctrl-C to close the engine/provider and remove the temporary store. Scenario prompts and local outage/lost-acknowledgement controls are documented in the [readiness audit](plans/production-readiness-audit-20261028.md). This checks application mechanics, not real-model quality. Apple logic/transport/build commands are in `apps/apple/README.md`.

Cushion companions use transparent local assets in `public/assets/companions/`. Dedicated portraits are the default for working UI; full-body mascots are requested only by single-bot welcomes/profile heroes. The 24-entry source catalog is `assets/companions/catalog.json`; the builder generates `public/companion-catalog.js`, which must load before the renderer. The twenty new 2×2 pose sheets retain their original alpha and exact prompts under `expansion-a/` and `expansion-b/`. The pipeline registers poses to a shared scale/foot baseline and derives compact portraits without recoloring or color-keying. Sources, alpha/layout metadata and exact generation prompts are in `assets/companions/`. `npm run avatars:build` runs both `scripts/build-roki-assets.mjs` (historical previews) and `scripts/build-companion-assets.mjs`, and is included in `npm run build`. The companion builder exports 32/64/128/256/512px WebP pose frames, 512px idle PNGs for new characters, the original four PNG/WebP sets, portable 256px animated WebPs, and catalog/registration manifests. Never hand-edit exports. `node scripts/build-companion-assets.mjs --only=cloud,tangerine` rebuilds a bounded subset during asset work; the normal command requires the complete catalog. Shared visibility observers pause offscreen animation; CSS handles body motion, pose layers, paused state and Reduce Motion. `/companions-preview.html` uses the production renderer; `/roki-preview.html` remains historical. Ship referenced local images; no runtime image service or CDN is required. `npm run docs:build` rebuilds the browser guide. `npm run build` also bundles assets and collects dependency notices.

Use the tests' temporary stores/local protocol fixtures. Keep real provider credentials and the operational `data/` directory out of tests. UI tests use deterministic DOM/speech stubs; visible workflow changes also need actual browser checks. Consult `verification.md` for the current full-suite baseline and rerun after changes.

Skills changes use the shared native installer in `lib/skills.mjs`, the bundled original catalog in `lib/skill-catalog.mjs` and bounded portable readers in `lib/skill-import.mjs`. The native Tupies product guide is maintained as four portable Markdown files in `lib/skills/tupies-product/`, loaded from an explicit module-relative file list in `lib/skill-tupies-catalog.mjs`; update its catalog metadata and native source-staging coverage together when resources change. Add exact package bytes/resources and conservative requirements to catalog entries; do not invoke foreign package-manager CLIs or setup hooks. Run the full suite for installer, permission, persistence or sync-boundary changes, including `skills-catalog`, `skill-import`, `skills-engine` and `skills-api-security` regressions, then verify Catalog/Installed/import in the disposable browser fixture. See [skills](skills.md).

Phone typography and layout live in `public/mobile.css`; `public/mobile.js` owns visual viewport sizing, motion/gestures, per-session chat drafts and native haptic requests, and `public/mobile-motion.css` holds the motion CSS it drives (navigation layers, the tab-bar lens, sheet and context-menu motion, press feedback). All three are served directly. Gestures only activate controls the screen already has: the edge swipe commits by clicking the screen's own Back control, and context-menu items carry the same `data-nav`/`data-action` attributes app.js handles. `test/mobile-motion.test.mjs` covers the gesture and transition logic. `app.js` calls its presentation hooks and still owns routing/submission. Test both phone and desktop widths after changing the controller; keep drafts out of persistent browser/server storage, and invalidate pending submission callbacks on sign-out. The native Dynamic Type/haptic bridge is in `apps/apple/Tupies/Views/Web/EngineWebSession.swift`. Browser fixtures do not prove physical iPhone keyboard, safe-area, accessibility or haptic behavior.

Background command and LSP tests launch real local child processes in temporary bot workspaces. The bundled TypeScript server is a pinned runtime dependency; no global compiler or language-server installation is needed for that preset. Commands and custom servers require the Terminal group and exact approval. Both process managers are task-owned, terminate ordinary descendant groups on host loss, and interrupt persisted metadata without replay on restart. See `tool-use.md` for lifecycle, output and protocol limits. Do not reuse production data for process tests.

Workspace layout and reusable programs live in `lib/workspace-layout.mjs` and `lib/scripts.mjs`, with Files/Scripts UI in `public/bot-profile.js`. Focused regressions are `workspace-layout`, `scripts`, `scripts-engine`, `scripts-api`, `bot-profile` and `routine-workflow`; permission, process, API and lifecycle changes also require the complete suite. The catalog is untrusted synced workspace data; opaque approval identities and private source staging remain engine-local. Do not add automatic dependency installation or execution grants to a manifest. See [Workspaces and scripts](workspaces.md).

Use Node 22 explicitly if another Node major is installed in the shell. Avoid debugging native/runtime incompatibility as if it were a provider failure. The container pins Node 22.

## Tupies branding and compatibility

The product and npm package are named **Tupies** (`tupies`). The Apple project and scheme are `apps/apple/Tupies.xcodeproj` and `Tupies`; the app product is `Tupies.app`. `npm run brand:build` derives all web/native brand assets from the transparent cream mascot master `assets/brand/tupies-avatar.png`, and runs as part of the full build. It exports transparent web logos, compact face favicons, the Apple touch icon, three icon background variants, opaque iOS/transparent-margin macOS app icons and the native `TupiesAvatar` imageset. Graphite is the default icon background; Pearl and Sky are alternatives. See [brand sources and exact generation prompt](../assets/brand/README.md). `TUPIES_BUILD_WEB_ONLY=1` skips Apple assets. Historical design references and exact image-generation prompts retain their original names.

The owner requested migration of the native bundle identifier from `dev.hermesstudio.app` to `dev.tupies.app`. Preserve pairings through an explicit, verified Keychain/preferences migration; changing the identifier alone creates a different app. Keep the original installation and data until the new app proves access to the existing device keys. See `apps/apple/README.md` for the migration's current implementation and verification status.

Engine compatibility identifiers remain stable: `STUDIO_*` configuration, the `hermes_studio_session` cookie, `hermes-studio://pair` links, engine product `hermes-studio`, cryptographic namespaces, the `hermesStudio` web bridge, `HERMES_STUDIO_LOCAL_ENGINE_FILE`, and `~/Library/Application Support/Hermes Studio/local-engine.json`. The Docker volume remains `hermes-studio-data` so an upgrade continues using its account data. Existing checkout/service paths need no migration; the sample `docs/tupies.service` uses Tupies paths for new installations. Do not rename a live data directory, engine identity or volume as part of native app migration.

User-visible text never shows these identifiers. Pairing instructions, placeholders and errors in the web UI, engine and Apple app say "pairing link" or "engine link" rather than the URL scheme, and the MCP and LSP clients identify themselves as `Tupies`. The link itself still uses the compatibility scheme. Installed apps and running engines only show the new name after they are updated: an app built before the rename still installs as `Hermes Studio.app`.

Prototype manifests use repository-relative paths and `generated_images/…` provenance references rather than private home-directory paths. Keep the original generation prompt text intact.

## Source and data

`server.mjs`, `lib/`, `public/`, `scripts/`, `eval/`, `test/`, `docs/`, `assets/`, the package lock, notices and agent context files belong to the project. `node_modules/` is installed locally and can be recreated. `data/`, `.env`, `.runtime/` and backups are operational/private and ignored. Never copy them into release archives or agent context files.

Keep tests alongside the behavior they protect. See `architecture.md` for component ownership, `api.md` for requests, and `security.md` before changing authorization, networking, document parsing or process execution.

## Package and deploy

Build and verify first. Releases include source, package/lock, built public assets, fonts, notices and docs. Exclude dependencies, runtime/account data, private files, environment settings, backups and scratch output. A release can install production libraries with `npm ci --omit=dev`; rebuilding source assets needs development dependencies.

`docker compose up --build -d` builds the independent service. The container uses `TUPIES_BUILD_WEB_ONLY=1` for its asset build, so a web engine does not need the Apple icon directory; native signing/build outputs and private development state stay outside its build context. The Compose named volume is separate from a native `data/` directory; do not assume it imports the Mac account. Follow `deployment.md` and `operations.md` for ports, TLS, backups and deliberate data migration.

## Local coding verification

Use `node --test test/coding-*.test.mjs test/local-coding*.test.mjs test/azure-devops.test.mjs` for focused deterministic acceptance, then the complete suite. The optional `TUPIES_CLAUDE_ACCEPTANCE` absolute executable path enables installed-Claude tests against a local fake Anthropic endpoint inside an OS network sandbox; no real accounts or inference are used. Source implementation, isolated release checks and live account/task acceptance must be reported separately. See [local coding](local-coding.md).

## Onboarding

New-workspace defaults, Ops’ bundled product guide and the resumable setup UI are described in [Onboarding](onboarding.md). Use `node scripts/e2e-fixture.mjs --onboarding` for an empty-model setup walkthrough; the printed synthetic endpoint uses the OpenAI Responses protocol. `test/onboarding.test.mjs` covers authentication, persistence, existing-workspace preservation, real reply completion, template editing and draft-only prompts. Keep native engine startup and pairing on their existing path.

## Chat learning and save receipts

`lib/skill-review.mjs` owns the bounded final ordinary-chat skill review; `lib/learning-changes.mjs` records verified save presentation metadata. `public/chat-learning.js` and `.css` render linked cards with finite, reduced-motion-aware animation. Keep the review on the normal inference/admission/tool/approval path, and never infer a save from model prose. `test/skill-review.test.mjs` covers actual files, policy, evidence, duplicate/lifecycle boundaries and provider failures; `test/chat-learning.test.mjs` covers safe labels, links and animation replay. Run the complete suite for Engine changes. `node scripts/e2e-fixture.mjs --learning` plus **E2E learning** exercises real Brain/Memory writes and automatic creation against the deterministic local provider. No production data or paid provider is used.

## Automatic action risk review

`lib/action-risk-review.mjs` adds one bounded independent inference for supported actions outside the automatic fast path. Use `node --test test/action-review.test.mjs test/action-risk-review.test.mjs test/browser-actions.test.mjs test/desktop-engine.test.mjs`, then `node scripts/verify-release-tests.mjs` for authorization/lifecycle changes. Fixtures use synthetic providers, temporary stores and actual disposable Chrome; they measure execution mechanics, not real-model risk classification. `node scripts/e2e-fixture.mjs --action-review` enables Terminal and automatic mode only on its disposable first bot; send **E2E automatic command** to verify the real local provider protocol, automatic review, command result and UI. Never enable production tools or use real credentials for this fixture.
