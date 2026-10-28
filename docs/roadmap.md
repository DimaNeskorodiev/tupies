# Product roadmap

This is intended future scope, not a list of shipped features. Consult `capabilities.md` and `verification.md` for what actually exists.

The product was renamed **Tupies** on 28 October 2026. Current source, package metadata and the Apple project use the new name; existing installation identities remain compatible. Deploying the renamed source and distributing signed Tupies apps remain separate release work.

The owner approved the reordered sequence in the [plan review](plans/studio-best-of-openbot-grok-review.md) on 27 October 2026: 1 ask and recall (shipped to both engines on 27 October 2026), 2 image understanding (shipped to both engines on 27 October 2026), 3 reliable sends and routines and 4 read-only browser (both shipped to both engines on 28 October 2026), 5 reviewed learning (shipped to both engines on 28 October 2026), 6 durable waits only after the owner's decisions, 7 Mac app packaging. The original [OpenBot and Grok Bot improvement plan](plans/studio-best-of-openbot-grok.md) proposes a dependency-aware sequence across the items below: validate/deploy completed context work; questions/history retrieval; reliable submissions and storage; durable tasks; browser/vision; resource-aware collaboration/routines; explicit device capabilities and reviewed shared learning; packaged setup and attention. It preserves Tupies's independent engine and existing permission/sync contracts. Competitor findings are in [research](research.md); the sequence is a proposal, not implementation or deployment evidence.

## Reliability and everyday use

- **Bot context, next stages** (see `docs/context.md`). Releases A–C shipped to the Mac and the home server together on 27 October 2026 (window-based limits, compaction order and a stable prompt; lanes and room watermarks; summary compaction with Summarize/New topic controls). Next: watch real long chats, summary quality and cache hits.
  - Shipped on 27 October 2026 (Phase 1, both engines): `session_search` and `session_read` over a bot's stored conversations.
  - Shipped on 28 October 2026 (Phase 5, both engines): reviewed learning. Bots suggest memory and skill changes for the owner to accept or decline, with an optional daily review routine.
  - Later: server-side compaction where providers support it, and a summary prepared ahead.
- Continue manual end-to-end verification of onboarding, provider/model access, tools, approvals, documents, collaboration and voice across real supported browsers.
- Improve the gaps found in real tasks, with clear progress/errors, recoverable partial work and accurate documentation.
- Review the implemented **pearl + cushion companions** direction in real daily use on Mac and iPhone: larger distinct portraits, the 24-companion catalog with the new twenty animated pose sets, thin regular typography, floating glass, readable contrast and compact everyday controls. Check physical-device keyboard/safe areas, VoiceOver, reduced motion/transparency and the visual treatment during real approvals/questions/long outputs. Technical controls remain under progressive disclosure. The current iteration is in local source; coordinate engine deployment separately and preserve all account data. Historical Roki and avatar studies are references, not the current required identity.
- Refine the selected adaptive activity flow through real chat and room tasks on the web, macOS and iOS: inspectable moving actions, sources and recorded results; transparent morphing research, analysis, visible-plan and teammate layouts; compact streaming, keyboard/touch access and reduced motion. The production adapter uses actual run events and bounded result previews. Preserve provenance and explicit preview limits as more tool shapes are supported; never substitute illustrative data or private reasoning for observed work.
- Keep [Thinking Motion Lab](../prototypes/thinking-motion-lab.html), [Living Activity](../prototypes/thinking-data-flow.html), the earlier [168px Constellation](../prototypes/constellation-focused-v1.html) and the selected [Adaptive Agent Flow study](../prototypes/constellation-focused.html) as design references. Their recorded weather, verified budget and illustrative plans/team exchanges remain prototype fixtures rather than production telemetry.
- Build on the shipped private-workspace search/edit tools, bounded parallel reads, task plans, output paging, managed background commands and language-server intelligence. Expand coding workflows through richer checkpoints, additional verified language-server presets and diagnostics after edits. Evaluate persistent cross-task services separately from current task-owned commands, with explicit lifecycle, resource and permission boundaries.
- Complete two-level memory on top of the shipped notes tools, pinned facts and automatic recall: save a summary to the daily note before older turns are omitted and after each task; add a "Second brain" bot template. (An opt-in daily review that suggests core-memory and skill updates for the owner's review shipped in Phase 5; linking and deduplicating notes is still open.) (The notes view shipped in the bot profile's Brain tab.) Optional provider embeddings for ranking remain a later, explicit choice.
- Questions from bots (`ask_user`) are wired into the engine with a question card in chat (shipped to both engines on 27 October 2026). Next: typed forms on the same control, and a separate credential-entry path that keeps secrets out of model context.
- Extend provider reasoning capabilities through verified adapter support, not guessed model names or unsupported request fields.
- Image understanding for attached images shipped to both engines on 27 October 2026 (Phase 2). Next: let a bot open a workspace image mid-task (needed for browser screenshots in Phase 4), OCR for scanned PDFs, and richer document workflows within the same provider capability and privacy boundaries.
- Build on shipped OpenRouter dictation, model/voice selectors and comparison previews. Verify paid-provider voice quality and microphone accuracy across target languages; assess continuous voice separately, with explicit account/cost/privacy setup.
- Expand messaging platforms and third-party authorization using the same tool permission and credential-destination boundaries.

