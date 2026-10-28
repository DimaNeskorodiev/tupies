# Providers, subscription login, integrations and skills

This guide retains its original filename for existing links. Tupies 0.2 has its own agent engine and does not need a Hermes profile, gateway, process or API key.

## Connect a model provider

Open **Settings › Models**, choose the service, name the connection and add its API key where required. The built-in endpoint is filled in for OpenAI, Anthropic, xAI, OpenRouter and Ollama. A compatible API can use an explicitly selected endpoint. Keys are sealed on the server and are never returned to browser state.

Use **Test** and **Choose default model** to fetch the account's model catalog without a paid model request. Pick a model and click **Use this model for my bots**. Tupies saves the workspace default. **Apply to all existing bots** is selected initially, so every current bot follows the chosen provider and model. Uncheck it to preserve individual model and provider choices while updating unconfigured bots and bots following the workspace default. New bots inherit the default automatically. Leave a bot's model empty to follow its provider default. Send a small task to verify inference; discovery only proves access to the catalog. Models, plans and API billing are provider-controlled.

Bots may share a provider account while keeping separate memory, workspaces and conversations. A bot-specific model override takes precedence over the connection default. Choose different providers per specialist when useful. Changing a provider type or API destination clears its previous credentials; re-enter the appropriate key for the new service.

**Image input** in the same Advanced endpoint settings decides whether the connection's models are shown attached images. **Automatic** follows the provider's model list and well-known model families. Choose **Models here can see images** for a local vision model, for example a LLaVA- or Qwen-VL-type model in Ollama, or **Text only** to never send images.

For Ollama, run the local service with a tool-capable model and use its OpenAI-compatible endpoint, normally `http://127.0.0.1:11434/v1`. Tupies does not download model weights or start Ollama. In a container, loopback refers to the container; use a deliberately configured trusted private service or HTTPS endpoint.

## ChatGPT / Codex subscription

Choose **ChatGPT / Codex subscription**, save the connection, and click **Continue with ChatGPT**. Tupies uses the documented public-client flow for open-source and locally hosted apps. The account authorizes Tupies to use eligible ChatGPT plan allowance for Responses requests. A Codex CLI, a Hermes installation and an OpenAI Platform API key are not required for this path.

Tupies generates a stable opaque installation identifier, fresh state, nonce and PKCE values. First-time registration uses OpenAI's documented dynamic client entrypoint. The callback supplies an issued client ID; Tupies verifies the signed ID token, issuer, audience, expiry, nonce and account identity before retaining credentials. The account's granted scopes must include plan usage before inference.

The installation identifier, app name and requested scopes are sent to OpenAI during sign-in. Tupies does not import existing Codex/Hermes logins or read their credential stores. Access, refresh and ID tokens are encrypted with Tupies's local vault. Reauthorization reuses the selected account registration and host identifier. Add a separate connection for a different account.

After authorization, Tupies immediately shows the signed-in account's model list. Choose a model and save it as the workspace default for your bots. **Change default model** on the provider card opens this list again. If the account was connected before a default was selected, Tupies also offers this step when you reopen the workspace. A failed or empty catalog can be refreshed without signing out. The catalog and a browser login do not guarantee unlimited usage or every model. Limit errors, revoked grants, failed streams and incomplete model responses remain explicit task outcomes.

### Loopback callback on a VPS

OpenAI's local flow returns to an HTTP callback on **127.0.0.1**, using Tupies's own port and `/auth/callback` path. Keep Tupies running while signing in. On your Mac, forward the same port as the VPS process:

```sh
ssh -N -L 4310:127.0.0.1:4310 user@your-vps
```

Open Tupies through that loopback address, then start sign-in. The OpenAI browser redirect reaches the local tunnel and returns to the same Tupies server. Do not change `127.0.0.1` to `localhost` or map a different local port. If Tupies uses another port, forward that same port at both ends. An expired/cancelled attempt must be started again; callback codes are not replayed.

### Product and account eligibility

