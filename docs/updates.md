# Automatic Mac and VPS updates

## Status and trust roots

Source implementation, 4 November 2026. Mac uses pinned **Sparkle 2.10.1**; VPS uses an independent operator-installed Node 22 updater and signed Engine bundles. Existing Mac/VPS installations need one reviewed bootstrap release. iPhone distribution is unchanged. No operational installation is implied by this source checkpoint.

The existing Mac signing team is pinned by a domain-separated SHA-256 identifier; release signing and publication refuse a different team. Public keys and beta feed addresses are in `assets/updates/release-channels.json`. New private update-signing keys were generated outside shipped source; no existing Apple private key was exported. Keep a separately protected key backup. The Engine private signing key stays on the maintainer/signing runner, never on the VPS. Only its public key goes to the updater. `scripts/create-update-keys.mjs --output /absolute/new/private-directory` creates fresh separate Engine and Sparkle keys without reading/exporting Apple certificates. Never overwrite a deployed trust root or generate replacements during an ordinary release.

## Mac behavior

Install the first updater-enabled notarized app in place once, preserving bundle ID, signing team and Keychain group. **Tupies → Check for Updates…** and **Settings → Updates** expose checks, background downloads and installation of a downloaded update. Sparkle asks about automatic checks; automatic download is a separate preference. Checks run approximately hourly while the app runs. A background download installs on safe quit; there is no forced restart timer.

The app requires signed HTTPS feeds and signed archives verified before extraction. Every release still needs Developer ID signing, notarization and an increasing native build number. `release-macos.mjs` signs Sparkle's nested helpers/framework before sealing the app. Normal release defaults use the pinned beta feed/key; `--update-feed` and `--update-public-key` allow a separately reviewed channel.

All loaded Engine pages must report readiness. Draft messages, attachments/uploads, changed text fields, dialogs, pairing, popups and downloads postpone installation. Older pages without the readiness function also postpone it: bootstrap the VPS Engine before the Mac updater. Ready pages become inert during preparation so no new draft appears between the check and termination. Refusal unlocks them. A failed/cancelled installation can restart only the previously owned bundled Engine using its exact saved managed identity.

The app calls its bundled `prepare-mac-update.mjs` with its exact owned PID. The helper claims the idle private control socket, checks that PID, sends normal SIGTERM, waits for process exit and verifies an encrypted complete data backup. A stopped managed workspace is backed up too. Message drafts and selected attachment metadata also survive a VPS authentication reload in Mac memory: they are restored as drafts, never sent automatically. They are cleared on connection removal/revocation; no disk or sync draft store is added. Separately launched Engines are not stopped; an app-owned developer Engine must be stopped explicitly.

Backups use the private `Tupies/UpdateBackups` Application Support folder and separate private `Tupies/update-backup.key`. Current workspace, managed ownership marker and device Keychain items stay in place. Preserve the key separately when exporting backups. Automatic retention/deletion is not implemented; monitor disk use. Updating never automatically restores old user data.

After the existing notarization `finish` stage, prepare a signed feed:

```sh
node scripts/release-mac-update.mjs --release /absolute/notarized-release --output /absolute/new-feed --url https://github.com/DimaNeskorodiev/tupies/releases/download/VERSION/Tupies.dmg --key /absolute/private/sparkle-private.key --sign-tool /absolute/verified-sparkle-2.10.1/bin/sign_update
```

The official Sparkle SPM archive SHA-256 is `4c2e48a3e50ebcc2c88a58a4c7264a1a99c3c31857ce754357afb9cdb323022a`. The script verifies final DMG bytes, the embedded public key, the archive signature independently and the signed appcast. It never installs or publishes. Publish the immutable versioned DMG first, then publish the signed feed as **mac-beta.xml** in the persistent public **update-feeds** GitHub prerelease. Never replace bytes of an already published versioned DMG. The public repository's release assets require no tester GitHub account.

## VPS bootstrap

Supported automatic installation is native **Linux/systemd**, with Engine running as a separate unprivileged account and official **Node 22.23.4** or a later Node 22 patch. Containers retain their own deployment mechanism; bots get no Docker/root access.

Bootstrap manually after the usual idle check and complete protected stopped backup:

