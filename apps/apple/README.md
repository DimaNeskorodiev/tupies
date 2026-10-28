# Tupies for iPhone, iPad and Mac

A native SwiftUI shell around the Tupies Engine's web UI, similar to the Home Assistant companion app. One multiplatform target (`dev.hermesstudio.app`) builds for iOS 17+ and macOS 14+.

The app adds what a browser tab can't:

- **Native pairing.** Scan the QR code (iOS), paste a `hermes-studio://pair?…` link, or open one from anywhere through the URL scheme. On a Mac, the app connects to the engine running on that Mac with no clicks.
- **Device keys in the Secure Enclave or Keychain.** There's no password to type, and the app stays signed in.
- **Several engines, one-click switching.** Each engine keeps its own live web view, so switching is instant and preserves page state. On the Mac you can also use ⌘1…⌘9.
- **Status at a glance.** A status dot per engine and a sync indicator (`GET /api/sync/status`). On the iPhone they live in the app's Settings (see below).
- **Local engine management on the Mac.** The app can start `node server.mjs`, show its log, and stop it when you quit, but only if the app started it.

The app loads the engine's web UI in a `WKWebView` after signing in with a single-use device ticket.

**iPhone navigation.** The web UI's phone layout is the iPhone app's interface: a floating tab bar (Dashboard, Bots, Team rooms, Routines), Settings in the top-right corner, and chats whose title switches bots. A small bridge connects it to the app:

- At document start the app's script sets `<html data-studio-app="ios">` (`"macos"` on the Mac).
- The page posts `{type: "chrome", ownsChrome: true}` to the `hermesStudio` message handler when it draws its own phone navigation, and `false` on the sign-in or error screens. While it is `true` (and the engine is loaded), the app hides its engine bar and lets the page run under the status bar; the page pads itself with `env(safe-area-inset-*)` (`viewport-fit=cover`). An engine running an older web UI never sends it, so the engine bar stays. It also comes back while the engine is connecting or unreachable.
- **Settings › the server row** (shown only inside the app) posts `{type: "app-settings"}`, which opens the app's Settings sheet. There, tap a server to switch to it (✓ marks the active one) or ⓘ for its details, as in Wi-Fi settings; the same sheet has the sync status, Reload and Add Connection. Pull down on any page to reload it.

Messages are accepted only from the engine's own origin in the main frame, and `app-settings` only from the engine on screen.

**Mobile refinement (27 October 2026).** Native 0.5.0 build 2 was installed in place on the owner's paired iPhone 15 Pro. Following the initial mobile-only home-server asset update, the mobile and Phase 2 vision release was deployed to both engines with complete protected backups and preserved workspace state. Build 2 was independently verified and relaunched to load fresh engine views. The phone UI now uses system typography, readable chat/forms and larger controls, with navigation motion, left-edge Back, draggable sheet grabbers and keyboard-aware composers. Return adds a newline on phones; Send or Cmd/Ctrl+Enter submits. Drafts stay only in the page's memory, separately per bot/room, and clear on sign-out or reload. The new `public/mobile.js` owns presentation and draft lifecycle; task execution and authorization remain in the engine. Deferred notification source is excluded from this rollout.

The iOS shell advertises `data-studio-haptics="true"` and accepts `{type:"haptic",style:"selection"|"light"|"success"|"warning"}` only from the active engine's own main frame while loaded. `StudioHaptics` limits feedback frequency and requires the app to be active. The web UI requests feedback for deliberate navigation/menu taps and accepted sends. `UIFontMetrics` supplies `--studio-text-scale` and a `studio:text-size` event on load, foregrounding and Dynamic Type changes. CSS owns safe-area padding; automatic WKWebView scroll insets are disabled. Native Settings/pairing sheets use standard grabbers, larger touch targets and reduced-motion transitions. Older engine pages simply ignore the new presentation hooks. Physical-device validation of keyboard transitions, haptics, VoiceOver and large accessibility text remains required; compile checks do not establish those behaviors.

## Native iPhone notifications (source, not activated)

Build 3 source includes an iOS Settings section for notification opt-in, bot-reply and routine-result switches, a delivery-engine selector and readable delivery status. `NotificationCoordinator` receives APNs callbacks, keeps its token only in memory, registers through the existing device bearer and suppresses foreground alerts for the matching authenticated bot/room view. A tap selects only an already paired engine and a validated bot/room route; pending navigation survives sign-in. Pushes cannot authorize actions.

