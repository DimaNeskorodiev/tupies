import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { BrowserSession, EgressProxy, findBrowser } from '../lib/browser.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=15_000) {const until=Date.now()+timeout;while(Date.now()<until){const result=predicate();if(result)return result;await delay(10);}throw new Error('Fixture timed out waiting for agent state.');}
const chrome=await findBrowser();
const needsChrome={skip:chrome?false:'No Chrome or Chromium on this machine.'};
const call=(id,name,args)=>({id,name,arguments:args});
const lastTool=request=>JSON.parse(request.messages.filter(message=>message.role==='tool').at(-1).content);
const alive=pid=>{try {process.kill(pid,0);return true;} catch {return false;}};

async function connect(port,target) {
  return new Promise(resolve=>{const request=http.request({host:'127.0.0.1',port,method:'CONNECT',path:target});request.on('connect',response=>{response.socket?.destroy();resolve(response.statusCode);});request.on('error',error=>resolve(error.message));request.end();});
}

test('the egress proxy applies http_fetch rules: HTTPS on 443 to public addresses only, checked after DNS',async t=>{
  const answers={'public.example':[{address:'93.184.215.14',family:4}],'rebind.example':[{address:'93.184.215.14',family:4},{address:'10.0.0.8',family:4}],'metadata.example':[{address:'169.254.169.254',family:4}]};
  const proxy=new EgressProxy({resolver:async host=>answers[host] || []});const port=await proxy.listen();
  t.after(()=>proxy.close());
  assert.deepEqual(await proxy.admit('public.example',443),{address:'93.184.215.14',family:4});
  for(const [host,port_] of [['rebind.example',443],['metadata.example',443],['127.0.0.1',443],['[::1]',443],['localhost',443],['printer.local',443],['public.example',80],['public.example',8443]])
    await assert.rejects(proxy.admit(host,port_),error=>error.status===403,`${host}:${port_} must be refused`);
  assert.equal(await connect(port,'127.0.0.1:443'),403);assert.equal(await connect(port,'metadata.example:443'),403);
  const plain=await new Promise(resolve=>http.get({host:'127.0.0.1',port,path:'http://public.example/'},response=>{response.resume();resolve(response.statusCode);}));
  assert.equal(plain,403,'plain HTTP is never proxied outside local fixtures');
  assert.equal(proxy.blocked,3);
});

test('the browser is found only where it is installed or named, and is never downloaded',async()=>{
  assert.equal(await findBrowser('/nonexistent/chrome'),null);
  if(chrome)assert.equal(await findBrowser(chrome),chrome);
});

