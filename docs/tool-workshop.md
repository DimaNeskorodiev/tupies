# Tool workshop and product improvements

Tool workshop is an optional, owner-enabled capability. In a bot’s Settings, enable **Tool workshop**. Existing bots keep their settings; Manage Tupies, imported skills, packages and delegated messages cannot enable it. The bot’s **Workshop** tab shows locally verified tools, the shared catalog count and a local improvement inbox. No Terminal access is required.

## Autonomous local tools

The bot discovers `workshop_list`, reuses an exact shared package with `workshop_install`, or creates one with `workshop_build`. A package contains a stable id, title, description, a synchronous JavaScript function expression `input => output`, and 1–8 synthetic input/expected test cases. Every test must pass before registration. Source, descriptions and tests form a SHA-256 identity. Registration creates an immutable Engine-local package; changing code or tests creates a different revision.

`workshop_run` selects an exact verified digest and JSON input. Optional `files` names up to eight UTF-8 files in the bot’s own workspace; this additionally requires Files in both the active snapshot and current bot permissions. With files, the function receives `{data: input, files: {"relative/path": "contents"}}`. Each file is limited to 32 KiB and the total serialized input to 64 KiB. Paths retain the ordinary workspace/symlink restrictions. No other files are mounted. Results are JSON, not automatically saved files or artifact cards. Use ordinary workspace/document tools to save and verify outputs; Strict continues to require approval for those writes.

Execution uses pinned QuickJS compiled to WebAssembly inside a fresh Node worker. Guest code never executes through Node eval, `node:vm`, a shell or the host JavaScript context. No host callbacks, module loader, WASI, filesystem, network, environment, credentials or package manager are exposed. Node's worker is for lifecycle containment; the guest language/Wasm boundary provides code isolation. Runtime dependencies are product-controlled, not installed by the bot. There is no fallback to host execution.

Limits: 32 KiB source, 16 MiB guest heap, 256 KiB guest stack, two seconds per guest evaluation, eight seconds total wall time per worker, 64 KiB JSON result and two concurrent workers per Engine process. The parent kills a stalled worker; Stop waits for termination. Serialization/getters execute within guest limits. The host worker has additional V8 heap limits, but these are not a claim of a complete operating-system memory quota. Package tests use fresh guests. Synthetic author tests demonstrate those cases only, not universal correctness, usefulness or security. Runtime/Wasm dependencies still require security updates.

Balanced permits build/install/proposal storage automatically **only with the separate owner-enabled Workshop capability**. Strict requires exact approval for those operations. Pure computation does not require another approval. Existing scripts, Terminal, API/MCP and browser policies remain unchanged. Run capabilities remain snapshotted and Workshop revocation is checked against current bot settings. No package can add permissions or change the running Engine.

This implementation supports synchronous JavaScript and JSON/text transformations, including the Engine-mediated API reads below. Python, npm imports, binary/media adapters, economic actions and long-lived workers are not included. The separate Engine workshop below prepares source candidates without modifying running Engine source.

## Controlled API reads (stage 2, source only)

Enable **Tool workshop** and **Integrations** for the bot, then assign an owner-configured REST integration with a fixed GET action and parameter schema. The bot discovers eligible actions with `workshop_sources`. MCP tools and POST/PUT/PATCH/DELETE actions are excluded, even if their descriptions call them read-only. A remote GET can still have side effects or account charges; every call requires **Allow once** in both Balanced and Strict.

`workshop_read_api` composes one approved request with an existing tested package:

```json
{
  "digest": "<exact verified package SHA-256>",
  "integrationId": "<assigned integration id>",
  "tool": "<configured GET action name>",
  "arguments": {"symbol": "TEST"},
  "input": {"scale": 2}
}
```

The package receives `{data: input, response: API_JSON}`. For example, `x => x.response.price * x.data.scale` can be tested locally with `{data:{scale:2},response:{price:3}}`, expecting `6`, before any network call. Tests use synthetic data; they never call the API. Only `arguments` become URL query parameters. Local `input`, package source and tests are not sent. The guest receives neither authentication headers nor host callbacks; it cannot perform another request. Engine injects credentials using the existing integration transport and redacts known credentials from the response before guest processing and from the output afterwards. Redaction is not a universal detector of private API data.

Approval binds the bot, exact package digest, input, parameters, action schema, method/path, integration endpoint/name and credential fingerprint. The owner sees the endpoint and exact call arguments in the existing approval flow. Configuration or credential changes invalidate that review. Both the task snapshot and current bot must retain Workshop, Integrations and the assignment. Engine checks them before dispatch, after the response and after computation; revocation discards an unfinished result. It cannot undo a request already received by the remote service.

