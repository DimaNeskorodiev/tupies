# Operations and recovery

Run Tupies on Node.js 22.16 or newer. For a release, install the locked runtime libraries with `npm ci --omit=dev`, then run `npm start`. The shipped browser/PDF assets and fonts need no build tools, runtime CDN, Codex CLI or Hermes installation. A modified source checkout needs `npm ci` and `npm run build` before deployment. The default listener is `127.0.0.1:4310`. First start prints a one-time setup token; use it to set a password of at least 12 characters. Browser sessions expire after 12 hours and are invalidated by a server restart.

Control-C stops the server and cancels active Tupies tasks. Approved external actions may already have completed, so inspect service results before retrying. After a crash/restart, active work and pending approvals become interrupted; queued side effects are not replayed automatically.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| STUDIO_HOST | 127.0.0.1 | Listener bind. Compose uses 0.0.0.0 inside the container. |
| STUDIO_PORT | 4310 | HTTP and local OAuth callback port. Use the same port at both tunnel ends. |
| STUDIO_DATA_DIR | data/ beside server.mjs | State, vault, skills and private bot workspaces. Prefer an absolute service path. |
| STUDIO_PUBLIC_URL | unset | Exact allowed external HTTPS origin; no path, query or credentials. |
| STUDIO_SECURE_COOKIE | false locally; on with public origin | Require HTTPS transport for login cookies. |
| STUDIO_ALLOW_PRIVATE_HTTP | false | Explicit trusted private-network services; public HTTP and metadata/link-local destinations remain blocked. |
| STUDIO_DEPLOYMENT_MODE | local | Use hosted for a paid/remotely hosted product; dynamic ChatGPT OSS registration is then disabled without a configured client. |
| STUDIO_OPENAI_CLIENT_ID | unset | An operator's approved/pre-issued client ID when appropriate; it does not create eligibility. |
| STUDIO_APNS_KEY_FILE | unset | Private operator-managed Apple push `.p8` key file, outside bot workspaces and sync. |
| STUDIO_APNS_KEY_ID | unset | Key identifier for that APNs key. |
| STUDIO_APNS_TEAM_ID | unset | Apple Developer team that signs the native app. |
| STUDIO_APNS_TOPIC | dev.hermesstudio.app | App bundle identifier for native push delivery. |
| STUDIO_APNS_ENVIRONMENT | sandbox | Sandbox for development-signed iPhone builds; production for distribution. Must match the key and app. |

`npm start` and `npm run dev` load `.env` if it exists. A direct `node server.mjs` invocation only uses the shell environment; use `node --env-file=.env server.mjs` to load a file explicitly. Compose reads its interpolation `.env` separately. Provider credentials belong in the app's sealed connection store, not a committed environment file.

The initial provider can serve multiple bots without sharing their conversations, memory or workspaces. Each task has bounded model/tool/delegation/time budgets. Document-enabled operation should have at least a 1 GB memory budget, plus headroom for the host and larger concurrent work. Two document workers may run at once with a 256 MB V8 heap each and a 25-second deadline; native buffers, image libraries and the main server need memory beyond those heaps. Compose and the sample service use 1 GB limits. Monitor the service for memory pressure rather than treating the worker heap limit as a total-process cap. These defaults are application guardrails, not a guarantee against provider billing or arbitrary trusted-script behavior.

Native iPhone notifications need operator APNs configuration and device opt-in; see [iPhone notifications](notifications.md). Only the home server sends when engines are linked. `notifications.json` is private engine-local registration/delivery metadata, with device tokens sealed by the vault key; preserve it in a complete private backup. The operator's APNs key is separate and must be protected independently. Neither file is workspace sync content. Notification credentials and mode are read at startup; check active work before a restart.

## Back up

Stop the single Tupies process, then back up the **entire** data directory: state.json, vault.key, sync/ (engine identity and the workspace key shared with linked engines), skills/, workspaces/ and every retained file. Credentials cannot be decrypted from state alone. Possessing the complete unencrypted backup also supplies the vault key, so encrypt backups with a separate backup key.

For native operation, from the Tupies folder after stopping it:

```sh
mkdir -p backups
chmod 700 backups
tar -czf backups/studio-data.tar.gz data
chmod 600 backups/studio-data.tar.gz
```

For Compose:

```sh
docker compose stop studio
mkdir -p backups
chmod 700 backups
docker compose cp studio:/data backups/studio-data
docker compose start studio
```

These commands produce unencrypted backup material. Protect it with your existing encryption/backup system and test a restore offline.

## Restore and upgrades

Keep Tupies stopped. Preserve the current data before restoring a backup. Restore the complete tree together with ownership matching the Tupies account, directories mode 0700 and key/state files mode 0600. Docker runs as UID/GID 1000. Do not generate a new vault key over old state.

A restored routine may be due immediately. First review a recovery in an environment without provider network access, disable/reconfigure schedules, then reconnect. Never operate the production data and its restored copy as concurrent schedulers against the same outside services.

For an upgrade, keep the package lock, install the new release with `npm ci --omit=dev`, preserve its shipped public/ and assets/ directories, and restart the single service after the backup. For a modified source build, use `npm ci` followed by `npm run build`; regenerating only the guide does not refresh browser assets or dependency notices.

Tupies 0.4.0 preserves local bot/room/transcript data from earlier versions, including retained attachment/artifact metadata. Legacy Hermes gateway connections are labeled for replacement; their gateway secrets are not reused as model-provider API keys. Choose direct providers and models before allowing scheduled work.

There is no password-change/reset UI in this version. Recover through an operator-controlled offline backup procedure; do not expose an unauthenticated recovery endpoint or wipe state to recover a login.

## Schedules

Run one process per data directory and keep the host awake for routines. With sync, routines and messaging channels run only on the home server; linked engines show and edit them. Hourly/Daily/Weekly schedules are intervals from enablement, not wall-clock calendar/timezone events. Custom intervals are at least five minutes. Missed intervals are not replayed as a batch; busy/reserved bots defer due work. Manual Run can intentionally dispatch a paused routine.

## Linked engines

Each linked engine has its own data directory, vault key and password; never point two engines at the same directory or restore one engine's backup onto another running engine. To retire an engine, remove it under **Settings › Devices & sync** on the home server. To restore a linked engine from an old backup, start it, then let it catch up: newer edits on the home server win, and its own older edits do not overwrite them. Deleting `data/sync/meta.json` on a linked engine makes it take the home server's versions. See [Engines, devices and sync](sync.md).
