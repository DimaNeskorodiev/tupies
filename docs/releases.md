# Versions, CI and releases

One page for how a change travels from a pull request to the Engine, the Mac app and the iPhone app. The signing and updater internals are in [Automatic Mac and VPS updates](updates.md); the notarized Mac build is in [macOS release](macos-release.md).

## The three parts and their versions

| Part | What it is | Version it shows | How a new one arrives |
| --- | --- | --- | --- |
| **Engine** | The server and every screen of the web UI | Release name, for example `0.5.0 beta 11` | A GitHub release; servers install it by themselves |
| **iPhone app** | A native shell that loads the Engine's screens | `0.5.0 (17)`: version and build number | A new build through TestFlight (or Xcode) |
| **Mac app** | The same shell, plus an included Engine for "Use this Mac" | `0.5.0 (17)` | A notarized `Tupies.dmg`; Macs update through Sparkle |

Most changes touch only the Engine, so the phone needs nothing but a reload. The phone needs a new build only when something under `apps/apple/` changed.

Version numbers live in three places that must agree, and CI fails when they do not:

- `package.json` `version` — the product version (`0.5.0`).
- `apps/apple/Tupies.xcodeproj` — `MARKETING_VERSION` (same as above) and `CURRENT_PROJECT_VERSION`, the native build number.
- `assets/updates/native-apps.json` — the native build this web UI expects, the oldest build it still works with (`minimumBuild`), and the public TestFlight link once one exists.

Never pass a build number on the command line. Raise it in the repository:

```bash
node scripts/update-impact.mjs --bump
```

A release tag is `vX.Y.Z-engine.beta.N` for a prerelease (beta channel) or `vX.Y.Z` for a stable release. The part before the first `-` must equal `package.json`.

## What needs updating: `scripts/update-impact.mjs`

```bash
node scripts/update-impact.mjs                      # the working tree, compared with the last release
node scripts/update-impact.mjs --base origin/main   # this branch
node scripts/update-impact.mjs --check              # also fail on version mismatches or a reused build number
```

It prints a table: Engine, iPhone app, Mac app, each with yes or no and what to do. Paths decide the answer: `server.mjs`, `lib/`, `public/`, shipped `assets/` and shipped scripts are the Engine; `apps/apple/` (except its README and tests) is the native apps; documentation, tests and workflows reach nothing. If native sources changed since the last release and the build number did not, `--check` fails: every native change ships under a new build number.

The same table is posted by CI as a comment on every pull request, written into the summary of every CI run, and appended to every GitHub release with what each release job actually did. Anyone finishing a change, person or coding agent, reports this table's answer.

## CI: `.github/workflows/ci.yml`

Runs on every pull request and on every merge to `main`.

| Job | What it proves | Runs |
| --- | --- | --- |
| **What to update** | The table above; version numbers agree; no build number is reused | always |
| **Tests** | `npm run check` and the whole suite through `scripts/verify-release-tests.mjs`, the same command the release uses | always |
| **Linux command sandbox** | Bot commands stay inside bubblewrap, directly and under the server's systemd hardening | always |
| **Workshop container** | Bot-proposed Engine changes are verified in a locked-down container (`scripts/accept-engine-verifier.mjs`) | always |
| **iPhone and Mac apps** | Swift logic tests, then both apps compile without signing | when `apps/apple/` changed, and on `main` |
| **CI passed** | Every job above passed or did not apply | always |

The container image holds only the Engine's own sources, and it refuses skipped tests, so a test under `test/` must not read `apps/apple/` or `.github/`; checks on those belong in **What to update** or **iPhone and Mac apps**.

`CI passed` is the one check the `main` ruleset should require. Because the suite now runs on a GitHub runner before merge, a test that is too slow or flaky there fails the pull request instead of failing a release after its tag is public.

## Releasing: `.github/workflows/release.yml`

1. Check what each server actually runs before anything else: `sudo -n cat /opt/…/current/engine-release.json` on the VPS, and compare its `id` with the last published release. The updater installs any release with a higher sequence, so a variant installed by hand is replaced without a word. If the server runs something that is not in `main`, bring that into `main` first or pause its update timer. On 16 November 2026 beta 11 replaced a hand-installed finance variant this way.
2. Merge to `main` with CI green.
3. Publish a GitHub release whose tag follows the scheme above, targeting `main`. Tick "pre-release" for the beta channel. Attach the notarized `Tupies.dmg` to the draft first if the Mac app changed.
4. The workflow does the rest:

