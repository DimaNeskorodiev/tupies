# Tupies: better tool use, context and memory

Proposed on 28 October 2026 after the [Grok Bot 0.77.0 follow-up](../research/grok-bot-0.77.0-followup.md), then implemented in source at the owner's request. This document retains the original design/acceptance targets below; the status here supersedes their future tense. No new engine deployment or live-product superiority claim follows.

## Implementation status (28 October 2026)

- **Q0:** disposable eight-family evaluation runner, independent mechanical oracles, bounded explicit live-provider mode, source/configuration identities and unknown metrics. Fixture results test engine mechanics; real-model/Grok quality remains unmeasured.
- **Q1:** structured failures, bounded safe-read retry and failing-call recovery, mechanical outcome criteria/final rechecks, local scoped work receipts, and actual checks/activity in Recent tasks. Unknown/denied actions never enter automatic replay.
- **Q2:** model-window-bounded source chunks and merge, explicit partial coverage, source-linked exact candidate handoffs, bounded repeat compaction and verified no-write-replay recovery. Literal candidates do not guarantee understanding every natural-language constraint.
- **Q3:** task-relevant facts, truncation/coverage, trusted lane guards, additive provenance/supersession, guarded proposal/Undo metadata, bounded blended recall refresh and optional deterministic task notes. No embeddings, extra model calls for episodes, shared writable memory or automatic note consolidation.
- **Q4:** expected teammate deliverables with real checks/caveats, private workspace image reading, and the owner's chosen keyless DuckDuckGo search. Existing assigned Brave search remains an explicit approved option. DuckDuckGo follows Tupies's Node/network boundary rather than importing Hermes or lazily installing Python packages.
- **Preserved:** independent engine, exact approvals, one active owner task, private bot scopes and no restart replay. Device actions, logged-in browsing, storage rewrites and durable task orchestration remain separate decisions/tracks.

Current commands, limits and evidence are in [tool use](../tool-use.md), [context](../context.md), [memory](../memory.md), [evaluation](../evaluation.md) and [verification](../verification.md). Real-model quality gates remain explicit follow-up measurement; passing fixtures does not establish superiority over Grok.

The [completion audit](agent-quality-completion-audit-20261028.md) records additional gaps found and finished after the first implementation, including missing evaluation cases/metrics, source/privacy coverage, subtopic recall and the owner-selected SearXNG fallback. It distinguishes code completion from unmeasured real-model targets.

## Product outcome

Tupies should finish more of the owner's real tasks correctly, remember the right decisions across long conversations, and recover from problems with less intervention. Judge that by checked outputs and repeatable tasks. A tool count, a larger context window or a longer memory list cannot establish those outcomes.

The best opportunity is to connect the systems Tupies already owns: a requested outcome → relevant recalled evidence → a bounded plan → real tools → checked results → a reliable handoff → reviewed durable learning. Keep the everyday chat simple. Put detailed context and retrieval diagnostics behind an inspector.

Grok's package shows separate local-device execution, exact request mediation, submission reconciliation and a knowledge-review interface. Its server-side model loop, retrieval and compaction implementation are absent. We can improve our observed weaknesses now; an honest product comparison additionally needs matched live tasks.

## Baseline and preserved decisions

- Already shipped: model-window budgeting and summaries, history search/read, questions, image input, reliable bot-chat sends, calendar routines, a read-only browser and reviewed memory/skill proposals. Do not rebuild those phases.
- Current source has a recorded 589-test baseline; the isolated deployed Phase 5 release passed 530. This investigation reran 40 relevant deterministic tests successfully, not the complete suite or real-model quality evaluation.
- Preserve the owner's approved defaults: one active owner-chat task per bot; private workspaces and memory; read-only, logged-out browsing; interrupt unfinished work after restart without action replay. Pending-control recovery and device actions remain separate tracks.
- Keep independent direct-provider execution, exact approvals, active model/capability snapshots and sync exclusions. Memory, summaries, retrieved content, work records and teammate replies are data and cannot grant permissions.

## What the source says to fix

