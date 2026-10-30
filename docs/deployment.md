# Mac and VPS deployment

Tupies is the complete agent server. It needs Node.js 22.16 or newer, the pinned npm runtime libraries and access to the selected model/API services. Browser assets, PDF resources and fonts ship with the release; no runtime CDN, Codex installation, Hermes gateway or Python agent is required. Python/Bash are needed only for skills that explicitly use them.

## Native Mac/server

Install a release and start it with a private writable data path:

```sh
cd /path/to/tupies
npm ci --omit=dev
npm start
```

Use the included package-lock.json and keep the shipped public/ and assets/ directories together. If building from modified source, run `npm ci` and `npm run build` first; the full build requires development dependencies.

Run the server from the app directory. A Mac browser can use loopback directly. On a VPS, use a dedicated unprivileged account and keep Tupies bound to loopback. The sample [systemd service](tupies.service) assumes `/usr/bin/node`, `/opt/tupies` and `/var/lib/tupies`; adapt paths and account ownership before installing it.

Allow at least a 1 GB memory budget for document-enabled operation, with additional headroom for larger concurrent work. The sample service uses MemoryMax=1G. Document parsing/rendering runs at most two workers, each with a 256 MB V8 heap and a 25-second deadline; heap limits do not cap total native/buffer memory. A smaller service limit may terminate the process under load.

The service account needs its data directory, network access to configured providers and only the host files you intentionally expose. Approved scripts/terminal work as that account. Optional skill interpreters/dependencies must exist on that host.

For native iPhone alerts, configure APNs on the home server and grant notification permission in the signed app. Keep the Apple key outside release assets, bot workspaces and sync. See [iPhone notifications](notifications.md) for Apple setup, the five operator variables, environment matching and device verification. APNs uses outbound port 443; it does not add an inbound listener or relax Tupies's authentication or TLS pinning.

From your Mac:

```sh
ssh -N -L 4310:127.0.0.1:4310 user@your-vps
```

