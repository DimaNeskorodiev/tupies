# Working context

How a bot's conversation becomes the context its model sees on each step. The design follows research into Hermes Agent, Codex CLI and Grok Bot (27 October 2026); the staged plan is in the roadmap.

## What the model sees

Each model step sends three parts:

1. **System prompt** (`NativeEngine.instructions`): identity, the bot's instructions, rules, tool guidance, a snapshot of core memory, assigned skills and the team roster. It is built once per task and does not change between steps, so providers can reuse its cached prefix. Memory a bot saves during a task appears in the tool result immediately and in the system prompt from the next task. A skill assigned during the task is announced in the turn context.
2. **The bot's stored conversation**, fitted to the model's window (below).
3. **The turn context** (`NativeEngine.turnContext`): a `<turn_context>` block with today's date, the current run plan, recalled long-term notes, skills assigned during the task and any compaction note. Providers append it as the last user message; it is never stored, so everything before it stays cacheable from step to step and from task to task.

The display transcript (`state.messages`) is separate and never shortened.

## Conversations and lanes

A bot has one **Bot Chat**: the app and its chat, the owner's own Telegram direct messages and requests from teammates all continue it. Its model history keeps the bot's id as its key, as it did before lanes existed, so no data moved.

Other work runs in its own lane with a separate model history (`lib/sessions.mjs`):

| Lane | Key | History |
| --- | --- | --- |
| Telegram from anyone else | `telegram:<channel>:<chat>`, plus `:<user>` in a group | Persistent per chat, and per person in a group |
| Team room | `room:<room>` per member | Persistent; each turn carries only what is new (below) |
| Routine | `routine:<routine>` | Fresh on every run; the last completed output (≤4,000 characters) comes along as `<previous_output>` |

A lane's id is derived from the bot and the key (`<botId>--<kind>-<16 hex>`), so every engine computes the same one, and it starts with the bot's id, so sync can tell whose it is. Each lane has a synced record in `state.sessions` (`{id, botId, kind, key, createdAt, updatedAt}` plus lane data such as `roomSeen`). The display transcript still shows every lane's messages in the Bot Chat. A display message from another lane carries its `sessionId`, and a routine's carries its `routineId`. When a run in another lane completes, the Bot Chat history gets one short record so the bot knows about replies the owner can see:

```
[Elsewhere: routine "Morning digest"]
Asked: …
Answered: …
```

The record holds at most 500 characters of the request and 2,000 of the answer. Telegram lanes are chosen with the channel's **Your own Telegram user ID** (`ownerUserId`), which must also be an allowed user ID. Without it, every Telegram chat gets its own lane. Deleting a bot removes its Bot Chat, every lane and their records.

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
   - **Summary.** If the context is still over the point after step 1, the older turns are summarized (see below), once per task, before anything else gives way.
2. **The current task's oldest tool outputs** are shortened to 4,000 characters and then omitted. A retained copy's `resultId` stays readable with `tool_result_read`.
3. **Whole earlier turns** are dropped, oldest first. This also happens when more than 900 messages would be sent, since providers accept at most 1,000. The current turn always stays.

Tool calls and their results are never separated. A note in the turn context tells the model what was cleared or omitted. The `context.compacted` event reports `omittedTurns`, `clearedResults` and `shortenedResults`. Steps 1–3 only shape the request; the stored model history changes only through a summary.

## Summary compaction

`lib/compaction.mjs` follows Codex and Hermes. It never touches the display transcript; it rewrites only the model history.

1. **What is kept.** The turn in progress stays whole, and so do the most recent whole turns that fit a tail budget: 2.5% of the effective window, 10K–25K tokens, at most a fifth of it. Everything earlier is summarized.
2. **The summary request.** The bot's own model writes a handoff summary with these sections: Goal, User preferences and constraints, Done, In progress, Decisions, Files and artifacts, Open questions and Critical details.
   - Its input is a clipped transcript of up to 160,000 characters, keeping the beginning and most of the recent part. The transcript is wrapped as data.
   - An earlier summary is passed in to be updated, not rewritten.
3. **The new history.** One `<conversation_summary>` message holds the summary and up to 24,000 characters of the user's earlier messages, quoted verbatim. The kept turns follow it.
4. **The record.** The lane record stores `summary`, `compactedAt`, `compactions` and `compactMethod`. A Bot Chat gets a lane record (`kind: 'chat'`) the first time it is summarized. Its display transcript gets a short Tupies note, and the run records a `context.compacted` event with `method` and `summarizedMessages`.
5. **When the summary request fails during a task**, a plain record of the latest requests and answers is used instead (`compactMethod: 'fallback'`), so turns are never dropped silently.

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

## Not yet included

The roadmap plans server-side compaction where providers support it, background memory review and a summary prepared ahead.
