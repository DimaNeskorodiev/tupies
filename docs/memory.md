# Memory and notes

Every bot has two levels of memory by default. Both belong to the `memory` tool group and stay private to the bot.

| Level | What it holds | Where it lives | How the bot uses it |
| --- | --- | --- | --- |
| Core memory | Short durable facts and preferences, up to 200 per bot | `state.json` | Pinned facts, then task-relevant facts with recency breaking ties (40 facts and about 10000 characters in total) are included in every task. `memory_search`, `memory_set` and `memory_delete`, plus the editable Memory view. |
| Long-term notes | Detailed knowledge: people, projects, topics, decisions, daily logs | `workspaces/<botId>/brain/` as Markdown files | The most relevant notes are recalled automatically at the start of each task. More can be found and edited with `brain_search`, `brain_read`, `brain_write`, `brain_append` and `brain_links`. |

Keep core memory short. A fact that needs more than a sentence or two belongs in a note, and a core fact can point to it, for example `client-acme: Main contact Ada, details in [[projects/acme]]`.

## How the levels work together

- **Pinned facts.** Pin a fact that nearly every task needs, in the Memory dialog (pin button or *Pin this fact*) or with `memory_set` and `pinned: true`. Pinned facts always come first in the prompt. Updating a fact keeps its pin unless `pinned` is given; up to 20 facts can be pinned.
- **Links from facts to notes.** `[[note]]` links in core facts are followed by `brain_read`, which accepts a path, a note name or an alias, the way Obsidian resolves links. A note linked from an included core fact gets a ranking boost during recall and is marked `linked_from_core_memory`.
- **Automatic recall.** When a task starts, Tupies picks distinctive words, dropping common English, Ukrainian and Russian function words and words found in most notes. Small explicit lexical groups expand terms such as budget/cost and font/typeface; this is local keyword ranking, not embeddings. It keeps up to four notes that match at least two task words, are named in the task, or are linked from core memory and still match. For a short follow-up such as "yes, go ahead", the previous message in the same lane also counts. Each recalled note contributes its most relevant paragraphs, about 4000 characters in total, inside a `<recalled_note>` block treated as task data. Version hashes and partial-coverage fields accompany the retrieved evidence.
- **Guidance.** Bots with the Memory group are told how to use both levels: keep facts short and pinned only when needed, search before creating a note, extend with `brain_append`, link related notes, and log notable events in today's daily note. The prompt includes today's date for this.
- Recall can refresh after a changed plan or compaction, at most three times including the initial recall. Relevant core facts, notes and lane-scoped transcript excerpts are ranked and deduplicated within a separate bounded evidence budget. Refreshed evidence lives in the dynamic turn context, preserving the cached system prefix. If the notes folder cannot be read, the task continues and the work log shows *Notes unavailable*. Bots without the Memory group get no recall or notes guidance; their core facts are still included as before.
- **Coverage.** Long fact values are marked `[… truncated]` in the prompt; stored values remain complete. Diagnostics report selected/omitted facts, omitted pins and truncated values. Pins get priority but cannot exceed the overall budget. `memory_search` reports total matches and whether its 30-entry result is capped. Equal nontrivial values are possible duplicate groups for source review; the engine does not automatically merge or delete them.
- **Provenance and corrections.** New or edited facts carry a bounded origin (`owner-edit`, `owner-chat`, `reviewed` or `unknown`), available source message IDs and observation time. A correction records the superseded revision; only the current value participates in recall. Legacy facts keep unknown provenance until edited. Metadata is data, never proof of permission. Existing memory sync documents carry the additive fields without transferring live runs.

## Notes folder

The notes folder is an ordinary folder of Markdown files in the bot's private workspace. It is compatible with Obsidian: open `data/workspaces/<botId>/brain` as a vault to browse, edit or graph the bot's notes. Tupies reads your edits on the next tool call without a restart.

- **Paths** are relative to the notes folder, for example `projects/acme` or `daily/2026-10-26`. `.md` is implied. Up to eight levels of letters, numbers, spaces and simple punctuation; hidden and dotted segments are refused.
- **Frontmatter**: Tupies maintains `created` and `updated`, and writes `type`, `tags` and `aliases` when the bot supplies them. Other properties, including ones you add in Obsidian, are preserved.
- **Links** use `[[note]]`, `[[folder/note]]`, `[[note|label]]` and `[[note#heading]]`. They resolve like Obsidian: exact path, then the nearest note with that name, then an alias. Image embeds and links inside code are ignored.
- **Tags** come from frontmatter and inline `#tag` or `#nested/tag` text outside code. Purely numeric tags are ignored.
- Hidden folders such as `.obsidian` and `.trash`, non-Markdown files and symbolic links are never indexed or followed.

## Tools

| Tool | Behaviour |
| --- | --- |
| `brain_search` | Ranks notes for a query (BM25 over titles, aliases, tags, headings and text). Inflected forms match through a shared word stem, for example *projects/project* or *проєкту/проєкт*. Well-linked notes get a small boost. Filters by tag (including nested tags) and folder. An empty query lists recently updated notes. Returns snippets, link counts and backlink counts. |
| `brain_read` | Paged note content with its full-note sha256, tags, aliases, type, resolved outgoing links and backlinks. |
| `brain_write` | Creates a note, or replaces it entirely when given the current `expectedSha256` from `brain_read`. A note that changed after it was read is never overwritten. |
| `brain_append` | Adds Markdown at the end of a note or at the end of a named section. Creates the note or section when missing. List items join the existing list. Appends to one note run one at a time. |
| `brain_links` | With a path: linked notes up to depth 2 and unresolved links. Without one: tag counts, most-linked notes, orphan notes and unresolved links, for maintenance. |

