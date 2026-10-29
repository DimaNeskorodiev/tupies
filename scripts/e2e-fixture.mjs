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
    const input=JSON.parse(Buffer.concat(chunks).toString()).input || [];
    const text=item=>typeof item.content==='string'?item.content:(item.content || []).map(part=>part.text || '').join('\n');
    const taskIndex=input.findLastIndex(item=>item.role==='user' && /E2E /i.test(text(item)) && !text(item).includes('<turn_context>'));
    const task=taskIndex<0?'':text(input[taskIndex]);
    const results=input.slice(taskIndex+1).filter(item=>item.type==='function_call_output');
    const guidance=input.slice(taskIndex+1).filter(item=>item.role==='user' && text(item).startsWith('Additional owner guidance for this same task:')).map(text).join('\n');
    let result;
    if (/E2E fail/i.test(task)) {res.writeHead(503);return res.end(JSON.stringify({error:{message:'Deliberate QA provider outage.'}}));}
    if (/E2E steer/i.test(task)) {
      if(!guidance){await new Promise(resolve=>{const timer=setTimeout(resolve,15000);res.on('close',()=>{clearTimeout(timer);resolve();});});if(res.destroyed)return;}
      result=answer(guidance?`QA additional guidance applied to the same task.\n\n${guidance.split('\n\n')[0]}`:'The initial fixture response finished before any guidance.');
    }
    else if (/E2E stop/i.test(task)) {await new Promise(resolve=>{const timer=setTimeout(resolve,60000);res.on('close',()=>{clearTimeout(timer);resolve();});});if(res.destroyed)return;result=answer('The waiting fixture finished.');}
    else if (results.length) result=answer(`QA workflow finished. Tool result:\n\n${results.at(-1).output}`);
    else if (/E2E question/i.test(task)) result=call('ask_user',{questions:[{id:'format',header:'Format',prompt:'Which format should the QA report use?',options:[{id:'pdf',label:'PDF'},{id:'docx',label:'Word'}]}]});
    else if (/E2E pdf/i.test(task)) result=call('documents_create',{path:'qa-report.pdf',document:{title:'QA report',content:'Created by the real Tupies document worker.\n\n| Check | Result |\n| --- | --- |\n| Export | Passed |'}});
    else if (/E2E approv/i.test(task)) result=call('workspace_write',{path:'qa-approved.txt',content:'Exact QA approval contents.\n'});
    else result=answer('QA reply: **rich chat works**.\n\n| Item | Result |\n| --- | --- |\n| Local fixture | Ready |\n\n```js\nconst ready = true;\n```\n\nThis is a deterministic fixture, not a live model quality measurement.');
    res.end(JSON.stringify(result));
  } catch {res.writeHead(500);res.end(JSON.stringify({error:{message:'QA fixture failed.'}}));}
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false,runTimeout:90000});
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
  state.connections.push({id:'qa-provider',name:'Local QA fixture',type:'openai',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,secret:app.store.seal('disposable-qa-key'),defaultModel:'qa-model',status:'connected',models:[{id:'qa-model',name:'QA model'}]});
  for(const bot of state.bots){bot.connectionId='qa-provider';bot.model='qa-model';bot.approvalPolicy=bot.id==='bot_nova'?'strict':'balanced';bot.collaborators=state.bots.filter(other=>other.id!==bot.id).map(other=>other.id);}
});
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(directory,{recursive:true,force:true});}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>close().then(()=>process.exit(0)));
process.on('SIGUSR1',()=>{fault=fault==='http'?'':'http';console.log(`QA transport: ${fault || 'ready'}`);});
process.on('SIGUSR2',()=>{fault=fault==='connection'?'':'connection';console.log(`QA transport: ${fault || 'ready'}`);});
process.on('SIGALRM',()=>{dropNextSubmission=true;console.log('QA transport: next accepted message acknowledgement will be dropped');});
console.log(JSON.stringify({url,password,pid:process.pid,disposable:true,scenarios:['E2E chat','E2E question','E2E pdf','E2E approval (Nova requires approval)','E2E steer','E2E stop','E2E fail']}));
