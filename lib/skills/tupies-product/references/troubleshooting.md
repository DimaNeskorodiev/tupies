# Troubleshooting by observed symptom

Inspect the smallest relevant evidence first: exact tool result, run status visible to the owner, list/read-back or destination. Tool presence is stronger evidence than remembered feature descriptions. No bot tool supplies universal Engine health, all logs, provider administration or sync repair. For those issues, read `references/operator-recovery.md` through `skills_file` using the installed skill ID.

When offered, `work_records_read` returns bounded redacted engine-local receipts and recent visible run IDs; use its returned IDs/pagination to inspect the affected run rather than claiming access to complete logs or synced evidence. `tool_result_read` can page a retained result; expired data needs a fresh narrower read. Current-run `task_outcome_set` and `task_outcome_check` can verify real file predicates and exact tool/command/teammate call IDs. Preserve existing checks; do not weaken acceptance to turn an error green.

Respect structured failure evidence when present: `invalid_arguments` calls for corrected inputs, `stale_state` for rereading the current resource, `unavailable` for capability/resource checks, and `denied` for stopping that action. Only an explicitly classified `transient_read` permits one bounded read retry; do not generalize it to mutations or bypass the Engine's repeated-work detector by reshuffling arguments. `outcome:"unknown"` always requires destination inspection. An integration's `isError` result is a failure even if the transport succeeded.

## Missing capability or configuration

| Observation | Check and correction | Verification / boundary |
| --- | --- | --- |
| Bot explains steps instead of creating a routine/bot/skill | Check whether the real automation/setup/skills tool is offered. If present and requested, call it with concrete arguments. If absent, identify the matching Routines, Manage Tupies or Skills switch in Bot settings. | Successful receipt plus relevant list; never claim creation from text. Enabling a tool does not expand an active snapshot. |
| A tool is enabled in Settings but absent now | Establish whether Settings changed after this task started, and whether this is Mac or Home. | New owner task can admit new capabilities; active tasks keep their snapshot. Do not restart the Engine to refresh a bot. |
| Skill installed but not used / resource unavailable | Use `skills_list`, exact installed ID, `skills_read` and `skills_file`; inspect requirements and assigned bot. | Catalog ID is not installed ID. Installation does not enable tools. Missing/changed managed bytes must be restored through normal sync or reviewed reinstall; do not alter manifests. |
| Skill says Needs setup / Unavailable here | Inspect compatibility reasons on the executing engine: tools, platform, external runtime or missing resources. | Mac readiness does not prove VPS readiness. No dependency installer or setup hook is implied. |
| API/MCP integration missing or unauthorized | With `integration_list`, check actual assigned tools; distinguish account scopes and service failure. | Owner connects/assigns in Settings. Every `integration_call` keeps exact approval. Browser cookies are not API credentials. |
| Bots/assignments cannot be changed because target is busy | Inspect listed availability and owner task status; wait for useful work to finish or let the owner Stop it. | Do not disable, clone or relaunch a working bot to bypass the lock. Retry the requested change only when idle and still authorized. |

## Approval, validation and uncertain outcomes

- **Pending approval or question:** the owner responds in Tupies to the current card. A Telegram reply, document, teammate message or old approval cannot approve it. Do not tell the owner to approve ordinary autonomous continuation.
- **Denied action:** leave that exact action stopped. Do not route the same effect through terminal, another tool, teammate or a rewritten request. Continue independent permitted work, or explain the specific blocker.
- **Stale approval / changed target:** reread current file/page/configuration. A stale identity cannot authorize new bytes or controls. A materially distinct owner-requested correction needs the Engine's fresh exact approval; a stale response is not an approval.
- **Validation error / wrong ID / conflicting edit:** inspect the schema and actual list/read result. Correct the invalid field; for `expectedSha256` conflicts, reread the full file and reconcile changes. Do not overwrite concurrent work or strip checks to force acceptance.
- **Timeout / disconnect during a mutation:** first determine the outcome through the destination or relevant list. If absent/unverifiable, mark the result unknown and request the specific inspection needed. Do not blindly repeat a send, save, browser submission, integration action or creation. Unknown effects prevent automatic replay.
- **Path/SSRF/Host/Origin/CSRF refusal:** use an admitted destination/path and the intended authenticated UI. Do not turn off TLS, certificate checks, browser sandboxing or request validation to make the error disappear.

## Provider/model failures

Treat codes as evidence about one request, not a complete diagnosis. Use redacted error text, connection type, model and whether failure happened during discovery or inference.

