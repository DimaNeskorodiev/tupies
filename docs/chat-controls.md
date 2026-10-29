# Bot appearance, models, reasoning and voice

Open a bot conversation and use the **•••** button in the top-right corner on desktop or phone. It holds Search conversation, Memory, Files, Quick details, Bot profile, Chat options and Edit bot. **Chat options** has three closed sections: **Model & reasoning**, **Conversation history** and **Voice & dictation**. Open only the section you need. Saving leaves untouched model and voice preferences intact. Model and reasoning changes apply to that bot's next task; an active task keeps its original settings. The configured composer keeps attachment, dictation and Send visible. A bot without a provider retains a **Connect to start** action. On a phone, tapping the bot's name switches teammates.

On phones, **Return** inserts a new line. Tap **Send**, or use **Cmd/Ctrl+Enter** with a hardware keyboard, to submit. Desktop keeps Enter to send and Shift+Enter for a new line. The phone composer grows with the text and follows the visible viewport above the keyboard. Unsent text survives switching between bot/room chats within the current page session; it is kept only in memory, clears at sign-out, and does not survive reloading the page. Text written while an earlier message is sending is kept for the next message. Swipe right from the left edge of a pushed screen to follow its Back button. A sheet can be dismissed with its close button or by dragging its top grabber down; scrolling a form does not dismiss it. System Reduce Motion suppresses the added navigation and sheet motion.

## Search and direction during work

Choose **Search conversations** in the desktop sidebar or phone header, or press **Cmd/Ctrl+K**. The workspace filter's Enter key also opens transcript search. Use **Search conversation** in a bot or room's menu for a scoped search. Results show the conversation, author, date and excerpt; selecting one opens and focuses the matched message while keeping the current page session's draft. Search reads bounded stored transcripts on this engine without calling a model. A partial-search notice means older messages may require narrowing the scope.

While a direct-chat task works, type additional guidance and choose **Add direction**. The transcript distinguishes queued, applied and cancelled guidance. It applies at the next model boundary; an already admitted action can finish first. Guidance keeps the same model, permissions and original required checks. Resolve a pending question or approval first. To abandon a required outcome, use **Stop** and send a revised task. There are at most eight guidance updates/32 KB per task; updates contain text only.

## Cushion companions and everyday settings

Tupies offers 24 soft cushion companions with distinct colors and silhouettes. The original Blue, Coral, Jade and Honey still identify canonical Atlas, Nova, Scout and Echo profiles. Existing implicit assignments remain stable as the library grows. In **Edit bot**, expand **Choose avatar** to see all 24 faces; choosing one previews it locally, and **Save changes** stores the explicit choice. Existing names, saved icons and activity palette colors stay intact until changed.

Each of the twenty additions has four generated poses: open eyes, a closed-eye blink, a curious look and a one-arm wave. Dedicated portraits appear in the roster, bot cards, headers/messages and team lists; full-body companions appear in single-bot welcomes/profile heroes. Gentle body motion varies by companion, with a staggered brief blink for the new twenty, look/wave poses for the matching state, and a short hover/keyboard-focus greeting. The original four retain their artwork and gain subtle body motion. This is rendered-pose animation with CSS motion, not a 3D rig or a display of private reasoning. Status, questions and approvals remain the source of task progress information.

Paused companions and **Reduce Motion** show the still idle image without blinking or transforms. Offscreen/hidden-page animation suspends automatically; there are no per-avatar JavaScript timers. The local `/companions-preview.html` gallery reviews every companion, actual interface sizes, task poses and the pause option; the new twenty have downloadable transparent animated WebP files.

The bot editor leads with name, role, description, companion and optional instructions. Provider/model overrides, capabilities, action review, context budget, skills, integrations, teammates and enabled/hidden controls remain under closed **Advanced settings**. Collapsing them does not change permissions or erase saved values. A new bot inherits the workspace provider and its default model. Room handoffs and turn budgets live under **Collaboration settings**. The profile keeps **Open chat** primary and puts technical details and Edit/Hide under **Bot settings**.

