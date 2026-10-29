# Engines, devices and sync · 0.5.0

Tupies can run on your Mac and on a server at the same time, with the same bots, chats, memory and settings on both. Paired iPhone and Mac apps sign in with device keys and can switch between engines with one click. This page describes how that works, what it protects against and what it does not do.

## The shape of it

```
            iPhone app ─────┐            ┌───── Mac app (This Mac ⇄ Home server)
                            ▼            ▼
   ┌──────────────────────────┐  sealed sync   ┌──────────────────────────┐
   │ Home server (VPS) · hub  │◀──────────────▶│ Tupies on your Mac       │
   │ always on; routines,     │  push + long-  │ full local engine; works │
   │ Telegram, ChatGPT renewal│  poll, ~1 s    │ offline, catches up later│
   └──────────────────────────┘                └──────────────────────────┘
```

- **Home server (hub).** The always-on engine, usually your VPS. Other engines sync through it. It is the only engine that runs routines and messaging channels, and the only one that renews ChatGPT subscription tokens.
- **Linked engine (replica).** A complete Tupies engine with its own copy of the workspace, such as the one on your Mac. It runs tasks locally, keeps working offline and pushes its changes when it reconnects.
- **Apps.** The [Apple app](../apps/apple/README.md) and browsers are clients. An app paired once with the home server can sign in to every linked engine.

An engine with no links is **standalone** and behaves exactly as before 0.5.

## Set it up

