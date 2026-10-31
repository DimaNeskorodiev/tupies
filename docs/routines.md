# Routines, saved steps and autonomous recovery

This page describes **autonomous-work-20261030**, which supersedes the earlier fixed-budget, explicit-Continue routine behavior. Native Apple apps and the Mac bundled fallback have separate versions. See [verification](verification.md) and `PROJECT_CONTEXT.md` for exact release evidence and installation status.

A routine runs a self-contained task on its assigned bot. Ask a bot with Routines enabled to create or change one, or open **Routines** in the app. Bot-created routines and changes require approval of the exact configuration. A paused routine can still be started with **Run now**. Automatic schedules run only on the home engine while it is online; missed-run policy remains **once** or **skip**. Every scheduled occurrence starts a fresh run in the routine's own conversation lane, with the previous successful output supplied as background.

## Work until done

**Advanced execution → Execution** defaults to **Work until done** (`limits.mode:"autonomous"`). The same default applies to ordinary chat tasks. Autonomous work has no lifetime time, model-turn or tool-call cap. Old numeric settings such as 30 minutes / 50 turns / 200 tool calls do not silently select a bounded run.

Choose **Use explicit limits** (`limits.mode:"bounded"`) only when a task should stop at a chosen budget:

| Budget | Bounded-mode default | Allowed values |
| --- | --- | --- |
| Active execution time | 30 minutes | 1–120 whole minutes |
| Model turns | 50 | 1–200 |
| Tool calls | 200 | 1–1000 |

These settings govern execution, not permissions. Exact owner approval and interactive-answer waits pause a bounded task's timers; those waits still expire. Waiting for a teammate also pauses the parent’s active budget while the child keeps its own budget. **Stop** remains available and cancels active work and children. Individual tools, context size, outputs, checkpoint storage and concurrent work retain their bounds.

A model turn is one request to the model; it can propose several tool calls. The visible plan is a separate checklist: “2 of 3 steps done” does not prove that a file was saved. Autonomous work repairs unfinished plan steps or failed declared checks before finishing. Repeated unchanged work is a real blocker: the default detector stops when the same observed work recurs four times within a rolling window of twelve observations, rather than after a fixed number of useful steps.

## Repair a required teammate result

A required delegation returns an engine-owned `deliverable.id`. If it is partial, the bot uses `delegate_task` with that `deliverableId`, the original `botId` and concrete correction instructions in `task`. The original expected result remains binding even if the correction uses different wording. The tool and completion feedback include the exact repair arguments; a completed plan alone is never acceptance evidence.

Each attempt keeps its own result and verification. A verified repair can close the current requirement while its earlier partial receipt remains unchanged. Original declared file checks cannot be weakened; denied and uncertain exact actions remain blocked. Accepted child files are checked again before the parent finishes. A teammate outcome check referencing the original call can pass only through that same requirement’s verified child lineage. Different bots, other tasks and fabricated call IDs cannot certify it. Startup never substitutes an old cached partial reply for actual repair work. Historical failed runs are not rewritten or automatically replayed by this fix.

## Recover automatically

An individual model attempt retains separate defaults of 15 minutes total and five minutes without incoming response data. Streaming data refreshes inactivity, not the total timer. In autonomous mode, a trusted transient provider failure retries the model attempt in the same task with the original model, reasoning and capability snapshot. Backoff starts at two seconds and grows to five minutes, with no retry-count deadline. The engine does not repeat completed tools to retry the model request. Authentication refusals, invalid requests and unknown action outcomes require the appropriate correction or inspection.

The chat and routine history show **Auto-recovering** while waiting or recovering, and **Needs attention** when work cannot progress. There is no Continue button or separate execution-continuation approval. New actions keep their ordinary exact approval requirements. Web reads and other tools retain their own deadlines; a failed source is not evidence that nothing changed.

After startup initializes the process, browser and coding managers, the engine can recover an interrupted direct owner chat or routine from a matching schema-version-2, engine-owned autonomous checkpoint. It keeps the same run ID and original inference snapshot. It rechecks task/configuration, bot permissions and provider destination/account identity before execution. Historical failed tasks, old checkpoints and replaced tasks are not automatically resurrected. **Stop** commits cancellation before aborting work, so a restart cannot turn a stopped task into recovery.

Checkpoints retain bounded redacted progress and completed-effect evidence on the executing engine. An exact completed file action is reused only after checking current file bytes; saved final reports are checked again before completion. A lost acknowledgement or unknown mutation outcome blocks automatic recovery until the actual destination is inspected. Old approvals and expired process/browser handles never become execution authority. A compatibility resume API remains available for eligible local routine checkpoints; ordinary operation recovers automatically.

