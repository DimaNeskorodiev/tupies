// An owner-set budget for one task of a bot: an estimated dollar amount and/or a number of model steps.
// Off unless the owner sets it. When a task reaches it the engine never fails silently: in the owner's chat it pauses
// with a card (continue for another budget's worth, or stop with the work kept); where nobody is watching it stops the
// task with a plain reason. Missions have their own shared resource budgets and are not affected.
// Dollars are the estimate from run-usage.mjs: a task whose calls have no price is limited by steps only.

export const BUDGET_USD={min:0.01,max:1000};
export const BUDGET_STEPS={min:5,max:1000};

const number=value=>typeof value==='string' && /^\d{1,4}(\.\d{1,4})?$/.test(value.trim())?Number(value):value;
const blank=value=>value===undefined || value===null || value==='';

/** Reads `taskBudgetUsd` / `taskBudgetSteps` from a settings form or API body. Returns the stored shape, or null to clear. Throws through `ensure`. */
export function validateTaskBudget(input,ensure) {
  const usd=blank(input.taskBudgetUsd)?null:number(input.taskBudgetUsd);
  const steps=blank(input.taskBudgetSteps)?null:number(input.taskBudgetSteps);
  ensure(usd===null || Number.isFinite(usd) && usd>=BUDGET_USD.min && usd<=BUDGET_USD.max,400,'Choose a task budget from 0.01 to 1000 US dollars, or leave it empty.');
  ensure(steps===null || Number.isInteger(steps) && steps>=BUDGET_STEPS.min && steps<=BUDGET_STEPS.max,400,'Choose a step budget from 5 to 1000 model steps, or leave it empty.');
  if(usd===null && steps===null)return null;
  return {...(usd!==null?{usd:Math.round(usd*100)/100}:{}),...(steps!==null?{steps}:{})};
}

/** The budget a bot snapshot carries, sanitized; null when unset or unusable. */
export function taskBudget(bot) {
  const value=bot?.taskBudget;
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const usd=Number.isFinite(value.usd) && value.usd>=BUDGET_USD.min && value.usd<=BUDGET_USD.max?value.usd:null;
  const steps=Number.isInteger(value.steps) && value.steps>=BUDGET_STEPS.min && value.steps<=BUDGET_STEPS.max?value.steps:null;
  return usd===null && steps===null?null:{usd,steps};
}

/**
 * Whether a task has reached its budget. `extensions` counts how many times the owner already chose to continue;
 * each one adds another full budget. Returns null while under budget, else what was reached.
 */
export function budgetReached(budget,{steps=0,costUsd=null,extensions=0}={}) {
  if(!budget)return null;
  const factor=1+Math.max(0,Number.isInteger(extensions)?extensions:0);
  if(budget.usd!==null && Number.isFinite(costUsd) && costUsd>=budget.usd*factor)return {kind:'usd',limit:Math.round(budget.usd*factor*100)/100,used:Math.round(costUsd*10000)/10000};
  if(budget.steps!==null && steps>=budget.steps*factor)return {kind:'steps',limit:budget.steps*factor,used:steps};
  return null;
}

/** Plain wording of what was reached, for the card, the event and the stop reason. */
export function budgetLabel(reached) {
  if(reached.kind==='usd')return 'about '+reached.used.toFixed(2)+' of its '+reached.limit.toFixed(2)+' US dollar task budget';
  return reached.used+' of its '+reached.limit+' budgeted model steps';
}
