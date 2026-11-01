# Specialist knowledge assimilation

Date: 1 November 2026. Status: native implementation, bounded semantic reconciliation and explicit procedure correction are present in mutable source; representative usefulness/scale remain separate acceptance work. The owner has subsequently authorized final testing, commit/PR, merge to main and a coordinated VPS update after development. Deployment is pending its own protected release checks; Mac/native actions are outside scope. The original target design and acceptance gates below are retained so source implementation is not mistaken for completed product acceptance.

Revision: skill-led methodology implemented against the current workspace layout, reusable Scripts catalog and native skill system. Operational engines/native installations retain their separately recorded baselines.

## Current source evidence and remaining gates

| Track | Implemented source | Remaining acceptance |
| --- | --- | --- |
| A — Skill and baseline | `tupies-learn-from-material` with five references; explicit install/assignment, immutable resource checks, source-backed schemas and deterministic miniature corpus | Human-reviewed relevance labels and actual model selection/application quality |
| B — Documents and transcripts | Learning-tab and direct-chat study admission; protected temporary staging, paged PDFs beyond 100 pages, DOCX/MD/text/VTT/SRT; bounded tool-less selection/checking, exact evidence, guarded Brain publication, Stop and current-job recovery | Three full encyclopedia scale/resource measurements and broader extraction/layout acceptance |
| C — Supported media | Accessible public YouTube captions; optional selected-model vision over fitted images/rendered PDF pages; uploaded PCM16 WAV normalized into explicit-consent OpenRouter transcription chunks; provenance/uncertainty and missing-adapter gaps | Real-provider OCR/transcription quality, inaccessible/captionless video access and video-frame interpretation; no claim that every video is readable |
| D — Reuse and corrections | Exact duplicates plus bounded model-selected Engine-offered reconciliation pairs; current-revision enrichment, full-detail same-batch synthesis, disputed same-scope conflicts and active cross-scope alternatives; explicit procedure-field correction, rollback and pending single-file Skill proposals | Reviewed real-model pair accuracy, exhaustive semantic discovery, broader multilingual paraphrases and realistic task-use evaluation |
| E — Acceptance and release | Disposable source/worker/Engine/API fixtures and deterministic evaluation; source build/checks are recorded separately in verification | Reviewed real-model/human usefulness, three real books plus ten real videos, operational rollout and native/physical-device acceptance |

The miniature deterministic evaluation admits 13 synthetic sources and retains 11 expected units. Seven of eight positive retrieval cases succeed; an unmapped Ukrainian paraphrase remains a recorded miss. The controlled provider returns fixture-labelled candidates, so this is a machinery/retention/retrieval baseline, not independent evidence that a model can learn the relevant content or perform specialist work. Reconciliation fixtures separately script semantic decisions while exercising actual guarded knowledge reads/publication. No real owner material or paid-provider evaluation is started automatically. The authorized operational rollout remains separately verified and recorded.

Current default intake limits are 20 sources, 24 MB/source, 256 MB local staging, 2000 PDF pages, 8 million extracted characters and 4096 bounded segments/source. Segments are at most 4000 characters; source workers have 256 MB V8 heaps and 25-second deadlines. The JSON admission body is 64 MB, and the browser limits selected source bytes to 42 MB for encoding headroom. These are enforced bounds, not measured three-encyclopedia capacity or latency guarantees.

Temporary source copies/full extracts and jobs stay outside workspace/history sync. Complete publication disposes of copies by default; seven-day deadline checks on normal ticks/startup clean eligible inactive failed/stopped/partial material, while explicit Keep originals retains local copies. Existing owner files are preserved. Accepted knowledge and bounded provenance/evidence can sync; source availability, live jobs and approvals remain local. Protected backups and provider retention are not securely erased by deleting intake files.

## Product outcome

An owner gives a specialist bot books, documents or videos and asks it to learn what is useful for its work. Tupies processes the material against the bot's role and learning goals, extracts supported knowledge, preserves the conditions needed to apply it, integrates it with existing knowledge and makes it available in later tasks.

The durable result is the bot's selected knowledge and proposed procedures. Full books, transcripts and source-chunk vector indexes are not the default permanent product. Temporary source processing is an implementation step. This supersedes the earlier source-library-first recommendation in this conversation.

Reference owner scenario: an SEO/GEO/ASO bot studies three encyclopedias and ten YouTube videos, retains useful principles, methods, examples and exceptions, and applies them in later audits and plans. Other specializations use the same mechanism with different relevance criteria.

Success requires three separately visible outcomes: the material was processed, useful supported knowledge was saved, and the bot can retrieve and apply it. No processing receipt alone proves expertise or exhaustive understanding.

## Learning methodology belongs in a skill

