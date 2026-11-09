import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { NativeEngine } from '../lib/engine.mjs';
import { siteKey, callSites, refusalsIn, noteSiteRefusals, siteAccessCheck, decideSite, siteAccessNote } from '../lib/site-access.mjs';
import { noteWebResearch, webResearchSummary, networkCommand } from '../lib/web-research.mjs';
import { noteStall, stallNote } from '../lib/autonomous-work.mjs';

const BOT='bot_atlas',call=(id,name,args)=>({id,name,arguments:args});
const calls=(...toolCalls)=>({text:'',toolCalls}),answer=text=>({text,toolCalls:[]});
const waitFor=async(check,timeout=10_000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Site-access fixture timed out.');};
const blocked=url=>({url,status:403,contentType:'text/html',text:'403 ERROR\nThe request could not be satisfied.\nRequest blocked.'});

test('site keys group subdomains and never gate local addresses',()=>{
  assert.equal(siteKey('https://m.olx.ua/uk/list/'),'olx.ua');
  assert.equal(siteKey('https://www.olx.ua/api/v1/offers/1/limited-phones/'),'olx.ua');
  assert.equal(siteKey('https://shop.example.com.ua/x'),'example.com.ua');
  assert.equal(siteKey('https://example.co.uk'),'example.co.uk');
  for(const local of ['http://localhost:4311/api','http://127.0.0.1:8080','http://10.0.0.5/x','http://app.test/','http://[::1]:3000/'])assert.equal(siteKey(local),null,local);
  assert.equal(siteKey('not a url'),null);
  assert.deepEqual(callSites(call('t','terminal',{command:'curl -s "https://www.olx.ua/api/v1/offers/?q=1" && curl https://api.example.org/x'})).sort(),['example.org','olx.ua']);
  assert.deepEqual(callSites(call('w','workspace_write',{path:'a.md',content:'https://olx.ua'})),[]);
});

test('refusals come from engine-observed status codes, challenge pages and block phrases only',()=>{
  assert.deepEqual(refusalsIn(call('f','http_fetch',{url:'https://www.olx.ua/x'}),blocked('https://www.olx.ua/x')),[{site:'olx.ua',reason:'HTTP 403'}]);
  assert.deepEqual(refusalsIn(call('f','http_fetch',{url:'https://a.example/x'}),{url:'https://a.example/x',status:429,text:''}),[{site:'a.example',reason:'HTTP 429'}]);
  assert.deepEqual(refusalsIn(call('f','http_fetch',{url:'https://a.example/x'}),{url:'https://a.example/x',status:404,text:'Not found'}),[]);
  assert.deepEqual(refusalsIn(call('f','http_fetch',{url:'https://a.example/x'}),{url:'https://a.example/x',status:400,text:'{"error":{"detail":"Disallowed for this user"}}'}),[{site:'a.example',reason:'HTTP 400 block page'}]);
  assert.deepEqual(refusalsIn(call('b','browser_open',{url:'https://shop.example/'}),{url:'https://shop.example/',title:'Shop',outline:'ok',challenge:true}),[{site:'shop.example',reason:'bot challenge page'}]);
  assert.deepEqual(refusalsIn(call('b','browser_open',{url:'https://shop.example/'}),{url:'https://shop.example/',title:'Shop',outline:'Sign in with reCAPTCHA',challenge:false}),[]);
  const curl=call('t','terminal',{command:'curl -s "https://www.olx.ua/api/v1/offers/9/limited-phones/"'});
  assert.deepEqual(refusalsIn(curl,{exitCode:0,output:'{"error":{"status":400,"title":"Bad Request","detail":"Disallowed for this user"}}'}),[{site:'olx.ua',reason:'“Disallowed for this user”'}]);
  assert.deepEqual(refusalsIn(curl,{exitCode:0,output:'x\n__S:429\n'}),[{site:'olx.ua',reason:'HTTP 429'}]);
  assert.deepEqual(refusalsIn(curl,{exitCode:0,output:'{"data":{"phones":["073 171 0246"]}}'}),[]);
  // A local script printing earlier saved block pages contacts no site.
  assert.deepEqual(refusalsIn(call('t','terminal',{command:'python3 count.py'}),{exitCode:0,output:'715 x Request blocked'}),[]);
  assert.deepEqual(refusalsIn(call('t','terminal',{command:'grep -r captcha src/ https://x.example'}),{exitCode:0,output:'src/form.js: captcha widget'}),[]);
});

test('the ledger asks once at the threshold and remembers the owner’s decision per site',()=>{
  let state;
  const fetch=call('f','http_fetch',{url:'https://www.olx.ua/a'});
  for(let index=0;index<2;index++)state=noteSiteRefusals(state,fetch,blocked('https://www.olx.ua/a'));
  assert.equal(siteAccessCheck(state,fetch),null);
  assert.equal(noteSiteRefusals(state,fetch,{url:'https://www.olx.ua/a',status:200,text:'ok'}),state,'a successful read changes nothing');
  state=noteSiteRefusals(state,call('t','terminal',{command:'curl https://m.olx.ua/b'}),{exitCode:0,output:'Request blocked'});
  assert.equal(state.sites['olx.ua'].refusals,3);
  assert.deepEqual(siteAccessCheck(state,call('b','browser_open',{url:'https://www.olx.ua/'})),{action:'ask',site:'olx.ua',entry:state.sites['olx.ua']});
  assert.equal(siteAccessCheck(state,call('o','http_fetch',{url:'https://other.example/'})),null);
  assert.match(siteAccessNote(state),/olx\.ua: refused 3×/);
  const allowed=decideSite(state,'olx.ua','allowed');
  assert.equal(siteAccessCheck(allowed,fetch),null);assert.match(siteAccessNote(allowed),/owner allowed/);
  const denied=decideSite(state,'olx.ua','denied');
  assert.equal(siteAccessCheck(denied,fetch).action,'deny');assert.match(siteAccessNote(denied),/do not contact this site again/);
});

test('research counts browser navigations and network commands but not ordinary command failures',()=>{
  const curl=call('t','terminal',{command:'curl -s https://www.olx.ua/api/v1/offers/'});
  assert.equal(networkCommand(curl),true);
  assert.equal(networkCommand(call('t','terminal',{command:'curl -s http://localhost:4311/api/health'})),false);
  assert.equal(networkCommand(call('t','terminal',{command:'npm test'})),false);
  let state=noteWebResearch(undefined,curl,{exitCode:0,output:'{"data":[1,2]}'});
  assert.equal(state.commands,1);assert.equal(state.novel,1);
  assert.equal(noteWebResearch(state,curl,{exitCode:7,output:'curl: (7) Failed to connect'}),state,'a plain command failure is a coding signal');
  state=noteWebResearch(state,call('b','browser_open',{url:'https://www.olx.ua/'}),{url:'https://www.olx.ua/',title:'OLX',outline:'listing',challenge:false});
  assert.equal(state.browsed,1);assert.equal(state.novel,2);
  for(let index=0;index<6;index++)state=noteWebResearch(state,curl,{exitCode:0,output:`__S:403 attempt ${index}`});
  const summary=webResearchSummary(state);
  assert.equal(summary.failed,6);assert.equal(summary.blocked,true);assert.equal(summary.commands,7);
});

test('the stall counter counts tool steps per unchanged plan and resets on plan edits or owner answers',()=>{
  const plan={steps:[{id:'probe',title:'Probe the API',status:'in_progress'}]};
  let state=noteStall(undefined,{plan,turn:1,now:0});
  assert.equal(state.rounds,0);
  state=noteStall(state,{plan,turn:1,now:0});assert.equal(state.rounds,0,'two batches in one model step are one round');
  for(let turn=2;turn<=13;turn++)state=noteStall(state,{plan,turn,now:turn*60_000});
  assert.equal(state.rounds,12);
  assert.match(stallNote(state,plan,{now:13*60_000}),/“Probe the API” has stayed in progress for 12 tool steps \(about 13 min\)/);
  assert.equal(stallNote(state,plan,{nudgeRounds:13}),'');
  const edited={steps:[{id:'probe',title:'Probe the API',status:'completed'},{id:'scan',title:'Scan',status:'in_progress'}]};
  assert.equal(noteStall(state,{plan:edited,turn:14}).rounds,0);
  assert.equal(noteStall(state,{plan,turn:14,reset:true}).rounds,0);
  assert.equal(noteStall(state,{plan,turn:14,productive:true}).rounds,12,'new research evidence is not a stalled step');
  assert.equal(stallNote(state,plan,{nudgeRounds:0}),'');
  const unplanned=noteStall({...noteStall(undefined,{plan:null,turn:0}),rounds:12},{plan:null,turn:0});
  assert.match(stallNote(unplanned,null),/without a plan/);assert.doesNotMatch(stallNote(unplanned,null),/pauses and asks/);
});

async function fixture(t,complete,fetcher,options={}) {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-site-access-')),store=await new Store(directory).init(),requests=[];
  // Approve for me is on: the engine's own checkpoints must still reach the owner.
  await store.mutate(state=>{state.connections=[{id:'site_fixture',type:'custom',defaultModel:'fixture-model'}];Object.assign(state.bots.find(bot=>bot.id===BOT),{connectionId:'site_fixture',model:'fixture-model',tools:['web'],approvalPolicy:'auto'});});
  const engine=new NativeEngine(store,{runTimeout:20000,publicFetch:fetcher,providers:{async complete(_connection,request){requests.push(structuredClone({messages:request.messages,turnContext:request.turnContext}));return complete(request,requests.length);}},...options});
  await engine.recover();t.after(async()=>{await engine.close();await fs.rm(directory,{recursive:true,force:true});});
  return {store,engine,requests};
}
const decided=new Set();
const decide=async(f,choice,tool)=>{
  const run=await waitFor(()=>{const current=f.store.state.runs[BOT],prompt=current?.pending_controls?.[0];return current?.status==='waiting_for_approval' && prompt?.tool===tool && !decided.has(prompt.prompt_id)?structuredClone(current):null;});
  decided.add(run.pending_controls[0].prompt_id);
  await f.engine.control(BOT,'approval',{runId:run.id,remoteRunId:run.remoteRunId,request_id:run.pending_controls[0].prompt_id,execution_generation:run.execution_generation,choice});
  return run;
};

test('a site that keeps refusing waits for the owner even with Approve for me; a denial stops every later route to it',async t=>{
  const dispatched=[];
  const f=await fixture(t,async(request,turn)=>{
    if(turn<=3)return calls(call(`read_${turn}`,'http_fetch',{url:`https://${turn===1?'m':'www'}.olx.ua/api/v1/offers/${turn}/limited-phones/`}));
    if(turn===4)return calls(call('read_4','http_fetch',{url:'https://www.olx.ua/api/v1/offers/4/phones/'}));
    if(turn===5){
      const result=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);
      assert.equal(result.errorCode,'site_access_denied');assert.equal(result.site,'olx.ua');
      assert.match(JSON.stringify(request.turnContext),/olx\.ua: refused 3×.*owner declined workarounds/);
      return calls(call('read_5','http_fetch',{url:'https://olx.ua/other'}));
    }
    assert.equal(JSON.parse(request.messages.findLast(message=>message.role==='tool').content).errorCode,'site_access_denied');
    return answer('OLX refused automated access and you declined workarounds, so I could not check the phone numbers.');
  },async url=>{dispatched.push(url);return blocked(url);});
  const started=await f.engine.start(BOT,'Find all OLX listings for this phone number.');
  const waiting=await decide(f,'deny','site_access_review');
  assert.match(waiting.pending_controls[0].review.summary,/olx\.ua refused automated access 3 times/);
  assert.match(waiting.pending_controls[0].review.riskReason,/Working around a site’s refusal/);
  await f.engine.tasks.get(started.id);
  const done=f.store.state.runs[BOT];
  assert.equal(done.status,'completed',done.error);
  assert.equal(dispatched.length,3,'denied attempts never reach the site');
  assert.equal(done.events.filter(event=>event.type==='approval.request').length,1,'one decision per site');
  assert.ok(!done.events.some(event=>event.type==='approval.automatic'));
  assert.deepEqual(done.siteAccess.sites,[{site:'olx.ua',refusals:3,decision:'denied',lastReason:'HTTP 403'}]);
});