Open `http://127.0.0.1:4310`. The same-port tunnel also carries the ChatGPT loopback callback at `/auth/callback`. An engine serving its own certificate takes that callback on port 1455 while signing in; forward `1455:127.0.0.1:1455` instead (see [providers](hermes-setup.md#with-the-engines-own-certificate)). Obtain the first-start setup token through the private console/journal. Keep the Node control port off the public network.

## Container

```sh
docker compose config
docker compose up --build -d
docker compose logs studio
```

Compose publishes only host `127.0.0.1:4310`, uses a persistent data volume, and runs as UID/GID 1000 with dropped capabilities, no-new-privileges, resource limits, a read-only application filesystem and a small nonexecutable `/tmp` tmpfs. It does not mount a host home, Docker socket or another app's credential store.

The Node base image is pinned by digest. The image build installs locked dependencies, builds local browser assets/guide/notices, then removes development packages. Compose sets a 1 GB service memory limit; size the host with additional room for the operating system and peak work. Document workers retain their own deadline and heap guards inside that service budget.

The container includes Node, the document libraries/fonts, Python 3 and Bash for explicitly approved skill scripts. Additional third-party libraries are an operator-selected image extension; importing a skill does not install packages or run a setup hook. Refresh the base digest and operating-system packages deliberately when patching.

Containerized `127.0.0.1` points at the container. For an existing host-local Ollama/private service, deliberately configure a reachable private address and network/firewall boundary, or use a trusted HTTPS endpoint. Enable STUDIO_ALLOW_PRIVATE_HTTP only for a trusted private service. Public unencrypted HTTP and metadata/link-local destinations remain blocked. Do not publish unauthenticated model servers to solve container networking.

For a stronger boundary between untrusted code and credentials, use a separate execution sandbox. The approved process launcher is trusted host execution, not per-bot OS isolation. Container restrictions limit the service account's environment but do not isolate a script from the Tupies volume mounted to that same account.

## Home server and Mac, in sync

Run the always-on engine on the VPS and a full engine on your Mac; they keep one workspace in sync within a second or two. See [Engines, devices and sync](sync.md) for what syncs and how conflicts resolve.

Your phone talks only to the home server, and the Mac engine connects out to it, so neither depends on being on a particular network. Give the server one HTTPS address that works from anywhere:

- **The engine's own certificate (recommended, no domain).** Set `STUDIO_TLS=engine` and Tupies serves HTTPS itself with a certificate over its identity key. Apps and linked engines trust it because that key matches the fingerprint in the pairing QR code (the server code), not because a certificate authority vouches for it: no domain, DNS, Caddy or Let's Encrypt, and nothing for you to renew (Tupies issues itself a 46-day certificate over the same key and renews it weekly). Open one port (443 is the safest choice on restrictive Wi-Fi). Browsers show a certificate warning on this address; paired apps do not, and browser sign-in from the internet is off by default anyway.
- **Your own domain.** Point a DNS name such as `studio.example.com` at the VPS, allow ports 80 and 443, and use the [Caddy setup](#optional-https) below. Caddy obtains and renews the certificate automatically. Browsers trust it without a warning.
- **No domain: Tailscale Funnel.** Install Tailscale on the server only and run `tailscale funnel --bg 4310`. The server gets a public `https://<machine>.<tailnet>.ts.net` address. TLS ends on the server, so Tailscale's relays cannot read the traffic.
- **Private only: Tailscale.** `tailscale serve --bg 4310` keeps the engine off the internet; every device then needs the Tailscale app.

Then set, in Tupies's `.env` or the compose environment. With the engine's own certificate on a server whose address is `203.0.113.5`:

```dotenv
STUDIO_TLS=engine
STUDIO_PUBLIC_URL=https://203.0.113.5
STUDIO_ENGINE_NAME="Home server"
# Compose: publish the container to the internet on 443
STUDIO_PUBLISH=443
```

Run natively, Tupies needs `STUDIO_HOST=0.0.0.0` and `STUDIO_PORT=443` (with permission to bind it, for example systemd's `AmbientCapabilities=CAP_NET_BIND_SERVICE`) or another open port in `STUDIO_PUBLIC_URL`. An engine serving its own certificate speaks TLS 1.3 only and trusts no proxy for client addresses. For ChatGPT sign-in it opens a temporary callback listener on the server's 127.0.0.1:1455, which never faces the internet; reach it through `ssh -N -L 1455:127.0.0.1:1455`. Behind a domain and Caddy instead, set `STUDIO_PUBLIC_URL=https://studio.example.com` and leave `STUDIO_TLS` unset.

From the internet only paired apps can sign in. The workspace password works on private routes: the server itself, an SSH tunnel, your LAN or Tailscale. Pair from the server's shell instead of a browser:

```sh
npm run pair                  # a phone or the Mac app: scan the QR code shown in the terminal
npm run pair -- --engine      # a link to paste into Settings › Devices & sync → Connect to a home server
# With Docker: docker compose exec studio npm run pair
```

Scan the code with the Tupies app and check that it shows the same server code. On the Mac, paste the engine link into **Settings › Devices & sync → Connect to a home server**. The Mac engine continues to work offline and catches up when it reconnects; routines and Telegram channels run on the server. To use a browser over the internet as well, turn on **Settings › Devices & sync → Sign-in from the internet**; failed passwords are then limited per client, and password sign-in from the internet pauses for an hour after 50 failures.

Behind a proxy, Tupies takes the client address from the last `X-Forwarded-For` hop, and only when the connection comes from a trusted proxy: `STUDIO_TRUSTED_PROXY=loopback` (default; Caddy or Tailscale on the same host) or `private` (containers reached through Docker's network; compose sets this). A request for the public host name that no trusted proxy vouched for counts as coming from the internet. Pairing links and engine links must use HTTPS, loopback or a Tailscale address. `STUDIO_ALLOWED_HOSTS` adds host names that may reach the engine directly, such as a Tailscale IP.

The internet sign-in policy depends on seeing each client's real address. Publish an internet-facing engine so that it does: run natively (the VPS setup below), or in Docker use `network_mode: host`, or rootful Docker with `"userland-proxy": false` and an IPv6-enabled network. Docker Desktop, rootless Docker's built-in port driver and the userland proxy (which IPv6 clients of an IPv4-only bridge go through) hand the container the bridge gateway's private address instead; the engine then treats internet clients as private (so password sign-in is offered to them) and all of them share one rate-limit bucket. A reverse proxy in front must overwrite `X-Forwarded-For` rather than pass on what the client sent. Link engines directly or through a TLS endpoint you operate, never through a third-party TLS-terminating tunnel or CDN: engine pairing exchanges the sync workspace key in a form that whoever terminates TLS could unwrap (see [Engines, devices and sync](sync.md)).

### Native service with the engine's own certificate

On a Linux server without Docker, run Tupies as its own account so it cannot read other software's files, with a hardened systemd unit. Install Node 22 under `/opt/tupies/node`, the release under `/opt/tupies/app` (root-owned; run `npm ci --omit=dev` as the `studio` account before handing ownership to root), then:

```ini
# /etc/systemd/system/tupies.service
[Service]
User=studio
WorkingDirectory=/opt/tupies/app
Environment=STUDIO_HOST=0.0.0.0 STUDIO_PORT=443 STUDIO_TLS=engine
Environment=STUDIO_DATA_DIR=/var/lib/tupies/data STUDIO_PUBLIC_URL=https://203.0.113.5
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
```

The read-only browser needs Chromium on the server (`sudo apt install --no-install-recommends chromium fonts-liberation` on Debian) and two settings beyond this unit. Chromium's sandbox needs user, PID and network namespaces for its renderers. Two browsers at once use about 235 tasks. Add them as a drop-in, so the unit itself keeps its hardening:

```ini
# /etc/systemd/system/tupies.service.d/browser.conf
[Service]
RestrictNamespaces=user pid net
TasksMax=512
```

Run `sudo systemctl daemon-reload`; the settings apply at the next restart. With `RestrictNamespaces=true` Chromium refuses to start ("No usable sandbox"). Tupies never turns the sandbox off unless `STUDIO_BROWSER_NO_SANDBOX=true` is set.

Allow the port in the server's firewall (for UFW: `sudo ufw allow 443/tcp`). Pair from the shell as the service account: `sudo -u studio env STUDIO_DATA_DIR=/var/lib/tupies/data /opt/tupies/node/bin/node /opt/tupies/app/scripts/pair.mjs` (add `--engine` for an engine link); a two-line wrapper such as `/usr/local/bin/studio-pair` makes that friendlier.

To update, copy the new release over `/opt/tupies/app` (run `npm ci --omit=dev` as `studio` when dependencies change, then give ownership back to root) and `sudo systemctl restart tupies`. Linked engines reconnect on their own and paired apps keep working, because the identity key in the data directory does not change.

## Optional HTTPS

A host Caddy example:

```caddyfile
studio.example.com {
    reverse_proxy 127.0.0.1:4310
}
```

Configure the exact allowed origin and secure cookies:

```dotenv
STUDIO_PUBLIC_URL=https://studio.example.com
STUDIO_SECURE_COOKIE=true
```

Keep Node bound/published to loopback and let the TLS terminator own public ports. Preserve Host/Origin and avoid wildcard CORS. Tupies does not infer its external identity from forwarded headers; it reads only the client address, and only from a trusted proxy (see above). Caddy replaces any client-supplied `X-Forwarded-For` with the real address by default. With secure cookies enabled, use HTTPS for workspace login. ChatGPT's local callback remains an HTTP loopback path validated by its OAuth state and should be reached through the same-port tunnel.

Public hosting and paid use of ChatGPT plan access have a separate OpenAI onboarding boundary. Set STUDIO_DEPLOYMENT_MODE=hosted and configure an approved client only after that onboarding. The local open-source registration flow is not an entitlement for a commercial remote service.

## Validate the actual deployment

Confirm login is required, only intended ports are reachable, provider model discovery works, a small actual task completes, exact approval denial/Stop behave correctly, and the complete encrypted backup restores. Test the selected provider, account, integration scopes and skill dependencies on the intended host. Local protocol fixtures and container smoke tests do not prove every live integration or production network configuration.


## Voice in browsers

Browser dictation uses localhost or HTTPS and microphone permission. An HTTP VPS address is not a suitable microphone origin; use your existing TLS reverse proxy or localhost SSH tunnel. The browser, rather than the VPS, provides speech recognition and synthesis. Browser speech-service availability and device voices vary; no Tupies audio service or paid audio API key is configured. The same-origin microphone Permissions-Policy allows this UI while camera and geolocation remain disabled. See [chat-controls.md](chat-controls.md).
