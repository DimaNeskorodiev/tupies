# Skills catalog and portable packages

The catalog, portable import and bot installation features described here are implemented in mutable source. They do not by themselves update the installed Apple apps or operational engines. Consult [verification](verification.md) for the tested source and deployment identities.

A skill is a reusable workflow: instructions and optional references, templates, assets or scripts. Tupies Engine owns its execution. Installing a skill does not install another agent runtime, create a service connection, grant a tool group, start a routine or execute code.

## Find and install a skill

Open **Settings → Skills**, the first Settings item, ahead of Models. Skills opens the **Installed** workspace library. **Catalog** contains reviewed Tupies playbooks, and the skill **Settings** tab contains preferences for the selected bot. Opening Skills from a bot profile preselects that bot.

In **Catalog**, search descriptions and examples, filter by category and choose the bot in **Install for**.

Open **Details** to inspect instructions, resource filenames, source, version, examples and requirements. **Install** adds that exact package version to the library and assigns it to the selected bot in one action. An existing identical package is reused. A bot can have at most 30 assigned skills, and the workspace can contain at most 200 skills.

The catalog ships with Tupies and works offline. Its original ten MIT-licensed playbooks each include an instruction document and reference checklist or template:

| Skill | Purpose |
| --- | --- |
| Research brief | Research a question using primary sources, a claim ledger and explicit uncertainties. |
| Document report | Create and read back an actual PDF or Office report from supplied material. |
| Spreadsheet audit | Check source data, totals and exported formula results. |
| Meeting notes to actions | Extract supported decisions, owners, deadlines and unresolved questions. |
| Project plan | Define milestones, dependencies and acceptance checks. |
| Compare options | Compare alternatives against explicit criteria and assumptions. |
| Writing editor | Improve clarity and structure while preserving meaning and voice. |
| Code review | Inspect changes and report actionable findings supported by source evidence. |
| Knowledge note | Create a source-backed, linked long-term note through the available memory tools. |
| Daily review | Organize available commitments, blockers and next actions without inventing account access. |

The catalog also includes six [Grok Bot public-profile adaptations](grok-bot-skills.md): dr eggbot, Projects Manager, SEO & AEO Desk, figma bro, AI Search Visibility and Researchy. These newly written Tupies skills credit the public source/author and include capability notes, runtime guidance and output templates. The original ten package digests are unchanged.

**Tupies product guide** (`tupies-product`) adds a native product skill for using Tupies and resolving observed errors. Search for Tupies in Catalog or through `skills_search`, inspect the package and install it for the intended bot. Its entrypoint routes to three included references: product workflows, symptom-based troubleshooting and owner/operator recovery. It covers real setup/skills/routine tools, local work receipts, provider/browser/file problems, partial teammate repair and differences between engine/native releases. It has no required extra tool groups: advice follows the current run's actual capabilities, with owner controls for unavailable actions. Installation does not enable tools, change accounts, deploy code or grant maintenance authority. These seventeen catalog entries use one-click installation and the same engine policies; none is assigned automatically. The four Markdown source files live in `lib/skills/tupies-product/` and are included in native Engine source staging.

**Learn from material** (`tupies-learn-from-material`) is the eighteenth package. Its `SKILL.md` routes to five references for learning rules, documents, video, knowledge structure, and later application/correction. Install it explicitly for the intended specialist; it is never assigned automatically. It requires Files, Memory and Skills for the native study flow, without Terminal. The original seventeen package revisions remain unchanged.

Rules for relevance, prerequisites, exceptions and integration belong in this versioned package. Engine-owned `study_material` and the Learning view enforce actual temporary intake, source identities, bounded processing, checked evidence, guarded Brain publication, Stop and restart recovery. The selected role/focus, package resources and inference choices are snapshotted for each job. Sources cannot rewrite this skill or grant capabilities. Scans use the chosen model only when it supports images; WAV transcription uses an explicitly chosen OpenRouter connection/model and consent. Accessible video captions do not establish video-frame coverage.

