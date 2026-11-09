// Owner-selected policy, evaluated by the Engine. Model/page/tool descriptions
// never classify themselves as safe. Effects outside the fast path are reviewed
// independently; deleting data and changing security still need the owner.
// Terminal/code tools (terminal, execute_code, shell_run, shell_start) are decided by
// the deterministic classifier policy in command-policy.mjs and never reach the model
// reviewer. The reviewer remains for actions whose effects depend on remote services,
// web pages, registered packages or team settings that a pattern classifier cannot see.
export const APPROVAL_POLICIES = ['auto', 'balanced', 'strict'];
export const DEFAULT_APPROVAL_POLICY = 'auto';

export function actionReviewGuidance(bot) {
  return bot?.approvalPolicy==='auto' ? '\n\nApprove for me: use enabled tools for routine steps without confirmation questions. The Engine reviews actions; ask only for missing task information.' : '';
}

const AUTOMATIC = new Map([
  ['skills_create', 'Save a new private playbook without executing code.'],
  ['scripts_register', 'Register private source files without running them.'],
  ['web_search', 'Use the assigned search service for this query.'],
  ['browser_open', 'Navigate in this bot’s browser session.'],
  ['browser_new_tab', 'Open a page in a task-owned tab.'],
  ['browser_switch_tab', 'Switch between task-owned tabs.'],
  ['browser_close_tab', 'Close a task-owned tab.'],
  ['browser_back', 'Navigate back in the current tab.'],
  ['browser_hover', 'Inspect a page control without clicking it.'],
  ['browser_fill', 'Edit a non-private field without submitting the form.'],
  ['browser_type', 'Type in a non-private field without submitting the form.'],
  ['browser_select', 'Choose an option without submitting the form.'],
]);

export function automaticReview(bot, currentBot, name, args = {}, evidence = {}) {
  // Both snapshots must opt in. Missing/unknown values never widen a running
  // task's authority, including old checkpoints and linked-engine changes.
  if (bot?.approvalPolicy !== 'auto' || currentBot?.approvalPolicy !== 'auto') return null;
  // Engine checkpoints are the owner's own decision for this request; Approve for me never answers them.
  if (name === 'site_access_review') return { automatic: false, reason: 'Working around a site’s refusal can break its terms and get this engine’s address blocked. Deny stops further attempts to reach this site in this task.' };
  if (name === 'task_checkpoint') return { automatic: false, reason: 'Allow once lets it continue and checks again if it stalls; Deny stops the task and keeps the work so far.' };
  if (name === 'browser_click' && evidence.navigation) return { automatic: true, reason: 'Follow the verified web link directly, without executing click handlers.' };
  const reason = AUTOMATIC.get(name);
  if (reason) return { automatic: true, reason };
  if (name === 'browser_key' && ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(args.key)) {
    return { automatic: true, reason: 'Move within a page without an activation key.' };
  }
  if (name === 'browser_dialog' && args.accept === false) return { automatic: true, reason: 'Dismiss a site dialog without accepting its action.' };
  const reasonForManual = /^(shell_|terminal$|execute_code$|lsp_start$|skills_run$|scripts_run$|coding_)/.test(name)
    ? 'This can execute code with the engine account’s access.'
    : /delete/.test(name) ? 'This can permanently remove saved work.'
    : /^(bots_|skills_assign$|routines_)/.test(name) ? 'This changes team access or future unattended work.'
    : name.startsWith('browser_') ? 'This can submit, upload, download or commit a site action. Its consequences need your review.'
    : 'This action has external, protected or unclassified effects that need your review.';
  const protectedAction = /delete/.test(name) || ['workspace_write','workspace_edit','documents_create','skills_install','workshop_poll_api','workshop_read_api','coding_connect','coding_publish'].includes(name)
    || name==='bots_update' && ['addTools','removeTools','enabled','approvalPolicy'].some(key=>Object.hasOwn(args,key))
    // Pre-approving routine commands is the owner's own exact approval, never a reviewer's.
    || ['routines_create','routines_update'].includes(name) && Array.isArray(args.commands) && args.commands.length>0;
  const reviewable = new Set(['lsp_start','scripts_run','skills_run','integration_call','routines_create','routines_update','bots_create','bots_update','skills_assign','coding_discover','coding_work_items','coding_run','coding_verify','desktop_launch','desktop_action','browser_upload','browser_download','browser_check','browser_drag','browser_click','browser_key','browser_dialog']);
  return { automatic: false, reason: reasonForManual, ...(reviewable.has(name) && !protectedAction ? { reviewable: true } : {}) };
}
