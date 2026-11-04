# Mac distribution

Updater-enabled releases pin Sparkle 2.10.1 and the public beta feed/key in `assets/updates/release-channels.json`. Default `prepare` uses those values; `--update-feed`/`--update-public-key` override a separately reviewed channel. Final assembly refuses missing feed/key or unsigned-feed/pre-extraction policy. Framework/helpers are re-signed before the containing app. After notarization, attach the final DMG to the draft GitHub release before publishing: the Mac release workflow verifies it and advances the signed feed. Configure its `mac-updates` environment first. See [Automatic updates](updates.md). Existing frozen DMGs remain unchanged.

The user-facing route is [Install Tupies](setup/install-the-apps.md). This maintainer workflow does not install over an operational app, restart an operational engine, read provider credentials or copy user data.

## Prepare

Use an isolated, recorded source snapshot with rebuilt assets, guide and notices, and complete regressions on official checksum-pinned Node 22.23.4. Exclude unrelated mutable work. The engine packager independently checks the official runtime archive and installs fresh locked production dependencies with lifecycle scripts disabled.

From that snapshot on Apple Silicon:

```sh
node scripts/release-macos.mjs prepare --output /absolute/new-release-directory --build-number 12 --node-archive /absolute/node-v22.23.4-darwin-arm64.tar.gz --checksums /absolute/SHASUMS256.txt --npm-cli /absolute/trusted/npm-cli.js
```

Choose a build number above the last distributed build. Output includes the standalone app, exact manifests, private logs, `release.json` and **Tupies-UNSIGNED.dmg**. That image is an internal candidate. Never launch an unsigned stable-identity app against the owner's preferences or Keychain.

## Sign and notarize

A locally available **Developer ID Application** certificate and private key are required; Apple Development is refused. Use the account holder's normal Xcode workflow if a certificate is missing. Preserve existing certificates/profiles. Never export private keys or put credentials in source, logs or command arguments.

```sh
node scripts/release-macos.mjs sign --output /absolute/release-directory --identity DEVELOPER_ID_CERTIFICATE_SHA1 --provisioning-profile /absolute/Tupies-Developer-ID.provisionprofile
```

Tupies uses the restricted Keychain access-group entitlement, so a matching **Developer ID provisioning profile** is mandatory. The signer verifies all-Mac scope, platform, expiry, certificate identity, team, exact app identifier and Keychain authorization, then embeds that profile. It derives the App ID prefix from the profile, signs native libraries, applies JIT only to Node, and verifies the hardened app. Native pairing must still verify actual data-protection Keychain access; signature verification alone is insufficient. See Apple's [provisioning-profile explanation](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).

Store notarization credentials locally using Apple's interactive `xcrun notarytool store-credentials` workflow, or use signed-in Xcode Organizer. The CLI takes only the Keychain profile name. Account entry, two-factor approval and new certificate/key creation belong to the authorized operator workflow.

The signed disk image can be prepared before credentials are available:

```sh
node scripts/release-macos.mjs package --output /absolute/release-directory
```

```sh
node scripts/release-macos.mjs notarize --output /absolute/release-directory --profile tupies-notary
node scripts/release-macos.mjs finish --output /absolute/release-directory --profile tupies-notary
```

The final DMG is timestamp-signed with the same Developer ID identity before submission. `notarize` prepares it automatically if `package` was omitted, verifies exact image bytes and validates credentials before upload. Authentication failure retains the prepared image; once upload starts, an uncertain submission remains blocked until its private log and Apple history are inspected. Successful submission saves Apple's request ID. `finish` checks without resubmitting. Only **Accepted**, successful stapling/validation and Gatekeeper assessment set `distributable: true` and produce `SHA256SUMS`. Keep the final DMG bytes unchanged.

Apple references: [Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates), [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [custom workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

## Acceptance and publication

Record separately:

1. Frozen-source complete Engine regressions, syntax, asset/guide/notices builds and Swift logic/build checks.
2. Exact packaged runtime on temporary data: native dependency load, empty workspace, authenticated provider setup, actual Engine chat/document creation, stop/restart and a second copied runtime opening the same data. Compare identity, vault, synthetic provider and artifacts. Synthetic providers establish mechanics only.
3. Exact final downloaded DMG on a clean Apple Silicon Mac without Node/source: quarantine/Gatekeeper, drag-install, native first launch and Keychain pairing, real provider authorization, chat, document download, quit/relaunch and app replacement preserving data. Test supported macOS versions. Temporary folders on the maintainer Mac are not a clean-machine test.
4. Record actual provider/model and human outcome without tokens, account identifiers or transcripts. The colleague uses their own provider. Never seed a package from the owner's workspace.
5. Publish only the accepted DMG, checksum and truthful release notes with version/build, architecture and minimum macOS. Exclude private logs, account data and credentials. Disclose outstanding clean-Mac or real-provider acceptance; never claim those gates passed from synthetic checks.

Versions before beta 2 update by replacing the app after active tasks finish and Tupies quits. Beta 2 includes signed Sparkle updates; existing testers replace the app once to enable them. Data stays outside the bundle. Operational installation and source rollback with current data retain their own preservation checks.
