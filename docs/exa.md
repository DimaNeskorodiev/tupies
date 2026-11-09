# Exa web search and page reading

Requested by the owner on 9 November 2026: web search and page reading were the weakest part of Tupies, so [Exa](https://exa.ai/docs) becomes the default search and page reader, with DuckDuckGo kept as the fallback. Source only until a release installs it on the Mac and VPS Engines.

## Setup

1. Create an API key in the [Exa dashboard](https://dashboard.exa.ai/api-keys).
2. In Tupies open **Settings → Integrations** and choose **Web search · Exa** (or **Connect a tool → Start with → Exa**).
3. Paste the key and save. Nothing else is needed: no bot assignment, no approval setting.

The key is sealed in the Engine vault like every integration credential, replicates to linked Engines through sync, and is redacted from tool output. The integration card shows **Default web search** and **All bots with Web tools**. To stop using Exa, delete the integration; bots return to DuckDuckGo immediately.

If several Exa integrations exist, the first one in the list is used.

## What bots get

The Engine recognizes the fixed contract `https://api.exa.ai` with a stored key and bearer or `x-api-key` authentication (`lib/exa.mjs`, `isExaIntegration`). With such a connection, every bot with **Web** tools gets:

- **`web_search {query, count?, includeDomains?, category?, startPublishedDate?}`** — Exa `POST /search` with `type: "auto"`, `contents.highlights: true` and up to 10 results. Results carry title, URL, query-relevant excerpts, publication date and author. The excerpt budget shrinks with the result count so a full list stays under the 16,000-character tool-result threshold and reaches the model directly instead of as a 2,000-character preview. `category` is one of `news`, `company`, `publication`, `financial report`, `people`, `personal site`. `startPublishedDate` is a calendar date (`YYYY-MM-DD`). Exa's reported cost (`reportedCostUsd`) and notices are kept with the result.
- **`web_extract {url, query?, maxCharacters?, offset?, fresh?}`** — a new core tool: Exa `POST /contents` for one public HTTPS URL, returning clean Markdown-style text (script-rendered pages and PDFs included). The default window is 12,000 characters (1,000–60,000); `nextOffset` pages a long document, and the Engine asks Exa for exactly `offset + maxCharacters + 1` characters. `query` adds up to 3,000 characters of the most relevant passages. `fresh: true` forces a live crawl (`maxAgeHours: 0`, 12 s crawl timeout) for prices and availability.
- Extra prompt guidance: read pages with `web_extract`, keep `http_fetch` for JSON APIs, POST and raw source, and use the search filters when recency or a specific site matters.

Neither tool asks for approval: both only read, and the Engine builds the request itself. A model can never pick the endpoint, headers or any Exa option other than the validated filters above. Result URLs are never fetched by the search adapter.

Without an Exa connection nothing changes: `web_search` is the keyless DuckDuckGo tool with its original schema, and `web_extract` is not offered.

## Fallbacks

```
web_search:  Exa ──fails──▶ DuckDuckGo (HTML → Lite) ──fails──▶ the bot's chosen fallback (exact approval)
web_extract: Exa ──fails──▶ direct public fetch with the same inert extraction as http_fetch
```

- Any Exa failure — timeout (20 s for search, 30 s for pages), HTTP 401/402/429/5xx, an invalid response, or a page Exa could not read — moves to the next step. The result keeps provenance: `fallback: {used: true, primaryFailure: {provider: "Exa", status}}` with statuses such as `unauthorized`, `payment_required`, `rate_limited`, `timeout`, `page_error` (with `pageStatus`) or `unavailable`. The run log records `search.fallback` / `extract.fallback`.
- A rejected key (401/403) or exhausted credits (402) also marks the Exa integration card **Needs attention** with the reason; bots keep working through the fallbacks, and the next request Exa accepts clears the mark. Rate limits, timeouts and outages do not mark the card. A request still in flight with a key the owner has since replaced cannot mark the new key.
- A Stop or cancellation never moves on to the next provider.
- DuckDuckGo honours a single `includeDomains` entry as `site:`; other filters are listed in `ignoredFilters`, never silently dropped.
- When Exa and DuckDuckGo both fail, the existing per-bot fallback (SearXNG, Tavily or Brave, chosen in bot settings) still needs exact approval, and the Exa failure is reported alongside.

## Integration with the rest of the Engine

`web_extract` is treated like `http_fetch` everywhere a page read matters: parallel reads, read-only failure classification (a failed read is reported as safe to retry and is never replayed as an action), the repeated-read guard, work receipts (`url`, and `httpStatus` for direct reads, where a non-2xx status is a failed read), `source_read` result checks, Mission source receipts, teammate source references, the research guard (counted as a page read) and the refused-site gate (the URL's site is gated after repeated refusals). Engine capabilities report `web_search_provider` (`Exa` or `DuckDuckGo`) and `web_extract`.

## Privacy and cost

Queries and page URLs go to Exa and are billed to the owner's Exa account. Exa's published pricing at the time of writing: search about $7 per 1,000 requests with contents for up to 10 results included; contents about $1 per 1,000 pages. Exa's [privacy policy](https://exa.ai/privacy-policy) allows using query data to improve its services. Check current pricing and terms when creating the key.

## Verification

- `test/exa-web.test.mjs` (13 cases) covers contract recognition, result normalization and budgets, filter validation, the exact `/search` and `/contents` request bodies, paging, every fallback path, cancellation, the Needs-attention mark, receipts and the site gate, and the Engine flow without assignment or approval.
- `test/exa-web-ui.test.mjs` (2 cases) covers the template card, the default badge (first Exa connection only, key required) and the preset form.
- A disposable local Engine showed the template card, the preset form, the saved card with **Default web search** / **All bots with Web tools**, the post-save text, and `features.web_search_provider: "Exa"`; the key was absent from public state.
- A real request to `api.exa.ai` with a deliberately invalid key returned HTTP 401, was classified `unauthorized`, fell back to the direct read and marked the card.
- The full release runner passed 2,305/2,305 before the final Needs-attention and wording changes; the 19 affected suites (152 tests) passed after them.

Not yet checked: a successful request with a real key, so real search quality, latency and cost are unmeasured.