Search, read and link exploration are read-only and can run in parallel with other read tools.

## Permissions and limits

- Under Balanced policy, note writes and appends inside the notes folder are automatic, like other private workspace writes. Strict policy requires approval of each exact write or append. Deleting a note uses `workspace_delete` and always requires approval.
- Notes are task data, never instructions. They cannot change permissions or authorize actions.
- Known provider and integration secrets are redacted before notes or core facts are written through tools and owner APIs. Do not ask a bot to store secrets: notes, like core memory and chats, are plaintext local data.
- 2000 notes per bot; 500 KB per note; 32 MB of notes indexed; 100000 characters per write and 20000 per append. Oversized or excess notes are reported as skipped or truncated rather than silently missing.
- The index lives in server memory and is refreshed from file size, modification time and identity on each call. No external database or embedding service is used.

## Seeing a bot's memory

Open a bot from **Bots** (or its name at the top of a chat) to reach its profile at `#/bots/<id>`:

- **Brain** shows the long-term notes: a map of the 60 most connected notes coloured by folder, search, folder and tag filters, a list sorted by recent, most linked or name, and a reader. The reader renders the note through the same sanitized renderer as chat; `[[links]]`, `#tags` and backlinks open the next note, and missing link targets are marked. *Edit text* saves the raw file through the workspace editor, like an edit in Obsidian, so Tupies does not change the `updated` property; the save waits while the bot is working.
- **Memory** lists core facts, pinned first, with search and inline add, edit, pin and delete. A `[[note]]` link in a fact opens that note in Brain. Changes wait while the bot is working, as in the Memory dialog.
- **Overview** counts facts, notes and files, and **Files** browses the whole private workspace.

The profile reads notes through `GET /api/bots/{id}/brain` and `GET /api/bots/{id}/brain/note`, which are read-only and keep working while the bot is busy.

## Suggested changes (reviewed learning)

A bot can suggest changes to its own core memory and skills instead of making them. You review each suggestion in its profile's **Learning** tab, and nothing changes until you accept it.

- **When bots suggest.** `memory_set` works directly in your ordinary bot chat (including authenticated owner Telegram DMs routed to that same lane) under its permission policy. The engine refuses direct core-memory writes/deletes from routines, team rooms, teammate tasks and other people's chats; those lanes must use `memory_propose`. Within your chat, suggesting inferred preferences and directly remembering explicit requests remains model guidance: the engine cannot infer that distinction from a model-supplied claim. `skills_propose` suggests a new skill or an improvement to an assigned skill (exact `oldText`/`newText` edits or a complete new `SKILL.md`). It needs the sha256 that `skills_read` returns. Suggestions need no approval, even under Strict policy, because they change nothing.
- **What you see.** Each suggestion shows the bot's reason, the change itself and the messages it is based on. A memory suggestion lists each fact as new, updated (now → becomes) or removed, including pin changes. A skill suggestion shows a line diff of `SKILL.md`, and it says which other bots use the skill, since accepting changes it for them too. The current request is always recorded as a source; cited message IDs must be ones the task could read with `session_read`, so other people's Telegram chats cannot be cited from your lanes.
- **Base revisions.** A suggestion records the facts or the `SKILL.md` sha256 it was made against. New fact proposals also compare provenance revisions, so a same-value owner edit can invalidate an older proposal. Accepting applies it only while those are unchanged. If anything changed in between, the suggestion is marked **Out of date** and nothing is written. A memory suggestion applies as a whole, within the 200-fact and 20-pin limits. Older proposals retain their original value/pin checks.
- **Undo.** Every accepted suggestion keeps what was there before. **Undo** puts it back only while nothing newer has changed the same facts or skill. New proposals restore the exact original fact identity and provenance and still check current fact/pin capacity atomically. Undoing a new skill removes it again from every bot. The newest 30 reviewed suggestions per bot are kept; older ones lose their undo record.
- **Waiting and limits.** Accepting or undoing waits while the bot works (for a skill, while any bot that uses it works); declining never waits. A bot can have 20 suggestions waiting (5 for skills). An identical suggestion is not added twice, and one you declined is refused if the bot makes it again within 30 days. Resources and scripts in a skill cannot be changed this way.
- **Daily review.** The Learning tab offers **Set up a daily review**: a prepared routine (every day at 21:00, editable before saving) that lists the last day's messages with `session_search` (an empty query with `after` lists messages in order) and suggests updates. Like every routine, it runs on the home server.
- **Where it shows.** The Dashboard's **Needs you** lists bots with suggestions to review, and the activity log records each suggestion and decision. Suggestions sync between engines as their own documents (`proposal:<id>`); deleting a bot removes its suggestions.

## Not yet included

A "Second brain" bot template and model-written note consolidation remain future work. Editing a suggestion before accepting it is not supported; decline it and edit memory yourself. Recall is keyword-based (no embeddings), so a note phrased with entirely different words than the task may not be recalled; the bot can still search for it. See `roadmap.md`.

## Optional task observations

**Bot settings → Advanced settings → Save brief task notes** is off by default. With Memory tools and Balanced review, the engine adds bounded observations before task compaction and when your ordinary chat task finishes. A record includes actual task status, request excerpt, source message IDs and engine-recorded output paths. It distinguishes execution status from proof that every requested outcome is correct. There are no extra model requests and no inferred preferences are committed.

The daily Markdown note deduplicates the same run/phase, caps records at 20 and total note content at about 40000 characters, and does not overwrite concurrent external edits. Other people's chats, rooms, routines and teammate work never enter this automatic note path. Strict review skips automatic note writes because each exact workspace change requires approval. Known secrets are redacted. The existing daily-review routine can read these observations and propose durable fact/skill changes through normal owner review.
