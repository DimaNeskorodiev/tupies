# Bot appearance, models, reasoning and voice

## Bots and Favorites

Each tile or phone row on **Bots** opens Bot Profile. The separate **Chat** button opens the conversation. The **•••** menu contains quick actions: Open chat, Start Mission when available and Delete bot; on phones it also holds Favorites. Long-press offers Bot profile, Chat and Favorites. The sidebar and Dashboard team shortcuts continue to open chat.

The **Bots** page orders conversations by their latest user or bot message, newest first. Local activity logs, settings edits and run heartbeats do not change that order; chats without messages follow the conversations with messages. The order is derived from the shared transcript, including routine replies shown in Bot Chat, while private messaging lanes and teammate/room work do not promote a bot.

Tap a bot card’s heart to add or remove it from **Favorites**, or use **••• → Add to Favorites** in the phone list or chat. Favorites has its own filter tab and the same message ordering. The choice is saved on the bot and travels through existing bot sync. Hidden favorites stay in Hidden. Changing a favorite is available while the bot works and does not change its tools, model or permissions.

Idle, configured bots have no Ready label or status dot. Working, Needs your answer, Needs approval, Paused and setup/connection errors remain visible and update in place.

## Text during a task

Completed public assistant messages between tool/model steps stay in direct-chat history as **Update** messages. A provider attempt interrupted by a transient error keeps available text as **Interrupted update**. The final reply follows these updates; neither the next model step nor a page reload erases them. Stopping retains the available text once and marks terminal partial text without claiming completion. Updates do not trigger reply push, unread markers, automatic speech or Dashboard completion. Opaque provider reasoning is not exposed. This applies to direct Bot Chat; room and private-lane progress keep their existing behavior. Update linked engines together before using this feature: older engines do not recognize progress messages and can mistake them for ordinary replies.

## Chat controls

Open a bot conversation and use the **•••** button in the top-right corner on desktop or phone. It holds Bot profile, Favorites, Start Mission, Search conversation, Chat options and Delete bot. An eligible active chat also offers Make this task a Mission. Memory, Files and bot settings live in Bot Profile; resource shortcuts open the matching profile tab. Chat options keeps conversation model/reasoning and voice preferences together. **Reasoning** is directly visible in the chat and in **Bot settings › Model**. **Chat options** also has three closed sections: **Model & reasoning**, **Conversation history** and **Voice & dictation**. Open only the section you need. Saving leaves untouched model and voice preferences intact. Model and reasoning changes apply to that bot's next task; an active task keeps its original settings. The configured composer keeps attachment, dictation and Send visible. A bot without a provider retains a **Connect to start** action. On a phone, tapping the bot's name switches teammates.

On phones, **Return** inserts a new line. Tap **Send**, or use **Cmd/Ctrl+Enter** with a hardware keyboard, to submit. Desktop keeps Enter to send and Shift+Enter for a new line. After the engine confirms a bot message, room message or task update, the phone/touch keyboard closes. Touch taps reach Send and Add direction without cancelling the native pointer event. Failed or unconfirmed sends keep the draft ready to retry; a late receipt never dismisses a newer draft or another chat’s keyboard. Desktop keyboard focus stays ready for typing. The phone composer grows with the text and follows the visible viewport above the keyboard. Unsent text survives switching between bot/room chats within the current page session; it is kept only in memory, clears at sign-out, and does not survive reloading the page. Text written while an earlier message is sending is kept for the next message. Swipe right from the left edge of a pushed screen to follow its Back button. A sheet can be dismissed with its close button or by dragging its top grabber down; scrolling a form does not dismiss it. System Reduce Motion suppresses the added navigation and sheet motion.

Phone transitions settle cleanly after interrupted animations, rotation or returning to the app. New messages use a short entrance; automatic scrolling follows streamed replies with one bounded animation and stops as soon as you scroll. Composer growth also yields to your scrolling. The floating down-arrow returns to the latest message. These motion refinements are currently in source; operational engines require the matching static asset update.

## Bot profile navigation

