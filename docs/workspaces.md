# A bot’s workspace and reusable scripts

## Isolated tools and reusable product improvements

The separate owner-enabled [Tool workshop](tool-workshop.md) supports autonomous pure JavaScript/JSON tools without Terminal. It has its own isolated runtime and Engine-local package/inbox storage; it does not loosen the host Scripts rules below. Bot → Workshop lets owners inspect and export selected improvements for maintainer review and future shared catalog releases.


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

When a bot does fully determined work (fetching and parsing pages, calculations, file conversions, bulk edits, checks over many items) it should write one script instead of repeating tool calls, and keep the script when the same kind of work comes up again. Bots with **Files** and **Terminal** get two tools for this (in the `terminal` tool group):

- `script_save {id, title, purpose, language: python|node|bash, code, inputs?, readme?, files?}` writes `scripts/<id>/main.py` (or `main.mjs`, `main.sh`; an existing entry file of the same language is reused), writes a README when none is given, computes the hash of every file itself and registers the package in one call. The model never supplies a hash. `inputs` is a list of `{name, description, required?, default?}`. `files` adopts extra files the bot already wrote into the same folder (helpers, data), again with engine-computed hashes. Saving changed code or metadata creates a new **version** (the package digest changes); saving identical content keeps the version. Saving never runs anything and needs no approval beyond writing files under the bot's review mode (Strict asks; Balanced and Approve for me do not).
- `script_run {id, args?, inputs?, timeoutMs?}` runs the current saved version. Each named input arrives as the two literal arguments `--name value`, followed by `args`; all inputs together also arrive as one JSON object in the environment variable `TUPIES_SCRIPT_INPUTS`. Nothing is interpolated into a shell string, so a value such as `; rm -rf x` or `$(id)` reaches the script as that exact text. Declared required inputs must be given; unknown names are refused; defaults are applied. The default lifetime is two minutes, up to thirty.

The on-disk package format is unchanged: `scripts/<id>/` with an entry file, `README.md` and the `script.json` manifest. Declared inputs are stored in the manifest's `inputs` list as `name (required) (default "x"): description`, so packages registered the old way (free-text inputs) keep listing, inspecting and running. `scripts_list` and `scripts_inspect` stay available; they show the model only a run count and the last status. `scripts_register` and `scripts_run` still work for existing callers and routine steps, but where `script_save`/`script_run` are available the model is no longer offered them (bots without Terminal keep the older registration flow).

Keep credentials in the appropriate Connections settings. Do not put tokens in script arguments, inputs, manifests, source files or README examples; the engine refuses known credentials there. A dependency declaration describes what is needed; Tupies does not install packages, run setup hooks or launch a foreign agent runtime to satisfy it. Missing interpreters, dependencies or connections must be reported before claiming the script works.

When a task in the owner's own chat made at least three successful `terminal`, `execute_code` or `shell_run` calls and no script call, the final reply carries a small display-only `scriptSuggestion` record (`{reason:'repeated_commands', commands}`, no code and no model text). The app shows it as a card whose button sends an ordinary chat message asking the bot to save the work with `script_save`. No suggestion appears when the last two suggestions among the chat's last 20 replies were both ignored.

## Approval: once per version

Approval belongs to an exact version. The engine keeps, per bot and outside every model-editable file (`<data>/script-ledger/<bot>.json`, never synced), which versions the owner approved, when and how: an approval card in a task (`card`), the owner pressing **Run** on that version (`owner-run`) or **Approve** in the app (`owner`). Model text, a synced or copied manifest and teammates cannot mark a version approved, and any byte change makes a new, unapproved version.

