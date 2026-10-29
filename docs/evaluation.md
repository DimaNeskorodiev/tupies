# Agent evaluation

`npm run eval:agent` exercises Tupies on new disposable stores and private fixture workspaces. It does not read `.env`, import operational chats, start the scheduler or restart an engine. Temporary data is removed after each case. Reports contain checks and metrics, not private prompts, answers, credentials or provider URLs. Reading a running home engine's current subscription grant requires the separate owner opt-in below.

## Deterministic coverage

```sh
npm run eval:agent -- --list
npm run eval:agent -- --mode fixture --repeat 3 --output output/eval/fixture-report.json
```

The eight families cover research-to-document, a constrained coding edit with actual test exits, exact beginning/middle/end requirements after three compactions, a memory correction with a contradictory imported note and paraphrased follow-up, paged reading/stale-edit refusal, a required specialist's failed check, questions/refusal, and submission/Stop/restart mechanics. Real engine tools and persistence run with a scripted provider. Independent checks read actual files/state, arithmetic examples, source IDs and lifecycle outcomes. Scripted fixture results establish harness behavior, not a model's ability to choose the right action or Grok superiority.

Corpus `tupies-agent-quality-v4` explicitly requests a **downloadable** Markdown research report. It accepts the requested sum labeled `Sum` or `Total`, ordinary Markdown/prose fields, an affirmative commute/home-city answer without fixed wording, and any declared check ID tied to the exact required specialist file. Negative regressions still reject wrong values/totals, an authoritative old city, and missing/unrelated/passing specialist checks. Initial live reports from the prior corpus remain historical evidence: retained synthetic outputs demonstrated correct `Sum: 200`, Warsaw commute/conflict reasoning and a failed `required-review-file` check that those older wording/ID oracles rejected. A missing artifact card remains a separate product-affordance check; the revised downloadable requirement is a new prompt, not a retroactive reinterpretation.

The coding oracle is one static Node `--test` script outside the model-writable workspace. Its SHA-256 and exact executable/arguments/folder/timeout are registered before the task; only that unchanged command receives fixture approval. It reads the generated source as text, accepts only a small add-function grammar and evaluates the extracted operator against examples. It never imports or executes generated JavaScript. The baseline must actually exit nonzero, the model requests the exact verification command after editing, its real tool receipt must report exit zero, and every other workspace file must remain unchanged. Changed test bytes, extra arguments and arbitrary commands remain denied. Research checks verify a Markdown file, fixture values/sum, source ID and recorded artifact; they do not judge arbitrary prose quality. A passing model-written plan or a confident answer is never the test oracle.

`large-result-image` verifies text paging and an actual red PNG sent through `workspace_image` and the provider image-parts route. The scripted provider decodes the returned bytes; a live model's color answer has the same fixed-image oracle. The fixture also changes a file after the model reads its hash, verifies the stale edit is refused, and checks the concurrent contents survive. When the active model does not offer the image tool, the report records that capability gap; a failed supported text/stale-edit check still counts as a failure and is never hidden by the image gap. `--image-input on|off` can explicitly state a custom endpoint's vision support; otherwise provider metadata/family rules apply. Stop/restart injection remains deterministic even when other tasks use a real provider; no external side effect is initiated.

## Explicit real-model runs

API runs require a dedicated credential in `STUDIO_EVAL_API_KEY`, an explicit provider/model, and explicit USD prices per million input/output tokens. The CLI supports the engine's API providers and a local Ollama-compatible service. Subscription acceptance is separately opt-in; it never copies a live connection record into the fixture store.

```sh
npm run eval:agent -- --mode live --provider ollama --model YOUR_LOCAL_MODEL \
  --input-price 0 --output-price 0 --cases research-document,coding-verification \
  --max-inferences 8 --max-tools 16 --max-ms 120000 --max-tokens 200000 \
  --max-output-tokens 2048 --max-cost 1 --output output/eval/local-model.json
```

For an API provider, choose its configured protocol (`openai`, `anthropic`, `xai`, `openrouter` or `custom`) and its actual price rates. An optional `--base-url` is checked by the normal credentialed provider transport. The credential goes only to that explicitly selected destination. API calls may be billed. A model may request actions in the disposable workspace; every action requiring approval is denied except the coding case's one exact, unchanged static oracle command. No terminal code generated by a model is executed.