Both the rules for selecting knowledge and the workflow for studying material are reusable instructions. Put them in one native portable package, catalog ID `tupies-learn-from-material`, with a short entrypoint and focused references:

```text
lib/skills/tupies-learning/
  SKILL.md
  references/learning-rules.md
  references/documents.md
  references/video.md
  references/knowledge-template.md
  references/apply-and-correct.md
```

The entrypoint routes owner requests to the relevant references. `learning-rules.md` defines usefulness, prerequisites, exceptions, source support, duplicate/conflict decisions and correction. Document/video references describe the supported material workflow and honest capability fallbacks. The role, current project and requested learning focus are task inputs; they do not require a separate universal rules skill or a new per-bot configuration system for the first release.

Start with one package so learning rules and source workflows share one reviewed revision and do not depend on separately installed skills. Split a reference into a discoverable skill only when it has an independently useful trigger and lifecycle. Keep it self-contained: existing `tupies-knowledge-note` remains the lightweight source-backed note workflow, and `tupies-product` remains product operation/troubleshooting. Reuse their established patterns and tool semantics without changing the original package digests or requiring both to be installed. The new learning package adds role-directed selection, preserved applicability, multi-source integration and later-use checks.

| Layer | Responsibility |
| --- | --- |
| Learning skill and its references | How to choose useful knowledge, read the relevant material, preserve meaning, compare with existing knowledge and explain the result |
| Existing Engine plus narrowly added study capabilities | Actual source admission/staging, bounded reading, source/segment identities, durable progress, schema checks, guarded publication, permissions, Stop, recovery and sync |
| Brain and core Memory | Retained detailed knowledge in Brain; short owner/project facts in the existing Memory collection |
| Skills and reusable Scripts | Reviewed instructional workflows; separately useful executable programs through the current script catalog and execution guards |

The skill provides methodology; native study capabilities now supply protected intake, bounded large-source processing and checked publication. Ordinary `documents_read` remains a bounded preview reader, and a model statement alone never proves complete processing. Keep subjective learning methodology in the package rather than presenting Engine validation as proof of relevance or expertise.

Install/discover through existing `skills_search`, `skills_inspect`, `skills_install`, `skills_read` and `skills_file`. Installation follows current Ask/Trusted and Strict policies and never grants tools. The ordinary document path needs Workspace, Memory and Skills; Terminal is not a prerequisite. Missing media/native-study capabilities must be reported, not invented by the package. The source feature never assigns the learning package automatically.

For a full study job, pin the exact skill catalog/version/package digest and reference hashes with the learning-focus and inference snapshots. Retain the resolved compact methodology bytes needed for recovery. An update affects future jobs; source material or model-generated knowledge cannot rewrite the foundation learning skill. Existing generic chat checkpoints do not already guarantee this study-method snapshot.

## Target owner experience and implemented subset

1. Ask the bot to learn from supported material in direct owner chat using `study_material`, or use the Learning tab’s **Learn from material** action. Both enter the same Engine-owned flow using the explicitly installed skill revision. Ordinary attachment Send remains unchanged.
2. Select files, a video link or a transcript; optionally describe the desired application. Show the current learning focus inferred from the bot's existing role, with an editable scope such as platforms, projects, languages and exclusions. Use the existing role as the default rather than requiring another setup questionnaire.
3. Show source availability, any required processing provider and retention before Start. Start admits the exact inputs and snapshots the learning focus, learning-skill revision/resources, permissions, provider/model/reasoning and existing knowledge revisions.
4. Show actual progress: **Reading material → Selecting useful knowledge → Comparing with existing knowledge → Checking → Saving**. Display source/page/segment counts and missing material; retain Stop. Do not add a mandatory Continue step to ordinary autonomous processing.
5. Show the result: knowledge added, existing knowledge enriched, duplicates skipped, disagreements retained, procedures proposed and unprocessed sections. Explain why retained knowledge matters to this bot. New and changed Brain entries open in the current reader.
6. Later tasks recall the applicable knowledge. The owner can correct a fact, limit its applicability, reject a proposed procedure or revert an assimilation batch while protecting newer edits.

Keep the everyday interface small. Put source locators, supporting excerpts, version history, coverage and usage in expandable details. A source that produced no new relevant knowledge can complete with that explicit outcome after processing and checks; it must not claim that new knowledge was saved.

## Foundation and target integration

