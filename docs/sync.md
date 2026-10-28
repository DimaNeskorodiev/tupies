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
| Conversations: every message, plus the model history | Activity log |
| Core memory facts (one document per fact) | Telegram delivery cursors and claims |
| Suggested memory and skill changes (`proposal:<id>`), with their review status | |
| Long-term notes, skills, bot workspace files (by content hash) | The engine's vault key and identity key |
| Rooms and room messages, routines (with their schedule, time zone and missed-run choice) | Files over 64 MB, `.git`, `node_modules`, virtualenvs and temporary files |
| The owner's time zone (`settings.timezone`) | Message receipts (`submissions`) and run history (`runHistory`) |
| Paired devices (public keys only) and revocations | |
| Presence: which bots each engine is working with | |

## How sync decides

Every document carries a hybrid-logical-clock stamp: wall time, a counter and the engine that wrote it. The newest stamp wins. Because messages, facts and files are separate documents, two engines adding messages or editing different facts never collide. Clocks are kept monotonic, and a stamp more than ten minutes in the future is refused.

- **Files.** When both engines changed the same file since they last agreed, the engine where the newer version lands keeps the older content next to it as `name (conflict <engine> <time>).md`, the same convention Obsidian-style sync tools use. A deletion never wins over a concurrent edit.
- **Model history.** A bot's model history is one document. A remote change that arrives while the bot is working locally waits until the task ends, then the newer history wins. Display messages merge either way.
- **One engine per bot at a time.** Each engine publishes which bots it is working with. Starting a task for a bot that another engine is working with is refused with "Atlas is working on Home server right now", and the chat shows the same note. Presence older than six minutes is ignored, so a crashed engine cannot block a bot forever.
- **Routines and Telegram** run only on the home server, so a schedule never fires twice. A linked engine shows them and can edit them.
- **ChatGPT subscription tokens** rotate on renewal. Only the home server renews; a linked engine asks it and receives the renewed bundle. If the home server is unreachable when the access token expires, subscription tasks on the linked engine wait with a clear error. API keys work offline.

Changes propagate in about a second: a linked engine pushes as soon as its state or files change and long-polls the home server for everyone else's changes. Files are also re-scanned every 30 seconds as a safety net.

## Security model