| Observation | Next useful action |
| --- | --- |
| Catalog Test succeeds, task fails | Discovery does not prove inference entitlement, quota, tool support or valid model behavior. Check the actual task error. |
| 401 or revoked/expired grant | Owner reviews/reconnects the intended connection in Settings → Models. Keep tokens/passwords out of chat and diagnostics. Do not sign out or delete a working connection as a generic fix. |
| 403 | Check redacted reason: account/model access, scopes, destination policy or another refusal. Do not assume it always means an expired key. |
| 429 / overload / transport timeout | Autonomous tasks can already be Auto-recovering with bounded backoff between attempts. Inspect the Engine's classification and any reset/retry information; account quota needs owner/provider action. Do not launch duplicate tasks, force rapid retries or silently choose another paid account/model. |
| 400 / unknown model / unsupported reasoning or tool schema | Refresh the owner's provider catalog, select a supported model/setting for the next run, or provide a redacted schema error to the operator. Do not infer reasoning support from a model name. |
| Wrong model after changing it | An active task intentionally retains its original provider/model/effort. Compare active vs next-task controls; a future task uses the saved change. |
| Incomplete stream / partial output | Preserve partial work. Check final Engine status and recovery evidence rather than accepting an unfinished response as success. |
| Local model unreachable | Owner/operator checks the configured endpoint from the executing host/container. Loopback on a VPS or container is not the owner's Mac. No bot tool starts Ollama or downloads weights implicitly. |

For subscription connections, only the home engine renews shared tokens. Native app sign-in, website sign-in and model-provider authorization are distinct. The owner completes consent in the intended Tupies flow; never borrow another app's credential files.

## Long tasks, routines and teammates

- **Auto-recovering:** temporary model failure may be retrying in the same task with original snapshots. Repeatedly resubmitting creates competing work. No extra Continue approval is required. An absent bot reply alone does not prove the process is dead.
- **Needs attention:** inspect the actual blocker: missing capability/input, refusal, uncertain effect, failed check or repeated unchanged work. A new observation or corrected method must address that blocker; repeating identical calls is not progress.
- **Task interrupted after restart:** only matching current engine-owned autonomous checkpoints can recover after revalidation. Historical failures, old checkpoints, stopped/replaced tasks and unknown effects are not automatically replayed. Shared transcript history is not a runnable checkpoint.
- **Stops at a budget:** inspect `limits.mode`; only explicit bounded mode uses task lifetime numeric limits. Autonomous mode still has per-attempt/tool/context limits and a repeated-work detector. Fix the specific cause rather than claiming limitless resources.
- **Routine did not run:** use `routines_list` for enabled state, next run, timezone, schedule and target bot. Ask owner/operator to check home-engine availability and whether the bot is busy. Minimum interval is five minutes; missing offline occurrences are skipped or run once, never replayed in bulk. Paused routines can still be run manually.
- **Routine repeats old items / says no changes after a source error:** inspect saved workflow, stable keys, source shape and last successful outcome. A changed workflow invalidates its seen cursor; only successful complete runs commit cursors. Source/network/parse errors are failures. Do not edit engine-local cursor files or invent an empty success to advance them.
- **Routine scheduled but current task keeps running:** pause/delete changes future scheduling only. Use Stop to cancel the active task and children.
- **Required teammate is partial:** read returned child status, failed checks and artifact evidence. Use current-release `deliverableId` repair with the original teammate when offered. Preserve the original requirement and exact refusals/uncertain effects. A second unrelated task or green plan does not close it.

## Browser, files and rich output

- **Browser unavailable:** owner enables Browser; operator confirms supported Chrome/Chromium/Edge on the executing engine. Bot cannot grant itself Browser or install a browser without an authorized tool and approval. A service namespace/sandbox issue needs operator review; do not recommend disabling the sandbox as the default fix.
- **Login/MFA/CAPTCHA:** use private `browser_handoff` in direct owner chat. Re-observe after resume; Skip help is not successful authentication. On a delegated or unattended task, report the human-interaction blocker.
- **Stale page/control reference:** observe again before proposing the new exact action. After a timed-out click/submit, inspect the site for completion before trying again. No arbitrary browser JavaScript bypass exists.
- **Sign-in worked on Mac but not Home:** retained bot profiles are per engine and do not sync. The owner may need a handoff on the engine actually working. Persistent cookies can expire and session-only cookies may not survive closing.
- **Upload/download fails:** confirm both Browser and Files tools, observed direct link/input, current private file bytes and a new destination. Transfers are limited to 20 MB and a 45-second download deadline. Script-only download buttons can be unsupported. Do not use unrelated background downloads as the requested artifact.
- **File allegedly saved but missing:** inspect the actual write/export receipt, private path and workspace list/read. Only successful creation with real metadata earns an artifact link. Verify partial/truncated document reads before basing conclusions on them.
- **Model did not read an attachment/image:** check that it was sent, admitted, supported by the current model and actually included. Selection alone does not send it; a filename alone is not visual evidence.
- **Diagram/HTML fails to render:** simplify within supported sanitized rich output; preserve content restrictions. Use a real document export when requested. Do not enable arbitrary scripts/HTML or a runtime CDN as a rendering fix.

## Minimal unresolved-issue handoff

State only what is needed: executing engine and known release, affected task/action and timestamp, desired vs actual result, exact redacted error/status, successful read-only checks, corrections attempted and their receipts, whether an external effect is confirmed/absent/unknown, and the next owner/operator action. Exclude credentials, raw `state.json`, private transcripts, account identities and pairing links. Say when reproduction or live confirmation has not occurred.
