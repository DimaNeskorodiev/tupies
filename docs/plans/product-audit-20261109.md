# Product audit and recovery plan — 9 November 2026

Audit of the current `main` checkout (`a08f1d5`) and the live Mac/VPS data, requested by the owner after a DeepSeek session that spent six minutes on its first step. Scope: model providers, web research, agent loop and prompt, context and memory, chat UI, channels and automation, storage, observability, and product scope, compared with Hermes Agent, OpenClaw, Grok Bot and OpenBot as of November 2026. Nothing was changed in the engine for this audit; no tests were run; no provider accounts were exercised. Competitor facts come from their current public documentation and issue trackers, not from side-by-side runs.

Evidence is cited as `file:line`. Token figures were measured by importing the real definition modules against a disposable store and by reading the run records that the Mac engine holds in `data/state.json` (counts and timings only; no account content was copied).

## 1. Verdict

Tupies has a careful security and approval core, a good compaction design and a very large surface of half-finished subsystems. What a user actually experiences is a slow, opaque agent: every model step carries roughly 30K tokens of fixed overhead, the bot can neither POST to an API nor read a script-rendered page reliably, weaker models loop on the same tool calls without being stopped, the chat shows a wave animation instead of what the bot is doing, reasoning is never shown or controlled for non-OpenAI models, and nothing is logged in a way that lets the owner or the bot find out what happened. Telegram is the only channel and it handles text only.

Roughly 40% of the server code (Missions ledgers, Engine Workshop, candidate verifier, Study/Learning, hub-replica Sync, auto-update) serves features no competitor's user asks for, while the features every competitor has (fast streaming, many providers with thinking control, strong search and extraction, a real terminal, several messaging channels, cron) are thin or missing. The recovery plan below cuts fixed cost first, then fixes research, then the UI, then channels, then simplifies.

## 2. What happened in today's DeepSeek session

Bot **Finance**, model `deepseek/deepseek-v4.1-flash-1017` through OpenRouter, Approve-for-me policy, every tool group enabled including Browser and Terminal, 16 skills. The run executed on the Home server; only the transcript replicated to the Mac, so per-step timings are not available here (see §3.F).

**07:45:01** owner asks whether the bot can open a Hyperliquid vault page and track a wallet. Run 1: step 1 `brain_read overview` (irrelevant, result shortened to a 2,000-char preview), step 2 at +28 s posts a sentence and opens the vault page in the browser. Hyperliquid is a script-rendered app: every `browser_open`, `browser_new_tab`, `browser_wait` and `browser_click` returned an outline with zero readable text. About eight model turns and no answer in four minutes.

**07:49:03** owner re-sends the same message, which replaces run 1. Run 2: step 1 at +16 s writes a plan and a sentence. Then, over about six minutes and twelve model turns, the bot:

- called `http_fetch` on `api.hyperliquid.xyz/info` four times (GET with and without `format:'raw'`); every call failed with "The web tool only reads textual content" because the tool is GET-only and rejects non-text content types (`lib/net-policy.mjs:71,82`). The Hyperliquid info API is POST-only, so the task was impossible through the API tool;
- read the same skill five times (`skills_read`) and the same skill file four times (`skills_file`), receiving identical content each time;
- opened the same vault URL three times and ran `browser_text` twice, getting 1,571 chars of application shell;
- fetched `stats-data.hyperliquid.xyz/Mainnet/vaults` and hit the hard 1 MB limit with no partial read.

Nothing stopped the loop: `repeatedFailure` blocks only an identical call that already failed twice (`lib/work-quality.mjs:75-78`), successful duplicate reads are not counted, and the research guard needs six consecutive unproductive observations (`lib/web-research.mjs:36-43`). The plan step "vault" stayed `in_progress`, so the UI showed "step 1" for the whole six minutes; the UI does not show model steps, tool names, durations or reasoning while a run is live (§3.D).

**07:55** owner asks the bot to check the logs and explain the delay. The bot has no access to its own run events or timings, so it read unrelated workspace reports until the owner cancelled it.

For comparison, the other DeepSeek bot's run on 5 November shows the model itself answering in 3–13 s per turn; its 27-turn, 52-tool-call run was slow because of six 30 s `http_fetch` timeouts against Overpass mirrors and the loop, not because of DeepSeek. The six minutes were spent in an unproductive tool loop with ~65K prompt tokens per turn, not in one long model call.

