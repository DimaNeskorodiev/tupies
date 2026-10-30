# Coding on this Mac

Tupies can supervise an optional installed Claude Code worker while retaining the task, approvals, progress and independent verification in its own Engine. This is Mac-local work. Home-server and iPhone dispatch are deferred. Codex can be detected but is unavailable for execution until its adapter can enforce Tupies's exact terminal-command approvals.

## Start with a conversation

Enable **Coding on this Mac** for the bot. Ask it to find the relevant project and carry out the task. It first requests permission to search common project folders and Claude Code's recent project locations. It should ask a focused question when more than one project or assigned task matches. The owner does not need to provide an Azure organization, repository path and test command before that discovery.

The search is bounded to Documents, Desktop, Developer, Projects, Code and src, four directory levels and 2,500 entries. It reads only project keys from `.claude.json`, never chat transcripts. It examines repository metadata for Azure remotes and returns sanitized organization/project/repository names. It does not launch an agent, load MCP servers, copy credentials or authorize project access. Results explicitly report incomplete scans. Symlinks, special files and oversized metadata are not followed. A repository outside those locations can be selected in advanced setup.

**Settings → Coding on this Mac** provides detected agents, explicit account connection, project discovery and progress. Connecting the existing Claude account selects its configuration directory without copying credentials. The worker still receives a separate HOME and no inherited host environment. Real account reuse is checked by the actual run; configuration alone is not proof of sign-in. Separate account setup provides a copyable sign-in command. Existing app/CLI installations are optional workers, never Tupies's core runtime dependency.

## Work and verification

The bot connects the chosen repository after exact approval. The source must be a real repository root with its own `.git` directory. A job clones committed source into a separate engine-local checkout and creates a unique branch. Uncommitted changes in the source are not included, and the source checkout is not edited by the coordinator. Approved host commands still retain the user's OS permissions; this is not an OS sandbox.

Claude runs with restricted/safe startup, no project or user hooks, no plugins or MCP startup, no slash commands and a fixed tool list. Every read, edit and command requests approval of its original arguments in Tupies. A rejection stops that worker turn. Tool approval cannot alter the submitted arguments or grant persistent permissions. Stop cancels the worker and ordinary descendants. Unsupported requests fail explicitly.

The worker must return a successful protocol result and exit 0. That produces **Needs verification**, not task success. Tupies inspects a real diff against the starting commit, including commits made by the worker, and runs exact-approved independent checks. Failing checks produce **Checks failed**. Changes made during checks or after verification invalidate the evidence. **Ready for review** means the recorded independent checks passed on the recorded content; it is not a claim that every acceptance criterion, deployment or human review passed. Corrections use the same owned checkout with a new bounded worker turn, at most four attempts per job.

Worker turns have a 30-minute maximum. Delegation and independent checks share a 90-minute budget per owner turn while ordinary model work retains its own budget. Only one local coding operation can run at a time. Jobs and committed files survive interruption, but restart marks active work interrupted and never replays a command, push or work-item action. Stored process IDs are not adopted. Worker account sessions are never automatically resumed.

## Azure DevOps

The first connector uses an explicitly supplied, sealed, organization-scoped personal access token. Enter it only in the secure project settings field, never a bot message. Use the minimum required Azure scopes and a short lifetime. Existing Claude MCP credentials are not imported or reused automatically. Microsoft Entra sign-in is a future improvement.

Assigned-item queries use Azure's `@Me` and `@Project` at a recorded snapshot time. A selected work item is checked against the assignment query before use. Task text and acceptance criteria remain untrusted input, never instructions to expand access. Remote calls have fixed `dev.azure.com` destinations, bounded responses and no redirects. Azure credentials do not enter the worker environment or prompt.

For an authorized publication, Tupies prepares a commit, repeats the approved checks on that commit, pushes its new branch and creates a **draft** Azure PR linked to the work item. It verifies the returned PR and work-item link. Publication intent is persisted before external effects; a lost acknowledgement is **Unknown**, requiring inspection rather than retry. Tupies does not merge the PR, close the work item or deploy it.

## Storage and boundaries

`local-coding/` inside the engine data directory owns sealed project credentials, explicit account/executable selections, job journals, managed checkouts and dedicated process homes. This directory is not replicated or exported with bot skills. Redacted tool results and final replies included in a conversation follow normal conversation sync; they remain evidence and cannot authorize execution on another engine. Protect the local directory with the complete runtime backup. Existing-account mode references the separately installed CLI's account configuration; protect that account using its own normal backup/security practices.

Configuration/discovery HTTP routes require normal workspace authentication, CSRF/Origin checks and a proxy-aware loopback client address. Tools require the opt-in Coding group and a direct owner chat on a Mac engine. Rooms, routines and teammate delegation do not get this capability. A Mac app pairing or linked Home engine does not grant remote Mac execution.

Implementation: `lib/local-coding.mjs`, `coding-tools.mjs`, `coding-api.mjs`, `coding-discovery.mjs`, `coding-workers.mjs`, `coding-process.mjs`, `azure-devops.mjs`; UI in `public/local-coding.js` and `.css`. No new package dependency is required. See [verification](verification.md) for test scope and deployment evidence.

Primary protocol references: [Claude programmatic runs](https://code.claude.com/docs/en/headless), [Anthropic's public control-protocol implementation](https://github.com/anthropics/claude-agent-sdk-python), [Azure WIQL](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1) and [Azure draft PR creation](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1).