| Situation | `script_run` | `scripts_run` (older tool, routine steps) |
| --- | --- | --- |
| New or changed version | One card: names the script, says "New script" or "Changed since the version you approved", shows a bounded diff of the entry file. Allowing it approves that exact version. | Same card in a ready sandbox; elsewhere exactly the earlier rules. |
| Approved version, bot runs in a ready sandbox, Balanced or Approve for me | Runs without a card, in every lane (chat, routines, teammates, channels). | Same. |
| Approved version on this computer (host, or the sandbox is unavailable) | A card for every run. | The earlier rules (a card; under Approve for me in the owner's chat the model reviewer may decide). |
| Strict | Always a card. | Strict always asks. |
| The classifier rates any code file dangerous (starts other commands, deletes files, sends data, reads credentials, too large to check) | Always a card. | Always a card in a ready sandbox; elsewhere the earlier rules. |

The first run of a new version always shows its card, even in the sandbox where an equivalent ordinary command would run without one: the card is where the owner sees what the script does and what changed, and it is shown once per version. An automatic decision never records an approval; only the owner's own decision does.

## Run history and the owner's Run

Each script keeps its last 20 runs engine-locally, with a total counter: when, who started it (`bot`, `routine`, `teammate` or `owner`), exit status, duration, where it ran (`host` or `sandbox`) and a redacted head/tail of the output (at most 2,000 characters). Run records carry no model usage.

The owner can run an exact version without any model or task through the owner API (the Scripts tab's Run button is being built on it) (`POST /api/bots/{id}/scripts/{scriptId}` with `{action:'run', version, inputs?, args?, approve?}`). It uses the same place to run as the bot (the sandbox when selected and ready, otherwise this computer, because the owner asked), requires the bot to be idle (the script's working folder is the bot's workspace), and refuses a version that is no longer current. Pressing Run on a version not approved yet requires `approve: true` and approves that version. See [API](api.md).

The engine executes a verified copy of the package from the bot's engine-local process home; the working directory is the bot's workspace, so relative data and output paths work. Processes get a controlled environment, never provider credentials or the engine's startup environment. On the host they run with the account's permissions; in the sandbox they can change only the bot's own folders (see [Terminal](terminal.md) → Where commands run). A successful run needs exit code zero, no timeout and untruncated output; the result has separate stdout and stderr. Stop cancels the active work; it cannot undo effects already committed by a script.

## Use a saved script in a routine

**Use in routine** opens a paused routine draft with the selected script version and arguments. A saved workflow step `{id, op:'script', scriptId, digest, args}` pins the exact version. Data returned by a source cannot choose executable code or replace that version; a later JSON step can parse its successful stdout. A routine whose steps run without a model (report mode) finishes with a usage line of **0 model calls**. A version the owner approved runs in such a routine without a new card when the bot's commands run in a ready sandbox; on this computer each run asks. Successful preparation results are retained for the same task; recovery does not rerun completed or uncertain effects. See [Routines and recovery](routines.md).

## Work across engines

Workspace source files and `script.json` use the existing file-sync system; there is no separate script account or synced execution grant. Metadata and file bytes may arrive separately, so a script stays unavailable until its complete source manifest verifies. A partial replica is not runnable. Interpreter availability is checked on the current engine; declared dependencies remain unverified until checked there. Execution approvals, the script ledger (approved versions and run history), process homes, active processes and recovery journals stay on the executing engine and never sync; a script approved on one engine asks again on another.

Empty folders do not travel as file contents; another engine can initialize its own empty layout. Temporary files in `.tmp/` remain local. See [Engine sync](sync.md) for the shared-workspace boundaries.

## Learning from material in current source

The bot’s **Learning → Learn from material** view and direct-chat `study_material` use the explicitly installed native learning skill. Selected durable knowledge goes to `brain/tupies-managed-knowledge/`; Engine-owned manifests bind active revisions, source evidence and content hashes. Ordinary file/document/edit tools cannot forge those manifests. Corrections and rollback use exact reviewed publication previews; newer owner edits are preserved.

Protected originals, full extracts and active job journals live outside `workspaces/` and `skills/`, in Engine-local study storage. `.tmp/` remains model-editable scratch and is not the authoritative study store. Ordinary `uploads/`, `documents/`, `data/` and `notes/` still sync as before; adding a document there does not make it temporary. Learning copies an existing owner file without moving or deleting it. **Keep originals locally** retains feature-owned copies locally, not in a synced document folder. Otherwise complete publication disposes of copies; inactive failed/stopped/partial sources expire after seven days when the running engine next ticks or performs a startup/list/admission expiry check.

Accepted knowledge, bounded provenance/evidence and terminal presentation sync. Raw sources, full extracts, provider prompts, active jobs, approval identities and local retained-source availability do not. Partial note/manifest arrival cannot activate managed knowledge. Existing reference documents and imported knowledge are not migrated or reprocessed automatically.

A retained Brain method, a pending instructional Skill and an executable Script remain distinct. Learning never automatically registers/runs a program, enables Terminal or grants recurring execution. Requested reports can use `outputs/`; separately requested helper code keeps the existing Scripts digest and execution approval rules. This feature is implemented in mutable source; see [acceptance and remaining work](plans/specialist-knowledge-assimilation-20261101.md) before making operational-release claims.
