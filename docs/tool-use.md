# Tupies Engine tool use

Tupies owns its model/tool loop. A bot can discover files, search text, read selected lines, edit exact text, run foreground or managed background commands, query real language servers and update a visible task plan. Tool results feed the next model turn. No Claude Code, Hermes Agent or host Codex installation is needed at runtime.

## Working through a task

For substantial work, the model records a plan with `task_plan_set`. The current plan is persisted with the run, displayed above the work log and included in subsequent model context. Stable step IDs and an optional `expectedVersion` prevent stale plan updates. Only one step can be in progress. Plans describe progress; they do not grant permissions or prove that actions succeeded. If the model ends its answer with unfinished plan steps, the run fails with an explicit incomplete-work notice and preserves the answer and plan. Stop and restart also preserve unfinished steps.

With Workspace enabled, a typical coding workflow is:

1. Call `workspace_glob` with a pattern such as `src/**/*.mjs`, and `workspace_search` with a literal phrase.
2. Read the relevant file with `workspace_read`. Lines and columns start at 1; `nextOffset` and `nextColumn` resume a partial page. The result includes the SHA-256 of the complete file.
3. Call `workspace_edit` with `path`, exact `oldText` and `newText`, and the read result's `sha256` as `expectedSha256`. Ambiguous matches require more context or explicit `replaceAll`. Changed files must be read again. Edits are serialized per file and atomically replaced after another revision check.
4. Read the edited section and, if Terminal is enabled, request `shell_run` for a real verification command. `cwd` selects a private workspace subfolder. `timeoutMs` defaults to 30000 and accepts 100–120000 milliseconds. Every terminal command needs exact approval, including its arguments, folder and timeout. Check `exitCode`, `timedOut` and `truncated` before reporting success.
5. Update the plan to reflect actual verified work, then report the result and any remaining limits.

Balanced policy permits private workspace writes and exact edits automatically. Strict policy requires approval of their exact arguments. Deletes, scripts, commands, integration actions and schedule changes retain their existing approval requirements. A bot's tool groups, collaborator assignments and active capability snapshots still apply. Reads and edits cannot select another bot's workspace, escape via relative paths or follow symlinks. Approved commands run with the host account's permissions; they are not an OS sandbox.

## Managed background commands

With Terminal enabled, `shell_start` requests exact approval of `{executable,args,cwd?,timeoutMs?}` and returns an opaque process ID after the command starts. The engine can continue file work or start another approved command while it runs. `shell_list` lists this task's commands. `shell_read` accepts `{processId,offset?,limit?,waitMs?,outputVersion?}` for merged, redacted stdout/stderr and real status; offsets count UTF-16 characters and a read can wait up to 10000 ms for new output or exit. Carry the returned `outputVersion` (including version 0) on later nonzero pages. If new credential redaction changes an already visible prefix, a stale cursor returns 409 and must restart at offset 0; the browser clears mismatched pages and offers Refresh. Only `status:completed` with `exitCode:0` demonstrates command success. New output may arrive before exit, so read again at the retained length to wait for completion. `shell_stop` stops only an owned handle and waits for cleanup; it cannot select an arbitrary PID.

The chat shows command status, folder, bounded arguments/output previews and exit details. View output opens a paged read/refresh dialog. Stop command leaves the bot and its other work running. Both UI APIs require authentication and current bot/run/process identities; stopping also requires CSRF and the current remote run identity. Late responses cannot replace another task's output dialog or make a stopped command look running again.

Commands belong to their task. They stop and drain on Stop, failure, runtime limits, successful task end or shutdown. A final model answer while a background command is still running fails explicitly and preserves the available work. The model must wait for the command or intentionally stop it before finishing. These are concurrent task-owned sessions, not persistent service hosting across completed tasks.

There are at most four active commands per task, eight globally and 20 command histories per task. Command timeout defaults to five minutes and accepts 100–1800000 ms, while the task's own deadline still applies. Output stops at 250000 raw bytes; overflow terminates the command with explicit output-limit status. Split UTF-8 characters and known credentials split across chunks are handled before output is exposed. Credential rotation refreshes the old/new secret union, and complete retained text is redacted before pagination/persistence; unrelated short readiness messages remain visible immediately. At most 12000 redacted characters per command are persisted as a preview; full bounded output stays in process-manager memory until task cleanup. Later/restarted reads identify prefix-only coverage explicitly.

