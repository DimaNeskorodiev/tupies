# Terminal, code snippets and command approval

Bots with the **Terminal** tool group get a real shell (`terminal`) and an ad-hoc code runner (`execute_code`). A deterministic, pattern-based classifier decides which commands run without asking. It replaces the per-action model risk review for terminal and code actions, so commands no longer cost an extra inference. `shell_run`, `shell_start`, saved scripts (`script_save` / `script_run`, see [Workspaces](workspaces.md)) and skill scripts keep working; the older `scripts_register`/`scripts_run` stay for existing callers and routine steps.

Code: `lib/terminal.mjs` (runtime), `lib/command-classifier.mjs` (classifier), `lib/command-policy.mjs` (approval policy, allowlist, routine pre-approval, integration auto reads). The Engine calls the policy from `approve()` in `lib/engine.mjs`. Tests: `test/command-classifier.test.mjs`, `test/command-policy.test.mjs`, `test/terminal.test.mjs`.

## `terminal`

`terminal {command, timeoutMs?}` runs one command line with `bash -lc` on the Engine host. The first command of a task starts in the bot's private workspace.

- **Persistent folder and exports per task.** `cd`, `export` and `unset` carry over to the task's next `terminal` and `execute_code` calls. Each task (run) has its own session; another task starts fresh in the workspace. Sessions live in Engine memory only, so a restart starts fresh. Shell functions, aliases and unexported variables do not persist.
- **Timeout** defaults to 10 minutes (600000 ms) and accepts 1000–1800000 ms. The task's own deadline still applies.
- **Output.** stdout and stderr are merged in arrival order. Long output keeps the first and last 12 KB with an explicit `… N bytes omitted …` marker (`truncated`, `omittedBytes`, `outputBytes`). A runaway producer is stopped after 64 MB (`outputLimit`). A shortened view is not a failure; a nonzero `exitCode`, `timedOut` or `outputLimit` is.
- **Result:** `{command, cwd, exitCode, durationMs, output, truncated, outputBytes, timedOut?, signal?}`. `cwd` is workspace-relative, or absolute when the session is outside the workspace.
- **Stop and cancellation.** Each command is its own process group. Stop, task failure or timeout sends TERM to the group and then KILL after 500 ms. When a command finishes, anything it left running in its group is killed too, so use `shell_start` for real background work.

**Why a wrapper per command instead of a long-lived shell.** Each call runs a fresh `bash -lc` wrapper. The wrapper restores the saved folder and exported variables, runs the command with `eval` in the same shell, and on exit writes `pwd -P` and the exported environment to a private Engine folder. Restored values travel as data in the child environment, never as sourced shell code. This approach keeps timeouts, Stop and output bounds per command. It avoids prompt or sentinel parsing and hangs on stdin. A killed or crashed command cannot corrupt the session: the last good state is kept.