Checkpoint storage is bounded and can be pruned; recovery is available only while the necessary engine-local evidence remains. Checkpoints and seen-item cursors never sync. Shared history and results on another engine neither supply a checkpoint nor authorize execution.

## Save repeated preparation once

For stable collection work, a saved procedure avoids asking the model to reconstruct every mechanical step on every run. In **Advanced execution → Saved preparation and reports**, enter a version 1 workflow JSON, or ask the bot to prepare one for exact approval. Leave it empty for an ordinary agent task. Existing routines remain ordinary agent tasks until explicitly changed; there is no automatic conversion of prior chats into runnable code.

The procedure supports four operations:

| Operation | Work performed |
| --- | --- |
| `fetch` | Read a fixed public HTTPS text URL through the bot's normal `http_fetch` tool. |
| `read` | Read a fixed relative private-workspace path through `workspace_read`. A truncated read fails explicitly. |
| `json` | Parse text from an earlier result; `path:"text"` selects a fetch body and `path:"content"` a workspace read. |
| `select` | Select previously unseen objects from an earlier array using a stable item key. |

For a feed shaped as `{"items":[{"id":"release-1","title":"New release"}]}`, this example prepares new candidates for the bot:

```json
{
  "version": 1,
  "mode": "agent",
  "steps": [
    {"id": "feed", "op": "fetch", "url": "https://example.com/feed.json"},
    {"id": "parsed", "op": "json", "from": "feed", "path": "text"},
    {"id": "fresh", "op": "select", "from": "parsed", "path": "items", "key": "id", "limit": 25}
  ],
  "skipIfEmpty": "fresh",
  "context": "Assess the reliability, novelty and usefulness of these candidates: {{fresh}}",
  "emptyReport": "No new items."
}
```

`example.com/feed.json` is a placeholder; replace it with an accessible JSON source that has the expected fields. The routine's normal `prompt` still specifies the real task, evidence requirements and destination. Fetch/read targets are fixed configuration, not templates chosen from source content. Public-network, private-path, tool-group and approval checks remain in the engine.

In `mode:"agent"`, prepared data enters the ordinary agent loop as untrusted evidence. Use the model for assessing meaning, reliability and useful recommendations. With `skipIfEmpty`, no new items produces the configured short report without a model call. An HTTP error, malformed JSON or blocked source is a failure, not “nothing new.”

In `mode:"report"`, the engine renders `report`, such as `"New records: {{fresh}}"`, without a model or provider connection. Templates only insert bounded text/JSON from named results; they cannot execute expressions. Optional `savePath`, for example `"reports/releases.md"`, saves the final output through ordinary `workspace_write`. Strict policy and protected Git/automatic-execution paths still require approval of the exact path and bytes. An unchanged skipped run does not overwrite a previously saved report.

Seen-item markers commit only after the entire task succeeds, including an optional report save. Failed analysis or saving does not consume the candidates. Items beyond `select.limit` remain eligible for later runs. The engine keeps up to 2000 recent key hashes per select step; this bounded cursor is not a permanent archive. Changing the saved workflow invalidates its cursor.

Workflows allow up to 16 steps, 1000 source items and 100 selected items per select step, with 64 KiB of combined results. Oversize or truncated data fails instead of silently losing items. Saved steps do not run shell, JavaScript, arbitrary scripts or source-selected tools. Open-ended research, changing page layouts, authentication and CAPTCHA still need the appropriate agent/browser workflow; the saved procedure does not solve them automatically.

## Research behind the design

- [Windmill AI Flow Chat](https://www.windmill.dev/docs/flows/ai_flows) builds reusable scripts, loops and branches from a natural-language request. This supports preparing a stable procedure once while retaining model reasoning where the task needs it.
- [n8n execution configuration](https://docs.n8n.io/hosting/configuration/environment-variables/executions/) separates workflow duration from the HTTP timeout of AI nodes. Tupies likewise separates task budgets, individual model-response limits and tool deadlines; its defaults are its own.
- [LangGraph checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) retain graph state and completed node results for recovery. Tupies retains its own bounded engine checkpoints and revalidates execution identity before automatic recovery.
- [Temporal activity idempotency](https://docs.temporal.io/activity-definition) explains why an action can complete before its acknowledgement is lost, making a blind retry unsafe. Tupies blocks continuation when a mutation has an uncertain outcome.

These are design references, not a claim of feature or reliability parity. Tupies Engine remains responsible for execution, state and authorization; none of these products is a runtime dependency.
