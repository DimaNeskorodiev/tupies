# Private SearXNG fallback

The owner chose self-hosted SearXNG as DuckDuckGo's independent fallback on 28 October 2026. Tupies remains a standalone Node engine; SearXNG is an optional separate service reached through an assigned integration. These files prepare a private deployment. They do not install Docker, start a service, change the firewall or configure a live bot automatically.

## Prepared configuration

`deploy/searxng/compose.yml` uses the official SearXNG container, requires an explicitly selected immutable image digest and random secret, and binds **only `127.0.0.1:8888`** on the engine host to container port 8080. `settings.yml` enables JSON and limits the upstream engines to Bing, Google, Brave and Wikipedia, excluding DuckDuckGo so the fallback does not simply repeat the failed provider. Upstream availability and policies still apply; SearXNG sends the query to those configured engines.

This is a single-owner loopback service. The public-instance limiter is off; no Valkey service is needed for that configuration. Do not reuse this template as a public anonymous search server. A separately protected HTTPS deployment needs authentication, proxy/rate-limit configuration and a deliberate operator setup.

## Activate deliberately on the engine host

Use a dedicated directory outside the checkout for private configuration, for example `/opt/tupies-search` on the VPS. Copy `compose.yml`, `settings.yml` and `.env.example` from `deploy/searxng/` into it, then work in that directory. Keep it separate from Tupies's data, keys and backups.

Choose and review an official release tag. The official container documentation lists `docker.io/searxng/searxng` and its GHCR mirror. Resolve the chosen image locally to its digest; do not use a made-up digest or leave production on `latest`:

```sh
docker pull docker.io/searxng/searxng:YOUR_REVIEWED_RELEASE_TAG
docker image inspect --format '{{index .RepoDigests 0}}' docker.io/searxng/searxng:YOUR_REVIEWED_RELEASE_TAG
```

Create `.env` with private permissions. Put the inspected image reference in `SEARXNG_IMAGE`; generate the secret locally without printing it into chat or source:

```sh
umask 077
cp -i .env.example .env
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { appendFileSync } from "node:fs"; appendFileSync(".env", "\nSEARXNG_SECRET=" + randomBytes(32).toString("hex") + "\n", {mode:0o600});'
```

Edit `.env` to set `SEARXNG_IMAGE` to the inspected digest and remove the earlier blank `SEARXNG_SECRET=` line, leaving the generated one. Do not regenerate an existing service's secret as part of routine updates. The file remains private and ignored by Git.

Validate before activation; `config --quiet` avoids displaying the secret:

```sh
docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d
```

After startup, test from the same host as the Tupies engine with a generic public query:

```sh
curl --fail --get --max-time 15 \
  --data-urlencode 'q=Node.js documentation' \
  --data 'format=json' --data 'safesearch=1' --data 'pageno=1' \
  http://127.0.0.1:8888/search
```

A valid response has a `results` array. Also inspect `unresponsive_engines`: an empty result list with upstream failures is partial coverage, not proof of no matches.

## Verified disposable smoke test

On 28 October 2026, the existing Docker Engine 29.5.2 ran these settings in a uniquely named temporary project, with a generated private secret, random loopback-only host port and restart disabled. The official image was `docker.io/searxng/searxng@sha256:268a4b460136dcefc8f2e896b6098ba3f770c8218dbbddcb86811b06b06816f1`, version `2026.10.28-c360868e5` (revision `c360868e5b7c01e463a362a53518190d5a3b1097`).

`GET /healthz` returned 200. The JSON request above returned 200 in 926 ms with 24 candidates; Tupies normalized five public HTTPS results. Brave supplied results. Bing reported an HTTP connection error and Google denied access, so the result correctly remained `partial: true`, `noResults: false`. Logs also contained non-blocking warnings about an absent limiter configuration and proxy address headers. This proves the container, JSON contract and normalization path for one generic query; it does not establish dependable upstream coverage or a search-quality benchmark.

The temporary container, project network, cache volume and generated configuration were removed. The official image remains in Docker's shared image cache. No live Tupies engine, bot, workspace, credential or firewall setting changed. Production activation still requires the operator steps in this guide.

## Connect it to Tupies

In **Settings → More settings → Integrations**, choose **SearXNG (your instance)**. For a native engine on the same host, use `http://127.0.0.1:8888` with No authentication and the supplied fixed JSON action. Assign the integration to the bot, keep Web and Integrations enabled, and select it as that bot's search fallback. Each actual fallback query still requests exact integration approval. DuckDuckGo's genuine no-results response does not trigger fallback.

The loopback URL is evaluated on the engine running the bot. The VPS endpoint is not available through the Mac's `127.0.0.1`, and the Mac's endpoint is not available on the VPS. Install the same private sidecar on each executing host, or deliberately expose one owned, authenticated HTTPS endpoint reachable from both. Do not open port 8888 to the internet or weaken the public-fetch SSRF rules. Existing configured-service transport allows loopback HTTP while retaining destination checks and blocked metadata/link-local addresses.

If Tupies itself runs in a container, `127.0.0.1` refers to that container. This host-loopback recipe is for the current native-engine setup; configure an explicit private container-network deployment separately rather than changing the public port binding.

Secrets stay in the private deployment `.env` or the integration's sealed credential field. Never place credentials in a URL, bot prompt, note, plaintext synced configuration or this document. Existing engine sync transports integration secrets only in sealed payloads and re-seals them on the other engine.

## Maintenance

Keep the existing digest and private `.env` for rollback. Review upstream changes, pull a selected new tag and replace only the image digest deliberately, then validate and recreate this sidecar. Tupies itself does not need a restart merely to update SearXNG. To stop this optional service, run `docker compose -f compose.yml down`; do not add `--volumes` unless intentionally discarding its cache. Do not reset the Tupies workspace to test search.

Primary references: [official container installation](https://docs.searxng.org/admin/installation-docker.html), [settings and engine selection](https://docs.searxng.org/admin/settings/settings.html), [server environment overrides](https://docs.searxng.org/admin/settings/settings_server.html), [JSON Search API](https://docs.searxng.org/dev/search_api.html), [private-instance behavior](https://docs.searxng.org/own-instance.html), [limiter/upstream blocking](https://docs.searxng.org/admin/searx.limiter.html).
