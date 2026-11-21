// Lock-screen text for what a bot is waiting on. Argument-free on purpose: an alert may show on a locked phone and
// passes through Apple, so it never carries commands, paths, hosts, script bodies, prompts or the bot's own wording
// (`review.summary`, `preview`, `arguments`, a browser handoff's reason). The approval card in the app shows the exact request.
// Titles follow public/approval-summary.js, phrased to complete "Needs your approval to …".

const words = name => String(name || '').replace(/[_-]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);

const ACTIONS = Object.freeze({
  terminal:'run a command', execute_code:'run code', shell_run:'run a program', shell_start:'start a background command',
  script_run:'run a saved script', scripts_run:'run a saved script', script_save:'save a script', scripts_register:'register a script',
  workspace_write:'write a file', workspace_edit:'change a file', workspace_delete:'delete a file', documents_create:'create a document',
  http_fetch:'send a web request', web_search:'search with a connected service',
  browser_click:'click in the browser', browser_fill:'type in the browser', browser_type:'type in the browser',
  browser_select:'change a form field', browser_check:'change a form field', browser_key:'press a key in the browser',
  routines_create:'create a routine', routines_update:'change a routine', routines_delete:'delete a routine',
  bots_create:'create a bot', bots_update:'change a bot’s settings',
  skills_create:'create a skill', skills_install:'install a skill', skills_run:'run a skill', skills_assign:'assign a skill',
  workshop_build:'build a new tool', workshop_install:'install a tool it built', workshop_read_api:'read an API for a new tool', workshop_poll_api:'check an API for a new tool',
  improvement_propose:'suggest an improvement', engine_candidate_build:'build an Engine improvement', knowledge_publish:'publish what it learned',
});

// Engine check-ins use the approval card but are not an action of the bot's choosing.
const CHECK_INS = Object.freeze({
  task_budget:'Reached its task budget. Needs your OK to continue.',
  task_checkpoint:'Paused at a checkpoint. Needs your OK to continue.',
  site_access_review:'A website keeps refusing. Needs your OK to keep trying.',
});

/** "Needs your approval to create a routine." `integrations` resolves a connection's own name for integration calls. */
export function approvalText(tool, args, {integrations = []} = {}) {
  if (Object.hasOwn(CHECK_INS, tool)) return CHECK_INS[tool];
  const plain = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (tool === 'integration_propose') return `Needs your approval to ${typeof plain.integrationId === 'string' && plain.integrationId ? 'change a connection' : 'add a connection'}.`;
  if (tool === 'integration_call') {
    // The service's name is the owner's own label and the action is a declared tool name, never an argument value.
    const service = integrations.find(item => item?.id === plain.integrationId), name = words(service?.name), action = words(plain.tool);
    return `Needs your approval to use ${name || 'a connected service'}${action ? `: ${action}` : ''}.`;
  }
  const action = Object.hasOwn(ACTIONS, tool) ? ACTIONS[tool] : words(tool) ? `use “${words(tool)}”` : 'take an action';
  return `Needs your approval to ${action}.`;
}

export const BROWSER_TEXT = 'Needs your help in the browser. Open the chat to continue.';
export const FAILED_TEXT = 'Couldn’t finish the task. Open the chat for details.';
export const skillProposalText = create => create ? 'Suggests a new skill. Review it in the bot’s profile.' : 'Suggests a change to a skill. Review it in the bot’s profile.';
