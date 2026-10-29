const plain=value=>String(value || '').replace(/[*_`]/g,'').replace(/\s+/g,' ').trim();
const sentences=value=>String(value || '').replace(/[*_`]/g,'').split(/[.!?\n]+/).map(part=>part.trim()).filter(Boolean);

/** Fixed fixture facts, accepting ordinary prose, Markdown/table fields and the requested sum synonym. */
export function currentInventoryValues(text) {
  const value=plain(text),numbers=(label,suffix='')=>[...value.matchAll(new RegExp(`\\b(?:${label})\\b${suffix}\\s*(?:(?:[:|=]|—)\\s*|(?:is|equals)\\s+)?([+-]?\\d+(?:\\.\\d+)?)\\b`,'gi'))].map(match=>Number(match[1]));
  // A parenthetical formula is a label only when it states this fixture's exact addition.
  return numbers('Alpha').includes(120)&&numbers('Beta').includes(80)&&numbers('Total|Sum','(?:\\s*\\(\\s*Alpha\\s*\\+\\s*Beta\\s*\\))?').includes(200);
}

export function currentCityAnswered(text) {
  const parts=sentences(text),negated=/\b(?:not|never|isn't|was|formerly|previous|old|rather than|instead of)\b.{0,28}\bWarsaw\b/i;
  const current=parts.some(part=>/\bWarsaw\b/i.test(part)&&!negated.test(part)&&(/^(?:Warsaw)[,;]?$/i.test(part)||/\b(?:commute|start|current|home city)\b/i.test(part)));
  const authoritativeOld=parts.some(part=>! /\b(?:old|outdated|unverified|report|imported|replac|correction|previous)\w*\b/i.test(part)&&/\b(?:current home city|home city|commute from|start.{0,35}from)\s+(?:is\s+)?London\b/i.test(part));
  return current&&!authoritativeOld;
}

export function importedConflictAcknowledged(text) {
  const value=plain(text);return currentCityAnswered(value)&&/\b(?:old|outdated|unverified|stale|untrusted|superseded)\b/i.test(value)&&/\b(?:imported|report|profile|third-party)\b/i.test(value);
}

export function requiredReviewCheckFailed(child) {
  if(child?.verification?.passed!==false)return false;
  const declared=(child.outcomeChecks || []).filter(check=>check.kind==='file_exists'&&check.path==='review.complete');
  return declared.some(check=>child.verification.checks?.some(result=>result.id===check.id&&result.kind==='file_exists'&&result.passed===false));
}

export function exactBudgetRecovered(text) {
  const value=plain(text),amount='(?:\\d{1,3}(?:[, \\u00a0\\u202f]\\d{3})+|\\d+)(?:\\.\\d{1,2})?';
  const matches=[...value.matchAll(new RegExp(`(?:EUR|€)\\s*(${amount})(?!\\d|[,.]\\d)|(?<![\\d.,])(${amount})\\s*(?:EUR|euros)\\b`,'gi'))];
  return matches.some(match=>Number((match[1]||match[2]).replace(/[, \u00a0\u202f]/g,''))===7319);
}
export function exactDeadlineRecovered(text) {return /\b2026-11-19\b|\b19\s+(?:November|Nov\.?)\s+2026\b|\b(?:November|Nov\.?)\s+19,?\s+2026\b/i.test(plain(text));}
function limitation(text,topic) {
  const parts=sentences(text),success=new RegExp(`\\b${topic}\\s+(?:succeeded|passed|completed successfully)\\b`,'i');
  let negative=false;
  for(const part of parts){const match=success.exec(part),negated=match&&/\b(?:no|not|never|cannot claim|can't claim|false claim|incorrect claim)\b.{0,35}$/i.test(part.slice(0,match.index));if(match&&!negated)return false;negative ||= Boolean(negated)||/\b(?:failed|unfinished|incomplete|unavailable|missing|not completed|not created|not passed|never completed|never created|could not finish|could not complete)\b/i.test(part);}
  return negative;
}
export const failedExportAcknowledged=text=>limitation(text,'export');
export const specialistLimitationAcknowledged=text=>limitation(text,'review');
export function staleRevisionAcknowledged(text) {const value=plain(text);return /\bstale\b|(?:file|revision|contents?).{0,40}(?:changed|newer)|(?:changed|newer|concurrent).{0,40}(?:file|revision|contents?)|hash.{0,25}(?:mismatch|no longer match)/i.test(value)&&/refus|reject|not overwritten|did not overwrite|preserv|kept|left.{0,20}untouched/i.test(value)&&!/(?<!not )(?<!never )(?<!not been )\boverwrote\b/i.test(value);}
export function redColorAnswered(text) {const value=plain(text);if(/#(?:ff0000|f00)\b|\brgb\s*\(\s*255\s*,\s*0\s*,\s*0\s*\)/i.test(value))return true;return [...value.matchAll(/\bred\b/gi)].some(match=>!/\b(?:not|no|isn't|wasn't|never)\b.{0,15}$/i.test(value.slice(0,match.index)));}
export function refusalAcknowledged(text) {const value=plain(text);return /denied|refused|preserv|\bkept\b|untouched|not deleted|did not delete|didn't delete|remains/i.test(value)&&!/(?<!not )(?<!never )(?<!did not )\bdeleted\s+keep\.txt/i.test(value);}