Per-case inference/tool/time bounds and a suite token/cost admission ceiling prevent further dispatch when reached. API requests include the protocol's output-token limit. Input admission reserves serialized UTF-8 bytes plus protocol overhead; when usage is absent, the reservation stays charged. Provider billing and token accounting are external, so the last dispatched request can exceed an estimate; a reported ceiling stops subsequent dispatch. Interrupted or budget-exhausted work is not counted as completed.

### Explicitly authorized ChatGPT subscription acceptance

The owner authorized synthetic acceptance using their existing subscription on 28 October 2026. This authorization does not make ordinary evaluation commands read account data. Select it explicitly for each run:

```sh
npm run eval:agent -- --mode live --provider chatgpt --model YOUR_AUTHORIZED_MODEL \
  --authorized-subscription --subscription-source /absolute/path/to/running/home-engine/data \
  --subscription-connection YOUR_CONNECTION_ID --cases research-document,coding-verification \
  --max-inferences 8 --max-tools 16 --max-ms 120000 --max-tokens 200000 \
  --max-output-tokens 2048 --output output/eval/subscription.json
```

The source must be an already running home or standalone engine, with one eligible connection or the selected ID. The reader opens its key and atomically replaced state file read-only, decrypts only the selected OAuth bundle in memory, and returns sanitized model metadata plus the current access token. It never calls `Store.init` there, copies transcripts/account records, writes source state, or renews/replays a copied refresh token. A fresh source read precedes every request, account identity stays fixed, and expired, renewing, ambiguous or changed grants fail closed. Only the source home engine may renew its own grant. `runEvaluation(options, {subscriptionGrantReader})` also supports an explicitly supplied read-only remote reader; it must obey the provided abort signal and the same grant contract.

