# Research and primary references

## Grok Bot and the combined improvement plan

The [Grok Bot 0.77.0 comparison](research/grok-bot-0.77.0.md) traces the supplied desktop package's service/gateway routing, coordinator, separate local execution daemon, submission reconciliation, app-scoped device policy, forms and shared-knowledge review. Backend inference/context/recovery and live quality remain unknown. The [combined Tupies improvement plan](plans/studio-best-of-openbot-grok.md) joins those findings with OpenBot's task/history/resource design, using the current A–C context baseline. This is proposed work; no engine deployment or application change follows from the investigation.

## OpenBot architecture comparison

The [OpenBot 0.52.1 comparison](research/openbot-0.52.1.md) records the 27 October 2026 static investigation of the supplied Apple Silicon package, the current Tupies checkout and current official Hermes Agent references. It traces runtime adapters, browser/device tools, context recovery, SQLite task coordination, collaboration and permission defaults, and proposes a staged Tupies direction. Observed package/source behavior is separate from proposed changes and unmeasured live reliability. The investigation did not change application behavior or deploy either engine.

## Independent implementation

Tupies 0.2 implements its own Node agent engine and tool lifecycle. Hermes and Grok Bot informed the product requirements and reference behavior. Neither is a required runtime, installed dependency, agent gateway or credential source.

The earlier investigation inspected the open-source [Hermes repository](https://github.com/NousResearch/hermes-agent) at commit `9976f4857b72439d79016354d7b6e1a3ee952e2f`. This was ordinary source inspection under the reverse-engineer-anything skill, which does not require decompilation for a complete source tree. The reviewed architecture, skills, profiles and bot concepts motivated the initial interface; the gateway adapter has now been replaced by Tupies Engine.

REA browser observation of the supplied [Grok Bot page](https://x.ai/bot) reached a Cloudflare block. Evidence `ev_38e9bf88d368bc8fe3e7b59c19b82558cf7763967685b2679c6e295bd4d34382` records that bounded Chromium navigation/wait/DOM/accessibility capture and owned-process cleanup. It does not establish the authenticated Grok app's behavior or pixel layout. Tupies's glass interface is original.

## Coding-agent tool reference

The 26 October 2026 tool-use work used Anthropic's [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) and [agent-loop description](https://code.claude.com/docs/en/how-claude-code-works) as behavioral references. These describe file discovery/reading/editing, execution, web access and orchestration as tools feeding a gather/action/verification loop. The installed Claude Code artifact was also selected for bounded REA inspection; the exact observed evidence and its limitations are recorded in [Tool use](tool-use.md).

Tupies's workspace tools, read batching, plans and output paging are independent implementations. Their API names, resource limits, private-workspace scope and exact-approval rules are Tupies design choices. Documentation or static artifact observations do not establish live parity, provider quality, full tool coverage or equivalent security isolation. No Claude Code installation is required at runtime.

## Implemented protocol sources

| Primary source | Implementation use | Verification boundary |
| --- | --- | --- |
| [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) | Tupies executes the model/tool loop, preserves tool identities and returns results to the next model request. | Local protocol fixtures; no user inference account used in automated tests. |
| [Sign in with ChatGPT overview](https://developers.openai.com/siwc/token-sharing-open-source) | Local/open-source registration, stable host identity and direct plan-authorized Responses access. | Paid/remotely hosted products require separate OpenAI onboarding. |
| [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | PKCE, state, nonce, issued client ID and signed ID-token verification. | Tested with a real signed local RSA fixture, not an actual user's login. |
| [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions) | Isolated registrations, rotating refresh and revocation. | Ambiguous renewal freezes the local grant instead of replaying it. |
| [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | Account-specific slug/display_name catalog, store:false streaming Responses, terminal completion checks. | Model access is confirmed only by a completed actual inference request. |
| [OpenAI OIDC discovery](https://auth.openai.com/.well-known/openid-configuration) | Official issuer, token endpoint, JWKS and revocation metadata. | Fetched from the issuer; origins are validated. |
| [Anthropic Messages](https://platform.claude.com/docs/en/api/typescript/messages/create) | Native message/tool blocks, tool results and streaming events. | Account model access and tool capability remain provider-specific. |
| [GitHub REST](https://docs.github.com/en/rest/repos/repos) and [request headers](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api) | Authenticated repository template and service User-Agent. | Token scopes and organization policy determine visible data. |
| [Slack conversations.list](https://docs.slack.dev/reference/methods/conversations.list/) and [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) | Fixed-path channel listing and approved message actions. | Appropriate token scopes/channel access are required. |
| [Telegram Bot API](https://core.telegram.org/bots/api) | getMe verification, allowlisted getUpdates ingestion and actual sendMessage replies. | Local protocol fixtures; no real account or recipient contacted. |
| [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | JSON-RPC initialize/list/call, session/version headers and JSON/SSE responses. | The implemented transport does not launch stdio servers or support all MCP extensions. |

No undocumented ChatGPT backend endpoint, borrowed Codex token, hardcoded private OAuth client or subscription bypass is used. No claim of complete Hermes/Grok/Claude Code product parity follows from matching these core engine concepts. Native computer use, mobile/desktop device clients, continuous real-time voice and additional messaging-platform adapters remain distinct future work. Browser dictation/read-aloud and Telegram are implemented within their documented boundaries.

The implementation's actual checks and remaining validation limits are recorded in [verification.md](verification.md). Source observations, protocol fixtures and live-account behavior have different scopes; do not treat one as proof of the others.
