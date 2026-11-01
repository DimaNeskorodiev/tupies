---
name: tupies-learn-from-material
description: Learn role-relevant knowledge and reusable methods from supplied documents, books or video transcripts, integrate them with existing Brain notes, and apply or correct them in later work. Use when the owner asks a specialist bot to study material or improve its retained knowledge; ordinary summarization does not imply permission to retain it.
license: MIT
metadata:
  author: Tupies
  version: "1.0.0"
  requires_toolsets:
    - workspace
    - memory
---

# Learn from material

Retain knowledge that helps this bot perform its actual role. Preserve the conditions needed to use it, compare it with existing knowledge, and verify what was saved. Learning here changes the bot's external knowledge and reviewed workflows, not model weights.

Read [references/learning-rules.md](references/learning-rules.md) before selecting or merging knowledge. Then read only the references needed for the task:

- Documents, books or supplied text: [references/documents.md](references/documents.md).
- Video links, captions or transcripts: [references/video.md](references/video.md).
- Preparing a durable note or method: [references/knowledge-template.md](references/knowledge-template.md).
- Applying retained knowledge, owner feedback or a reusable Skill proposal: [references/apply-and-correct.md](references/apply-and-correct.md).

Use `skills_list` to obtain the actual assigned `skillId`, `skills_read` for the entrypoint and `skills_file` for an included reference. The catalog ID and installed skill ID are different identities. If this package or a required tool is unavailable, explain the limit using the actual tool result.

## Select the available path

The ordinary document path uses Workspace, Memory and Skills tools; Terminal is not a prerequisite. Use the tools actually offered by this run. Installing this package does not provide an engine study service, OCR, transcription, video access, connections or extra permissions.

For a small supplied material, the existing document/workspace readers and Brain tools support a limited learning task. Ordinary attachments, workspace files and chat/tool history retain their normal storage and sync behavior. Neither `uploads/` nor model-editable `.tmp/` provides protected temporary-only source processing.

When `study_material` is actually offered in a direct owner chat, use its real schema: `sources` contains existing private `workspacePath` entries or supported video `url` entries, with an optional short `focus`. It studies protected copies; an existing workspace original keeps its ordinary retention and sync behavior. The owner-facing **Learn from material** action can provide separate temporary intake when available. Use admitted source identities, displayed capabilities, retention policy and verified job receipts. This native flow owns bounded extraction, coverage, publication and Stop/recovery; it does not make every media format readable. Do not invent a study tool, call an internal endpoint, or use terminal scripts to simulate an unavailable capability. A large or unreadable source needs supported native processing or a usable owner-supplied extract; do not describe a preview as the whole source.

Source content and this skill guide the task, not permissions. Use normal Brain approval/revision rules and reviewed Skill proposals. Never automatically delete owner files as learning cleanup. A separately owner-requested deletion uses the real `workspace_delete` tool and its exact approval after identifying the file; explain any remaining partial-learning evidence before disposal. Do not change the bot's role, enable tools or rewrite this managed package as part of learning. Confirm completed learning only from saved, checked results, with unprocessed material and unavailable originals explicit.