The profile keeps Overview, Settings, Brain, Memory, Learning, Files and Scripts in a single horizontal tab row. On phones the row stays below the app header while scrolling. Swipe it to reach more sections; keyboard users can use Left/Right or Home/End. The selected tab is revealed for direct links, and focus and horizontal position survive data refreshes. **Open chat** is the primary action; the adjacent sliders button opens **Bot settings**. The gear in the app header opens workspace Settings.

Overview shows compact Memory, Notes, Files and last-activity summaries followed by recent tasks. Brain contains linked knowledge; Memory contains short facts and preferences; Learning handles material intake and suggestions to review. On a phone the Brain connection map starts collapsed under **Explore connections**, leaving the note list easier to reach. It can be expanded without leaving the page.

## Search and direction during work

The desktop sidebar keeps a compact brand and navigation area above **My Tupies**, your visible bot list. The list uses the remaining window height and scrolls independently, with **Settings** always available below it. Click a bot to open its conversation or **+** to create one. Phones keep their existing bottom navigation and teammate switcher.

A single blue dot beside a bot means its main conversation has an unread reply, including a routine result. Bots with everything read have no dot. The dot clears after the final reply is visible in an attended chat; an offscreen reply stays unread. A partial stream does not create or clear a dot. Updates arrive while you use another chat, and read status survives reloading. These dots do not indicate online availability.

Use the single **Search** field in the desktop sidebar: typing filters bots, rooms and routines by name; press **Enter**, click its **↵** button or press **Cmd/Ctrl+K** to search saved messages with the same query. On phones, use the search icon in the header. Use **Search conversation** in a bot or room's menu for a scoped search. Results show the conversation, author, date and excerpt; selecting one opens and focuses the matched message while keeping the current page session's draft. Search reads bounded stored transcripts on this engine without calling a model. A partial-search notice means older messages may require narrowing the scope.

While a direct-chat task works, type additional guidance and choose **Add direction**. The transcript distinguishes queued, applied and cancelled guidance. It applies at the next model boundary; an already admitted action can finish first. Guidance keeps the same model, permissions and original required checks. Resolve a pending question or approval first. To abandon a required outcome, use **Stop** and send a revised task. There are at most eight guidance updates/32 KB per task; updates contain text only.

## Cushion companions and everyday settings

Tupies offers 24 soft cushion companions with distinct colors and silhouettes. The original Blue, Coral, Jade and Honey still identify canonical Atlas, Nova, Scout and Echo profiles. Existing implicit assignments remain stable as the library grows. In **Edit bot**, expand **Choose avatar** to see all 24 faces; choosing one previews it locally, and **Save changes** stores the explicit choice. Existing names, saved icons and activity palette colors stay intact until changed.

Each of the twenty additions has four generated poses: open eyes, a closed-eye blink, a curious look and a one-arm wave. Dedicated portraits appear in the roster, bot cards, headers/messages and team lists; full-body companions appear in single-bot welcomes/profile heroes. Gentle body motion varies by companion, with a staggered brief blink for the new twenty, look/wave poses for the matching state, and a short hover/keyboard-focus greeting. The original four retain their artwork and gain subtle body motion. This is rendered-pose animation with CSS motion, not a 3D rig or a display of private reasoning. Status, questions and approvals remain the source of task progress information.

Paused companions and **Reduce Motion** show the still idle image without blinking or transforms. Offscreen/hidden-page animation suspends automatically; there are no per-avatar JavaScript timers. The local `/companions-preview.html` gallery reviews every companion, actual interface sizes, task poses and the pause option; the new twenty have downloadable transparent animated WebP files.

Open **Bots → bot profile → Settings**, the profile’s **Settings** button, or **chat ••• → Bot profile → Settings**. One page contains four visible sections, with buttons to jump between them: **Instructions** (identity, companion and standing rules), **Memory** (Memory/Brain tools, Save brief task notes, explanations of Brain and reviewed Learning, and links to the stored content), **Tools** (capabilities, action review, skills, integrations, search fallback and teammates), and **Model** (provider and model). Only context budget, enabled/hidden controls and deletion remain under **Advanced settings**. Brain, Memory and Learning remain content views; the Overview’s configuration summary is read-only. Creating a bot uses the same form in a dialog. A new bot inherits the workspace provider and its default model. Room handoffs and turn budgets remain under **Collaboration settings**.

