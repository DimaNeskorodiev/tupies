import { ensure } from './store.mjs';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const quote = { type: 'string', minLength: 1, maxLength: 1200 };

export const MISSION_INTENT_GUIDANCE = 'Ordinary chat is the default, including autonomous tool use and multi-step work. Use mission_start only in the first step for an explicit owner request to create a Mission, or to OFFER the owner a large durable process with ALL of: at least three distinct substantive owner-requested deliverables or changes, dependent stages, and an owner-requested need for staged execution, external waits or recurring work. Bind every outcome and the separate process need to non-overlapping exact quotes from THIS owner message. Searching, reading, comparing, choosing, recommending, summarizing and checking a single result are supporting actions, not separate deliverables. A domain/product comparison, one recommendation, one report/document, a focused fix, several browser/tool calls, login, approvals, high effort or delegation alone stay chat. Never inflate a small task into stages or infer process requirements the owner did not request. When uncertain or evidence is missing, continue the work in ordinary chat without asking about Mission mode. Negated, quoted, hypothetical and plan-only Mission mentions stay chat. Inferred Missions require owner confirmation and effort selection before work starts. Explicit requests default to Medium; supply another effort only with an exact owner quote. Explicit owner UI creation and promotion remain available.';

export const MISSION_START_DEFINITION = {
  name: 'mission_start',
  description: `${MISSION_INTENT_GUIDANCE} No prompt is repeated and no access is granted. Use the exact owner message ID from turn context. For explicit intent supply explicitRequest (an exact quote of the direct Mission request), without scope. For clear_goal supply scope, without explicitRequest. Order outcomes by dependency; each outcome after the first must depend on an earlier outcome by its zero-based index. Process evidence must be separate from the outcome quotes.`,
  parameters: object({
    intent: { type: 'string', enum: ['explicit', 'clear_goal'] },
    ownerMessageId: { type: 'string', maxLength: 120 },
    explicitRequest: quote,
    effort: { type: 'string', enum: ['low','medium','high','ultra'] },
    effortQuote: quote,
    scope: object({
      outcomes: { type: 'array', minItems: 3, maxItems: 6, items: object({
        quote,
        kind: { type: 'string', enum: ['deliverable', 'change'] },
        dependsOn: { type: 'array', maxItems: 5, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 5 } },
      }) },
      process: object({ kind: { type: 'string', enum: ['staged_execution', 'external_waits', 'recurring_work'] }, quote }),
    }),
  }, ['intent', 'ownerMessageId']),
};

const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const stayChat = message => ensure(false, 400, `${message} Continue this task in ordinary chat; do not retry Mission admission or ask the owner to use Mission mode.`);

/** Validate structural/source evidence, not model semantics or action authority. */
export function validateMissionIntent(input, owner) {
  if (!fields(input, ['intent', 'ownerMessageId', 'explicitRequest', 'scope', 'effort', 'effortQuote']) || !['explicit', 'clear_goal'].includes(input.intent) || input.ownerMessageId !== owner.id) stayChat('Bind a structured Mission decision to the exact owner message.');
  const spans = [];
  const sourceQuote = value => {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 1200 || !owner.content.includes(value)) stayChat('Mission admission needs exact evidence in the current owner request.');
    const start = owner.content.indexOf(value), end = start + value.length;
    if (spans.some(span => start < span.end && end > span.start)) stayChat('Separate Mission outcomes and process requirements need non-overlapping owner evidence.');
    spans.push({ start, end });
    return value;
  };
  if (input.intent === 'explicit') {
    if (input.scope !== undefined) stayChat('Explicit Mission intent uses only the direct owner request.');
    const evidence = sourceQuote(input.explicitRequest);
    // This lexical guard cannot establish intent; it prevents silently relabelling an ordinary goal as explicit.
    if (!/(?:\bmission\b|\bmisi[oó]n\b|місі[яюїє])/iu.test(evidence)) stayChat('An explicit Mission decision must quote the owner naming Mission mode.');
    let effort;
    if(input.effort!==undefined || input.effortQuote!==undefined){
      if(!['low','medium','high','ultra'].includes(input.effort) || typeof input.effortQuote!=='string' || !owner.content.includes(input.effortQuote) || !new RegExp('\\b'+input.effort+'\\b','i').test(input.effortQuote) || input.effortQuote.length>1200)stayChat('An explicit effort needs its exact named level in the owner request.');
      effort=input.effort;
    }
    return { schemaVersion: 1, intent: 'explicit', explicitRequest: evidence, ...(effort?{effort,effortQuote:input.effortQuote}:{}) };
  }
  if(input.effort!==undefined || input.effortQuote!==undefined)stayChat('The owner chooses effort on the Mission proposal.');
  const scope = input.scope;
  if (input.explicitRequest !== undefined || !fields(scope, ['outcomes', 'process']) || !Array.isArray(scope.outcomes) || scope.outcomes.length < 3 || scope.outcomes.length > 6) stayChat('Automatic Missions require at least three distinct substantive outcomes and a durable process.');
  const outcomes = scope.outcomes.map((outcome, index) => {
    if (!fields(outcome, ['quote', 'kind', 'dependsOn']) || !['deliverable', 'change'].includes(outcome.kind) || !Array.isArray(outcome.dependsOn) || outcome.dependsOn.length > 5 || new Set(outcome.dependsOn).size !== outcome.dependsOn.length || outcome.dependsOn.some(before => !Number.isSafeInteger(before) || before < 0 || before >= index) || index > 0 && !outcome.dependsOn.length) stayChat('Automatic Missions require distinct outcomes connected by forward dependent stages.');
    return { quote: sourceQuote(outcome.quote), kind: outcome.kind, dependsOn: [...outcome.dependsOn] };
  });
  if (!fields(scope.process, ['kind', 'quote']) || !['staged_execution', 'external_waits', 'recurring_work'].includes(scope.process.kind)) stayChat('Automatic Missions require a separate owner-requested durable process.');
  return { schemaVersion: 1, intent: 'clear_goal', scope: { outcomes, process: { kind: scope.process.kind, quote: sourceQuote(scope.process.quote) } } };
}