Limits are one request, 8 KiB serialized parameters, 16 KiB local input, 64 KiB network response, 64 KiB combined guest input and a 20-second network deadline; the usual guest limits then apply. The response must be finite JSON; SSE and malformed/oversized responses fail. Existing pinned-DNS, SSRF, credential-destination and no-redirect checks apply, including the operator's existing private-network policy. The bot cannot select an arbitrary URL, header, method or secret. Stop aborts the request or guest. The Engine does not classify this as an automatically retryable read: uncertain external outcomes retain the normal recovery protection and successful effects retain their ordinary task receipt.

`verifiedExecution` proves that the approved response was processed, not that its contents are true, fresh or profitable. Output remains untrusted data and creates no artifact until saved using normal tools. Source discovery creates no grant, and a package or exported contribution carries no connection configuration, runtime API input or standing authorization. The same generic transform can be reviewed into the shared catalog and reused with each owner's separately configured API.

The single-read gateway remains exact-approved per call. The bounded-read workflow below implements the first part of stage 3. Financial budgets, external writes and transactions still need action-specific adapters. See the five-stage plan in [Roadmap](roadmap.md#isolated-extension-work-1-november-2026).

## Bounded autonomous reads (stage 3 foundation, source only)

`workshop_poll_api` takes the same arguments as `workshop_read_api`, but requests a fresh observation on each explicit tool invocation. The first invocation opens the ordinary approval card. **Allow once** still permits only that action. To allow a series, expand **Allow a bounded series of reads**, choose the limits and participants, then press **Allow bounded reads**. Model messages, teammates, package contents and API replies cannot create or enlarge a grant.

The owner selects 1–100 requests, an expiry of 1–60 minutes, a minimum interval of 0–60 seconds and up to 20 permitted bots including the requester. The entire root task and its explicitly selected descendants share one counter and interval; delegation does not multiply the budget. Selecting a participant grants no new tools, integration assignment or private workspace access. Every participant needs the exact tested package locally and both Workshop and Integrations in its own current settings and active snapshot. Selecting another bot does not authorize its unrelated tasks.

The scope fixes the integration endpoint/credential/action/schema, exact package digest, API parameters and local transform input. It does not permit varying a query, selecting another endpoint or generating request bodies. A changed scope requires new exact review. Current permissions and configuration are still checked around each API/guest invocation. Each call remains bounded by the stage-2 network and guest limits; only one request per grant can be in flight. The first read counts toward the selected total.

Before dispatch, Engine atomically records a reservation in `data/workshop-grants.json`, outside workspaces and sync. Only an owner decision on the current approval identity can prepare and activate a grant; pending records authorize nothing. Failures, Stop and uncertain results consume the reserved slot without refund and block further use. Failure to save a receipt also blocks the grant in the current process. A repeated tool-call identity cannot be dispatched twice. Reads are not automatically retried. A denied ordinary read revokes a matching task-family grant and cannot be bypassed through the polling alias.

The ledger contains bounded scope hashes, endpoint/package metadata, selected bot/run identities, counts, deadlines and attempt statuses; it does not copy API inputs, responses, credentials or transcripts. It retains at most 128 records within 2 MB, pruning inactive history when needed, with at most 32 active/pending grants. Atomic replacement prevents partial records; malformed or symlinked storage fails closed. This uses the Engine's existing single-owner data-directory assumption, not an OS sandbox or cross-process distributed lock.

In **Bot → Workshop → Bounded API reads**, inspect the shared count and expiry, refresh status or revoke an exact grant. Revocation aborts an in-flight invocation and prevents later dispatch; it cannot undo a request already received by the API. The root task ending or stopping removes authority, and an Engine restart never reactivates old grants, even if the same task safely recovers. Existing receipts remain inspectable. A blocked/exhausted grant is not silently renewed; a fresh task and owner review can establish new authority, or an ordinary read can use its normal exact approval.

This is a **request budget, not a monetary spending limit**. A service may charge for GETs; Engine has no trusted price feed or billing verifier for arbitrary APIs. This stage does not authorize payments, trading, POST/PUT/PATCH/DELETE, messages, deployment or other external writes. Those remain behind their existing exact approvals and need action-specific bounds, outcome verification and uncertain-effect handling before autonomous grants can cover them. The five-stage roadmap therefore marks stage 3 as partially implemented.

## Improvement inbox and sharing

### Engine source candidates (stage 4, source only)

Enable **Engine workshop** separately in Settings → Tools. It is off by default, independent of Tool workshop, Files and Terminal. Bots cannot enable it for themselves or teammates. Both the active task snapshot and current settings must allow it; disabling the bot or capability prevents publication of unfinished work. Balanced permits local candidates; Strict asks for exact approval of candidate creation.

`engine_source_list {prefix?,offset?}` lists up to 64 installed source paths with SHA-256 hashes. `engine_source_read {path,sha256,offset?}` reads up to 16,000 characters; follow `nextOffset` until null. The allowlist covers `server.mjs`, `package.json`, `.mjs` modules under `lib/`, `.test.mjs` files under `test/`, top-level JS/CSS in `public/`, and six explicitly named public context/development documents. Installed payloads may omit tests/docs. Hidden files, runtime data, `.env`, private local handoff documents, dependencies, arbitrary host paths and symlinks are excluded. A configured runtime directory nested inside the source tree is also excluded, as are nested `node_modules` directories. Files are capped at 512 KiB and directory scans are bounded. Known credentials are refused; source still needs privacy review before sharing.

`engine_candidate_build` takes `title`, `summary`, `changes`, `dependencies` and `tests`. Supply 1–4 distinct changes `{path,sha256,oldText,newText}`. Existing files require their exact listed hash and an `oldText` occurring exactly once. New allowed files use `sha256:null` and `oldText:""`; their parent source directory must already exist. Add up to eight exact `{path,sha256}` dependencies for pure tests. Up to eight tests use `{path,exportName,input,expected}`, calling a named synchronous export of an edited JS module with one JSON argument. Limits: 40 KB request, 8 KiB input/expected pair, 1 MiB selected source snapshot and 60 KB generated diff. Prefer focused replacements over whole large modules.

Engine copies selected bytes into memory, applies exact replacements and checks changed files. Fixed `node --input-type=module --check` parses JavaScript via stdin without executing candidate code, resolving imports, loading project configuration or inheriting `NODE_OPTIONS`. JSON is parsed; CSS/Markdown receive text checks only. Pure tests execute actual candidate modules in QuickJS/Wasm with a loader restricted to selected in-memory source. No Node APIs, packages, filesystem, network or credentials are available. Each test has a 16 MiB guest heap, two-second CPU deadline and eight-second wall limit; two candidate check jobs may run concurrently. Stop terminates checks. Empty `tests` means **no behavioral tests**. Modules requiring Node APIs or external packages cannot run in this guest.

After checks, Engine rechecks base hashes and current access, retains an immutable candidate under `data/workshop/<bot-id>/candidates/` and adds an Engine proposal to **Workshop → Product improvements**. Candidate records retain selected changed/dependency source and evidence: at most 16 records of 2 MB each per bot. They do not sync or carry execution authority. Failed checks create no accepted proposal. Cancellation/storage failure after candidate retention can leave an unaccepted candidate, never an installation. Records share the complete runtime backup boundary.

Export includes the proposal, exact edit/test request, base hashes and diff. It does **not** automatically export the full retained source snapshot, other source files, runtime data, logs or transcripts. Author-supplied edits/tests still need privacy and redistribution review. Legacy `improvement_propose` Engine patches remain unexecuted claims; models cannot attach trusted check results through that tool.

On a matching source checkout, independently reconstruct and check a contribution without applying it:

```sh
node scripts/review-contribution.mjs contribution.json --check-engine REVIEWED_SHA256
```

The command validates schema/base hashes, re-runs syntax and pure-module checks and requires the resulting diff to match. Imported verification is not trusted; changed bases fail rather than silently rebasing. Successful checks still report `fullSuite:false` and `build:false`. Full Engine execution, dependency tests and build/release/rollback require a separately reviewed, appropriately isolated checkout and the normal release workflow. No candidate hot-patches the running process, runs install hooks, submits a PR or deploys itself. Stage 4 is partial. An operator-only container verifier is implemented below, but actual container acceptance and automatic bot dispatch remain pending.

## Operator container verification (source only)

`scripts/verify-engine-candidate.mjs` adds a separate, explicit maintainer path for full candidate regression/build checks. It is **not** a bot tool, HTTP endpoint or scheduler. Installing Tupies does not install Docker, grant access to a Docker socket or enable this path. The existing in-Engine candidate checks remain syntax/pure-module checks only.

Prepare `Dockerfile.engine-verifier` from a **reviewed clean source checkout**, never a running Engine directory, account copy or personal development directory. The dedicated ignore file includes product source/tests/assets and excludes runtime/dependencies/private local handoff paths, but does not replace reviewing the context for private files. Image preparation deliberately downloads the pinned Node base, OS packages and locked npm dependencies; candidate jobs never install dependencies or pull/build images. Record the resulting local image ID, source revision and preparation evidence. Rebuild/review the image when its baseline or dependencies change.

For an already configured local Docker runtime, preparation is a deliberate operator operation:

```sh
docker --host unix:///ABSOLUTE/LOCAL/docker.sock build -f Dockerfile.engine-verifier -t tupies-engine-verifier:reviewed .
docker --host unix:///ABSOLUTE/LOCAL/docker.sock image inspect --format '{{.Id}}' tupies-engine-verifier:reviewed
```

Use the printed **full `sha256:…` image ID**, not the tag. Review the exported contribution and its printed SHA from `review-contribution.mjs`. First inspect an inert plan:

```sh
node scripts/verify-engine-candidate.mjs contribution.json \
  --reviewed REVIEWED_PROPOSAL_SHA256 \
  --image sha256:FULL_LOCAL_IMAGE_ID \
  --docker /ABSOLUTE/PATH/TO/docker \
  --socket /ABSOLUTE/LOCAL/docker.sock
```

Add `--run --output NEW_RECEIPT.json` to start one job. The receipt path must be new; it is written with mode 0600. Planning never contacts Docker. Execution uses a temporary Docker configuration containing only the pinned seccomp profile and a minimal environment, an explicit local Unix socket, and no inherited contexts, TLS credentials or remote daemon address. Docker must report Linux with seccomp and rootless/user-namespace isolation, or Docker Desktop. Missing runtime, image or isolation fails closed; there is no host execution fallback.

The fixed policy requests a non-root UID, read-only image, dropped capabilities, no-new-privileges, a hash-pinned Moby-derived seccomp profile for Chromium namespaces, no external network, no host bind mounts/volumes, 4 GiB memory without extra swap, two CPUs, 512 processes and a 20-minute execution deadline. Daemon log storage is disabled with Docker’s [`none` logging driver](https://docs.docker.com/engine/logging/configure/); only bounded attached output enters the receipt. Private shared memory is capped at 256 MiB. Writable storage is temporary `/work`, `/tmp` and `/dev/shm`; it disappears with the container. The runner independently checks Linux seccomp/no-new-privileges, cgroup-v2 memory/CPU/process limits and absence of external interfaces. Hosts without those controls are refused. See Docker's [runtime options](https://docs.docker.com/reference/cli/docker/container/run/), [seccomp policy](https://docs.docker.com/engine/security/seccomp/) and [rootless mode](https://docs.docker.com/engine/security/rootless/).

The fixed [seccomp profile](../assets/engine-verifier/README.md) adds only clone, setns, unshare and chroot to the pinned Moby baseline for Chromium’s nested user-namespace sandbox. The verifier hashes the shipped bytes and checks Docker’s installed profile; no caller-selected or unconfined profile is accepted. These namespace syscalls are also available to candidate processes and remain part of the reviewed kernel attack surface.

The immutable image runner reconstructs the exact contribution against the image baseline, rechecks its generated diff and only then copies source/dependencies to temporary storage. It refuses `package.json` edits; dependency/npm-script changes require a separate reviewed image. Fixed steps are syntax checks, the four timing-sensitive regression files sequentially, the remaining test files (including nested candidate tests) at concurrency four, and the complete web-only product build. Test skips/cancellations/TODOs, missing summaries, failing steps or changed checked source prevent a passing receipt. Source stability covers JS/JSON under `lib`, `test`, `scripts`, root server/package files and every selected candidate source/dependency. It is a mutation check, not comprehensive integrity attestation. No generated artifacts are copied back or automatically adopted.

Receipts bind the proposal digest, pinned image, random job ID, requested policy, bounded per-step logs and final container state. Stop/timeouts do not retry work. Cleanup uses the exact job label and container ID; uncertain cleanup clears success and requires operator inspection of that job. A hard host crash can leave an orphan container: do not rerun blindly or use broad Docker prune commands. Inspect only the recorded `dev.tupies.verifier-job` identity and remove the matching verifier container. If the host dies before writing a receipt, locate the corresponding `tupies-verify-…` container and check its label/image first.

Treat all contributed code, tests and logs as untrusted. Candidate processes share the guest UID with the supervisor; a hostile candidate can interfere with guest results. A passing receipt is diagnostic evidence from an isolated job, **not** a security certificate or proof of semantic correctness, and never grants installation/publication authority. Independent source/test review and normal release verification remain necessary.

Current acceptance: deterministic protocol/kernel-policy fixtures and ordinary host regressions are available. Docker/Podman is absent on the development Mac, so **no image build, real container job, escape probe or Linux full-suite acceptance has been performed for this runner**. Chromium's sandbox must remain enabled; if the fixed container policy cannot run it, the job fails and needs reviewed platform work, not an automatic `--no-sandbox` fallback. Automatic bot dispatch stays disabled pending actual isolation/resource/cancellation/cleanup and full build acceptance.

`improvement_propose` saves either:

- A verified tool’s complete package, exact digest and synthetic-test evidence.
- An Engine unified diff, summary and author validation notes. These patches are inert and explicitly unverified; they are never applied or executed by the inbox.

Packages and proposals live under `data/workshop/<bot-id>/`, outside model-editable files and workspace sync. Each bot has at most 64 packages and 64 proposals. They are included in complete runtime backups. They remain on the executing engine across restarts; interrupted builds do not receive a successful registration. Existing task recovery rules retain Stop and uncertain-effect handling. There is no automatic publication, telemetry, central upload or sync of execution grants.

In **Bot → Workshop → Product improvements**, select **Review proposal**, inspect its complete source/fixtures and select **Export reviewed source**. The API binds export to the exact reviewed digest and explicit inclusion of source. The JSON bundle contains no automatically collected chat, run inputs, runtime logs, account identities or local source paths. However, source, patches, descriptions and test fixtures are author-supplied and may themselves contain private information or copyrighted material. Known-credential rejection is a guard, not a complete privacy detector; the owner reviews suitability and permission to share before sending the file. Export downloads locally and does not transmit to the product maintainer.

## Maintainer intake and shared product catalog

A maintainer receives an owner-selected `tupies-contribution-v1` JSON file through their chosen channel. Inspect its exact identity with:

```sh
node scripts/review-contribution.mjs /path/to/contribution.json
```

Review the complete source and fixtures, generic usefulness, provenance and redistribution permission. Tool contributions can then be added to this source checkout using the printed digest:

```sh
node scripts/review-contribution.mjs /path/to/contribution.json --accept-tool REVIEWED_SHA256
```

The command validates hashes and schema, independently re-runs tests in the isolated runtime and exclusively creates `assets/tool-catalog/<id>.json`. It never overwrites a catalog id, imports credentials, applies patches or runs host code. Updating an existing id requires normal source review. Treat supplied test expectations as untrusted claims and add independent tests where needed. Engine patches go through ordinary repository review, appropriate full regression checks and release preparation; the command refuses to apply them.

Ship the reviewed catalog with the product source and built assets. After a normal product release, other users’ Workshop-enabled bots discover it with `workshop_list` and install the exact revision after local re-testing. This is the reuse path that avoids each user rebuilding the same utility. A hosted contribution service and automatic distribution outside releases are not implemented.

## API and verification

Authenticated owner routes:

- `GET /api/bots/:id/workshop`: local tools, shared catalog and proposal summaries.
- `GET /api/bots/:id/workshop/:digest`: exact package source and evidence.
- `GET /api/bots/:id/improvements[/:digest]`: inbox or exact proposal.
- `POST /api/bots/:id/improvements/:digest`: local export, with `{digest, reviewedDigest: digest, includeSource: true}` and normal CSRF/Origin checks.
- `GET /api/bots/:id/workshop-grants`: bounded-read grant metadata and attempt receipts for this bot; the ordinary Workshop response also includes `grants`.
- `POST /api/bots/:id/workshop-grants/:grantId/revoke`: revoke the exact grant with an empty JSON object and normal CSRF/Origin checks.

Grant creation is only an existing task-approval control, with its exact `runId`, `remoteRunId`, `request_id`, `execution_generation`, `choice: "bounded-read"` and `grant: {maxRequests, minutes, intervalSeconds, botIds}`. Other tools cannot accept that choice. There is no free-standing grant-creation endpoint or model tool.

There is no owner HTTP endpoint that executes guest code. Execution remains in admitted Engine tasks. `test/workshop*.test.mjs` covers guest boundary probes, resource limits, cancellation, versions, synthetic checks, scope/revocation, Strict approval, API security and export privacy boundaries. See `docs/verification.md` for actual release evidence and platform limits.
