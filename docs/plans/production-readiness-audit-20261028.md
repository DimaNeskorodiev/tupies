# Desktop and iOS production-readiness audit

Audited 28 October 2026 against the current Tupies 0.5.0 working tree. This is a source audit and a bounded end-to-end test, not a release approval. The working tree already contained substantial changes before this audit. Operational Mac/VPS data, accounts, installed apps and the owner's iPhone were not used as test fixtures or upgraded.

## Release decision

**Do not claim general production readiness or Grok Bot parity yet.** The supported single-owner self-hosted core has substantial passing regression and observed UI evidence. This audit found and repaired functional, native transport and recovery bugs. Public-release security disposition, physical-device acceptance, real-model quality and distribution/notification verification remain open.

Grok Bot has documented workflows Tupies does not implement. The [separate parity matrix](grok-parity-audit-20261028.md) links current official sources and defines a matched-task study. No Grok runtime or paid account was operated, and market leadership/equal usability were not measured. Intentional Tupies properties—private bot workspaces, direct providers, engine-owned permissions and self-hosting—remain the product's requirements.

The owner subsequently selected existing Mac/iPhone installs first. The [release-hardening follow-up](release-hardening-20261028.md) records new security, packaging, recovery, real-model and UX work; the results below remain the earlier audit snapshot.

## Test environment and method

- Node 22.23.1 on macOS; real engine HTTP/API/worker execution with temporary stores and a deterministic local Responses provider.
- Chrome at desktop and 375 × 812 phone dimensions, including real clicks, forms, task submission, PDF preview and injected connection failures. Browser geometry is not an iPhone hardware test.
- A fresh iPhone simulator and a separate macOS QA bundle/preferences/Keychain identity. The actual SwiftUI/WKWebView shell was exercised without importing operational connections. Both native targets were built after the fixes.
- Pure Swift/Node signing and parsing checks, real Swift URLSession HTTP contract fixtures, complete JavaScript regressions, fixture evaluation and retrieval measurements.
- No paid model inference, live OAuth consent/renewal, Telegram delivery, camera/microphone recording, APNs delivery, production restore or broad penetration test. Automated fixtures do not prove model judgment or external-account entitlement.

The reproducible browser fixture is `node scripts/e2e-fixture.mjs`. It always creates a new OS temporary directory, disables scheduling, uses a local scripted provider, prints only synthetic test configuration, and removes its store on SIGINT/SIGTERM. It accepts no operational data-directory argument. Scenarios are `E2E chat`, `E2E question`, `E2E pdf`, `E2E approval` (Nova uses Strict), `E2E stop` and `E2E fail`.

The launcher also supports process-local fault injection, absent from the product API: SIGUSR1 toggles HTTP 503; SIGUSR2 toggles dropped connections; SIGALRM drops the next successful bot/room message acknowledgement after admission. Restore the fault with its signal and stop the fixture after testing. Use the printed PID only; never signal a live engine.

## Reproduced defects and fixes

