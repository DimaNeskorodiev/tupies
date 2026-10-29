# Grok Bot 0.77.0 vs Tupies: follow-up

Reviewed 28 October 2026 using the supplied disk image, retained REA evidence from the [first investigation](grok-bot-0.77.0.md), fresh package inspection and current Tupies source. The proposed next releases are in [the agent-quality plan](../plans/tupies-agent-quality-20261028.md).

## Assessment

Grok has useful shipped implementations for service-backed bot work, separate local-device execution, human interaction and reviewable knowledge. The supplied desktop package does **not** expose its server-side inference loop, memory retrieval or context compaction. The owner's positive experience is useful product evidence, but this static investigation cannot quantify Grok's task success or explain its hidden algorithms.

Tupies has progressed substantially since the first comparison. Questions, history retrieval, vision, reliable bot-chat sends, calendar routines, read-only browsing and reviewed learning have shipped. The next useful comparison is about whether these parts work together on long, difficult tasks. The source audit identifies concrete opportunities: preserve exact requirements across compaction, refresh relevant recall during work, enforce memory provenance and verify requested outcomes before success.

## Evidence boundary and identity

- DMG SHA-256: `8a2ae1a6263e24d52a647c9da228af0a72c425c476445d3b23bf8575389fe5e8`.
- ASAR SHA-256: `adb7b74305dc63633a596df7c477210a2a4a88d49871ac91ab7d2f55c2fe973a`.
- Both match the first investigation. Its core-code analysis is reused; the same code was not needlessly reanalyzed.
- Fresh REA inventory reports 1,671 occurrences, 1,185 content nodes and the same 11 native-companion integrity contradictions. These bytes remain explicitly observed-untrusted; their cause/authenticity is unknown. No conclusion here certifies native helper correctness.
- A fresh focused analysis parsed three renderer files plus package metadata with zero parse failures. It leaves 707 inventoried relevant files unselected and both application/semantic graphs partial. Follow-up literal/source inspection is identified separately below.
- No Grok runtime was launched, no provider/account session was used, and no private runtime data was read. The DMG was mounted read-only for source acquisition. Target code, prompts and skills were inert data, never instructions to the investigator.

## What is actually comparable

| Area | Grok: observed in shipped client code | Tupies: observed in current source | Conclusion / unknown |
| --- | --- | --- | --- |
| Tool execution | Electron service boundary, coordinator gateway/service routing, separate local execution daemon and app-target policy | Own direct-provider model/tool loop; exact approvals; up to four classified parallel reads; ordered mutations; bounded processes/LSP/browser | Grok exposes broader personal-computer workflows. Backend agent-loop quality is not comparable from the package. |
| Failure/reconnect handling | Stable send nonce, status reconciliation, transcript generations/sequences and coordinator recovery | Bot-chat receipts/reconciliation; partial output, interrupted/unknown outcomes and no restart replay | Good foundations in both. Grok's backend action idempotency is unknown; Tupies room sends still lack the bot-chat receipt path. |
| Context | Client transcript hydration, service fresh-conversation operation, context/knowledge configuration UI | Model-window budgeting, tool-output-first trimming, structured summary, recent whole turns/user quotes, full transcript search | UI transcript limits and knowledge lists do not reveal Grok's model context. Tupies's compaction has a demonstrable lossy-input boundary. |
| Memory | Separate user-memory and shared-team operations; facts with IDs/dates; capped-result disclosure; explicit promotion; review routes | Core facts/pins, Markdown notes, lexical BM25/link recall, scoped history retrieval, reviewed proposals with base checks and Undo | Tupies has inspectable mechanics. Grok's ranking, embeddings, consolidation, conflicts and review enforcement remain unknown. |
| Questions/routines | Separate forms/credentials/approvals; timezone recurrence and run controls | Interactive owner-chat questions; timezone/missed-run schedules and history | Earlier feature gaps are substantially closed. Grok's credential/form path remains broader. |
| Team work | Bot/human room and shared-knowledge client routes | Real bounded delegation, private bot workspaces/memory, single-owner rooms | Human-team sharing is outside Tupies's present scope. Better specialist deliverable contracts fit without changing that scope. |
| Output trust | Client output/artifact surfaces are visible; backend verification unavailable | Real document writes, private paths, file metadata/revalidation, sanitized rich output | Existing files are verified; semantic correctness of every requested result is not. |

