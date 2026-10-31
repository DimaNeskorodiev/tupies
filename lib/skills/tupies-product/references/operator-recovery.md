# Owner and operator recovery

Read when the issue crosses ordinary bot tools: service startup, source repairs, runtime integrity, engine sync/pairing or native app delivery. This reference does not grant host access, maintenance permission or approval. Complete read-only diagnosis and a concrete repair through available capabilities; reserve actual privileged steps for the responsible owner/operator.

## Establish ownership before changing anything

Determine which engine executes the task, which process/service owns its data directory, whether useful tasks are active, and whether this is a source checkout, isolated release, operational engine, native app or bundled fallback. These are separate artifacts. A source fix does not update a running engine, and the app version alone does not identify served Engine bytes.

There is no generic bot tool for engine-health, provider administration, sync repair, restarting services, approving actions or editing runtime configuration. Do not invent one or reach the internal API with credentials borrowed from a browser. If the owner supplies a repository/workspace, use only the admitted file/command tools there. Repository access is not access to production data or deployment authority.

## Common operator investigations

| Symptom | Evidence / responsible next step |
| --- | --- |
| App cannot connect, server unavailable | Owner checks the selected engine/address and network; operator checks its actual listener/service and redacted startup error. Default engine port is 4310, but local configuration can differ. Never assume the checkout owns the running listener or launch a duplicate scheduler. |
| Model connection works on one engine only | Confirm executing host, endpoint reachability, sync status and home renewal ownership. Local loopback and host dependencies differ. Do not copy raw token bundles or substitute another account. |
| Mac/Home data differs or a skill resource is incomplete | Owner reviews Settings → Devices & sync and waits for a complete verified package; operator checks admitted sync evidence. Workspace replication is not a shared data directory, and security journals/identities cannot be reconstructed by deleting them. |
| Device pairing/TLS error | Verify the intended engine and exact fresh pairing flow with the owner. Preserve existing device identities and certificate pinning. Never share a pairing link in chat, disable trust checks, or reinstall an app to erase the symptom. |
| Notifications missing | Owner checks app notification preferences and OS permission; operator checks home-only delivery, device registration/outbox, and configured APNs environment/topic/credentials without exposing tokens. APNs acceptance does not prove physical delivery, Focus behavior or tap routing. |
| Browser startup fails under a service | Operator checks browser installation and service namespace/task constraints on that engine. Preserve Chromium sandboxing and public-network controls. A tool error is not authority to weaken service isolation. |
| Missing vault key/state or credential-decryption failure | Preserve the entire current runtime and recover the matching complete protected backup. Never generate a new key over old state, blank state, or delete collections to make startup succeed. |
| Password/sign-in recovery needed | Use the documented operator-controlled offline recovery procedure. Do not invent a public reset endpoint, print password hashes, or wipe the workspace. |

Read-only service inspection can be delegated to an authorized operator; stop, restart, deploy, restore and native changes remain concrete separate actions within the owner's actual authorization. Do not recommend unrelated macOS profiles, Keychain resets or device relinking for a web/Engine bug.

## Safe maintenance shape

1. Identify the actual source/release/process and data ownership. Check active work before maintenance; preserve useful progress instead of forcing idle by cancelling it.
2. Before a restart, move or restore, the operator stops the single writer and creates a complete private stopped backup. Preserve state, vault key, sync identity/security journal, skills, workspaces, retained browser profiles, process homes, notifications metadata and all other runtime files together. File placement can vary by release: use its actual runtime inventory, not a handpicked subset. A backup with its vault key needs independent protection/encryption.
3. Validate recovery in a fresh offline directory without provider network access or schedulers. Never run production and a restored copy as two schedulers against outside services, point two engines at one directory, or restore one identity onto another running engine.
4. Apply only the reviewed repair/update, preserving original identities, account state, pairings and configuration. Inspect uncertain external effects before any retry. Verify exact served/runtime files and preserved data; retain a usable rollback source and protected backup.
5. Recheck the owner's original operation. Report source tests, isolated release checks, actual deployment and physical-device acceptance separately.

When the repository is actually available, `docs/operations.md` documents the offline `scripts/runtime-backup.mjs create/verify/restore` tool. It takes explicit absolute paths, does not read `.env`, does not start the Engine and refuses an existing destination. These are operator commands, not tools automatically offered to a bot. Do not invent a runtime path or paste real credentials/state into a report.

## Source-level repair when the owner requested it

Read the checkout's `AGENTS.md`, `PROJECT_CONTEXT.md` and `docs/development.md` before substantial edits. Use its existing changes and ownership rules. Current Tupies uses native Node ES modules, Node 22.16+ with Node 22 as the verified baseline, a Node HTTP server and vanilla browser code. Resolve application paths from module locations. No host Hermes or Codex install is required for the core Engine.

Useful documentation routes, only when those files are present:

| Area | Repository evidence |
| --- | --- |
| Run/recovery/permissions and tools | `lib/engine.mjs`, `lib/agent-tools.mjs`, `lib/setup-tools.mjs`; `docs/security.md`, `docs/tool-use.md`, `docs/routines.md` |
| Models, OAuth and credentialed requests | `lib/providers.mjs`, `lib/oauth.mjs`, `lib/provider-net.mjs`; `docs/hermes-setup.md` |
| Skills and package integrity | `lib/skills.mjs`, `lib/skill-catalog.mjs`, `lib/skill-import.mjs`; `docs/skills.md` |
| Files/documents/browser | `lib/documents.mjs`, `lib/browser.mjs`, `lib/browser-control.mjs`, `lib/browser-files.mjs`; `docs/rich-chat.md`, `docs/browser.md` |
| Store/sync/device/native/push | `lib/store.mjs`, `lib/sync/`, `lib/notifications.mjs`, `lib/apns.mjs`, `apps/apple/`; `docs/operations.md`, `docs/sync.md`, `docs/notifications.md`, `apps/apple/README.md` |

Use temporary deterministic stores for reproduction; never real runtime data, provider secrets, transcripts or account connections. Approved terminal/scripts use host-account permissions and are not an OS sandbox. Keep auth, exact approval identities, SSRF/private-path rules, output sanitization and Stop semantics intact.

Run the checkout's appropriate checks through approved commands. Provider/tool/persistence/authorization/lifecycle changes require its full suite; visible UI changes require actual disposable browser checks. Rebuild generated `public/vendor/` and `public/guide-content.js` from source rather than editing bundles. Update relevant docs/context/roadmap when behavior changes. Do not claim deployment, live-provider quality or physical-device success from source tests. A release archive excludes runtime data, `.env`, backups and `node_modules`; ship source, built assets/fonts and notices.