| Job | What it does | Runs |
| --- | --- | --- |
| **What this release updates** | Compares with the previous release tag | always |
| **Engine update** | Tests, stages, signs and publishes the Engine; advances the channel feed last | always |
| **Mac update feed** | Verifies the notarized DMG and publishes the signed Sparkle feed | when `Tupies.dmg` is attached |
| **iPhone app (TestFlight)** | Archives, signs and uploads the iPhone build | when the iPhone app changed and TestFlight is switched on |
| **Release notes** | Appends "What to update" and each job's outcome to the release page | always |

The Engine job depends on nothing else, so a problem describing the release never holds back the server update. Never republish a tag; a failed run is rerun (`gh run rerun --failed`) or followed by the next beta number.

## In the app: Settings → Version & updates

- **Tupies Engine** shows the installed release, **Check for updates** (reads the signed release channel and verifies it with the public key shipped in `assets/updates/release-channels.json`) and, where the server allows it, **Update now**.
- **iPhone app / Mac app** shows the app's own version and build when the page is open in the app, and says when a newer build exists or is required. On the iPhone it points to TestFlight; on the Mac it opens Sparkle's own check.
- A page left open across an Engine update shows "Tupies was updated — Reload" the next time it comes to the front.

The Engine routes are `GET /api/update`, `POST /api/update/check` and `POST /api/update/install` (`lib/update-status.mjs`), all behind the owner's session. None of them downloads or installs code.

**Update now** asks, it does not install. The Engine writes a timestamp to the file named by `STUDIO_UPDATE_REQUEST_FILE`; a systemd path unit ([`tupies-update-request.path`](tupies-update-request.path)) then starts the same root-owned updater the timer runs. That updater still verifies the signature, waits for an idle Engine and takes its encrypted backup. Without the variable the button is not shown and the page says how updates arrive: by the server's timer (about every 30 minutes), with the Mac app, or by hand. Setting it up is step 7 of the [VPS bootstrap](updates.md#vps-bootstrap).

How a copy knows what it is: a release installed by the updater has `engine-release.json`; any other staged copy (the Mac app's included Engine, a hand rollout) has `assets/updates/build.json` with the commit it was built from, written by `scripts/stage-engine-release.mjs`; a source checkout has neither and makes no claim. Signed release metadata carries the release commit, so a copy built from that same commit reads as up to date.

## TestFlight: one-time setup

Until this is done the iPhone app is built and installed from Xcode as before, and releases say so.

1. In App Store Connect, create the app record for bundle ID `dev.tupies.app` (the identifier and its capabilities, Push Notifications and Communication Notifications, must exist under the same team that signs today's builds, so the installed app and its Keychain items carry over).
2. Create an App Store Connect API key (Users and Access → Integrations → Team Keys) with the **Admin** role: Xcode's automatic signing uses the key to create the distribution certificate and profiles, which lesser roles may not do. Download the `.p8` once.
3. In the GitHub repository create the environment **`ios-testflight`**, restricted to `v*` tags like the two signing environments, with four secrets: `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_PRIVATE_KEY` (the whole `.p8` text) and `APPLE_TEAM_ID`.
4. Set the repository variable `TESTFLIGHT_ENABLED` to `true`. Optionally set `TUPIES_REQUIRE_TRANSFER` to `YES` to build the transfer variant described in the [Apple README](../apps/apple/README.md).
5. Add yourself as an internal tester in TestFlight. Internal testers get each build as soon as Apple has processed it, without review. A public link for other people needs Apple's beta review once; put that link in `assets/updates/native-apps.json` as `ios.testflightURL` and the app's update card opens it.

Things that change when the phone moves from an Xcode build to TestFlight:

- **Push notifications** use Apple's production service. Set `STUDIO_APNS_ENVIRONMENT=production` and `STUDIO_APNS_TOPIC=dev.tupies.app` on the home server, then switch notifications off and on again on the phone so it registers afresh.
- **Builds expire after 90 days.** Upload a new one before then, even without changes: Actions → Release → Run workflow, choosing the tag.
- **Build numbers are single-use.** Apple refuses a number it has seen; `--check` in CI already prevents reusing one.
- The upload job is written against Apple's documented `xcodebuild -exportArchive` upload and has compiled and archived unsigned on this project, but it has **not yet run with real credentials**. Treat its first run as the test.

## Changing the required check

The `main` ruleset currently requires the check `linux-container`, the old name of the container job. After the pull request that introduces this pipeline is green, change the required check to **`CI passed`** (Repository → Settings → Rules → Protect main → Require status checks), then merge.