| Problem | Source evidence | Effect to measure |
| --- | --- | --- |
| A long history can lose important middle material before the summarizer sees it | `lib/compaction.mjs:6,32–45`: 160K-character summary input, per-message clipping, then middle elision; user quotes separately have a 24K budget | Lost requirements, exact identifiers and incomplete work after repeated compaction |
| Automatic note recall runs only at the beginning | `lib/engine.mjs:312–320,459`; `lib/brain.mjs:284–297`: at most four notes/about 4K characters | A new subtopic or paraphrase misses an existing fact even though explicit search remains available |
| Core memory favors recency after pins | `lib/agent-tools.mjs:38–46`; `lib/engine.mjs:332–335`: up to 40 facts/10K characters, 500 characters per rendered value | Relevant older facts omitted, partial facts presented without a truncation marker, superseded preferences reused |
| Completion has no task-specific outcome check | `lib/engine.mjs:526–534,652–655`: nonempty answer, no active commands, completed model plan; artifacts are revalidated for existence | A plausible answer or existing file can be marked complete while the requested result is wrong |
| General failures return only error text | `lib/engine.mjs:574–582` | Repeated bad calls, poor recovery and confusion between refusal, transient failure and an uncertain action |
| Reviewed learning is guided partly by a prompt | `lib/engine.mjs:335`; `lib/agent-tools.mjs:294–300` | Direct core-memory mutation remains possible in unattended/third-party lanes under the general permission policy |
| Teammate deliverables are unstructured | `lib/agent-tools.mjs:83,364`; `lib/engine.mjs:638–642` | A parent can miss the child's limitations or accept an incomplete required result |

These are implementation limits and test targets, not measured failure rates.

## Release Q0 — establish a quality baseline (S)

Build a small local evaluation runner, independent of the live workspace and scheduler. Suggested files: `scripts/eval-agent.mjs`, versioned cases under `eval/`, and a documented `npm run eval:agent`. Keep real-provider execution explicit and bounded; deterministic runs remain suitable for CI. Require maximum inference calls, tool calls and elapsed time per case plus a suite spend/token ceiling; reaching one records incomplete work and stops further dispatch. Record the exact source revision, provider/model/effort, permission policy, enabled tools, skill versions and fixture identities.

Start with eight task families below and three runs per real-model case. Expand difficult cases to 24 scenarios and five runs when evaluating a release. These are proposed sample sizes; publish counts and variance, and do not make a general superiority claim from a small pilot.

| Family | Seed/setup | Independent acceptance check |
| --- | --- | --- |
| Research → document | Fixed local sources, one misleading source, requested table/report | Correct cited facts, working output file, required content and arithmetic |
| Code → verify | Small private fixture with a failing test and a requested change | Actual test exit, expected behavior and no unrelated changes |
| Long conversation | Exact constraints at beginning/middle/end; force three compactions | Required values recovered with source IDs; failed actions never reported done |
| Memory correction | Old preference, later correction, conflicting imported note, paraphrased query | Latest applicable owner preference, correct provenance, no cross-lane disclosure |
| Large tools/images | Paged source plus workspace image and a stale file revision | Required evidence actually read; stale edit rejected; image result matches fixture |
| Teammate review | Specialist returns partial output and an explicit failed check | Parent preserves caveats and required failure prevents success |
| Ask/deny | Necessary missing detail and a refused action | Appropriate question, no invented answer, refusal is not bypassed |
| Lifecycle/network | Lost acceptance response, Stop, restart, uncertain external action | One admitted submission; no duplicated side effect; accurate interrupted/unknown state |

Mark unavailable capabilities separately: the workspace-image portion is an expected gap until Q4, while attachments/browser screenshots already have an image path. Missing tools and poor model use of available tools are different findings.

Record verified completion, false success, exact-constraint retention, source correctness, unauthorized changes, duplicated effects, human interventions, elapsed time, tool calls, input/output/cache tokens and reported cost when available. Publish raw timings and medians for the pilot; use p95 only with sufficient comparable samples. Missing cost/cache fields are unknown, not zero. Use deterministic fixture oracles wherever possible, then a human rubric for prose quality; a model judge is supplementary.

For Grok, use the same tasks, fresh bot setup, seeded memory/files, available tools, dates and approved actions. Retain sanitized visible traces and output hashes. Document any capability mismatch. Grok's managed model may not be selectable, so report an end-to-end product comparison separately from Tupies before/after tests with a fixed model. No account access or paid comparison run was performed in this investigation.

