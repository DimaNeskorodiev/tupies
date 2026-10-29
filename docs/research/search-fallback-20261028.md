# DuckDuckGo fallback choices

Reviewed 28 October 2026 from current official documentation and the Tupies source. The owner selected DuckDuckGo as primary search, then requested an independent fallback. No provider account, subscription or live Tupies configuration changed. One disposable SearXNG container smoke test was completed and removed; production activation remains pending.

## Recommendation

Keep DuckDuckGo HTML → official Lite as the keyless first path. Those are two layouts of the same provider, so they do not address a DuckDuckGo-wide block or outage. Add one explicitly configured, assigned fallback, with its provider shown and exact integration approval preserved.

The owner selected **an owner-operated SearXNG instance**. It offers control of routing/logging and no per-query API vendor charge, at the cost of another maintained service. The [private deployment guide](../searxng.md) and `deploy/searxng/` prepare a loopback-only service with JSON enabled and DuckDuckGo excluded from its upstream engines. No service is activated automatically.

For an optional API setup, **Tavily Basic** is also supported: a key is required, but the documented free allowance does not require a card. Existing Brave remains an explicit option rather than being selected merely because a key happens to exist.

## Compared options

| Option | Verified setup and cost boundary | Product implications |
| --- | --- | --- |
| Tavily Basic | Official `POST https://api.tavily.com/search`, Bearer API key. Basic uses one credit; 1,000 monthly credits without a card, then the published pay-as-you-go rate is $0.008/credit. | A documented JSON API avoids another HTML parser. Query handling follows Tavily's policy: it may use portions to improve responses and may send queries to third-party indexes. It must remain an explicit owner choice. |
| Own SearXNG | Official `GET /search?q=…&format=json`; JSON must be enabled in the instance's `search.formats`. Hosting/maintenance costs replace a per-query vendor charge. | The owner controls the instance. Upstream engines can still block or challenge the instance. Partial upstream failures must stay visible. A private service uses the existing owner-configured integration transport, not a relaxation of public-web SSRF rules. |
| Brave Search API | Existing Tupies preset. Current Search price is $5/1,000 requests, with $5 monthly credits; a key and card are required. | Independent index and minimal additional code. Current standard terms restrict result retention beyond transient application operation; an appropriate plan/permission is needed for storing raw results in persistent transcripts or datasets. Do not describe the old 2,000-query free plan as current. |
| Exa | Search API, $7/1,000 requests; Starter advertises $10 monthly credits without a payment method. | Useful optional search/content API, but another integration and account. Its default privacy policy says query data is used to improve/train its services. No need to add it before the selected fallbacks are measured. |

These are provider-declared interfaces/prices/policies, not an independent reliability or answer-quality benchmark. Prices, terms and account entitlements should be checked at activation.

## Why public SearXNG roulette is unsuitable

Official SearXNG documentation warns that many public instances disable JSON, that users must trust the operator, and that abuse can cause upstream CAPTCHAs or IP bans. Automatically trying random public instances would send a private bot's query to unchosen operators with uncertain logging and availability. Tupies instead accepts an owner-supplied instance URL and keeps normal credential-destination, private-network, DNS-pinning and exact-approval checks.

There is no established dependable, zero-account, keyless independent generic-web API in this review. Wikipedia-style APIs are useful specific sources, but do not replace general web search.

## Implemented adapter boundary

`lib/web-search.mjs` recognizes fixed API contracts for Tavily Basic, SearXNG JSON and the legacy Brave adapter. `availableSearchFallbacks` returns only owner-configured integrations assigned to the bot with both Web and Integrations enabled. `searchFallbackIdentity` binds URL, credential and declared operation. `searchFallback` requires an unchanged identity and exact approval, then makes one request with a 20-second abort ceiling. The engine separately bounds the primary-plus-fallback path and preserves the primary failure/provider provenance.

Tavily requests fix `search_depth: basic`, turn automatic parameter selection off, and exclude answers, images and raw page contents. SearXNG uses the fixed `/search` JSON operation and returns at most ten normalized candidates. API responses are already byte-bounded by the integration transport; normalization inspects at most 100 candidates, strips markup from display text, deduplicates URLs and rejects non-public/non-HTTPS result syntax. Result URLs are not fetched by the adapter. Unresponsive SearXNG engines and unusable candidates produce explicit partial coverage, not invented no-results success.

Fallback is appropriate after a primary challenge, timeout, rate-limit, service or layout failure. Genuine empty results, cancellation, denied approval, invalid input and SSRF-policy refusal must not cause a provider switch. A credentialed fallback is never automatically retried. Missing configuration remains an honest unavailable state.

## Runtime evidence and limit

The prepared private SearXNG configuration ran in an isolated temporary Docker project using the official immutable image version `2026.10.28-c360868e5`. Health and JSON endpoints returned 200 for the generic query `Node.js documentation`; 24 candidates arrived in 926 ms and five were normalized. Brave supplied results, while Bing had a connection error and Google denied access. Partial coverage was preserved. The project, private test configuration and its cache volume were removed afterward; no production service was activated. See [the reproducible deployment and smoke-test record](../searxng.md).

This single query confirms the API/deployment path and demonstrates upstream failure handling. It does not measure general reliability, compare answer quality or prove Grok Bot parity. An owner-operated metasearch service still depends on its upstream engines and egress address.

## Primary references

- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search), [credits and pricing](https://docs.tavily.com/documentation/api-credits), [privacy policy](https://www.tavily.com/privacy).
- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html), [private-instance guidance](https://docs.searxng.org/own-instance.html), [upstream blocking and limiter](https://docs.searxng.org/admin/searx.limiter.html).
- [Brave current pricing](https://brave.com/search/api/), [account/credits FAQ](https://api-dashboard.search.brave.com/documentation/resources/help-feedback), [Search API terms](https://api-dashboard.search.brave.com/terms-of-service).
- [Exa pricing](https://exa.ai/pricing), [Search API](https://exa.ai/docs/reference/search), [privacy policy](https://exa.ai/privacy-policy).