1. Run Tupies on the server and give it an HTTPS address (see [Reaching your engines](#reaching-your-engines)). Set `STUDIO_PUBLIC_URL` to it.
2. On the server's shell, run `npm run pair -- --engine` (or open **Settings › Devices & sync → Link another engine**). A single-use link appears, valid for ten minutes.
3. On the Mac, open **Settings › Devices & sync → Connect to a home server** and paste it. Both engines verify each other, exchange the workspace key and start syncing.
4. To add a phone, run `npm run pair` on the server (or choose **Pair a phone or Mac**) and scan the QR code with the Tupies app. Check that the app shows the same server code.

When an existing Mac workspace links to a freshly installed server, the Mac's data wins: seeded items on a new engine carry the "genesis" stamp, so any real edit beats them. When both engines already had real data, items merge, and where both changed the same item the most recent edit wins.

## What syncs

| Synced (each item is its own document) | Stays with each engine |
| --- | --- |
| Bots and their settings, workspace settings | Workspace password and browser sessions |
| Model providers, integrations and Telegram channel settings (secrets re-sealed per engine) | Active runs, approvals, room turns, background commands, language servers |
| Conversations: every message, terminal task outcome metadata, plus the model history | Raw activity/audit log (Settings › Activity) |
| Core memory facts (one document per fact) | Telegram delivery cursors and claims |
| Suggested memory and skill changes (`proposal:<id>`), with their review status | |
| Long-term notes, skills, bot workspace files (by content hash) | The engine's vault key and identity key |
| Rooms and room messages, routines (with their schedule, time zone and missed-run choice) | Files over 64 MB, `.git`, `node_modules`, virtualenvs and temporary files |
| The owner's time zone (`settings.timezone`) | Bot/room message receipts (`submissions`, `roomSubmissions`) and run history (`runHistory`) |
| Paired devices (public keys only) and revocations | |
| Presence: which bots each engine is working with | |

## Dashboard activity across engines

**Latest activity** is a shared timeline of task results, built from conversation messages rather than each engine's audit log. The engine saves a small `taskOutcome` on the originating user message when a bot task or room turn finishes: terminal status, finish time, an optional redacted error and optional counts of declared mechanical checks. It travels through the existing message sync. Runs, approvals, controls, tool events and run history remain local; this metadata cannot resume or authorize work. Active work and requests for approval remain in **Working now** and **Needs you**.

On upgrade, retained terminal run/history/audit evidence is backfilled into existing messages. An older final assistant reply can supply a completed result; a partial reply needs an explicit non-success status. A request without a known result is never guessed to have succeeded or been interrupted. A member reply alone cannot prove a whole room task completed. Old outcomes whose local records and replies are already gone cannot be reconstructed. Both engines need the update; their timelines converge once message sync catches up. **Settings › Activity** intentionally describes changes on the selected engine.

## How sync decides

Every document carries a hybrid-logical-clock stamp: wall time, a counter and the engine that wrote it. The newest stamp wins. Because messages, facts and files are separate documents, two engines adding messages or editing different facts never collide. Clocks are kept monotonic, and a stamp more than ten minutes in the future is refused.

- **Files.** When both engines changed the same file since they last agreed, the receiving engine keeps the losing bytes beside it as `name (conflict <engine> <content hash>).md`. Exact retries reuse the same matching copy; different contents get distinct names, and failed preservation blocks replacement. Current bytes are inspected even when a watcher/rescan has not yet recorded an owner edit or new file, and rechecked before publication. A deletion never wins over a concurrent edit. Blob availability is based on bounded hash-verified bytes rather than stale cache membership; cache fingerprints include inode and change time.
- **Model history.** A bot's model history is one document. A remote change that arrives while the bot is working locally waits until the task ends, then the newer history wins. Display messages merge either way.
- **One engine per bot at a time.** Each engine publishes which bots it is working with, including waits for the owner’s answer or a teammate. Starting a task for a bot that another engine is working with is refused with "Atlas is working on Home server right now", and the chat shows the same note. Presence older than six minutes is ignored, so a crashed engine cannot block a bot forever.
- **Routines and Telegram** run only on the home server, so a schedule never fires twice. A linked engine shows them and can edit them.
- **ChatGPT subscription tokens** rotate on renewal. Only the home server renews; a linked engine asks it and receives the renewed bundle. If the home server is unreachable when the access token expires, subscription tasks on the linked engine wait with a clear error. API keys work offline.

Changes propagate in about a second: a linked engine pushes as soon as its state or files change and long-polls the home server for everyone else's changes. Files are also re-scanned every 30 seconds as a safety net.

A refused/missing/changed file application cannot acknowledge that file’s remote stamp or advance the pull cursor. Sync retries from the last acknowledged cursor; previously committed document versions are recognized by their causal stamps. Runs/approvals never enter these batches, so this recovery does not replay task actions. Unsafe, oversized or unreadable current files block replacement instead of being treated as absent.

## Security model

- **Linked engines are fully trusted.** They hold the whole workspace, including provider credentials. Link only engines you operate. Removing an engine removes its authoritative grant and rotates the group key. A replica forwards engine removal to the reachable home server; it does not report a local-only removal as success. A secure disconnect removes its own grant at the hub before clearing the local link.
- **Sealed sync and key recovery.** Workspace payloads and file contents use AES-256-GCM under a 256-bit group key. Provider secrets travel only inside these payloads and are re-sealed with each engine’s own vault key. When the hub rotates the key, each remaining peer—including one that was offline—obtains a nonce-bound signed response individually wrapped with P-256 ECDH and HKDF-SHA-256. The response binds both engine identities, grant id, workspace id and key epoch. A peer refuses a replay, another peer’s wrapper, a changed workspace identity, a lower epoch or a conflicting key at the same epoch. No current key is distributed under the old group key. Metadata stores keyed digests, never provider secrets.
- **Pairing.** Codes are 192-bit, single-use and expire after ten minutes (24 hours for the local Mac file below). Device pairing remains version 1: the device proves possession of its P-256 key and verifies the engine’s signed paired identity against the link fingerprint. Engine pairing requires version 2 and fresh ephemeral P-256 ECDH. Signed request/reply transcripts bind the code, both engine identities, ephemeral keys, grant id, workspace id and returned key epoch; HKDF-SHA-256 and authenticated encryption wrap the group key. Recording the code and public transcript is insufficient to decrypt it. Protect codes and TLS endpoints nevertheless: a stolen code authorizes an active enrollment attempt. Use the engine’s pinned certificate, a private tunnel or a TLS endpoint you operate.
- **Device sign-in.** Session version 2 signs the target engine node id and fingerprint, device id, timestamp and nonce to obtain a one-hour engine-local bearer. A proof for one engine cannot mint a session on another. Missing/v1 versions are rejected with an update error; the app checks the advertised protocol/identity before signing and never retries v1. Repeated nonces and clocks more than five minutes off are refused. Apple devices keep their key in the Secure Enclave when available. Device-ticket web sessions are tied to the same paired device. Bearers are not ambient browser credentials, so CSRF does not apply; Host and Origin checks still do.
- **Authority and revocation.** Engine sessions can use only sync routes; apps cannot use replication or key recovery. The hub’s local journal is authoritative for engine grants, so editing a synced device record or introducing an alias cannot grant engine access. Every sync/key request rechecks the current grant. Known app and engine revocations are journaled and cannot be undone by a newer edit, tombstone or stale active record. App-only removal does not rotate the group key. A disconnected engine learns a remote app revocation when it reconnects; there is no immediate offline propagation. Signing out ends that bearer session without unpairing it.
- **Sign-in from the internet.** Requests from outside private networks (loopback, LAN, Tailscale) can sign in only with a paired app unless the owner turns on password sign-in from the internet in **Settings › Devices & sync**. A password session opened privately does not carry over to the internet address. Failed sign-ins are limited per client address (IPv6 per /64), the limit tables have a fixed size, and a device's valid signature is never blocked by strangers' failures on other networks; password sign-in from the internet pauses for an hour after 50 failures. Each internet attempt is counted before the password is checked and refunded unless it was wrong, so concurrent guesses cannot exceed that cap. Behind a proxy, the client address comes from the last `X-Forwarded-For` hop, trusted only from loopback (`STUDIO_TRUSTED_PROXY=loopback`, the default) or private networks (`private`, for containers).
- **The engine's own certificate.** With `STUDIO_TLS=engine` the engine serves TLS 1.3 with a self-signed certificate over its identity key. The certificate is valid for 46 days, regenerated at each start and renewed weekly over the same key; only the key matters, so the pin and existing pairings never change. Apps and linked engines accept it only when that key matches the fingerprint from the pairing link, checked during the TLS handshake before any request is sent. Device and engine links from `STUDIO_TLS=engine` say so (`tls=engine`), as does the local-discovery file. Updated apps and linking engines require HTTPS and the exact pin before the first request; a publicly trusted certificate with a different key cannot replace it. An engine reached this way at pairing is remembered as pinned: from then on only its own key is accepted, so not even a publicly trusted certificate for the same address can impersonate it. Engines behind a domain or Tailscale pass normal certificate validation. The identity key also signs pairing proofs; those messages carry their own `hermes-studio/…` prefixes and TLS 1.3 signs a separate context string, so the two uses cannot be confused.
- **Transport.** Pairing/engine addresses must use HTTPS, loopback or Tailscale. Plain HTTP to another host needs explicit `STUDIO_SYNC_ALLOW_HTTP=true`; a link requiring the engine pin always requires HTTPS. Engine HTTP refuses redirects and has bounded deadlines, including session/key recovery. A TLS endpoint can see HTTP metadata and JSON session/key-wrap envelopes; the wrapped group key still requires the intended peer’s private key.
- **Same-user Mac pairing.** A loopback engine on macOS writes `~/Library/Application Support/Hermes Studio/local-engine.json` (mode 0600) with a local pairing code, so the Mac app can pair with "This Mac" without typing anything. Processes running as your user can already read the data directory, so this grants nothing new.

Messages, notes and files remain plaintext on each engine. Key rotation protects future sync; it cannot erase past plaintext/credentials held by a removed peer or revoke those credentials at their providers. Restoring an old hub backup can restore old grants and epochs. Keep that restoration offline and explicitly review/revoke/relink peers before reconnecting it. Protect each host and its complete backups.

## Upgrading legacy links

Update the home server, replicas and Apple app together after checking active tasks and making protected complete-runtime backups. Existing node ids, identity keys, bots, provider state and workspaces are preserved. On the first secure upgrade, the old code-wrapped group key is replaced; legacy engine grants do not authorize secure sync. A replica whose stored hub link has no version-2 contract stays paused with an explicit Update/relink message.

1. On each idle legacy replica, choose **Disconnect**, retaining its local workspace and identity. This migration path does not contact the unsupported old protocol. Its copied routines/messaging remain paused locally, without changing their enabled settings on either engine.
2. On the updated home server, create a fresh **Link another engine** link and connect the replica with it. Both endpoints must advertise the secure versions; there is no automatic v1 fallback.
3. Verify synced bots, files and outcomes before resuming unattended work. An already paired app can keep its device key/record and sign in using v2 after its app and target engine are updated.

For an established v2 link, Disconnect requires the reachable home server so it can revoke that replica’s grant and rotate the group key. If the remote removal committed before an acknowledgement/local completion was lost, a retry requires a fresh nonce-bound hub-signed proof for the exact durably revoked grant and original peer identity. Generic/unsigned authentication failures, expired bearers and transport failures cannot confirm removal; they leave the local link intact and automation paused. Linking, unlinking and local automation promotion require idle tasks, conversation summaries and credential renewal. New work is blocked and channel polls are quiesced during the transition. Do not delete identity, vault or security-journal files to bypass an update/relink error.

Every unlink suspends automatic routines and messaging on this engine using local `config.json`, so copied enabled schedules/channels cannot start alongside the former home server. Re-link to resume the home-server arrangement, or explicitly choose **Run routines and messaging here** in Devices & sync to promote this copy. The confirmation warns that the former home may still run its own copy and that jobs can use model credits/send messages. Manual tasks remain available. This choice never edits synced `enabled` settings and does not transfer ChatGPT authorization.

Copied ChatGPT grants remain owned by the former home: this copy cannot use/refresh them or revoke them remotely through provider Sign out. Only a successful fresh verified ChatGPT sign-in here, or v2 re-link to that same verified home identity, clears this local guard. Linking to a different home preserves the guard and withholds the copied OAuth secret from sync; ordinary provider settings/workspace data still merge. Existing source-home credentials remain untouched. Fresh sign-in is necessary before an independently promoted engine can use those copied connections.

The public engine metadata advertises `protocols: {deviceSession:2,devicePairing:1,enginePairing:2,sync:2}`. Sealed sync routes require `X-Tupies-Sync-Version: 2` and the current `X-Tupies-Key-Epoch`; an epoch conflict leads to individual key recovery and bounded retry, not old-key fallback. `POST /api/sync/key` and `POST /api/sync/revoke-engine` require a currently authorized engine bearer. These control envelopes do not expose the plaintext group key.

## Reaching your engines

| Option | Good for | Notes |
| --- | --- | --- |
| **Engine's own certificate** (recommended) | Phone from anywhere, no VPN app and no domain | `STUDIO_TLS=engine`: Tupies serves HTTPS with a certificate over its identity key, trusted by apps and linked engines through the pairing fingerprint. Open one port. Browsers show a warning on this address. |
| Own domain + Caddy | Same, plus browsers without a warning | Caddy obtains certificates automatically. Keep Tupies bound to loopback behind it. Only paired apps sign in from the internet. |
| Tailscale Funnel | Same, without a domain | Tailscale on the server only: `tailscale funnel --bg 4310` publishes `https://<machine>.<tailnet>.ts.net`. TLS ends on the server. |
| Tailscale (private) | Phone, Mac and server on a private network | No open ports: `tailscale serve --bg 4310`. Every device needs the Tailscale app. Headscale works if you prefer self-hosting the coordinator. |
| SSH tunnel | Testing from the Mac | `ssh -N -L 4310:127.0.0.1:4310 you@server`; not suitable for a phone. |

`STUDIO_ALLOWED_HOSTS` lists extra host names (for example a Tailscale IP) that may reach the engine directly. `STUDIO_ENGINE_NAME` sets the initial engine name; you can rename it in **Settings › Devices & sync**.

## Files on disk

`data/sync/` belongs to the data directory and must be backed up with it:

| File | Purpose |
| --- | --- |
| `identity.json` | Engine id, name and P-256 identity key (private key sealed with the vault key). |
| `security.json` | Canonical v2 key epoch/workspace id, sealed group key, authoritative engine grants, durable device/node revocations and original revoked-engine public identities for signed removal proofs. Atomic replacement flushes file and directory before success. |
| `workspace.key` | Private plaintext compatibility mirror of the current group key (mode 0600). A valid canonical journal repairs an absent/stale mirror. |
| `config.json` | Home server URL, device id and pinned identity (if linked); local post-unlink automation suspension and former-home ownership guards for copied ChatGPT connections. Never synced. |
| `meta.json` | Per-document stamps and hashes, cursors. Contains no content or secrets. |
| `blobs/` | File contents in transit; cleared at start. |

The data directory itself also holds `access.json` (whether the workspace password is accepted from the internet) and, while the engine runs, `control.sock` (mode 0600; under a per-user 0700 directory in `/tmp` when the data path is too long for a Unix socket), through which `npm run pair` asks the engine for a pairing link. A second engine refuses to start on a data directory whose control socket answers.

Restore the complete runtime consistently. A missing secure journal or engine identity fails closed; neither is regenerated to bypass lost trust. Do not delete `meta.json` as a recovery shortcut: losing stamps/cursors can change conflict resolution and discard unsynced edits when server versions win. Process homes under `data/process-homes/` also belong in private backups and never travel through workspace sync.

## Limits

- Hub and spoke only: linked engines do not sync directly with each other, and an engine cannot be both a hub and a replica.
- A conversation is merged message by message, but each model history (the Bot Chat and every other lane, `conv:<sessionId>`) is last-writer-wins. Avoid working with the same bot on two engines while they are disconnected.
- Lane records (`session:<sessionId>`) replicate like other items. A lane's id starts with its bot's id, so changes to any of a bot's lanes wait while that bot works on this engine. An engine older than lanes ignores `session:` documents and stores lane histories without using them; update the Mac and the home server together.
- Deletions are kept as small tombstones and are not garbage-collected yet.
- Workspace sync is designed for notes, documents and small projects, not large repositories: 20,000 files per engine, 64 MB per file.
- Bot runs and their live progress are not mirrored. Other engines see "working on …" and the result when it is saved.
- There is no web-based pairing of the browser itself; browsers keep using the workspace password.