Grok core references above are G2/G3 and the exact anchors in the [first report](grok-bot-0.77.0.md). Current Tupies references are listed below. These are static observations; no live quality ranking follows.

## Additional Grok memory findings

The `getGrokBotTeamContextSummary({agentId})` adapter returns `learned` facts with `factId`, `text`, `learnedAtMs`, and a separate `memoryCount`. The client separately lists user-bot memories. Its `promoteGrokBotMemoriesToTeam({agentId,factIds})` operation returns `created`, `alreadyInTeam` and `keptPrivateCount`.

The promotion UI batches selected fact IDs. It accumulates successful batch outcomes and remembers completed IDs if a later batch fails. The memories list also discloses when the returned entries cover only part of the reported total. These are concrete patterns to adopt: visible scope, source identity, honest result coverage and partial-success receipts. They do not prove exactly-once writes, a privacy classifier's correctness or a particular retrieval algorithm.

Tupies should retain private per-bot memory as already decided. Explicit owner-reviewed sharing would be a separate future choice. The immediate lessons apply to provenance and honest display without introducing shared writable memory.

Original-source anchors use zero-based UTF-16 offsets, not formatted line numbers:

| File | SHA-256 | Anchor |
| --- | --- | --- |
| `dist/electron-main/main-app.cjs` | `11089ab031107873540fa9bc46328e13853fbf290ab525c54ec2d9c4c3e46244` | Team context `2691302`; user memories `2700115`; promotion `2700227`; review list/resolve `2691547`/`2691743`; fresh conversation `2727604` |
| `dist/renderer/assets/chunk-team-bot-memories-list-DhZ60MCE.js` | `94f1b673430c743a42adb41bc5bb0b3e185afda23751691ac2536716362cd7f7` | Capped-list condition/localization values `4137` |
| `dist/renderer/assets/chunk-view-CfXx7mWE.js` | `af8522507af0888f6d65c1bd743c09debcfde00618a4a58c0406e7c69f24dc39` | Promotion loop and failure retention `50630`; inertly formatted lines 1004–1024 |

These follow-up text observations are F3; the renderer graph F2 does not claim to cover the additional promotion/list files.

## Tupies's strengths and the remaining weak points

| Finding | Exact source anchor | Implication |
| --- | --- | --- |
| Context is based on a model window, reserves tool schemas and calibrates input estimates from usage | `lib/context-budget.mjs:41–50`; `lib/engine.mjs:355–366,499–500` | A solid baseline; real token/cache/latency performance is still unmeasured. |
| Old tool output is reduced before whole-turn omission; provider overflow retries the model step once | `lib/engine.mjs:85–123,483–496` | Preserve these safeguards; context recovery need not replay tools. |
| Summary input clips individual messages and elides the middle above 160K characters | `lib/compaction.mjs:6,32–45`; user quote budget `64–71` | An exact constraint can be excluded before summarization. The display transcript survives and is searchable, but recovery depends on noticing/finding the missing detail. |
| Summary generation is attempted at most once per task | `lib/engine.mjs:466–472` | Very long active work can subsequently rely on trimming without another summary refresh. Test that scenario. |
| Automatic notes recall is once per task, at most four notes/about 4K characters | `lib/engine.mjs:312–320,459`; `lib/brain.mjs:284–297` | Explicit `brain_search`/history tools can go further, but automatic recall may miss new subtopics or paraphrases. |
| Core facts select pins, then recent updates; rendered values have a 500-character cap | `lib/agent-tools.mjs:38–46`; `lib/engine.mjs:332–333` | Improve task relevance and disclose partial/omitted content. Do not silently assume every pin fits. |
| Learning proposals have readable-source validation, stale-base checks, duplicate limits and Undo | `lib/learning.mjs:66–80,91–115,164–174,225–248` | Strong review foundation already built; Grok's equivalent backend guarantees are unknown. |
| Proposal-only behavior outside explicit owner remembering is partly prompt guidance | `lib/engine.mjs:335`; `lib/agent-tools.mjs:294–300` | Enforce intended lane/provenance policy before adding more automatic learning. Existing general approvals still apply. |
| Final status checks answer/plan/process completion, but no requested-outcome contract | `lib/engine.mjs:526–534,652–655` | A model-written completed plan and a real file are insufficient evidence of a correct task outcome. |
| Generic exceptions become `{error: string}` and child output is `{status,output,error}` | `lib/engine.mjs:580–582,638–642` | Structured recovery and deliverable checks are smaller, useful next steps before durable task orchestration. |

