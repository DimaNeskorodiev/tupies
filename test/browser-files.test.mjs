import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { BrowserSession, findBrowser } from '../lib/browser.mjs';
import { executeBrowserFileTool, validateBrowserFileAction } from '../lib/browser-files.mjs';

const chrome=await findBrowser(),needsChrome={skip:chrome?false:'Chrome/Chromium is not installed.'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-browser-files-')),store=await new Store(directory).init();
  const bot={id:'bot_atlas',tools:['browser','workspace']},root=await getWorkspaceRoot(store,bot.id);
  const context={store,bot,root,directory};
  // Hooks run in registration order: drain Chrome before deleting its profile.
  // Close the fixture server before removing files, including failed downloads.
  t.after(async()=>{await context.session?.close();if(context.site){context.site.closeAllConnections();await new Promise(resolve=>context.site.close(resolve));}await fs.rm(directory,{recursive:true,force:true});});
  return context;
}
test('browser file transfers require private paths, current upload bytes and Workspace access',async t=>{
  const context=await fixture(t),bytes=Buffer.from('fixture upload');await fs.writeFile(path.join(context.root,'upload.txt'),bytes);
  const args={path:'upload.txt',sha256:sha(bytes)};
  assert.equal((await validateBrowserFileAction(context,'browser_upload',args)).bytes,bytes.length);
  await assert.rejects(validateBrowserFileAction({...context,bot:{...context.bot,tools:['browser']}},'browser_upload',args),/Workspace/);
  await assert.rejects(validateBrowserFileAction(context,'browser_upload',{...args,sha256:'0'.repeat(64)}),/changed/);
  for(const target of ['../escape.txt','/tmp/escape.txt','folder/../escape.txt','C:/escape.txt','folder\\escape.txt'])await assert.rejects(validateBrowserFileAction(context,'browser_download',{path:target}));
  await assert.rejects(validateBrowserFileAction(context,'browser_download',{path:'upload.txt'}),/new download path/);
  await fs.symlink(tmpdir(),path.join(context.root,'linked'));
  await assert.rejects(validateBrowserFileAction(context,'browser_download',{path:'linked/escape.txt'}),/real directory/);
});

test('Chrome uploads exact private bytes and downloads real bytes without replacing existing files',needsChrome,async t=>{
  const context=await fixture(t),download=Buffer.from('actual browser download\n'),upload=Buffer.from('actual browser upload\n');
  await fs.writeFile(path.join(context.root,'upload.txt'),upload);
  const site=context.site=http.createServer((req,res)=>{
    if(req.url==='/file'||req.url==='/wrong'){res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="remote-name.txt"'});return res.end(download);}
    res.setHeader('content-type','text/html');res.end('<label>Attachment <input type="file" id="file"></label><p id="result"></p><a href="/file">Download report</a><a href="/file" onclick="event.preventDefault();location.href=\'/wrong\'">Unexpected download</a><script>file.onchange=async()=>{result.textContent=await file.files[0].text()}</script>');
  });
  await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
  const session=context.session=await BrowserSession.start({executable:chrome,profileRoot:path.join(context.directory,'browser'),allowPrivate:true});
  await session.navigate(`http://127.0.0.1:${site.address().port}/`);
  let view=await session.outline(),ref=view.outline.match(/\[(e\d+)\].*?(?:file|Attachment)/)?.[1];assert.ok(ref,view.outline);
  const result=await executeBrowserFileTool(session,context,'browser_upload',{ref,revision:view.revision,path:'upload.txt',sha256:sha(upload)});
  assert.equal(result.uploaded,true);
  for(let tries=0;tries<40 && !(await session.text()).includes('actual browser upload');tries++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.match(await session.text(),/actual browser upload/);
  view=await session.outline();ref=view.outline.match(/\[(e\d+)\] link "Download report"/)[1];
  const saved=await executeBrowserFileTool(session,context,'browser_download',{ref,revision:view.revision,path:'downloads/report.txt'});
  assert.equal(saved.sha256,sha(download));assert.deepEqual(await fs.readFile(path.join(context.root,saved.path)),download);
  await assert.rejects(executeBrowserFileTool(session,context,'browser_download',{ref,revision:view.revision,path:saved.path}),/new download path/);
  assert.deepEqual(await fs.readFile(path.join(context.root,saved.path)),download);
  view=await session.outline();ref=view.outline.match(/\[(e\d+)\] link "Unexpected download"/)[1];
  await assert.rejects(executeBrowserFileTool(session,context,'browser_download',{ref,revision:view.revision,path:'downloads/wrong.txt'}),/unrelated download/);
  await assert.rejects(fs.stat(path.join(context.root,'downloads/wrong.txt')),{code:'ENOENT'});
});