1. Install a reviewed protocol-1 Engine release with built assets and locked target-platform production dependencies. Retain actual data, service account, environment, TLS identity and unit security options. An old Engine needs this one manual upgrade.
2. Use `scripts/stage-engine-update.mjs --manifest SIGNED_JSON --archive PAYLOAD --public-key PRIVATE_MODE_PUBLIC_PEM --output NEW_ABSOLUTE_DIRECTORY --channel beta` to verify/extract a downloaded package offline on its target platform without starting Engine. Put the immutable candidate in root-owned `/opt/tupies/releases/RELEASE_ID`; root-owned `/opt/tupies/current` points to it. Engine can read source but cannot modify it. Copy the candidate's actual `engine-release.json` alongside `server.mjs`, and the same metadata to `/var/lib/tupies-updater/accepted.json`. Never label unrelated installed code with invented metadata.
3. Install the reviewed updater source separately in root-owned `/usr/local/lib/tupies-updater`, using `node scripts/stage-engine-release.mjs --output /usr/local/lib/tupies-updater`, then copy the separately reviewed CLI entry with `install -m 0644 scripts/update-engine.mjs /usr/local/lib/tupies-updater/scripts/update-engine.mjs`. The ordinary Engine staging allowlist intentionally does not ship this privileged operator entry. It imports the existing snapshot/credential validator from its own frozen `lib/` tree, never from moving `current`. It does not execute package-manager hooks or install dependencies during updates.
4. Create root-owned `/var/lib/tupies-updater` mode **0755**: Engine needs traversal to inspect the hold marker. Receipts/lock/accepted state are 0600. Create backup storage `/var/backups/tupies` mode 0700 and `/etc/tupies-updater` mode 0700. Put the pinned public key in `engine-public.pem` mode 0600. Generate a new random 32-byte `backup.key` mode 0600 and protect an independent copy. It stays outside Engine data, releases and backup storage. No private release-signing key belongs on the VPS.
5. Write root-owned `/etc/tupies-updater/config.json` mode 0600. Adapt these portable examples to the existing installation:

```json
{
  "schema": 1,
  "channel": "beta",
  "service": "tupies.service",
  "feedURL": "https://github.com/DimaNeskorodiev/tupies/releases/download/update-feeds/engine-beta-linux-x64.json",
  "artifactOrigins": ["https://github.com", "https://release-assets.githubusercontent.com"],
  "releasesDir": "/opt/tupies/releases",
  "currentLink": "/opt/tupies/current",
  "dataDir": "/var/lib/tupies",
  "backupDir": "/var/backups/tupies",
  "backupKeyFile": "/etc/tupies-updater/backup.key",
  "stateDir": "/var/lib/tupies-updater",
  "publicKeyFile": "/etc/tupies-updater/engine-public.pem",
  "holdFile": "/var/lib/tupies-updater/hold"
}
```

6. Review/install `tupies-update-engine.conf` as the existing Engine's systemd drop-in, and the supplied update service/timer. Keep original account/data/environment settings. Match `ReadWritePaths`/`ProtectHome` to actual paths; examples are not a live-workspace installer. Restart the idle Engine once, verify preservation and control status, run one controlled update check, then enable `tupies-update.timer`. It checks after boot and approximately every 30–35 minutes.

The updater runs as root to swap code and control the fixed service; Engine retains its service account. The private control socket must match the data directory owner's UID. Neither HTTP routes nor model tools grant update authority; ordinary same-user owner shell authority remains unchanged.

## Server transaction and recovery

The updater verifies an Ed25519 signature over exact manifest bytes, product/channel/platform/architecture, expiry, monotonic sequence and data epoch. Every HTTPS redirect must stay within configured exact origins. Download/expanded sizes are bounded. Paths, modes, lengths and SHA-256 are checked. Relative links are permitted only between signed dependency files in `node_modules`; escaping, dangling, cyclic, special-file and file/directory collision cases fail closed. No downloaded installer script or `npm install` runs on the VPS.

Files are staged before claiming an idle window. Active task families, rooms, summaries, submissions, channel dispatch/writes, current sign-ins/refreshes, push delivery and authenticated HTTP requests postpone updates. An idle Telegram long poll can settle or be cancelled during Stop without consuming a new message. Staging stays on the releases filesystem for atomic rename even when updater state is on another mount. Disk preflight retains 512 MiB spare and reserves conservative backup verification scratch (six times the measured runtime bytes). The two-minute reservation blocks new task/room/study/HTTP admission and scheduled work; it expires if its preparer disappears. Active work is never stopped just to claim a window.