Root causes, in order of impact: GET-only fetch (§3.B), no readable SPA content (§3.B), ~100 tools and ~30K fixed tokens per step on a flash model (§3.C), no duplicate-call detection (§3.C), plan-step-only progress UI with no reasoning or tool stream (§3.D), no logs or run introspection (§3.F).

## 3. Findings

Severity: **P0** blocks everyday use or wastes money on every task; **P1** makes the product clearly worse than competitors; **P2** quality and hygiene.

### A. Model providers and inference

| # | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| A1 | P0 | Reasoning is dropped on every transport. Chat-completions ignores `delta.reasoning_content` / `delta.reasoning` (DeepSeek, OpenRouter, Ollama, xAI); Responses counts `reasoning_summary_*` events but never emits them; Anthropic accumulates `thinking_delta` and never emits it. The user sees an animation for minutes. | `lib/providers.mjs:214-233`, `:255`, `:273` | Emit a bounded `reasoning.delta` run event from all three adapters; render a collapsible Thinking block; store a short reasoning summary on the message. |
| A2 | P0 | Reasoning control exists only for OpenAI/Codex and is dead for every OpenRouter model: it requires the catalog to declare `supported_parameters` with `reasoning_effort` **and** `supported_reasoning_levels`, which OpenRouter does not publish. Measured: 0 of 200 OpenRouter models are controllable; DeepSeek direct, GLM, Ollama and Anthropic get nothing. "Reasoning: auto" on the Finance bot sends no parameter at all. Anthropic never receives a `thinking` block, so Claude never thinks. | `lib/providers.mjs:26-34`, `:187`, `:201`, `:233`; `data/state.json` connection catalogs | Make effort a bot-level setting mapped per provider (OpenRouter `reasoning:{effort}`/`{max_tokens}`, DeepSeek `thinking:{type}`, Anthropic `thinking:{type:'enabled',budget_tokens}`, OpenAI `reasoning.effort`), with a per-model override list, the way Hermes and OpenClaw do. |
| A3 | P0 | Fixed per-step payload: a fully enabled bot gets **101 tools ≈ 19K tokens of schemas**, a default bot 60 tools ≈ 13.6K; the system prompt is ≈22K chars ≈ 6K tokens before the bot's own instructions; the per-step `turn_context` adds 2–8K uncached tokens (frozen reference snapshot, plan JSON, recall diagnostics). Measured real runs: 65K prompt tokens per step on the DeepSeek bot, 91K–240K per step on Codex bots. | `lib/engine.mjs:817-825`, `:681-708`; `lib/providers.mjs:23` (cap 128) | Tiered catalog (~15 core tools always; groups loaded on demand), ≤200-char descriptions, reference snapshot into the cached system prompt, `turn_context` ≤500 tokens, guidance gated by group. Target ≤8K fixed tokens per step. |
| A4 | P1 | `max_tokens` defaults to 4,096 on chat-completions and Anthropic; on thinking models reasoning counts against it, producing truncated or empty answers ("Use a nonempty final response" appears in run history). No `max_completion_tokens` fallback for strict OpenAI-compatible endpoints. | `lib/providers.mjs:153`, `:233`, `:265` | Default 16K for models flagged as reasoning; retry once with `max_completion_tokens` on a 400 that names `max_tokens`. |
| A5 | P1 | Provider catalog has 7 entries: OpenAI, ChatGPT/Codex, Anthropic, xAI, OpenRouter, Ollama, custom. DeepSeek, Gemini, Groq, Mistral, Together, Fireworks, Cerebras, Moonshot, Z.ai, MiniMax all require the custom path with a hand-typed base URL; the owner's GLM connection is one. No Claude subscription OAuth, no Gemini. Hermes supports ~20 providers plus OAuth for Codex, Claude Max, xAI, MiniMax, Qwen and OpenRouter. | `lib/providers.mjs:7-15` | Add presets (base URL, auth header, quirks, reasoning mapping, known windows); add Claude Max OAuth. |
| A6 | P1 | Inference timeouts are 900 s total and 300 s idle; a stalled call sits five minutes with no feedback. Retries have no attempt cap (delay capped at 300 s), and there is no fallback provider or model chain. | `lib/providers.mjs:171`; `lib/autonomous-work.mjs:99-115` | Idle 120 s default (600 s for reasoning models), cap transient retries at 6, per-bot fallback model, status shown in the UI. |
| A7 | P2 | Tool results above a small threshold are replaced by a 2,000-char preview and require `tool_result_read` paging, adding model turns for ordinary reads. | `lib/task-tools.mjs:62` | Keep up to ~12K chars inline with head/tail window; page only beyond that. |