Each command uses a Tupies-owned guardian. Loss of the host IPC connection terminates the ordinary process group, including descendants that ignore TERM. Restart marks unfinished metadata interrupted and never relaunches a stored command or adopts/signals a historical PID. On Windows a process-tree termination route exists; execution verification was performed on macOS. A command deliberately escaping its process group still falls within the documented trusted-host execution boundary.

## Language-server intelligence

`lsp_start` requests exact approval of `{server:"typescript",rootPath?}` or `{server:"custom",executable,args,rootPath?}`. Both Workspace and Terminal must be enabled to launch it. The bundled TypeScript/JavaScript preset uses pinned runtime dependencies `typescript-language-server` 5.3.0 and TypeScript 6.0.3, supporting the project's Node 22.16+ baseline. It selects the shipped compiler, disables automatic type acquisition and does not enable project-local plugin loading. Custom servers must already be installed; the tool does not install packages. All language servers are trusted host processes with host-account permissions, not isolated filesystem sandboxes. Selecting a project root constrains tool file selection and returned locations; it does not sandbox the approved server's own imports or filesystem access.

The server returns a session ID and explicit supported capabilities. `lsp_query` uses the following operations when the server advertises them:

| Operation | Inputs and result |
| --- | --- |
| definition, type_definition, implementation | `path`, `line`, `character`; normalized private project locations. |
| references | Same position inputs; optional `includeDeclaration` defaults true. |
| hover | Same position inputs; bounded text and optional source range. |
| document_symbols | `path`; named symbols with kinds and private locations. |
| workspace_symbols | `query`; named symbols across the selected project. |
| prepare_call_hierarchy | Source position; bounded items with opaque session-owned `itemId` values. |
| incoming_calls, outgoing_calls | An `itemId` returned by the same session; normalized call items and call-site ranges. Changed source invalidates the prepared item; prepare again. |
| diagnostics | `path`; actual server reports plus received/version/freshness/truncation fields. |

Source positions are 1-based UTF-16 code units. Tupies uses standard Content-Length JSON-RPC, initializes the server, synchronizes opened documents and changed content before querying, and closes vanished open files. Outside-project file URIs, symlinks and malformed locations are omitted with explicit coverage metadata. Opaque hierarchy data stays internal and never becomes a model-authored server command. The client refuses `workspace/applyEdit`, arbitrary command execution and unsupported server-initiated requests; edits continue through Tupies's normal file tools and approvals.

Diagnostics use pull reports when supported, otherwise bounded push notifications. No report within the two-second wait returns `received:false`, not an empty-success assertion. Unversioned push reports are labeled `versioned:false`; they cannot prove an exact source revision even after document synchronization. Server text is untrusted evidence. Missing capabilities and protocol failures produce tool errors, and all server processes drain at task end.

There are at most two language servers per task, four globally and 20 opened files per session, each up to 1 MB. Responses cap locations/symbols/diagnostics at 100 items; call hierarchy caps 30 items, 20 call-site ranges per item and 100 retained hierarchy handles. Additional text/frame/output limits report truncation or failure explicitly: 2 MB per protocol frame and 16 MB protocol output per session. See [API](api.md) for exact tool schemas and [verification](verification.md) for real bundled-server and crash-cleanup evidence.

The protocol follows Microsoft's [LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/). The preset uses the maintained [TypeScript Language Server](https://github.com/typescript-language-server/typescript-language-server), rather than an approximate text-search implementation.

## Batches and long results

Up to four adjacent, explicitly classified read calls can run together. Every mutation, approval, delegation or unknown tool is an ordering barrier. Results enter provider history in original call order. A failed read returns an error result while successful siblings remain usable. Stop aborts all started reads and drains the batch before history is reconciled. Commands and integration calls are never parallelized by this mechanism.

