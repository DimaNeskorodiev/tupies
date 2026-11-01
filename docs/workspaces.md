# A bot’s workspace and reusable scripts

Each bot has a private workspace for its knowledge, documents, projects and results. Folder names organize the files; they do not grant extra tools or permission to run code. Another bot cannot read these files merely because a teammate mentions their paths.

## Start with a useful structure

Bots created through the app or approved chat setup start with the folders below. For an existing bot, open its **Files** tab and choose **Create default folders**, or ask a bot with Workspace tools to initialize its workspace. Initialization creates missing empty folders. It leaves existing files and folders where they are and reports a blocked path if a file or symbolic link occupies a folder name. It does not merge or replace that entry. Browsing the workspace does not initialize the standard folders silently.

| Folder | Use it for |
| --- | --- |
| `brain/` | Linked Markdown knowledge and long-term notes, available through Brain search and recall. |
| `notes/` | Working notes, outlines and drafts that do not need automatic recall. |
| `scripts/` | Reusable script source, documentation and descriptive manifests. |
| `projects/` | A folder for each ongoing project and its supporting files. |
| `documents/` | Source documents, reference material and document exports. |
| `data/` | Input datasets and structured local evidence. |
| `outputs/` | Finished reports, exports and other generated results. |
| `uploads/` | Files added to the bot’s workspace. Selecting a chat attachment stores it here; Send admits it to a task. |
| `.tmp/` | Hidden temporary working files. This folder does not sync. |

**Memory** is the bot’s existing collection of short facts and preferences. It is not a workspace folder. Detailed reusable knowledge belongs in Brain; a short memory fact can link to its note. See [Memory and notes](memory.md).

Use clear names that describe the purpose, such as `projects/monthly-budget/`, `scripts/summarize-expenses/` and `outputs/monthly-summary.pdf`. Prefer lowercase words separated by hyphens. These are organizing conventions, not a requirement to rename existing owner files.

## Save a script for reuse

Open a bot’s **Scripts** tab to search its local catalog, inspect a package’s purpose and files, and see its inputs, outputs and dependencies. A **draft** has source files without a registered manifest. **Registered** means its current source hashes match the manifest; it does not establish that dependencies work or that the program has been run. Changed or incomplete packages need review before execution.

Keep each reusable script in its own folder, such as `scripts/summarize-expenses/`, with:

- An entry file such as `main.py` or `index.mjs`.
- A `README.md` explaining what it does, its inputs and outputs, and how to verify its result.
- A `script.json` manifest describing the script, its interpreter, source files, inputs, outputs and known dependencies.

Ask the bot to read every source/helper file and register the package with the returned full-file hashes. Updating an existing registration also needs its current manifest hash, so a newer version cannot be overwritten silently. The manifest is descriptive data. A manifest written by a model, copied from another product or received through sync does not authorize execution. Imported drafts are not run automatically. Bot registration and changes to `scripts/<name>/script.json` require exact owner approval, including under Balanced policy. Editing ordinary source files invalidates their registered revision until they are reviewed and registered again.

Keep credentials in the appropriate Connections settings. Do not put tokens in script arguments, manifests, source files or README examples. A dependency declaration describes what is needed; Tupies does not automatically install packages, run setup hooks or launch a foreign agent runtime to satisfy it. Missing interpreters, dependencies or connections must be reported before claiming the script works.

## Run and verify

Choose a registered script in **Scripts**, enter arguments as a JSON array of literal strings, and use **Use in chat** to prepare a draft. Review and send that draft to start a task; the button does not run code. Files and Terminal tools must both be enabled. Every script execution requires approval of the exact source identity and run arguments. Approval for registration, a previous run or a routine does not become permission for another execution. The engine binds the run to verified source hashes, checks the selected interpreter again after approval, and refuses changed, missing or incomplete source files. It executes a verified copy using an engine-local process home, outside the model-editable workspace. The script’s working directory is the bot’s workspace, so declared relative data and output paths still work.

Processes use a controlled environment rather than inheriting provider credentials or the engine’s startup environment. They still run with the host account’s permissions; this is not an operating-system sandbox. The bot must have the required execution tools, and an imported script cannot enable those tools for itself.

A successful command needs a completed result with exit code zero and no timeout or truncated output. Its result includes separate stdout and stderr. The default command lifetime is two minutes, configurable up to thirty minutes within the task’s own limits. Inspect the actual output files before treating them as a verified report. Stop cancels the active work; it cannot undo effects already committed by a script. If execution is interrupted with an uncertain outcome, inspect the actual destination before attempting another action.

## Use a saved script in a routine

**Use in routine** opens a paused routine draft with the selected script revision and arguments. Review its task and schedule before saving. A saved workflow references a fixed registered script identity, source digest and literal arguments. It goes through the same engine execution and approval path as an ordinary script run. Data returned by a source cannot choose executable code or silently replace that fixed identity. A later JSON step can parse its successful stdout; failed or truncated script results fail preparation.

Each execution still needs its own exact approval. Saving a schedule does not grant recurring unattended code execution. Successful preparation results are retained for the same task; recovery must not rerun completed or uncertain effects. See [Routines and recovery](routines.md).

## Work across engines

Workspace source files and `script.json` use the existing file-sync system; there is no separate script account or synced execution grant. Metadata and file bytes may arrive separately, so a script stays unavailable until its complete source manifest verifies. A partial replica is not runnable. Interpreter availability is checked on the current engine; declared dependencies remain unverified until checked there. Execution approvals, process homes, active processes and recovery journals stay on the executing engine and never sync.

Empty folders do not travel as file contents; another engine can initialize its own empty layout. Temporary files in `.tmp/` remain local. See [Engine sync](sync.md) for the shared-workspace boundaries.

## Learning from material in current source

The bot’s **Learning → Learn from material** view and direct-chat `study_material` use the explicitly installed native learning skill. Selected durable knowledge goes to `brain/tupies-managed-knowledge/`; Engine-owned manifests bind active revisions, source evidence and content hashes. Ordinary file/document/edit tools cannot forge those manifests. Corrections and rollback use exact reviewed publication previews; newer owner edits are preserved.

Protected originals, full extracts and active job journals live outside `workspaces/` and `skills/`, in Engine-local study storage. `.tmp/` remains model-editable scratch and is not the authoritative study store. Ordinary `uploads/`, `documents/`, `data/` and `notes/` still sync as before; adding a document there does not make it temporary. Learning copies an existing owner file without moving or deleting it. **Keep originals locally** retains feature-owned copies locally, not in a synced document folder. Otherwise complete publication disposes of copies; inactive failed/stopped/partial sources expire after seven days when the running engine next ticks or performs a startup/list/admission expiry check.

Accepted knowledge, bounded provenance/evidence and terminal presentation sync. Raw sources, full extracts, provider prompts, active jobs, approval identities and local retained-source availability do not. Partial note/manifest arrival cannot activate managed knowledge. Existing reference documents and imported knowledge are not migrated or reprocessed automatically.

A retained Brain method, a pending instructional Skill and an executable Script remain distinct. Learning never automatically registers/runs a program, enables Terminal or grants recurring execution. Requested reports can use `outputs/`; separately requested helper code keeps the existing Scripts digest and execution approval rules. This feature is implemented in mutable source; see [acceptance and remaining work](plans/specialist-knowledge-assimilation-20261101.md) before making operational-release claims.