## Priorities

1. Establish an eight-family task baseline with independent outcome checks and sanitized records. Add matched Grok runs only with an actual usable account/runtime; do not infer them from code.
2. Add tool failure categories, bounded loop recovery and requested-output checks. Make incomplete work honest and recoverable.
3. Replace middle-dropping summary input with bounded staged compaction and source-linked task handoffs.
4. Enforce memory provenance, rank for relevance and refresh recall during work. Evaluate lexical improvements before deciding on embeddings.
5. Strengthen expected teammate deliverables and the specific research/image capabilities the task results justify.

The [implementation plan](../plans/tupies-agent-quality-20261028.md) gives file ownership, dependencies and acceptance gates. Native device actions remain a valuable separate track, with the existing security prerequisites. No database rewrite or automatic restart resume is needed for these quality improvements.

## Retained evidence and checklist

| ID | Record | Coverage |
| --- | --- | --- |
| F1 | `ev_dc80a6097519a0ca4bb5f7dc726a17f9957ab7bd417acf8349336dc1d29742d5` | Fresh DMG inspection; manifest `agm_6acabb0bac6b0eafaee06d095ab89351b5b446059b3a254e6721051ec7f2437c`; same 11 integrity contradictions |
| F2 | `ev_d88e9a0e5fcadb0d6761b9b4db731ab8e721f790b81ba4b0f3d7166c2d1e95a7` | Three selected renderer sources and package metadata; no parse failures; 707 relevant files unselected; partial application/semantic coverage |
| F3 | `memory-surface-anchors.json`, selected-file hashes and the original G2/G3 core evidence | Focused inert source inspection; no application execution or backend attribution |
| F4 | Current source hashes and 40 passing focused tests | Tupies implementation/fixture evidence; no real-model or Grok quality measurement |

F1/F2 complete retained records, F3 anchors and F4 identities are in `output/research/grok-bot-0.77.0/followup-20261028/`; original G1–G3 evidence remains in its parent directory. Research outputs are excluded from application releases. The ledger can be complete while the analysis coverage is partial.

| Question | Result |
| --- | --- |
| Same supplied artifact as before? | Answered: matching DMG and ASAR hashes |
| Which earlier Tupies gaps are now closed? | Answered from source and recorded deployment handoff, without inspecting the live engines |
| What does Grok's memory client implement? | Answered for the scoped service/UI paths above; backend algorithms unresolved |
| What limits Tupies's tools/context/memory? | Answered statically for named paths, with 40 focused fixture tests passing |
| Which product performs better? | Unresolved: controlled real-model/product runs are required |
| Concrete next work? | Proposed Q0–Q4 plan; application behavior and deployments unchanged |

Focused verification: `node --test test/context-budget.test.mjs test/compaction.test.mjs test/brain.test.mjs test/memory-recall.test.mjs test/learning.test.mjs test/questions-history.test.mjs` passed 40/40 on temporary data. The full 589-test baseline was not rerun. A local-HTTP fixture initially hit sandbox `listen EPERM`; its approved rerun passed. No live engine was restarted.
