# Move your Mac workspace to a server

**You have:** Tupies on your Mac, with bots, chats, memory and files you want to keep.
**You want:** Tupies on your VPS as well, always on, with all of that, and your phone using the server.

## How it works

You install a **fresh** Tupies on the server and **link** your Mac to it. The server becomes your **home server**. Your Mac uploads its whole workspace to it, and from then on the two stay in sync within a second or two. Your Mac keeps a full copy and keeps working, even offline.

A fresh server's starter bots never overwrite yours: on the first link, your Mac's data wins.

Don't copy your Mac's data folder to the server. Each engine has its own identity and keys, and a copied folder makes two engines claim to be the same one. Linking is the supported way to move.

### What moves and what stays

| Moves to the server | Stays only on the Mac |
| --- | --- |
| Bots and their settings | Your workspace password (the server gets its own, and doesn't need one) |
| Every chat, including each bot's model history | The activity log and run history |
| Memory and long-term notes | Tasks in progress and pending approvals |
| Skills and each bot's files | Websites bots signed in to in their browser (sign in again on the server if bots browse there) |
| Rooms and routines | Approved tools' private settings folders |
| Model providers, API keys and your ChatGPT sign-in (encrypted between your engines) | iPhone notification registrations (turn notifications on again for the server) |
| Integrations and Telegram settings | Files over 64 MB, `.git` folders, `node_modules` and temporary files |

After the move, **routines and Telegram run only on the server**, so nothing runs twice. The server also renews your ChatGPT sign-in. A bot works on one engine at a time.

## What you need

- A Linux VPS running Debian or Ubuntu, with at least 1 GB of memory (2 GB is more comfortable), a public IP address and SSH access with `sudo`.
- **Port 443** open to the internet, both in your cloud provider's firewall and on the server.
- Your Mac's Tupies, and the **same Tupies version** for the server. Steps below copy it straight from your Mac's Tupies folder.

The examples use `203.0.113.5` as the server's public IP and `you@203.0.113.5` for SSH. Replace both with yours.

## Step 1: Back up your Mac

1. Let any bot that's working finish.
2. Stop Tupies. If it runs in Terminal, press Control-C there. If the Mac app runs its built-in engine, open the app's Settings and choose **Stop Engine**.
3. Make a backup. If you run Tupies from a folder such as `~/Tupies`:

   ```sh
   cd ~/Tupies
   mkdir -p "$HOME/TupiesBackups" && chmod 700 "$HOME/TupiesBackups"
   npm run runtime:backup -- create --source "$PWD/data" --target "$HOME/TupiesBackups/before-server-$(date +%Y%m%d)"
   ```

   If your `.env` sets `STUDIO_DATA_DIR`, use that folder as `--source`. If you use the Mac app's built-in engine, its data is in `~/Library/Application Support/Tupies/Engine/data`.

   The backup contains your encryption key and your data, unencrypted. Keep it private.
4. Start Tupies again.

## Step 2: Install Tupies on the server

Connect with `ssh you@203.0.113.5`. Every command in this step runs on the server, except 2.3, which starts on your Mac.

**2.1 Tools, a service account and folders.**

```sh
sudo apt update && sudo apt install -y curl xz-utils ca-certificates
sudo useradd --system --home-dir /var/lib/tupies --shell /usr/sbin/nologin studio
sudo mkdir -p /opt/tupies /var/lib/tupies/data
sudo chown -R studio:studio /var/lib/tupies
sudo chmod 700 /var/lib/tupies /var/lib/tupies/data
```

Tupies runs as its own account, `studio`, so it can't read anything else on the server.

**2.2 Node.js 22, checked against its official checksum.**

```sh
cd /tmp
NODE=v22.23.4
curl -fsSLO https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/$NODE/SHASUMS256.txt
grep " node-$NODE-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo mkdir -p /opt/tupies/node
sudo tar -xJf node-$NODE-linux-x64.tar.xz -C /opt/tupies/node --strip-components=1
/opt/tupies/node/bin/node --version
```

The checksum line must say `OK`. On an ARM server, use `linux-arm64` instead of `linux-x64`.

**2.3 Copy Tupies from your Mac.** On your **Mac**:

```sh
cd ~/Tupies
git archive --format=tar.gz -o /tmp/tupies-release.tar.gz HEAD
scp /tmp/tupies-release.tar.gz you@203.0.113.5:/tmp/
```

This packs the Tupies version you have, without your data, `.env` or installed libraries. Then, back on the **server**:

```sh
sudo mkdir -p /opt/tupies/app
sudo tar -xzf /tmp/tupies-release.tar.gz -C /opt/tupies/app
sudo chown -R studio:studio /opt/tupies/app
cd /opt/tupies/app
sudo -u studio env HOME=/var/lib/tupies PATH=/opt/tupies/node/bin:/usr/bin:/bin npm ci --omit=dev
sudo chown -R root:root /opt/tupies/app
cd /
```

The last `chown` hands the program files back to `root`, so the service can run them but not change them.

**2.4 Create the service.** Replace `203.0.113.5` with your server's IP, then run:

```sh
sudo tee /etc/systemd/system/tupies.service >/dev/null <<'EOF'
[Unit]
Description=Tupies
After=network-online.target
Wants=network-online.target

[Service]
User=studio
Group=studio
WorkingDirectory=/opt/tupies/app
Environment=STUDIO_HOST=0.0.0.0 STUDIO_PORT=443 STUDIO_TLS=engine
Environment=STUDIO_DATA_DIR=/var/lib/tupies/data
Environment=STUDIO_PUBLIC_URL=https://203.0.113.5
Environment="STUDIO_ENGINE_NAME=Home server"
ExecStart=/opt/tupies/node/bin/node server.mjs
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/tupies
PrivateTmp=true
UMask=0077
MemoryMax=1200M

[Install]
WantedBy=multi-user.target
EOF
```

In plain words: Tupies listens on port 443 with HTTPS, using its own certificate. You don't need a domain name: your apps and your Mac trust the server because its key matches the server code in the pairing link.

**2.5 Open the port and start it.**

```sh
sudo ufw allow 443/tcp        # only if this server uses the ufw firewall
sudo systemctl daemon-reload
sudo systemctl enable --now tupies
sudo systemctl status tupies --no-pager
```

Status should say `active (running)`. Also allow port 443 in your cloud provider's firewall if it has one. The log (`sudo journalctl -u tupies -n 30 --no-pager`) shows a one-time setup token; you don't need it, because apps pair from the server's terminal.

Don't add bots, providers or chats on the server. Your Mac's workspace is about to arrive.

**2.6 Add a pairing shortcut.**

```sh
sudo tee /usr/local/bin/tupies-pair >/dev/null <<'EOF'
#!/bin/sh
cd /
exec sudo -u studio env STUDIO_DATA_DIR=/var/lib/tupies/data /opt/tupies/node/bin/node /opt/tupies/app/scripts/pair.mjs "$@"
EOF
sudo chmod 755 /usr/local/bin/tupies-pair
```

From now on, `tupies-pair` shows a QR code for an app and `tupies-pair --engine` prints a link for another engine.

## Step 3: Link your Mac to the server

1. On the **server**, run `tupies-pair --engine` and copy the link it prints. It works once, within 10 minutes.
2. On your **Mac**, make sure no bot is working. Open Tupies on this Mac (the app's **This Mac**, or the browser), go to **Settings › Devices & sync**, choose **Connect to a home server**, paste the link and choose **Connect**.
3. **Devices & sync** now shows **Home server** as linked. The Mac uploads its workspace; a large one can take a few minutes.

## Step 4: Connect your apps to the server

1. On the **server**, run `tupies-pair`. A QR code appears.
2. **iPhone:** in the Tupies app, open Settings, choose **Add Connection**, then **Scan QR code**. Check that the server code matches the one in the terminal and confirm. (A first-time app shows **Scan QR code** straight away.)
3. **Mac app:** run `tupies-pair` again for a fresh link (each one works once), copy it to the Mac, and in the app choose **Add Connection › Paste pairing link**.
4. Switch the app to **Home server** and look around: your bots, chats, memory, notes, files and routines should all be there.

Your phone now uses the server, which works even when your Mac is asleep. If you set up phone access to your Mac with [Mac and iPhone, no server](mac-and-iphone.md), you can leave it as it is.

## Step 5: Finish up

- **Routines.** Open **Routines** once. They now run on the server, and one that was due may run soon after the move.
- **iPhone notifications.** Set up the Apple push key on the server (see [iPhone notifications](../notifications.md)), then in the iPhone app's Settings, under **Notifications**, choose **Home server** as the **Delivery engine**.
- **Bots that browse the web on the server** need Chromium and two extra service settings. See [deployment](../deployment.md#native-service-with-the-engines-own-certificate).
- **A browser for the server.** From the internet, only paired apps can sign in. Use the apps; [deployment](../deployment.md) covers other ways in.
- **Keep the Mac linked.** It's a live copy that works offline. To stop it syncing, choose **Disconnect** in **Settings › Devices & sync** on the Mac. It keeps its copy and pauses its routines so they don't run twice.

**Updating the server later:** copy a new release the same way (step 2.3), run `npm ci --omit=dev` again as `studio`, hand the files back to `root` and run `sudo systemctl restart tupies`. Your pairings and links keep working. Update the Mac and the server together.

## If something goes wrong

| What you see | What to check |
| --- | --- |
| **Can’t reach https://…** when connecting the Mac | The IP in `STUDIO_PUBLIC_URL`, that port 443 is open in both firewalls, and `sudo systemctl status tupies`. |
| **Update both engines before linking.** | The Mac and the server run different versions. Copy the Mac's version to the server again (step 2.3). |
| **Other engines sync through this one.** | Other engines are linked to your Mac. It can't also link to the server. |
| **Wait for active tasks … to finish** | A bot is still working on the Mac. Let it finish and try again. |
| `tupies-pair` says Tupies is not running | Check `sudo systemctl status tupies` and the log with `sudo journalctl -u tupies -n 50 --no-pager`. |
| The service won't start and the log says permission denied | The data folder must belong to `studio`: `sudo chown -R studio:studio /var/lib/tupies`. Never delete files in `/var/lib/tupies/data` to fix a start-up error. |
