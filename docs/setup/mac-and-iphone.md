# Tupies on your Mac and iPhone, no server

**You have:** a Mac and an iPhone, and you're new to Tupies.
**You want:** Tupies running on the Mac, used from the Mac and from the iPhone app. No VPS for now.

Your Mac runs the engine, and the iPhone app connects to it over the network. Two things to know first:

- **The iPhone reaches Tupies only while your Mac is on, awake and online.** Routines also run only while the Mac is awake. If you later want Tupies available around the clock, add a server: [Move your Mac workspace to a server](move-to-a-server.md) keeps everything.
- **iPhone-to-Mac without a server hasn't been tested end to end yet.** These steps use the same certificate pinning and pairing as the tested server setup, but treat your first run as a trial.

## What you need

- A Mac with **Node.js 22** (22.16 or newer; install it from nodejs.org).
- The **Tupies app** on your iPhone, and on your Mac if you want it there. See [Install the apps](install-the-apps.md).
- A **model provider**: an API key, or a ChatGPT subscription.
- **Tailscale** (free) on the Mac and the iPhone, if you want the phone to work away from home. See part 2.

## Part 1: Tupies on your Mac

1. **Get Tupies and install it.** In Terminal:

   ```sh
   git clone https://github.com/DimaNeskorodiev/tupies.git ~/Tupies
   cd ~/Tupies
   npm ci
   cp .env.example .env
   ```

2. **Start it.**

   ```sh
   npm start
   ```

   Terminal shows `One-time setup token: …` and the address `http://127.0.0.1:4310`. Leave this window open: closing it stops Tupies.
3. **Choose your password.** Open `http://127.0.0.1:4310` in your browser, paste the setup token and choose a password of at least 12 characters. This is your workspace password for browsers.
4. **Connect a model.** Open **Settings › Models** and add an API key, or choose **Continue with ChatGPT** for a ChatGPT subscription. Then pick a default model.

   If you use ChatGPT, sign in now. ChatGPT sign-in needs this plain local address, which changes in part 2. Once you're signed in, Tupies renews the sign-in by itself.
5. **Try it.** Open a bot and send a message.

## Part 2: Let your iPhone reach the Mac

Pick how the phone gets to your Mac:

- **Tailscale (recommended).** Works at home and away, and nothing is opened to the internet. Install Tailscale on the Mac and the iPhone and sign in to the same Tailscale account on both. The Mac's Tailscale address starts with `100.`; copy it from the Tailscale menu on the Mac.
- **Home Wi-Fi only.** No extra app, but the phone works only on the same Wi-Fi as the Mac. If your router gives the Mac a new address, you'll need to update `.env` and pair the phone again. Find the Mac's address with `ipconfig getifaddr en0` in Terminal.

Then:

1. **Stop Tupies.** Let any bot that's working finish, then press Control-C in the Tupies Terminal window.
2. **Change the settings.** Open `.env` (`open -e .env`) and set these four lines. `.env` already has a `STUDIO_HOST=127.0.0.1` line: change it rather than adding a second one. Remove the `#` in front of the others and use your Mac's address from above:

   ```dotenv
   STUDIO_HOST=0.0.0.0
   STUDIO_TLS=engine
   STUDIO_PUBLIC_URL=https://100.101.102.103:4310
   STUDIO_ENGINE_NAME="My Mac"
   ```

   In plain words: listen for other devices, not just this Mac; use HTTPS with Tupies's own certificate (no domain needed, the apps trust it through the server code); this is the address the phone uses; this is the name the apps show.
3. **Start Tupies again** with `npm start`. If macOS asks whether `node` may accept incoming network connections, choose **Allow**.
4. **Show a QR code.** Open a second Terminal tab (⌘T) and run:

   ```sh
   cd ~/Tupies
   npm run pair
   ```

5. **Pair the iPhone.** In the Tupies app, choose **Scan QR code** and point the camera at the code in Terminal. Check that the **server code** in the app matches the one in Terminal, then confirm.

The iPhone opens your Tupies and stays signed in.

### On the Mac from now on

**The Mac app (optional).** Pair it using the Mac's own address, so it keeps working when Tailscale is off or the Wi-Fi changes:

```sh
npm run pair -- --url https://127.0.0.1:4310
```

Terminal adds a note that other devices can't reach this address. That's fine: this link is only for this Mac. In the Mac app, choose **Paste pairing link**, paste the link, check the server code and confirm. If you had already connected the Mac app during part 1, that old connection stops working after part 2; remove it in the app's Settings.

**A browser.** Tupies is now at `https://127.0.0.1:4310` (note the `https`). The browser warns that the certificate isn't trusted. That's expected: Tupies made its own certificate rather than getting one from a certificate authority. Continue to the site and sign in with your password. The apps don't show this warning, because they check the certificate against the server code.

## Keep it running

- Tupies stops when you close its Terminal window, log out or restart. Start it again with `cd ~/Tupies && npm start`. The iPhone reconnects by itself.
- Keep the Mac awake. On a MacBook, keep it plugged in and turn on **System Settings › Battery › Options › Prevent automatic sleeping on power adapter when the display is off**.

## Sign in to ChatGPT again later

ChatGPT sign-in doesn't work while `STUDIO_TLS=engine` is on. If you ever need to sign in again:

1. Stop Tupies and put a `#` in front of the `STUDIO_HOST`, `STUDIO_TLS` and `STUDIO_PUBLIC_URL` lines in `.env`.
2. Start Tupies, sign in at `http://127.0.0.1:4310`, then stop it again.
3. Remove the three `#` and start Tupies. Your paired iPhone and Mac app keep working.

## Notifications

The app works without notifications. To get iPhone alerts when a bot replies or a routine finishes, the engine needs an Apple push key. See [iPhone notifications](../notifications.md). With no server, that setup goes on this Mac's engine.

## If something goes wrong

| What you see | What to check |
| --- | --- |
| The phone says **Can’t reach** your Mac | The Mac is asleep or off, Tupies isn't running, Tailscale is off on one of the devices, or (Wi-Fi option) the phone isn't on the same Wi-Fi or the Mac's address changed. |
| Terminal says the link points at `http://127.0.0.1…`, which other devices can't reach | `STUDIO_PUBLIC_URL` isn't set. Check `.env` and restart Tupies. |
| The app says **Security check failed** | Something other than your Tupies answered at that address. Don't continue; check the address. |
| A browser says **Host is not allowed** | Use `https://127.0.0.1:4310` on the Mac, or the address in `STUDIO_PUBLIC_URL`. Tupies refuses other names and addresses for the Mac. |
| Port already in use when starting | Another Tupies is already running. Close it first; only one may use the data folder. |
