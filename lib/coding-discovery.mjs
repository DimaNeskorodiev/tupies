import { promises as fs, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, ensure } from './store.mjs';

const SKIP=new Set(['.git','node_modules','data','vendor','build','dist','target','coverage','Library','Applications']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=value=>value && typeof value==='object' && !Array.isArray(value);
const cancelled=signal=>{if(signal?.aborted)throw new HttpError(499,'Project discovery cancelled.');};
const absolute=value=>typeof value==='string' && value.length<=4096 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)?path.normalize(value):null;

// No special files, symlinks or unbounded reads. A changed inode is not trusted.
async function smallFile(file,maxBytes,signal) {
  cancelled(signal);const initial=await fs.lstat(file);if(!initial.isFile() || initial.isSymbolicLink() || initial.size>maxBytes)return null;
  const handle=await fs.open(file,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened=await handle.stat();if(!opened.isFile() || opened.dev!==initial.dev || opened.ino!==initial.ino || opened.size>maxBytes)return null;
    const buffer=Buffer.alloc(maxBytes+1);let offset=0;
    while(offset<=maxBytes){cancelled(signal);const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
    if(offset>maxBytes)return null;
    const after=await handle.stat();if(after.size!==offset || after.dev!==opened.dev || after.ino!==opened.ino || after.mtimeMs!==opened.mtimeMs)return null;
    return buffer.subarray(0,offset).toString('utf8');
  } finally {await handle.close();}
}
async function realDirectory(value) {
  try{const info=await fs.lstat(value);if(!info.isDirectory() || info.isSymbolicLink())return false;return await fs.realpath(value)===value;}catch{return false;}
}
function decodedSegment(value) {
  try{const decoded=decodeURIComponent(value);return decoded && decoded.length<=200 && !/[\x00-\x1f\x7f/\\%?#]/.test(decoded) && !['.','..'].includes(decoded)?decoded:null;}catch{return null;}
}
function azureRemote(value) {
  let parts;
  if(/^https:\/\//i.test(value)) {
    try{const url=new URL(value);if(url.protocol!=='https:' || url.hostname.toLowerCase()!=='dev.azure.com' || url.port || url.search || url.hash)return null;parts=url.pathname.split('/').filter(Boolean);if(parts.length!==4 || parts[2]!=='_git')return null;parts=[parts[0],parts[1],parts[3]];}catch{return null;}
  } else {
    const match=/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(value);if(!match)return null;parts=match.slice(1);
  }
  const [organization,project,repositoryName]=parts.map(decodedSegment);
  if(!organization || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(organization) || organization.length>50 || !project || !repositoryName)return null;
  return {organization,project,repositoryName,...(UUID.test(repositoryName)?{repositoryId:repositoryName.toLowerCase()}:{}),azureRemote:`https://dev.azure.com/${organization}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repositoryName)}`};
}
function remoteFromConfig(text) {
  // Parse only literal URL lines in remote sections. Never execute Git/include/credential config.
  let remote=null;const found=[];
  for(const raw of text.split(/\r?\n/).slice(0,5000)) {
    const line=raw.trim();if(!line || /^[#;]/.test(line))continue;
    if(line.startsWith('[')){const match=/^\[remote\s+"([^"\r\n]{1,200})"\]\s*(?:[#;].*)?$/.exec(line);remote=match?.[1] ?? null;continue;}
    if(!remote)continue;
    const match=/^url\s*=\s*(.{1,4000})$/i.exec(line);if(!match)continue;
    let value=match[1].trim();if(value.startsWith('"') && value.endsWith('"'))value=value.slice(1,-1);
    const info=azureRemote(value);if(info)found.push({remote,info});if(found.length>=20)break;
  }
  return found.find(value=>value.remote==='origin')?.info ?? found[0]?.info ?? null;
}
async function projectInfo(directory,source,signal) {
  if(!await realDirectory(directory))return null;
  const git=path.join(directory,'.git');let info;
  try{info=await fs.lstat(git);}catch{if(source!=='claude')return null;}
  if(info?.isSymbolicLink())return null;
  if(info && !info.isDirectory() && !info.isFile())return null;
  if(!info && source!=='claude')return null;
  const result={path:directory,name:path.basename(directory),source};
  // Worktree .git pointer files are recognized without following paths outside this project.
  if(info?.isDirectory()) {
    try{const config=await smallFile(path.join(git,'config'),256_000,signal);if(config!==null)Object.assign(result,remoteFromConfig(config) || {});}catch(error){cancelled(signal);}
  }
  return result;
}
function defaultAgentPaths(home) {
  const bins=[path.join(home,'.local','bin'),path.join(home,'.npm-global','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin'];
  return {claude:bins.map(bin=>path.join(bin,'claude')),codex:[...bins.map(bin=>path.join(bin,'codex')),'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','/Applications/Codex.app/Contents/Resources/codex']};
}
async function detectAgents(home,agentPaths,signal) {
  const candidates=agentPaths ?? defaultAgentPaths(home),agents=[];
  for(const [id,label] of [['claude','Claude Code'],['codex','Codex']]) {
    let executable='';const paths=Array.isArray(candidates[id])?candidates[id].slice(0,20):[];
    for(const value of paths) {
      cancelled(signal);const candidate=absolute(value);if(!candidate)continue;
      try{const resolved=await fs.realpath(candidate),info=await fs.stat(resolved);if(!info.isFile())continue;await fs.access(resolved,constants.X_OK);executable=resolved;break;}catch{}
    }
    agents.push({id,label,executable,detected:!!executable});
  }
  return agents;
}

/** Read-only discovery. Results are choices, never authorization to run or configure a worker.
 * agentPaths is an embedding/test hook; the HTTP/agent API must not accept it from model input.
 */
export async function discoverCoding({home=os.homedir(),roots,includeClaudeProjects=true,maxEntries=2500,maxProjects=100,signal,agentPaths}={}) {
  home=absolute(home);ensure(home,400,'Discovery needs an absolute home directory.');
  cancelled(signal);ensure(await realDirectory(home),400,'Discovery home must be a real directory without symbolic links.');
  ensure(Number.isInteger(maxEntries) && maxEntries>=1 && maxEntries<=10_000,400,'Discovery entry limit must be 1–10000.');
  ensure(Number.isInteger(maxProjects) && maxProjects>=1 && maxProjects<=200,400,'Discovery project limit must be 1–200.');
  ensure(typeof includeClaudeProjects==='boolean',400,'Claude project discovery must be enabled or disabled.');
  const selected=roots ?? ['Documents','Desktop','Developer','Projects','Code','src'].map(name=>path.join(home,name));
  ensure(Array.isArray(selected) && selected.length<=12 && selected.every(value=>absolute(value)),400,'Choose at most twelve absolute discovery folders.');
  const scanRoots=[...new Set(selected.map(absolute))],warnings=new Set(),projects=new Map();let visited=0,truncated=false,claudeConfigPresent=false;
  const agents=await detectAgents(home,agentPaths,signal);
  const add=async(directory,source)=>{
    if(projects.has(directory)){if(source==='claude')projects.get(directory).source='claude';return;}
    if(projects.size>=maxProjects){truncated=true;return;}
    const value=await projectInfo(directory,source,signal);if(value)projects.set(directory,value);
  };
  if(includeClaudeProjects) {
    cancelled(signal);const configPath=path.join(home,'.claude.json');
    try {
      const info=await fs.lstat(configPath);claudeConfigPresent=info.isFile() && !info.isSymbolicLink();
      const raw=await smallFile(configPath,2_000_000,signal);
      if(raw===null){warnings.add('Claude project metadata is unavailable or exceeds its read limit.');}
      else {
        const config=JSON.parse(raw);
        if(object(config.projects)) {
          // Only keys are retained. Conversation/session contents and account fields are never returned.
          for(const value of Object.keys(config.projects)) {
            cancelled(signal);if(visited>=maxEntries || projects.size>=maxProjects){truncated=true;break;}visited++;
            const directory=absolute(value);if(directory)await add(directory,'claude');
          }
        }
      }
    } catch(error){cancelled(signal);if(error.code!=='ENOENT')warnings.add('Claude project metadata could not be read.');}
  }
  const seen=new Set();
  const scan=async(directory,depth)=>{
    cancelled(signal);if(seen.has(directory))return;
    if(visited>=maxEntries || projects.size>=maxProjects){truncated=true;return;}visited++;seen.add(directory);
    if(!await realDirectory(directory))return;
    await add(directory,'folder');if(depth>=4)return;
    let handle;
    try {
      handle=await fs.opendir(directory,{bufferSize:32});
      if(!await realDirectory(directory))return;
      for await(const entry of handle) {
        cancelled(signal);if(visited>=maxEntries || projects.size>=maxProjects){truncated=true;break;}
        // Hidden/skipped entries count too: a directory full of ignored files is still bounded.
        visited++;
        if(entry.name.startsWith('.') || SKIP.has(entry.name) || entry.isSymbolicLink())continue;
        if(!entry.isDirectory())continue;
        await scan(path.join(directory,entry.name),depth+1);
      }
    } catch(error){cancelled(signal);if(error.code!=='ENOENT')warnings.add('Some project folders were unavailable.');}
    finally{if(handle)await handle.close().catch(()=>{});}
  };
  for(const directory of scanRoots){cancelled(signal);if(visited>=maxEntries || projects.size>=maxProjects){truncated=true;break;}await scan(directory,0);}
  return {agents,projects:[...projects.values()].sort((a,b)=>a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),truncated,warnings:[...warnings],claudeConfigPresent};
}
