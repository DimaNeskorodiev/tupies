# What people love about Grok Bot, and what Tupies should improve — 10 November 2026

Requested by the owner on 10 November 2026. This note collects what users and reviewers say they love about Grok Bot, what they complain about, and what Tupies should build in response. It complements the [capability comparison](hermes-grok-comparison-20261110.md) and the [flexibility plan](flexibility-plan-20261110.md); those are about what the engine can do, this one is about what people enjoy.

## Sources and their limits

| Source | Kind | Note |
| --- | --- | --- |
| [zenaegis.com, three-week review](https://zenaegis.com/grok-bot-review/) | Hands-on | Three stars of five; the most detailed account of daily use |
| [createwith.com, "We both tried GrokBot. We disagree."](https://www.createwith.com/blog/we-both-tried-grokbot-we-disagree) | Hands-on, two people | One enthusiastic power user, one who could not get it working reliably |
| [chatprd.ai, hands-on review](https://www.chatprd.ai/how-i-ai/how-i-ai-my-hands-on-review-of-grokbot-cursor-origin-and-the-grok-46-model) | Hands-on | A product manager running several bots |
| [xAI, "Designing Grok Bot"](https://x.ai/news/designing-grok-bot) | The maker's own design account | Explains the decisions users later praise |
| [Cursor forum, weekly allowance thread](https://forum.cursor.com/t/grok-bot-ultra-users-how-do-you-make-the-weekly-allowance-last-mine-reached-99-in-three-days/171221) | Paying users | What drains usage and what they wish they could see |
| [layer3labs.io review](https://www.layer3labs.io/guides/grok-bot-review) | Review by an automation agency | Partly promotional |
| [eesel.ai review](https://www.eesel.ai/blog/grok-bot-review) | Review by a competitor | Useful for user quotes from Hacker News and Reddit; critical by interest |
| [TechRadar](https://techradar.com/ai-platforms-assistants/elon-musk-says-grok-bot-was-throttled-because-costs-were-unsustainably-high-as-users-call-the-move-a-rug-pull) and [TechRepublic](https://www.techrepublic.com/article/news-spacex-grok-bot-usage-limits-ai-costs/) on the November usage limits | News | Several outlets repeat one episode |
| [docs.x.ai/grok-bot](https://docs.x.ai/grok-bot/overview) | Official documentation | Read earlier the same day |

- This is a small sample of written opinion, not a survey. Nothing was measured, and no Grok Bot account was used.
- One aggregate of posts from X, Reddit and YouTube could not be read (it sits behind a payment wall).
- Grok Bot is three months old and changes weekly; prices changed three times in three days according to one review.
- Tupies facts are from branch `feature/engine-capability-20261110`.

## What people love

Ordered by how often and how strongly it appears across the sources.

| # | What they love | What they say | Tupies today |
| --- | --- | --- | --- |
| 1 | **It just works from the first minute** | Name a bot, describe its job in a sentence, message it. No workflow builder. The bot works out which connected apps it needs. Called smoother to set up than OpenClaw and Hermes. | A bot is created from a template or a nine-section form. Bots can set up other bots from chat. Providers and tools are chosen by hand. |
| 2 | **Connected apps, several accounts each** | One reviewer links four Gmail accounts and seven Slack workspaces and says this alone earns his business. Another says several Gmail and calendar accounts connected easily. Connectors are called top-tier. | Eight presets (GitHub, Slack, three search services, MCP, custom API), each set up by pasting a key. No sign-in with Google or Microsoft; no Gmail, Calendar, Drive or Notion. |
| 3 | **A chief-of-staff bot that runs the team** | A manager bot oversees the others; specialist bots hand work to each other and settle questions between themselves; a morning inbox brief; daily stand-ups where the manager reviews the team. Built-in bot-to-bot messaging impressed people who had tried to build it themselves. | A chief-of-staff bot is seeded; teammates, verified handoffs, rooms and Missions exist. The chief of staff does not check on the team by itself, brief the owner, or route requests. |
| 4 | **It keeps working while you are away, and you can step in** | Each bot has a screen on a cloud computer. Long jobs do not tie up the laptop. The owner can watch, take over for a login, and hand control back. | The server engine works while apps are closed. The browser keeps a profile per bot and asks the owner to sign in when needed. There is no live view to check on a bot in passing. |
| 5 | **Approval cards that are easy to read** | Cards show what the bot wants to do and with which inputs; "I approve, and the work moves". Rated the most flexible approvals of three agents compared. | Exact approval cards exist and are stricter. For most actions the card shows the raw request as JSON. No "always allow this". |
| 6 | **The phone app is the same product** | Same bots, chats and computer as the desktop; "felt great on mobile". | Native iPhone app with the same engine interface and reply notifications. Approvals and questions do not yet alert the phone. |
| 7 | **Teach by showing** | Record yourself doing a task once and it becomes a reusable skill; attractive to non-developers. Reviewers also note recordings are drafts and break when a site changes. | Not available. Skills are imported, written, or suggested from finished work. |
| 8 | **It remembers corrections** | Preferences such as how to triage email do not have to be repeated. | Memory and a background review exist. A correction is not acknowledged visibly when it is learned. |
| 9 | **Routines are part of the main screen** | Schedules and event triggers sit with the bot; results and exceptions arrive in its chat. | Routines exist with four schedule kinds; the [flexibility plan](flexibility-plan-20261110.md) P3 extends them. |
| 10 | **A calm interface** | A roster of bots instead of a chat history; the avatar shows whether a bot is idle, working, waiting, blocked or done; five concepts in total; emails and events as cards in the transcript. xAI says it cut features that add supervision work. | A roster with companion avatars. The avatar has one state (working). About forty named destinations in the interface. |

## What people complain about

Each of these is an opening for Tupies.

| Complaint | What they say | Tupies today |
| --- | --- | --- |
| **Usage runs out and nobody can see why** | A $200 plan spent in 14 hours; an allowance at 99% in three days; long chats re-read their whole history each turn; users cannot see which bot or task spent it; they ask for "clear chat", context pruning and cheaper models. xAI called the cost of serving it "unsustainably high". | A usage line under every reply, an optional task budget, compaction with a 128K ceiling, new chats, and a free choice of model. There is no view of usage per bot or per day. |
| **It says "done" when it is not** | The three-week reviewer's reason for three stars: the bot claimed to have finished tasks or checked documents it had not, and did not offer to redo them. | The engine records what tools really did, checks required results and refuses to mark some unfinished work complete. None of this is visible to the owner as a sign of trust. |
| **No model choice, nothing to adjust** | Power users miss choosing a model and tuning behaviour. | Any provider and model per bot, reasoning effort, fallback. |
| **Bots are not isolated from each other** | All of a user's bots share one computer, its logins and its files; the documentation says separate bots are not a security boundary. Data storage on the vendor's side is mandatory. | A private workspace per bot, sealed credentials, self-hosted. An operating-system sandbox is planned as P1. |
| **Bland personality** | "No vibes"; not a bot one would want to spend time with. | Twenty-four companions and per-bot instructions; no ready-made tones of voice. |
| **No rehearsal, no audit view** | Test runs perform real actions; a per-action audit view is "coming". | Run history with tool receipts exists; no rehearsal mode for routines. |

## What to build

Two principles from xAI's design account are worth adopting outright: **delegation over operation** (cut anything that adds supervision work) and **few concepts**. Every item below should reduce what the owner has to manage.

### Quick wins (S each)

| # | Item | What the owner sees |
| --- | --- | --- |
| G1 | **Usage screen** | Per bot and per day: tokens, estimated cost, cached share, and the five tasks that used the most. Built from the usage summaries already stored on replies. This is the exact view Grok Bot's users are asking for. |
| G2 | **Readable approval cards** | Each card says in a sentence what will happen and lists its inputs ("Send an email to anna@… with subject …"), with the raw request behind "Details". |
| G3 | **"I'll remember that"** | When the owner corrects a bot, the reply carries a small card with what was learned and an Undo. |
| G4 | **Tones of voice** | A short list per bot (plain, warm, brisk, playful) next to the companion picker, plus a free-text field. |
| G5 | **Avatar states** | The companion shows working, waiting for you, blocked, and finished-unread, in the roster and on the phone. |

### Core (M each)

| # | Item | What the owner sees | Notes |
| --- | --- | --- | --- |
| G6 | **Create a bot by describing it** | One field: "What should this bot do?" The answer is a filled-in proposal (name, role, tools, skills, connected apps, a first routine) to confirm or adjust. The nine-section form stays under "Customize". | Uses the existing bot-setup tools. |
| G7 | **A chief of staff that runs the team** | An optional morning brief of what every bot did, what failed and what waits for the owner. Ask the chief of staff anything and it routes to the right bot. It raises only what needs a decision. | Needs one new read-only tool for the owner's primary bot: recent activity across bots. Brief and stand-up ship as routine templates. |
| G8 | **Proof of work** | Under a reply: "Checked: file exists · 3 sources read · tests passed", or "Not verified" when the bot claims something the engine did not observe, with a Redo button. | Surfaces receipts and outcome checks the engine already keeps. Answers the main reason reviewers stopped trusting Grok Bot. |
| G9 | **Watch and take over** | While a bot uses the browser: a small preview in the chat, expandable, with Take over and Hand back. | Builds on the existing sign-in handoff view. Follows xAI's three levels: status, preview, takeover. |
| G10 | **Approvals that travel and remember** | Approvals and questions alert the phone. A card offers "Always allow this" for one tool and one destination, revocable in settings. | The phone alert is listed as future scope in the notification docs; the scoped grant is item 4 of the OpenBot reuse plan's allowance area. |
| G11 | **Fewer places** | Main navigation reduced to Bots, Routines, Rooms and Settings. Workshop, Engine workshop, Desktop, Coding, Study and Missions move under one Advanced area, off by default. | Audit finding D5. |

### Larger (L each)

| # | Item | What the owner sees | Notes |
| --- | --- | --- | --- |
| G12 | **Connected apps with sign-in** | A gallery: Gmail, Google Calendar, Google Drive, Microsoft 365, Notion, Slack, GitHub, Linear. Connect with a sign-in button, several accounts per service, each with a label. Each bot is given accounts by name. | The most loved Grok Bot quality and Tupies' largest gap here. Many services publish a hosted MCP server with sign-in; Tupies needs MCP sign-in support and a gallery. Google and Microsoft need the owner to register their own app once, which a hosted product hides. See decision 1. |
| G13 | **Teach by showing** | "Show me once": the owner does the task in the bot's browser view; the bot writes a draft skill with the steps, to review and name. | Needs G9. A recording is a draft, as Grok's own documentation says; it should become a script where the steps are fixed (flexibility plan P2). |

## Order, together with the flexibility plan

| Step | Content | Why here |
| --- | --- | --- |
| 1 | P0 land the current branch; quick wins G1–G5 | Small, visible, and G1 and G2 build directly on work already in the branch |
| 2 | P1 sandbox; G8 proof of work | Both are about trusting unattended work |
| 3 | P2 scripts first; G6 create by describing; G11 fewer places | The first-minute experience |
| 4 | P3 routines; G7 chief of staff | The brief and stand-up are routines |
| 5 | P4 media and streaming; G10 approvals that travel | Both concern reaching the owner away from the desk |
| 6 | G12 connected apps; P5 providers | Two galleries with the same "add on one screen" pattern |
| 7 | G9 watch and take over; G13 teach by showing | G13 depends on G9 |

## Decisions (answered by the owner on 10 November 2026)

| # | Decision | Answer |
| --- | --- | --- |
| 1 | Connected apps: which services first? | Google first (Gmail, Calendar, Drive): "Google is a big win". The one-time registration of a Google app is accepted. |
| 2 | Should the chief of staff check on the team by itself? | Build the chief of staff; the daily brief is optional, not on by default. |
| 3 | May Missions, Study, Workshop, Desktop and Coding move under Advanced, off by default? | Yes. |
| 4 | Teach by showing | After watch-and-take-over (G9). |

The owner also asked to start with the quick wins G1–G5.