The project has an iOS-only `aps-environment` entitlement: development in Debug, production in Release. This needs an explicit Push Notifications app identifier and matching provisioning profile; the owner's current wildcard profile cannot sign it. The signed-device build attempt reported no developer account in Xcode. Apple Developer/Xcode sign-in and the operator APNs key are deferred at the owner's request. The installed iPhone app remains build 2, and real closed-app delivery is unverified. See [iPhone notification setup](../../docs/notifications.md) for the Apple and server steps.

## Shared chat activity view

The browser, macOS and iOS load the same chat assets from the selected engine. The adaptive activity flow therefore lives in `public/activity-flow-model.js`, `public/thinking-waves.js` and `.css`, rather than a separate Swift renderer. It shows recorded actions, sources, bounded result values, visible plan steps and real teammate exchanges in a transparent graph, with tap/keyboard inspection and a compact streaming view. It does not expose private reasoning or invent missing results. System reduced motion uses a still composition; hidden and offscreen views pause animation. Returning to an engine dispatches the existing `studio:visible` event so its retained canvas can resume.

After updating an engine's web assets, reload its existing view to load them: **Reload** or ⌘R on macOS; pull down on the page or choose **Reload <engine>** in the app's Settings on iOS. Switching engines preserves each live web view and does not itself reload its assets. This feature needs no native rebuild; native build and device verification remain separate checks from browser verification. See [Activity flow](../../docs/chat-controls.md#activity-flow) for the shared controls.

## Layout

```
apps/apple/
├── Tupies.xcodeproj        # hand-written, Xcode 16+ synchronized folder (objectVersion 77)
├── Tupies/                 # every file here is compiled into the app automatically
│   ├── App/                      # @main app, root view, menu commands
│   ├── Models/                   # Connection, wire types, UI state enums
│   ├── Services/                 # PairingLink, SigningMessages, DeviceKeyStore, Keychain,
│   │                             # EngineClient, ConnectionStore, LocalEngine (macOS)
│   ├── Views/                    # Onboarding, Pairing, Main (switcher/sync), Settings, Web
│   └── Assets.xcassets           # app icon (generated from the web favicon mark), accent color
├── Config/                       # Info.plist (URL scheme, ATS) and macOS entitlements (not compiled)
└── Tests/                        # standalone logic checks (see below)
```

## Build and run

Requirements: Xcode 16 or newer (verified with Xcode 26.4.1 / Swift 6.3, with the project in Swift 5 language mode).

**Xcode:** open `apps/apple/Tupies.xcodeproj`, choose the `Tupies` scheme, choose *My Mac* or an iPhone simulator, and run. To run on a physical iPhone or iPad, set your team under *Signing & Capabilities*, or pass it on the command line as below.

**Command line** (DerivedData stays under `apps/apple/build/`, which is git-ignored):

```sh
# Compile-only checks (no signing)
xcodebuild -project apps/apple/Tupies.xcodeproj -scheme Tupies \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath apps/apple/build/DerivedData \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/apple/Tupies.xcodeproj -scheme Tupies \
  -destination 'platform=macOS' -derivedDataPath apps/apple/build/DerivedData \
  CODE_SIGNING_ALLOWED=NO build

# Run in the simulator. Build WITH the default ad-hoc signing: without it the
# simulator app gets no entitlements and the Keychain refuses to store device keys.
xcodebuild -project apps/apple/Tupies.xcodeproj -scheme Tupies \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath apps/apple/build/DerivedData-signed build
xcrun simctl boot "iPhone 17 Pro"; open -a Simulator
xcrun simctl install booted "apps/apple/build/DerivedData-signed/Build/Products/Debug-iphonesimulator/Tupies.app"
xcrun simctl launch booted dev.hermesstudio.app
xcrun simctl openurl booted 'hermes-studio://pair?v=1&url=…'   # test the URL scheme

# Run on a physical iPhone (paired with this Mac, Developer Mode on). The team stays out of
# the project file; -allowProvisioningUpdates lets Xcode create the provisioning profile.
xcrun devicectl list devices
xcodebuild -project apps/apple/Tupies.xcodeproj -scheme Tupies \
  -destination 'id=<device UDID>' -derivedDataPath apps/apple/build/DerivedData-device \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<team ID> build
xcrun devicectl device install app --device <device UDID> \
  "apps/apple/build/DerivedData-device/Build/Products/Debug-iphoneos/Tupies.app"
# Open a pairing link in the app without scanning; the app still asks to confirm the server code.
xcrun devicectl device process launch --device <device UDID> --terminate-existing \
  --payload-url 'hermes-studio://pair?v=1&url=…' dev.hermesstudio.app
# To see the system's TLS and networking messages, add:
#   --console --environment-variables '{"OS_ACTIVITY_DT_MODE":"enable"}'

# Install a signed Mac app (development signing: Gatekeeper accepts it on the Mac that
# built it, but it is not notarized for anyone else). When updating, quit the app and remove
# the old copy first; connections and keys stay in its preferences and Keychain.
xcodebuild -project apps/apple/Tupies.xcodeproj -scheme Tupies -configuration Release \
  -destination 'platform=macOS' -derivedDataPath apps/apple/build/DerivedData-mac \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<team ID> build
ditto "apps/apple/build/DerivedData-mac/Build/Products/Release/Tupies.app" "/Applications/Tupies.app"
open -a "/Applications/Tupies.app" 'hermes-studio://pair?v=1&url=…'   # pair another engine
```

**Logic checks:** `apps/apple/Tests/run-logic-tests.sh` compiles the pure Swift files (link parsing, fingerprints, signing messages) with a small harness. It then checks signatures in both directions against the engine's real `lib/sync/crypto.mjs`. No server, simulator or signing is involved. There is no XCTest target, because a test bundle would complicate the multiplatform project file.

**Native notification HTTP regression:** on macOS with Xcode, run `node apps/apple/Tests/notification-client.mjs`. It compiles the actual Swift client and checks registration, category preferences and disabling through a disposable engine, including bearer authentication and DELETE's JSON body. It uses a fake Apple transport and temporary data; it does not contact APNs or the real workspace. This explicit native check is separate from the portable `npm test` suite.

## How pairing works

1. The engine shows a QR code or link: `hermes-studio://pair?v=1&url=…&code=…&fp=…&name=…&kind=device`. `kind=engine` links (for engine-to-engine linking) are rejected with an explanation. The engine percent-encodes values; the app also accepts `+` as a space and reduces `url` to its origin.
2. The app shows **Connect to <name>?** with the host and the short security code (`ABCD EFGH`, the first 8 fingerprint characters, as shown by Tupies).
3. `GET /api/engine`: the app requires `product == "hermes-studio"` and requires both the advertised fingerprint and `base64url(SHA-256(publicKey))` to equal `fp` from the link. Any mismatch stops pairing with a security warning.
4. The app creates a new P-256 key for this connection and signs `hermes-studio/pair/v1\n<code>\n<publicKey>`. It calls `POST /api/pair` with its name and platform (`ios`/`macos`).
5. The engine's answer must carry the same identity and a valid `engineProof` over `hermes-studio/paired/v1\n<deviceId>\n<publicKey>`. Otherwise nothing is saved and the key is deleted.
6. To sign in, the app signs `hermes-studio/session/v1\n<deviceId>\n<ms timestamp>\n<nonce>` and calls `POST /api/device/session` to get a bearer token (about 1 hour). It refreshes 5 minutes before expiry, or once on a 401. It then calls `POST /api/device/web-ticket` and loads `/auth/device?ticket=…` in the web view.
7. After every page load the app checks `fetch('/api/auth')`, and a small injected script reports any 401 from the page's own API calls. Either way, the app signs the web view in again with a fresh ticket, at most 3 times in 2 minutes.

**On a Mac:** when the engine listens on loopback, it writes `~/Library/Application Support/Hermes Studio/local-engine.json`. On launch, if there is no "This Mac" connection yet, the app reads that file, checks the URL responds and pairs automatically. If the engine isn't running, choose **Use this Mac → Start Local Engine**. The app runs `node --env-file-if-exists=.env server.mjs` in the configured Tupies folder (default `~/Documents/Personal/hermes-studio`), using the first of `~/.local/bin/node`, `/opt/homebrew/bin/node` or `/usr/local/bin/node` by default. It never starts a second engine when one already answers `/api/engine`. For tests, set `HERMES_STUDIO_LOCAL_ENGINE_FILE` to read a different discovery file; this mirrors the engine's `STUDIO_LOCAL_PAIRING_FILE`.

## Security notes

- **Device keys.** Each connection gets its own P-256 key. With a Secure Enclave (Apple silicon Macs, iPhones, iPads, and the iOS 26 simulator) the private key never leaves the enclave; only an encrypted, device-bound handle is stored in the Keychain. Otherwise a software key is stored in the Keychain. Items use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so they never sync to iCloud or migrate in backups. Removing a connection deletes its key, token and website data.
- **Engine pinning.** The fingerprint from the QR code or link is checked against `/api/engine` and the pair response, and the engine must sign `engineProof` with that identity key. A server that only answers on the same address can't impersonate your engine during pairing.
- **Tokens.** Bearer tokens last about 1 hour and are kept in the Keychain, never in UserDefaults. The connections list in UserDefaults holds no secrets.
- **Revocation.** If the engine rejects the device (401 from `/api/device/session`), the app hides the page and wipes that connection's cookies and storage, then shows "This device was removed from <engine>. Pair again."
- **Web view isolation.** Each connection has its own `WKWebsiteDataStore`, so two engines on one host never share cookies. Links to other origins open in the system browser. The microphone and camera are granted only to the engine's own origin, and the OS still asks once.
- **Transport.** ATS allows plain HTTP, because self-hosted engines are commonly reached over `http://` on loopback, the LAN or Tailscale (where WireGuard encrypts traffic). The confirmation sheet warns when a link points at unencrypted HTTP outside loopback or Tailscale.
- **The engine's own certificate.** An engine with `STUDIO_TLS=engine` serves HTTPS with a self-signed certificate over its identity key. `ServerTrust` (used by `EngineClient` through a per-request `PinningDelegate`, and by the web view's authentication-challenge handler) accepts a certificate whose P-256 key hashes to the connection's fingerprint, and otherwise only normal system trust. A connection paired through its own key is stored with `pinnedTLS`, after which only that key is accepted. A mismatch shows "Security check failed: the server at <engine>'s address isn't the one you paired with" and nothing is sent. Verified in the iPhone simulator: pairing and the full web interface over pinned TLS, an impostor engine on the same address refused, and recovery when the real engine returned. Verified on a physical iPhone 15 Pro (iOS 27) against a home server on a VPS's public address, and in the Mac app (macOS 26.7), which holds that server next to its automatically paired local engine.
- **App Transport Security is off, on purpose.** `Config/Info.plist` sets only `NSAllowsArbitraryLoads`: ATS refuses a certificate that no authority issued even after `ServerTrust` has matched its key, which shows up as "Can't reach" (`-1200`, "system TLS Trust evaluation failed(-9802)"). Don't add `NSAllowsLocalNetworking` or another ATS exception: iOS then ignores `NSAllowsArbitraryLoads`, so engines on public addresses fail while `127.0.0.1` in the simulator still works.