## Engines, sync and native apps

Shipped in 0.5: home-server sync between engines, device pairing with P-256 keys, short-lived device sessions, revocation, paired-apps-only sign-in from the internet with proxy-aware limits, shell pairing (`npm run pair`), HTTPS with the engine's own certificate pinned through the pairing QR code (no domain needed), and the Apple app shell in `apps/apple/`. Next:

- Tell TLS failures apart from an unreachable engine in the Apple app: today `-1200` reads as "Can't reach …", which hid the ATS problem found on the first physical iPhone.
- Sign, notarize and distribute the Mac app; bundle a Node runtime so it can run the local engine without a separate install; TestFlight for iPhone.
- Replace web-view screens with native SwiftUI where it clearly helps (chat list, composer, notifications), keeping the engine API as the contract. The phone layout already follows iOS (tab bar, navigation bar, bot switcher, pull-down menus, bottom sheets; shipped 27 October 2026). A further refinement was installed as native build 2 on the iPhone 15 Pro and deployed with image understanding to both engines on 27 October 2026: system typography/Dynamic Type, readable chat and forms, larger controls, route motion, edge Back, grabber-driven sheet dismissal, keyboard viewport handling, session-scoped drafts and native haptics. Next: check keyboard transitions, VoiceOver, accessibility text sizes and haptic feel on the physical iPhone; then consider narrow rows for Team rooms and Routines.
- iPhone polish to Apple standards, deployed on 28 October 2026 with the full Tupies release; iPhone build 3 and `Tupies.app` are installed. It covers Liquid Glass native screens, a seamless launch and reveal, interactive edge-swipe Back with parallax, sheet physics with unsaved-input protection, long-press context menus, a gliding tab lens, large-title collapse, an iOS type ramp, inset grouped lists and full phone dark mode. Next: verify haptics, the keyboard, VoiceOver and 120Hz motion by hand on the iPhone. Still open: sheet detents and the iOS 26 tab-bar shrink on scroll.
- Native iPhone notifications for bot/room replies and routine outcomes are implemented in source with private generic APNs payloads and per-kind opt-in. Activation is pending Apple Developer/Xcode sign-in, an app-scoped APNs key, push-enabled provisioning, a signed iPhone update and real background-delivery verification; the owner deferred Apple setup. Approvals/interactive questions, unread badges and Mac notifications remain future scope. See [iPhone notifications](notifications.md).
- Mirror live run progress to other engines; merge a bot's model history by run instead of last-writer-wins; tombstone garbage collection.
- Optional end-to-end encryption of the app API itself (not only engine-to-engine sync) for relays that terminate TLS.
- Scoped device capabilities (for example read-only devices) and per-device audit records before enabling computer/device actions.
- Engine pairing key exchange: mix an ECDH secret from both identity keys into the workspace-key wrapping (negotiated, so older engines keep linking) so that a passive observer of the pairing request cannot unwrap the sync key. Found in the 27 October 2026 security review.
- Bind device sign-in signatures to the target engine (a v2 session message naming the engine's node id, in the engine and the Apple app), so one captured request cannot be replayed on another linked engine.
- Rotate the sync workspace key when an engine is revoked, and mark the replica's engine record inactive on the hub when it disconnects.
- Make the Apple app require the pinned key on first contact when a pairing link says `tls=engine`, as linking engines now do.

## Device actions

- Retain Tupies Engine as the independent core and formalize a versioned client API.
- Integrate OS permissions and declared Mac/iOS actions through a separate device worker. Model text cannot grant itself device access.
- Design screen capture/streaming and action review as explicit capabilities; do not expose general remote shell access as a substitute for a device protocol.

## Operational maturity

- Move transcripts and conversations out of the single `state.json` (per-bot files or an append-only log), so a commit no longer rewrites and rescans the whole history; trim or archive very old conversation turns; replicate a bot's conversation by turn rather than as one document. Measured on synthetic data: a 22 MB state still costs about 18 ms per commit and 34 ms per sync scan.
- Skip the workspace file walk on sync scans when file watchers report no change (keeping the periodic full walk), and load the 6 MB rich-content bundle lazily.
- Give approved processes a Tupies-owned `HOME` outside the model-writable workspace (with `PYTHONNOUSERSITE` and `GIT_CONFIG_NOSYSTEM`), and decide whether tool credential files in workspaces should sync. This changes where tools keep their state across runs, so it needs an owner decision.
- Optional approval or per-bot domain allowlist for `http_fetch`, which can currently send model-chosen data to public URLs without approval.
- Detect container publishing that hides client addresses (Docker userland proxy, rootless port driver, Docker Desktop) and warn in **Settings › Devices & sync** when the engine faces the internet.

- Assess stronger process isolation for untrusted workloads independently of current document limits and trusted approved scripts.
- Add multiuser authentication/authorization and distributed persistence/scheduling only when product scope requires them. Current state has one owner and one process per data directory.
- Improve backup/restore and migration ergonomics while keeping encryption keys and private files protected.
- Perform broader deployment, dependency and security review before treating the app as a public hosted service. Commercial subscription-provider onboarding remains a separate operator responsibility.

Prioritize coherent, tested user workflows. Preserve bots-first navigation, simple setup, skill compatibility and the glass visual direction as capabilities grow.
