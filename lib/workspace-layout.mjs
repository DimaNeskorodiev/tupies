import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensure } from './store.mjs';

export const WORKSPACE_LAYOUT_VERSION=1;
export const WORKSPACE_FOLDERS=Object.freeze([
  {path:'brain',label:'Brain',description:'Linked Markdown knowledge and long-term notes.'},
  {path:'notes',label:'Notes',description:'Working notes and drafts.'},
  {path:'scripts',label:'Scripts',description:'Reusable source files and descriptive manifests; execution needs exact approval.'},
  {path:'projects',label:'Projects',description:'Project folders and their supporting files.'},
  {path:'documents',label:'Documents',description:'Reference documents and document exports.'},
  {path:'data',label:'Data',description:'Input datasets and structured local data.'},
  {path:'outputs',label:'Outputs',description:'Completed results and generated files.'},
  {path:'uploads',label:'Uploads',description:'Files added to this bot’s workspace.'},
  {path:'.tmp',label:'Temporary',description:'Temporary workspace files; excluded from workspace sync.',hidden:true},
].map(folder=>Object.freeze(folder)));

async function workspaceRoot(root) {
  ensure(typeof root==='string' && root.length>0 && !root.includes('\0') && path.isAbsolute(root),400,'Use an absolute private workspace path.');
  const requested=path.resolve(root);
  let info;
  try {info=await fs.lstat(requested);}catch(error){if(error.code==='ENOENT')ensure(false,404,'The workspace folder does not exist.');throw error;}
  ensure(info.isDirectory() && !info.isSymbolicLink(),400,'The workspace root must be a real directory.');
  // Canonicalize system parent aliases (for example macOS temporary paths),
  // while refusing a symlink in place of the actual workspace root itself.
  const absolute=await fs.realpath(requested),canonical=await fs.lstat(absolute);
  ensure(canonical.isDirectory() && !canonical.isSymbolicLink() && canonical.dev===info.dev && canonical.ino===info.ino,409,'The workspace root changed while checking its layout.');
  return {absolute,dev:canonical.dev,ino:canonical.ino};
}

async function unchangedRoot(root) {
  const info=await fs.lstat(root.absolute);
  ensure(info.isDirectory() && !info.isSymbolicLink() && info.dev===root.dev && info.ino===root.ino,409,'The workspace root changed while checking its layout.');
}

async function folderStatus(root,relative) {
  try {
    const info=await fs.lstat(path.join(root.absolute,relative));
    return info.isDirectory() && !info.isSymbolicLink()?'ready':'blocked';
  } catch(error) {
    if(error.code==='ENOENT')return 'missing';
    if(['EACCES','EPERM','ENOTDIR','ELOOP'].includes(error.code))return 'blocked';
    throw error;
  }
}

async function layout(root) {
  const folders=[];
  for(const folder of WORKSPACE_FOLDERS)folders.push({...folder,status:await folderStatus(root,folder.path)});
  await unchangedRoot(root);
  return {version:WORKSPACE_LAYOUT_VERSION,folders,memory:{kind:'collection',label:'Memory'}};
}

/** Read-only layout inspection. Missing folders and blocked paths are never repaired here. */
export async function inspectWorkspaceLayout(root) {
  return layout(await workspaceRoot(root));
}

/** Explicitly create missing empty folders; never replace, move or chmod existing entries. */
export async function ensureWorkspaceLayout(root) {
  const checked=await workspaceRoot(root),created=[];
  for(const folder of WORKSPACE_FOLDERS) {
    await unchangedRoot(checked);
    if(await folderStatus(checked,folder.path)!=='missing')continue;
    try {await fs.mkdir(path.join(checked.absolute,folder.path),{mode:0o700});created.push(folder.path);}
    catch(error){if(!['EEXIST','EACCES','EPERM'].includes(error.code))throw error;}
  }
  return {...await layout(checked),created};
}
