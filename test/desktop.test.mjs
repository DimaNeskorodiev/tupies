import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Desktop} from '../lib/desktop.mjs';

import {desktopFixture} from './desktop-fixture.mjs';

test('desktop setup is explicit, Mac-local, engine-local and never grants tools',async t=>{
  const f=await desktopFixture(t);assert.equal(f.desktop.ready(),true);assert.ok(!f.store.state.bots[0].tools.includes('desktop'));assert.equal(f.store.state.desktop,undefined);
  const persisted=JSON.parse(await fs.readFile(path.join(f.desktop.root,'config.json'),'utf8'));assert.equal(persisted.identity.length,2);
  const status=await f.desktop.status({probe:true});assert.equal(status.driver.permissions.accessibility.state,'granted');assert.ok(f.calls.every(c=>!c.env.OPENAI_API_KEY&&!c.env.NODE_OPTIONS&&c.env.HOME.startsWith(f.desktop.root)));
});
test('desktop verifies new field state and sent message separately; stale refs cannot replay input',async t=>{
  const f=await desktopFixture(t),view=await f.observe(),args=f.typeArgs(view),reviews=[];
  const typed=await f.desktop.act(args,{...f.scope,approve:async review=>{reviews.push(review);return true;}});
  assert.equal(typed.delivery,'delivered');assert.equal(typed.verification,'required');assert.throws(()=>f.desktop.assertVerified(f.scope.runId));
  const verified=await f.desktop.verify({actionId:typed.actionId},f.scope);assert.equal(verified.passed,true);f.desktop.assertVerified(f.scope.runId);
  await assert.rejects(f.desktop.act(args,{...f.scope,approve:async()=>true}),/expired/);
  const send=await f.desktop.act({observationId:verified.observationId,ref:verified.tree.children[1].ref_id,action:'click',expect:{kind:'appears',role:'text',text:'Delivered: Hello fixture'}},{...f.scope,approve:async()=>true});
  assert.equal((await f.desktop.verify({actionId:send.actionId},f.scope)).passed,true);assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,1);assert.equal(f.calls.filter(c=>c.args[0]==='click').length,1);assert.equal(reviews[0].expectedValue,'');
});
test('desktop protects existing drafts, private fields and incomplete observations',async t=>{
  const f=await desktopFixture(t);f.state.value='An unsent owner draft';let view=await f.observe();
  await assert.rejects(f.desktop.act(f.typeArgs(view),{...f.scope,approve:async()=>true}),/expected value/);assert.equal(f.state.value,'An unsent owner draft');
  f.state.private=true;view=await f.observe();assert.equal(view.tree.children[0].value,undefined);assert.equal(view.tree.children[0].ref_id,undefined);assert.ok(!JSON.stringify(view).includes('An unsent owner draft'));
  await assert.rejects(f.desktop.observe({appId:f.appId,windowId:'w-1',screenshot:true},f.scope),/private fields/);
  f.state.complete=false;await assert.rejects(f.observe(),/incomplete/);assert.equal(f.calls.filter(c=>['set-value','type','click'].includes(c.args[0])).length,0);
});
test('desktop approvals bind original text, target state and current configuration',async t=>{
  const f=await desktopFixture(t),view=await f.observe();
  await assert.rejects(f.desktop.act(f.typeArgs(view),{...f.scope,approve:async()=>{f.state.value='Changed while reviewing';return true;}}),/changed while awaiting/);
  assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,0);
  await assert.rejects(f.desktop.configure({enabled:false,apps:[]}),/Stop desktop tasks/);
  await f.desktop.closeRun(f.scope.runId);await f.desktop.configure({enabled:false,apps:[]});assert.equal(f.desktop.ready(),false);
});
test('desktop rejects moved targets even if visible text stayed the same',async t=>{
  const f=await desktopFixture(t),view=await f.observe();
  await assert.rejects(f.desktop.act(f.typeArgs(view),{...f.scope,approve:async()=>{f.state.position=100;return true;}}),/target changed/);assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,0);
});
test('desktop refusal survives a new observation identity',async t=>{
  const f=await desktopFixture(t),view=await f.observe();await assert.rejects(f.desktop.act(f.typeArgs(view),{...f.scope,approve:async()=>false}),/not approved/);
  const fresh=await f.observe();await assert.rejects(f.desktop.act(f.typeArgs(fresh),{...f.scope,approve:async()=>true}),/denied/);assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,0);
});
test('desktop verifies uncertain delivery by inspection without replaying input',async t=>{
  let first=true;const f=await desktopFixture(t,{driver:async(input,state)=>{if(input.args[0]==='set-value'&&first){first=false;state.value=input.args[input.args.indexOf('--')+2];throw new Error('Synthetic lost acknowledgement');}}}),view=await f.observe();
  await assert.rejects(f.desktop.act(f.typeArgs(view),{...f.scope,approve:async()=>true}),e=>e.desktopDispatched===true);
  const observed=await f.observe();assert.equal(observed.pendingAction.delivery,'unknown');await assert.rejects(f.desktop.act(f.typeArgs(observed),{...f.scope,approve:async()=>true}),/previous desktop action/);
  assert.equal((await f.desktop.verify({actionId:observed.pendingAction.actionId},f.scope)).passed,true);assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,1);
});
test('desktop failed verification cannot weaken the original condition or certify success',async t=>{
  const f=await desktopFixture(t,{driver:async input=>input.args[0]==='set-value'?{action:'set-value'}:undefined}),view=await f.observe(),typed=await f.desktop.act(f.typeArgs(view),{...f.scope,approve:async()=>true});
  const result=await f.desktop.verify({actionId:typed.actionId},f.scope);assert.equal(result.passed,false);assert.throws(()=>f.desktop.assertVerified(f.scope.runId));
});
test('desktop scope, restart, owner assignment and global Mac lease are enforced',async t=>{
  const f=await desktopFixture(t),view=await f.observe();await f.desktop.admit('other','bot_atlas');await assert.rejects(f.desktop.observe({appId:f.appId,windowId:'w-1'},{runId:'other',botId:'bot_atlas'}),/Another task/);
  assert.throws(()=>f.desktop.prepare(f.typeArgs(view),{runId:'other',botId:'bot_atlas'}),/another task/);
  assert.throws(()=>f.desktop.app(f.appId,'bot_nova'),/not assigned/);
  await f.desktop.closeRun(f.scope.runId);assert.throws(()=>f.desktop.prepare(f.typeArgs(view),f.scope),/expired/);
  const fresh=new Desktop(f.store,{platform:'darwin',driver:async()=>({})});await fresh.init();assert.equal(fresh.sessions.size,0);assert.equal(fresh.observations.size,0);await fresh.close();
});
test('desktop repeated-state and hard action bounds survive changing arguments',async t=>{
  const f=await desktopFixture(t);for(let i=0;i<6;i++)await f.observe();await assert.rejects(f.observe(),/repeatedly returned/);
  f.desktop.sessions.get(f.scope.runId).actions=61;await assert.rejects(f.observe(),/60-action/);
});
test('desktop Stop aborts an in-flight command and does not adopt previous task handles',async t=>{
  let started;const wait=new Promise(resolve=>started=resolve),f=await desktopFixture(t,{driver:async input=>{if(input.args[0]==='snapshot'){started();await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));}}});
  const observing=f.observe(),rejected=assert.rejects(observing,/ended/);await wait;await f.desktop.closeRun(f.scope.runId);await rejected;assert.equal(f.desktop.sessions.size,0);
});
test('Linux exposes unavailable desktop metadata without creating a runtime directory',async t=>{
  const f=await desktopFixture(t,{platform:'linux'});assert.deepEqual(await f.desktop.status(),{available:false,enabled:false,apps:[]});await assert.rejects(fs.access(f.desktop.root));
});
test('desktop restart retains uncertainty and blocks old input and false final success',async t=>{
  const f=await desktopFixture(t),view=await f.observe(),action=await f.desktop.act(f.typeArgs(view),{...f.scope,approve:async()=>true});
  const restarted=new Desktop(f.store,{platform:'darwin'});await restarted.init();assert.equal(restarted.hasPending(f.scope.runId),true);assert.throws(()=>restarted.assertVerified(f.scope.runId));assert.throws(()=>restarted.session(f.scope.runId,f.scope.botId),/interrupted/);assert.equal((await restarted.status()).unfinishedActions[0].actionId,action.actionId);await restarted.close();
});
test('launch has an exact approval and needs a separate window check',async t=>{
  const f=await desktopFixture(t),launched=await f.desktop.launch({appId:f.appId},{...f.scope,approve:async review=>review.application==='Fixture'});assert.equal(launched.verification,'required');assert.throws(()=>f.desktop.assertVerified(f.scope.runId));assert.equal((await f.desktop.verify({actionId:launched.actionId},f.scope)).passed,true);assert.equal(f.calls.filter(c=>c.args[0]==='launch').length,1);
});
test('desktop text remains literal even when it resembles driver flags',async t=>{
  const f=await desktopFixture(t),view=await f.observe(),args={...f.typeArgs(view),text:'--headed --app Another application',expect:{kind:'appears',role:'textfield',text:'--headed --app Another application'}};const action=await f.desktop.act(args,{...f.scope,approve:async()=>true});assert.equal((await f.desktop.verify({actionId:action.actionId},f.scope)).passed,true);const call=f.calls.find(c=>c.args[0]==='set-value');assert.equal(call.args.at(-1),args.text);assert.ok(call.args.indexOf('--session')<call.args.indexOf('--'));assert.equal(call.args.filter(v=>v==='--headed').length,0);
});
test('disabled desktop can be saved without executing a missing or changed driver',async t=>{
  let refuse=false;const f=await desktopFixture(t,{driver:async()=>{if(refuse)throw new Error('Synthetic unavailable driver');}});refuse=true;await f.desktop.configure({enabled:false,executable:f.desktop.config.identity[0].path,apps:[]});assert.equal(f.desktop.ready(),false);assert.equal(f.calls.length,0);
});
test('desktop denial survives restart without reviving an old observation handle',async t=>{
  const f=await desktopFixture(t),view=await f.observe();await assert.rejects(f.desktop.act(f.typeArgs(view),{...f.scope,approve:async()=>false}),/not approved/);const restarted=new Desktop(f.store,f.desktop.options);await restarted.init();assert.equal(restarted.hasPending(f.scope.runId),false);const current=await restarted.observe({appId:f.appId,windowId:'w-1'},f.scope);await assert.rejects(restarted.act(f.typeArgs(current),{...f.scope,approve:async()=>true}),/denied/);await restarted.close();assert.equal(f.calls.filter(c=>c.args[0]==='set-value').length,0);
});
test('focus telemetry alone cannot invalidate a semantic click or count as general visible progress',async t=>{
  let focused=true,serial=0;const f=await desktopFixture(t,{driver:async input=>{if(input.args[0]==='snapshot')return {app:'Fixture',window:{id:'w-1'},complete:true,snapshot_id:`s${++serial}`,tree:{role:'window',name:'Fixture',children:[{role:'button',name:'Unchanged',ref_id:`@s${serial}:e1`,...(focused?{states:['focused']}: {})}]}};}});
  const view=await f.observe(),result=await f.desktop.act({observationId:view.observationId,ref:view.tree.children[0].ref_id,action:'click',expect:{kind:'changed'}},{...f.scope,approve:async()=>{focused=false;return true;}});assert.equal(f.calls.filter(c=>c.args[0]==='click').length,1);assert.equal((await f.desktop.verify({actionId:result.actionId},f.scope)).passed,false);
});
test('new application assignments cannot expand an already admitted task',async t=>{
  const f=await desktopFixture(t);await f.desktop.configure({enabled:true,executable:f.desktop.config.identity[0].path,apps:[{name:'Fixture',botIds:['bot_atlas']},{name:'New application',botIds:['bot_atlas']}]});const added=f.desktop.config.apps.find(a=>a.name==='New application');f.calls.length=0;
  await assert.rejects(f.desktop.observe({appId:added.id,windowId:'w-1'},f.scope),/original desktop snapshot/);assert.equal(f.calls.length,0);assert.deepEqual(f.desktop.allowedApps(f.scope.runId,f.scope.botId).map(a=>a.name),['Fixture']);await f.desktop.admit('new_run','bot_atlas');assert.equal(f.desktop.allowedApps('new_run','bot_atlas').length,2);
});
test('owner driver replacement requires a new task and cannot loosen a resumed snapshot',async t=>{
  const f=await desktopFixture(t),identity=f.desktop.config.identity,newPath=path.join(f.root,'replacement-driver');f.desktop.options.identity=async()=>[{...identity[0],path:newPath,sha256:'c'.repeat(64)},identity[1]];
  await f.desktop.configure({enabled:true,executable:newPath,apps:[{name:'Fixture',botIds:['bot_atlas']}]});assert.equal(f.desktop.hasAccess(f.scope.runId,f.scope.botId),false);await assert.rejects(f.observe(),/original desktop snapshot/);const restored=new Desktop(f.store,f.desktop.options);await restored.init();assert.equal(restored.hasAccess(f.scope.runId,f.scope.botId),false);await assert.rejects(restored.observe({appId:f.appId,windowId:'w-1'},{runId:'legacy_run',botId:'bot_atlas'}),/original desktop snapshot/);await restored.admit('new_run','bot_atlas');assert.equal(restored.hasAccess('new_run','bot_atlas'),true);await restored.close();
});