| Existing area | Reuse | Original addition/acceptance target |
| --- | --- | --- |
| Native skill catalog, `lib/skill-catalog.mjs`, `lib/skill-tupies-catalog.mjs` | Immutable packages, offline catalog, progressive `skills_read`/`skills_file`, existing Knowledge note and product-guide patterns | One new learning package and explicit resource allowlist; preserve existing versions and add native source-staging coverage |
| Workspace layout, `lib/workspace-layout.mjs` | Existing standard folders, `workspace_structure`, preservation-safe explicit `workspace_initialize` | Route learning artifacts to the current folders; no parallel workspace hierarchy or automatic relocation |
| Brain, `lib/brain.mjs` | Private Markdown, tags/aliases/wiki links, BM25, version hashes and guarded edits | Typed knowledge metadata, staged merge/publication, batch history, inactive-revision filtering and relevance evaluation |
| Core memory and `lib/memory-quality.mjs` | Short owner/project facts, provenance and correction semantics | Keep material-derived domain knowledge out of core memory by default; do not consume its 200-fact/20-pin capacity |
| `lib/learning.mjs`, `lib/skills.mjs` | Reviewed skill suggestions, immutable versions, stale-base checks and Undo | A material-evidence reference alongside existing readable-message evidence; a batch summary without flooding the existing 20 pending/5 skill proposal limits |
| Documents and bounded workers | Private path checks, inert parsing, existing document dependencies | A separate paged learning extractor; current preview rejects PDFs above 100 pages and `documents_read` has a 100000-character maximum without a page/range selector |
| Engine and task checkpoints | One active bot task, cancellation, inference snapshots, progress, trusted recovery | A study task with local phase checkpoints; existing direct-chat schema-2 snapshots and their 2 MB limit are not a generic study-job store |
| Reusable Scripts, `lib/scripts.mjs`, `lib/routine-workflow.mjs` | Source/README/manifest catalog, digest-bound approved runs, verified private execution copies and fixed routine references | Optional helper reuse under existing approvals; not a new script registry, source reader or study scheduler |
| Sync | Brain/workspace file replication and shared terminal presentation | Keep raw inputs, intermediate extracts and active study jobs engine-local; sync accepted knowledge and safe terminal summaries only |
| Evaluation | Disposable `eval:agent` and `eval:retrieval` runners | Role-relevant extraction, merge and application cases with reviewed evidence labels |

Selecting an ordinary attachment stores workspace bytes. Workspace files and conversation/model histories can sync. Learning must therefore use dedicated engine-local intake outside `workspaces/` and `skills/`; uploading a book normally and deleting it later does not satisfy temporary-only processing.

The current `.tmp/` folder is excluded from sync but remains model-editable workspace scratch. It is not a protected job store, permission boundary or managed retention service. Native study uses a dedicated source spool outside the workspace; ordinary attachment/history behavior still does not provide that temporary-only guarantee.

The source compatibility map now includes workspace initialization and Scripts tools. Existing immutable product-guide package bytes remain unchanged; richer Scripts/product guidance needs a separately versioned package when useful. No second capability registry or broad prompt refactor is introduced.

## Fit the existing workspace and script model

| Location or artifact | Learning use |
| --- | --- |
| `brain/` | Selected durable principles, facts, examples, exceptions and source-derived method notes |
| `notes/` | Ordinary owner-visible working notes; it syncs, so it is not the full-source/draft staging store |
| `documents/`, `data/`, `uploads/` | Existing reference originals, datasets and attachments; preserve them. Current Keep originals retains feature-owned copies locally outside these synced folders |
| `outputs/` | Optional compact learning report or requested export, with actual creation receipts |
| `scripts/<id>/` | Optional reusable code with entrypoint, README and `script.json`; use the existing Scripts catalog |
| `.tmp/` | Existing disposable model workspace scratch, excluded from sync; do not put authoritative study checkpoints or the trusted cleanup manifest here |
| Engine-local private study storage | Temporary originals/full extracts, unpublished managed drafts, phase receipts and publication/recovery journal |

Studying a method can produce a Brain note, a proposed instructional Skill, or an optional executable implementation. Those are distinct outputs. A book-derived method remains source-derived/untested until actual task evidence supports a stronger description. Generate a program only when useful to the requested work; do not automatically turn each lesson into code.

For optional code, discover with `scripts_list`/`scripts_inspect`; read all source/helper files and register exact hashes with `scripts_register`. Discovery/read/registration need Workspace; registration also requires exact approval, including Balanced. Every `scripts_run` additionally needs Terminal and its own exact execution approval. Keep the engine-prepared one-use execution identity, source/manifest/interpreter rechecks, managed process lifecycle and verified private source copy. `skills_run` likewise retains its own exact approval; packaged code is not automatically safe or authorized because a skill references it. Dependencies remain declarations until separately available and checked.

Routine script steps retain fixed `scriptId`/digest, literal arguments and fresh approval per occurrence. The current 16-step/64 KB preparation result limits and retained-result rules are not an encyclopedia-processing checkpoint system. Reuse the existing routine/script path only for a separately requested recurring workflow; the core native study worker does not require Terminal or execute bot-authored scripts.

