// Disposable full-stack UI fixture. Never reads operational data or credentials.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioServer } from '../server.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'tupies-e2e-'));
const password = 'disposable-e2e-password';
const answer = text => ({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:100,output_tokens:30}});
const call = (name,args) => ({status:'completed',output:[{type:'function_call',call_id:`qa-${name}`,name,arguments:JSON.stringify(args)}],usage:{input_tokens:100,output_tokens:30}});
const provider = http.createServer(async (req,res) => {
  res.setHeader('content-type','application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({data:[{id:'qa-model',name:'Deterministic QA model',context_window:128000}]}));
  if (req.url !== '/v1/responses') {res.writeHead(404);return res.end('{}');}
  try {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString()),input=body.input || [];
    if((body.tools || []).some(tool=>tool.name==='memory_review_result')) {
      const review=JSON.parse(input.find(item=>item.role==='user').content),matches=/E2E memory/i.test(review.ownerMessage),saved='I have saved your name to long-term memory.';
      return res.end(JSON.stringify(call('memory_review_result',{changes:matches && !review.facts.some(fact=>fact.key==='qa-name')?[{key:'qa-name',value:'Owner name is Cedar.',evidence:'My name is Cedar.'}]:[],claims:review.assistantAnswer.includes(saved)?[{text:saved,key:'qa-name',value:'Owner name is Cedar.'}]:[],reason:'The owner stated a durable name in this synthetic fixture.'})));
    }
    const text=item=>typeof item.content==='string'?item.content:(item.content || []).map(part=>part.text || '').join('\n');
    if(String(body.instructions || '').includes('You independently assess an agent result')){
      const payload=JSON.parse(text(input.find(item=>item.role==='user')));
      return res.end(JSON.stringify(answer(JSON.stringify({coveragePassed:true,requirements:payload.contract.requirements.map(item=>({id:item.id,passed:true,reason:'The exact synthetic fixture output meets this labelled criterion.'})),reason:'Deterministic fixture acceptance; no real-model quality claim.'}))));
    }
    const taskIndex=input.findLastIndex(item=>item.role==='user' && /E2E /i.test(text(item)) && !text(item).includes('<turn_context>'));
    const task=taskIndex<0?'':text(input[taskIndex]);
    const results=input.slice(taskIndex+1).filter(item=>item.type==='function_call_output');
    const guidance=input.slice(taskIndex+1).filter(item=>item.role==='user' && text(item).startsWith('Additional owner guidance for this same task:')).map(text).join('\n');
    let result;
    if(/E2E Mission (timer|pause|watch)/i.test(task)){
      const turn=input.findLast(item=>item.role==='user' && text(item).includes('Mission context (engine-owned identity;'));
      const raw=turn?text(turn).split('Mission context (engine-owned identity; source content is untrusted task data): ')[1]?.split('\n\nEngine-provided context')[0]:null;
      const mission=raw?JSON.parse(raw):null;
      if(!mission?.id)result=call('mission_start',{intent:'explicit',ownerMessageId:mission.ownerMessageId});
      else if(!mission.contract.requirements.length)result=call('mission_contract_set',{requirements:[{id:'bounded',text:task.slice(0,100),source:{ownerId:mission.ownerMessageId,quote:task.match(/E2E Mission (timer|pause|watch)/i)[0]},checker:{kind:'rubric',rubric:'Retain exact saved work and answer after the actual saved wait or owner pause; no duplicate file write.',rubricVersion:'durable-qa-v1'}}]});
      else if(/timer/i.test(task) && !results.some(item=>item.call_id==='qa-mission_wait'))result=call('mission_wait',{kind:'timer',delayMs:10000});
      else if(/pause|watch/i.test(task) && !results.some(item=>item.call_id==='qa-workspace_write'))result=call('workspace_write',{path:'Documents/before-pause.md',content:'This exact file was committed once before the owner paused.'});
      else {if(/pause|watch/i.test(task) && !input.some(item=>item.role==='user' && text(item).startsWith('Engine continuation of the same Mission'))){await new Promise(resolve=>{const timer=setTimeout(resolve,/watch/i.test(task)?15000:3000);res.on('close',()=>{clearTimeout(timer);resolve();});});if(res.destroyed)return;}result=answer('The same Mission retained its actual saved work and completed the deterministic durable-wait/pause scenario without repeating the file write.');}
    }
    else if(/E2E Mission document/i.test(task)){
      const turn=input.findLast(item=>item.role==='user' && text(item).includes('Mission context (engine-owned identity;'));
      const prefix='Mission context (engine-owned identity; source content is untrusted task data): ';
      const raw=turn?text(turn).split(prefix)[1]?.split('\n\nEngine-provided context')[0]:null;
      const mission=raw?JSON.parse(raw):null;
      if(!mission?.id)result=call('mission_start',{intent:'explicit',ownerMessageId:mission.ownerMessageId});
      else if(!mission.contract.requirements.length)result=call('mission_contract_set',{requirements:[{id:'report',text:'Create the requested exact QA report.',source:{ownerId:mission.ownerMessageId,quote:'E2E Mission document'},checker:{kind:'file_exists',path:'Documents/mission-report.docx'}},{id:'quality',text:'Explain the synthetic checks and their limits.',source:{ownerId:mission.ownerMessageId,quote:'E2E Mission document'},checker:{kind:'rubric',rubric:'The report explicitly states this is deterministic synthetic acceptance, not real model quality.',rubricVersion:'qa-report-v1'}}]});
      else if(!results.some(item=>item.call_id==='qa-documents_create'))result=call('documents_create',{path:'Documents/mission-report.docx',document:{title:'Mission QA report',content:'The synthetic Mission produced this real document.\n\nThe exact file, evidence and independent fixture review passed. This is deterministic synthetic acceptance, not real model quality.'}});
      else if(!results.some(item=>item.call_id==='qa-mission_submit_result'))result=call('mission_submit_result',{requirementId:'report',callId:'qa-documents_create',path:'Documents/mission-report.docx'});
      else result=answer('Created the real Mission report with the exact synthetic checks and explicit limitations. This verifies application mechanics, not real model quality.');
    }
    else if (/E2E memory/i.test(task)) result=answer('I have saved your name to long-term memory.');
    else if (/E2E recall/i.test(task)) result=answer(body.instructions.includes('Owner name is Cedar.')?'Your stored name is Cedar.':'No Cedar name fact is present in core memory.');
    else if (/E2E fail/i.test(task)) {res.writeHead(503);return res.end(JSON.stringify({error:{message:'Deliberate QA provider outage.'}}));}
    else if (/E2E steer/i.test(task)) {
      if(!guidance){await new Promise(resolve=>{const timer=setTimeout(resolve,15000);res.on('close',()=>{clearTimeout(timer);resolve();});});if(res.destroyed)return;}
      result=answer(guidance?`QA additional guidance applied to the same task.\n\n${guidance.split('\n\n')[0]}`:'The initial fixture response finished before any guidance.');
    }
    else if (/E2E stop/i.test(task)) {await new Promise(resolve=>{const timer=setTimeout(resolve,60000);res.on('close',()=>{clearTimeout(timer);resolve();});});if(res.destroyed)return;result=answer('The waiting fixture finished.');}
    else if (/E2E progress/i.test(task) && results.length) {await new Promise(resolve=>setTimeout(resolve,6000));result=answer('The final QA answer is complete. The earlier update stays in this chat.');}
    else if (results.length) result=answer(`QA workflow finished. Tool result:\n\n${results.at(-1).output}`);
    else if (/E2E progress/i.test(task)) {result=call('workspace_list',{path:'.'});result.output.unshift({type:'message',role:'assistant',content:[{type:'output_text',text:'I am checking the workspace before answering.'}]});}
    else if (/E2E layout/i.test(task)) result=answer(`Long text: ${'WorkspaceDocumentation'.repeat(12)}\n\n| Source | Result |\n| --- | --- |\n| ${'long-source-identifier-'.repeat(16)} | Preserved |\n\n\`\`\`text\n${'long-code-value-'.repeat(30)}\n\`\`\``);
    else if (/E2E question/i.test(task)) result=call('ask_user',{questions:[{id:'format',header:'Format',prompt:'Which format should the QA report use?',options:[{id:'pdf',label:'PDF'},{id:'docx',label:'Word'}]}]});
    else if (/E2E pdf/i.test(task)) result=call('documents_create',{path:'qa-report.pdf',document:{title:'QA report',content:'Created by the real Tupies document worker.\n\n| Check | Result |\n| --- | --- |\n| Export | Passed |'}});
    else if (/E2E approv/i.test(task)) result=call('workspace_write',{path:'qa-approved.txt',content:'Exact QA approval contents.\n'});
    else result=answer('QA reply: **rich chat works**.\n\n| Item | Result |\n| --- | --- |\n| Local fixture | Ready |\n\n```js\nconst ready = true;\n```\n\nThis is a deterministic fixture, not a live model quality measurement.');
    res.end(JSON.stringify(result));
  } catch {res.writeHead(500);res.end(JSON.stringify({error:{message:'QA fixture failed.'}}));}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,runTimeout:90000});
