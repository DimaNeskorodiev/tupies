# Local models on the Mac, used from every engine — 17 November 2026 (proposed, revised)

Requested by the owner on 17 November 2026. Bots should be able to think with a model running on the owner's Mac through **Ollama** or **MLX LM**. The first target is **Qwen3.8-27B**, which the owner is downloading and which most owners will probably choose too. The owner chose the **Mac as the inference node**: bots on the home server (VPS) also use the model on the Mac. Switching a bot to the local model must be obvious in the UI.

**Revision.** An independent architecture review on the same day agreed with the direction (relaying generation over the engine link). It found 13 problems in the first draft, four of which would have made VPS bots on the local model unreliable or unusable. This version incorporates them. The claims the review cited were spot-checked against the code.

Nothing has been changed, run or deployed. Statements about Tupies cite the current checkout. Facts about the model come from its [model card](https://huggingface.co/Qwen/Qwen3.8-27B). How Ollama and MLX LM behave with this model is still **unverified**; phase L0 measures it before the engine depends on it.

## Short answer

- **Some of this works today.** Ollama is a preset that uses the OpenAI-compatible `/v1` endpoint (`lib/providers.mjs:25`). `mlx_lm.server` works through the `custom` preset. Both work only on the engine running on the same Mac.
- **Making it reliable on the Mac needs these engine changes:**
  - **Real context size.** Ollama's `num_ctx` cannot be set through `/v1`, so prompts are truncated without any error.
  - **Thinking and output budget.** Qwen3.8 is not recognized as a thinking model. `REASONING_FAMILY` (`lib/providers.mjs:75`) does not match it, and `reasonsByDefault` (`:96-101`) does not cover Ollama or custom endpoints. So it thinks with a 4,096-token output limit (`:455-456`) and a 120 s idle limit instead of 600 s (`:94`, `:298-301`).
  - **Time limits.** A long prefill streams nothing. The total inference limit of 900 s can never be extended by activity (`lib/providers.mjs:318-319`, `lib/provider-net.mjs:73`).
  - **`<think>` in `content`.** It is not separated from the answer (`reasoningOf`, `lib/providers.mjs:173`).
  - **Background reviews.** Action, memory and skill reviews run on the task's own model with 20 s, 12 s and 15 s limits:
    - `lib/action-risk-review.mjs:40`;
    - `lib/memory-review.mjs:89`;
    - `lib/skill-review.mjs:35`.

    On a thinking 27B model they time out, and action review then falls back to manual approval.
  - **Sampling.** Local servers may fall back to greedy sampling, and Qwen recommends specific values.
- **The VPS cannot reach the Mac directly.** The Mac is behind NAT, and provider connections sync between engines as whole documents where the last writer wins (`lib/sync/docs.mjs:14`). An Ollama connection to `127.0.0.1` on the Mac therefore replicates to the VPS:
  - the VPS would dial its own loopback for the model list, the connection test and inference (`lib/api-native.mjs:143,196,246`);
  - a failed test there writes `status:'error'` into the shared record (`lib/api-native.mjs:194`), which marks the Mac's working connection as broken.
- **Recommendation: relay generation over the existing engine link.**
  - The Mac engine already holds an authenticated, sealed long-poll link to the hub (`lib/sync/index.mjs:492`). Replica→hub requests have a precedent: `/api/sync/oauth-refresh` (`lib/sync/index.mjs:395-403,544-548`).
  - The Mac claims inference jobs from the hub, runs them against its own loopback runtime and streams the results back.
  - Tasks, tools, approvals, routines and Telegram stay on the hub. Runs and approvals never sync (`AGENTS.md`, `docs/sync.md`), so only generation can move.
  - Linked engines already hold the whole workspace (`docs/sync.md`), so the relay adds no new trust boundary.
- **Why not Tailscale directly as the default.**
  - `STUDIO_ALLOW_PRIVATE_HTTP=true` is global. On the VPS it also opens private addresses to integrations (`lib/integrations.mjs:48`) and to bot-driven `browser_open` (`lib/browser.mjs:519,532`), an SSRF regression on the internet-facing engine.
  - Ollama and MLX have no authentication on the tailnet.
  - One synced record cannot hold both the Mac's and the VPS's address.
  - Tailscale is kept only as a short stopgap with a **per-connection** private-address allowance (step L1b).

## What the model card says that matters here

| Fact | Consequence for Tupies |
| --- | --- |
| Dense 27B. 64 layers, of which 48 are Gated DeltaNet (linear attention) and 16 are gated attention with 4 KV heads (head dim 256). Includes vision and multi-token prediction. | KV cache is small, so long windows fit in Mac memory. The runtime must support this hybrid architecture. Prefix reuse is harder for recurrent layers, and a server may re-read the whole prompt when the prefix changes. Both are measured in L0. |
| 262,144-token native context; YaRN extends it to 1M but can hurt shorter texts. | Do not enable YaRN. The window Tupies uses is the one it sends (`num_ctx`, or the server limit). |
| Thinking is on by default and wraps output in `<think>…</think>`. Turn it off with `chat_template_kwargs: {enable_thinking: false}`. | Tupies needs a streaming `<think>` splitter and a thinking setting for each runtime. Reviews run with thinking off. |
| `reasoning_effort` takes `low`, `medium` or `xhigh` (default). Lower effort can *increase* total latency in multi-turn agent tasks. | A family preset exposes these three levels. The default is the model's own (xhigh). |
| `preserve_thinking` defaults to true and keeps historical thinking. | Today only DeepSeek gets reasoning echoed back (`lib/providers.mjs:449`). Measurement in L0 decides whether to echo it for Qwen3.8. |
| Sampling — thinking: `temperature 1.0, top_p 0.95, top_k 20, min_p 0, presence_penalty 0`. Non-thinking: `0.7, 0.8, 20, 0, presence_penalty 1.5`. | Send these explicitly for local runtimes, through a family preset that the owner can override. |
| Answers up to 131K tokens; reasoning up to 262K. | The thinking floor of 16K output tokens is probably too small for xhigh. The per-connection maximum is 32,768 (`lib/providers.mjs:286`). L0 sets the default. |
| The card names no tool-call format or parser. | Tool calling through each runtime is the main L0 risk. |

## Phases

### L0 — Measure the model on the Mac (no product code) — done for MLX, 17 November 2026

**Results: [Qwen3.8-27B L0 measurements](../research/local-qwen38-27b-20261117.md).** Ollama is not measured yet; the owner deferred the download.

Gate outcome. These change L1 below:

1. **Bug.** Tupies sends request bodies chunked without `Content-Length`, and `mlx_lm.server` refuses every request with HTTP 411.
2. **Tool calls.** Both MLX runtimes return structured, valid tool calls. No XML parser is needed.
3. **Thinking.**
   - Reasoning arrives in `reasoning` / `reasoning_content`, never as `<think>` in `content`.
   - `chat_template_kwargs.enable_thinking` is the one control that works on both runtimes.
   - `mlx_lm` thinks by default; `mlx_vlm` does not.
4. **Prefill and caching.** Cold prefill runs at about 120–130 tok/s, so the real 5.3K prompt waits 42–44 s for the first token. A prefix cache cuts the next step to 0.2–2 s. `mlx_lm` caches by default; `mlx_vlm` needs `APC_ENABLED=1`.
5. **Memory.** A cold 76K-token prompt pushed the 48 GB Mac to 18% free memory, so the default window drops to 32K.
6. **Reviews.** With thinking on they take 80–135 s. With thinking off, action review takes 11–16 s and memory review 12–15 s.
7. **Concurrency.** Two concurrent requests cost about the same time as one.
8. **Live eval.** On `mlx_vlm` with APC, 3 of 3 scored cases passed. The delegation case ran out of its 10 min.

What was planned for L0:

Run Qwen3.8-27B in Ollama and in `mlx_lm.server`. Record the results in `docs/research/local-qwen38-27b-20261117.md`:

1. **Support.** Does the runtime load the hybrid architecture? Which quantization, and how much memory at 32K, 64K and 128K windows?
2. **Tool calls.** Do structured `tool_calls` arrive while streaming, over `/v1` and over Ollama's native `/api/chat`? Or do they leak into `content` as XML?
3. **Thinking.** Does it arrive as `reasoning` / `reasoning_content`, or as `<think>` inside `content`? Do `enable_thinking: false` and `reasoning_effort` work? How many output tokens does a typical xhigh agent step use?
4. **Timing.** For 5K, 30K and 100K token prompts, measure:
   - time to the first response header;
   - time to the first token;
   - prefill tok/s;
   - generation tok/s;
   - cold-load time.
5. **Prefix reuse.** Measure prefill for three requests in a row:
   1. the same long prefix plus one new message;
   2. a short, unrelated request (like a review);
   3. the long prefix again.

   The result decides how reviews are scheduled.
6. **Reviews.** Run the real action, memory and skill review prompts with thinking off and record their latency.
7. **Agent quality.** Run `npm run eval:agent -- --mode live --provider ollama --model …` (`docs/evaluation.md:25`) with thinking on and off, and with reasoning echo on and off.

**Gate.** Choose the recommended runtime and the defaults for window, output limit, thinking, echo and review handling. If no runtime streams structured tool calls, L1 gains a bounded parser for the model's XML tool-call format. Otherwise that parser stays out of scope.

LM Studio is deferred. Each runtime multiplies the L0 and L4 work, and LM Studio users can use the `custom` preset meanwhile.

### L1 — Local runtimes done properly (engine)

0. **`Content-Length` on every request body** (`lib/provider-net.mjs:123`). Today `mlx_lm.server` refuses every Tupies request with HTTP 411. Add a regression test with a server that rejects chunked bodies.
1. **Presets.**
   - Keep `ollama`.
   - Add `mlx` (MLX LM, `http://127.0.0.1:8080/v1`) with an optional API key. `mlx_vlm.server` uses the same preset; its setup note recommends `APC_ENABLED=1`.
   - Mark both `local: true` in the catalog.
   - Treat whitespace-only `content` next to tool calls as empty. `mlx_lm` sends `"\n\n"` there.
   - Connection test: send one short prompt twice. If `usage.prompt_tokens_details.cached_tokens` stays 0, warn that every step will re-read the whole prompt.
2. **Native Ollama transport.** Send requests to `/api/chat` with a streamed NDJSON response and these options:
   - `options.num_ctx` set to the connection's window;
   - `think`;
   - `keep_alive` (default 30 min);
   - native `tools` and `tool_calls`.

   `serviceRequest` needs an NDJSON mode next to `onSSE`. Model discovery uses `/api/tags` and `/api/show`, which report capabilities (`tools`, `thinking`, `vision`), `context_length`, quantization and size. Existing Ollama connections keep working unchanged.
3. **Family presets.**
   - MLX lists only model ids, so a family preset keyed by model id supplies tools, thinking, vision, native window, efforts and sampling. Qwen3.8 is the first entry.
   - The preset must feed `reasonsByDefault` and `reasoningModel`. The model then gets the thinking output floor and the 600 s reasoning idle limit.
   - Raise the thinking output floor for local reasoning models to the value L0 measures.
4. **Thinking.**
   - Map the reasoning slider:
     - the off position → `chat_template_kwargs.enable_thinking: false` (MLX) or `think: false` (Ollama);
     - low / medium / xhigh → `reasoning_effort` with thinking on.
   - Always send the setting explicitly, because the runtimes' defaults differ.
   - L0 found no `<think>` text in `content` on MLX, so the streaming `<think>` splitter is only a cheap safeguard for other compatible servers and can wait.
   - Reasoning echo for Qwen3.8 stays off. L0 did not measure it on agent tasks; revisit with the L4 eval.
5. **Sampling presets.** Send per-family sampling for local runtimes. The owner can choose "Runtime default" in Advanced endpoint settings.
6. **Context window.**
   - The default for a local connection is **32K**, adjustable, and never above the reported native window.
   - 64K and more show a memory warning on Macs with 48 GB or less. In L0 a cold 76K prompt pushed a 48 GB Mac to 18% free memory.
   - Re-measure with `--prefill-step-size 512` before recommending larger windows.
   - For Ollama, `num_ctx` is the window itself. `contextLimits` already keeps the prompt below the window minus the output limit (`lib/context-budget.mjs:78-79`), so prompt and output fit together.
7. **Time limits for local connections.**
   - A separate, configurable **total** limit (default 45 min), so model load and prefill do not consume the 900 s total.
   - A **first-token** limit (default 15 min), measured to the first data event. Response headers count as activity (`lib/provider-net.mjs:77`), so they do not count as the first token.
   - The existing idle limit applies after the first token.
   - The response caps (8 MB, 50,000 events; `lib/provider-net.mjs:49,92,100`) are checked against long NDJSON streams in L0, and raised for local connections if needed.
   - The "waiting for the model" notices (`lib/model-resilience.mjs`) show "Loading model" and "Reading N tokens".
8. **Reviews on local connections.** This is a security property, not only performance: `docs/security.md:9` documents that the action reviewer uses the task's own connection, model and reasoning.
   - All reviews on a local connection run with **thinking off**. With thinking on, L0 measured 80–135 s.
   - Time limits on local connections, from L0 (thinking off: action 11–16 s, memory 12–15 s):
     - memory and skill review: **30 s**;
     - action review: **45 s**.
   - **A/B done 17 November 2026** on eight fixed actions: thinking off gave 8/8 correct decisions in 11–17 s, thinking on gave 7/8 in 24–104 s. Thinking off is confirmed ([live check](../research/local-qwen38-27b-20261117.md#live-check-of-the-implementation--17-november-2026)).
   - **Action review** stays on the task's model. If it still cannot answer in time, the result is the existing manual approval, stated plainly in the chat. It is never silently moved to another model.
   - **Memory and skill reviews** stay local, with thinking off and longer limits. If L0 shows they evict the chat's prefix cache, they run deferred while the bot is idle. They are never moved to a cloud model by default.
   - `docs/security.md` is updated in the same change.
9. **Broken tool arguments.** When the model returns invalid tool-call JSON, re-send the same model request once. This follows the existing context-overflow and image retries (`lib/engine.mjs:964-972`).
   - Nothing is stored and no tool runs.
   - A second failure ends the step as today.
   - This applies to all providers, because storing an invalid call would later break providers that re-parse history (`anthropicMessages`, `lib/providers.mjs:250`).
10. **Usage.** Local runs cost $0, including in Mission pricing (`lib/mission-resources.mjs`, to check).

The queue (one request at a time, interactive work first) lives on the engine that hosts the runtime. It is designed together with L2 and listed there.

### L1b — Tailscale stopgap for the VPS (½ day, optional)

This lets the L1 time limits and review behaviour be exercised from the VPS before the relay exists.

- A per-connection setting allows exactly one private address, for example the Mac's tailnet address. It never uses the global `STUDIO_ALLOW_PRIVATE_HTTP`.
- The docs warn that the runtime is unauthenticated on the tailnet.
- It is removed from the recommended path once L2 ships.

### L2 — The Mac as the inference node for the VPS

1. **Host semantics on the connection.**
   - A connection created with a local preset stores `host: nodeId`. The display name comes from engine presence.
   - Connections without a host (all existing Ollama connections) keep dialling locally, because a VPS may run its own Ollama.
   - On every other engine a hosted connection is remote and its `baseUrl` is never dialled.
   - Only the host engine may change `type`, `baseUrl` or `host` (`validate`, `lib/providers.mjs:274-295`). Other engines are refused.
   - The other writes into the record also happen only on the host, because last-writer-wins would let them race:
     - `rememberOutputParameter` (`lib/providers.mjs:440-444`);
     - `learnContextWindow` and `learnNoImages` (`lib/engine.mjs:765,859`);
     - test status.
   - A Mac restored with a new identity gets a **This Mac hosts this connection** action.
2. **Relay of `models` and `test`, not only `complete()`.**
   - On a non-host engine, the model list comes from the synced `connection.models`.
   - The connection test is relayed to the host. A failure is reported to the caller without writing `status:'error'` into the shared record.
3. **Hub job queue.**
   - When a hub task calls `complete()` on a connection hosted elsewhere, the hub creates an in-memory inference job instead. The job carries:
     - model, messages and tool schemas;
     - reasoning, sampling and output limit;
     - priority: interactive or background;
     - a protocol version.
   - Payloads are sealed with the workspace key, like other sync payloads.
   - If the host engine is not connected (`sync.online`, `lib/sync/index.mjs:373,620`), the job fails immediately with `node_offline`, with no claim wait.
4. **Claim and events.**
   - The Mac long-polls `POST /api/sync/inference/claim`, an engine route (`lib/sync/api.mjs:11`).
     - The hub checks that the claiming engine's `nodeId` equals the connection's `host`.
     - The claim wait copies the exchange's idle pattern (`idleUpdateWait`, `lib/sync/api.mjs:50`; `lib/sync/index.mjs:378`). It does not block hub updates or maintenance (`server.mjs:243-249,291`), and it stays outside `securityOperation`.
   - The Mac runs the request through its own `providers.complete` against loopback.
   - It posts sealed event batches to `/api/sync/inference/events`:
     - deltas and reasoning, at most every 250 ms;
     - a **heartbeat at least every 3 s** while queued, loading, reading or generating, with that state;
     - the final result: text, tool calls, usage and finish reason.
   - Every batch has a per-job sequence number. The hub drops duplicates, because `Sync.request` re-sends on 401 and 409 (`lib/sync/index.mjs:424-437`), and a network error leaves delivery unknown.
   - Every reply carries `continue`, `cancel` or `unknown job`. The Mac aborts its local request on `cancel` or `unknown job`, so it also stops when the hub has restarted.
5. **Failure semantics.**
   - New failure codes `node_offline`, `node_lost` (heartbeat missed for 20 s) and `node_incompatible` (protocol version mismatch). They are added to `CODES` (`lib/provider-failure.mjs:2`), or `markProviderFailure` drops them.
   - `node_offline` and `node_lost` skip the autonomous retry loop (`lib/engine.mjs:949-962`, `lib/autonomous-work.mjs:95,111`) and go straight to the bot's existing fallback model (`fallbackTarget`, `lib/model-resilience.mjs:11`). The chat says so.
   - Without a fallback, the task fails at once with "The Mac is offline".
   - Fallback stays once per run, as today (`lib/engine.mjs:543-548`).
   - A stream broken mid-answer fails as `stream_interrupted` and is never replayed. After a hub restart the hub has no waiter left: the Mac stops on `unknown job`, and the hub task is already interrupted by the restart.
6. **Busy state on the Mac.** A relayed job counts as busy for `assertIdle` / `linkBusy` (`lib/sync/index.mjs:127-129`, `server.mjs:161`) and for the Mac updater. An unlink or update then cannot cut a hub task off mid-answer.
7. **The queue lives on the host.**
   - At most **2** requests run at once, interactive before background. Both MLX runtimes batch decoding: two requests took 16 s against 14–15 s for one. Cold prefills, however, compete for compute.
   - Local tasks on the Mac and relayed hub jobs share one queue.
8. **Status without presence churn.**
   - The hub already knows whether the Mac is connected (`sync.online`) and its own queue depth, so the VPS UI shows "Mac online · queue N" from hub state.
   - Presence carries at most `{runtime, loadedModel}`, because each presence change is a sync write to every engine (`lib/sync/index.mjs:187-190,206,229`).
9. **Scope.**
   - Only hub → host-replica relay is in scope. A second replica using the Mac's model fails clearly with `node_offline`.
   - The case where the hub hosts the model needs no relay: it dials its own loopback.
10. **Sleep.**
    - While jobs are queued or running, the Mac app holds a sleep assertion. The `apps/` code is still to check.
    - A closed-lid Mac on battery still sleeps. That case is handled by `node_offline` / `node_lost` and the fallback model, and documented.
11. **Boundaries.**
    - The Mac only generates text. It never runs tools, approvals or the loop for the hub's tasks.
    - The runtime ports stay on loopback.
    - The payloads hold conversation content that both engines already sync.
    - Job size, concurrency and claim rate are bounded.

### L3 — Making the switch obvious in the UI (after L2 host semantics)

This builds on the provider chips in the composer picker on `feature/chat-provider-switch` (`docs/chat-controls.md`, Model and reasoning), which merges first. The disabled and offline states depend on L2.

1. **Cloud | On my Mac toggle.** A two-segment control sits at the top of the picker's model view and in Bot profile → Settings → Model.
   - The composer trigger reads, for example, "Mac · Qwen3.8 27B".
   - The segment is disabled with a reason when no local runtime is configured, and links to setup.
   - It shows "Mac offline" when the host is not connected.
   - Before adding a per-bot memory of the last cloud and last local choice, check whether the provider chips already make switching back one tap. Add the memory only if they do not.
2. **"On this Mac" card first in Settings › Models.**
   - It lists Ollama and MLX LM with a status:
     - running · N models;
     - not running, with a copyable start command;
     - not installed, with a link.
   - **Use** creates the hosted connection in one click, named "Mac · Ollama".
   - On the VPS the same card shows the paired Mac and whether it is online.
3. **Local model rows.** Each row shows size and quantization, window, and badges for tools, thinking and vision. Models without tool support stay visible, with an explanation.
4. **Run status in the chat.** The chat shows the heartbeat states ("Loading model on Mac…", "Reading 24K tokens"), "Mac is offline — answered by ‹fallback›", and "Action needs your approval: the local reviewer did not answer in time".

Deferred: speed figures in model rows and run details, the Dashboard line, and the "On my Mac" offer when creating a bot.

### L4 — Verification and documentation

- **Fixture-server tests:**
  - Ollama native NDJSON with `num_ctx`, `think` and tool calls;
  - MLX `<think>` split across chunks;
  - Qwen3.8 recognized as a reasoning model, with its output floor and idle limit;
  - the total and first-token limits;
  - reviews with thinking off, and action review falling back to manual approval;
  - the single re-send for invalid arguments, with nothing stored and no tool executed.
- **Two disposable engines linked by sync:**
  - a relayed answer with tool calls;
  - relayed `models` and `test`, with no `status:'error'` written into the shared record;
  - non-host edits to `baseUrl` and `host` refused;
  - cancel during prefill, delivered through the heartbeat reply;
  - `node_offline` without a claim wait, then fallback without autonomous retries;
  - `node_lost` when heartbeats stop;
  - duplicate event batches dropped;
  - a hub restart making the Mac stop on `unknown job`;
  - a protocol version mismatch;
  - the claim wait not blocking hub maintenance;
  - a relayed job blocking unlink and update on the Mac.
- **UI tests** for the toggle, the disabled and offline states, and the setup card. Check in the in-app browser on a scratch engine.
- **The L0 eval** repeated on the finished build.
- **Documentation:**
  - `docs/hermes-setup.md` (providers);
  - `docs/context.md`;
  - `docs/sync.md`;
  - `docs/security.md` (reviewer behaviour on local connections);
  - `docs/chat-controls.md`;
  - `docs/evaluation.md`;
  - `PROJECT_CONTEXT.md` and the roadmap, with shipped and planned work distinguished.

## Order and size

| Step | Depends on | Size |
| --- | --- | --- |
| L0 measure | the downloaded model | 1 day |
| L1 engine (presets, native Ollama, family presets, thinking, sampling, window, time limits, reviews, argument re-send) | L0 gate | 4–5 days |
| L1b Tailscale stopgap (optional) | L1 | ½ day |
| L2 relay (host semantics, `models`/`test` relay, queue, claim and events, heartbeat, failure codes, busy and update integration) | L1 | 5–7 days |
| L3 UI (toggle, setup card, model rows, run status) | picker branch merged, L2 host semantics | 2 days |
| L4 | each step | ongoing, plus 1 day |

After L1 the local model works on the Mac. L1b makes it reachable from the VPS early, with known limits. L2 makes it the supported path for VPS bots.

## Decisions for the owner

The review's recommendations are written in as defaults. The owner can change them:

1. **Window:** 32K by default (changed from 64K after L0), adjustable, with a memory warning at 64K and above. The prompt plus output fit inside it.
2. **Reviews:** stay local with thinking off and longer limits. Never moved to a cloud helper by default. Action review never moves silently; if it cannot answer, the action waits for the owner.
3. **Mac offline:** no new setting. The bot's existing fallback model answers at once and the chat says so. Without a fallback, the task fails with "The Mac is offline".
4. **Starting the runtime:** Tupies never starts Ollama or MLX and never downloads weights. The setup card only shows the start command.

## Not yet checked

- Runtime behaviour of Ollama and MLX LM with this model (L0).
- The Mac app's sleep and updater code under `apps/`.
- `$0` pricing in `lib/mission-resources.mjs`.
- The picker code in `public/app.js` on this branch.
- Current `test/` coverage for providers and sync.
