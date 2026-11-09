import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Desktop} from '../lib/desktop.mjs';

export async function desktopFixture(t,options={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-desktop-'))),store=await new Store(path.join(root,'data')).init(),calls=[],scope={runId:'run_fixture',botId:'bot_atlas'},state={value:'',sent:false,private:false,position:0,snapshot:0,complete:true};
  const identity=[{path:path.join(root,'agent-desktop'),sha256:'a'.repeat(64),device:1,inode:1},{path:path.join(root,'agent-desktop-macos-helper'),sha256:'b'.repeat(64),device:1,inode:2}];
  const driver=async input=>{
    calls.push(input);if(options.driver){const result=await options.driver(input,state);if(result!==undefined)return result;}
    const [command]=input.args;
    if(command==='version')return {version:'1.1.0'};
    if(command==='status')return {version:'1.1.0',platform:'macos',permissions:{accessibility:{state:'granted'}}};
    if(command==='list-windows')return [{id:'w-1',title:'Synthetic desktop'}];
    if(command==='snapshot'){const sid=`s${++state.snapshot}`;return {app:'Fixture',window:{id:'w-1'},snapshot_id:sid,complete:state.complete,tree:{role:'window',name:'Fixture',children:[{role:'textfield',name:'Message',value:state.value,states:state.private?['secure']:[],bounds:{x:state.position,y:0,width:100,height:30},ref_id:`@${sid}:e1`},{role:'button',name:'Send',states:[],ref_id:`@${sid}:e2`},...(state.sent?[{role:'text',name:'Delivered: '+state.value}]:[])]}};}
    if(command==='set-value'||command==='type'){state.value=input.args[input.args.indexOf('--')+2];return {action:command,disposition:{delivery:'delivered_unverified',retry:'unsafe'}};}
    if(command==='click'){state.sent=true;return {action:command};}
    return {action:command};
  };
  const desktop=new Desktop(store,{platform:options.platform||'darwin',identity:async()=>identity,driver});
  await desktop.init();t.after(async()=>{await desktop.close();await fs.rm(root,{recursive:true,force:true});});
  if(options.platform!=='linux')await desktop.configure({enabled:true,executable:identity[0].path,apps:[{name:'Fixture',botIds:['bot_atlas']}]});
  if(options.platform!=='linux')await desktop.admit(scope.runId,scope.botId);
  calls.length=0;const appId=desktop.config.apps[0]?.id,observe=()=>desktop.observe({appId,windowId:'w-1'},scope);
  const typeArgs=view=>({observationId:view.observationId,ref:view.tree.children[0].ref_id,action:'set-value',text:'Hello fixture',expectedValue:'',expect:{kind:'appears',role:'textfield',text:'Hello fixture'}});
  return {root,store,desktop,state,calls,scope,appId,observe,typeArgs};
}
