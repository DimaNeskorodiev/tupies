# Providers, subscription login, integrations and skills

This guide retains its original filename for existing links. Tupies 0.2 has its own agent engine and does not need a Hermes profile, gateway, process or API key.

## Connect a model provider

Open **Settings › Models**, choose the service, name the connection and add its API key where required. The built-in endpoint is filled in for OpenAI, Anthropic, xAI, OpenRouter and Ollama. A compatible API can use an explicitly selected endpoint. Keys are sealed on the server and are never returned to browser state.

Use **Test** and **Choose default model** to fetch the account's model catalog without a paid model request. Pick a model and click **Use this model for my bots**. Tupies saves the workspace default. **Apply to all existing bots** is selected initially, so every current bot follows the chosen provider and model. Uncheck it to preserve individual model and provider choices while updating unconfigured bots and bots following the workspace default. New bots inherit the default automatically. Leave a bot's model empty to follow its provider default. Send a small task to verify inference; discovery only proves access to the catalog. Models, plans and API billing are provider-controlled.

Bots may share a provider account while keeping separate memory, workspaces and conversations. A bot-specific model override takes precedence over the connection default. Choose different providers per specialist when useful. Changing a provider type or API destination clears its previous credentials; re-enter the appropriate key for the new service.

**Image input** in the same Advanced endpoint settings decides whether the connection's models are shown attached images. **Automatic** follows the provider's model list and well-known model families. Choose **Models here can see images** for a local vision model, for example a LLaVA- or Qwen-VL-type model in Ollama, or **Text only** to never send images.

For Ollama, run the local service with a tool-capable model and use its OpenAI-compatible endpoint, normally `http://127.0.0.1:11434/v1`. Tupies does not download model weights or start Ollama. In a container, loopback refers to the container; use a deliberately configured trusted private service or HTTPS endpoint.

### Models on your Mac (Ollama and MLX)

**Settings › Models** opens with an **On this Mac** card. It is the main way to add a model on your Mac: one **Use** per running runtime, nothing to fill in. The engine checks only this machine's loopback interface, with a short timeout (`GET /api/local-runtimes`, cached for 30 s; **Check again** asks it to look now), for:

- **Ollama** on `http://127.0.0.1:11434` (`/api/version`, `/api/tags`);
- **MLX LM** or **MLX VLM** on `http://127.0.0.1:8080` (`/v1/models`, and `/health`, which `mlx_vlm.server` exposes).

Each runtime shows one of three states:

