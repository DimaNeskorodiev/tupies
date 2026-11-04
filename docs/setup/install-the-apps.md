# Install Tupies

## Mac

Use an **Apple Silicon Mac (M-series) with macOS 14 or later**. The complete Mac app includes Tupies Engine, Node.js and its libraries. You do not need Terminal, Xcode, Homebrew or Docker.

**Beta status, 3 November 2026:** the first Apple Silicon package is Developer ID signed and Apple notarization is accepted. The GitHub prerelease is a draft while the colleague tests it on a clean Mac with their own provider. Public download is pending that acceptance. Use the final `Tupies.dmg`; `Tupies-UNSIGNED.dmg` remains an internal intermediate.

1. Download **Tupies.dmg** from [Tupies Releases](https://github.com/DimaNeskorodiev/tupies/releases).
2. Open it, drag **Tupies** into **Applications**, then eject the disk image.
3. Open Tupies from Applications. Choose **Use this Mac → Start my engine**.
4. Follow **Continue setup**. Connect your own eligible ChatGPT / Codex account, provider API key, or a separately configured local model. Test the connection and choose a default model.
5. Meet **Chief of Staff** and **Ops**. Choose an example task, edit it and press **Send**.

The app connects to its engine automatically. Your workspace starts with your own bots, chats and files. Cloud models need internet access and use your provider's limits and billing. Browser actions additionally require Chrome, Chromium or Edge. See [Getting started](../onboarding.md).

Closing the window keeps Tupies running. **Quit (⌘Q)** stops the engine started by the app. Keep the Mac awake for routines and background tasks. A home server is optional and can be added later.

### Update manually

1. Finish or stop active tasks and keep a protected workspace backup; see [Backups & operations](../operations.md).
2. Quit Tupies with **⌘Q**.
3. Download the new notarized disk image and replace Tupies in Applications.
4. Open it again. Your saved connection, bots, chats and files should remain.

The app and its bundled engine update together. Data lives separately in `~/Library/Application Support/Tupies/Engine`; do not delete this folder when replacing the app. Updates must retain the signing team and Keychain group. Older development/legacy installations need the [maintainer migration guide](../../apps/apple/README.md), not an unreviewed replacement. The existing beta DMG has no automatic updater. The next updater-enabled release adds **Check for Updates…** and automatic downloads with installation on safe quit; existing testers install it manually once. See [Automatic updates](../updates.md). Do not roll back by restoring old user data.

If macOS reports an unverified developer or a damaged app, obtain the official notarized release and report its version. Do not disable Gatekeeper or strip quarantine attributes as an installation step.

## iPhone

The iPhone app is not yet available through TestFlight or the App Store. Current iPhone installations require a maintainer-supported signed Xcode build and pairing with your engine. See the [Apple developer guide](../../apps/apple/README.md#build-and-run). Installing the Mac app does not install the iPhone app or expose your Mac to the internet.

## Developers

Source builds and signing commands are in the [Apple developer guide](../../apps/apple/README.md#build-and-run). The [Mac release runbook](../macos-release.md) covers the complete payload, distribution signing, notarization and acceptance. For the browser-only source workflow, use [Development](../development.md#run-locally).
