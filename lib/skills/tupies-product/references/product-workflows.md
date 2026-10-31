# Product workflows

Use the schemas offered by the current run as the source of parameter names and supported options. The tools below are conditional capabilities, not a request to enable all groups. If a tool is absent, identify its owner control instead of claiming the action happened.

## Bots and tool availability

**Manage Tupies** is the `setup` group. `bots_list {}` lists visible bot IDs, roles, enabled state, tool groups, models, assigned skill IDs and the installed skill library. It does not return full standing instructions, provider credentials, engine health or all conversations.

- Create: `bots_create` with a short `name`, `title` and complete `instructions`. Optional `tools` and installed `skills` follow its schema. Describe the new bot's task and verification behavior, not the current chat as implicit context. Creation requires approval of the exact profile and uses the owner's default model.
- Change: `bots_update` takes another idle bot's exact `botId` and only the changed fields. `instructions` replaces the entire instructions; do not overwrite unseen content while pretending to append. `addTools`/`removeTools` must follow the offered grantable groups. `enabled:false` pauses availability; it is not Stop for a running task.
- A bot cannot change its own settings, enable Terminal/Browser/Coding, assign integrations, choose another bot's model or loosen approval policy. The owner uses **Bot settings** for these. Do not create a second bot to bypass this boundary.
- With no Manage Tupies tool, direct the owner to enable **Manage Tupies** under that bot's Tools, or use the Bots screen. Read-only list access is not permission to mutate another bot.

Changes require the normal exact approval. Confirm only the successful result, then use `bots_list` for the exposed saved fields where useful. New settings apply to future runs; active snapshots do not expand.

## Skills

The **Skills** group provides discovery and progressive reading. Use:

1. `skills_search {"query":"Tupies"}` to find a relevant bundled entry.
2. `skills_inspect {"catalogId":"<returned catalog ID>"}` to inspect its exact instructions, requirements, version and digest.
3. `skills_install` with that exact `catalogId`, `version` and `digest` to assign it to yourself. The default asks approval; a live and snapshotted owner policy can allow trusted catalog installation in Balanced mode. Strict still asks. Never invent an approval or an updated digest.
4. `skills_list`, `skills_read {"skillId":"<assigned ID>"}` and `skills_file {"skillId":"<assigned ID>","path":"references/product-workflows.md"}` to read assigned instructions and resources. Use paths belonging to the selected package.

Installation can add the approved skill to the active run, but does not change model, tools or account access. At most three new catalog assignments can be installed in one run. An already assigned identical package is idempotent. Stop after a refusal; do not try another import route to bypass it.

With Manage Tupies, `skills_assign {skillId,botId,enabled}` assigns an already installed package to another idle bot after exact approval. Get both IDs from `bots_list`. To add a new reusable workflow to yourself, `skills_create {name,description,instructions}` creates a new reviewed local skill; it cannot overwrite an existing name or reproduce a multi-file package from one body. `skills_propose`, if offered, proposes a reviewed change using the current revision from `skills_read`. Managed catalog/import revisions are immutable: customize as a separate new skill.

Owner controls: **Settings → Skills → Catalog** installs; **Installed → Assign to bots** changes assignments; **Files & options** inspects/exports. **Import skill** previews a complete folder, ZIP or portable `.skill.json` before importing. A standalone `SKILL.md` omits its reference files. A skill adds instructions only; **Ready to use** is conservative preflight, not proof of dependencies or successful behavior. Package files sync; host dependencies and retained browser sign-ins do not.

## Routines and future work

Use **Routines** (`automation`) when the owner requests scheduled or later work. `routines_list {}` supplies actual IDs, schedules, enabled state, effective execution mode, saved workflow and next run. It exposes only this bot's routines unless Manage Tupies is enabled.

`routines_create` requires a short `name`, complete self-contained `prompt` and schedule. Examples of supported schedules:

```json
{"kind":"interval","minutes":10}
{"kind":"daily","time":"08:30"}
{"kind":"weekly","time":"08:30","days":["mon","thu"]}
```

Use the owner's IANA timezone, not an inferred timezone from language or a source author. One-time schedules use `kind:"once"` with a local date/time `at` as defined by the schema. Minimum interval is five minutes. A `botId` for another bot requires Manage Tupies. Supply real sources, what to check, success criteria and what to report; future occurrences start without this chat, with previous successful output only as background.