test('an owner-approved site keeps working for the rest of the request without asking again',async t=>{
  const dispatched=[];
  const f=await fixture(t,async(_request,turn)=>turn<=6?calls(call(`read_${turn}`,'http_fetch',{url:`https://www.olx.ua/item/${turn}`})):answer('Checked what OLX allowed.'),async url=>{dispatched.push(url);return url.endsWith('/5')?{url,status:200,contentType:'text/html',text:'<p>Listing five</p>'}:blocked(url);});
  const started=await f.engine.start(BOT,'Check these OLX listings.');
  await decide(f,'once','site_access_review');
  await f.engine.tasks.get(started.id);
  const done=f.store.state.runs[BOT];
  assert.equal(done.status,'completed',done.error);assert.equal(dispatched.length,6);
  assert.equal(done.events.filter(event=>event.type==='approval.request').length,1);
  assert.equal(done.siteAccess.sites[0].decision,'allowed');assert.equal(done.siteAccess.sites[0].refusals,5);
  assert.ok(done.events.some(event=>event.type==='site.access' && event.decision==='allowed'));
});

test('an autonomous task whose plan stops moving gets a note, then an owner checkpoint that can stop it',async t=>{
  const f=await fixture(t,async(request,turn)=>{
    if(turn===1)return calls(call('plan','task_plan_set',{steps:[{id:'probe',title:'Probe the source',status:'in_progress'},{id:'answer',title:'Answer',status:'pending'}]}));
    if(turn===4)assert.match(JSON.stringify(request.turnContext),/Engine progress checkpoint: plan step “Probe the source” has stayed in progress for 2 tool steps/);
    // Local re-processing: varied commands that never move the plan.
    return calls(call(`local_${turn}`,'terminal',{command:`echo attempt ${turn}`}));
  },async()=>{throw new Error('No network in this task.');},{stallNudgeRounds:2,stallAskRounds:4});
  await f.store.mutate(state=>{state.bots.find(bot=>bot.id===BOT).tools=['web','terminal'];});
  const started=await f.engine.start(BOT,'Research the source.');
  const waiting=await decide(f,'once','task_checkpoint');
  assert.match(waiting.pending_controls[0].review.summary,/4 tool steps .* on “Probe the source”/);
  await decide(f,'deny','task_checkpoint');
  await f.engine.tasks.get(started.id);
  const done=f.store.state.runs[BOT];
  assert.equal(done.events.filter(event=>event.type==='approval.request' && event.tool==='task_checkpoint').length,2,'the counter restarts after the owner lets it continue');
  assert.equal(done.status,'cancelled');
  assert.ok(done.events.some(event=>event.type==='task.stalled'));
  assert.ok(done.events.some(event=>event.type==='task.checkpoint' && event.decision==='continue'));
  assert.ok(done.events.some(event=>event.type==='task.checkpoint' && event.decision==='stopped'));
});
