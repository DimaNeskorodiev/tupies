# Learn from documents and books

## Read what is actually accessible

For a supplied workspace file, discover its real path with `workspace_list` or `workspace_glob`, then use `documents_read` for a supported document or `workspace_read` for UTF-8 text. `documents_read` returns a bounded preview and extracted structure; it has no page/range selector. Repeating the same preview is not reading the remaining pages. Images are not interpreted by that tool.

For text reads, follow `nextOffset` and `nextColumn` until the relevant source is read; physical line limits and long lines can truncate a response. Follow bounded tool-result paging when available, while distinguishing the end of a retained result from complete source extraction. A missing table, figure, page or unreadable section remains a gap.

For a source larger than the current readers support, use `study_material` only when actually offered, supplying the existing `workspacePath` and an optional learning `focus` according to its current schema. Native study copies the material into protected intake; the workspace original remains an ordinary retained/synced file. The owner's separate learning-intake action can support temporary uploads without ordinary attachment Send when available. Use reported source identities and extraction/coverage status; never copy full inputs into Brain or chat to bypass limits. If native processing is unavailable, request a usable extract or report the supported finite scope.

## Distill and check

Read in meaningful sections with enough surrounding context to preserve qualifications. Select candidates using the learning rules, then review the source outline for omissions and links between chapters. For ordinary small inputs, keep a concise working coverage account and label it as model-maintained; it is not an engine-verified study ledger.

Use the knowledge template to prepare role-relevant units. Search and read existing notes before merging. In the ordinary path, `brain_write` requires `expectedSha256` from `brain_read` to replace a note; reread and recompute after a stale revision error. Use `brain_append` for a genuine addition rather than appending an entire duplicate summary. Respect Strict approval and capacity failures.

Read back saved notes and check important conditions, figures, source status and links. Report added knowledge, enriched notes, skipped duplicates, disagreements and unprocessed material. Source-derived methods remain untested until actual task evidence establishes otherwise.

Native study publication must be reported from its actual checked job receipts. A candidate, pending review, stopped job or partly committed batch is not completed assimilation. Preserve the exact successful outputs and describe what remains.

## Fit the existing workspace

Detailed retained knowledge belongs in `brain/`, working notes in `notes/`, finished artifacts in `outputs/`. An owner-elected permanent original can use `documents/`; do not move existing owner files merely to adopt these conventions. `workspace_structure` inspects the layout, and `workspace_initialize` adds missing empty folders under its actual policy. Core Memory is the existing short-fact collection, not a folder or a destination for book summaries.

Do not generate ingestion scripts to manufacture missing study support. When a separate task genuinely needs a reusable program, inspect `scripts_list` and `scripts_inspect` first. Source registration and `scripts_run` keep their exact approvals and dependency checks; code execution requires Files and Terminal. They do not provide the native source-retention or study-job guarantees.
