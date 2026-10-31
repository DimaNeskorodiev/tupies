# Install the Tupies apps

The Mac and iPhone apps aren't on the App Store or TestFlight yet. For now you build them from the Tupies source with Xcode. The apps are optional on a Mac: a web browser works on the computer that runs the engine. On an iPhone, the app is the way to use Tupies.

## What you need

- A Mac with **Xcode 16 or newer**.
- Xcode signed in to an Apple account that belongs to an **Apple Developer Program team** (Xcode › Settings › Accounts). The iPhone app uses push notifications, which free Apple accounts can't sign.
- Your **team ID**: 10 letters and digits, shown in Xcode › Settings › Accounts or on developer.apple.com under Membership.
- The Tupies source:

  ```sh
  git clone https://github.com/DimaNeskorodiev/tupies.git ~/Tupies
  cd ~/Tupies
  ```

The project uses the app identifier `dev.tupies.app`, which belongs to the Tupies maintainer's Apple team. If you build with that team, nothing needs changing. Apple won't let another team use the same identifier, and building under a different identifier hasn't been tested yet, so ask the maintainer first if you're on a different team.

If this Mac or iPhone already has the older **Hermes Studio** app, don't install over it. Follow the transfer steps in the [Apple app guide](../../apps/apple/README.md#moving-existing-pairings-to-the-tupies-identifier) so your existing pairings move across.

## Mac app

From the Tupies folder, replace `<team ID>` and run:

```sh
xcodebuild -project apps/apple/Tupies.xcodeproj -scheme Tupies -configuration Release \
  -destination 'platform=macOS' -derivedDataPath apps/apple/build/DerivedData-mac \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<team ID> build
ditto apps/apple/build/DerivedData-mac/Build/Products/Release/Tupies.app /Applications/Tupies.app
```

`-allowProvisioningUpdates` lets Xcode register this Mac with your team the first time. Open **Tupies** from Applications.

This build doesn't carry its own engine. When you want an engine on this Mac, start it from the Tupies folder with `npm start` and the app connects to it. (The all-in-one Mac app with a built-in engine needs an extra packaging step; see the [Apple app guide](../../apps/apple/README.md#build-4-security-and-bundled-engine-migration).)

## iPhone app

1. Connect the iPhone to the Mac with a cable, unlock it and tap **Trust**.
2. Find the iPhone's device ID:

   ```sh
   xcrun devicectl list devices
   ```

3. Build and install it, replacing `<device ID>` and `<team ID>`:

   ```sh
   xcodebuild -project apps/apple/Tupies.xcodeproj -scheme Tupies \
     -destination 'id=<device ID>' -derivedDataPath apps/apple/build/DerivedData-device \
     -allowProvisioningUpdates DEVELOPMENT_TEAM=<team ID> build
   xcrun devicectl device install app --device <device ID> \
     apps/apple/build/DerivedData-device/Build/Products/Debug-iphoneos/Tupies.app
   ```

4. The first time, the iPhone asks you to turn on **Developer Mode** (Settings › Privacy & Security › Developer Mode) and restarts. Turn it on, then run the install command again.
5. Open Tupies on the iPhone. It shows **Connect to your Tupies** with **Scan QR code** and **Paste pairing link**. Your scenario guide says what to scan.

Prefer Xcode's window? Open `apps/apple/Tupies.xcodeproj`, choose your team under Signing & Capabilities for both the **Tupies** and **NotificationService** targets, pick the iPhone at the top and press Run. Don't commit the team change; the shared project keeps it empty.

## Updating the apps

Pull the new source and run the same commands again. Your pairings stay, because they live in the device's Keychain. Update the apps together with your engines: when an engine is too old for the app, the app shows **Update required** until you update that engine.