### B. Web research

| # | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| B1 | P0 | `http_fetch` is GET-only with no headers or body, rejects any non-text content type with a misleading message, refuses responses over 1 MB outright, and has a 15 s timeout with two attempts (30 s stall per slow host). JSON APIs that need POST (Hyperliquid, most GraphQL, many public data APIs) are unreachable. | `lib/net-policy.mjs:56-100`; `lib/agent-tools.mjs:411-415` | Add `method`, `headers`, `body` (JSON) with the same egress policy; accept JSON and text types; stream to a 5 MB cap with head/tail windows and paging; accurate error codes (405, non-text, too large). |
| B2 | P0 | Default search is DuckDuckGo HTML scraping (two layouts, CSS-class parser, challenge and rate-limit detection). Max 10 results, no freshness, region, news or site filters, no pagination (SearXNG `pageno` fixed at 1), no result cache. "DuckDuckGo requested a challenge" already appears in the Finance transcript. Brave, Tavily and SearXNG exist only as owner-assigned integrations. Hermes defaults to Firecrawl with Exa, Parallel, Tavily, Perplexity, Brave and keyless rotation; OpenClaw auto-detects a dozen backends. | `lib/web-search.mjs:103-227`; `:60-62` | Search provider abstraction with API-key backends (Exa, Firecrawl, Tavily, Brave, Perplexity, Serper, Parallel) and keyless fallback, filters, 20-minute cache, and results surfaced as citations in the reply. |
| B3 | P1 | Page extraction is a tag walker: no main-content detection, tables flattened to " | ", 80K-char head-only cut, 60 links, no Markdown. Hermes/OpenClaw use Firecrawl/Jina-style extraction with head/tail windows. | `lib/web-content.mjs:1-74` | `web_extract` through a readability algorithm or Firecrawl/Jina, Markdown output, head/tail window, paging. |
| B4 | P1 | Browser snapshots of script-rendered pages return an empty outline; there is no network-idle wait, no automatic text fallback and no screenshot-to-vision path even when the model accepts images. The bot burned eight turns on this today. | `lib/browser.mjs` snapshot/outline; today's transcript | Wait for network idle, fall back to `browser_text` and a screenshot for vision models automatically, report "page is script-rendered" once. |
| B5 | P1 | Research effort counters are injected into every prompt and can refuse the whole task with HTTP 409 ("Web research previously stopped without progress"). They add noise for strong models and do not stop weak ones in time (today's loop never reached the threshold). | `lib/web-research.mjs:36-62`; `lib/engine.mjs:853` | Keep as telemetry; replace the prompt text with duplicate-call blocking (§C4) and better tools. |
| B6 | P2 | `web_search` is not in the parallel read set, so multi-query research runs sequentially. | `lib/engine.mjs:64` | Add `web_search` and browser read tools to `PARALLEL_READ_TOOLS`. |

### C. Agent loop, prompt, context and memory

| # | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| C1 | P0 | Unconditional guidance names tools the bot does not have (`coding_*`, `mission_*`, `shell_start`, `lsp_start`, `workspace_image`) and protocol rules live both in descriptions and in the prompt. Small models hallucinate these names. | `lib/engine.mjs:117`, `:691` | Gate every guidance paragraph on the tool group that owns it; move protocol detail into tool results. |
| C2 | P0 | `shell_run` is not a shell: `spawn(executable,args,{shell:false})`, no persistent cwd or env, 30 s default and 120 s maximum, 250 KB output cap, literal args only. Ad-hoc code needs the `scripts_register` manifest ceremony plus approval per run. Hermes offers `bash` with persistent state, six execution backends and `execute_code`. | `lib/agent-tools.mjs:244-262`, `:416-420`; `lib/scripts.mjs:81-86` | `bash -lc` with per-task persistent cwd/env, 10-minute default, pattern-based dangerous-command classifier with auto-run for read-only/allowlisted commands, one `execute_code` tool. |
| C3 | P0 | Unattended lanes cannot act: risk review returns manual for any non-owner-chat source, and only 11 browser/search/skill actions are automatic. Routines, Telegram groups and delegated teammates block on `shell_run`, `integration_call`, `routines_*` for up to 24 h. Every integration call, including read-only GETs, needs approval. | `lib/action-risk-review.mjs:17`; `lib/action-review.mjs:11-23`; `lib/engine.mjs:1268`; `lib/integrations.mjs:107` | Per-bot command allowlist, `auto|ask` per integration tool for idempotent GETs, routines carrying pre-approved command digests. |
| C4 | P0 | No duplicate-call detection for successful repeats (today: same skill read five times, same URL opened three times). | `lib/work-quality.mjs:75-78` | Block the third identical read in a task with a one-line nudge; count duplicates in the progress guard. |
| C5 | P1 | Each reviewable action in owner chat costs an extra uncached model call (risk review), and every completed chat task runs two more (final memory review, final skill review). A five-command task costs ~8 extra inferences. | `lib/action-risk-review.mjs`; `lib/memory-review.mjs:80`; `lib/skill-review.mjs:34` | Replace per-action LLM review with the classifier from C2; run memory/skill review on a cheap auxiliary model, batched, off the critical path. |
| C6 | P1 | One endless conversation per bot. Chat `sessionId` is the bot id; "new topic" summarizes in place. The Finance thread holds 262 model messages (1.2 MB) since 1 November and compaction only begins at 90% of a 272K effective window. This is the "bot context is wrong" complaint: Hermes keeps one session per chat with compaction at 50% of the window to a 20% target, memory living outside the session. | `lib/engine.mjs:385`, `:1435-1447`; `lib/context-budget.mjs:51-53` | Sessions as first-class objects (new chat = new session, list of past sessions, resume), compaction threshold configurable (default 50–60%), memory and daily notes carried across sessions. |
| C7 | P1 | Compaction boundary bug: engine feedback (`continueWork`), earlier-task context and the compaction summary are all `role:'user'`, so the current task's outputs can be classified as "earlier tasks" and cleared, and the summary at index 0 can be dropped as a whole turn. | `lib/engine.mjs:181`, `:200-205`, `:640`; `lib/compaction.mjs:218` | Mark engine-injected messages with `kind` and exclude them from boundary and drop logic. |
| C8 | P1 | Whole step rejected when the model proposes more than 8 tool calls (Claude and Gemini routinely emit 10+ reads). Recall refresh is capped at 3 per task and consumed by plan edits, so `memory_refresh` goes dead early. | `lib/engine.mjs:919`, `:655`, `:856` | Execute the first 8 and return not-started for the rest; decouple recall budget from plan versions. |
| C9 | P2 | Recall is keyword TF-IDF with a 7-entry synonym table; paraphrases and cross-lingual queries (owner writes Ukrainian, notes often English) miss. Five overlapping retrieval tools (`memory_search`, `brain_search`, `session_search`, `memory_refresh`, `work_records_read`). | `lib/brain.mjs:258`; `lib/memory-quality.mjs:4-24` | Optional local embeddings (Ollama `nomic-embed`) behind `brainRecall`; one `recall` tool. |
| C10 | P2 | Skills: Hermes `SKILL.md` import and progressive disclosure are correct; bundled catalog is thin (two Tupies packages; Grok catalog exports no named entries) and there is no hub fetch beyond the reviewed catalog. MCP is Streamable HTTP only, through Integrations, approval-gated per call; no stdio MCP. | `lib/skill-import.mjs:43-99`; `lib/integrations.mjs:36` | ClawHub/skills.sh/GitHub sources with the existing scanner; stdio MCP client with per-tool auto policy. |

### D. Chat UI

| # | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| D1 | P0 | No SSE or WebSocket. Live chat is a 2 s poll of `GET /api/bots/:id/messages` that returns the whole transcript plus the whole run object with all events; each poll rebuilds the entire thread HTML. The engine flushes partial text at most every 400 ms, so streamed text arrives in ≥2 s chunks. An incremental `GET /api/bots/:id/events?after=` endpoint exists and nothing in the frontend calls it. | `public/app.js:1631`, `:1087`, `:1060-1086`; `server.mjs:330`; `lib/api-native.mjs:341` | 500 ms live loop on `/events?after=` (or SSE) during a run; patch only the partial node. |
| D2 | P0 | While a run is live the user sees a canvas animation ("Roki is thinking") with elapsed seconds, at most six de-duplicated tool labels, no arguments, no results, no model-step counter unless a plan exists. Once the run completes nothing in the transcript records which searches, pages or commands happened. | `public/app.js:981-992`, `:1030-1044`; `public/thinking-waves.js:240-270` | Persist a compact tool-call card per `tool.completed` into the message list; show "model step N · tool · Ns"; collapsible Thinking block (A1). |
| D3 | P0 | Boot is blocked on a 5.8 MB (1.26 MB brotli) vendor bundle (mermaid, elk, cytoscape, katex, chart.js, hljs) loaded with `defer` before `app.js`; 22 scripts and 24 stylesheets (6.7 MB raw / 1.5 MB brotli) load unconditionally on every device with `Cache-Control: no-cache`, ~46 revalidations per load. | `public/index.html:41,63`; `server.mjs:481`; `public/rich-content.mjs:1-6` | Dynamic-import the rich bundle on first rich render; split mermaid/katex/chart.js; immutable hashed asset URLs. |
| D4 | P1 | Approval card offers Deny / Allow once / Stop only; no "Allow this tool for this task". Send is disabled during a run; only "Add direction" is possible, so a next message cannot be queued. No Copy, Edit-and-resend, Retry, Regenerate, Delete or export. | `public/app.js:592-600`, `:1085`, `:187-207` | Standing per-task grant on the card; message actions; queued next message. |
| D5 | P1 | Provider and bot setup: adding a provider is four modals; model is a free-text input with a datalist; capabilities (reasoning, vision, window) appear only in Chat options; no pricing or speed. Bot creation opens a nine-section form. A new user meets ~40 named destinations (5 main tabs, 9 settings tabs, 9 bot-profile tabs, 9 bot-settings sections, Missions, Routines, Rooms, Workshop, Scripts, Learning, Brain). | `public/app.js:1226-1242`, `:1185-1217`, `:318-323`; `public/bot-profile.js:168` | One-screen provider setup with presets (A5) and a catalog picker; three-field bot creation; Advanced section for Workshop, Engine workshop, Scripts, Desktop, Coding, Study, Missions. |
| D6 | P2 | Inline images are forbidden in replies (`img` in DOMPurify FORBID_TAGS), so charts and screenshots cannot render inline. Uploads are base64 JSON bodies (33% inflation, no progress, no drag-drop or paste). Dead `.bot-inspector` aside shipped in every chat and unreachable on desktop. Whole-app `innerHTML` rewrite on every navigation; drafts memory-only. No `aria-live` on the thread. | `public/rich-content.mjs:24`; `public/app.js:631-637`, `:569`, `:419-440` | Allow `img` with safe `src`; multipart uploads with progress; remove inspector; `aria-live`. |

### E. Channels, automation, OAuth, storage

| # | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| E1 | P0 | Telegram is the only channel and is text-in/text-out: non-text updates (photos, voice, documents, commands) are consumed and silently dropped after the offset advances; replies are raw plain text with no `parse_mode`, no typing indicator, no `sendDocument`; delivery happens only on a terminal run status, so an approval or question leaves the chat silent and every further message gets "already working"; group chats give each sender a private lane; no outbound `message_send` tool or routine `deliverTo`. Hermes ships 20+ channels; OpenClaw 10+. | `lib/channels.mjs:95`, `:103`, `:121`, `:11`; `lib/sessions.mjs:44-47` | Media in (transcribe voice with the existing `Speech.transcribe`), Markdown→HTML, typing, documents out, inline-keyboard approvals, shared lane per chat with sender names, per-lane concurrency, `message_send` tool and routine delivery. Then Discord, Slack inbound, generic webhook, WhatsApp. |
| E2 | P0 | ChatGPT renewal fails closed on any exception: the bundle is marked `in_progress`+`needsLogin` before the POST, and a timeout or reset saves `refreshState:'uncertain'`, after which every `bearer()` throws 401 until the owner re-signs in through an SSH-forwarded loopback callback. | `lib/oauth.mjs:118-127`, `:107`, `:43,56` | Mark uncertain only after the request was sent and the response is ambiguous; retry pre-send failures with backoff; device-code or paste-redirect flow for the VPS. |
| E3 | P1 | Scheduling supports `interval ≥5 min`, `daily`, `weekly`, `once`; no cron, monthly, multiple times, natural-language entry, or "deliver to the chat that asked"; runs only on the hub, so a VPS outage stops all automation. The routine workflow DSL (fetch/read/json/select/script with templates, hand-written JSON) is a mini-ETL that competitors avoid. | `lib/schedule.mjs:36-52`; `lib/routine-workflow.mjs`; `server.mjs:151,494` | Cron + natural-language entry, deliver-to-chat, failover to any linked engine, retire the DSL in favor of a prompt plus pre-approved commands. |
| E4 | P1 | Storage: one pretty-printed `state.json` (20 MB on the Mac, 24 MB on the VPS) is re-serialized and atomically rewritten on **every** mutation, including the 400 ms partial-text flush (40 `local:true` call sites). During streaming that is ≥2.5 full writes per second, ~100 ms of synchronous JSON per write on one queue that every HTTP mutation waits behind, plus a second 24 MB copy in RAM. Run records are capped at 50 per bot and are not replicated between engines. | `lib/store.mjs:115-122`; `lib/engine.mjs:737`; `lib/sync/docs.mjs:19`; `docs/operations.md:96` | Transcripts, runs and events into `node:sqlite` (or per-bot JSONL); config stays in a compact `state.json`; partial text in memory only; coalesce flushes ≥1 s; replicate run summaries. |
| E5 | P2 | Browser sessions are an in-memory map (max 100, 12 h) lost on every restart; stale `Tupies/0.2.0` user agents; `/api/state` rescans every message of every bot per call. Security itself is solid (HttpOnly/SameSite cookies, CSRF, Origin checks, strict CSP, scrypt, rate limits, sealed secrets, consistent egress policy). | `server.mjs:160,222`; `lib/channels.mjs:58`; `lib/store.mjs` `publicState` | Persist hashed sessions; cache derived state by revision. |

### F. Observability and diagnostics

| # | Sev | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- |
| F1 | P0 | The engine log contains one startup line. There is no per-request record of provider, model, time to first token, duration, tokens, finish reason or error, and no per-tool duration. Run events exist only on the executing engine, are not replicated, and expire after 50 runs per bot. Today's run cannot be timed from the Mac at all. | `.runtime/*/mac-engine.private.log`; `lib/sync/docs.mjs:19`; `lib/engine.mjs:115` | Structured JSONL log (rotating, redacted) for model calls and tool calls; per-run summary replicated; Activity view with per-step timings; a `doctor` command that checks providers, search backends, browser and channels. |
| F2 | P1 | The bot cannot inspect its own runs (`work_records_read` is partial), so "check the logs" produced random file reads. | `lib/work-quality.mjs` | A `run_inspect` tool returning the last runs' steps, tools, durations and errors. |

### G. Product scope and code health

- **Size.** 130 server modules, ~19,400 lines but 1.96 MB because lines run to 1,000–5,500 characters (`lib/engine.mjs` is 191 KB in 1,552 lines); 210 test files (2.7 MB); 1.6 MB of docs; `PROJECT_CONTEXT.md` 238 KB and `docs/verification.md` 395 KB are release diaries; 132 commits in 12 days. This density defeats both human review and agent edits.
- **Where the code went.** Missions 1,680 lines (15 modules), Sync 1,536, Skills 1,473, Study/Knowledge/Learning 1,343, Browser 799, Coding/Azure 766, Workshop + Engine workshop + verifier 709, Documents 626, Routines 434, Rooms/delegation 540, **Channels 159**.
- **Cut:** Engine Workshop, tool Workshop, candidate verifier and its Docker image and seven scripts; Mission pricing/effort/resource ledgers; routine workflow DSL; `azure-devops.mjs`.
- **Freeze behind a default-off flag:** Missions (second orchestration model on top of runs), Study/Knowledge/Learning, Desktop, Local coding.
- **Rethink:** hub-replica Sync plus Sparkle/systemd auto-update (re-sealed secrets, HLC clocks, security epochs, ten release scripts). For one owner, "the VPS is the engine, Mac and iPhone are clients" removes ~1,800 lines and the largest correctness risk.
- **Keep and invest:** approvals engine and sealed secrets, compaction design, skills import, Telegram as the seed of a real gateway, routines, documents.

## 4. Competitor reference (November 2026)

| Capability | Tupies today | Hermes Agent | OpenClaw | Grok Bot |
| --- | --- | --- | --- | --- |
| Providers | 7 types; Codex OAuth only | ~20 incl. DeepSeek, Gemini, Groq, Z.ai, Kimi, Ollama; OAuth for Codex, Claude Max, xAI, MiniMax, Qwen, OpenRouter; fallback chains | Similar breadth; Codex OAuth; Claude CLI reuse | Hosted, model not published |
| Reasoning control / display | OpenAI/Codex only; nothing shown | `reasoning_effort` none…ultra per model, `/reasoning show`, 600 s stale timeout for R1-class | `/think off…ultra` per provider, `/reasoning stream` | none exposed |
| Web search | DDG scrape default; Brave/Tavily/SearXNG as approved integrations | Firecrawl default; Exa, Tavily, Parallel, Perplexity, Brave, SearXNG, DDG; keyless rotation; 20-min cache | Brave, Exa, Firecrawl, Perplexity, Tavily, Parallel, Gemini, Grok, Kimi…; auto-detect | built-in + Composio |
| Extraction | tag walker, GET only | `web_extract` 15K head/tail, paging | `web_fetch` + Firecrawl | computer use |
| Terminal / code | literal spawn, 120 s max; script manifests | `bash` with 6 backends, `execute_code` | `exec`, sandbox, `code_execution` | cloud CLI |
| Compaction | summary handoff at 90% of effective window, one thread per bot | 50% threshold → 20% target, protect first 3 / last 20, auxiliary model | min(75%, window−reserve), memory flush, `/compact` | auto-summary, no control |
| Memory | core facts + Obsidian vault + session search, keyword recall | MEMORY.md + USER.md, FTS5 session search, Honcho | MEMORY.md + daily notes, hybrid embeddings, dreaming | per-bot memory + dated log |
| Channels | Telegram text | Telegram, Discord, Slack, WhatsApp, Signal, SMS, Email, Matrix, Teams, iMessage… | Telegram, Discord, Slack, WhatsApp, Signal, iMessage, Teams, Matrix… | apps, Slack, X, voice |
| Scheduling | 4 kinds, hub only | cron tool, any-platform delivery | `automations` cron, webhooks, heartbeat | routines ≥5 min, triggers |
| Streaming UI | 2 s poll, whole-thread rebuild | TUI + message-edit streaming | preview-channel streaming | step list + live screen |
| Approvals | strong, exact, per action; weak unattended | dangerous-command approval, `/approve` | exec approvals, sandbox opt-in | Auto Review cards + rules |

Competitors' own complaints are instructive: Hermes users report web-tool wiring bugs and `reasoning_effort` never reaching DeepSeek; OpenClaw users report token bills and lossy compaction; Grok Bot users report caps and an unbounded single thread. Tupies' approval model and compaction design are competitive; everything around them is not.

## 5. Recovery plan

Each phase ends with a measurable gate run on three models (Codex `gpt-6.1-sol`, DeepSeek V4.1 Flash via OpenRouter, Claude via API) over a fixed 12-task set: three web-research questions (one needing a POST API, one a script-rendered page), two document tasks, two coding tasks, two Telegram round-trips, one routine, two memory tasks. Record per task: completed without owner help, model turns, tool calls, fixed tokens per step, wall time, longest silent gap.

### Phase 0 — stop the bleeding (one week)

1. Stream reasoning from all three adapters (A1) and show a Thinking block (D2).
2. Bot-level reasoning effort mapped per provider; `thinking` for Anthropic; 16K default output for reasoning models (A2, A4).
3. `http_fetch` with method, headers, body, JSON acceptance, 5 MB streamed cap with head/tail and paging, accurate errors (B1).
4. Duplicate-call blocking on the third identical read (C4); `web_search` parallel (B6).
5. Structured JSONL logging for model and tool calls, per-run summary replicated, timings in the Activity view (F1); `run_inspect` tool (F2).
6. Live loop on `/events?after=` with a model-step and tool indicator (D1, D2 minimum).
7. OAuth renewal no longer fails closed (E2); Telegram sends a notice with a deep link on approval/question states (E1 minimum).
8. Provider presets for DeepSeek, Gemini, Groq, Mistral, Together, Fireworks, Z.ai, Moonshot, MiniMax (A5).

Gate: today's Hyperliquid question answered in ≤6 model turns on DeepSeek; no silent gap over 5 s in the UI; a per-step timeline visible for every run on both engines.

### Phase 1 — inference core and prompt diet (two to three weeks)

1. Tiered tool catalog, ≤200-char descriptions, group-gated guidance, reference snapshot into the cached prefix, `turn_context` ≤500 tokens (A3, C1). Target ≤8K fixed tokens per step, down from ~30K.
2. Real terminal (`bash -lc`, persistent cwd/env, 10-minute default) with a pattern-based dangerous-command classifier, allowlisted auto-run including routines, and one `execute_code` tool (C2, C3).
3. Replace per-action LLM risk review with the classifier; move memory/skill reviews to a batched auxiliary model (C5).
4. Sessions as first-class objects: new chat = new session, session list and resume, compaction at a configurable 50–60% threshold, memory and daily notes across sessions (C6). Fix the compaction boundary and the >8-calls and recall-budget issues (C7, C8).
5. Retry cap, per-bot fallback model, shorter idle timeouts with visible status (A6).

Gate: fixed tokens per step ≤8K on the default bot; ≥80% of the 12 tasks complete on DeepSeek without owner intervention; no task exceeds 15 turns on Codex.

Status (9 November 2026): merged (PR #46) and installed on the Mac and VPS engines (signed Engine `0.5.0-engine.beta.6`). Measured fixed payload 5.0K tokens per step on the default bot (19.4K before). The live-model parts of the gate are not yet run.

### Phase 2 — research that works (two weeks)

1. Search abstraction with Exa, Firecrawl, Tavily, Brave, Perplexity, Serper, Parallel and keyless DDG/SearXNG fallback; filters, cache, citations in replies (B2).
2. `web_extract` with main-content extraction to Markdown, head/tail windows, paging (B3).
3. Browser: network-idle wait, automatic text and screenshot fallback for script-rendered pages (B4).
4. Research counters become telemetry only (B5).

Gate: the three research tasks answered with cited sources in ≤5 turns on all three models.

### Phase 3 — chat UI (two weeks)

Lazy-load the rich bundle and hash assets (D3); persisted tool-call cards and sources block (D2); message actions, queued next message, per-task standing approvals (D4); one-screen provider setup with presets and catalog picker, three-field bot creation, Advanced section for expert features (D5); inline images, multipart uploads, remove dead inspector, `aria-live` (D6).

Gate: cold boot under 1 s on a cached-miss load; a new user adds a provider and gets a first answer in under two minutes without documentation.

### Phase 4 — channels and automation (three to four weeks)

Telegram media in and out, Markdown→HTML, typing, inline-keyboard approvals, shared group lane, per-lane concurrency, `message_send` tool and routine `deliverTo` (E1); Discord and Slack inbound, generic inbound webhook, then WhatsApp; cron and natural-language schedules with delivery to the requesting chat and failover to any linked engine, retire the workflow DSL (E3); Claude Max OAuth and Gemini presets (A5).

Gate: "every morning at 8 send me X on Telegram" configured from chat and delivered; a photo sent on Telegram is described by a vision model; a Discord server and Slack workspace each complete a round trip.

### Phase 5 — simplify and harden (ongoing from Phase 1)

Transcripts, runs and events into `node:sqlite`, compact config state, coalesced flushes (E4); cut Engine Workshop, candidate verifier, mission ledgers, workflow DSL, Azure DevOps; flag Missions, Study/Learning, Desktop, Local coding off by default; decide on "VPS is the engine" versus hub-replica sync (G); reformat the codebase with a formatter and split `engine.mjs` so lines are reviewable; collapse `PROJECT_CONTEXT.md`, `docs/verification.md` and `docs/roadmap.md` into a status table plus changelog, each under 30 KB.

Gate: server code under 12,000 formatted lines; full test suite under 10 minutes; `state.json` under 2 MB.

## 6. What this audit did not do

- Did not read the Home server's run events or journal; today's per-step timings exist only there.
- Did not run the test suite, the eval harness or any live model; competitor figures come from documentation and public issue trackers, not from matched runs.
- Did not change engine code or deploy anything. Earlier plans in this folder (`tupies-agent-quality-20261028.md`, `grok-parity-audit-20261028.md`) remain the record of what was built in October; this document supersedes their open items where they conflict.