| Priority | Reproduction and impact | Fix and evidence |
| --- | --- | --- |
| P1 | A native body-bearing request received an off-origin 307 redirect. URLSession forwarded pairing credentials to the second origin. | Native transport now accepts redirects only within the original scheme/host/effective port, excluding userinfo. Real Swift HTTP regression observed one foreign-origin request before the fix and zero afterward; same-origin redirects still work. Pairing, signed session and push-registration bodies are covered. |
| P1 | In the actual macOS app, Attach files did nothing. WKWebView disables this picker without a delegate implementation. | A trusted-main-frame/active-session NSOpenPanel handler now stages selected files, with cancellation on teardown/revocation and completion-time connection checks. Actual macOS selection, staging, Send and a real TXT card passed. |
| P1 | A bot could be removed or reconfigured while asynchronous task admission was checking its workspace. The task could then be committed using an obsolete configuration. | Bot edits/deletion guard admission and compaction; serialized admission revalidates bot/provider snapshots. Three regressions cover deletion, reconfiguration, compaction and safe visibility edits. Failed admission leaves no run or receipt. |
| P2 | A room member/specialist created a real document, but the shared room copied only reply text and lost its artifact card. | Room forwarding retains verified artifact metadata and the original bot-specific routes. Member and delegated output regressions pass. Actual room PDF generation and preview passed. |
| P1 | Room sends lacked receipt reconciliation: losing the response after admission left a retry capable of starting the task again. | Engine-local week/200-entry receipts are committed with the room drive/message; digest conflicts and concurrent repeats are checked before busy admission. The browser checks a receipt before resending. An actual deliberately dropped accepted acknowledgement produced exactly one user message, assistant message, verified PDF and completed bot run. Restart receipts never resume/replay work. |
| P1 | A pending direct/room send could outlive sign-out and submit an old task after a new sign-in. The nested CSRF recovery path and late 401 callbacks also crossed this boundary. | Send IDs/generation invalidate when sign-in ends; both the send loop and API's response/auth-refresh/retry paths check generation before dispatch or auth replacement. Independent controlled-timer and raw-fetch reproductions now show no second POST and retain the new session. Added direct/room, nested CSRF, late401 and detached-policy regressions. |
| P2 | Failed chat polling replaced received messages with an error, and the header could still show green Ready. | Bot and room recovery retains cached messages and drafts, discloses stale task status, distinguishes transport failure/HTTP refresh failure/browser-confirmed offline, and clears the notice on full/304 recovery. Stale-route/auth/request guards remain. Actual HTTP 503, dropped connection and recovery passed at 375px with the same draft and transcript. |
| P2 | At 375px, a normal two-word bot name split its last word because the companion stayed 132px wide despite the phone's 88px rule. | Corrected selector specificity. Actual measurement after reload: 88px avatar, 193px text column, 375px page/scroll width. The full name wraps at its word boundary. |
| P3 | Provider test said “1 models are available.” | Singular/plural model catalog copy is corrected. |
| P3 | The desktop search field's accessible name was only the shortcut “⌘ K.” | Added “Search workspace”; the actual Chrome accessibility tree now reports that name. Physical VoiceOver acceptance remains open. |

Two test-infrastructure races were repaired separately: short-swipe events now use deterministic timestamps, and evaluation approval responses are counted once for each exact prompt. These are fixture fixes, not changes to motion or permission policy.

## Observed user workflows

“Passed” means the listed finite scenario was observed, not that every variation or device passed.

| Area | Observed result | Remaining boundary |
| --- | --- | --- |
| Authentication and navigation | Disposable sign-in; desktop Dashboard/chat/Settings; phone tabs, Back and Settings-section Back passed. | Fresh real-provider consent, device upgrade and broad account recovery not repeated. |
| Bot configuration | Phone creation with name/role/provider; profile tabs; actual memory fact save/pin/reload; provider test/catalog/default model passed. | Long multi-day memory usefulness needs real-model grading. |
| Chat | Actual UI → HTTP → engine → provider → rendered rich text/table/code; work log and terminal status passed. | Scripted content tests plumbing rather than answer quality. |
| Questions | Direct question card paused work, a selected answer resumed it, and the answer appeared in the transcript. | A full page reload loses an unsubmitted answer; ordinary polling preserves it. Typed secret forms are unsupported. |
| Approval | Nova Strict write showed exact path/content. Deny produced a refused tool result; a separate approved task wrote the file. | Real external integrations and commands use deterministic integration/process tests. |
| Stop and failure | Active delayed inference cancelled; provider 503 displayed an explicit failure and re-enabled Send. | Physical device loss/cellular conditions and actual provider outages not reproduced. |
| Documents | Real PDF creation/card/preview in direct/room contexts; iOS PDF download opened the native share sheet with a 13 KB PDF thumbnail and system actions. | All Office layouts/third-party editors were not manually exercised in this pass. |
| Attachments | Native macOS picker, staging, Send and verified TXT card passed after the fix. Automated suites cover private paths, metadata, aggregate limits and vision transport. | Chrome's automated picker was blocked by extension file-URL permission; that permission was not changed. iOS file selection and physical Files/iCloud workflows remain unverified. |
| Rooms | UI room creation, two-bot @all output, single-bot mention and actual room PDF preview passed. | Wider team-quality and live cross-engine progress remain separate gates. |
| Routines | Phone daily schedule with Europe/Warsaw, manual Run now and completed history passed; Run now retained the clock schedule's next time. | Scheduler was disabled in the browser fixture. DST/offline/busy semantics have automated coverage; long-running production delivery was not observed. |
| Native iOS | Fresh onboarding, invalid/valid link feedback, security-code confirmation, real pairing, Keychain session/web ticket, Dashboard, Settings/server details, engine switching, rich chat Send, question/answer continuation and PDF share passed. Software keyboard retention after Send and native Done dismissal, dark appearance and larger Dynamic Type were observed. | Simulator evidence does not pass physical keyboard, haptics, VoiceOver, scanner, 120Hz motion or background push gates. |
| Native macOS | Isolated bundle onboarding/pairing, rich chat Send, reload/route/session persistence, file selection/staging/Send and clean removal of the QA pairing passed. | Notarized install/update and bundled engine first-run remain unverified/unimplemented. |
| Offline recovery | Cached phone chat and unsent draft survived both HTTP and transport failures, then recovered automatically. Native server Settings identified the stopped engine as offline. | Startup while wholly offline cannot load uncached web assets; no persistent offline transcript store was added. |

