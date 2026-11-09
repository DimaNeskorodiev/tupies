# Terminal, code snippets and command approval

Bots with the **Terminal** tool group get a real shell (`terminal`) and an ad-hoc code runner (`execute_code`). A deterministic, pattern-based classifier decides which commands run without asking. It replaces the per-action model risk review for terminal and code actions, so commands no longer cost an extra inference. `shell_run`, `shell_start`, registered scripts and skill scripts keep working.

Code: `lib/terminal.mjs` (runtime), `lib/command-classifier.mjs` (classifier), `lib/command-policy.mjs` (approval policy, allowlist, routine pre-approval, integration auto reads). The Engine calls the policy from `approve()` in `lib/engine.mjs`. Tests: `test/command-classifier.test.mjs`, `test/command-policy.test.mjs`, `test/terminal.test.mjs`.

## `terminal`

`terminal {command, timeoutMs?}` runs one command line with `bash -lc` on the Engine host. The first command of a task starts in the bot's private workspace.

- **Persistent folder and exports per task.** `cd`, `export` and `unset` carry over to the task's next `terminal` and `execute_code` calls. Each task (run) has its own session; another task starts fresh in the workspace. Sessions live in Engine memory only, so a restart starts fresh. Shell functions, aliases and unexported variables do not persist.
- **Timeout** defaults to 10 minutes (600000 ms) and accepts 1000–1800000 ms. The task's own deadline still applies.
- **Output.** stdout and stderr are merged in arrival order. Long output keeps the first and last 12 KB with an explicit `… N bytes omitted …` marker (`truncated`, `omittedBytes`, `outputBytes`). A runaway producer is stopped after 64 MB (`outputLimit`). A shortened view is not a failure; a nonzero `exitCode`, `timedOut` or `outputLimit` is.
- **Result:** `{command, cwd, exitCode, durationMs, output, truncated, outputBytes, timedOut?, signal?}`. `cwd` is workspace-relative, or absolute when the session is outside the workspace.
- **Stop and cancellation.** Each command is its own process group. Stop, task failure or timeout sends TERM to the group and then KILL after 500 ms. When a command finishes, anything it left running in its group is killed too, so use `shell_start` for real background work.

**Why a wrapper per command instead of a long-lived shell.** Each call runs a fresh `bash -lc` wrapper. The wrapper restores the saved folder and exported variables, runs the command with `eval` in the same shell, and on exit writes `pwd -P` and the exported environment to a private Engine folder. Restored values travel as data in the child environment, never as sourced shell code. This approach keeps timeouts, Stop and output bounds per command. It avoids prompt or sentinel parsing and hangs on stdin. A killed or crashed command cannot corrupt the session: the last good state is kept.

The process environment is the existing curated one from `process-environment.mjs`: a per-bot engine-local HOME, no provider credentials, and Git hooks, fsmonitor, credential helpers and `ext::` disabled. A command cannot persist changes to those protective `GIT_CONFIG_*` and `PYTHONNOUSERSITE` settings. Code-injecting variables (`LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, exported functions) are never carried over. This is trusted host execution with the server account's permissions, not an OS sandbox.

## `execute_code`

`execute_code {language: "python" | "node", code, timeoutMs?}` writes the snippet to a private temporary file under the workspace's `.tmp/code/`. It runs the file with `python3` or the Engine's own Node, in the task's terminal folder and environment, under the same timeout, output and cancellation rules. The file is removed afterwards. Node snippets run as ES modules (top-level `await` works) unless they only use `require`. Use it for ad-hoc computation. Registered scripts (`scripts_register`/`scripts_run`) remain the way to keep reviewed, versioned code.

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

`decideAction` uses the stricter of the task's snapshot and the saved bot's Action review setting; an unknown setting counts as Strict. The decision is re-checked just before execution.

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
- registered `scripts_run` and `skills_run`
- `lsp_start`
- coding delegation
- team and routine changes

These effects depend on remote services, page state, registered multi-file packages or team settings that a command pattern cannot see. Terminal-family tools (`terminal`, `execute_code`, `shell_run`, `shell_start`) never reach it.

### Limits

The classifier is a best-effort policy aid. It does not resolve symlinks, does not evaluate variables or aliases, and cannot see inside programs the command runs. Approved or allowlisted programs run with the server account's permissions. The real security boundary remains the owner's choice of tool groups, the dangerous-command gate, and the process environment.
