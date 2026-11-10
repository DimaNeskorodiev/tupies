#!/usr/bin/env node
// Where can this computer run bot commands? Prints each execution backend's availability and reason
// for the account and restrictions this script runs under, then exits 0 when the command sandbox is
// ready and 1 otherwise. No network (the SSH backend is not contacted), no Engine state, no secrets:
// the sandbox self-test runs `bwrap … true` (Linux) or `sandbox-exec … true` (macOS) once, and Docker is
// asked only for its local version and image.
//
//   node scripts/check-sandbox.mjs           readable lines
//   node scripts/check-sandbox.mjs --json    one JSON object
//
// On a VPS run it as the service account, and inside the service's own restrictions when you can (see
// docs/deployment.md): systemd settings such as RestrictNamespaces= apply only inside the service.
import os from 'node:os';
import { executionBackend, EXECUTION_BACKEND_IDS } from '../lib/exec/index.mjs';

const json=process.argv.includes('--json');
const results=[];
for(const id of EXECUTION_BACKEND_IDS) {
  const backend=executionBackend(id);
  if(id==='ssh' && process.env.STUDIO_EXEC_SSH_HOST){results.push({id,label:backend.label,available:null,reason:'Not checked here: it would open a network connection. The settings screen checks it.'});continue;}
  let status;try{status=await backend.available();}catch(error){status={ok:false,reason:error.message};}
  results.push({id,label:backend.label,available:Boolean(status?.ok),reason:status?.ok?'':String(status?.reason || 'Unavailable.')});
}
const sandbox=results.find(item=>item.id==='sandbox');
const underService=Boolean(process.env.INVOCATION_ID);
const user=(()=>{try{return os.userInfo().username;}catch{return String(process.getuid?.() ?? 'unknown');}})();
if(json) {
  console.log(JSON.stringify({platform:process.platform,user,underService,mechanism:executionBackend('sandbox').describe().mechanism,sandboxReady:sandbox.available,backends:results}));
} else {
  console.log(`Where bot commands can run on this ${process.platform} computer (account ${user}${underService?', inside a systemd service':''}):`);
  for(const item of results)console.log(`  ${item.id.padEnd(8)} ${item.available===null?'not checked':item.available?'ready':'not ready'}${item.reason?`: ${item.reason}`:''}`);
  console.log(sandbox.available?`Sandbox ready (${executionBackend('sandbox').describe().mechanism}). Bots set to "Sandbox on this computer" run ordinary commands without asking.`:'Sandbox not ready. Bots set to "Sandbox on this computer" ask before every command that can change files, and say why.');
  if(process.platform==='linux' && !underService)console.log('Note: this ran outside the Engine’s systemd service. Its settings (RestrictNamespaces=, AmbientCapabilities=) apply only inside it; after a restart the bot settings screen shows the Engine’s own result.');
}
process.exitCode=sandbox.available?0:1;