Settings are applied only with **Save changes**. Unsaved values, checkboxes, selected companion and focused input/caret survive profile refreshes and switching between profile tabs in the current page session. **Discard changes** restores the current saved configuration. A refused save retains the draft and shows its error. On phones, the save bar floats above the tab bar only while there are unsaved edits; otherwise it stays at the end of the form. This is session-local editing state, not persistent draft storage or a change to Engine permissions.

**Settings** starts with Models, Devices & sync and Help. Open **More settings** for Skills, Integrations, Messaging and Activity; those routes and their existing actions remain available. A collapsed section picker on each settings page switches sections. Open state and keyboard focus survive background refreshes.

## Activity flow

While a bot works, actions, sources and returned values move through a transparent flow in the bot's own colors. Its shape adapts to the work: research connects sources to observed fields, analysis brings together recorded results and table cells, visible plan steps branch from the task, and real teammate requests and replies connect the bots. A caption, elapsed time and **Stop** stay beside the flow. Team rooms use the same view for the bot taking its turn; while a reply streams, it contracts to a compact band.

Moving labels use pearl glass cards with a local icon and a short **Request, Source, Action, Plan, Teammate, Result** or **Observed** label. Their bounded text can span two lines; full bounded task/step/source values remain available in inspection. Luminous paths and fewer moving pulses connect the cards. Only isolated nodes add canvas captions, avoiding duplicate labels beneath connected cards. The caption describes the current action, for example **Searching the internet**, **Browsing a page** or **Working on step 1 of 2**, without repeating a long prompt or naming the underlying service. It stays on one line beside **Stop**. The graph is 168px high on phones, 184px on desktop and 112px while a reply streams.

**Task details** is one collapsed row containing the plan and a short **Activity** history of up to six recent actions. It replaces the separate Work log; raw event JSON, tool identifiers and internal context updates are omitted. It is useful when checking what happened or why a task paused, and can stay closed during ordinary chat. An opened panel and its keyboard focus survive updates to the same task; the next task starts collapsed. These surfaces follow the light/dark theme and phone text-size setting.

Plan progress is a checklist, not proof that the final file/report was saved. Current source works until done by default, without a lifetime time, turn or tool-call cap. It continues unfinished plans and failed declared checks, and automatically retries temporary model-service failures using saved progress and the original inference snapshot. Individual model attempts retain 15-minute total and five-minute inactivity limits; a transient timeout does not end an autonomous task. **Auto-recovering** shows progress while waiting; **Needs attention** explains a real blocker or repeated unchanged work.

For routines, **Advanced execution → Execution** defaults to **Work until done**. Choose **Use explicit limits** to bound time, model turns and tool calls. Old numeric defaults do not silently enable those limits. Saved preparation/report steps remain optional. There is no Continue button or separate approval to keep executing the same task; new actions retain ordinary approvals. **Stop** persists cancellation before aborting active work and children, preserving committed partial work.

An interrupted direct owner chat or routine can recover automatically on this engine from a current schema-version-2 autonomous checkpoint after startup checks. Stopped/replaced tasks, historical failures, changed identities and uncertain write/external outcomes are not automatically replayed. Tool/context/concurrency/storage limits remain. See [Routines](routines.md) for workflow examples and boundaries. Both operational engines run these autonomous changes as `autonomous-work-20261030`.

During an active direct-chat task, **Add direction** sends text guidance using the existing task. Desktop Enter and phone Cmd/Ctrl+Enter send that guidance within the same task; phone Return, Shift+Enter and IME composition retain their editing behavior. A pending send shows **Sending…** and prevents duplicate guidance. Its short tooltip explains that files remain for the next message; there is no standing explanation inside the composer. Queued/applied acknowledgements appear only after sending and describe receipt rather than task completion.

