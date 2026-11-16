# Bots can add their own connections

Requested by the owner on 16 November 2026: “Bots must be able to create and add their own tools. If the engine has no Gmail integration, the engine must let the model add that tool and integration itself.” **Status: source only** on branch `feature/bot-authored-tools-20261116`. It is not installed on the Mac or VPS Engine and not released. No real Google account has been connected yet; the flow is proven against a local fixture that imitates Google (see [verification](verification.md)).

## The flow

1. You ask a bot for something in an outside service (“check my Gmail”) and no assigned tool covers it.
2. The bot loads its **integrations** tool group, checks `integration_list`, and calls `integration_propose` with a definition: service name, base address, how you sign in (API key, key header, OAuth 2.0 or none), the actions it needs, plain **setup notes** for you and one sentence of **reason**.
3. You get an approval card. It is never approved automatically — not under Approve for me, not by the risk reviewer — and it only appears in your own direct chat with the bot. Routines, teammates, rooms and other people's chats cannot propose a connection.
4. After you approve, the Engine creates the connection **without any credential**, assigns it to that bot only, and marks it `needs_credentials`. Nothing is sent to the service yet.
5. Under the bot's reply a **connect card** (“Connect Gmail”) asks you to connect it. It names the bot that asked, why, and the only addresses your key or sign-in goes to; the bot's own setup steps and the list of actions (each marked Reads or Changes) are in two collapsible sections. You paste the API key, or copy the return address, enter the OAuth client ID and secret and press Sign in. The same connection is in **Settings → Integrations** with an “Added by <bot>” tag, a status (Needs your key, Needs sign-in, Sign in again, Connected) and a Connect button.
6. Once connected, the card collapses to “Gmail is connected” with a **Continue** button; pressing it sends the bot an ordinary message from you, and nothing is sent until you press it. It calls `integration_list` again and uses the actions with `integration_call`. **Every call still needs your approval** of its exact arguments, as for any integration.

The model never sees, supplies or stores a key, client secret or token. A proposal that contains a credential-like field (`apiKey`, `token`, `clientSecret`, a header such as `Authorization` or `X-Api-Key`, an extra sign-in parameter such as `access_token`) is refused before any card is shown.

## What the approval card shows

One plain line above the exact arguments, for example:

> Add a connection “Gmail” to gmail.googleapis.com — 4 actions (2 read, 2 can change things). Sign-in: OAuth at accounts.google.com (tokens from oauth2.googleapis.com). You enter the key or sign in yourself afterwards.

The host names are what you are trusting: requests go to the API host, you sign in at the authorization host, and the client secret and tokens are exchanged with the token host. Check that they are the service's official addresses. “Read” counts GET actions; everything else “can change things”. An MCP proposal says that its tools are discovered after you connect it.

A bot can also change a connection assigned to it (`integration_propose {integrationId, …}`), again only with your approval. The card names what changes and what happens to your sign-in:

- Adding, changing or removing actions, renaming, or resending identical sign-in settings keeps the saved key or sign-in.
- A new base address, sign-in method, key header or OAuth endpoint removes the saved key or sign-in: “Its saved key or sign-in will be removed and you connect it again.”
- A new token address also removes the saved OAuth client secret, because the secret is sent to that address.
- Different OAuth scopes keep the current sign-in working and suggest that you sign in again to grant them.

## API key or OAuth

- **API key** (`bearer`, or `header` with a header name): paste the key in the connect card or Settings. It is sealed in the vault (AES-256-GCM) and sent only to the connection's base address.
- **OAuth 2.0** (`oauth2`): you create an OAuth client at the provider, enter its client ID and secret in Tupies and press **Sign in**. Tupies uses the authorization-code flow with PKCE (S256) and a single-use state that expires after 10 minutes. The provider sends you back to Tupies' return address, `/api/integrations/oauth/callback`, which finishes the sign-in. Tokens are sealed with the client secret; the access token is renewed a minute before it expires, and concurrent calls share one renewal.
- If the service later refuses the renewal (`invalid_grant`, for example because you revoked access), the connection becomes **needs_reauth**: bots are told you must sign in again, the Dashboard shows it under what needs you, and the client ID and secret stay so you only press Sign in.

The **return address** is shown by Tupies (`GET /api/integrations/oauth/redirect`) and must be registered exactly at the provider:

- On a VPS: `STUDIO_PUBLIC_URL` + `/api/integrations/oauth/callback`, for example `https://studio.example.com/api/integrations/oauth/callback`.
- On a Mac: the address the Engine serves, for example `http://127.0.0.1:4311/api/integrations/oauth/callback` (`https://` when the Engine serves its own TLS).

It never comes from a request's Host header.

**Manual fallback.** If the provider's redirect cannot reach the Engine (a certificate warning, a phone, a tunnel), copy the full address from the browser's address bar after you approve at the provider and paste it into the connect card (`POST /api/integrations/{id}/oauth/complete {redirectUrl}`). The same state and PKCE checks apply.

## Hosted MCP servers: automatic sign-in

