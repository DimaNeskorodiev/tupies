# iPhone notifications

The notification implementation is in source and verified with fixtures. **Activation is pending Apple setup:** no notification-enabled build is installed and no real APNs delivery has been tested yet. The currently installed iPhone app remains build 2. The owner chose to finish Apple Developer/Xcode sign-in later.

Tupies uses Apple Push Notification service (APNs) for native alerts about bot replies and routine updates. The home server sends the alert, so the iPhone app does not need to stay open or poll in the background. A standalone engine can send its own alerts; a linked replica leaves delivery to the home server.

The notification is a private summary. Apple receives the app's push token, delivery timing and opaque routing IDs, plus generic text such as “A bot has replied.” Bot names, message text, routine prompts, files and provider credentials stay on your engines. Tapping an alert opens the corresponding conversation in an already paired engine. An alert cannot approve an action, send a message, run a routine or pair a new engine.

## Apple setup

Use the Apple Developer team that signs `dev.hermesstudio.app`. An Apple Developer account with access to Certificates, Identifiers & Profiles is required; creating an APNs key requires the Account Holder or Admin role.

1. Add the developer account in **Xcode → Settings → Accounts**, then enable **Push Notifications** for the explicit app identifier. The native project declares the capability; a signed build needs a provisioning profile that includes it. A wildcard profile cannot receive push notifications. Xcode can manage the explicit profile after the account is signed in; a manually created matching profile is another option.
2. In **Certificates, Identifiers & Profiles → Keys**, create an **Apple Push Notification service** key. Prefer a topic-specific key restricted to `dev.hermesstudio.app` and the environment you will actually use.
3. For a development-signed build installed directly from Xcode, select **Sandbox**. For TestFlight or App Store distribution, use **Production**. The app, key, server setting and provisioning entitlement must agree.
4. Download the `.p8` key once and protect it. Record its Key ID and your Team ID privately. Apple does not let you download the same private key again.
5. Put the key on the home server outside bot workspaces, synced folders, the public directory and release archives. Its file should be readable only by the engine's service account, with a private parent directory. Never paste its contents into chat or commit it.

Apple's references: [create a private key](https://developer.apple.com/help/account/keys/create-a-private-key/), [APNs authentication keys](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), and [register an app for remote notifications](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns).

## Configure the engine

Set these operator variables on the delivery engine. Values below are placeholders:

```dotenv
STUDIO_APNS_KEY_FILE=/private/operator/path/AuthKey.p8
STUDIO_APNS_KEY_ID=YOURKEYID1
STUDIO_APNS_TEAM_ID=YOURTEAMID
STUDIO_APNS_TOPIC=dev.hermesstudio.app
STUDIO_APNS_ENVIRONMENT=sandbox
```

`npm start` reads an optional `.env`. A systemd service must receive the variables through its private environment file or service configuration. A container needs explicit environment entries and a read-only mount for the key; it must not bake the key into its image. Changing these variables requires an engine restart, so check active tasks and preserve the complete data tree first.

The provider connects only to Apple's fixed sandbox or production HTTP/2 endpoint with normal TLS validation. No third-party relay or runtime dependency is required. Missing or invalid configuration leaves push unavailable and does not prevent normal bot work. A key for the wrong environment cannot deliver to the installed app's token.

## Enable alerts on the iPhone

In the native app, open **Settings → Notifications**. Choose the paired delivery engine, enable notifications, and allow Apple's notification permission prompt. Bot replies and routine updates have separate switches. The app requests a fresh APNs registration on launch and uploads the token over the engine's existing authenticated, pinned connection.

Only the paired iPhone/iPad's bearer session can manage its registration. The web interface and models cannot register another device or change the Apple destination. Re-pairing, token changes, revocation and disabling notifications invalidate obsolete registrations. iOS notification settings can also disable banners and sounds; the app links to those settings when permission is denied.

## Delivery behavior

Alerts are generated from committed final direct-chat and team-room replies, completed/failed/interrupted routine tasks and confirmed admission errors, not from streaming tokens or inferred progress. Private teammate work and messages belonging to other people's Telegram sessions are excluded. Existing history is baselined and per-kind enrollment boundaries exclude events observed before enablement. Late imports older than five minutes before enrollment are excluded; the small allowance accommodates engine clock skew. The native app suppresses an alert only when the matching authenticated conversation is visible in the foreground with no dialog covering it.

Registration tokens are sealed with the engine's vault key in a separate `notifications.json` file. Registrations, delivery intentions and cursors are local to that engine and do not enter workspace sync or the public state API. Include this file in a complete private backup, alongside the vault key. Keep the operator's APNs key protected separately; it does not sync.

The engine retains at most 10,000 recent seen IDs, 1,000 delivery intentions and 1,000 unclassified reply records, with a 24-hour event/delivery horizon. Explicit temporary APNs refusals retry at most five times with backoff (at least 15 minutes after server errors). A dispatch whose network outcome is ambiguous is recorded as unknown rather than replayed on restart. This avoids replaying an alert that Apple may already have accepted; it also means that an uncertain alert can be missed. Delivery status is not proof that a person saw an alert. Apple, Focus modes, connectivity and the phone's notification settings affect presentation.

Corrupt, oversized or symlinked notification metadata disables only push delivery and is preserved for operator recovery; normal bot work still starts. Selecting another delivery engine attempts to remove the old registration and retries failed removal on a later foreground session. The normal linked Mac/home-server arrangement has one sending authority; two independent offline engines may temporarily retain separate registrations until cleanup succeeds.

## Verify an installation

After the signed app and configured engine are installed, enable notifications on the physical iPhone, put the app in the background, and finish a bot task and a deterministic routine. Check that each alert arrives once and opens the correct engine/conversation. Also check the foreground conversation, disabled categories, token refresh and device revocation. Fixture tests and simulator payloads establish protocol and routing behavior; only a real APNs test establishes delivery to the phone.
