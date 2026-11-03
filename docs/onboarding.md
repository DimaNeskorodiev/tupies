# Getting started in the app

Tupies introduces the product before asking a new Mac user to connect. **Use this Mac → Start my engine** starts the included engine and pairs the app through the existing flow. An engine keeps the workspace and executes tasks; the selected model provider processes inference requests. The Mac must stay awake with its engine running for background work. Existing engines can still be reached with a pairing link.

Once connected, Dashboard offers **Continue setup**. The three-step guide is also available from **Dashboard → Getting started**, **Settings → Help → Open getting started**, and `#/welcome`:

1. **Connect a model.** Choose an eligible ChatGPT / Codex subscription, a provider API key or a local model. Use the normal account authorization or credential form, test the connection and choose a default model. Setup does not send an inference request. Plan eligibility and actual inference access still depend on the provider.
2. **Meet Chief of Staff and Ops.** Review the editable starter profiles and their model status. Missing roles can be added through a template in the normal New bot form. The same templates are available whenever a bot is created.
3. **Get your first reply.** An example prompt opens a chat draft. Existing draft text is preserved, and only Send starts work. The final step completes after a real, non-partial assistant reply to a direct user conversation. A send, failed task, progress update, interrupted text or teammate reply does not complete it.

The short map explains Dashboard, Bots, Missions and Routines. Chat guidance points to questions, approval cards and Stop. **Set up later** dismisses the Dashboard banner without changing bots, providers, tools or runs; the guide remains accessible.

## Starter roles

New workspaces contain **Roki · Chief of Staff**, **Ops · Tupies operator**, and the existing **Scout · Research analyst** specialist. The guide focuses on the first two roles. The stable internal IDs remain compatible with earlier workspaces. Existing saved bot names, roles, instructions and skill assignments are never migrated to these defaults.

Chief of Staff helps clarify priorities, carry out authorized work and coordinate specialists. Ops explains Tupies and uses the existing Manage Tupies, Skills and Routines tools for requested setup changes. Ops starts with the bundled, immutable **Tupies product guide**, including all four verified resources. Its presence grants no tools or authority. New Ops templates reuse the guide when it is already installed; an existing workspace without the guide can install it from Settings → Skills.

All starters retain the standard tool groups. Terminal, Browser, Coding, Tool workshop and Engine workshop are not enabled by onboarding. Account connections, integrations, schedules and external actions are not created automatically. Existing exact approvals remain in force.

## Implementation and verification

- `lib/bot-templates.mjs` owns editable profile text and example prompts; `lib/store.mjs` applies defaults only on first initialization and derives actual reply progress.
- `public/onboarding.js` and `.css` render the guide and Dashboard banner. `public/app.js` connects normal routing, bot forms and draft insertion. `public/dashboard.js` retains its normal refresh behavior.
- `PATCH /api/onboarding` accepts only `{dismissed: boolean}` behind normal session, CSRF, Origin and Host checks. The preference is engine-local presentation state; it is not replicated and does not authorize work. `/api/state` exposes templates, the preference and derived `onboardingProgress.firstReply`.
- The Apple welcome and This Mac setup views explain the product and next steps. Engine startup, identity, pairing and Keychain behavior are unchanged.

Run `node --test test/onboarding.test.mjs` and the complete Engine suite after persistence changes. `node scripts/e2e-fixture.mjs --onboarding` creates a disposable workspace with no configured provider and prints a synthetic model endpoint. In Models, select **OpenAI**, use the printed endpoint under Advanced endpoint settings, enter the synthetic key and `qa-model`, and choose that default model. This fixture uses the Responses protocol; its endpoint is not a Chat Completions service. It never reads `.env`, runs routines or uses paid inference. Stop it with Ctrl-C to remove its temporary store.

Native compile checks and browser acceptance are separate from deployment or physical-device testing. See [verification](verification.md) for the current evidence.
