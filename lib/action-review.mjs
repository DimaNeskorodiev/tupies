// Owner-selected policy, evaluated by the Engine. Model/page/tool descriptions
// never classify themselves as safe. New or ambiguous effects need manual review.
export const APPROVAL_POLICIES = ['auto', 'balanced', 'strict'];
export const DEFAULT_APPROVAL_POLICY = 'auto';

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
  if (name === 'browser_click' && evidence.navigation) return { automatic: true, reason: 'Follow the verified web link directly, without executing click handlers.' };
  const reason = AUTOMATIC.get(name);
  if (reason) return { automatic: true, reason };
  if (name === 'browser_key' && ['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(args.key)) {
    return { automatic: true, reason: 'Move within a page without an activation key.' };
  }
  if (name === 'browser_dialog' && args.accept === false) return { automatic: true, reason: 'Dismiss a site dialog without accepting its action.' };
  const reasonForManual = /^(shell_|lsp_start$|skills_run$|scripts_run$|coding_)/.test(name)
    ? 'This can execute code with the engine account’s access.'
    : /delete/.test(name) ? 'This can permanently remove saved work.'
    : /^(bots_|skills_assign$|routines_)/.test(name) ? 'This changes team access or future unattended work.'
    : name.startsWith('browser_') ? 'This can submit, upload, download or commit a site action. Its consequences need your review.'
    : 'This action has external, protected or unclassified effects that need your review.';
  return { automatic: false, reason: reasonForManual };
}