Hover a moving fragment or focus it with the keyboard to hold it for reading while the other fragments continue. Other recorded actions and values cycle into the flow during visible animation. Click, tap or activate a fragment with the keyboard to inspect its recorded display value and source or result details. Close the detail panel to return to the flow. Narrow screens show fewer moving fragments to keep them readable.

The view uses actual run events and bounded tool-result previews (`public/activity-flow-model.js`, `public/thinking-waves.js`, `public/thinking-waves.css`). A visible plan describes intended work; a tool completion or returned value is separate evidence of what happened. Incomplete previews are identified, and no private reasoning or missing result values are invented. The canvas keeps its position and selection across chat refreshes, pauses while offscreen or hidden, and stops when removed. Reduced motion shows a still composition while the elapsed time continues updating. Approval requests replace the flow with the approval card.

The pearl glass redesign was deployed to both engines serving the Mac and iOS apps on 29 October 2026. Existing views need **Reload** to fetch the updated web assets; signed Mac7/iPhone7 apps, their profiles/pairings and the bundled fallback v10 were unchanged. The [activity preview](../prototypes/activity-glass-preview.html) uses this same production renderer with clearly labeled illustrative data, without running a bot or contacting a service. Exact rollout and disposable browser/WebKit evidence are recorded in [verification](verification.md).

## Hiding bots

Open the bot profile’s **Settings → Model → Advanced settings → Hide from the sidebar and Bots** to hide a bot. Hidden bots keep their chats, routines, channels and team roles and still work; **Bots › Hidden** lists them and the same button shows them again.

## Model and reasoning

The small tuning icon inside the message field sits beside the rounded microphone icon. Its accessible label and tooltip show the model and effective reasoning level. Tap it for a glass panel: tap the model name to search and choose a model, or drag the reasoning slider between the model's supported levels. Releasing saves the selected level; cancelling a drag keeps the previous setting. Keyboard arrows, Home/End and Escape work with the native range and dismissible panel. **High by default** and **Provider default** remain explicit choices. Models without adjustable reasoning show an explanation instead of a fictitious slider. A dormant unsupported preference is retained for a later compatible model.

The panel preserves the draft and applies selections to the next task. During a task it shows that task's original effort separately. Sliding requests one native selection haptic per crossed detent when the iPhone shell's existing haptic preference permits it. Desktop/browser-only sessions need not provide physical vibration. The reasoning rail stays mounted during saves to avoid flashing or restarting its highlight; thumb motion uses a transform and pointer updates are grouped by animation frame. Reduced Motion disables decorative transitions. The same saved preference remains available in Bot settings; Chat options retains history and voice controls.

Choose a model from the connected provider's current catalog. Choose the shared default to resume following the provider/workspace default. Changing a model does not erase the transcript, memory or files.

Chat options also shows the selected model's context window and where Tupies starts organizing older material (90% of the window, at most about 245K by default). When a provider does not report a window, Tupies assumes 128K; set the real one for a local or compatible service in the provider's **Advanced endpoint settings › Context window**.

The **Conversation history** section in Chat options shows how large the conversation is and when it was last summarized:

- **Summarize older messages** folds the older turns into a summary and keeps the recent ones.
- **Start a new topic** keeps everything so far as a background summary, so the same chat continues fresh.

Either way the full transcript stays visible in the chat, with a short Tupies note. **Bot settings › Context limit** chooses how much of the model's window a bot uses. See `docs/context.md`.

Reasoning defaults to **Tupies default · High** for new bots and bots that previously had an implicit provider default. High is sent only when the selected model explicitly advertises it; otherwise the automatic preference uses the provider default and the UI says so. Existing explicit effort choices are kept. **Provider default** is a separate, persistent owner choice that omits the effort parameter. Reasoning choices come from explicit capability metadata for the selected model; Tupies does not guess support from a model's name. Changing the shared model preserves the reasoning preference; an explicit level unsupported by the new model uses its provider default until a supported level is chosen. A change is validated against a fresh catalog before it is saved. Models and account entitlement remain provider-controlled.