## Durable knowledge contract

Use portable Brain Markdown as the readable content. Introduce a schema for managed knowledge and a compact engine-owned manifest binding unit IDs, content hashes, provenance and batch revisions. Frontmatter and imported text remain data, never permission or execution receipts. Existing untyped notes remain readable and searchable without automatic rewriting.

Each retained unit contains:

- Stable ID and revision; type such as principle, scoped fact, decision rule, method, example or caveat.
- A self-contained explanation and the reason it helps the bot's learning focus.
- Applicability: platform, audience, prerequisites, time/version constraints and known exclusions.
- For methods: required inputs, ordered steps, expected output and checks. For examples: whether the outcome was reported, hypothetical or actually observed by Tupies.
- Important exceptions, thresholds and dependencies; links to supporting or related knowledge.
- Source identity and revision, publication date when available, page/heading or video interval, and a small bounded supporting excerpt when necessary.
- Whether the content is directly supported by the source, a synthesis or an inference. Keep source support, project applicability and verified task outcomes as separate signals; model confidence is not proof.
- Status and lineage: candidate, active, disputed or superseded; originating batch, prior revision, correction reason and verification date.

One unit should express one reusable idea or a coherent method, including the context needed to apply it. Group related units into readable topic notes rather than creating a file per sentence or one continually compressed document for the entire specialty. Check Brain's existing 2000-note/32 MB indexed limits before publication; a capacity failure stays visible and cannot silently drop results.

Keep a compact source record after processing: title, author/channel, original URL or filename, edition/date, content digest, locators and whether the original is retained or unavailable. A digest establishes identity; it does not establish truth or permit rereading an unavailable original. A link must not pretend that discarded local bytes can still be opened.

## Native study pipeline (Release B onward)

### A. Admit and inventory

Create an engine-owned job from an authenticated owner action, with bot ID, source digests, role/focus revision, resolved learning-skill identity/reference hashes, selected provider snapshot and retention policy. Deduplicate identical admission requests. A changed learning focus or explicitly selected learning-method revision is a new processing context; the same file can legitimately yield additional knowledge later.

Build a source outline and an accounting ledger for pages or timed segments. Record each as processed, explicitly excluded with a reason, or failed. Distinguish text extraction from model inspection. A complete ledger means input accounting, not proof that every useful idea was captured.

The engine assigns segment IDs and their actual page/time spans. The model can cite supplied IDs and bounded spans, but cannot create authoritative page numbers, timestamps or source identities. Validate referenced text against the staged segment before retaining it.

### B. Read in bounded units

Read sections and their surrounding context while preserving tables, footnotes, appendices and relevant diagrams. Use a paged learning worker and bounded intermediate files. Do not increase ordinary preview limits globally or load an entire encyclopedia into `state.json`, chat history or one model request.

Each inference call must fit the actual provider/model context budget with output headroom. Intermediate structured responses are private study-job data, excluded from ordinary transcripts, provider-history sync, raw activity previews and shared checkpoints. Use the existing credentialed provider transport, pinned skill/reference methodology and Engine-owned phase schema; the distillation calls have no action tools. Report their usage in the parent task totals. Do not duplicate the skill's relevance policy in a separate hardcoded model orchestrator.

### C. Select useful knowledge

Apply the learning skill's relevance rubric to each section and extract candidates with exact support locators. It asks whether the candidate helps a current responsibility, improves a decision or procedure, supplies a prerequisite, explains a failure mode or preserves an important exception. Retain useful worked examples when they teach application. The Engine validates the resulting structure and evidence handles, not a model's subjective declaration of usefulness.

Do not discard a prerequisite merely because it is basic, assume the model permanently knows something, or use a target compression ratio as the quality criterion. Tangential material and repeated exposition can be skipped with aggregate reasons. Prompts or instructions embedded in a source cannot change the bot's role, permissions, tools or learning focus.

After section processing, perform a source-level review over the outline, candidates and coverage ledger. Reopen temporary sections when checking missing topics or cross-section dependencies. Avoid repeatedly replacing all previous knowledge with one new summary.

### D. Compare and propose a merge

Search the bot's current knowledge for each candidate. Classify the result as new, supporting an existing claim, adding a condition/example, applying in a different scope, conflicting, or irrelevant. Exact duplicate inputs must not produce duplicate active knowledge. Repeated derivative videos are not independent corroboration.

Keep differently scoped rules distinct. Preserve genuine disagreement and identify its source. A later publication date alone cannot supersede a rule; platform/version/conditions must match. Material must not silently override owner-confirmed project facts or procedures.