Results larger than 16000 characters return a short preview and a `resultId`. Use `tool_result_read` with that ID and follow `nextOffset`. Outputs are redacted before retention. Up to 250000 characters per result and 1000000 characters per active run are retained in memory; the oldest retained results expire first. Results expire when execution ends, and full retained text is excluded from run polling and persistent state. Read pages are at most 12000 characters and shrink further when JSON escaping needs space. `truncated` distinguishes a retained prefix from the complete source result. Missing or expired results require a new, narrower read.

All calls, including plan updates and result pages, count toward the existing 60-call task budget. Model-step and wall-clock limits remain enforced. Workspace reads are targeted, not a promise to ingest an entire 1 MB file in a single task. Search scans at most 4000 entries, 20 directory levels, 1 MB per file and 8 MB total per call. Binary/skipped reads count toward the byte budget. Globs support `*`, `**` and `?`; content search is literal. Discovery skips `.git`, `.tmp` and `node_modules`, plus other hidden paths unless explicitly requested. Scan truncation and skipped counts are returned; no matches do not establish absence outside that boundary.

## Comparison evidence and scope

The implementation was informed by Anthropic's primary documentation: [how Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) and [its tool reference](https://code.claude.com/docs/en/tools-reference), consulted on 26 October 2026. Those pages describe file operations, search, execution, agent delegation and task tracking. They describe the current documented product; they are not proof of behavior in the older installed binary below.

The requested reverse-engineer-anything investigation selected the installed Claude Code standalone artifact version **2.1.114**, an arm64 Mach-O with SHA-256 `bf1b4da368da7970f0d1d4a1675acea99b6f2ad94f24e9f8ccfcc7940ac67894` (204534752 bytes).

| Question | Evidence and conclusion | Coverage |
| --- | --- | --- |
| Which local artifact was inspected? | REA `open_binary` bound the digest above. `inspect_macho` retained parent Evidence `ev_7899f1dcbabcb57aacdbefff7ebea8676b7be81c5850f4b54c7663a89e8fbc02`; summary Evidence `ev_5daa026b061922616a4d7640608acb4bf7201ad7d7e2d9097d3ff43e6bc19fe0` reports arm64/64-bit, 7 segments and 23 load commands. | Answered for this artifact only. Import/export inventories are explicitly non-exhaustive. |
| Are edit and task concepts embedded? | A separate bounded shell byte scan found literal `old_string` (149 occurrences; first byte 76476237), `new_string` (127; 76476250), `replace_all` (100; 62209527), `TaskCreate` (50; 72623065), `TaskUpdate` (45; 72162996) and `TodoWrite` (20; 76423231). | Observed strings from ordinary shell analysis, not REA Evidence or observed execution. Names alone do not establish registration or semantics. |
| Was command background support observed? | The same byte scan found `run_in_background` (77 occurrences; first byte 76502610); official docs discuss background task control. | Partial comparison evidence: no command lifecycle was executed in Claude Code. Tupies's independent background implementation is exercised with real processes, including host-crash cleanup. |
| Was proprietary control flow recovered? | REA session diagnostics reported no configured Ghidra/Java or Hopper installation. Native metadata inspection succeeded without them. No decompiler was installed, and no Claude account/session data was read. The native session was closed. | Unresolved; no decompilation or runtime equivalence claim. |
| Does Tupies's reconstructed workflow execute? | Deterministic tests drive Tupies's actual engine/tools across discovery, reading, exact editing, command approval, verification, cancellation, plan persistence and paged output. | Answered for tested Tupies behavior, independently implemented from its own source. A deterministic model fixture does not establish equal model quality or provider entitlement. |

Tupies retains its own bots-first architecture, private workspaces and security policy. Background commands and real LSP navigation/diagnostics are implemented as described above. Signed-in or form-filling browser work, computer actions, opening workspace images mid-task (screenshots from the read-only browser are shown), built-in web search, arbitrary host project mounts, git worktree management and file-rewind checkpoints remain future work. Interactive questions (`ask_user`) and attached-image understanding are covered in `docs/capabilities.md`. Full Claude Code parity is not claimed from this delivered toolset. Assigned REST/MCP integrations, bounded real bot delegation, skills, memory and document output provide extension paths within their documented permissions.
