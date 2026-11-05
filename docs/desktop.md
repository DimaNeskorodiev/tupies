# Desktop actions on this Mac

**Action review update (5 November 2026, source only):** In a direct owner chat, Approve for me can independently review an exact launch/input and continue without a manual prompt for ordinary requested work. Balanced/Strict retain manual review. Owner app/bot setup, frozen driver/app scope, fresh target/draft checks, result verification, denial/unknown receipts and Stop remain required. Dangerous or unresolved effects ask the owner. The historical installation receipts below predate this source change. See [security](security.md#approve-for-me).

Tupies Engine can read and operate explicitly assigned Mac applications through the optional `agent-desktop` 1.1.0 driver (JSON protocol 2.6). Tupies owns task admission, approvals, cancellation, result checks and recovery. The driver has no model and is not Tupies’s inference backend. Ordinary provider, API/MCP and browser work does not require it.

## Local installation checkpoint

The maintainer Mac Engine has the verified driver connected with Desktop disabled and no assigned applications or bots. Choose access explicitly in the settings below. This preserves existing bot permissions. The source remains usable on other Macs through the optional verified installer; remote execution and real Codex/model task quality need separate acceptance. See [verification](verification.md) for the frozen installed-source, backup/restore and native synthetic-app receipts.

## Setup

Use the local Mac engine. In **Settings → Desktop on this Mac**, select the absolute executable, enable Desktop, and name the applications and bots allowed to use them. Enable **Desktop on this Mac** in each selected bot’s Tools. Both the saved task snapshot and the current bot configuration must allow access. Engine admission freezes the allowed application IDs and pinned driver identity in its local journal. Enabling Desktop, assigning another application or replacing the driver applies only to a new task; continuations keep their original scope. Existing bots receive no new capability automatically.

The verified installer currently supports Apple Silicon. Download the official [agent-desktop 1.1.0 arm64 archive](https://github.com/vercel-labs/agent-desktop/releases/download/v1.1.0/agent-desktop-v1.1.0-aarch64-apple-darwin.tar.gz), then run the operator-only offline installer with a new destination directory:

```sh
node scripts/install-desktop-driver.mjs --archive /absolute/path/to/archive.tar.gz --destination /absolute/path/to/new-driver-directory
```

The installer verifies the pinned official archive SHA-256 before extracting exactly the driver and its helper. It does not overwrite an existing destination or download or execute code. Keep `agent-desktop-macos-helper` beside the executable. Configuration pins the hashes and file identities of both files; reconnect after a reviewed replacement. This optional native executable is not installed through a model tool or runtime CDN, and no installed Codex/Hermes CLI is required for desktop actions.

The Mac must be unlocked and have an available graphical user session. A granted permission does not make a locked desktop controllable; inaccessible windows must be inspected after unlocking, without replaying input.

**Check permissions** reports the actual macOS permission state. Grant Accessibility in System Settings to the responsible hosting application and, when macOS identifies it separately, the driver executable. Screen Recording is needed for optional screenshots. Tupies cannot grant itself these OS permissions. Status is readiness evidence, not proof that a particular application exposes usable controls.

## Task flow

- `desktop_status` lists only this bot’s locally assigned applications. Prefer the existing assigned REST/MCP integration when it supports the requested direct operation.
- `desktop_launch` requests exact owner approval to launch one assigned application, without arbitrary startup arguments. Verify that an application window exists before further work.
- `desktop_observe` first lists the application’s windows. Select an exact `windowId`, then read its Accessibility tree. Window, menu, menubar, sheet, popover and alert surfaces are supported. Returned references belong to one fresh observation and task.
- `desktop_action` performs one reviewed action: click, focus, type/set-value, select, expand/collapse, scroll or a bounded key combination. The confirmation binds the application, window, target, original field contents, literal input, delivery mode and expected result. A fresh pre-dispatch observation must match. Physical input requires an explicit `headed` request shown in the confirmation; semantic input is the default.
- `desktop_verify` reads the window or specified resulting surface and checks the original expected condition. A condition cannot be weakened after input. Focus changes have their own `focused` condition; application activation/focus telemetry does not count as general UI progress. Exact field content is required for text input; an existing owner draft must match the reviewed `expectedValue`. A changed window verifies only a UI change, not message delivery or the entire owner goal.

For “create a new Codex chat in Tupies and send this text”, verify the new chat/project selection, exact composer contents, and then a newly present sent message in the conversation. Do not treat the text still in the composer, a successful script exit, a model assertion or worker completion as successful sending. Preserve other drafts. Unsupported or ambiguous controls require inspection or owner assistance.

Input targets Accessibility refs; unexposed or purely canvas controls are refused rather than clicked through arbitrary coordinates or shell scripts.

Screenshots are optional on `desktop_observe`, only with current and saved Files access and a vision-capable model. They capture the selected application window, are bounded, and are refused on overlay surfaces or when the observation includes a private field. Returned images are verified private PNG files, not model-invented artifact links. Screen content remains untrusted task data.

## Bounds and recovery

Only one task may own this engine’s Mac desktop at a time. The desktop episode has a 15-minute maximum, 60 actions and 120 observations. Repeated returns to the same semantic UI state stop the task even if snapshot IDs or proposed scripts differ. Six Desktop tool failures without a verified result also stop it; changing invalid arguments cannot evade that guard. Runtime/read/action bounds are fatal to the episode rather than another endlessly retried tool error. These limits are separate from ordinary chat’s autonomous execution policy.

Actions always use the existing exact manual Engine approval path, including under Approve for me. A new snapshot cannot bypass a denied target/action. Protected fields are removed from model observations and cannot receive model input. Passwords, codes and private sign-in remain owner work. Generic shell execution keeps its existing exact approvals; imported skills cannot supply a missing `computer_use` capability or authorize an alternative route around a refusal.

Every action writes an engine-local intent receipt before input dispatch. Delivery and result verification are separate states. Failed or lost post-input capture requires fresh inspection, without repeating input. Stop cancels the task’s driver processes; it cannot undo already delivered input. Unverified/uncertain action receipts survive task end and restart. No process, observation, ref or old window handle is adopted automatically, and a task with interrupted desktop work cannot automatically recover into new input. Its original task cannot report verified completion.

The engine-local `desktop/` directory contains configuration, pinned executable identities, bounded action receipts and the driver’s separate process home. It is not workspace sync data. Include it with the complete protected runtime backup. Protect plaintext UI observations/images as conversation/workspace content; do not publish raw desktop traces.

## Direct actions and scope

Existing `integration_list` / `integration_call` provide the direct REST/MCP route, and Terminal provides exact-reviewed host CLI execution. Desktop tools supplement those paths. The optional supervised coding subsystem remains separate: its Codex worker is still refused until its adapter can enforce the required exact terminal-action approvals. Codex App Server thread creation is not by itself proof of a chat in the selected desktop app project; no unsupported RPC or private app endpoint is assumed here.

This first desktop version is local Mac only, in direct owner chats. Rooms, routines, delegated bots and Missions do not receive desktop tools. A linked Home/VPS engine or paired iPhone does not acquire Mac execution authority. Remote device-worker dispatch is a separate future capability. This feature does not replace Tupies Engine with Codex or Hermes.

## Verification

`test/desktop.test.mjs`, `desktop-driver.test.mjs`, `desktop-engine.test.mjs`, `desktop-api.test.mjs` and `desktop-ui.test.mjs` cover input identity, drafts, private fields, stale views, denial, current/snapshot permissions, Stop, unknown delivery, restart, no-progress bounds, HTTP security and setup UI races on disposable data. The native driver archive/real JSON protocol is checked separately from scripted UI behavior. Actual installed-app Accessibility, Electron controls and real-model task quality require their own acceptance; synthetic tests are not that evidence.

See [upstream driver documentation](https://agent-browser.dev/desktop), [local coding](local-coding.md), [security](security.md) and [verification](verification.md).