The process environment is the existing curated one from `process-environment.mjs`: a per-bot engine-local HOME, no provider credentials, and Git hooks, fsmonitor, credential helpers and `ext::` disabled. A command cannot persist changes to those protective `GIT_CONFIG_*` and `PYTHONNOUSERSITE` settings. Code-injecting variables (`LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, exported functions) are never carried over. With the default setting this is trusted host execution with the server account's permissions, not an OS sandbox. See “Where commands run” below.

## Where commands run

Bot settings → Tools → Automation & development → **Where commands run** (`bot.execution.backend`, owner-only):

| Choice | Meaning |
| --- | --- |
| This computer, ask me (default, no setting) | Today's behaviour: host execution, approvals as in the table below. |
| Sandbox on this computer (recommended) | Commands can change only the bot's own folders and cannot read the Engine's data or your keys. Read-only and ordinary commands run without asking in every lane; dangerous ones still ask; Strict asks for everything. |
| Docker container | Each command runs in a fresh container (`docker run --rm`) that mounts only the bot's workspace and process home. Same approval behaviour as the sandbox while Docker and the image are ready. |
| Another machine (SSH) | Each command runs on a machine you set up, in `<base folder>/<bot id>/`. Same approval behaviour as the sandbox while the connection works. The bot's local workspace is not copied there. |

A status line under the choice comes from `GET /api/execution` (authenticated): `{backends:[{id,label,available,reason,isolated,summary}]}`, for example "Sandbox ready" or "bubblewrap (bwrap) is not installed on this server". The sandbox is Seatbelt (`/usr/bin/sandbox-exec`) on macOS and bubblewrap on Linux; what it allows and denies is in `docs/security.md` → Command sandbox.

### Docker and SSH settings (engine environment)

Both are per engine, not per bot. Set them in the engine's environment (`.env` or the service definition) and restart.

**Docker** uses the `docker` (or `podman`) command found on `PATH` or in `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`; it never uses the Docker API or mounts the socket, and never pulls an image. The status line says which command to run when the image is missing (for example `docker pull nikolaik/python-nodejs:python3.12-nodejs22-slim`).

| Variable | Default | Meaning |
| --- | --- | --- |
| STUDIO_EXEC_DOCKER_IMAGE | `nikolaik/python-nodejs:python3.12-nodejs22-slim` | Image to run commands in. It must already be on this computer and contain `bash`; the default has Python 3 and Node 22 but not Git. Build your own (for example named `tupies-exec`) for more tools. |
| STUDIO_EXEC_DOCKER_MEMORY | `2g` | Memory limit per command. |
| STUDIO_EXEC_DOCKER_PIDS | `512` | Process limit per command. |

A command runs as `docker run --rm -i --init --pull=never --cap-drop ALL --security-opt no-new-privileges --memory … --pids-limit …` (plus `--user uid:gid` on Linux; Docker Desktop on macOS maps file ownership itself), with the network at its default (open). Only two folders are mounted, read-write: the bot's workspace and its process home, each **at the same absolute path as on the computer**, so paths in commands, in `execute_code` snippets and in the terminal's saved working folder mean the same inside and outside. Environment variables come from an allow-list (`HOME`, `TMPDIR`, `LANG`, `XDG_*`, `GIT_*` config, `PIP_*`, `npm_config_*`, `TUPIES_*`); the container's `PATH` is the image's. `execute_code` with `language:"node"` starts Node by the engine's own path, which does not exist in the container; use `terminal` with `node file.js` there. Stop ends the `docker run` client's process group, which forwards the termination signal to the container (`--init`); a command that ignores it can keep running in the container until it ends on its own (containers are named `tupies-exec-…` and labelled `tupies-exec=1`, so you can `docker kill` them).

**SSH** uses the system `ssh` client with `BatchMode=yes`, `StrictHostKeyChecking=yes` (no password prompts; add the host key once yourself with `ssh -p PORT USER@HOST`), `-T`, a connect timeout, keep-alive probes, and one shared connection (`ControlMaster=auto`, socket in `<data folder>/exec-ssh/`; skipped when that path would be too long for a socket).

| Variable | Default | Meaning |
| --- | --- | --- |
| STUDIO_EXEC_SSH_HOST | unset | Host name or address. SSH is "not set up" until this and the user are set. |
| STUDIO_EXEC_SSH_USER | unset | Remote account. |
| STUDIO_EXEC_SSH_PORT | `22` | Remote port. |
| STUDIO_EXEC_SSH_KEY | unset | Full path of a private key file on this computer. Without it the ssh agent (`SSH_AUTH_SOCK`) and default keys are used. |
| STUDIO_EXEC_SSH_DIR | `tupies` | Base folder on the remote machine (absolute, or relative to the remote home). Each bot works in `<dir>/<bot id>/`. |

The local workspace is **not synced**: files the bot creates there stay on that machine, and local files are not visible to its commands. A working folder inside the workspace maps to the same relative folder remotely; anything else is refused. The remote account must use a POSIX-style login shell. Only `LANG`, `PYTHON*` flags and `TUPIES_*` variables are sent. A changed working folder is not carried between terminal calls. Stop ends the local `ssh` client; whether remote child processes then receive a hangup depends on the remote `sshd` (no terminal is requested), so a long-running quiet command may keep running there.

- **One registry.** `lib/exec/` holds the backends (`host`, `sandbox`, `docker`, `ssh`). `terminal`, `execute_code`, `shell_run`, `shell_start`, background commands, `script_run`/`scripts_run` and the owner's own script runs all ask it what to spawn; the supervisor, timeouts, output limits and Stop are unchanged. Registry entries are Engine code only, never loaded from a workspace, state or model output. The interface (`available`, `describe`, `check`, `prepare`) is documented at the top of `lib/exec/index.mjs`. Language servers and document workers are Engine-owned and stay on the host.
- **Snapshot.** A task uses the backend its bot had when the task started. Unattended runs need the saved bot to select the same backend too, so switching a bot back to "ask me" takes effect at the next command.
- **Fallback.** If the sandbox is selected but unavailable (or its profile cannot be built) when a command is admitted, the policy is exactly the host policy and the card says why; only such a command may run on the host. A command admitted for the sandbox fails closed if the sandbox breaks before it starts.
- **Caches** go to the process home: `HOME`, `TMPDIR`, `XDG_CACHE_HOME`, `npm_config_cache`, `PIP_CACHE_DIR` (and `xcrun_db` on macOS). Install packages into the workspace (`python3 -m venv .venv`, `npm install`); global installs fail.
- **Receipts.** Results and work receipts carry `backend: "sandbox"`, or `backend: "host"` with `sandboxUnavailable` after a disclosed fallback. A plain host bot's results are unchanged.
- **Limits.** The network is open; commands run as the same OS user; `git init`/`git clone` fail inside the sandbox because `.git/config` and `.git/hooks` are read-only; the Linux path is unit-tested but not yet run on Linux.

Tests: `test/exec-sandbox.test.mjs` (real Seatbelt on macOS, skipped elsewhere; bubblewrap argument builder anywhere), `test/exec-policy.test.mjs` (policy matrix, engine lanes, API, settings field).

## `execute_code`

`execute_code {language: "python" | "node", code, timeoutMs?}` writes the snippet to a private temporary file under the workspace's `.tmp/code/`. It runs the file with `python3` or the Engine's own Node, in the task's terminal folder and environment, under the same timeout, output and cancellation rules. The file is removed afterwards. Node snippets run as ES modules (top-level `await` works) unless they only use `require`. Use it for ad-hoc computation. Registered scripts (`scripts_register`/`scripts_run`) remain the way to keep reviewed, versioned code.

## Saved scripts

`script_save {id, title, purpose, language, code, inputs?, readme?, files?}` saves a reusable program under `scripts/<id>/` and computes its hashes; `script_run {id, args?, inputs?, timeoutMs?}` runs the current saved version through the same backend registry. Named inputs arrive as literal `--name value` argument pairs and as JSON in `TUPIES_SCRIPT_INPUTS`; nothing goes through a shell string. Approval is once per exact version and recorded engine-locally: a new or changed version always shows one card (with a diff against the approved version); an approved version then runs without a card in a ready sandbox under Balanced or Approve for me, in every lane. On this computer every `script_run` asks; Strict always asks; a script whose code the classifier rates dangerous always asks. Code: `lib/saved-scripts.mjs`, `lib/script-ledger.mjs` (decision called from `engineActionDecision`). Tests: `test/saved-scripts.test.mjs`, `test/saved-scripts-api.test.mjs`.

For fully determined work (fetching and parsing, calculations, conversions, bulk edits, checks over many items) bots are told to write and run one script instead of repeating tool calls, to reuse a saved script, and to save one after doing the same kind of work twice.

## Classifier

`classifyCommand(command, {workspaceRoot, cwd})` and `classifyCode(language, code)` are pure functions. They return `read_only | normal | dangerous`, short reasons (hazards first) and the simple commands found. The command parser is a conservative bash subset. It handles quotes, escapes, pipelines, `&&`/`||`/`;`/`&`, subshells, `$(…)`/backticks, process substitution, here-documents, redirections, env-assignment prefixes and wrappers such as `env`, `timeout`, `nice`, `xargs` and `sudo`. Nested commands are classified recursively.

- **read_only:** known inspection commands (`ls`, `cat`, `grep`, `find` without `-exec`/`-delete`, `git status|log|diff|show`, `jq`, `wc`, …) whose paths stay inside the workspace, with no write redirection. Pure Python/Node computation with no file, process, network or dynamic-code access is also read-only.
- **dangerous:**
  - deletion and discarding work: `rm`, `find -delete`, `git clean`, `git reset --hard`, `git checkout -- .`, `rsync --delete`
  - privilege: `sudo`, `su`, `doas`
  - disks and filesystems: `dd`, `mkfs`, `diskutil`
  - processes and services: killing processes, shutdown, `launchctl`, `systemctl` changes, `crontab`
  - permissions: `chown`, `chmod 777`, setuid or recursive `chmod`
  - keychain and security settings
  - remote code: downloaded content piped or substituted into an interpreter (`curl … | sh`, `bash <(curl …)`)
  - data sends and remote access: POST/upload/credential flags, `nc`, `ssh`, `scp`
  - publishing: `git push`, `npm publish` and other registry publishes, `docker push`, cloud deletes or applies, global or system package installs
  - writes outside the workspace or to a computed path
  - credentials, keys, `.env` files and shell profiles
  - Git metadata or configuration writes
  - code-injecting environment variables
  - container host access
  - fork bombs
  - unparseable input
- **normal:** everything else, including unknown programs, project scripts, package installs, network downloads, workspace writes, reads outside the workspace and computed command names.

When the session folder is outside the workspace, reads become normal and writes become dangerous. Without a known workspace root, every absolute path counts as outside.

## Approval policy

The owner chose (9 November 2026) that Approve for me in the owner's own chat runs ordinary (non-dangerous) commands without asking; dangerous commands always ask.

`decideAction` uses the stricter of the task's snapshot and the saved bot's Action review setting; an unknown setting counts as Strict. The decision is re-checked just before execution.

For a bot whose commands run in a ready sandbox (see “Where commands run”), read_only and normal commands run in every lane under Balanced and Approve for me; dangerous ones ask and Strict asks for everything. The table below is the host behaviour.

| Command | Strict | Balanced | Approve for me, owner chat | Approve for me, routines / teammates / other chats |
| --- | --- | --- | --- | --- |
| read_only | ask | runs | runs | runs |
| normal on the bot's allowlist | ask | runs | runs | runs |
| exact routine pre-approved command (routine lane) | runs | runs | runs | runs |
| other normal | ask | ask | runs | ask |
| dangerous | ask | ask | ask | ask |

- **`shell_run` / `shell_start`** keep their earlier meaning: exact approval in every lane and policy, except that Approve for me in the owner's chat now auto-runs non-dangerous calls on the classifier's verdict instead of a model review. Dangerous calls always ask. The allowlist and routine pre-approval apply to `terminal` (and the allowlist not to `execute_code`).
- **Dangerous always asks** with the existing exact approval card. The card now carries `review.command {risk, reasons, cwd}`. Denial is remembered for the task, and nothing is replayed after a restart.
- **Per-bot allowlist** (`commandAllowlist` on the bot): up to 50 owner patterns where `*` matches any text, such as `npm test`, `npm run *` or `python3 scripts/*.py`. Patterns describe one simple command (no `; & | < > $ \` ( )`). A command line is allowlisted when it is classified normal, every non-read-only simple command matches a pattern, and at least one matched. Both the task snapshot and the saved bot must allow it. Owner-only: Bot settings → Tools → Automation & development → Allowed commands, or `PATCH /api/bots/:id {commandAllowlist}`. Manage Tupies tools cannot set it. It does not apply to `execute_code`.
- **Routine pre-approval:** `routines_create`/`routines_update` (and the owner routine API) accept `commands: [exact command strings]` (up to 20). Dangerous commands are refused. They are stored as `approvedCommands [{command, digest}]`, and the approval card lists each exact command. Adding commands is never decided by the model reviewer, even with Approve for me; the owner approves it. In a run of that routine, a `terminal` call whose sha256 digest matches an entry in both the run snapshot and the current routine runs unattended. Changing a routine's bot drops its pre-approvals.
- **Integrations:** an owner can mark a REST `GET` action `approval: "auto"` in the integration's action list (default `ask`; non-GET and MCP tools cannot be auto). Matching calls from an assigned bot run without review in every lane except Strict. Every other integration call keeps the existing path.

### Where the model reviewer still runs

`lib/action-risk-review.mjs` still reviews, in Approve-for-me owner chats only:

- browser submissions and downloads
- Mac desktop input
- non-auto integration calls
- registered `scripts_run` on this computer (an approved version in a ready sandbox runs without review; `script_run` never reaches the reviewer) and `skills_run`
- `lsp_start`
- coding delegation
- team and routine changes

These effects depend on remote services, page state, registered multi-file packages or team settings that a command pattern cannot see. Terminal-family tools (`terminal`, `execute_code`, `shell_run`, `shell_start`) never reach it.

### Limits

The classifier is a best-effort policy aid. It does not resolve symlinks, does not evaluate variables or aliases, and cannot see inside programs the command runs. Approved or allowlisted programs run with the server account's permissions. The real security boundary remains the owner's choice of tool groups, the dangerous-command gate, and the process environment.
