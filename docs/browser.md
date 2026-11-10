# Browser use

## Automatic action review

**Approve for me** is a saved per-bot policy. The Engine automatically reviews routine navigation (including a retained session), tabs, hovering, non-private field fill/type/select, movement keys and dialog dismissal. A native HTTP(S) link may be followed automatically by navigating to its verified href in the current tab; its click handlers do not run. Download links and generic buttons are excluded. Exact page/target/argument fingerprints are still prepared and rechecked before dispatch, including the link's destination and download state. Private sign-in, verification and payment credentials stay in owner handoff.

Form submissions/activation keys, checkbox/drag effects, uploads/downloads and accepting dialogs still ask. Page loads and field input/change handlers can themselves contact or modify the site; the setting is not a semantic guarantee about website behavior. Unknown actions ask. Balanced/Strict retain their manual interaction behavior. See [security](security.md#approve-for-me).


This document describes the interactive browser in current source. Operational engines and signed Apple apps require a separately verified update. Source changes do not change an already running release.

## Use the browser

Enable **Browser** in a bot's tool settings. Chrome, Chromium or Edge must be installed on the engine doing the work. Tupies controls that browser itself; no Hermes runtime, Codex CLI, external browser account or runtime CDN is required. See [setup](hermes-setup.md#browser-use) for installation.

The bot can inspect script-rendered pages, follow links, fill forms, type text, select options, check boxes, use keys, hover and drag, move between tabs and frames, and inspect screenshots with an image-capable model. Actions use observed page references. A changed document or control requires a new observation; a stale approval cannot silently act on a different target.

Browser actions can submit forms or trigger a site's automatic save behavior. The engine reviews exact actions, including their page/control identity. Approval of one action does not authorize a later purchase, reservation, message or form submission. A successful click is not proof that the site's business operation succeeded; the bot must inspect its result. Interrupted or timed-out actions are not automatically replayed.

## Pages that render with scripts

Many sites send an empty shell and draw their content with scripts after the page has loaded. The browser gives such a page a short, bounded chance to finish before the bot reads it.

**Settle after navigation.** After a page loads (`browser_open`, `browser_new_tab`, `browser_back`, or a link followed by navigation), and before the first `browser_snapshot` of a document reached another way, the browser checks once per document:

- A visible loading marker (`aria-busy="true"`, `role="progressbar"`, or a class containing `skeleton`, `shimmer`, `spinner` or `loading`) is given up to about 2 seconds to go away.
- A page that has scripts but shows under 200 characters of text, or no links, buttons or fields, is given up to about 1.5 seconds for its content to start arriving, and then until 250 ms pass without a change.
- Any other page keeps the previous short fixed pause, so ordinary pages are not slowed.

The whole wait is capped at about 3 seconds on top of the existing 15-second load limit. It ends at once when a JavaScript dialog opens or the task is stopped, and if the page cannot be checked (for example because it navigates again) the browser falls back to the short fixed pause. Clicks, fills, typing and keys do not use it.

**`browser_wait` conditions.** `milliseconds` alone is still a plain pause of at most 5000 (default 500). Two optional arguments turn it into a wait for something specific, with `milliseconds` as the longest wait (default 5000, at most 15000):

- `text`: up to 200 characters; wait until the visible text of the selected page or frame contains it, ignoring case and spacing.
- `until: "dom-quiet"`: wait until 250 ms pass without a change to the page's elements or text.

With both, the text must be present and the page quiet. The result always includes a fresh outline, plus `waited: {condition, met, ms}`. A condition that was not met is reported as `met: false`; it is not an error and nothing is repeated.

**Hint for a page that is still empty.** When the result of `browser_open`, `browser_new_tab` or `browser_snapshot` has under 200 characters of outline and fewer than three references, it carries a `hint` telling the bot to wait for text or a quiet page and then read the text, rather than reopen the same address. The hint is given once per page load (a repeated snapshot of the same page does not repeat it), and not on dialogs or detected verification challenges.

Limits: the settle and the conditions watch the selected page or frame only, and do not see changes inside other frames or shadow-DOM components. A page with constant updates (tickers, animations) may never be quiet and simply reaches the time limit. A very short but complete page also gets the hint. None of this solves a CAPTCHA or a sign-in wall; those still need the owner handoff below. A page drawn only on a canvas has no text to wait for: it needs `browser_screenshot` with an image-capable model.

## Sign in, verification codes and CAPTCHA

When the bot calls `browser_handoff`, the chat displays **Open browser**. The task pauses while you control the same browser through an image of its current page:

1. Open the browser card and inspect the displayed website address.
2. Click a field on the page. Use the panel's text box to insert a username, password or verification code. Text is masked in the panel by default and cleared after insertion.
3. Use the page buttons, keyboard controls, scrolling or dragging to complete sign-in or a human verification challenge.
4. Choose **Resume bot**. The bot reads the current page to verify what happened.

These owner actions go directly to the browser control API. Their text and screenshots are not added as chat messages, tool arguments or activity records. The website itself receives the values you enter. The panel's views are transient and are never download artifacts. Use **Skip help** if the site cannot be completed; skipping does not establish that sign-in or verification succeeded.

The current source binds each view to the tab/document, rendered text, visible controls, focus and frame state. Hidden verification tokens and telemetry updates do not invalidate an otherwise unchanged view. Changed controls, destinations, positions or covering elements still require a fresh view. This owner-view check is separate from exact bot-action approvals.

If input was sent but the next image could not be captured, the panel says **Input sent** and asks you to **Refresh** to inspect the result. Refresh reads the page; it never repeats the input. An uncertain transport error still requires inspecting a fresh view before choosing another action.

The handoff works through the same authenticated Tupies interface on desktop or phone, including when the browser is running on a VPS. CAPTCHA handling means owner interaction with the actual page. Tupies does not guarantee that a site will accept automation, that every challenge can be completed remotely, or that a successful verification will remain valid.

Cloudflare explicitly lists automated browsers as [unsupported for production challenges](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/). Repairing the handoff controls does not establish Cloudflare acceptance. If the site keeps refusing the task browser, skip browser help and complete that account step in a regular supported browser. A sign-in in your own browser does not transfer to the bot's isolated profile.

## Keep or discard sign-in

Each bot has its own browser session. Temporary sessions are discarded when their task ends. In the handoff, **Keep this sign-in on this engine** lets the owner retain that bot's browser profile for later tasks on this engine. The bot cannot enable retention itself. Reusing a retained profile requires approval before the bot opens it.

Browser profiles contain sensitive site state, including cookies and local storage. They remain outside the model-editable workspace and engine sync. They do not transfer between Mac and Home server and are not the owner's ordinary Chrome profile. Protect the complete runtime and its backups accordingly. Clearing the retention choice during a later handoff discards the profile when its browser closes. Stop closes the browser; restart interrupts the task without replaying its actions.

Sites control cookie expiry and may require sign-in again. Retaining a profile preserves persistent site state; it does not extend expired credentials or promise that session-only cookies survive closing Chrome.

## Files

With **Browser** and **Files** enabled, `browser_upload` selects one existing private workspace file for a site's file input. Approval includes the path and SHA-256 of the exact bytes. A changed file is refused; the browser receives a private copy of the verified bytes. The site may upload immediately after selection.

`browser_download` approves one observed direct download link and a new private destination path. It correlates the downloaded bytes with that frame and link's observed redirect chain, refuses unrelated background downloads, and refuses to overwrite a file. A script-only download button without an inspectable URL is unsupported by this tool. Transfers are bounded to 20 MB; a download must complete within 45 seconds. Downloaded files are not executed. Other automatic downloads remain disabled.

## Boundaries

- The browser connects only to public HTTPS destinations on port 443, with proxy-enforced DNS/address checks. The private-HTTP override exists only for deterministic local fixtures.
- Chrome is controlled through a private pipe. There is no remotely exposed debugging port or arbitrary model JavaScript tool.
- Bot tools, approvals and retained sign-ins belong to the executing engine. A web page, skill or teammate cannot grant access.
- Owner controls require the exact active run, handoff, execution generation and current view. Controls from a previous task, closed panel or already resumed handoff are refused. Concurrent actions are serialized.
- Handoffs are available in direct owner chat, with a 30-minute wait limit. Unattended and delegated tasks must report missing human interaction.
- Browser availability and successful fixture tests do not prove that every public site, identity provider, payment flow or CAPTCHA works. Live-site and physical-device acceptance must be recorded separately.

## Implementation and verification

`lib/browser.mjs` owns the browser, egress proxy, references, sessions and bot tools. `lib/browser-control.mjs` owns the authenticated human handoff. `lib/browser-files.mjs` bounds file transfer. `public/browser-control.js` and `.css` provide the live owner panel. Engine approval, Stop and recovery remain in `lib/engine.mjs`.

Tests use temporary runtime directories, synthetic accounts and actual installed Chrome. See [verification](verification.md) for the tested snapshot and remaining limits. The implementation uses Chrome's [DevTools Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/), [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) and [Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/) protocols; these APIs do not grant the bot permission to act.