The documented dynamic flow covers open-source and locally hosted/self-hosted apps. Offering ChatGPT plan access in a paid or remotely hosted service requires OpenAI's separate onboarding. `STUDIO_DEPLOYMENT_MODE=hosted` disables initial dynamic registration unless an operator configures an approved client ID with `STUDIO_OPENAI_CLIENT_ID`. Setting an arbitrary client ID does not grant approval, account entitlement or new API permissions.

Official references: [Sign in with ChatGPT](https://developers.openai.com/siwc), [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [account and token lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), and [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

### Renewal and sign-out

Tupies serializes refreshes for each connection and stores replacement credentials together. If renewal has an uncertain outcome, it freezes the saved refresh grant and asks for sign-in again instead of replaying a possibly rotated token. Pending sign-in does not replace an active account until validation succeeds.

Sign-out attempts remote revocation and clears local tokens. If remote revocation is unconfirmed, disconnect Tupies in ChatGPT Settings. A process restart loses pending browser attempts but retains established encrypted credentials. Tokens never belong in exported skill files, source control, browser storage or screenshots.

## Read-only browser

A bot with **Browser** turned on (Bot settings › Advanced settings) can open public HTTPS pages in a real headless browser. That helps with pages that need JavaScript; `http_fetch` stays the simple choice for plain pages and APIs. Tupies drives a browser installed on the engine and never downloads one:

- **Mac:** Google Chrome, Chromium or Microsoft Edge in `/Applications` is found automatically.
- **Debian or Ubuntu server:** install Chromium as the owner, for example `sudo apt install chromium`, then restart the service. `STUDIO_BROWSER=/path/to/chrome` names any other location.
- **Hardened services:** a systemd unit with `RestrictNamespaces=true` blocks Chromium's sandbox. Allow `user pid net` and raise `TasksMax` with a drop-in, as in `docs/deployment.md`. Otherwise Chromium's error appears in the bot's tool result. `STUDIO_BROWSER_NO_SANDBOX=true` runs without the sandbox, with weaker isolation.

The bot editor says when this engine has no browser, and `GET /api/state` reports `browser.available`. Each task's browser starts on first use (about a second), has a fresh profile and closes when the task ends. A model that can see images can also take screenshots, saved under `browser/` in the bot's files.

## Third-party APIs and MCP

An integration is separate from a model provider. Open **Settings › Integrations**, choose a preset or a custom API/MCP endpoint, then add its credential and assign it only to the bots that need it.

- **MCP:** Provide the exact Streamable HTTP endpoint, such as `https://service.example/mcp`. Discovery performs protocol initialization and lists real tool schemas. Session and protocol headers are retained for calls. No stdio program is launched.
- **REST:** Declare each fixed action's name, description, HTTP method, path and JSON input schema. The GitHub and Slack templates are starting points; the token still needs appropriate service scopes. GET arguments become query parameters; other methods send JSON bodies. Action paths cannot redirect to arbitrary URLs.

REST configuration validation does not execute an action or verify the credential. MCP discovery verifies the discovery connection, not every future tool. During a task, an assigned bot can list tools and request a call. Every call pauses for approval of the exact integration, tool and arguments, including calls a remote server labels read-only.

API credentials remain sealed on the server. HTTPS is required for remote services; loopback HTTP is supported for deliberate local services. Trusted private HTTP needs the operator setting. Service requests pin DNS and refuse credential-forwarding redirects; model-requested web fetches have a separate public-network policy.

## Telegram messaging channels

Create a Telegram bot using Telegram’s official bot setup, then add its bot token under **Settings › Messaging**. Choose the Tupies bot that will answer. Enter explicit numeric chat IDs and user IDs; both lists are checked for every inbound message. Usernames, wildcards and empty enabled lists are refused. A bot token can belong to only one Tupies channel so competing pollers cannot consume each other’s updates.

Enter **Your own Telegram user ID** (also listed among the allowed users) to continue the bot's main chat from Telegram: your direct messages land in the same conversation as in Tupies. Messages from other allowed people, and each person in a group, get a separate conversation, so they never see your chat with the bot.

Use **Test** to verify the token with getMe, then enable the channel after reviewing recipients. The user must already be able to message the Telegram bot; group visibility also depends on Telegram’s bot privacy/permissions. Tupies does not remove an existing webhook automatically. A webhook/poller conflict is an explicit service error to resolve through the intended Telegram configuration. Background polling stays off while a channel is disabled. Test is an explicit, read-only token-verification request.

Only ordinary text messages from an allowed chat **and** allowed non-bot sender enter the assigned Tupies bot. The request retains that bot’s model, skills and tool permissions. Telegram text cannot approve actions or grant extra permissions. Approvals must be reviewed in Tupies. A busy bot returns a bounded busy notice; text is not placed in an unbounded execution queue.

The update cursor is saved before task admission. Task output is sent as plain text to the allowed originating chat, at most three bounded parts, with secrets redacted. Reply intent is persisted before network transmission. A crash or uncertain send can therefore lose an acknowledgment, but cannot automatically replay the task or send the same claimed reply again. Review the Tupies transcript when delivery is uncertain. Disabling a channel stops new ingress and suppresses an unsent result; it does not undo a completed external action.

Bot tokens stay sealed on the server. Telegram’s API requires the token in its HTTPS request path, so Tupies never returns or logs that URL. This is a server-side adapter; no Telegram token is stored in the browser. The official [Bot API](https://core.telegram.org/bots/api) describes getUpdates, getMe, sendMessage and platform permissions.

## Portable skills

Import a root `SKILL.md` or a full folder with resources. The root uses the familiar format:

```markdown
---
name: daily-review
description: Review priorities using the context and tools actually available.
---

# Daily review
List commitments, blockers and next actions. Never invent calendar access.
```

Assign the skill to a bot. The engine first advertises its name and description, then provides `skills_read` and `skills_file` tools for progressive access to instructions, scripts and references. Full folders are preserved as regular-file bytes, up to 100 files and 5 MB. Unsafe paths, symlinks and conflicting entries are refused. The parser accepts ordinary scalar/folded/literal descriptions and preserves the original document; it is not a complete YAML implementation.

Unlike the earlier gateway version, resources are available to Tupies's own tools. `skills_run` can execute an assigned Node, Python or Bash script after approval of its exact path, interpreter and arguments. Use only reviewed scripts. Dependencies must exist in the service environment. Execution is trusted host execution under the Tupies account, not an OS sandbox; scripts can access that account's files and network.

A bot can also learn a workflow with **skills_create** after exact approval of its complete name, description and instruction document. The new skill is marked learned, assigned only to its creating bot, and immediately available to its run. It cannot overwrite an existing skill. Review learned playbooks like imported ones.

With the automation tool group enabled, a bot can list its own routines, propose an interval task using **routines_create**, or remove its own schedule. Creating/removing a schedule always requires exact approval. The first run is one interval after creation and can spend model usage while the server is online; future tools still follow their own approvals.

**Download package** saves a portable `.skill.json` export. Restore its exact directory/resource bytes without executing them:

```sh
node scripts/restore-skill.mjs ~/Downloads/name.skill.json ./name
```

The destination must be new and its parent must exist. Restored files are mode 0600 and folders 0700; executable bits and symlinks are not recreated. Tupies runs scripts through an explicit interpreter, so executable bits are not needed for that route. The restored SKILL.md/resources can also be used in a compatible skill system after review.

## OpenRouter voice setup

Add an OpenRouter API-key connection in **Settings › Models**, then open Chat options → Voice & dictation. Select that connection, a reading model and its voice, a dictation model, and explicitly allow OpenRouter speech processing. The default selections are Eleven v4 Turbo and ElevenLabs Scribe v2. Preview ElevenLabs, Gemini 3.8 Flash TTS and Fish Drama 3 with the same sample before saving. Paid speech uses the OpenRouter balance independently of the bot's chat provider; existing ChatGPT subscription authorization does not supply audio credits. See [Voice controls](chat-controls.md).