- **Running · N models.** **Use** adds it as a provider in one click, named “Mac · Ollama” or “Mac · MLX”, with its first chat model as the default, and checks it once. Embedding models the runtime also serves (for example `sentence-transformers/all-MiniLM-L6-v2` or `nomic-embed-text`) cannot chat: they are not counted, never become the default, and the model picker does not list them for local providers. A runtime that is already added shows **Added as …** and **Use for a bot**.
- **Not running.** A copyable start command: `ollama serve`, or `mlx_lm.server --model <model> --port 8080`. For images and a prefix cache, the alternative is `APC_ENABLED=1 mlx_vlm.server --model <model> --port 8080`.
- **Not installed.** A link to [Ollama](https://ollama.com/download) or [MLX LM](https://github.com/ml-explore/mlx-lm). Ollama is looked for in its usual install places. MLX often lives in a Python virtual environment, so when it is not found the card shows both the start command and the link.

While a bot's step runs on a local model, the chat says what it is waiting for: "Waiting for this Mac…" when other requests are ahead in the queue, "Loading the model on this Mac…", "Reading the conversation (about 24K tokens)…", and then the streamed answer. While a request runs, the Mac is kept from idle sleep (`caffeinate`, ended 30 s after the last request). A closed lid on battery still sleeps the Mac; a bot used from the home server then gets its fallback model's answer, or stops with "The Mac is offline" (see [Engines, devices and sync](sync.md#local-models-hosted-by-a-linked-engine)).

Tupies never starts a runtime and never downloads weights. On the home server (a VPS that Macs link to) the card is titled **On your Mac** and lists each linked Mac with the runtimes that Mac found on its own loopback, checked through the relay. **Use** there adds the runtime for that Mac (`hostNodeId`), named “Mac · Ollama” or “Mac · MLX”, and bots on the server reach it through the Mac. A Mac that is offline says to open Tupies on it; a Mac running an older engine says to update it; with no linked Mac the card says to open Tupies on the Mac and link it in **Settings › Devices & sync**. A server that is not a home server lists the local providers the paired Mac hosts, with **Mac online** or **Mac offline**, or explains that local models run on the Mac. Choose the model for a bot with **On my Mac** in the model picker (see [Model and reasoning](chat-controls.md#model-and-reasoning)).

From the chat, **Set up a model on your Mac** opens this card focused, for the bot you were talking to: **Use** then also switches that bot to the new model, and **Back to chat** returns with your draft.

**Add provider › Ollama** or **MLX LM (Mac)** asks for nothing. It shows what was found (for example **Running on this Mac · 3 models**, or **Running on Studio Mac** on the home server), what Connect will add, and one **Connect** button. The name, address and default model are chosen automatically: the engine picks the first chat model and checks the new provider once. If the runtime is not running, the dialog says so with the start command and **Check again**. A custom address, the context window and image input are under **Advanced**, closed by default. Editing a saved Ollama or MLX provider keeps its name and default model, with the same fields under **Advanced**.

## ChatGPT / Codex subscription

Choose **ChatGPT / Codex subscription**, save the connection, and click **Continue with ChatGPT**. Tupies uses the documented public-client flow for open-source and locally hosted apps. The account authorizes Tupies to use eligible ChatGPT plan allowance for Responses requests. A Codex CLI, a Hermes installation and an OpenAI Platform API key are not required for this path.

Starting again from the provider tile after an abandoned or failed sign-in reuses that unfinished connection instead of adding a second one with the same name. A connection that has held an account is never reused, so adding another account creates a separate connection. Bot settings and the chat model picker label same-named connections with their account email and show an unfinished or expired sign-in as an error rather than as a normal choice.

Tupies generates a stable opaque installation identifier, fresh state, nonce and PKCE values. First-time registration uses OpenAI's documented dynamic client entrypoint. The callback supplies an issued client ID; Tupies verifies the signed ID token, issuer, audience, expiry, nonce and account identity before retaining credentials. The account's granted scopes must include plan usage before inference.

The installation identifier, app name and requested scopes are sent to OpenAI during sign-in. Tupies does not import existing Codex/Hermes logins or read their credential stores. Access, refresh and ID tokens are encrypted with Tupies's local vault. Reauthorization reuses the selected account registration and host identifier. Add a separate connection for a different account.

After authorization, Tupies immediately shows the signed-in account's model list. Choose a model and save it as the workspace default for your bots. **Change default model** on the provider card opens this list again. If the account was connected before a default was selected, Tupies also offers this step when you reopen the workspace. A failed or empty catalog can be refreshed without signing out. The catalog and a browser login do not guarantee unlimited usage or every model. Limit errors, revoked grants, failed streams and incomplete model responses remain explicit task outcomes.

### Loopback callback on a VPS

OpenAI's local flow returns to an HTTP callback on **127.0.0.1**, using Tupies's own port and `/auth/callback` path (an engine serving its own certificate uses port 1455; see below). Keep Tupies running while signing in. On your Mac, forward the same port as the VPS process:

```sh
ssh -N -L 4310:127.0.0.1:4310 user@your-vps
```

Open Tupies through that loopback address, then start sign-in. The OpenAI browser redirect reaches the local tunnel and returns to the same Tupies server. Do not change `127.0.0.1` to `localhost` or map a different local port. If Tupies uses another port, forward that same port at both ends. An expired/cancelled attempt must be started again; callback codes are not replayed.

### With the engine's own certificate

An engine started with `STUDIO_TLS=engine` speaks only HTTPS on its port, so it cannot receive OpenAI's plain-HTTP redirect there. While a sign-in is pending it opens a separate callback listener on **127.0.0.1** only, port **1455** (OpenAI's documented example port, or any free port when 1455 is taken). The sign-in dialog names the port. This listener answers only `/auth/callback` and closes when the sign-in finishes, is cancelled or expires after ten minutes.

On the engine's own computer nothing else is needed: sign in from a browser or the Mac app there. On a VPS, forward the callback port before you approve in ChatGPT. Tupies itself can stay open at its usual `https://` address:

```sh
ssh -N -L 1455:127.0.0.1:1455 user@your-vps
```

In Docker the listener is on the container's own loopback address, which published ports cannot reach. Sign-in therefore cannot finish on a container that serves its own certificate; run that engine as a native service instead.

The redirect always goes to 127.0.0.1 on the device whose browser approves the sign-in, so an iPhone cannot finish it. Start ChatGPT sign-in from the Mac running the engine, or from a computer with this tunnel. Afterwards the engine renews access by itself.

### Product and account eligibility

The documented dynamic flow covers open-source and locally hosted/self-hosted apps. Offering ChatGPT plan access in a paid or remotely hosted service requires OpenAI's separate onboarding. `STUDIO_DEPLOYMENT_MODE=hosted` disables initial dynamic registration unless an operator configures an approved client ID with `STUDIO_OPENAI_CLIENT_ID`. Setting an arbitrary client ID does not grant approval, account entitlement or new API permissions.

Official references: [Sign in with ChatGPT](https://developers.openai.com/siwc), [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [account and token lifecycle](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), and [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

### Renewal and sign-out

Tupies serializes refreshes for each connection and stores replacement credentials together. If renewal has an uncertain outcome, it freezes the saved refresh grant and asks for sign-in again instead of replaying a possibly rotated token. Pending sign-in does not replace an active account until validation succeeds.

Sign-out attempts remote revocation and clears local tokens. If remote revocation is unconfirmed, disconnect Tupies in ChatGPT Settings. A process restart loses pending browser attempts but retains established encrypted credentials. Tokens never belong in exported skill files, source control, browser storage or screenshots.

## Browser use

A bot with **Browser** turned on (Bot settings › Advanced settings) can open public HTTPS pages in a real headless browser. That helps with pages that need JavaScript; `http_fetch` stays the simple choice for plain pages and APIs. Tupies drives a browser installed on the engine and never downloads one:

- **Mac:** Google Chrome, Chromium or Microsoft Edge in `/Applications` is found automatically.
- **Debian or Ubuntu server:** install Chromium as the owner, for example `sudo apt install chromium`, then restart the service. `STUDIO_BROWSER=/path/to/chrome` names any other location.
- **Hardened services:** a systemd unit with `RestrictNamespaces=true` blocks Chromium's sandbox. Allow `user pid net` and raise `TasksMax` with a drop-in, as in `docs/deployment.md`. Otherwise Chromium's error appears in the bot's tool result. `STUDIO_BROWSER_NO_SANDBOX=true` runs without the sandbox, with weaker isolation.

The bot editor says when this engine has no browser, and `GET /api/state` reports `browser.available`. The browser starts on first use and closes when the task ends. Current source adds approved typing, forms, tabs, frames, dialogs and bounded file transfers. An **Open browser** handoff lets the owner enter passwords, verification codes and CAPTCHA responses directly, then resume the bot. The owner may retain a bot-specific sign-in on that engine; temporary profiles are discarded. Models never receive the private handoff input directly. Screenshots for an image-capable model are saved under `browser/`, but are refused after private owner input in that task. See [Browser use](browser.md) for controls, permissions and limits. These source features do not update an operational release automatically.

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

Open **Settings → Skills**, the first Settings item, to manage the **Installed** library. **Assign to bots** controls each bot’s assignment; **Files & options** contains instructions, export and removal. The skill **Settings** tab contains per-bot installation preferences. In **Catalog**, search by task and choose a bot; **Install** adds the exact reviewed version and assigns it to that bot in one action. The bundled catalog contains sixteen offline workflows: ten original Tupies playbooks and six attributed Grok Bot public-profile adaptations. It is not a live index of other agents’ marketplaces.

**Import skill** accepts one `SKILL.md`, a complete folder, a ZIP export or a public HTTPS URL. GitHub folder/file links can use a branch or tag: the engine resolves it once and fetches only the resulting commit. Preview the original instructions, resource filenames and requirements before installing. A selected skill is limited to 100 regular files and 5 MB; ZIP input is limited to 10 MB. The compatible directory format is:

```markdown
---
name: daily-review
description: Review priorities using the context and tools actually available.
---

# Daily review
List commitments, blockers and next actions. Never invent calendar access.
```

Original instruction/resource bytes stay intact. Hermes-style metadata is inspected conservatively; Grok Bot skill folders can be brought over through supported OpenBot ZIP exports. These are format/import capabilities, not a promise that foreign runtime modules, OAuth, browser actions or setup commands will work in Tupies. **Ready to use**, **Needs setup** and **Unavailable here** describe the executing engine and selected bot's declared requirements. Unknown requirements can still fail at use time. See [Skills](skills.md) for exact formats and boundaries.

The engine advertises assigned names/descriptions, then gives the bot `skills_read` and `skills_file` for progressive access. `skills_search` and `skills_inspect` discover the reviewed catalog; `skills_install` adds an exact version. The default installation policy asks for approval. In **How [bot] adds skills**, the owner can allow automatic reviewed-catalog installs for a Balanced bot, with at most three new assignments per run. Strict still asks. No installation grants extra tools, credentials or execution permissions.

`skills_run` executes an assigned Node, Python or Bash script only after approval of its exact path, interpreter and arguments. Dependencies must already exist on that engine. Execution is trusted host execution under the Tupies account, not an OS sandbox; scripts can access that account's files and network. Importing a package never executes its code or setup hooks.

`skills_create` can save a new reusable workflow after exact approval and assign it only to the creating bot. Learning proposals remain available for new skills or reviewed changes to existing learned/local skills. Managed imported/catalog package revisions are immutable; create a separate new skill to customize one. Explicit catalog-version changes retain older installed revisions for rollback. See [Skills](skills.md#versions-customization-and-sync).

With the automation tool group (**Routines**) enabled, a bot can list its own routines, schedule one through **routines_create** (for example when asked to “check the bitcoin price every 10 minutes”), change, pause or resume one with **routines_update**, or remove one. Creating, changing or removing a schedule always requires exact approval and can spend future model usage while the engine is online.

With **Manage Tupies** (the `setup` group, on by default) a bot can also set up the workspace from chat: `bots_list` shows the team, models and installed skills; `bots_create` adds a new bot; `bots_update` changes another bot's name, role, instructions, tool groups or availability; `skills_assign` gives an installed skill to another bot; and the routine tools work for any bot. Every change shows the owner an approval card with a plain summary and the exact arguments. A bot cannot change its own settings, turn on Terminal, Browser or Coding, assign integrations or loosen an approval policy; those stay in Settings.

**Download package** saves a portable `.skill.json` export. Restore its exact directory/resource bytes without executing them:

```sh
node scripts/restore-skill.mjs ~/Downloads/name.skill.json ./name
```

The destination must be new and its parent must exist. Restored files are mode 0600 and folders 0700; executable bits and symlinks are not recreated. Tupies uses explicit interpreters for script execution. The restored SKILL.md/resources can be used in another compatible system after review.

## OpenRouter voice setup

Add an OpenRouter API-key connection in **Settings › Models**, then open Chat options → Voice & dictation. Select that connection, a reading model and its voice, a dictation model, and explicitly allow OpenRouter speech processing. The default selections are Eleven v4 Turbo and ElevenLabs Scribe v2. Preview ElevenLabs, Gemini 3.8 Flash TTS and Fish Drama 3 with the same sample before saving. Paid speech uses the OpenRouter balance independently of the bot's chat provider; existing ChatGPT subscription authorization does not supply audio credits. See [Voice controls](chat-controls.md).
