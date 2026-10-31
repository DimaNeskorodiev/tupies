# Add another Mac

**You have:** Tupies on your server (the home server) and on one Mac, already syncing.
**You want:** a second Mac, such as a new MacBook, connected to the same workspace.

Choose one:

- **A. Just the app (recommended).** The new Mac opens your home server. Bots run on the server, and everything is there at once. You only install the app. Works anywhere the Mac has internet.
- **B. The app plus an engine on this Mac.** The new Mac also keeps a full copy of the workspace, works offline and can run bots here, for example for coding on this Mac's files. More setup. Do A first, then B.

## A. Just the app

1. [Install the Mac app](install-the-apps.md#mac-app) on the new Mac and open it. It shows **Connect to your Tupies**.
2. Get a pairing link from your **home server**, in one of two ways:
   - **From a device that's already connected,** such as the Tupies app on your other Mac or your iPhone. Switch to **Home server** first, then open **Settings › Devices & sync › Pair a phone or Mac** and copy the link. A link made while you're looking at your other Mac's own engine (**This Mac**) points at that Mac and won't work.
   - **From the server's terminal.** Over SSH, run `tupies-pair` if you set the server up with [Move your Mac workspace to a server](move-to-a-server.md). On a server set up another way, run `npm run pair` in its Tupies folder as the account that runs Tupies.
3. Send the link to the new Mac with AirDrop or Universal Clipboard. It works once and expires in 10 minutes.
4. On the new Mac, choose **Paste pairing link**, paste it and choose **Continue**.
5. Check that the **server code** in the app matches the one shown next to the link, then confirm.

The app opens your home server with all your bots and chats. It stays signed in; there's no password. To remove this Mac later, open **Settings › Devices & sync** on any engine and choose **Remove** next to its name.

## B. Add an engine on this Mac too

Do part A first. Then:

1. **Install Node.js 22** (22.16 or newer) from nodejs.org.
2. **Get the same Tupies version your home server runs.** Engines on different versions can mishandle each other's data, so don't link a newer or older copy. If you're not sure which version the server runs, check before you continue.
3. **Install it.** In Terminal:

   ```sh
   cd ~/Tupies
   npm ci
   cp .env.example .env
   ```

   Open `.env` (`open -e .env`), remove the `#` in front of `STUDIO_ENGINE_NAME` and give this engine a name you'll recognize, for example `STUDIO_ENGINE_NAME="MacBook Air"`.
4. **Start it.**

   ```sh
   npm start
   ```

   Leave this Terminal window open. Tupies prints a one-time setup token; you can ignore it for now (it's only for using a browser).

   Don't create bots, add model providers or chat on this engine yet. Its starter bots won't overwrite your real ones when you link, but anything new you create here gets merged into your shared workspace.
5. **Connect the app to it.** In the Tupies app, open **Settings** (⌘,) and, under **Local Engine**, choose **Use This Mac…**. The app finds the engine and connects; it appears as **This Mac**.
6. **Get an engine link from the home server.** Switch the app to **Home server**, open **Settings › Devices & sync › Link another engine** and copy the link. (Or, on the server, `tupies-pair --engine`.) Use **Link another engine**, not **Pair a phone or Mac**: this link is for an engine, not an app.
7. **Link.** Switch to **This Mac**, open **Settings › Devices & sync › Connect to a home server**, paste the link and choose **Connect**.
8. **Wait a minute.** Your bots, chats, memory, notes and files arrive. **Devices & sync** now shows your home server as linked.

Switch between **This Mac** and **Home server** in the app's server menu, or with ⌘1, ⌘2 and so on. A bot works on one engine at a time; if it's busy on the other one, the chat says so. Routines and Telegram keep running only on the server.

**Keeping the engine running.** The engine stops when you close its Terminal window or restart the Mac. Run `cd ~/Tupies && npm start` again; it catches up with everything it missed. While it's stopped, the app still reaches your home server.

**A browser on this Mac (optional).** Open `http://127.0.0.1:4310`, paste the setup token from the Terminal window and choose a password for this engine.

## If something goes wrong

| Message | What it means |
| --- | --- |
| This link pairs an app. On the home server, choose “Link another engine”. | You pasted an app link into **Connect to a home server**. Make an engine link instead (step 6). |
| Link engines from your home server. This engine already syncs with one. | You made the engine link on your other Mac. Make it while looking at **Home server**. |
| Disconnect from the current home server first. | This engine is already linked to a server. |
| Update both engines before linking. | The two engines run different versions. Install the same version as the server. |
| Can’t reach … Check the address and that the server is running. | The server is down, or this Mac can't reach its address. |
| Wait for active tasks … to finish before changing this engine’s sync connection. | A bot is still working on this engine. Let it finish and try again. |
| The pairing link is refused or expired | Links work once and for 10 minutes. Make a new one. |