## Limitations and open items

- **No signing or notarization yet.** `DEVELOPMENT_TEAM` is empty in the project (pass it on the command line for development builds). Running on a physical iPhone or iPad needs an Apple developer team. Distribution needs signing and notarization; neither is set up.
- **Unsigned Mac builds and the Keychain.** The Mac app is **not sandboxed**, because it starts a local `node` engine and reads the engine's discovery file. Unsigned or ad-hoc Mac builds can't use the data-protection Keychain, so they fall back to the login keychain. macOS may then ask for keychain access after each rebuild. A team-signed build uses the data-protection Keychain.
- **A force-quit Mac app leaves its engine running.** A local engine started by the app is stopped with SIGTERM on a normal quit. After a crash or force-quit, the child engine keeps running; the app finds it again on next launch.
- **Removing a connection unpairs the device.** While the app still has a valid session, it calls `DELETE /api/devices/{id}` before deleting the local key, so the engine (and every linked engine) forgets the device. If the engine is unreachable, remove the device under **Settings › Devices & sync** in Tupies.
- **iPhone shows one window at a time.** The app requests a single scene (iPad multi-window is off), because each engine's web view can live in only one window.
- **Downloads:** saved to `~/Downloads` on the Mac and offered through the share sheet on iOS.
- **Not covered yet:** activated push delivery (source exists, Apple setup is pending), widgets, Shortcuts, and the planned computer-use/device-action features.