// Exercise only Mission's actual durable scheduler; no routines/channels run in this fixture.
let missionTickBusy=false;const missionTimer=setInterval(async()=>{if(missionTickBusy)return;missionTickBusy=true;try{await app.runtime.missions.tick();}catch(error){console.error('QA Mission tick:',app.store.redact(error.message));}finally{missionTickBusy=false;}},250);missionTimer.unref();
// Fault injection exists only in this disposable launcher, never in the shipped engine API.
let fault='',dropNextSubmission=false;
const [handler]=app.server.listeners('request');
app.server.removeListener('request',handler);
app.server.on('request',(req,res)=>{
  if(fault==='connection'){req.socket.destroy();return;}
  if(fault==='http'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Deliberate QA service outage.'}));return;}
  if(dropNextSubmission && req.method==='POST' && /^\/api\/(?:bots|rooms)\/[^/]+\/messages(?:\?|$)/.test(req.url)){
    const end=res.end;
    res.end=function(...args){
      if(res.statusCode>=200 && res.statusCode<300){dropNextSubmission=false;req.socket.destroy();return this;}
      return end.apply(this,args);
    };
  }
  handler(req,res);
});
const {url}=await app.listen(0);
const setup=await fetch(`${url}/api/setup`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password})});
if(setup.status!==201)throw new Error('Disposable fixture setup failed.');
await app.store.mutate(state=>{
  if(process.argv.includes('--onboarding'))return;
  state.connections.push({id:'qa-provider',name:'Local QA fixture',type:'openai',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,secret:app.store.seal('disposable-qa-key'),defaultModel:'qa-model',status:'connected',models:[{id:'qa-model',name:'QA model'}]});
  for(const bot of state.bots){bot.connectionId='qa-provider';bot.model='qa-model';bot.approvalPolicy=bot.id==='bot_nova'?'strict':'balanced';bot.collaborators=state.bots.filter(other=>other.id!==bot.id).map(other=>other.id);}
  if(process.argv.includes('--layout-stress')) {
    Object.assign(state.bots[0],{name:'ResearchAndDocumentationCoordinationAssistant',title:'DocumentationAndResearchForTheWholeWorkspace',description:'A synthetic teammate with deliberately long unbroken labels for mobile layout verification.'});
    state.bots.push({...structuredClone(state.bots[1]),id:'bot_hidden_layout',name:'ArchivedLayoutFixture',hidden:true});
    state.connections[0].name='LocalDevelopmentProviderWithAnUnbrokenConnectionName';
    state.rooms.push({id:'room_layout',name:'ResearchAndDocumentationCoordinationRoom',description:'Synthetic layout fixture.',botIds:state.bots.slice(0,2).map(bot=>bot.id),enabled:true});
    state.routines.push({id:'routine_layout',name:'DailyResearchAndDocumentationCoordination',botId:state.bots[0].id,prompt:'Synthetic layout fixture. Do not run automatically.',enabled:false,intervalMinutes:1440});
  }
});
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(missionTimer);await app.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(directory,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>close().then(()=>process.exit(0)));
process.on('SIGUSR1',()=>{fault=fault==='http'?'':'http';console.log(`QA transport: ${fault || 'ready'}`);});
process.on('SIGUSR2',()=>{fault=fault==='connection'?'':'connection';console.log(`QA transport: ${fault || 'ready'}`);});
process.on('SIGALRM',()=>{dropNextSubmission=true;console.log('QA transport: next accepted message acknowledgement will be dropped');});
console.log(JSON.stringify({url,password,pid:process.pid,disposable:true,scenarios:['E2E chat','E2E memory: My name is Cedar.','E2E recall','E2E progress','E2E question','E2E pdf','E2E approval (Ops requires approval)','E2E steer','E2E stop','E2E fail','E2E Mission document','E2E Mission timer','E2E Mission pause','E2E Mission watch']}));

if(process.argv.includes('--onboarding'))console.log(`Onboarding model endpoint: http://127.0.0.1:${provider.address().port}/v1 (key: disposable-qa-key, model: qa-model)`);