Source only (16 November 2026), not installed or released. Official hosted MCP servers (Linear, Notion, Todoist, ClickUp, Atlassian and others) publish how to sign in. For those, a bot proposes only the server address with `authType:'oauth2'` and no `oauth` settings, and the approval card says: *Sign-in: found from the server when you connect; you see the sign-in address before you sign in.* No developer console, client ID or secret is needed.

What you do:

1. Approve the proposal. Nothing is sent to the server yet.
2. In the connect card or Settings → Integrations, press the control that prepares the sign-in (`POST /api/integrations/{id}/oauth/discover`). Tupies shows the **sign-in host** and the **token host** it found.
3. If those hosts are what you expect, press **Sign in** and approve at the service. Tupies lists the server's tools right after the sign-in; if that fails, **Test** lists them.

What the Engine does (MCP authorization, 2026-07-28 revision with the earlier fallbacks):

- It sends one `initialize` request without any credential and reads the `401` answer's `WWW-Authenticate` header for `resource_metadata` and `scope`; otherwise it tries `/.well-known/oauth-protected-resource/<path>` and then `/.well-known/oauth-protected-resource`.
- From that document it takes the first authorization server and fetches its metadata in the order the specification requires (OAuth metadata with the path inserted, OpenID Connect with the path inserted, OpenID Connect with the path appended; for an issuer without a path, OAuth then OpenID Connect). The `issuer` must match exactly, the resource must be this server (same origin, the same path or a parent of it), and **PKCE S256 must be declared**, or the server is refused.
- Older servers (2025-03-26) without that document: the authorization-server metadata at the MCP server's own origin, and if that is missing (404) the default `/authorize`, `/token` and `/register` there, but only when the server answered `401` and its `/register` exists.
- Client: with a public HTTPS address (`STUDIO_PUBLIC_URL`) and a server that supports client ID metadata documents, the client ID is `https://<your address>/api/integrations/oauth/client.json`, which the Engine serves. Otherwise Tupies registers itself (RFC 7591) as a public client named “Tupies” for exactly this Engine's return address (`application_type` native on a Mac, web on a VPS). A secret the server issues anyway is sealed like a typed one. Re-preparing reuses the registration while the sign-in server and return address stay the same, and registers again when the Engine's return address changed.
- The sign-in and every token request carry `resource=<the MCP server>` (RFC 8707). When the server promises the `iss` response parameter (RFC 9207), a sign-in answer without it, or from another issuer, is dropped before its code is used.

Fallbacks: if the server publishes nothing usable, preparing fails with “It may need a token instead”: choose **bearer token** (or an API key header) when the service documents one, or turn automatic sign-in off and enter the OAuth details by hand. If the server offers no registration, the endpoints are still filled and only the client ID is missing: create a client at the service and enter it. If the server refuses registration, the message says so; the same two fallbacks apply.

What it never does: discovery runs only when you ask for it, never from a bot or after a failed call. A sign-in the server stops accepting becomes **needs_reauth** as usual; a different sign-in server found later only takes effect when you prepare the sign-in again and sign in, so you always see the new host first. Changing the server address forgets the discovery, the registration and the sign-in.

## Gmail step by step

Tupies includes a **Gmail** preset (`lib/gmail.mjs`) with search, read, send and label actions. A bot can propose the same definition itself.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (or pick one).
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **OAuth consent screen**: choose **External** (or **Internal** for a Workspace domain), fill in the app name and your email, add your own address as a **test user**, and add the scope `https://www.googleapis.com/auth/gmail.modify`.
4. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorised redirect URIs** add the return address Tupies shows (above). Google accepts `http://127.0.0.1:<port>` for a Mac. For a server it needs HTTPS **and a domain name**: Google refuses redirect addresses on a bare IP address such as `https://203.0.113.5`, so a VPS reached only by its IP cannot use Google sign-in yet (see the follow-ups in the [roadmap](roadmap.md)).
5. Copy the **client ID** and **client secret** into the connect card (or Settings → Integrations) and press **Sign in**. Approve at Google; the tab says “Connected — you can close this tab”.

Things to know:

- While the consent screen's publishing status is **Testing**, Google expires refresh tokens after **7 days**; the connection then shows needs_reauth and you sign in again. Publishing the app removes that limit but needs Google's verification.
- Gmail scopes are **restricted scopes**. A personal app used only by its test users works without verification; anything wider needs Google's review and a security assessment.
- `access_type=offline` and `prompt=consent` are sent so Google returns a refresh token every time you sign in.
- Scope: `gmail.modify` alone. The label action needs it, and it already includes reading and sending. Permanent deletion (`https://mail.google.com/`) is not in the preset; a bot that proposes a delete action must ask for that scope, and you see it on the card.

## Limits