**Settings** starts with Models, Devices & sync and Help. Open **More settings** for Skills, Integrations, Messaging and Activity; those routes and their existing actions remain available. A collapsed section picker on each settings page switches sections. Open state and keyboard focus survive background refreshes.

## Activity flow

While a bot works, actions, sources and returned values move through a transparent flow in the bot's own colors. Its shape adapts to the work: research connects sources to observed fields, analysis brings together recorded results and table cells, visible plan steps branch from the task, and real teammate requests and replies connect the bots. A caption, elapsed time and **Stop** stay beside the flow. Team rooms use the same view for the bot taking its turn; while a reply streams, it contracts to a compact band.

Moving labels use compact single-line chips: **Task**, numbered steps and short actions such as **Searching** or **Reading**. The caption describes the current action, for example **Searching the internet**, **Browsing a page** or **Working on step 1 of 2**, without repeating a long prompt or naming the underlying service. It stays on one line beside **Stop**. The graph is 96px high on phones, 112px on desktop and 72px while a reply streams. Full bounded task/step/source values remain available in inspection.

**Task details** is one collapsed row containing the plan and a short **Activity** history of up to six recent actions. It replaces the separate Work log; raw event JSON, tool identifiers and internal context updates are omitted. It is useful when checking what happened or why a task paused, and can stay closed during ordinary chat. An opened panel and its keyboard focus survive updates to the same task; the next task starts collapsed. These surfaces follow the light/dark theme and phone text-size setting.

During an active direct-chat task, **Add direction** sends text guidance using the existing task. Its short tooltip explains that files remain for the next message; there is no standing explanation inside the composer. Queued/applied acknowledgements appear only after sending and describe receipt rather than task completion.

Hover a moving fragment or focus it with the keyboard to hold it for reading while the other fragments continue. Other recorded actions and values cycle into the flow during visible animation. Click, tap or activate a fragment with the keyboard to inspect its recorded display value and source or result details. Close the detail panel to return to the flow. Narrow screens show fewer moving fragments to keep them readable.

The view uses actual run events and bounded tool-result previews (`public/activity-flow-model.js`, `public/thinking-waves.js`, `public/thinking-waves.css`). A visible plan describes intended work; a tool completion or returned value is separate evidence of what happened. Incomplete previews are identified, and no private reasoning or missing result values are invented. The canvas keeps its position and selection across chat refreshes, pauses while offscreen or hidden, and stops when removed. Reduced motion shows a still composition while the elapsed time continues updating. Approval requests replace the flow with the approval card.

## Hiding bots

Each tile on **Bots** opens the conversation. Open the profile through **••• › Bot profile** (on a phone, the trailing details button). **Bot settings › Hide** on the profile, or **Advanced settings › Hide from the sidebar and Bots** in the editor, hides a bot. Hidden bots keep their chats, routines, channels and team roles and still work; **Bots › Hidden** lists them and the same button shows them again.

## Model and reasoning

Choose a model from the connected provider's current catalog. Choose the shared default to resume following the provider/workspace default. Changing a model does not erase the transcript, memory or files.

Chat options also shows the selected model's context window and where Tupies starts organizing older material (90% of the window, at most about 245K by default). When a provider does not report a window, Tupies assumes 128K; set the real one for a local or compatible service in the provider's **Advanced endpoint settings › Context window**.

The **Conversation history** section in Chat options shows how large the conversation is and when it was last summarized:

- **Summarize older messages** folds the older turns into a summary and keeps the recent ones.
- **Start a new topic** keeps everything so far as a background summary, so the same chat continues fresh.

Either way the full transcript stays visible in the chat, with a short Tupies note. **Bot settings › Context limit** chooses how much of the model's window a bot uses. See `docs/context.md`.

Reasoning choices come from explicit capability metadata for the selected model. **Provider default** omits the effort parameter. A provider/model with unknown or unsupported effort controls only offers that default; Tupies does not guess support from a model's name. A change is validated against a fresh catalog before it is saved. Models and account entitlement remain provider-controlled.

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