- **Linked engines are fully trusted.** They hold the whole workspace, including provider credentials. Link only engines you operate. Removing a linked engine on the home server stops its sync immediately.
- **End-to-end sealed sync.** Engine-to-engine requests and file contents are encrypted with AES-256-GCM under a 256-bit workspace key that only linked engines hold. After linking, a TLS-terminating proxy or tunnel sees only ciphertext. Provider secrets travel only inside these sealed payloads, and each engine re-seals them with its own vault key. Sync metadata stores keyed digests, never secrets.
- **Pairing.** Codes are 192-bit, single-use and expire after ten minutes (24 hours for the local Mac file below). The device proves possession of its P-256 key; the engine returns a signature over the device's identity, which the device checks against the fingerprint in the link. An engine link also carries the workspace key, wrapped with a key derived from the pairing code and the linking engine's id. Both travel in the pairing request itself, so anything that can read that exchange in clear (a TLS-terminating tunnel, CDN or inspection proxy, or a link allowed over plain HTTP) can unwrap the key, and with it every later sync payload. Link engines directly over the engine's own pinned certificate, Tailscale or a TLS endpoint you operate; never through a third-party TLS terminator. A key exchange that would also keep a passive observer of the pairing out is on the roadmap.
- **Device sign-in.** Devices sign a timestamped, nonce-bound challenge to obtain a one-hour bearer token. A web view signed in through a device ticket is tied to that device and loses its session as soon as the device is revoked, on any engine. Replays and clocks more than five minutes off are refused. Apple devices keep their key in the Secure Enclave when available. Bearer tokens are not ambient browser credentials, so CSRF does not apply; Host and Origin checks still do.
- **Least privilege between engines.** An engine session can only use the sync routes; an app session cannot use them. Revoking a device ends its sessions on its next request and replicates to every engine. Revocation is final: a newer edit to the same device made on an engine that had not yet received the revocation (for example a stolen phone renaming itself on an offline Mac) keeps the device revoked, and that engine restamps the revocation so it wins everywhere. Signing out with a device bearer ends that bearer session.
- **Sign-in from the internet.** Requests from outside private networks (loopback, LAN, Tailscale) can sign in only with a paired app unless the owner turns on password sign-in from the internet in **Settings › Devices & sync**. A password session opened privately does not carry over to the internet address. Failed sign-ins are limited per client address (IPv6 per /64), the limit tables have a fixed size, and a device's valid signature is never blocked by strangers' failures on other networks; password sign-in from the internet pauses for an hour after 50 failures. Each internet attempt is counted before the password is checked and refunded unless it was wrong, so concurrent guesses cannot exceed that cap. Behind a proxy, the client address comes from the last `X-Forwarded-For` hop, trusted only from loopback (`STUDIO_TRUSTED_PROXY=loopback`, the default) or private networks (`private`, for containers).
- **The engine's own certificate.** With `STUDIO_TLS=engine` the engine serves TLS 1.3 with a self-signed certificate over its identity key. The certificate is valid for 46 days, regenerated at each start and renewed weekly over the same key; only the key matters, so the pin and existing pairings never change. Apps and linked engines accept it only when that key matches the fingerprint from the pairing link, checked during the TLS handshake before any request is sent. Links from an engine with `STUDIO_TLS=engine` say so (`tls=engine`), and a linking engine then accepts nothing but the pinned key from the first request on. An engine reached this way at pairing is remembered as pinned: from then on only its own key is accepted, so not even a publicly trusted certificate for the same address can impersonate it. Engines behind a domain or Tailscale pass normal certificate validation. The identity key also signs pairing proofs; those messages carry their own `hermes-studio/…` prefixes and TLS 1.3 signs a separate context string, so the two uses cannot be confused.
- **Transport.** Pairing links and engine links must use HTTPS, loopback or a Tailscale address. Plain HTTP to another host requires the explicit `STUDIO_SYNC_ALLOW_HTTP=true`, because bearer tokens would otherwise travel in clear text.
- **Same-user Mac pairing.** A loopback engine on macOS writes `~/Library/Application Support/Hermes Studio/local-engine.json` (mode 0600) with a local pairing code, so the Mac app can pair with "This Mac" without typing anything. Processes running as your user can already read the data directory, so this grants nothing new.

Messages, notes and files remain plaintext data on each engine, as before. Protect each host and its backups.

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
| `workspace.key` | The 256-bit key shared by linked engines (mode 0600). |
| `config.json` | The home server this engine syncs with, if any. |
| `meta.json` | Per-document stamps and hashes, cursors. Contains no content or secrets. |
| `blobs/` | File contents in transit; cleared at start. |

The data directory itself also holds `access.json` (whether the workspace password is accepted from the internet) and, while the engine runs, `control.sock` (mode 0600; under a per-user 0700 directory in `/tmp` when the data path is too long for a Unix socket), through which `npm run pair` asks the engine for a pairing link. A second engine refuses to start on a data directory whose control socket answers.

Deleting `meta.json` is safe: an engine linked to a home server re-stamps its data at genesis and takes the server's versions; a standalone engine re-stamps everything now.

## Limits

- Hub and spoke only: linked engines do not sync directly with each other, and an engine cannot be both a hub and a replica.
- A conversation is merged message by message, but each model history (the Bot Chat and every other lane, `conv:<sessionId>`) is last-writer-wins. Avoid working with the same bot on two engines while they are disconnected.
- Lane records (`session:<sessionId>`) replicate like other items. A lane's id starts with its bot's id, so changes to any of a bot's lanes wait while that bot works on this engine. An engine older than lanes ignores `session:` documents and stores lane histories without using them; update the Mac and the home server together.
- Deletions are kept as small tombstones and are not garbage-collected yet.
- Workspace sync is designed for notes, documents and small projects, not large repositories: 20,000 files per engine, 64 MB per file.
- Bot runs and their live progress are not mirrored. Other engines see "working on …" and the result when it is saved.
- There is no web-based pairing of the browser itself; browsers keep using the workspace password.
