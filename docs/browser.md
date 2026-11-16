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

When the bot calls `browser_handoff`, the chat displays **Open browser**. The task pauses, and the window that opens is a live view of the bot's own browser that you use directly, like a remote screen:

1. Check the website shown in the address bar. The site's name is in bold, with a lock for a secure (https) page and a warning sign otherwise. Make sure it is the site you expect before typing a password.
2. Click or tap on the page as you would in a normal browser. On a computer, click a field and type: keystrokes go straight to the page, including Tab, arrows, Backspace and Enter, and Paste (⌘V / Ctrl+V) sends the clipboard text. A blue ring and a small "Typing goes to the page" label show when your keys go to the page; press **Escape twice** quickly (or click outside the page) to stop.
3. On a phone, tap the field on the page. A small typing box appears under the page; tap it to bring up the keyboard (or use the keyboard button in the toolbar at any time). Each letter, Backspace and Enter is sent to the page immediately; the box never keeps what you typed and shows dots for a password field. One-time codes from SMS can be filled from the keyboard's suggestion. Swipe on the page to scroll it, as the page itself would.
4. Use **Back**, **Forward** and **Reload** in the toolbar, or select the address to open another one (a bare name such as `example.com` gets `https://`). If the site opens a popup, the window switches to it and shows a row of tabs so you can switch back. Website messages ("Leave this page?", prompts, confirmations) appear over the page with their own buttons.
5. Choose **Resume bot**. Anything you already typed reaches the page first; the bot then reads the current page to verify what happened. Use **Skip help** if the site cannot be completed; skipping does not establish that sign-in or verification succeeded.

The page follows the size of the window: on a phone it is laid out for the phone's screen instead of a shrunken desktop page, and rotating the phone or opening the keyboard resizes it. A thin bar under the toolbar and a spinning Reload button show that a page is still loading; you can keep using the window, Resume and Skip while it does.

The connection light next to the title says **Live**, **Connecting…**, **Reconnecting…** or **Paused** (while the window is in the background, for example while you copy a code from an authenticator app). The window reconnects by itself after a network drop, a silent connection or a return from the background; **Resume bot** and **Skip help** always stay available. If you open the same browser in another window or device, the first one says it is open somewhere else and offers **Take control here**. When the bot gets the browser back, the task stops or the request times out, the window says so and can be closed. Closing the window does not resume the bot; open it again from the chat card.

These owner actions go directly to the browser control API. Your keystrokes, pasted text and the page images are not added as chat messages, tool arguments or activity records, and the window does not store them. The website itself receives what you enter. Input that may not have arrived (for example during a network drop) is reported and never sent again automatically, so check the page before you continue.

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
- Owner controls require the exact active run, handoff, execution generation and the current live view's control lease. Controls from a previous task, closed or replaced window or already resumed handoff are refused. Owner input is sent in order, one request at a time.
- Handoffs are available in direct owner chat. A handoff expires after 30 minutes without owner activity (opening the live window and every input restart that clock) and in any case 2 hours after it began, so a forgotten open window cannot keep the bot paused. Unattended and delegated tasks must report missing human interaction.
- Browser availability and successful fixture tests do not prove that every public site, identity provider, payment flow or CAPTCHA works. Live-site and physical-device acceptance must be recorded separately.

## Implementation and verification

`lib/browser.mjs` owns the browser, egress proxy, references, sessions and bot tools. `lib/browser-control.mjs` owns the authenticated human handoff and `lib/browser-stream.mjs` its live view and owner input. `lib/browser-files.mjs` bounds file transfer. `public/browser-control.js` and `.css` provide the live owner window. Engine approval, Stop and recovery remain in `lib/engine.mjs`.

Tests use temporary runtime directories, synthetic accounts and actual installed Chrome. See [verification](verification.md) for the tested snapshot and remaining limits. The implementation uses Chrome's [DevTools Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/), [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) and [Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/) protocols; these APIs do not grant the bot permission to act.

The owner window opens `POST /api/bots/{botId}/browser/stream` (an event stream of `ready`, JPEG `frame`, page `state`, website `dialog` and `end` events with heartbeats) and sends input to `POST /api/bots/{botId}/browser/input` in ordered batches with a strictly increasing `seq` and one request in flight; events that arrive meanwhile wait for the next batch. Pointer, touch, wheel and key coordinates are CSS pixels of the remote viewport, which follows the window's own size and device pixel ratio (capped at 2). A press carries the tab and document of the frame on screen, so the Engine can ignore one aimed at a page that has since changed. The window treats 15 seconds without any bytes as a dead connection and reconnects with backoff; an input `409` reopens the stream once and never resends input. The window is its own dialog element, so other dialogs and in-app navigation do not close it; it closes on sign-out, when the exact handoff visibly ends, or when the owner closes it. An open stream is rechecked every 5 seconds against the sign-in or paired device that opened it, and ends (`signedout`) when that session ends or the device is revoked. A JavaScript dialog belongs to its tab: switching to another tab and back shows it again. `test/browser-control-ui.test.mjs` exercises it in jsdom with a fake stream. Physical iPhone keyboard, WKWebView focus and SMS code autofill behaviour are not covered by those tests and need device acceptance.
