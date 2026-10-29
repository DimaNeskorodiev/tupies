import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensure } from './store.mjs';

async function privateDirectory(directory) {
  await fs.mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const stat=await fs.lstat(directory);
  ensure(stat.isDirectory() && !stat.isSymbolicLink(),400,'Process configuration and temporary storage must be real directories.');
  await fs.chmod(directory,0o700);
  return directory;
}

/** Engine-local tool state is separate from files the model can edit without process approval. */
export async function getProcessHome(store,botId) {
  ensure(/^[a-zA-Z0-9_-]{1,100}$/.test(botId),400,'Invalid bot id.');
  const parent=await privateDirectory(path.join(store.directory,'process-homes'));
  return privateDirectory(path.join(parent,botId));
}

/** An explicit allowlist; provider/host credentials and startup environment are never inherited. */
export async function processEnvironment(home) {
  ensure(typeof home==='string' && path.isAbsolute(home),500,'An explicit process home is required.');
  await privateDirectory(home);
  const temp=await privateDirectory(path.join(home,'.tmp'));
  const config=await privateDirectory(path.join(home,'.config'));
  const cache=await privateDirectory(path.join(home,'.cache'));
  const local=await privateDirectory(path.join(home,'.local'));
  const data=await privateDirectory(path.join(local,'share'));
  const hooks=await privateDirectory(path.join(home,'disabled-git-hooks'));
  return {PATH:`${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,HOME:home,TMPDIR:temp,LANG:'C.UTF-8',XDG_CONFIG_HOME:config,XDG_CACHE_HOME:cache,XDG_DATA_HOME:data,PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(home,'.gitconfig'),GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:'false',GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:hooks,GIT_CONFIG_KEY_2:'credential.helper',GIT_CONFIG_VALUE_2:'',GIT_CONFIG_KEY_3:'protocol.ext.allow',GIT_CONFIG_VALUE_3:'never'};
}
