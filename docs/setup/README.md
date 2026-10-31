# Set up Tupies and sign in

These guides take you from nothing to signed in, step by step. Pick the one that matches where you are:

| Where you are | Guide |
| --- | --- |
| Tupies already runs on your server and one Mac, and you want to add another Mac | [Add another Mac](add-another-mac.md) |
| You're new and want Tupies on your Mac and iPhone, with no server yet | [Mac and iPhone, no server](mac-and-iphone.md) |
| You've used Tupies on your Mac and want to move it to your server, keeping everything | [Move your Mac workspace to a server](move-to-a-server.md) |

All three use the same Mac and iPhone apps. [Install the apps](install-the-apps.md) explains how to get them.

## How signing in works

Four words come up everywhere:

- **Engine.** The Tupies program that does the actual work. It runs the bots and stores chats, memory and files. It runs on your Mac, your server, or both.
- **Home server.** When you have more than one engine, one always-on engine (usually a VPS) is the hub. The others keep a full copy of the workspace and sync through it within a second or two.
- **App.** The Tupies app for Mac and iPhone. It shows an engine; it doesn't hold the workspace itself.
- **Pairing.** How an app signs in to an engine.

Tupies has no usernames. There are two ways in:

1. **Pair the app (the main way).** The engine shows a QR code or a pairing link. You scan or paste it in the app once. The app creates its own key, which never leaves the device (it lives in the Secure Enclave on iPhones and Apple-silicon Macs), and signs in with it from then on. There's no password to type, and the app stays signed in.
2. **Workspace password (for web browsers).** The first time an engine starts, it prints a one-time setup token in its terminal. You use the token once to choose a password of at least 12 characters. The password works in a browser on the same computer, your home network, Tailscale or an SSH tunnel. From the open internet, only paired apps can sign in unless you turn on **Settings › Devices & sync › Sign-in from the internet**.

Each engine has its own password; passwords don't sync. Pair each app with each engine it should open. On a Mac, the app finds the engine running on that same Mac and connects by itself.

### Where pairing links come from

| You want to connect | Make the link with |
| --- | --- |
| An app (iPhone or Mac) | `npm run pair` in the engine's Tupies folder, or **Settings › Devices & sync › Pair a phone or Mac** in Tupies |
| Another engine (to sync with a home server) | `npm run pair -- --engine` on the home server, or **Settings › Devices & sync › Link another engine** while you're looking at the home server |

A pairing link works once and expires after 10 minutes. It contains no password, but anyone who uses it first gets in, so don't post it in chats or email. To move it between your own devices, use AirDrop or Universal Clipboard (copy on one Apple device, paste on another signed in to the same Apple account).

Whenever you pair, the app shows an 8-character **server code**. Check that it matches the code the engine shows. That's how you know the app is talking to your engine and not something pretending to be it.

## What syncs between engines

Bots and their settings, every chat, memory, long-term notes, skills, bot files, rooms, routines and model providers (keys travel encrypted) sync between linked engines. Each engine keeps its own password, running tasks, approvals, activity log and the website sign-ins bots made in their browser. Routines and Telegram run only on the home server, so nothing runs twice. Details are in [Engines, devices and sync](../sync.md).

## Rules that keep your data safe

- **Link engines; never copy a data folder to another computer.** Each engine has its own identity and keys. A copied folder makes two engines claim to be the same one.
- **One engine per data folder.** Don't start two copies of Tupies on the same folder (Tupies refuses anyway).
- **Back up before big changes.** [Operations](../operations.md#back-up) has the backup commands.
- **Run the same Tupies version on every engine** you link together.

## What you need

- **Node.js 22.16 or newer** on every computer that runs an engine. Releases are tested with 22.23.4.
- **The Tupies source**, from the Tupies repository.
- **Xcode and an Apple Developer team** to build the apps. See [Install the apps](install-the-apps.md).
- **A model provider**: an API key (OpenAI, Anthropic, OpenRouter, xAI and others) or a ChatGPT subscription. See [providers](../hermes-setup.md).