A durable root-owned journal records exact previous/candidate releases before service changes. Normal Stop precedes a complete runtime snapshot, AES-256-GCM encryption, fresh authenticated decryption and validation by the existing credential/snapshot inspector. Empty directories and saved files are retained; key stays outside the archive. Failure prevents activation.

An atomic `current` switch is followed by a held start. While held, automatic task recovery, schedules, outbound peer startup, push delivery and workspace APIs are blocked. The private socket must report the exact expected release ID/sequence and held state. Only then are acceptance persisted, the hold marker removed and Engine activated.

Automatic upgrades require the **same data epoch**. A pre-activation failure can stop the candidate and restart previous code against **current data**, held until verified. Old backup data is never automatically restored. Once activation may have admitted real work, automatic rollback stops and uncertainty requires operator inspection. A data epoch is a maintainer compatibility declaration, not proof that arbitrary code is reversible; cross-epoch migration is manual.

An unfinished journal or stale lock requires operator review, not replay. Inspect `pending.json`, the actual service/current link, hold marker and accepted metadata before resolving that exact job. Preserve receipts/backups. Never remove a running updater's lock, blindly clear an unknown phase or run production/restored copies as duplicate schedulers.

## Release publication

Create persistent public **update-feeds** once. Configure GitHub environment **engine-updates** with `TUPIES_ENGINE_RELEASE_PRIVATE_KEY` matching the source public key; restrict it to reviewed release tags. Configure **mac-updates** with `TUPIES_SPARKLE_PRIVATE_KEY` (the base64 seed, not an Apple private certificate), matching the source Mac public key. Writing workflows does not upload secrets, create a release or change a VPS.

When a versioned GitHub release already contains the final `Tupies.dmg` at publication time, the Mac workflow independently downloads it, checks stapling/Gatekeeper/inner-app signatures and pinned identity/update metadata, signs/verifies its feed using checksum-pinned official Sparkle tools, refuses non-increasing Mac builds and advances the configured feed last. Attach the DMG to the draft before publishing it; adding an asset later does not trigger this release event. Apple certificate export is not required.

The Engine release workflow pins Node 22.23.4, runs all regressions/syntax checks, builds assets/guide/licenses, stages allowlisted source and installs Linux x64 production dependencies. It signs and uploads immutable package/manifest/metadata to the published versioned release, then advances the matching channel **last**. Prereleases publish beta, ordinary releases stable. Publication time supplies the increasing sequence; do not republish old releases to move a channel backward. Beta servers do not implicitly switch to stable.

For a separately verified platform/manual pipeline:

```sh
node scripts/stage-engine-release.mjs --output /absolute/new-source
# In an isolated build environment on the target Linux architecture:
npm ci --prefix /absolute/new-source --omit=dev --ignore-scripts
node scripts/release-engine.mjs --source /absolute/new-source --output /absolute/new-output --id 0.5.1-beta.1 --version 0.5.1-beta.1 --sequence 1793880000000 --channel beta --arch x64 --data-epoch 1 --url https://example.com/immutable/engine.tupies.gz --key /absolute/private/engine-private.pem
```

The package base version must match the tag. Never sign private runtime data, an ordinary working checkout or Mac dependencies as a Linux release. Arm64 is supported by the format/builder but has no publishing job yet. Key rotation, updater self-replacement and cross-epoch migration remain manual.

Verify/restore encrypted backups offline without starting Engine:

```sh
node scripts/update-backup.mjs verify --source /absolute/runtime.tupies-backup --key-file /absolute/private/backup.key
node scripts/update-backup.mjs restore --source /absolute/runtime.tupies-backup --key-file /absolute/private/backup.key --target /absolute/new-recovery
```

Restore refuses existing destinations. Match recovered ownership to the Engine account before a reviewed restart. CLI authenticated-decrypt scratch is private and removed. Retain independent backups and the separately protected key.

## Verification boundary

See [Verification](verification.md) for measured checks. Fixtures cover actual private Engine control/admission, signatures, corrupted/unsafe bundles, redirects, complete encrypted backup/restore and updater failure phases. A service adapter fixture does not establish real systemd acceptance. Exact official Sparkle build/typecheck is separate from a production signed update between two notarized apps. Operational bootstrap, GitHub settings/first published feed, actual VPS/systemd and tester acceptance remain separate. Existing installed ownership in `PROJECT_CONTEXT.md` stays authoritative.
