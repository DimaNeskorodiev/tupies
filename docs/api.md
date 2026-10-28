# Tupies HTTP API · 0.5.0

The browser API is same-origin and single-owner. Read `/api/auth` to discover whether setup/login is needed. All other `/api/*` routes require the session cookie; mutations also require `X-CSRF-Token` from the authenticated session. Paired apps may instead send `Authorization: Bearer <token>` from a device session (see [Devices, pairing and sync](#devices-pairing-and-sync)); bearer requests need no CSRF token. JSON request bodies use `Content-Type: application/json`. API errors are `{error:string}` with an appropriate status.

Native push registration is a device-only exception: **GET/PUT/DELETE `/api/device/notifications`** requires the bearer of a currently paired iOS app. A browser/web-view cookie or linked-engine bearer is refused. PUT accepts exactly `{token,environment,enabled,botReplies,routines}`: a hexadecimal APNs token, `sandbox` or `production`, and three booleans. Device identity comes from the bearer; callers cannot supply a device ID, destination or topic. DELETE takes `{}` and removes this app's registration. Responses are `{available,registered,enabled,botReplies,routines,environment?,reason?,delivery:{status,lastError?}}`, with no token or credentials. Missing configuration, a linked replica or an environment mismatch is reported as unavailable; normal bot work continues. See [iPhone notifications](notifications.md).

| Route | Behavior |
| --- | --- |
| GET /api/auth | setupRequired, authenticated, session csrf when signed in, and passwordSignIn (false on an internet address that accepts paired apps only; setup and login are then refused with 403). |
| POST /api/setup | One-time `{token,password}` setup; creates the first session. |
| POST /api/login | Password login; returns authenticated/csrf. |
| POST /api/logout | Invalidates this browser session. |
| GET /api/state | Public bot/provider/integration/skill/room/routine metadata, run summaries, activity, `browser: {available, name?}` (whether this engine has Chrome or Chromium for the read-only browser) and a `sync` summary (this engine, its home server, other engines and bots busy elsewhere); no stored credentials. |
| GET /api/dashboard | Read-only Dashboard summary: `{counts,files,activity,needs,working,routines}`. `files` (≤12) are verified run outputs only, with workspace-relative paths and download URLs. `activity` (≤80) is a humanized timeline from the 500-entry activity log; settings, security, device and provider-configuration events stay in Settings › Activity. `needs` (≤20) lists approvals with their exact action (a shell program path is reduced to its name), pending questions and setup problems that block work. `working` (≤20) lists active runs with their current step, bots busy on another engine and active room drives. `routines` (≤12) lists recent routine results. Task titles are the first line of the user's message (at most 120 characters). Text is redacted before it is shortened; no credentials, transcripts or host paths. Returns an `ETag`; a matching `If-None-Match` answers `304` while the dashboard content is unchanged. Same session/bearer rules as `/api/state`; linked engines cannot use it. |
| GET /api/capabilities | Tupies engine version and implemented feature flags. |
| GET /api/providers | Direct provider catalog and setup metadata. |

## Model providers

A connection uses `{name,type,baseUrl?,apiKey?,defaultModel?,maxOutputTokens?,contextWindow?}`. `contextWindow` (4000–10000000 tokens, or empty for automatic) states the window of a local or compatible service; catalog entries carry the provider's own `contextWindow` when it reports one. Types are openai, chatgpt, anthropic, xai, openrouter, ollama and custom. Provider keys are accepted only as input and sealed into server storage. ChatGPT uses OAuth; its bearer destination is fixed to the public OpenAI API.

| Route | Behavior |
| --- | --- |
| POST /api/connections | Add a direct provider; optionally assigns the first provider to unconfigured bots. |
| PATCH /api/connections/{id} | Edit provider metadata/model; type/destination changes require appropriate fresh credentials. |
| DELETE /api/connections/{id} | Remove an unused provider. Active tasks and assigned bots must be resolved first. |
| POST /api/connections/{id}/test | Fetch model metadata without a paid inference request. |
| GET /api/connections/{id}/models | Current provider model choices. |
| POST /api/connections/{id}/default-model | Validate `{model,applyToAllBots?}` against the current catalog; save workspace/provider defaults atomically. applyToAllBots defaults to true and makes all existing bots inherit; false preserves individual model/provider overrides. Active affected tasks must finish first. |
| POST /api/connections/{id}/login | Start ChatGPT OAuth, return pending authUrl/loginId/message. |
| GET /api/connections/{id}/login | Poll safe pending/connected/error/signed-out status. |
| DELETE /api/connections/{id}/login | Cancel a pending attempt. |
| POST /api/connections/{id}/logout | Sign out and clear local OAuth credentials. |
| GET /auth/callback | Public loopback OAuth callback; state, code, issued-client identity and signed token are validated internally. |

## OpenRouter voice

These presentation routes are separate from agent tools. Only an existing OpenRouter API-key connection at the official OpenRouter base URL is accepted. Speech preferences are browser-local; no endpoint changes a bot's model or conversation. No audio is persisted on the server.

| Route | Behavior |
| --- | --- |
| GET /api/speech/catalog?connectionId={id}&refresh=true | Discover the three supported reading models, exact voices, safe pricing metadata and supported transcription choices. Catalogs cache for five minutes; refresh bypasses cache. Fish uses verified public presets when its catalog omits voices. |
| POST /api/speech/synthesize | `{connectionId,model,voice,text,consent:true}`; up to 2000 text characters. Returns validated MP3/WAV bytes with a matching Content-Type and no-store headers. Gemini PCM is wrapped as mono 24 kHz PCM16 WAV. |
| POST /api/speech/transcribe | `{connectionId,model,audio,language?,consent:true}`; audio is base64 of a canonical mono 16 kHz PCM16 WAV (44-byte header), at most 60 seconds/1,920,044 decoded bytes. language is a two/three-letter hint. Returns `{text}` without recording a conversation message. |

Synthesis/transcription require CSRF, explicit cloud-processing consent, an advertised model and a supported voice where applicable. There are at most two active operations globally, a 60-second upstream deadline, 8 MB output-audio cap, 128 KB transcript-response cap and bounded request bodies. Closing the response cancels upstream work. Provider authentication failures return a speech error rather than invalidating the Tupies session. No fallback or paid retry is automatic.

## Bots, runs and resources

New bots default to `icon: "roki"` and `color: "slate"` when appearance fields are omitted. The browser renders Roki for generated avatar icons, including legacy creature seeds. Existing icon and color values remain valid stored metadata; the saved palette still supplies activity-flow colors. Character variations are not exposed in the current appearance editor.

Bot fields include name, title, description, instructions, color, icon, connectionId, model, skills, tools, collaborators, teamMode, integrationIds, enabled, hidden and approvalPolicy. teamMode is `all` (default: the bot knows and may contact every other bot) or `selected` (only the bots in collaborators); bots saved before this field existed behave as `all`. hidden (default false) only removes the bot from the sidebar and the Bots grid. A PATCH whose only field is hidden is accepted while the bot is working; every other edit still waits for its task and room turn. A message a teammate sent through delegation carries fromBotId. Omitting connectionId when creating a bot uses settings.defaultConnectionId. An empty model inherits its provider default; a nonempty model is an explicit override. GET /api/state exposes safe settings.defaultConnectionId and settings.defaultModel values. Tool groups are workspace, memory, skills, web, integrations, delegation, automation and optional terminal. Policy is balanced or strict. Provider accounts can be shared; workspace, memory and transcript are per bot.

| Route | Behavior |
| --- | --- |
| POST /api/bots | Create a bot. |
| PATCH or DELETE /api/bots/{id} | Edit or remove an idle bot's local records; no third-party account deletion. |
| GET /api/bots/{id}/messages | Persistent display messages and current run. Returns an `ETag`; with a matching `If-None-Match` the answer is `304` and no body. |
| POST /api/bots/{id}/messages | Submit `{text,attachments?:[{path,name?}],clientMessageId?}`; up to five supported files and 20 MB combined. Text may be empty with attachments. HTTP 202 returns `{run}`, the admitted local run. With `clientMessageId` (8–80 letters, digits, `-` or `_`), a repeat with the same content returns HTTP 200 `{run,duplicate:true}` for the original task instead of starting another. The same ID with different content is refused with 409. Receipts are written with the admitted task, kept on this engine for a week and never synced. |
| GET /api/bots/{id}/submissions/{clientMessageId} | Whether this engine received a message: 200 `{received:true,runId,createdAt,run}`, or 404 `{received:false,pending}` (`pending` while a request with that ID is still being admitted). The browser asks this after an uncertain send before sending again. |
| POST /api/bots/{id}/compact | Summarize the Bot Chat's older messages (`{}`) or start a new topic (`{topic:true}`) with the bot's model. Returns `{compacted,method,summarized,kept}` or `{compacted:false,reason}`; 409 while the bot works. See `docs/context.md`. |
| GET /api/bots/{id}/run | Poll current native engine run/status/controls. |
| GET /api/bots/{id}/capabilities | Bot engine feature flags (including `image_input`, and `browser`: this engine has a browser and the bot has the Browser tools), supported document formats and attachment/file limits. `documents.imageVision` says whether the bot's current model is shown attached images, and `documents.imageSource` why: `owner`, `provider`, `provider-error`, `known` or `unknown`. |
| POST /api/bots/{id}/stop | `{runId,remoteRunId}` captured from the displayed task; stale ids return 409. remoteRunId is retained for client compatibility and equals the native local id. |
| POST /api/bots/{id}/approval | `{choice:once-or-deny,runId,remoteRunId,request_id,execution_generation}` matching the displayed exact prompt. No blanket approval. |
| POST /api/bots/{id}/answer | Answer the displayed question: `{runId,remoteRunId,request_id,execution_generation,answers:[{questionId,optionIds?,text?}]}` with one answer per question, or `{runId,remoteRunId,request_id,execution_generation,skip:true}`. A stale, changed or already answered prompt returns 409. An answer is task data; it never approves a tool action. |
| GET /api/bots/{id}/runs | The bot's run history on this engine: up to 50 finished tasks, newest first, as `{id,status,source,lane,task,model,connectionId,createdAt,finishedAt,durationMs,steps,toolCalls,usage,questions?,routineId?,roomId?,delegatedBy?,error?,artifacts?}`. It never syncs. |
| GET /api/bots/{id}/events?after=N | Sequenced retained events, run id/status and partialOutput. |
| GET /api/bots/{id}/memory | Durable memory entries. |
| PUT /api/bots/{id}/memory | Upsert `{key,value,pinned?}` while idle. Omitting `pinned` keeps the current pin; at most 20 pinned facts. |
| DELETE /api/bots/{id}/memory/{entryId} | Remove one fact while idle. |
| GET /api/bots/{id}/proposals | The bot's suggested memory and skill changes: `{proposals,pending}`, pending ones oldest first, then up to 30 reviewed ones newest first. Each has `kind` (`memory` or `skill`), `status` (`pending`, `accepted`, `rejected`, `stale`, `undone`), `reason`, `source {runId,from,sessionId?,messageIds}` and `sources` (cited messages with `from`, `where`, `createdAt` and a 280-character excerpt). Memory suggestions list `changes [{key,before,after}]` (`null` for absent); skill suggestions have `skill {id,name,description,create,before,after}` with full `SKILL.md` content and sha256, plus `usedBy` (other bots with the skill). Pending items carry `current` (the base is unchanged); accepted ones carry `undoable`. |
| POST /api/bots/{id}/proposals/{proposalId}/accept, /reject or /undo | Review one suggestion; returns `{proposal}`. Accept applies a pending suggestion only while its base is unchanged, otherwise it is marked `stale` and 409 is returned. Undo reverses an accepted one only while nothing has changed it since (409 otherwise, status unchanged). Accept and undo wait (409) while the bot, or for a skill any bot using it, is working; reject never waits. |
| GET /api/bots/{id}/brain | Read-only overview of the bot's long-term notes: `{folder,notes,total,indexed,skipped,truncated,linksTruncated,unresolved,tags,limits}`. Each note is `{path,title,folder,tags,type?,updated,size,links,backlinks}` (links are resolved note paths, backlinks a count), newest first. At most 50 links per note and 20000 in total (`linksTruncated`); `tags` lists the top 100 with note counts. Uses the same index as the notes tools, so external Obsidian edits appear on the next request. A missing notes folder gives an empty overview and is never created. Works while the bot is busy. |
| GET /api/bots/{id}/brain/note?path=projects/acme | One note: `{path,workspacePath,resolvedFrom?,title,folder,type?,tags,aliases,created?,updated,size,content,truncated,links:[{target,path\|null}],backlinks,indexed}`. `path` resolves like `brain_read` (exact path, `[[link]]`, note name or alias). `content` is the body without frontmatter, at most 100000 characters; links and backlinks are capped at 200 each. Missing, escaping, hidden or dotted segments, backslashes and symbolic links return 400; an absent note returns 404. All returned text is redacted. Works while the bot is busy. |
| GET /api/bots/{id}/files?path=. | List the bot's relative workspace folder. |
| GET /api/bots/{id}/files/content?path=brief.txt | Read a bounded UTF-8 workspace file. |
| GET /api/bots/{id}/files/download?path=report.pdf | Download a regular workspace file up to 20 MB with the matching MIME type and filename. |
| GET /api/bots/{id}/files/view?path=report.pdf | Serve PDF, PNG/JPEG/WebP or supported text inline. HTML, SVG and unknown types are offered as attachments. |
| GET /api/bots/{id}/documents/preview?path=report.docx | Extract bounded document text and format-specific preview structure, or image-preview metadata. |
| PUT /api/bots/{id}/files | Save `{path,content}` while idle; text whitespace is preserved. |
| POST /api/bots/{id}/attachments | Upload `{files:[{name,contentBase64}]}` while idle; 1–5 files and 20 MB combined. Returns private file metadata; does not start inference or parse documents. |
| GET /api/bots/{id}/processes/{processId}?runId={runId}&offset=0&limit=12000&outputVersion={version} | Read retained redacted output and status for a process owned by this bot's current run. Current run identity and exact process ownership are checked; offset is 0-based and pages are bounded. Offset 0 starts a fresh view and returns outputVersion; carry that version on later nonzero pages. |
| POST /api/bots/{id}/processes/{processId}/stop | `{runId,remoteRunId}`; stop and drain only the current run's owned process. Requires the normal authenticated mutation/CSRF boundary and rejects stale or completed-run controls. |

Runs use queued, running, waiting_for_approval, waiting_for_delegate, stopping and terminal completed/failed/cancelled/interrupted states. A waiting_for_delegate run carries `teammate` `{botId,status,steps,event,tool?,updatedAt}` with the teammate run's live progress; it is cleared when the reply returns. API admission is not completion. Completed status is emitted only after the model/tool loop produces a final result. Context and task limits preserve available progress but do not report success. Restarted pending work is interrupted, not replayed.

Runs can include a structured `plan` with at most 20 steps in pending, in_progress or completed state and at most one in_progress step. Plan updates are task progress, not execution authorization or final completion. A final model answer with unfinished plan steps fails explicitly and preserves the answer and plan. The engine emits a plan-update event and retains the current plan after cancellation/failure. Tool events retain exact call identities; failures are returned as error results so the model can recover.

## Workspace and harness tools

These are model-call tools exposed by Tupies Engine, not unrestricted HTTP execution endpoints. Workspace tools require the bot's `workspace` group. Plans and retained-output reads are harness tools available to the active run; they cannot enable disabled groups or access another bot/run.

| Tool | Behavior |
| --- | --- |
| workspace_list | List one safe relative folder in the bot's private workspace. |
| workspace_glob | `{pattern,path?,includeHidden?,offset?,limit?}`; `*`, `?` and whole-component `**` matching. Pattern is workspace-relative even with a path filter. Default limit 50, maximum 100; results report truncation/scan limits. |
| workspace_search | `{query,path?,glob?,caseSensitive?,includeHidden?,contextLines?,offset?,limit?}`; literal single-line query of 1–500 characters. Case-sensitive by default; context is 0–2 lines and default limit 20, maximum 50. Binary, changed and oversized files are skipped explicitly. |
| workspace_read | `{path,offset?,column?,limit?}`; offset/column are 1-based. Default 200 lines, maximum 1000, at most 12000 returned characters and a 1 MB UTF-8 file. Returns full-file `sha256`; continue using `nextOffset` and `nextColumn`, including a page ending within one long line. |
| workspace_write | Create or replace a complete UTF-8 file; Strict requires approval of its exact path and contents. |
| workspace_edit | `{path,oldText,newText,expectedSha256,replaceAll?}`; exact replacement in a UTF-8 file up to 1 MB. Nonempty oldText must match once unless replaceAll is true. Stale hashes and absent/ambiguous matches are rejected before atomic replacement. Balanced permits the private edit; Strict requires exact argument approval. |
| workspace_delete | Delete one private file after exact approval. |
| shell_run | Terminal group only. `{executable,args,cwd?,timeoutMs?}`; cwd is a safe private workspace folder (default .). Timeout defaults to 30000 ms and accepts 100–120000 ms. Exact approval covers all supplied arguments; output reports exitCode, timedOut and truncated. Trusted host execution, not an OS sandbox. |
| shell_start | Terminal group only. `{executable,args,cwd?,timeoutMs?}`; exact approval launches a task-owned command and returns a processId without waiting for completion. Timeout defaults to 300000 ms and accepts 100–1800000 ms, subject to the owning task's runtime. |
| shell_read | Terminal group only. `{processId,offset?,limit?,waitMs?,outputVersion?}`; read merged stdout/stderr and actual status. Offset starts at 0, limit is 1–12000 characters and waitMs is 0–10000 ms. Use nextOffset plus returned outputVersion for further retained output. If redaction changes an already visible prefix, stale nonzero pages return 409; restart at offset 0. |
| shell_list | Terminal group only. `{}`; list this run's process handles, bounded metadata and actual statuses. |
| shell_stop | Terminal group only. `{processId}`; stop and drain this run's owned command. No executable/PID input or new command launch is accepted. |
| lsp_start | Workspace and Terminal must both be enabled. `{server,rootPath?,executable?,args?}` with server `typescript` for the bundled JS/TS server or `custom` for an exact approved installed stdio executable. rootPath is a private workspace folder, default .; a successful launch returns a sessionId. No package is installed by a model call. |
| lsp_query | Workspace group only. `{sessionId,operation,path?,line?,character?,query?,itemId?,includeDeclaration?}`. Operations are definition, type_definition, implementation, references, hover, document_symbols, workspace_symbols, prepare_call_hierarchy, incoming_calls, outgoing_calls and diagnostics. Document/position operations require path; workspace_symbols uses query. Source positions are 1-based UTF-16; references defaults includeDeclaration to true. Current open file contents are synchronized before querying. Results are bounded, private project locations are normalized, outside locations are omitted and diagnostic freshness/capability limits are reported. |
| lsp_list | Workspace group only. `{}`; list this run's owned language-server sessions and their advertised supported queries. |
| lsp_stop | Workspace group only. `{sessionId}`; stop and drain only this run's owned language-server session. |
| task_plan_set | `{steps,explanation?,expectedVersion?}`; atomically replace the complete plan. Each of 1–20 steps is `{id,title,status}` with a unique safe ID, title up to 240 characters and pending/in_progress/completed status. At most one step can be in_progress. Optional expectedVersion rejects stale updates. |
| task_plan_get | `{}`; return `{plan}` with the current durable run plan or null. |
| tool_result_read | `{resultId,offset?,limit?}`; use the exact resultId from a shortened tool result, with 0-based offset and a limit of 1–12000 characters. Returns content, nextOffset, totalChars, retainedChars and truncated; escaped content may shorten a page further to fit its result envelope. |
| memory_propose | Memory group. `{changes:[{key,value?,pinned?,remove?}],reason,sourceMessageIds?}`; 1–10 changes. Queues a suggestion for the owner's review without changing memory and without approval. Refuses removing a missing fact, a change that matches the current fact, limits it could never meet, uncitable message IDs, a suggestion the owner declined in the last 30 days and more than 20 waiting. Returns `{proposalId,status:'pending'}` (or the identical waiting one with `duplicate:true`). |
| skills_propose | Skills group. Improve an assigned skill with `{skillId,expectedSha256,edits:[{oldText,newText}]|content,reason,sourceMessageIds?}` (sha256 from `skills_read`; each oldText must match once; the frontmatter name cannot change), or suggest a new one with `{name,description,instructions,reason,sourceMessageIds?}`. Nothing is written until the owner accepts. At most 5 skill suggestions wait per bot. |

Up to four adjacent tools from the engine's explicit read allowlist can execute concurrently. Mutations, approvals, integration calls and delegation remain ordered barriers; provider batching never grants parallel side effects. Results return in original model call order. Every started call is drained on Stop before the engine settles history, and the normal per-task limits apply to each call. See [Tool use](tool-use.md) for exact tool arguments, limits and examples.

Results longer than 16000 characters are redacted and retained in active-run memory, up to 250000 characters per result and 1000000 per run. Oldest results are evicted first and all retained results expire when the run ends. Public run polling does not expose these full outputs and no extra persistent copy is created. `nextOffset:null` exhausts retained content only; `truncated:true` means original output remains outside that retained range.

Discovery/search skips symlinks, special files, `.git`, `node_modules` and `.tmp`; hidden entries are excluded unless requested. Traversal stops at 4000 entries or depth 20. Search reads at most 1 MB per file and 8 MB overall, with explicit skipped-file/scan truncation indicators. Search/glob output is additionally capped near 10000 characters, so a result cap never establishes that the entire workspace was searched.

### Managed command and language-server lifecycle

`run.backgroundProcesses` contains bounded redacted metadata: processId/id, status, executable, argsPreview, cwd, outputPreview and exit details. It never offers arbitrary PID control. Process statuses distinguish running, completed, failed, stopped, timed_out, output_limit and interrupted; only completed with exitCode 0 demonstrates command success. Four commands per run and eight globally can run at once; at most 20 process histories are retained per run. Output is bounded to 250000 bytes per process, with explicit limit/truncation status. Full retained output is requested through the owned handle rather than sent in each run poll.

`run.languageServers` records bounded session identity, server, rootPath, capabilities and starting/ready/stopping/stopped/failed/interrupted state. TypeScript/JavaScript support uses pinned runtime dependencies `typescript-language-server` 5.3.0 and TypeScript 6.0.3; custom servers must already be installed. LSP is a separate stdio protocol client, not an unrestricted stdio MCP transport. It rejects server-initiated file edits and arbitrary command execution. Server text, diagnostics and project content remain untrusted evidence and cannot grant permission.

Call hierarchy preparation returns normalized items with opaque itemId values. Use an itemId from the same live session for incoming_calls or outgoing_calls; the server item payload is retained internally rather than accepted from model-supplied JSON. A changed source revision invalidates the handle and requires preparation again. Advertised capability checks gate every operation. Diagnostics distinguish pull reports from bounded push-notification waits; missing or unversioned reports do not prove the current file has no errors.

Background command memory retains up to the per-process output cap while its run is live. Persisted process records retain a bounded 12000-character prefix for inspection after run cleanup/restart; persistedPreview/outputPreviewTruncated and truncated flags distinguish this saved prefix from complete command output. Chat previews are smaller still. Exhausting a saved prefix is not proof that all original output was read.

Retained output is redacted against both launch-time and newly rotated credentials before paging. Each read reports outputVersion; it changes when redaction revises an existing visible prefix rather than appending text. A stale nonzero read must restart at offset 0 with the new version, so callers cannot silently concatenate different projections. The browser clears stale pages on a revision conflict and asks for Refresh. Fresh offset-zero reads do not carry an old version.

Both managers enforce bot/run ownership. Stop, task failure, runtime limits, successful completion and server shutdown terminate and drain owned processes. A final model response while background commands are still running produces an incomplete/failed run and cleans them up; language servers shut down normally after their last task query. Restart marks unfinished metadata interrupted without replaying a process or signaling a recorded PID. Preserved process output/metadata is progress evidence, not proof that interrupted work succeeded. Commands and language servers use host-account permissions and do not constitute an OS sandbox.

## Documents, attachments and rich replies

Read/create formats are PDF, DOCX, PPTX, XLSX, Markdown (`.md`), UTF-8 text, CSV and JSON. PNG, JPEG and WebP can be attached and previewed by the user, and are shown to the bot's model when it can see images (see `docs/rich-chat.md`). Scanned PDFs without extractable text need an external OCR step. Legacy or macro-enabled Office formats and embedded executable objects are unsupported.

Upload files first, then include their returned paths in the message's `attachments` array when the user sends. The server derives names, MIME types, formats and sizes from the actual bot files. It rejects duplicate files, unsupported chat attachment extensions, unsafe/cross-bot paths, symlinks, more than five attachments and totals over 20,000,000 bytes before recording a user message or calling the provider. Client names cannot substitute a different file. Generic workspace uploads can contain other byte formats, but those are not admitted as document attachments or previews.

Display messages keep the user's text and `attachments` metadata. The separate provider context lists private relative paths and instructs the bot to use `documents_read`; attachment bytes are not inserted into provider context on upload. Model tool reads can subsequently send extracted text to the selected provider as part of the task.

The `workspace` tool group includes:

| Tool | Arguments and result |
| --- | --- |
| documents_read | `{path,maxChars?}`; `maxChars` is 100–100000, default 60000. Returns `{path,name,format,mime,size,title,text,preview,warnings,truncated}`. |
| documents_create | `{path,document}`; document accepts `title`, `subtitle`, Markdown `content`, structured `blocks`, `slides` or `sheets`. Returns `{path,size,written:true,artifact}` after the file is committed. |

`blocks` supports heading, paragraph, table, list, chart and page_break. Exported chart blocks use `{type:"chart",chart:{type:"bar"|"line"|"pie",title,labels,series:[{name,values}]}}`. `slides` accepts `{title,content?,blocks?}`; `sheets` accepts `{name,rows}` with arrays of cell values or explicit `{formula:"SUM(B2:B3)"}` cells. Model tool arguments are bounded to 150 KB; input/output files to 20 MB. See [Rich chat and documents](rich-chat.md) for complete valid examples and preview limits.

A committed `artifact` is `{path,name,format,mime,size,downloadUrl,previewUrl}`. The engine validates the actual file and constructs authenticated local URLs. Produced files appear in `run.artifacts` and the final assistant message's `attachments`; models need not paste links. Files created before cancellation/failure are retained on an explicitly partial assistant message. Files removed later in the same turn are excluded from the final downloads. Balanced policy permits private exports automatically; Strict requires exact path/specification approval, including replacements.

Document previews return format-specific data: text content; sanitized document HTML; PDF page text; slides with titles/text/tables; or sheets with bounded rows, counts and formula metadata. Image preview metadata contains an authenticated `files/view` URL. Warnings and `truncated` identify extraction limits. Office previews are content previews, not full editors or exact layout reproductions. Spreadsheet formulas are displayed with available cached values; recalculation may be required in Excel.

Chat rendering supports Markdown, highlighted code, math, Mermaid, and bounded `chart`/`infographic` JSON fences. Inline chart types are bar, line, area, pie, doughnut and scatter. These presentation blocks do not execute arbitrary HTML/JavaScript or fetch remote images. They do not create a server-side document artifact by themselves.

## Integrations

An integration uses `{name,type:mcp-or-rest,baseUrl,authType:bearer-or-header-or-none,headerName?,apiKey?,tools?}`. REST actions are `{name,description,method,path,inputSchema}` with fixed safe paths. MCP tools are discovered from the configured Streamable HTTP endpoint.

| Route | Behavior |
| --- | --- |
| GET /api/integrations/catalog | MCP/custom API and GitHub/Slack template metadata. |
| POST /api/integrations | Save an integration with sealed credential. |
| PATCH or DELETE /api/integrations/{id} | Change/remove an integration while its assigned bots are idle. |
| POST /api/integrations/{id}/test | MCP initialization/tool discovery, or REST declaration validation without action execution. |

Model tool integration_call requires a bot assignment, declared/discovered tool name and exact approval. REST arguments map to scalar GET query parameters or JSON request bodies. MCP maintains negotiated session/version headers. Unknown tools, unmatched protocol responses and unsafe destinations are refused. Mutating calls are not automatically retried.

## Messaging channels

A channel uses `{name,type:telegram,botId,token,enabled:false,allowedChatIds:[numeric-string],allowedUserIds:[numeric-string],ownerUserId?:numeric-string}`. `ownerUserId` must be one of the allowed user ids. That person's direct messages continue the bot's Bot Chat; every other chat, and each person in a group, has its own conversation (see `docs/context.md`). Token is input-only and sealed into secret storage. Enabling requires both allowlists. No endpoint accepts a custom Telegram service URL or arbitrary outgoing recipient.

| Route | Behavior |
| --- | --- |
| GET /api/channels | Public channel metadata and platform catalog. |
| POST /api/channels | Add a Telegram bot channel, disabled unless explicitly enabled. |
| PATCH /api/channels/{id} | Edit the channel after cancelling/draining its old poll; cursor and pending task state are reconciled. |
| DELETE /api/channels/{id} | Cancel its poll and remove local channel state/credential. |
| POST /api/channels/{id}/test | Telegram getMe token verification, returning safe bot identity. |

Polling runs only for enabled, explicitly allowlisted channels. The engine receives allowed ordinary text and returns its actual result to that chat. Exact tool approvals remain in Tupies; incoming messages cannot approve them. Durable cursor/reply claims prevent automatic duplicate execution/delivery after uncertainty.

## Skills, rooms and routines

| Route | Behavior |
| --- | --- |
| POST /api/skills | Import `{content}` or `{files:[{path,contentBase64}]}`. |
| GET /api/skills/{id} | Root instruction document and resource metadata. |
| GET /api/skills/{id}/export | Complete `{files:[{path,contentBase64}]}` portable package. |
| DELETE /api/skills/{id} | Remove an unused local skill and unassign it. |
| POST /api/rooms | Create `{name,botIds,autoCollaborate?,maxRounds?}` with selected members. |
| PATCH or DELETE /api/rooms/{id} | Edit/remove an idle room. |
| GET /api/rooms/{id}/messages | Persistent shared messages and drive. Supports `ETag`/`If-None-Match` like bot messages. |
| POST /api/rooms/{id}/messages | Submit `{text}`; exact @mentions scope the selected members. |
| POST /api/rooms/{id}/stop | `{driveId}` matching the displayed round; cancels queued and active room work. |
| POST /api/routines | Create `{name,botId,prompt,schedule,timezone?,missed?,enabled}`. `schedule` is `{kind:'interval',minutes}`, `{kind:'daily',time:'08:30'}`, `{kind:'weekly',time,days:['mon',…]}` or `{kind:'once',at:'2026-11-02T09:00'}` (local time). `timezone` is an IANA name (default: the owner's, else the server's). `missed` is `once` (run once when Tupies is back, the default) or `skip`. `intervalMinutes` alone still means an interval. A `timezone` sent here becomes the owner's default (`settings.timezone`). |
| PATCH or DELETE /api/routines/{id} | Edit/remove a routine; changing its schedule or time zone starts its dates afresh. A one-time routine must be in the future. |
| POST /api/routines/{id}/run | Intentionally dispatch now, including a paused routine. An interval restarts from now; a clock schedule keeps its next time. |
| GET /api/routines/{id}/runs | Recent runs, newest first: `{data:[{runId,startedAt,status,durationMs?,usage?,error?,preview?}],missedRuns,lastMissedAt?}`. Built from synced messages, so it works on every engine; duration, usage and errors come from the engine that ran the task. |

Resource packages require root UTF-8 SKILL.md, safe relative paths, canonical padded base64, at most 100 files/5 MB and bounded frontmatter. Document upload JSON bodies are capped at 28 MB to accommodate base64; skill packages have a separate bounded cap, and ordinary API bodies are smaller. The engine can progressively read assigned resources and execute a selected script only after exact approval. API imports do not execute resources.


## Chat inference controls

Each model in the `GET /api/bots/:id/inference` catalog carries `imageInput: {supported, source}`. A connection's optional `imageInput` (`on` or `off`; `auto` on save removes it) sets image input for all its models. `GET /api/bots/:id/inference` returns the current model override, effective model, reasoning selection, a fresh provider model catalog with safe reasoning capabilities and context windows, `context`: `{window,source,effective,usable,compactAt,small}` for the effective model, and `conversation`: `{tokens,compactedAt?,compactions?}` for the Bot Chat (see `docs/context.md`). A bot's `contextLimit` (`''`, `'128k'` or `'max'`) is set through `PATCH /api/bots/{id}`. `PATCH` accepts `{model: "catalog-model-id" | "", reasoningEffort: "supported-effort" | ""}`. Empty values restore provider/workspace defaults. Validation uses the live catalog and rejects unsupported choices. Changes affect the next run; active run continuations retain their snapshot. Both endpoints require the normal workspace session; PATCH requires CSRF/Origin validation. No inference is submitted by loading or saving this menu.

## Devices, pairing and sync

See [Engines, devices and sync](sync.md) for the model. Pairing links have the form `hermes-studio://pair?v=1&url=<engine origin>&code=<code>&fp=<engine fingerprint>&name=<engine name>&kind=device|engine`. Keys are P-256 (SPKI DER, base64); signatures are ECDSA-SHA256 (DER, base64). The signed strings are `hermes-studio/pair/v1\n<code>\n<publicKey>`, `hermes-studio/paired/v1\n<deviceId>\n<publicKey>` and `hermes-studio/session/v1\n<deviceId>\n<timestamp ms>\n<nonce>`.

| Route | Auth | Behavior |
| --- | --- | --- |
| GET /api/engine | none | `{product,version,name,nodeId,fingerprint,publicKey,role}`, plus `tls:"identity"` when the engine serves HTTPS with its identity key (`STUDIO_TLS=engine`). Apps check `fingerprint` against the link before pairing. |
| POST /api/pair | none, rate limited | `{v:1,code,kind,name,platform,publicKey,proof}` (+`nodeId` for engines). Returns `{deviceId,engine,engineProof}`; engine pairings also receive the wrapped workspace key. Codes are single use. |
| POST /api/device/session | none, rate limited | `{deviceId,timestamp,nonce,signature}` → `{token,expiresAt}` (one hour). Replayed nonces and clocks more than five minutes off are refused. Failures are limited per client address (30 per ten minutes) and sign-ins per device (30 per minute). |
| POST /api/device/web-ticket | app bearer | `{ticket,path}`; opening `path` within 30 seconds sets a browser session cookie for an embedded web view and redirects to `/`. Single use. |
| GET /api/devices | session | Paired apps and engines (no public keys), with `current` for the calling device. |
| PATCH /api/devices/{id} | session | Rename `{name}`. |
| DELETE /api/devices/{id} | session | Revoke; ends its sessions and replicates to linked engines. |
| POST /api/pairing | session | Create a link `{kind?:"device"|"engine",url?}` → `{link,code,expiresAt,fingerprint,qrSvg}`. `url` overrides the address in the link (HTTPS, loopback or Tailscale). |
| GET /api/sync/status | session | This engine, its home server, linked engines, pending changes, tracked documents, skipped large files and `access` `{publicPassword,trustProxy,public}` (`public` describes the calling request). |
| PATCH /api/access | session | `{publicPassword:boolean}` allows or refuses the workspace password from the internet on this engine. Engine-local; not synced. |
| PATCH /api/sync/engine | session | Rename this engine `{name}`. |
| POST /api/sync/connect | session | Link to a home server with an engine link `{link}`. |
| POST /api/sync/disconnect | session | Stop syncing; local data stays and a fresh workspace key is generated. |
| POST /api/sync/exchange | engine bearer | Sealed `application/octet-stream`. Push `{node,push:[changes]}` or pull `{node,since,wait}`; replies are sealed too. |
| GET or PUT /api/sync/blobs/{sha256} | engine bearer | Sealed file contents by SHA-256. |
| POST /api/sync/oauth-refresh | engine bearer | Sealed `{connectionId}`; the home server renews ChatGPT access and returns the provider document. |

A change is `{k,v,h,o,b?}`: document key, value (`null` deletes), stamp, authoring engine and the stamp it replaced. Engine sessions can call only the sync routes; app sessions cannot call them. `GET /api/bots/{id}/messages` also returns `elsewhere: {nodeId,name}` while another engine is working with that bot.