// A small site with a script-rendered paragraph, a link, a button that adds text, and a banner that covers a link.
async function site(t) {
  const server=http.createServer((request,response)=>{
    response.setHeader('content-type','text/html; charset=utf-8');
    if(request.url==='/pricing')return response.end('<title>Pricing</title><h1>Pricing</h1><p>The team plan costs €24 per month.</p>');
    response.end(`<title>Launch notes</title><h1>Launch notes</h1><p>Static introduction.</p><a href="/pricing">See pricing</a><button onclick="document.body.insertAdjacentHTML('beforeend','<p>Details expanded.</p>')">Show details</button>
      <a id="hidden-link" href="/pricing" style="position:fixed;bottom:0;left:0">Under banner</a><div style="position:fixed;bottom:0;left:0;width:100%;height:60px;background:#fff">Cookie banner</div>
      <script>document.body.insertAdjacentHTML('beforeend','<p>Rendered by JavaScript: release on Friday.</p>')</script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t,complete,{browser={allowPrivate:true},tools=['workspace','memory','web','browser'],imageInput}={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-browser-')),store=await new Store(directory).init(),requests=[];
  await store.mutate(state=>{state.connections.push({id:'native-provider',type:'openai',name:'Fixture',model:'test-model',secret:store.seal('fixture-private-key'),...(imageInput?{imageInput}:{})});for(const bot of state.bots){bot.connectionId='native-provider';bot.tools=tools;bot.approvalPolicy='balanced';}});
  const engine=new NativeEngine(store,{runTimeout:60_000,browser,providers:{async complete(connection,request){requests.push(request);return complete(request,requests.length);}}});
  await engine.recover();
  t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests};
}
const current=store=>store.state.runs.bot_atlas;

test('a bot reads a script-rendered page, follows a link, is refused stale or covered targets, and sees a screenshot',needsChrome,async t=>{
  const base=await site(t);let pid,profile;
  const {engine,store,requests}=await fixture(t,async(request,count)=>{
    if(count===1)return {text:'',toolCalls:[call('open','browser_open',{url:`${base}/`})]};
    const result=lastTool(request);
    if(count===2){const session=engine.browsers.sessions.get(current(store).id);pid=session.child.pid;profile=session.profile;
      const banner=result.outline.match(/\[(e\d+)\] link "Under banner"/)[1],details=result.outline.match(/\[(e\d+)\] button "Show details"/)[1];
      engine.fixtureRefs={banner,details,revision:result.revision};return {text:'',toolCalls:[call('covered','browser_click',{ref:banner,revision:result.revision})]};}
    if(count===3)return {text:'',toolCalls:[call('expand','browser_click',{ref:engine.fixtureRefs.details,revision:engine.fixtureRefs.revision})]};
    if(count===4){engine.fixtureRefs.expanded=result;const link=result.outline.match(/\[(e\d+)\] link "See pricing"/)[1];return {text:'',toolCalls:[call('stale','browser_click',{ref:link,revision:engine.fixtureRefs.revision}),call('follow','browser_click',{ref:link,revision:result.revision})]};}
    if(count===5)return {text:'',toolCalls:[call('shot','browser_screenshot',{})]};
    return {text:'The team plan costs €24 per month.',toolCalls:[]};
  },{imageInput:'on'});
  await engine.start('bot_atlas','What does the team plan cost?');
  // Even links/buttons can cause site actions, so exercise exact approvals for the two valid clicks.
  let approvals=0;
  for(let attempts=0;attempts<1500 && !['completed','failed'].includes(current(store)?.status);attempts++) {
    const run=current(store);
    if(run?.status==='waiting_for_approval') {
      assert.equal(run.pending_controls[0].tool,'browser_click');
      try {
        await engine.control('bot_atlas','approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation,choice:'once'});
        approvals++;
      } catch(error) {
        // A stale exact identity is correctly refused; poll the current prompt again.
        assert.equal(error.status,409);assert.match(error.message,/This approval prompt changed/);
      }
    }
    await delay(10);
  }
  assert.equal(approvals,2);
  assert.equal(current(store).status,'completed',current(store).error);
  const opened=JSON.parse(requests[1].messages.filter(message=>message.role==='tool').at(-1).content);
  assert.equal(opened.title,'Launch notes');assert.equal(opened.status,200);assert.match(opened.outline,/^# Launch notes/);
  assert.match(opened.outline,/Rendered by JavaScript: release on Friday\./,'the outline includes what scripts render');
  assert.match(opened.notice,/untrusted data/);assert.equal(opened.revision,1);
  assert.match(lastTool(requests[2]).error,/covered by something else on the page \(“Cookie banner”\)/);
  assert.match(engine.fixtureRefs.expanded.outline,/Details expanded\./);
  const tools=requests[4].messages.filter(message=>message.role==='tool');
  assert.match(JSON.parse(tools.at(-2).content).error,/older view of the page/);
  const followed=JSON.parse(tools.at(-1).content);assert.equal(followed.title,'Pricing');assert.match(followed.outline,/€24 per month/);
  // The screenshot is a workspace file, recorded on the tool message, and shown to the model right after the result.
  const shot=lastTool(requests[5]);assert.match(shot.path,/^browser\/.+-127\.0\.0\.1\.png$/);
  const bytes=await fs.readFile(path.join(await getWorkspaceRoot(store,'bot_atlas'),shot.path));assert.deepEqual([...bytes.subarray(1,4)],[80,78,71]);
  const stored=store.state.conversations.bot_atlas.find(message=>message.role==='tool' && message.images);
  assert.equal(stored.images[0].path,shot.path);assert.ok(!JSON.stringify(store.state).includes(bytes.toString('base64').slice(0,100)));
  const shown=requests[5].messages.at(-1);assert.equal(shown.role,'user');assert.match(shown.content,/Images returned by the tool calls above/);assert.equal(shown.imageParts[0].mediaType,'image/png');
  assert.ok(requests[0].tools.some(tool=>tool.name==='browser_screenshot'));
  // The task's browser is gone with the task.
  await waitFor(()=>!alive(pid),5000);assert.equal(engine.browsers.sessions.size,0);
  // The profile folder is removed just after the process exits; under load that can take a moment.
  for(let tries=0;tries<100 && await fs.stat(profile).then(()=>true,()=>false);tries++)await delay(50);
  await assert.rejects(fs.stat(profile));
});

test('Stop closes the task\'s browser process',needsChrome,async t=>{
  const base=await site(t);let release;const gate=new Promise(resolve=>{release=resolve;});
  const {engine,store}=await fixture(t,async(request,count)=>{if(count===1)return {text:'',toolCalls:[call('open','browser_open',{url:`${base}/`})]};if(count===2)await gate;return {text:'Done.',toolCalls:[]};});
  const run=await engine.start('bot_atlas','Read the launch notes.');
  const session=await waitFor(()=>engine.browsers.sessions.get(run.id));
  await waitFor(()=>store.state.runs.bot_atlas.events.some(event=>event.type==='tool.completed'));
  await engine.control('bot_atlas','stop',{runId:run.id,remoteRunId:run.remoteRunId});release();
  await waitFor(()=>current(store)?.status==='cancelled');
  await waitFor(()=>!alive(session.child.pid),5000);assert.equal(engine.browsers.sessions.size,0);
});

test('without the Browser group, or without Chrome, no browser tools are offered',async t=>{
  const plain=await fixture(t,async()=>({text:'Done.',toolCalls:[]}),{tools:['workspace','web']});
  await plain.engine.start('bot_atlas','Hello.');await waitFor(()=>current(plain.store)?.status==='completed');
  assert.ok(!plain.requests[0].tools.some(tool=>tool.name.startsWith('browser_')));
  const missing=await fixture(t,async(request,count)=>count===1?{text:'',toolCalls:[call('open','browser_open',{url:'https://example.com/'})]}:{text:'Done.',toolCalls:[]},{browser:{executable:'/nonexistent/chrome'}});
  assert.equal(missing.engine.browsers.status().available,false);assert.equal(missing.engine.capabilities(missing.store.state.bots[0]).features.browser,false);
  await missing.engine.start('bot_atlas','Open a page.');await waitFor(()=>current(missing.store)?.status==='completed');
  assert.ok(!missing.requests[0].tools.some(tool=>tool.name.startsWith('browser_')));
  assert.match(lastTool(missing.requests[1]).error,/No Chrome or Chromium is installed on this engine\. Install one/);
});

test('outside local fixtures a bot can open only public HTTPS addresses',needsChrome,async t=>{
  const base=await site(t);
  const {engine,store,requests}=await fixture(t,async(request,count)=>count<=3?{text:'',toolCalls:[call(`open${count}`,'browser_open',{url:[`${base}/`,'https://localhost/','https://10.0.0.1/'][count-1]})]}:{text:'Blocked.',toolCalls:[]},{browser:{allowPrivate:false}});
  await engine.start('bot_atlas','Open the local pages.');await waitFor(()=>current(store)?.status==='completed');
  assert.match(lastTool(requests[1]).error,/public HTTPS URL/);
  assert.match(lastTool(requests[2]).error,/Private and local web addresses are blocked/);
  assert.match(lastTool(requests[3]).error,/Private and reserved web addresses are blocked/);
  assert.equal(engine.browsers.sessions.size,0);
});

test('a long data directory path still starts the browser, and nothing is left behind',needsChrome,async t=>{
  // Chromium's single-instance socket lives in its temporary folder, and Unix socket paths are limited to about 104 bytes.
  const root=path.join(await fs.mkdtemp(path.join(tmpdir(),'studio-long-')),'data-'+'x'.repeat(70),'browser-profiles');
  t.after(()=>fs.rm(path.dirname(path.dirname(root)),{recursive:true,force:true}));
  const session=await BrowserSession.start({executable:chrome,profileRoot:root});
  assert.ok(session.profile.length>110,'the profile path is longer than a socket path may be');
  assert.ok(session.scratch.length<70);
  await session.close();
  await assert.rejects(fs.stat(session.scratch));assert.deepEqual(await fs.readdir(root),[]);
});