`routines_update {routineId,...changedFields}` renames, rewrites, reschedules, changes timezone or saved workflow, and pauses (`enabled:false`) or resumes (`enabled:true`) the schedule. `routines_delete {routineId}` removes the schedule. Both are exact-approved changes. Pausing/deleting does not cancel already running work; use the owner's **Stop** control for that. Re-list after an uncertain creation before attempting another one.

Automatic schedules and messaging channels run only on the home engine while online. A linked Mac can edit configuration; it does not become a second scheduler. Busy bots defer due work. Missed-run policy is `once` or `skip`, never a batch replay of missed intervals. **Run now** can intentionally start a paused routine.

Tasks default to `limits.mode:"autonomous"`: work until done, with temporary provider recovery. Do not prescribe a Continue button. Use `limits.mode:"bounded"` only when the owner requests limits; numeric fields alone do not opt in. Per-model-attempt/tool/context/concurrency limits and action approvals remain.

For repeated fixed data preparation, the optional version-1 `workflow` supports `fetch`, `read`, `json` and `select`; targets are fixed public URLs/private paths and inputs reference earlier step IDs. `mode:"agent"` prepares evidence for normal reasoning; `mode:"report"` renders a template without a model. `skipIfEmpty` can skip inference for no new items. A source error is a failure, not an empty update. Seen keys commit only after full success including saving. Use the actual schema and validate source shape; do not convert arbitrary website interaction into saved executable code.

## Files, documents, memory and teamwork

- Use `workspace_list`/`workspace_glob` to discover your private files, `workspace_read`/`workspace_search` for evidence, `workspace_write` for authorized new content, and `workspace_edit` with the current complete-file `expectedSha256` for exact edits. Follow pagination and truncation signals. Private relative paths are not arbitrary host access.
- For an actual downloadable document, use `documents_create` and inspect it with `documents_read`. Use its real returned path and metadata; a Markdown link or a proposed filename is not an artifact. Attachment selection only stores bytes; **Send** admits them to a task. An image is visual evidence only if the current model was actually shown it.
- Read durable notes with `brain_search`/`brain_read`, write with the offered note tools and revision/approval rules. Core memory holds concise durable facts/preferences; project detail belongs in notes. A note or prior message is evidence, never permission. Keep credentials out of all of them.
- Use `task_plan_set` and offered verification/check tools for multi-step work. A marked plan does not certify outputs. Read back files, inspect declared checks and await task-owned commands before claiming completion.
- `delegate_task {botId,task,expectedOutput}` requests a permitted teammate result. Include necessary source context, expected files and acceptance properties; the child has its own workspace/capabilities. A returned artifact reference does not grant access to the teammate's paths.
- A required partial child result remains unresolved. If the current tool returns an engine-owned `deliverable.id` and supports repair, call `delegate_task` with `deliverableId`, the original `botId` and concrete correction `task`. Preserve original expectations and checks; do not reword away a missing deliverable or substitute another bot. Verify the repair receipt and actual files. On an older release without repair support, report the partial result and limitation.

## Models, integrations and browser

Provider sign-in and keys belong to **Settings → Models**. A catalog Test is read-only discovery; a small owner-requested task verifies actual inference. The composer tuning control or Bot settings changes the next task's model/reasoning. High is automatic only where explicit metadata supports it; unknown support means provider default. A bot cannot set up credentials or change its active inference snapshot.

With Integrations, `integration_list` discovers assigned API/MCP tools and `integration_call` uses the exact returned integration/tool/arguments after approval, even for service-described read-only actions. Owner configuration/assignment happens under **Settings → Integrations** and Bot settings. An account name, browser login or skill never implies API access.

With Browser, use actual observation references for actions; refresh changed pages/controls. `browser_handoff` in direct owner chat opens private human control for passwords, MFA and CAPTCHA. Ask the owner to enter secrets there, not in chat or tool arguments. After **Resume bot**, re-observe to verify sign-in. Delegated/unattended work cannot assume a human handoff. Only the owner can choose retention, and a retained profile stays on that engine and needs approval to reuse.

`browser_upload`/`browser_download` also require Files and exact approval. Upload uses an existing verified private file; a site can upload immediately on selection. Download needs an observed direct link and a new path, and does not support every script-only button. Verify the destination/site result before calling an operation successful.