For OpenAI and ChatGPT/Codex Responses requests, selected efforts use `reasoning.effort`, following the [official reasoning guide](https://developers.openai.com/api/docs/guides/reasoning). The supported native values are model-dependent subsets of none, minimal, low, medium, high, xhigh and max. Codex catalog orchestration labels such as ultra are not offered as a native reasoning effort. Compatible providers require explicit parameter and effort metadata; Anthropic, custom and Ollama retain provider-default reasoning until supported adapters are available.

## OpenRouter AI voices

Choose **OpenRouter · AI voices** in Chat options, select an existing OpenRouter API-key connection, and allow speech processing. The key stays sealed on the server. Speech settings are independent of each bot's reasoning provider/model and are saved only in this browser. A ChatGPT subscription is not an OpenRouter audio credential. Add an OpenRouter connection in Model providers if none is configured.

The reading-model selector offers **Eleven v4 Turbo** (default), **Gemini 3.8 Flash TTS**, and **Fish Drama 3**. Choose a voice for each model. ElevenLabs and Gemini voices come from the current OpenRouter catalog. OpenRouter currently omits Fish's voice list; Tupies includes three public, trained Fish presets verified on 26 October 2026: Ethan, Delia and Adrian. A missing model remains unavailable rather than silently switching providers.

Use the three preview buttons to compare the same editable sample (up to 600 characters). Previewing selects that model and its remembered voice in the form; **Save options** commits the selection. Cancel leaves saved preferences unchanged. Previews use paid API requests. An identical model/connection/voice/text combination reuses a temporary in-memory audio cache (up to six entries and 16 MB); navigation/sign-out clears it. Closing the dialog stops pending previews.

OpenRouter and the selected upstream provider receive the recording for dictation or the text to be spoken. Explicit consent is required before either request. Tupies does not persist microphone recordings, generated audio or unsent transcripts on its server. Transcribed drafts become conversation data only when sent. OpenRouter/provider processing and retention policies apply separately.

## Voice input

Use the microphone, speak for up to 60 seconds, then choose **Stop & transcribe**. Tupies converts the recording locally to mono 16 kHz PCM WAV and transcribes it through the authenticated server. **ElevenLabs Scribe v2** is the default; GPT Transcribe and Whisper Large V3 Turbo are available when listed by OpenRouter. Review the resulting draft and press **Send** separately. Dictation never submits a message automatically.

Cancel discards the session. Typing, Send, navigation, sign-out and conflicting speech actions cancel recording/transcription and ignore late results so they cannot overwrite a draft or send extra text. Browser microphone permission and MediaRecorder/Web Audio support are required; use localhost or HTTPS. Embedded browsers can expose fewer recording capabilities than full Chrome/Safari. Audio is limited to 60 seconds and 1,920,044 WAV bytes per request, with a larger bounded browser recording buffer before conversion.

The optional **Browser · System voices** service preserves browser recognition and synthesis. Some browsers send microphone audio to their vendor's speech service; the first-use notice explains this before listening. In this mode Tupies receives only the text you explicitly send, not microphone audio. On-device reading voices are preferred, and browser online voices require explicit selection and acknowledgement.

## Read aloud

Use the speaker control on a completed assistant reply. Stop cancels playback and pending generation. Rich output is converted to readable prose; raw chart JSON, code fences and tables are omitted. Long prose is split into bounded requests. Gemini PCM is wrapped as WAV for browser playback; other supported responses use MP3/WAV. Generated media uses private blob URLs that are revoked after playback or cancellation.

Automatic reading starts off. When enabled, it reads new completed replies without replaying old history on refresh. Browser autoplay rules can require a manual click; the UI explains when playback is blocked. Provider errors do not silently fall back to another paid model or change the conversation.

This is recorded dictation and reply playback, not a continuous realtime audio conversation. Browser microphone accuracy and paid provider voice quality require representative live testing; deterministic fixtures only verify the app's lifecycle and protocol behavior.

References: [OpenRouter TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts), [OpenRouter transcription](https://openrouter.ai/docs/guides/overview/multimodal/stt), [Fish Drama 3](https://fish.audio/blog/fish-audio-drama-3/), [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).