Learning a method first saves source-derived, untested Brain knowledge. **Propose as skill** creates a pending single-file proposal with the exact knowledge revision and source reference; accepting it remains an owner action. It does not create executable resources, register Scripts, install dependencies or authorize code execution. Semantic consolidation and real-provider usefulness remain measurement work. See [Memory and material learning](memory.md#learning-from-material-current-source).

The catalog currently has one bundled version of each playbook. It is not a live index of the Hermes, Grok or other public marketplaces. Public-profile adaptations do not import unpublished upstream playbooks, account state or service access. Catalog availability also does not guarantee that a model will choose or apply a skill correctly; evaluate actual tasks and outputs.


## Manage installed skills

**Installed** shows each package's source, version, readiness and assigned bots. Search the library, filter by category, or choose **All installed**, **Assigned to [selected bot]** or **Unassigned**. Unassigned means no bot currently uses that package; it remains in the workspace library.

Open a skill's title or **Assign to bots** to manage its assignments. The sheet lists every bot with a checkbox. Each change saves immediately through an exact request for that skill and bot; the sheet reports success or the server's refusal. The engine refuses assignment changes while the affected bot is working. Assigning another revision of the same catalog skill switches only that bot to the chosen revision. Other bots keep their assignments.

**Files & options** opens the full instructions and resource filenames, with actions to copy `SKILL.md`, download the complete portable package or remove the skill. Removal asks for confirmation, removes its bot assignments and is refused while a bot is using it. Missing package files prevent new assignments and file access; existing assignments can still be removed.

The skill **Settings** tab applies to the selected bot. It contains the installation policy described below and links to **Bot settings** and **Integrations** for tools and account access. Its version guidance explains switching and rollback; these controls do not change tool permissions or connect accounts.

## Understand readiness

Compatibility is calculated on the engine that answers the request and for the selected bot's enabled tools:

| Status | Meaning |
| --- | --- |
| Ready to use | No unsupported feature or unfulfilled declared requirement was detected by the bounded inspection. |
| Needs setup | A declared tool, binary, connection, setting or resource needs configuration or review; or a synchronized package is incomplete. |
| Unavailable here | The package declares another platform or a recognized unsupported runtime feature. |

These are conservative preflight diagnostics, not a sandbox, malware verdict or proof that an arbitrary workflow will succeed. An undeclared requirement can still fail at execution time. Binary and environment-variable requirements are reported for review; Tupies does not install dependencies, inspect the host's secret values or infer authorization from metadata.

Readiness can differ on Mac and VPS. Installing a package on one engine does not install Python modules, Node dependencies, command-line tools or account logins on the other. Browser requirements also need an available supported browser on the executing engine.

## Let a bot find and add skills

With the **Skills** tool group enabled, a bot can use:

| Tool | Behavior |
| --- | --- |
| `skills_search` | Search the bundled catalog by task or capability. |
| `skills_inspect` | Read a catalog entry's original instructions, files, requirements, version and package digest. |
| `skills_install` | Install the exact `catalogId`, `version` and `digest`, assigning it only to the calling bot. |
| `skills_list` | List the bot's assigned skills. |
| `skills_read` / `skills_file` | Read the full instructions or one reference/resource progressively. |
| `skills_run` | Execute an assigned script after approval of its exact path, interpreter and arguments. |

In **Settings → Skills → Settings**, select a bot. Under **How [bot] adds skills**, the owner chooses:

- **Ask me before installing** (`skillInstallPolicy: "ask"`, the default): installation requires exact approval.
- **Install reviewed catalog skills automatically** (`"trusted"`): Balanced bots may install a compatible exact version from the bundled reviewed catalog. Both the run's original bot snapshot and the current saved bot must allow it. Strict still requires approval.

Bots cannot supply an arbitrary URL, repository, package body, target bot or installation policy to `skills_install`. There are at most three new skill assignments through installation per run. Repeating an already assigned identical package is idempotent. Denied actions must not be retried automatically.

A successful bot installation adds only that approved assignment to its active skill snapshot. The next model step is told about the new skill; model, reasoning, tool groups, integration access and other capability snapshots stay fixed. Stop, a stale run identity, a topology change or a bot working on another engine prevents admission or commit. Owner-driven installation and assignment wait until the target bot is idle.

Installation permission does not authorize script execution, dependency installation, account connections, terminal commands, messages or other external effects. Those keep their existing engine permissions and exact approvals. Imported instructions and `allowed-tools` metadata cannot expand access.

## Learn a reusable method from completed work

A substantial ordinary owner-chat task can receive a bounded final skill review. The model must identify a useful repeatable method and cite actual successful work; trivial work and methods already covered by existing skills should be skipped. With Skills on, **Approve for me** saves one new instruction-only skill automatically through `skills_create`; **Balanced** and **Strict** create a `skills_propose` suggestion for owner review. Existing catalog installation preferences are unchanged. A new skill adds instructions, never execution permissions, scripts or dependencies.

Chat shows a linked **Skill created** acknowledgement only after the real creation succeeds. Pending proposals show **Skill suggested** and open Learning. See [reusable methods and save acknowledgements](memory.md#reusable-methods-after-a-chat-task) for review limits, source scope and lifecycle behavior.

## Import Hermes and Grok Bot skills

The portable unit is an [Agent Skills](https://agentskills.io/specification) directory:

```text
skill-name/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

`SKILL.md` starts with YAML frontmatter containing `name` and `description`, followed by Markdown instructions. References resolve from the skill root. Original instruction/resource bytes and unknown frontmatter are preserved. Tupies keeps its normalized metadata, source provenance, internal identity and package digest separately.

**Import skill** accepts one `SKILL.md`, a portable `.skill.json` export, a complete skill folder, a ZIP or a URL. A full folder can contain up to 100 regular files and 5 MB of decoded content. A standalone instruction file does not include its referenced resources. Choose the target bot, select one source and use **Preview import**. The preview lists discovered packages and requirements, with the original instructions and filenames available for inspection. Selecting **Import skill** installs one exact previewed package and assigns it to that bot. The preview belongs to the current sign-in session and selected bot, expires after five minutes and is consumed after one successful import. At most four unexpired previews are retained on an engine. Preview bytes are transient and are lost on restart.

Supported sources:

- A portable `.skill.json` created by **Download package**. The JSON must contain only `files`, with each entry containing `path` and `contentBase64`; instruction and binary resource bytes are preserved. Encoded JSON is limited to 7.1 MB and the decoded package still uses the 100-file/5 MB limit. Arbitrary JSON files are refused.
- A ZIP with one skill folder, or multiple independent skill folders selected from the preview.
- An OpenBot export using `openbot-import.json`, `format: "openbot-agent-import"`, `version: 1`, including its Grok Bot and Hermes exporter layouts. Only the listed skill folders are imported; the agent's identity, chats, memories, routines and account state are not imported by this feature.
- A public HTTPS ZIP URL or standalone `SKILL.md` URL.
- A public GitHub `tree` or `blob/.../SKILL.md` URL using a branch, tag or full 40-character commit SHA. A branch or tag is resolved once, then all folder/resource downloads use that immutable commit; the requested ref and resolved commit are recorded. Tupies uses the API and raw file endpoints without cloning or running the repository.

For example, `https://github.com/OWNER/REPO/tree/main/path/to/skill` is resolved to a commit before preview. Branch or tag names containing `/` need a link pinned to a full commit SHA; private repositories and authenticated URLs are unsupported. Standalone `SKILL.md` URLs receive a resource-coverage warning because linked files are not fetched automatically.

Remote imports use public HTTPS on port 443, require public DNS addresses and pin the admitted address for the request. Credentials, query parameters and redirects are refused. A downloaded mutable URL is installed from the inspected bytes and recorded digest; no automatic later refresh is performed. Source requests are bounded and never receive provider credentials or account cookies.

## Format and runtime boundaries

The bounded frontmatter reader supports ordinary quoted, scalar, folded and literal descriptions, plus a conservative subset of nested/list metadata. It recognizes declarations such as platforms, required tools/toolsets, binaries, environment-variable names and configuration requirements. It is not a complete YAML evaluator; aliases, tags and unsupported relevant structures require review. Descriptions can contain up to 1024 characters; the root instruction document is limited to 100,000 JavaScript characters.

The legacy `POST /api/skills` endpoint remains available for existing clients: it imports a local slug-named skill to the library without assigning it or adding the managed immutable-package manifest. New store imports use the preview/install pipeline above.

The inspected portable flow also accepts printable human-readable skill names up to 80 characters, as used by some export workflows. The original name and bytes stay intact; a separate safe internal identity prevents collisions. This tolerance is a compatibility feature, not a claim that such names conform to the base Agent Skills naming rules.

Hermes-specific Python imports, `${HERMES_HOME}`, `hermes setup`, inline shell expansion and automatic setup/hooks are not executed by importing a package. Recognized unsupported features produce diagnostics. A Hermes workflow that depends on its OAuth or runtime needs adaptation to Tupies integrations. Grok Bot support means reading portable/exported skill folders; it does not claim a published native Grok Bot package API or direct connection to its private marketplace. Grok Build/CLI is a separate product and its format extensions are not proof of Grok Bot runtime compatibility.

An imported code resource is stored as data. `skills_run` supports Node, Python and Bash scripts through explicit interpreters. Dependencies must already be available on that engine. Execution uses the Tupies OS account and is trusted host execution, **not an OS sandbox**. File/path controls around package import do not confine an approved script's access to the host or network.

## Package validation and limits

Inspected imports reject path traversal, absolute paths, control characters, duplicate or case-conflicting paths, file/directory collisions, symlinks and special files. Credential/private-key filenames, Git metadata, dependency trees and nested archives are refused. File extensions are not a complete secret detector; review instructions and resources before sharing or importing them.

| Limit | Value |
| --- | --- |
| Selected skill package | 100 files / 5,000,000 decoded bytes |
| ZIP input | 10,000,000 bytes |
| ZIP directory | 2,000 entries |
| Total ZIP expansion | 20,000,000 bytes, with bounded per-entry expansion and compression ratio |
| Individual skill resource read | 250,000 bytes, without paging |
| Import preview | 45-second preparation deadline, four in-flight/retained slots, 40 MB retained package bytes |
| Workspace / bot assignment | 200 skills / 30 assigned skills |

ZIP local and central headers, sizes, CRC checksums and entry ranges are validated before installation. Oversized exported skills must be reduced or imported as an intentionally prepared smaller package; Tupies does not silently omit resources to pass a limit.

## Versions, customization and sync

Catalog and inspected imports create immutable package revisions. The package digest covers sorted filenames, exact sizes and per-file SHA-256 hashes. Storage identity includes source and content, so same-named skills from different sources do not overwrite one another. Installation stages regular files and atomically publishes the package before committing the assignment. An unregistered existing target directory is not overwritten.

There is no automatic update from upstream. If a later bundled catalog release supplies a new revision, installing it switches only the selected bot's assignment from the previous revision of that catalog entry. Older revisions remain in **Installed**. To roll back, open **Assign to bots** on the older installed revision and select the affected bot; this replaces its current assignment for the same catalog entry. Other bots retain their chosen revisions. Imported packages have separate identities; review and remove an older assignment explicitly when changing those workflows.

Immutable installed packages cannot be rewritten through Learning. To customize one, create a separate new skill with a new name using reviewed `skills_create` or `skills_propose`. Existing learned/local skills retain their reviewed editing behavior. Deleting a package removes its assignments and is refused while a bot is using it.

Skill metadata and regular files already participate in trusted engine sync. Before a managed package is read, exported or assigned, every listed file must match the manifest. A partial or modified replica remains unavailable until all required bytes arrive correctly. Live runs, approvals, processes, dependency installations and engine-local process homes do not sync. Preserve the complete runtime tree when backing up; see [sync](sync.md) and [operations](operations.md).

## Implementation map

- `lib/skill-catalog.mjs`: bundled original playbooks and canonical manifest hashing.
- `lib/skill-import.mjs`: bounded portable parser, metadata diagnostics, ZIP/export reader and public pinned-source fetcher.
- `lib/skills.mjs`: compatibility, exact-version installation, immutable identities, assignment and integrity gates.
- `server.mjs`: authenticated catalog/import/assignment endpoints and session-bound transient previews.
- `lib/agent-tools.mjs` / `lib/engine.mjs`: discovery tools, approval decisions and the narrow active-run assignment update.
- `public/skills-store.js` / `.css`: Installed library, per-bot assignment sheets, Catalog, import review and skill Settings.

The browser and bot tools call the same installer. See [API](api.md#skills-rooms-and-routines), [tool permissions](security.md) and the current [verification evidence](verification.md).