Produce a diff against exact Brain revisions. An external edit, sync conflict or newer owner correction invalidates the affected merge and requires rereading/recomputing it. The engine cannot treat a model-provided merge decision as authority to overwrite current files.

Current source implements this through `lib/study-reconcile.mjs`. It screens plausible neighbors lexically, reads their actual managed hashes/revisions and offers bounded pairs to the pinned model. Exact literal claims need no extra semantic inference; other requests contain at most six candidate groups and 40000 payload characters, up to three existing and three same-batch neighbors per candidate, and at most 200 reconciliation calls per study. The model selects duplicate/enrichment/conflict relations only; Engine code supplies targets/hashes and retains complete existing/new claim text, conditions, exceptions, ordered procedure fields and prior bounded evidence. Same-scope contradictions remain as reciprocal disputed units; differing scopes remain independent active alternatives. Incompatible method order or a preservation limit retains a separate linked supplement rather than truncating details. Only an actual supplement identity collision receives a deterministic bounded title suffix; its claim body remains complete. Compared read sets are rechecked at publication, including verified receipts from this study's own prior batches. Oversized/deferred/independent comparisons retain their candidates. Lexical screening and model judgments do not guarantee exhaustive semantic duplicate/conflict discovery or correct classification without representative evaluation.

### E. Check and publish

Before activation, check schema, source existence while staged, locator/quote identity, applicability fields, links, capacity, redaction and expected revisions. Use a separate bounded semantic review to look for unsupported generalizations, lost exceptions and misreported outcomes. Mechanical checks validate structure and lineage; semantic support still needs measured real-model quality and sampled human review.

Publish material-derived knowledge under ordinary Brain permissions: Balanced permits authorized private note writes; Strict requires exact approval of the concrete changes. Extracted procedures first become Brain method knowledge marked source-derived/untested. Operational Skill creation uses existing reviewed proposals and owner acceptance; edits to an assigned mutable single-file skill retain their stale-base checks. Installed package versions are immutable, so customizations become a new skill or an explicitly installed new version, not an in-place rewrite. Current `skills_propose` cannot add/edit references or scripts; initially generated procedure suggestions are self-contained single-file skills. Richer package-generation proposals are a separate future extension. Do not turn hundreds of extracted facts into core-memory proposals, generate a skill per fact or bypass proposal capacity.

Use a journaled publication manifest with stable per-operation IDs, before/after hashes and verified receipts. Staged drafts are not searchable. Managed knowledge enters recall only when its manifest marks that revision active and its content hash matches. A missing manifest, mismatched hash or incomplete sync arrival fails closed; the note cannot fall back to ordinary untyped-note indexing. Define managed-note identity compatibly with existing legacy notes in Release A. On failure, reconcile each operation with actual files; do not claim an atomic multi-file transaction that the current Brain implementation does not provide. Incomplete publication has explicit status and exact committed outputs. Preserve already committed artifacts and the previous revisions needed for guarded rollback. Mark a batch complete only after final file/link/manifest checks.

### F. Use, correct and retain only what is needed

Use existing Brain search/read and bounded dynamic recall for accepted knowledge. Add applicable methods, relevant conditions and exceptions to the current task, with deeper reads as needed. Preserve original-language terminology and useful aliases for Ukrainian questions against English-derived knowledge.

Owner correction previews now accept explicit method inputs, ordered steps, expected outputs and checks as well as explanation, scope, conditions and exceptions. Omitting method fields preserves the current procedure; changing explanation text alone does not rewrite its sequence. Method-to-Skill suggestions use the corrected current fields and still require owner review.

Begin with existing lexical retrieval. Evaluate multilingual embeddings and reranking over the distilled knowledge if measured retrieval misses justify them. Any embeddings are rebuildable derived indexes with model/version metadata. Replacing a chat model must not require learning all materials again.

Record later feedback as one of: incorrect knowledge, missing detail, wrong application, project-specific preference, or verified outcome. These produce different scoped corrections. An audit being completed does not prove that a tactic improved traffic or rankings. Only actual observations can support outcome-based experience.

## Temporary material, recovery and synchronization