The adapter uses the [official Responses endpoint and bearer flow](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference). The [current subscription preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) reject `max_output_tokens`, so the requested output allowance is an admission estimate, **not a remotely enforced subscription output-token cap**. Subscription requests omit it, namespace offered functions as `tupies`, and validate returned function namespaces/names before dispatch. [Responses schema](https://developers.openai.com/api/reference/resources/responses/methods/create) keeps tool name and namespace as separate fields. Canonical engine history stays intact when switching providers.

Subscription runs still use per-case time, inference/tool admission, an 8 MB response transport bound and subsequent-request token admission. A dispatched response may exceed the requested token reservation. Monetary cost and cost reservation are `null`; this runner cannot infer subscription quota/billing from token counts. Reports omit the source path/connection identity, and the disposable store contains no OAuth secret, refresh token or account record. This opt-in must be independently reviewed before a real run; deterministic adapter tests do not prove subscription availability or real-model task quality.

Start with raw timings and medians, not a p95 from three runs. Missing usage/cache/cost is `null`, not zero. Reports retain source-file SHA-256 values, fixture identity, model/provider, caps and permission behavior. Full raw traces remain outside reports. Treat real-provider results as a finite task sample and use a human rubric for qualities the mechanical checks cannot verify.

Schema version 2 reports per-case usage and raw repeat timings with median/range/population standard deviation. Its finite quality ledger includes known false-success counts among observed completed tasks, exact-constraint retention, source correctness, unauthorized-change checks and duplicate-effect checks. Every rate has a denominator; an unmeasured category is `0/0` with `rate:null`, not a success. Checks label their measurement category. Expected incomplete specialist work passes its oracle only when the actual child check fails and the required result prevents parent success. Automated answer/denial/static-command approval counters are separate from `humanInterventions`, which remains unknown until actual people are measured. The fixed examples are a starting baseline, not comprehensive safety or general task-quality coverage.

## Local retrieval corpus

```sh
npm run eval:retrieval -- --k 4 --output output/eval/retrieval-report.json
```

`eval/retrieval-corpus.mjs` versions 12 public fixture queries, explicit relevant IDs, source dates, a corrected city and stale imported report, English paraphrases, Ukrainian/Polish queries, a short follow-up and a third-party-lane canary. Labels are agent-authored and reviewable; **human review is pending**, so this is not a human-validated benchmark. `eval/retrieval-runner.mjs` invokes the actual core-fact selector, Brain recall and scoped history search on temporary notes/history. It uses no provider, account, network, embedding or model-written answer.

The report measures precision@k, recall@k, relevance of returned sources, validity of source IDs/note hashes, stale candidate retrieval, negative-query abstention and excluded-lane candidates. Precision@k uses fixed k for positive queries, so returning one perfectly relevant note at k=4 scores 1/4; returned-source relevance separately describes that case. Unmeasured rates stay null. Retrieving an old history entry is measurable; whether a model would use the stale fact is still unknown.

The 28 October k=4 fixture run found relevant IDs 41/41, precision 41/124, returned-source relevance 41/84 and valid source references 84/84, with one stale history candidate and no private-lane candidate. For core facts, current task relevance found 21/21 labeled IDs versus 12/21 for the explicit recency-only comparator; precision was 21/44 versus 12/44. That comparator has the same pins/k and is **not** a historical live version. These finite measurements expose broad candidate selection and the stale-history risk; they do not prove real-model first-answer or multi-day improvement. Misses/low precision remain recorded rather than changing the ranker to make the corpus pass.

## Comparing products

The product's built-in `web_search` uses keyless DuckDuckGo under the Web tool group. The evaluation fixtures deliberately use local sources and disable public web transport, so their research score does not measure live search availability, ranking or freshness. Dedicated DuckDuckGo tests check fixed-endpoint requests, bounded inert HTML/Lite parsing, wrapped public URLs, cancellation, rate limits, challenge pages and explicit no-results states. One primary search makes at most two requests to the official DuckDuckGo layouts, within 20 seconds total; an explicit rate limit does not trigger the second endpoint. Actual 28 October public smoke reads found an HTML challenge and three parsed public HTTPS results through the official Lite endpoint. No challenge was solved and no alternative provider was contacted in that smoke test. The owner may select an assigned SearXNG, Tavily or Brave integration for one exact-approved fallback request after an availability failure. Separate fallback tests cover approval, changed identity, refusal, cancellation, partial upstream coverage and genuine empty results. A disposable SearXNG container also supplied actual JSON results; see [verification](verification.md) and [setup](searxng.md).

For Grok, seed the same memories/files and use the same task wording, dates, allowed actions and independent output checks. Record capability differences and the model/account configuration available to each product. Grok's managed model may not be selectable, so this measures end-to-end product behavior; Tupies before/after comparisons should separately hold its model and inference settings fixed. No Grok account run or live-provider quality result is supplied by the deterministic runner.

Generated reports belong in ignored `output/eval/`, outside release packages. Engine/tool/persistence changes still require the complete regression suite; this runner supplements those tests.

## Human review for real answers

`runEvaluation(options, {onCaseComplete})` optionally delivers redacted synthetic outputs to an explicit callback before temporary cleanup. Default runs retain no answer text or artifact bytes. The callback receives the corpus/version hash, case/status, bounded final assistant display answers for the case's actual runs, and independently verified fixed expected text outputs. It never receives prompts, engine state, credentials, tools, provider items or arbitrary workspace files. Currently only the research case's `report.md` bytes are eligible, at a 256 KB source bound; retained text is redacted and bounded again. `recordedArtifact:false` preserves the distinction between an existing expected output and a missing product artifact card. Symlinks, outside paths and unlisted files are excluded. Keep callback output private and outside release packages; the ordinary report records capture counts/failure only. This is synthetic-corpus inspection, not a way to export operational chats.

Mechanical passes do not grade arbitrary prose. For each real-model answer, record a separate human assessment of factual support, coverage of the requested outcome, usefulness of the delivered artifact, and honesty about uncertainty/incomplete work. Score each dimension 0 (fails), 1 (needs correction), or 2 (meets the request), with a short source-backed reason. Record human questions/corrections and time spent separately from scripted owner-control responses. Keep private answer text outside shareable reports. This rubric is defined; no human-rated real-model comparison was performed in the fixture run.

The v4 acceptance checks additionally require the actual engine outcome to be completed for every expected-success family, including both memory tasks. Equivalent numeric grouping, supported date/color notation and explicit negated success are normalized; wrong values/currency/dates, affirmative false success and deletion claims remain negative regressions. Intentionally failed specialist work and interrupted lifecycle probes retain their expected non-success outcomes. Earlier v2/v3 reports stay unchanged. Retained synthetic answers exposed a real source-check bug: successful `session_read` and `brain_read` calls now qualify as exact source observations; searches, failed reads, invented or ambiguous call IDs do not.