**Gate:** a reproducible baseline and a failure ledger, rather than a pass/fail badge based on scripted model obedience. Proposed initial product target: at least 90% verified completion on the selected ordinary tasks, with zero false-success, unauthorized mutation or duplicate-side-effect failures in deterministic fixtures. Report the actual result even if it misses the target.

## Release Q1 — accurate completion and useful recovery (M)

Extend tool results with stable error codes, an action-outcome field and bounded recovery guidance. Distinguish invalid arguments, stale revision, unavailable capability, denied action, transient read failure and unknown side-effect outcome. Preserve existing readable messages and redact all retained fields.

Detect repeated identical failed calls within a run. Require a relevant change of input/state or a new approach; do not count intentional paging or status polling as a loop. Allow bounded retries only for explicitly classified safe reads. Unknown writes, denied actions and interrupted integrations never enter an automatic retry path.

Add small outcome contracts for supported work: expected output paths/content properties, a required actual test result, required source references, and a teammate's expected deliverable. Model-extracted criteria remain candidates linked to the owner's request; they cannot prove that every natural-language requirement was captured or weaken the original request. Use deterministic validators where possible and expose what remains unverified. Validators certify only their supported mechanical properties, not arbitrary prose correctness.

Retain a bounded run-local work record: tool call/result identity, status, observed source/version/digest, produced files and pending checks. Derive action status from actual tool outcomes. Keep it local with run history; it is not a new synced task queue or authority store. Add a bounded read API/tool so later continuations can retrieve it, applying the same lane visibility rules as `session_read`; third-party Telegram records must not become visible through a general run-history reader. This supplies evidence without retaining entire tool payloads or replaying work.

Main files: `lib/engine.mjs`, `lib/agent-tools.mjs`, `lib/task-tools.mjs`, `lib/integrations.mjs`, `lib/providers.mjs`; focused result/outcome helpers as needed. Introduce fields compatibly rather than changing every tool at once.

**Gate:** zero false success or duplicated actions in the fault fixtures; a failed required check makes work visibly incomplete; a denied call stays denied; loop recovery has a bounded call/token cost. Full suite, then representative real-model tasks.

## Release Q2 — preserve the task through long context (M/L)

Start with exact-identifier/source preservation and tested transcript-retrieval fallback. Reproduce the middle-loss cases from Q0. Where they fail, replace oversized-middle elision with bounded chunk summaries and a final merge; do not add multi-call summarization to histories already handled well. Carry the previous summary, exact source message ranges and omissions explicitly. Fit every summary request to the selected model's actual budget, reserve output capacity and bound total summary calls/tokens. A summary failure must leave the full transcript and honest partial coverage intact.

Add a bounded task handoff containing requested outcome, source-linked requirements/decisions, verified results and unfinished checks. Extend existing plan/context structures where practical. Distinguish owner-confirmed statements from model-extracted candidates and tool observations. Never promote a model claim to a verified action or carry authorization from a summary. Source IDs must be validated against the current lane's readable history.

Preserve pinned requirements and exact identifiers through every compaction. Retrieve source messages when an exact detail matters. Support bounded refresh during a long task instead of relying only on the first summary attempt (`lib/engine.mjs:466–472`); retain whole-turn/tool pairing and tool-output-first trimming. Show coverage and compaction diagnostics on demand.

Main files: `lib/compaction.mjs`, `lib/context-budget.mjs`, `lib/engine.mjs`, `lib/history.mjs`, `test/compaction.test.mjs` and context fixtures. Keep stable provider cache prefixes and matching opaque-reasoning boundaries.

**Gate:** all mandatory fixture constraints/IDs survive or are correctly recovered after three compactions; zero failed actions become done; summary requests stay within budget; full transcript remains unchanged. Measure first-answer correctness, extra model calls/tokens, latency and cache effect with a real model. No unlimited summary recursion.

## Release Q3 — relevant, correctable memory (M)

First enforce a trusted lane boundary in the engine: unattended, team-room and third-party core-memory changes become proposals. Owner-chat remembering remains available under the selected permission policy. Within an owner chat, distinguishing an explicit remember request from an inferred preference still relies on prompt/review assistance unless a trusted user confirmation path is added; do not claim engine enforcement of that semantic distinction. An ambiguous request can propose, and no model-generated `ownerAsked:true` flag can authorize a write. The lane guard can ship early alongside Q1, independently of ranking work.