- Default to temporary engine-local source copies and full extracts. Show that small evidence excerpts and distilled knowledge persist; never retain the full source under the label of notes or diagnostics. Keeping the original is an explicit optional choice.
- Ordinary file selection and source admission stay separate. A user-owned file or existing workspace attachment is never deleted by the study flow. Existing imported bot documents/notes are not migrated, erased or reprocessed automatically.
- After verified publication, dispose of feature-owned staging under the trusted intake lifecycle selected at admission. The engine janitor is restricted to exact generated staging IDs and private paths. It is not a model-accessible deletion tool and does not weaken approval-gated workspace deletes.
- Failed, stopped, review-pending or interrupted jobs retain recovery material for a documented bounded retention period, with storage usage and expiry visible. Expiry makes an unavailable source explicit; a later repair may require reattachment. Define and test exact retention defaults in Release A before enabling intake. Backups, filesystem snapshots and external provider retention are outside a claim of secure erasure; document actual handling.
- Persist local job phase, segment IDs, validated outputs, learning-skill/reference snapshot, inference/capability snapshot and publication journal. Integrate admission, execution ownership, Stop and resource accounting with Tupies Engine, including current starting/routine/compaction/closing/remote-owner reservations; do not create an independent scheduler or a second active bot run.
- Reuse the engine's recovery design through an explicitly versioned study checkpoint. Revalidate bot/provider/destination identity, permissions, staged hashes and committed revisions before resuming. Stop is durable, changed configuration cannot silently alter an active job, and denied or uncertain effects are not blindly replayed.
- Another engine can read accepted knowledge after sync, but cannot resume this engine's active study job. Switching engines shows where the job is running. The raw source, extracts, prompts and live journal do not sync.
- Synchronize compact durable knowledge provenance, current revisions and safe terminal summaries with the existing document/file mechanisms. Test note/manifest arrival order, concurrent edits and offline convergence. Source availability must be engine-specific if the owner elects to keep an original locally.
- Superseded or removed managed knowledge is excluded from default recall, search, generated summaries and vector caches. Preserve revision history in a protected namespace outside Brain's normal index, with private API access. Reverting never overwrites newer owner edits; existing deletion approval rules remain.

## Implementation map

The following narrow modules implement the source path; representative semantic accuracy, scale and application quality remain acceptance work:

| Responsibility | Current source location and integration |
| --- | --- |
| Learning rules and document/video workflows | `lib/skills/tupies-learning/SKILL.md` and five references; explicit `lib/skill-learning-catalog.mjs`/`lib/skill-catalog.mjs` loading |
| Catalog compatibility and package delivery | Existing `lib/skills.mjs` mapping, `skillPackageManifest`, immutable install/assignment, and `scripts/package-apple-engine.mjs` source allowlist; add the new package without changing prior package bytes |
| Workspace organization | Existing `lib/workspace-layout.mjs`, `workspace_structure`/`workspace_initialize` and `docs/workspaces.md`; no new directory convention |
| Study job schema, phase transitions and local persistence | `lib/study-jobs.mjs`; `lib/engine.mjs`, task checkpoint/lifecycle helpers and startup/shutdown ownership |
| Temporary source intake, manifests, paged extraction and coverage | `lib/study-sources.mjs`, `lib/study-source-worker.mjs`, `lib/study-media.mjs`; private staging, paged extraction, bounded rendering/WAV chunks and existing archive/network guards |
| Bounded structured inference and semantic checking | `lib/study-jobs.mjs` with existing provider/context-budget transport and Engine task ownership; pinned skill resources and tool-less requests |
| Bounded semantic reconciliation | `lib/study-reconcile.mjs`; lexical neighbor screening, model-selected offered pairs, Engine-built lossless merges/relations and verified current read sets |
| Knowledge schema, revisions, guarded merge and publication reconciliation | `lib/knowledge.mjs`, `lib/knowledge-paths.mjs`; Brain active-manifest guards and file-sync integration |
| Material-backed skill proposals and corrections | Extend `lib/learning.mjs` source-reference schema; preserve single-file proposal limits, immutable-package rules and existing `lib/skills.mjs` validation |
| Optional executable implementations and routine reuse | Existing `lib/scripts.mjs`, `lib/routine-workflow.mjs` and managed process path; preserve digest/argument approvals, dependency checks and sync integrity |
| Authenticated study endpoints and owner-chat admission | `lib/study-api.mjs`, `lib/api-native.mjs`, `lib/study-jobs.mjs`; Engine-owned material IDs, bot reservations and exact publication review |
| Learning focus, progress and batch results | `public/study-learning.js`/`.css`, existing `public/bot-profile.js` and chat task details |
| Evaluation | Public synthetic fixtures under `eval/`, `scripts/eval-assimilation.mjs`, existing evaluation helpers and focused `test/study-*.test.mjs`/`test/knowledge-*.test.mjs` |

Keep Tupies's own engine, provider adapters and portable skills. No Hermes backend, separately installed coding CLI, mandatory external vector database or runtime CDN is introduced by this design.

## Releases and dependencies

The source-status table above records current implementation. The scope and exit gates below remain the original target sequence, not declarations that all human/model/scale gates passed.

