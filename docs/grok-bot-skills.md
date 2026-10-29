# Grok Bot marketplace adaptations

The six owner-selected marketplace profiles are available as Tupies skills in mutable source. They use the same catalog, exact-version installer, assignment controls and permission rules as other skills. This source change does not update an operational engine or an installed Apple app; deployment and acceptance evidence remain in [verification](verification.md).

These are newly written Tupies workflows based on the public profiles and visible skill descriptions reviewed on **29 October 2026**. The public pages expose descriptions, preferences and skill summaries, rather than their full private playbook bodies. This is an adaptation of their published purposes, with original templates for Tupies, and does not import a Grok account, private agent state or provider entitlement. Names and source authors are credited below and in each package's `SOURCE.md`.

## Available skills

Open **Settings → Skills → Catalog**, find the title and select the bot that should receive it. **Details** shows the origin and practical capability notes before installation.

| Catalog title | Public source and author | Tupies workflow | Access and limits |
| --- | --- | --- | --- |
| dr eggbot · Tupies | [dr eggbot](https://x.ai/bot/marketplace/bots/dr-eggbot-v2), Lauren Tan | Design a bot role and instruction draft, prepare its output/acceptance checks and review an explicitly supplied workflow. | Files support the design. Bot creation, application UI generation, private transcript access and background health checks are not implied by installing the skill. |
| Projects Manager · Tupies | [Projects Manager](https://x.ai/bot/marketplace/bots/projects-manager), Eric Zakariasson | Turn a project request into deliverables, a dependency/ownership plan, bounded teammate assignments and an evidence-backed progress report. | Uses enabled collaboration with existing permitted teammates. Missing specialists, unavailable work and blockers stay explicit; no unobserved completion or automatic creation of a team. |
| SEO & AEO Desk · Tupies | [SEO & AEO Desk](https://x.ai/bot/marketplace/bots/seo-aeo-desk), Adam Tanguay | Build a search opportunity board, a writer-ready brief, an answer-question map and a page audit or comparable search report. | Starts from public pages, supplied keywords or exports. Search Console, paid keyword data and remote backlog destinations need their own connections. Missing volumes, rankings and traffic remain unknown. |
| figma bro · Tupies | [figma bro](https://x.ai/bot/marketplace/bots/figma-bro), John Bai | Prepare a frame/build specification, screen plan, component/token/motion audit, handoff or cleanup proposal. | Works from pasted/exported design data. Assigned Figma tools are optional; screenshots require a model that can inspect images. Hidden measurements and token values cannot be inferred as exact facts. |
| AI Search Visibility · Tupies | [AI Search Visibility](https://x.ai/bot/marketplace/bots/ai-search-visibility), Adam Tanguay | Keep a stable buyer-prompt panel, record answer captures, score supported recommendation/citation/mention evidence and draft a visibility brief or improvement. | Publicly observed and user-pasted captures are labeled by actual surface, date and coverage. An inaccessible or partial answer is distinct from verified absence. Login-gated assistants need supplied evidence or a separately configured tool. |
| Researchy · Tupies | [Researchy](https://x.ai/bot/marketplace/bots/researchy), Farzad | Research or fact-check a bounded question, maintain a dated claim ledger and deliver a source-backed synthesis or verified document. | Uses the bot's configured provider/model and enabled web tools. Installation supplies no Grok CLI, forced model, account sign-in or automatic approval flag. Failed search does not establish that no evidence exists. |

The core groups declared by these packages are Files for all six; Web for SEO, visibility and Researchy; and Bot collaboration for Projects Manager. **Needs setup** identifies a disabled required group. Optional external integrations are explained in the capability notes and do not block work from files or pasted evidence.

## What changes in an adaptation

Tupies Engine remains responsible for task execution, model/reasoning snapshots, permissions and cancellation. Instructions refer to native workspace/document tools and, where relevant, actual web tools and bounded collaboration. The packages do not install another agent harness or assume that the source profile's account, remembered preferences, local paths or integrations exist here.

Each package includes `SKILL.md`, its source and runtime notes, and reusable output templates. The new adaptation text and templates use the repository's MIT license; that does not relicense the original marketplace author's unpublished instructions, brand or service. Attribution identifies the source, adaptation kind and review date. The packages contain no bundled executable setup scripts.

Keep changing project/search/design records in the selected bot's private files, read the previous revision before updating them and use actual successful document creation for downloadable artifacts. A profile or skill can suggest a routine, connector or external change but cannot authorize one. Schedules remain off until the owner explicitly requests and approves the exact schedule in their timezone. Publishing, messages, remote edits and other integration effects retain exact engine approvals.

## Evidence that must stay explicit

SEO opportunity suggestions are different from measured demand. A search-volume, difficulty, position, click or citation value needs an actual source and observation period. Reports compare compatible dimensions and date windows; unavailable exports cannot be replaced with invented account data. SEO briefs guide a writer and do not silently turn into a finished published article.

AI visibility requires a real answer capture for each scored prompt/surface. A company may be recommended, cited, mentioned or absent, using the package's recorded scoring definitions. `Unavailable` and `partial` describe capture coverage and must not count as absence. Pasted answers keep their user-supplied provenance and observation date. Rates state their eligible-capture denominator, and trends compare the same prompt, surface, language and region. A Tupies web-search result is labeled with its actual provider; it is not automatically a Google results page or an AI assistant's answer.

Figma specifications distinguish values read from structured exports or assigned tools from observations of an image. Without exact design data, use unknown values or clearly marked approximations and request the missing export when it affects the handoff. Do not claim that a remote file, component or published library changed without a successful approved integration action.

Researchy uses current evidence when its task needs it, with dates and directly supporting sources. It must distinguish facts, inference and unresolved claims, and identify inaccessible evidence rather than filling gaps from model memory. No skill can promise identical results across different providers or substitute a source profile's fixed model for the owner's chosen model.

## Verification boundary

Deterministic package tests cover source attribution, retention of the original ten playbook identities, installation and exact resource reads, core-group readiness without optional integrations, and the absence of installation side effects on providers, tool grants or routines. Actual browser results belong in the source verification record; package tests alone do not establish real-model output quality, privileged account access, Figma integration behavior, live AI-surface coverage or equality with Grok Bot's private implementation.

See [Skills](skills.md) for installation/approval policies, package limits, immutable revisions and sync behavior.