Add backward-compatible fact provenance: source IDs or an explicit owner-edit origin, observation/update time and supersession/conflict information. Legacy facts retain unknown provenance. Conflicting reports coexist as candidates for review; imported content never silently replaces an owner-confirmed preference. Handle sync, stale proposal acceptance and Undo together.

Rank unpinned core facts for the task after reserving essential pins. Mark truncated content and omitted pins in diagnostics. Combine scoped candidates from core facts, Markdown notes and conversation history, deduplicate, then select within a fixed token budget. Begin with lexical query expansion and existing BM25/link signals. Add optional embeddings only if evaluation proves a benefit worth their resource/privacy cost; portable Markdown remains the source of note content.

Allow bounded recall refresh after a material plan/subtopic change or compaction. Put refreshed excerpts in dynamic turn context to preserve the system cache prefix. Include source/date/version, mark partial or possibly stale excerpts, and reread exact material when needed. Do not flood every model step with retrieval or let retrieved instructions change policy.

Extend the existing daily review with opt-in episodic notes and deduplication proposals after task completion/pre-compaction. Bound retention and review volume; distinguish observations from inferred preferences. This builds on Phase 5, rather than creating a second review system.

Main files: `lib/agent-tools.mjs`, `lib/brain.mjs`, `lib/history.mjs`, `lib/learning.mjs`, `lib/engine.mjs`, `lib/sync/docs.mjs`, `public/bot-profile.js`. New fact fields require coordinated sync compatibility and migration tests.

**Gate:** zero unauthorized core writes/cross-lane reads; corrected preferences supersede old ones in fixtures; stale proposals/Undo remain guarded. Measure recall@k, precision@k, source correctness, stale-fact use, first-answer accuracy and token cost on paraphrase/multilingual/follow-up cases. Ranking changes must improve the baseline before adding a vector store.

## Release Q4 — stronger research and teammate results (M)

Add an expected deliverable to `delegate_task` and a bounded structured result with completed/partial/failed status, source/output references and unmet checks. Validate referenced artifacts through existing private-workspace boundaries; a child cannot grant the parent file access or action authority. The parent explicitly accepts or reports a missing required deliverable. Measure whether a teammate improves quality enough to justify time/tokens against the single-bot baseline.

Add a workspace-image reader through the existing bounded document/vision path and a verified web-search tool if the research fixtures show a need. Search supplies discovery candidates; fetched/read sources establish the facts. Browser screenshots already use the image-input route, but arbitrary workspace-image reading is still missing. Preserve SSRF, capability snapshots and genuine output receipts.

Main files: `lib/engine.mjs`, `lib/agent-tools.mjs`, `lib/documents.mjs`, `lib/providers.mjs`, `lib/provider-net.mjs`; a dedicated search adapter if justified.

**Gate:** no required failed child deliverable becomes completed, no fabricated/cross-bot artifact access, correct source attribution and measurable research/team benefit. Keep current bounded synchronous delegation until evidence justifies asynchronous orchestration.

## Separate tracks and release discipline

Grok's local device worker is a real capability gap. Build Tupies's paired/scoped device actions only after the pairing/signature/security prerequisites in the roadmap, with explicit readiness, per-device revocation and observed uncertain outcomes. Start from a narrow useful action; a general remote desktop is not a prerequisite for better context or memory.

Durable unanswered controls, app packaging/notifications, storage splitting and authenticated browser actions keep their existing tracks. A larger database, task queue, shared writable memory or automatic restart resume is not required by Q0–Q4.

Recommended order: **Q0 → Q1 → Q2 → Q3 → Q4**, with Q3's lane guard parallel to Q1. Reorder only from the measured failure ledger. Sizes indicate scope, not promised dates. Each release needs relevant docs/context updates, the full regression suite for engine/provider/tool/persistence changes, regenerated assets where applicable, actual-browser checks for visible changes, and real-model evaluation before a quality claim. Any deployment is a separate coordinated release preserving active work and account data.

The immediate implementable slice is Q0's eight-case baseline plus Q1's error/outcome vocabulary. It gives the next engineering work a measured reason and a concrete definition of success.