| Release | Scope and dependency | Exit gate |
| --- | --- | --- |
| **A — Learning skill and baseline** | One native learning package with shared rules and document/video/correction references; use existing supported read/Brain tools in owner chat; align compatibility metadata; define focus/knowledge schemas, retention contracts and reviewed fixtures | A useful small-material learning pilot and independently evaluated skill behavior; original catalog digests preserved; incomplete reads and ordinary attachment retention disclosed; no invented native study tools or Terminal requirement |
| **B — Native large-material support** | After A: temporary intake, paged extraction, skill-pinned resumable job, checking, guarded Brain publication, active-revision filtering/sync and minimal Learning UI; text PDFs, Markdown/text, DOCX and timestamped VTT/SRT transcripts | Full document/transcript learning uses A's methodology; original-source access can be disabled after publication; exact reimport is idempotent; missing/stale manifests fail closed; Stop/Strict approval/recovery are honest |
| **C — Video, scans and visual evidence** | Extend the same skill/source contracts over B: supported YouTube acquisition, authorized audio transcription, OCR and relevant slide/frame handling | Timestamp/page lineage and uncertainty survive into useful knowledge; unavailable video/captions and unprocessed visuals cannot produce full-success claims |
| **D — Reuse, methods and corrections** | Build on B's publication/revision filtering; validate C outputs too: reviewed single-file Skill proposals, typed owner feedback, guarded batch rollback and correction UI; optional existing script reuse only when requested; evaluate retrieval improvements | Correct procedures and exceptions are reused in later tasks; corrections remain scoped; immutable packages and script execution approvals remain intact; no unrelated-knowledge regression |
| **E — Acceptance and release** | B–D complete: representative three-book/ten-video workflow, resource tuning, full regressions, guide/assets/notices, actual browser and cross-engine checks | Reviewed useful-output result, complete preservation/security/lifecycle checks and a separately prepared operational rollout |

Skill authoring, independent behavioral evaluation and contract work can run in parallel against existing tools. After A, bounded source extraction and knowledge-schema/merge work can proceed independently against the fixed contracts. Video intake can proceed once B's intake/segment interfaces are stable. Final end-to-end acceptance depends on all required media paths. The native phase runner uses the same versioned methodology rather than creating a second set of learning rules.

For Release C, do not promise that every YouTube URL is readable. Distinguish an available caption track, an uploaded transcript, available authorized audio and a link with no usable content. The official captions-download API requires permission to edit the video. Pick, pin and package any transcription/OCR/media dependencies through a reviewed adapter; no arbitrary model-issued downloader commands or hidden system installs. Local and configured API processing should be separate options, with clear capability, resource and data-destination reporting.

Source bounds are set in the current implementation; benchmark source bytes/count, staged storage, pages/media duration, worker RSS/time, candidate size, publication batch size and concurrent jobs against representative real materials. Limits apply to intake, workers and individual inference calls. Ordinary autonomous work keeps its current completion semantics; optional owner-selected study cost limits stop with accurate partial status. Admission must support the 13-source reference batch within the validated limits or explain a safe partition without losing batch provenance.

## Verification and acceptance

Use synthetic/licensed public fixtures and disposable stores. Never feed private production books, transcripts, bots or accounts into regressions. Real-model evaluation is separate, explicit and usage-bounded.

Create a human-reviewed inventory of role-relevant units across multiple chapters and timed segments: principles, methods, prerequisites, numerical conditions, rare exceptions, useful examples and deliberately irrelevant content. Hold out application questions/tasks from extraction-prompt tuning. Evaluate both Ukrainian questions and English source terminology.

Initial targets below are proposed fixture release gates, not guarantees for arbitrary books:

| Dimension | Proposed acceptance |
| --- | --- |
| Input accounting | 100% of pages/segments accounted for; failed/skipped/unread portions remain visible; no partial source described as fully learned |
| Useful-knowledge coverage | At least 95% of reviewed relevant units and 100% of designated critical rules/exceptions retained; report excess irrelevant units separately |
| Support and meaning | Valid lineage for every retained unit; zero unsupported factual claims/invented outcomes in the acceptance set; preserve all designated conditions, thresholds and ordering |
| Integration | Identical reimport adds zero duplicate active units; scoped alternatives and disagreements remain distinct; stale merges and Undo cannot overwrite newer changes |
| Actual use | With originals unavailable, correctly retrieve and apply the retained knowledge on 60–100 reviewed questions and 10–20 realistic specialist tasks; publish before/after results with the same model/settings and fixture inputs |
| Isolation and lifecycle | Zero cross-bot/lane disclosures, raw-input sync leaks, permission expansion, false completion or duplicate committed effects in deterministic fault fixtures |
| Efficiency | Report learning/storage cost, discarded versus retained volume, answer latency and inference usage; select retrieval and retention settings from measured results rather than compression alone |

