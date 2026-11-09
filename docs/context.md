# Working context

How a bot's conversation becomes the context its model sees on each step. The design follows research into Hermes Agent, Codex CLI and Grok Bot (27 October 2026); the staged plan is in the roadmap.

## What the model sees

Each model step sends four engine-assembled parts (`lib/prompt-context.mjs`):

1. **System prompt** (`NativeEngine.instructions` → `systemPrompt`): identity, the owner-configured bot instructions, Engine workflow rules, a one-line index of tool groups that load on demand, and guidance for the core tools the bot is offered. Every guidance paragraph is gated: it appears only when the bot is offered the tools it names, and detail for on-demand groups arrives with `tools_load` instead (see [Tool use](tool-use.md#provider-tool-catalog)). Core memory, skill descriptions, teammate profiles and recalled notes are reference data and never part of the system message. It is built once per task and stays byte-stable between steps; it does not depend on the task, so for an unchanged bot configuration it is identical across tasks.
2. **A view of the bot's stored conversation**, with bulky earlier tool trajectories projected out for new eligible tasks, then fitted to the model's window (below).
3. **The reference data** (`referenceMessage`): one `<reference_data>` user-role message inserted just before the current task's first message. It holds the task-start snapshot as escaped JSON (`coreMemory`, `assignedSkills`, `teammates` and any other keys a workstream adds, such as `previousChat`) plus the notes and earlier-conversation excerpts recalled at admission, in the escaped `<recalled_note>` wrapper. It is frozen for the task (`context.referenceContext`, saved in continuation checkpoints), so it sits inside the cached prefix for every step after the first, while earlier history before it stays cacheable across tasks. It is inserted after fitting; its size is reserved first.
4. **The turn context** (`NativeEngine.turnContext` → `turnContextBody`): a small `<turn_context>` block with today's date and daily note, the owner's time zone, the run plan as compact text (`Current plan v2 …` with `[x]`/`[>]`/`[ ]` per step id), Mission identity/effort, observed web-research counters, recall refreshed after the task started, skills assigned during the task, guidance for a group just loaded by a direct call (shown once) and any compaction note. Recall diagnostics stay in the `memory.recalled` event and run diagnostics, not in model context. Providers append it as the last user message; it is never stored.

Measured with `node scripts/measure-prompt.mjs` (UTF-8 bytes / 4, the Engine's estimator), the fixed per-step payload (system prompt + offered tool schemas + turn context) is about **5.0K tokens for a default new bot** (2.5K system, 2.4K for 15 core tools, ≤0.1K turn context) and **5.1K for a fully enabled bot** before it loads groups (20.5K with every group loaded). Before the tiered catalog it was 19.4K (default, 62 tools) and 28.2K (fully enabled, 117 tools), with the reference snapshot and recall additionally repeated uncached in every turn context. `test/tool-catalog.test.mjs` keeps the default bot at or below 8K and the turn context at or below 500 tokens.

The display transcript (`state.messages`) is separate and never shortened.

Mission turn context additionally includes the Engine-owned effort profile, shared committed/reserved use and finishing guidance. This bounds work independently of the model reasoning setting. The continuation keeps its original model/reasoning/capabilities; changing Mission effort changes the shared allowance only. See [Missions](missions.md#mission-effort).

## Earlier tool history in new tasks

New direct-chat, delegated and Mission runs snapshot a model-only history policy. When older tool trajectories exceed8,192 estimated tokens, they leave the working view before the full model window fills. With Memory enabled, recent earlier requests/replies become an8,192-token background packet with original roles/run IDs; exact older requests remain readable with `session_search`/`session_read`. Without Memory, all earlier user requests and text replies stay, and only older tool trajectories leave the view. An existing compaction handoff remains whole because it may describe the same task. Plain long conversations without bulky tool trajectories retain the normal summary-compaction path.

The current task's messages and call/result pairs, including engine continuation notes, stay intact. This projection does not rewrite the canonical stored history or create a summarizer call. `work_records_read` can read a retained historical observation by exact `runId` and `resultCallId`, with6,000-character pages, `nextResultOffset` and a required matching `resultVersion` after the first page. It reuses the existing bot/lane visibility boundary, rejects another bot or third-party Telegram history and redacts retained text again. Missing, expired, ambiguous or changed observations are refused explicitly. A retained observation can already be a shortened result; this is not a permanent full-payload archive. Read history instead of repeating an action to reconstruct its result. Historical content and success receipts grant no authority and do not certify current state.

Explicit **Maximum** context keeps the prior full-history fitting behavior. The selected history policy is retained in execution checkpoints; older saved continuations without it keep their original behavior. Model/provider/reasoning and tool capabilities are unchanged. This is source behavior, not a deployment or a measured real-model quality/savings claim.

## Conversations and lanes

A bot has one **Bot Chat**: the app and its chat, the owner's own Telegram direct messages and requests from teammates all continue it. Its model history keeps the bot's id as its key, as it did before lanes existed, so no data moved.

Other work runs in its own lane with a separate model history (`lib/sessions.mjs`):

| Lane | Key | History |
| --- | --- | --- |
| Telegram from anyone else | `telegram:<channel>:<chat>`, plus `:<user>` in a group | Persistent per chat, and per person in a group |
| Team room | `room:<room>` per member | Persistent; each turn carries only what is new (below) |
| Routine | `routine:<routine>` | Fresh on every run; the last completed output (≤4,000 characters) comes along as `<previous_output>` |

A lane's id is derived from the bot and the key (`<botId>--<kind>-<16 hex>`), so every engine computes the same one, and it starts with the bot's id, so sync can tell whose it is. Each lane has a synced record in `state.sessions` (`{id, botId, kind, key, createdAt, updatedAt}` plus lane data such as `roomSeen`). The display transcript still shows every lane's messages in the Bot Chat. A display message from another lane carries its `sessionId`, and a routine's carries its `routineId`. When an owner room or routine run completes, the Bot Chat model history gets one short record:

```
[Elsewhere: routine "Morning digest"]
Asked: …
Answered: …
```

The record holds at most 500 characters of the request and 2,000 of the answer, with engine-owned `sourceLane`, `sourceSessionId` and `runId` metadata. Third-party Telegram work never supplies this bridge to the owner's model context. Telegram lanes are chosen with the channel's **Your own Telegram user ID** (`ownerUserId`), which must also be an allowed user ID. Without it, every Telegram chat gets its own lane. Deleting a bot removes its Bot Chat, every lane and their records.

**Older context:** request construction and summary generation filter explicitly Telegram-scoped bridges and the exact old `[Elsewhere: a Telegram chat with someone else]` message shape, without changing the display transcript. A later compaction excludes those records from its new model history. An already generated legacy summary may have paraphrased private material without retaining its source; a marker filter cannot reliably detect or rebuild that text. Such ambiguous existing summaries are preserved rather than silently erased. Forward lane isolation and recognized-bridge filtering are verified; complete repair of unknown legacy summary content is not claimed.

## Team rooms

Each member keeps its own room conversation. A turn's prompt contains the latest user task and the room messages since that member's last turn (its `roomSeen` watermark, stored on the lane record when the turn starts). The member's own replies and the task shown above are left out of that list. The list is bounded:

- at most 200 messages and about 32,000 characters, keeping the newest;
- a single message longer than 8,000 characters is cut to an excerpt;
- the prompt says how many earlier messages were left out.

A member that joins later starts with that bounded recent history. The prompt also reminds members that their private chats are not part of the room.

## Limits follow the model's window

`lib/context-budget.mjs` works out the limits for a bot on a model, in tokens, with Codex's thresholds:

- **Window:** an owner-set `contextWindow` on the connection wins. Otherwise the window from the provider's catalog applies (`context_window`, `context_length` and similar fields, cached on `connection.models`), then a small table of known model families, then **128K** for an unknown model. Guessing too high fails requests; guessing too low only compacts earlier.
- **Ceiling:** by default at most **272K** of a larger window is used, because every step resends the whole context. A bot's `contextLimit` can be `''` (automatic, 272K ceiling), `'128k'` or `'max'` (the full window).
- **Usable:** 95% of the effective window, less the output reservation when that is smaller. A context above this is refused.
- **Compaction point:** 90% of the effective window. For a ChatGPT-subscription model with a 272K window, that is 258,400 usable tokens and compaction from 244,800.

Token counts are UTF-8 bytes over four, which counts Cyrillic about twice as dense as English. After each response the engine compares the provider's reported prompt tokens (`input_tokens`/`prompt_tokens`, including Anthropic's cached segments) with its estimate. It keeps that ratio per connection and model, so later estimates track the real tokenizer. Tool schemas and the turn context are reserved before the conversation is fitted.

## Compaction order

`compactConversation` in `lib/engine.mjs` keeps the conversation itself for as long as possible. Above the compaction point it does the following, in order:

1. **Tool outputs from earlier tasks** longer than 200 characters are replaced with a stub, all at once. Doing them together keeps the context identical from one step to the next. Their retained copies expired with their tasks, so the stub offers no handle.
   - **Summary.** If the context is still over the point after step 1, the older turns are summarized (see below), before anything else gives way. Up to three attempts are allowed in a task, with a new attempt only after the canonical history has grown; an unchanged oversized history cannot trigger an endless summary loop.
2. **The current task's oldest tool outputs** are shortened to 4,000 characters and then omitted. A retained copy's `resultId` stays readable with `tool_result_read`.
3. **Whole earlier turns** are dropped, oldest first. This also happens when more than 900 messages would be sent, since providers accept at most 1,000. The current turn always stays.

Tool calls and their results are never separated. A note in the turn context tells the model what was cleared or omitted. The `context.compacted` event reports `omittedTurns`, `clearedResults` and `shortenedResults`. Steps 1–3 only shape the request; the stored model history changes only through a summary.

## Summary compaction

`lib/compaction.mjs` follows Codex and Hermes. It never touches the display transcript; it rewrites only the model history.

1. **What is kept.** The turn in progress stays whole, and so do the most recent whole turns that fit a tail budget: 2.5% of the effective window, 10K–25K tokens, at most a fifth of it. Everything earlier is summarized.
2. **The summary request.** The bot's own model writes a handoff summary with these sections: Goal, User preferences and constraints, Done, In progress, Decisions, Files and artifacts, Open questions and Critical details.
   - Short histories use one summary request. Oversized histories use at most four source chunks and one merge, within a shared timeout and cancellation signal. The source path no longer clips every user/tool/assistant message or silently discards the middle before summary generation. Long messages can span chunks with exact source/body offsets.
   - Requests reserve output capacity and overhead using the selected model's effective window and the existing UTF-8 token estimate. Source chunks are also capped at 160,000 characters each. An earlier summary is passed in to be updated; if it must be shortened for the model window, coverage says so.
   - When the finite call/input budget cannot cover every source, a chunk fails during automatic compaction, or the final merge fails, the handoff explicitly says it is partial. It records covered/omitted source character counts, failed chunks and merge status. This is input coverage, not a guarantee of the model's summary quality.
3. **The source-linked handoff.** `lib/context-handoff.mjs` retains a bounded record of the requested outcome, exact requirement candidates and observed tool replies. Where available, a user message keeps its actual `sourceMessageId`; tool records carry run/call identities. Legacy history entries use clearly labelled snapshot indexes, not invented `session_read` IDs. Exact excerpts survive later compactions without depending entirely on another model paraphrase. Earlier constraints and recent corrections remain candidates together; this helper cannot decide which conflicting natural-language statement is applicable.
   - Before summary generation, engine-owned message/run references are checked against the same lane-readable display history as transcript retrieval, including the current task. Missing or out-of-scope identities in current or inherited handoffs are downgraded to snapshot locations while their text is preserved. `compactCoverage.sourceReferences` records whether validation ran and how many identities were rejected. This validates reference availability, not the truth of a model-written summary or every citation inside its prose.
   - At most 32 requirement excerpts and 16 tool observations fit a 12,000-character structured record. Failures/unknown outcomes are prioritized. Dropped items are counted. A source tool reply is marked observed, failed or unknown, never promoted to independently verified task completion.
   - All handoff content is data. It cannot grant permissions, revive an approval or authorize replay. Literal requirement recognition is bounded and multilingual but does not guarantee that every important sentence was recognized. Search/read the source for missing exact details.
4. **The new history.** One `<conversation_summary>` message holds the model summary, the source-linked record and up to 24,000 characters of earlier user quotations. Its total visible size is limited to a quarter of the effective model window (with a small minimum), shrinking quotations and whole handoff entries as needed and disclosing partial coverage. The kept turns follow it. Only the model history changes; the display transcript remains intact.
5. **The record.** The lane record stores `summary`, `compactedAt`, `compactions`, `compactMethod` (`summary`, `staged-summary`, `partial-summary` or `fallback`) and `compactCoverage`. A Bot Chat gets a lane record (`kind: 'chat'`) the first time it is summarized. Its display transcript gets a short Tupies note, and the run records a `context.compacted` event with the method, summarized-message count and coverage.
6. **When all summary requests fail during a task**, a plain record of recent requests and answers is used (`compactMethod: 'fallback'`) alongside the exact handoff and partial-coverage notice. Stop still cancels compaction; cancellation never becomes a fallback success. An owner-requested failure leaves the history unchanged.

The deterministic regression fixtures reproduce a requirement that the former middle-elision path lost, preserve exact identifiers and failed tool observations through three compactions, bound requests for small windows and verify that overflow recovery never repeats an already committed write. They do not establish real-model retention or superiority to another product; the agent evaluation runner records those separately.

## Owner-requested compaction

`POST /api/bots/{id}/compact` takes `{topic?: boolean}`. Both forms are refused while the bot works, is reserved by a room or runs on another engine, and no task can start while a summary is being written.

- **Summarize older messages** (`{}`) keeps the recent turns. A short conversation is left as it is.
- **Start a new topic** (`{topic:true}`) summarizes everything into one background summary and continues the same conversation. Grok Bot 0.77's packaged reset confirmation instead says the conversation starts over while memory, files, routines and settings remain; its client delegates reset to a service, so physical transcript deletion is not established. See the [package comparison](research/grok-bot-0.77.0.md).
- **If the summary request fails**, nothing changes and the error is reported.

## When a provider says the context is too large

`contextOverflow` recognises a provider's context-length error and the limit it names (OpenAI, Anthropic and similar wording); token rate limits are excluded. The engine then does the following:

- It stores a stated limit on the model's catalog entry (`contextSource: 'provider-error'`).
- It compacts to that limit and sends the same model step once more. Without a stated limit it aims at 75% of what it sent.
- Only the model call repeats; no tool runs again. A second overflow in the same task fails it.
- It records a `context.overflow` event.

## Prompt caching

- **OpenAI Responses / ChatGPT:** `prompt_cache_key` is a 32-character digest per bot, so no bot name or id leaves the engine.
- **Anthropic:** cache breakpoints mark the system prompt and the last three messages, never the turn context block.
- **Other providers:** compatible providers use their own automatic caching.

Cached prompt tokens are added up per task in `run.usage.cached_tokens`. Each run also records `run.context`: `{window, source, compactAt, tokens}`.

## Owner controls

- **Settings › Models › provider › Advanced endpoint settings › Context window (tokens):** for local or compatible services that run a model with a smaller context than it supports (for example Ollama's `num_ctx`). Ollama does not report its window, so set it there.
- **Chat options:**
  - the selected model's window and the point where older material gets organized;
  - a **Conversation** section with the conversation's estimated size, when it was last summarized, and **Summarize older messages** and **Start a new topic**.
- **Bot settings › Context limit:** Automatic (up to 272K), 128K, or the model's full window.
- **`npm run context:report`:** read-only diagnostics per bot. It shows the window, stored and visible user turns, cleared outputs, other lanes and the last run's summed usage, and it prints no content.

## Images in the context

A browser screenshot works the same way: the tool message records a reference to the saved file, and the image is sent as a user message right after the tool results, the one place every provider accepts it. It counts toward the same newest-five limit.


An attached image stays a reference in the model history (path, name, format, size). At the start of each task the engine prepares the newest five images still in the conversation and sends them as image parts with their messages on every step. Each one counts about width × height ÷ 750 tokens (at most about 1,600) toward the working context and its compaction thresholds. Images in older or summarized turns are not sent again; their messages carry a short note instead. See `docs/rich-chat.md`.

## Finding earlier conversation

Compaction rewrites only the model history. The display transcript keeps every message, so a bot with the Memory tools can look things up again:

- **`session_search`** ranks stored messages by the query's words (BM25, with word forms such as "migrate" and "migration" matching). It returns the message id, date, who said it, where (Bot Chat, a named team room or routine) and a short excerpt, with `totalMatches` and `nextOffset`. Optional filters: `role` (`user` or `assistant`), `after` and `before` (ISO dates). An empty query with `after` lists every message since then in transcript order, which the daily review uses to look back over a day.
- **`session_read`** returns one message (6,000 characters per page, `nextOffset` for more) with up to five neighbours on each side from the same conversation.
- **Scope:** the Bot Chat, team rooms and routines search the bot's whole history apart from Telegram chats with other people. Such a Telegram chat searches only itself. Tupies notes and the current task's own messages are left out.
- The system prompt tells the bot to search when a task depends on something it no longer sees and to say where it came from. Results are marked as stored data, never instructions or approval.

Code: `lib/history.mjs`.

## Material study uses a separate bounded working packet

The implemented material-study flow shares Engine task ownership but does not append whole books, transcripts, images, audio requests or private selection/check prompts to ordinary conversation/model history. `lib/study-jobs.mjs` snapshots the explicitly installed learning package/resources, role/focus and model/reasoning/image capability. Each tool-less selection request receives the relevant methodology, one bounded source segment, its Engine-assigned locators and a small existing-knowledge packet, with context/output headroom checked against the selected model. A separate bounded request checks proposed units. Optional vision sends fitted image parts with explicit interpretation provenance; uploaded audio uses the separately selected/consented speech service.

`lib/study-reconcile.mjs` then screens plausible current-unit and same-batch neighbors lexically. Exact claims require no extra semantic inference. Other comparisons use at most six candidate groups and 40000 payload characters per request, three neighbors per existing/same-batch search and 200 requests per study. The model selects only offered pairs and duplicate/enrichment/conflict relations; Engine code constructs revisions, unions complete protected details and retained evidence, and refuses invented targets/text. Compared current hashes/revisions form a read set that is checked again at publication, including verified progress from this study's own earlier batches. Unequal scopes stay independent; same-scope contradictions stay disputed and linked. Overflow or incompatible method order retains separate supplements instead of truncating knowledge. Omitted, oversized or deferred comparisons retain candidates separately; bounded screening is not exhaustive semantic matching.

Full source bytes and extracted segments stay in local `study-staging/`. Bounded job/method snapshots, candidate evidence, processed segment IDs and publication progress live in `study-jobs/`; these do not use generic chat checkpoints or sync. The owner transcript and `study_material` tool result carry compact progress/results. Accepted knowledge and bounded evidence are published through managed Brain revisions, then later tasks retrieve the applicable active knowledge with ordinary search/read/recall. Changing the chat model does not require relearning the materials.

Study recovery revalidates the current task, source identities, inference/method snapshot and publication state. Stop remains durable. Completed source/media read receipts and committed publication are reconciled rather than used as permission for another action; recovery after a lost cleanup acknowledgement can finish from publication receipts without discarded originals or repeated inference. Temporary-only intake differs from ordinary attachments: the latter remain owner workspace files and can sync. Inactive source expiry and explicit Keep originals are described in [Memory](memory.md#learning-from-material-current-source).

This study packet does not implement the broader smaller-context proposal below for every normal chat. Lexical retrieval and reconciliation screening can still miss an unaliased cross-language paraphrase, and model-assisted checking/reconciliation is not independent proof of semantic completeness or expertise. See [material-learning evaluation](evaluation.md#specialist-knowledge-assimilation).

## Proposed: smaller working context with retrievable evidence

The narrower earlier-tool projection and retained-observation reader above are implemented in current source. The broader evidence archive, semantic working-packet selection and UI breakdown below remain proposals and are not deployed. A large input alone does not prove worse answers; real-model quality and latency still need matched-task evaluation.

The next context policy should separate the model's hard capacity from the evidence needed for the current task:

- Extend the current **older-tool budget** with measured, task-relevant source selection. Keep current call/result pairs and unresolved outcomes intact; a concise historical excerpt is never proof of success.
- **Add a separately retained full-result archive before broader pruning.** `session_search`/`session_read` read display messages; `work_records_read` now reads scoped retained canonical tool observations, while `tool_result_read` copies belong to the active task. Canonical observations can still expire through existing compaction/history retention. A permanent archive needs bounded retention, private paths, bot/lane checks and explicit expiry/coverage. Recovering an observation must never require replaying a write or treating an old approval as permission.
- Build a **smaller relevant working packet** from the current goal, exact constraints, recent turns, task-relevant memory and selected evidence. Keep the full display transcript. Search/read original sources when an exact detail is missing, and preserve uncertainty and source identity through summaries. Evaluate target sizes with matched real tasks before choosing a new default; this proposal sets no new numeric threshold.
- Show a **context breakdown** in the UI: conversation, tool results, memory, tool schemas and summary coverage. This would explain why a request is large and whether material was omitted, rather than implying that a larger window guarantees a better answer.

These are input-selection changes, not task-duration limits. They must preserve work-until-done execution, active inference snapshots, Stop, exact action approvals and the prohibition on replaying uncertain effects. Verification should compare input tokens, latency, task completion and exact-requirement retention; token savings alone are insufficient.

Existing owner controls offer **Bot settings → Context limit → 128K** for earlier window cleanup, or **Chat options → Summarize older messages / Start a new topic** while idle. Both summary actions preserve the display transcript; Start a new topic retains a background summary. The narrower source projection applies to newly admitted eligible runs; this broader proposal adds no further automatic change.

Grok Bot's [official memory documentation](https://docs.x.ai/grok-bot/bots), reviewed 30 October 2026, describes persistent facts, preferences and work summaries without replaying every prior message. Its [design account](https://x.ai/news/designing-grok-bot) describes memory belonging to a bot's role and group chats supplying shared project context. These support the product direction above; neither source discloses Grok's exact retrieval algorithm, compaction thresholds or working-context size. The [packaged-client comparison](research/grok-bot-0.77.0-followup.md) retains the same backend-evidence boundary.

## Not yet included

The roadmap plans server-side compaction where providers support it, background memory review and a summary prepared ahead.