## Automated verification

The final complete suite passes **748/748 tests**, with **84 syntax-checked modules**. Exact native build/contract results are recorded in [verification](../verification.md). The build regenerated brand/companion assets, browser bundles, 21 guide pages and dependency notices for 399 packages from source. A current production `npm audit --omit=dev` reported zero known vulnerabilities; that advisory result is not a security certification.

The eight-family fixture evaluation has 24 repeated cases. Retrieval's 12 public queries retrieve 41/41 labeled relevant IDs at k=4, with precision 41/124 and one stale history candidate. Labels await human review. These measurements do not establish real-model task completion, summary fidelity or Grok superiority.

Local synthetic screenshots and logs are retained under ignored `.runtime/qa-20261028/` and `/tmp/tupies-*audit*.log`; they are excluded from release packages. No operational transcript or provider credential belongs in this evidence. The report and regressions are the portable handoff.

## Required release work

1. **Public-service security disposition.** Resolve or explicitly scope first-contact TLS pin requirements, target-engine binding for device session signatures, engine-pairing key exchange and shared-key rotation after engine revocation. The existing target-binding gap was reproduced with two in-memory engines and one synthetic signed request; this does not by itself demonstrate remote interception. See the exact items in [roadmap](../roadmap.md).
2. **Physical iPhone acceptance.** Run the real keyboard, safe areas/rotation, sheet/edge gestures with unsaved text, VoiceOver, largest supported Dynamic Type, reduced motion/transparency/contrast, background/foreground and poor/cellular network tests. Retain device/build/OS evidence and fix failures.
3. **Real-model usefulness.** Run the versioned non-private task corpus with explicit budgets and independent checks; have a human grade correctness, constraint retention, sources, usefulness and false success. Include multi-day memory corrections, actual provider entitlements and cross-engine continuity. Scripted responses cannot pass this gate.
4. **Attention and delivery.** Complete Apple provisioning/APNs configuration and verify actual closed-app notifications and cold-start taps. Approval/question notifications and Mac alerts require their own supported scope. An outbox item or local HTTP mock is not delivery evidence.
5. **Release operations.** Produce and test the intended signed/notarized Mac and TestFlight/iOS distribution, install/update/rollback, isolated full-runtime backup/restore, realistic state-size/resource soak and certificate renewal. Latest source fixes need a deliberate verified release; they have not been installed by this audit.
6. **Parity decisions.** Separately decide the roadmap for interactive logged-in browser work/takeover, credential forms, live voice, active-task steering, native device actions/App Intents/Live Activities, richer message navigation, media creation and event-triggered automation. These are feature programs, not small test fixes. Use the matched product study before making equal-UX claims.

Until those gates are satisfied, the accurate claim is a tested self-hosted development product with repaired defects and explicit acceptance gaps.