For application tasks, use a 0/1/2 human rubric for correctness, scope/exception handling, usefulness and honest uncertainty. Require no critical-rule violation and no regression on a held-out existing-knowledge set; publish actual distributions and missed targets. Passing recall questions alone does not establish specialist task quality.

Required adverse cases include late-chapter/footnote/table knowledge, OCR gaps, missing slides, unreliable transcripts, source instructions, hypothetical success examples, similar rules for different platforms, duplicate videos, conflicting editions, a changed learning focus or learning-package revision, concurrent Obsidian/sync edits, capacity exhaustion, Stop during each phase, crash between file write and manifest receipt, expired staging, denied approval, changed provider identity and a source that yields no useful new knowledge. Test raw-byte canaries against synced state/files/history and logs, including `notes/`, `documents/`, `data/` and `outputs/`. Verify active/superseded search behavior and source-unavailable rendering after cleanup.

Skill-specific checks must include discovery for a learning request, no accidental trigger for an ordinary answer, missing Memory/Workspace/native-study capability, an unreadable oversized document, a video link without content, and independent application of the retained knowledge. Test the core learning path with Terminal disabled. Source instructions must not create/register/run scripts, enable tools, alter the learning package or bypass review. For optional script output, cover changed source digests, incomplete sync, absent interpreter/dependencies and routine execution without a fresh approval. The study janitor must leave unrelated `.tmp/` and existing owner documents unchanged.

For runtime/provider/tool/persistence/authorization work, run the complete suite and syntax checks on the repository's verified Node 22 baseline. Skill catalog/installer/compatibility changes also require the existing skill import/catalog/engine/API regressions, unchanged prior bundle digests, exact resource packaging and independent behavioral evaluation. Include relevant workspace-layout, scripts, scripts-engine/API, routine-workflow and sync regressions when their integration changes. Run the full build when implementation lands. Exercise the real browser at desktop and phone widths for learning admission, progress, Stop, partial results, review and rollback; physical-device behavior remains separate evidence. Update `docs/memory.md`, `docs/skills.md`, `docs/workspaces.md`, `docs/routines.md`, `docs/context.md`, `docs/api.md`, `docs/security.md`, `docs/sync.md`, `docs/evaluation.md`, the roadmap and project context as each behavior actually ships.

## Release boundaries

The owner has explicitly authorized completing development, testing, committing, opening a PR, merging main and updating the VPS. This supersedes the earlier source-only release boundary. Use a concrete verified candidate and the existing coordinated rollout process: confirm live ownership/idle tasks, preserve the complete runtime, make a protected stopped backup, verify the immutable release and replacement startup, and retain exact rollback/preservation receipts. Do not stop useful active work or treat source verification as proof of deployment.

This rollout authorization does not include Mac/native builds or installations, profile/Keychain/pairing changes, deletion of existing owner material, automatic reprocessing of imported bots or automatic paid-provider evaluation. Source verification uses disposable fixtures. Record the actual VPS release after it is installed; until then its separately recorded baseline remains current.

Native source now includes the learning package, bounded document/media study and reconciliation, protected publication, explicit procedure corrections and method proposals. The full owner scenario remains a distinct acceptance task: three full encyclopedias and ten real videos, reviewed relevant-unit coverage and useful application without originals. Current fixture evidence and guarded mechanics do not establish those outcomes. Representative real-model/human quality and large-material resource measurements remain open independently of the authorized release.

## Research informing the plan

These sources informed the research discussed with the owner. They motivate design choices; their published scores are not Tupies measurements.

- [LangMem core concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/): separate factual knowledge, experience and procedures; no LangChain adoption is implied.
- [Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents): compact durable notes, relevant working context and deeper reads when needed.
- [LongMemEval, ICLR 2025](https://arxiv.org/abs/2410.10813): evaluate extraction, temporal reasoning, updates and abstention separately from retrieval alone.
- [Useful Memories Become Faulty When Continuously Updated by LLMs, 2026 preprint](https://arxiv.org/abs/2605.12978): consolidation can lose useful meaning in the tested environments; retain guarded knowledge revisions and supporting evidence rather than repeatedly overwriting all knowledge with one summary. Temporary-only source retention is the owner's product choice and requires explicit verification before disposal.
- [Sufficient Context](https://arxiv.org/abs/2411.06037): relevant retrieved content can still be insufficient for an answer; test abstention and missing knowledge.
- [Docling document representation](https://docling-project.github.io/docling/concepts/docling_document/): an example of structure/provenance-aware extraction to evaluate, not a selected runtime dependency.
- [YouTube captions download](https://developers.google.com/youtube/data/reference/rest/v3/captions/download): source-access constraints for a real video adapter.