- One connection per proposal; at most 12 proposed by one bot and 100 integrations in all. At most 64 actions, 8 static headers and 8 extra sign-in parameters.
- A proposed connection is assigned only to the bot that proposed it. Assign it to other bots in their settings.
- Remote MCP servers over Streamable HTTP only, with a bearer key, an API key header, OAuth with endpoints you enter, or automatic sign-in (above). No local (stdio) MCP servers. Automatic sign-in uses the first authorization server a server lists, and has no allowlist of services Tupies may register with.
- Disconnecting forgets the tokens in Tupies; it does not revoke them at the provider. Revoke access in the provider's account settings if needed.
- Linked engines share the sealed client secret and tokens through sync, and each engine renews them by itself. Google keeps its refresh token on renewal, so that is safe; a provider that issues a new refresh token on every renewal can invalidate the other engine's copy, which then shows needs_reauth.
- Scripts and Workshop tools cannot use a connection's credentials; only `integration_call` (and the Workshop API gateway for approved REST GET reads) can.

## Action definition reference

A REST action is `{name, description, method, path, inputSchema, query?, encode?, decode?}`; the integration may add `headers`.

| Field | Meaning |
| --- | --- |
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. GET sends all inputs as query parameters; other methods send them as a JSON body. |
| `path` | A fixed path under the base address. `{name}` placeholders take a **required** string or integer input; the value fills one path segment, is URL-encoded and may not contain `/`, `\`, control characters or be `.`/`..`. No query string or fragment in the path. |
| `query` | For non-GET actions: input names sent as query parameters instead of in the body. |
| array values | A list input sent as a query parameter is repeated: `labelIds=INBOX&labelIds=UNREAD`. |
| `encode` | `{input: "base64" \| "base64url"}`: the bot writes plain text and the Engine encodes it (UTF-8) before sending. `integration_list` tells the model so it does not encode twice. |
| `decode` | `{keys: [...], as: "base64" \| "base64url"}`: response strings under these keys, at any depth, are replaced by their text when they decode to printable UTF-8; binary data stays as it was. Bounded to 1 MB of decoded text per response. |
| `headers` | Integration-level fixed, non-secret headers such as `Notion-Version: 2022-06-28`. Authentication, `Host`, `Cookie`, `Content-Type` and other engine headers cannot be set here; a bot cannot propose a credential-like header name. |
| `approval` | Owner-only: `"auto"` lets a GET run without asking. A bot's proposal cannot set it. |

An empty successful answer (such as HTTP 204 after DELETE) reaches the model as `{status: 204, note: "The service accepted the request and returned no content."}`.

A complete Gmail definition, as a bot would propose it (the preset is the same without `delete_message` and the wider scope):

```json
{
  "name": "Gmail",
  "type": "rest",
  "baseUrl": "https://gmail.googleapis.com",
  "authType": "oauth2",
  "oauth": {
    "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenUrl": "https://oauth2.googleapis.com/token",
    "scopes": ["https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"],
    "extraParams": {"access_type": "offline", "prompt": "consent"}
  },
  "tools": [
    {"name": "search_messages", "description": "Find messages with Gmail search syntax.", "method": "GET",
     "path": "/gmail/v1/users/me/messages",
     "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}, "maxResults": {"type": "integer", "minimum": 1, "maximum": 50},
       "labelIds": {"type": "array", "items": {"type": "string"}}, "pageToken": {"type": "string"}}, "additionalProperties": false}},
    {"name": "read_message", "description": "Read one message.", "method": "GET", "path": "/gmail/v1/users/me/messages/{id}",
     "decode": {"keys": ["data"], "as": "base64url"},
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "format": {"type": "string", "enum": ["full", "metadata", "minimal"]}},
       "required": ["id"], "additionalProperties": false}},
    {"name": "send_message", "description": "Send one email; raw is the whole RFC 822 message.", "method": "POST",
     "path": "/gmail/v1/users/me/messages/send", "encode": {"raw": "base64url"},
     "inputSchema": {"type": "object", "properties": {"raw": {"type": "string"}, "threadId": {"type": "string"}}, "required": ["raw"], "additionalProperties": false}},
    {"name": "modify_labels", "description": "Add or remove label ids on one message.", "method": "POST",
     "path": "/gmail/v1/users/me/messages/{id}/modify",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "addLabelIds": {"type": "array", "items": {"type": "string"}},
       "removeLabelIds": {"type": "array", "items": {"type": "string"}}}, "required": ["id"], "additionalProperties": false}},
    {"name": "delete_message", "description": "Permanently delete one message.", "method": "DELETE", "path": "/gmail/v1/users/me/messages/{id}",
     "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"], "additionalProperties": false}}
  ],
  "setupNotes": "Create a Google Cloud project, enable the Gmail API, add yourself as a test user, create a Web application OAuth client with the return address Tupies shows, then paste the client ID and secret and sign in.",
  "reason": "You asked me to check your Gmail, and no mail connection exists yet."
}
```

`modify_labels` sends `{addLabelIds, removeLabelIds}` as the JSON body and the id in the path; `send_message` sends `{"raw": "<base64url of the text>"}`.

## Where it lives

`lib/integration-proposals.mjs` (the tool, checks, approval line, `connectionRequests`), `lib/integration-oauth.mjs` (sign-in, renewal, owner routes and the callback), `lib/integrations.mjs` (actions, validation, readiness in `integration_list`), `lib/integration-readiness.mjs`, `lib/gmail.mjs` (preset). Routes are in [API](api.md#integrations); threat notes in [security](security.md#bot-proposed-connections-and-integration-sign-in).
