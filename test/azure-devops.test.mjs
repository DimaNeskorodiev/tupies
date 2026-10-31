import test from 'node:test';
import assert from 'node:assert/strict';
import { AzureDevOps } from '../lib/azure-devops.mjs';

const TOKEN='azure-fixture-token',REPO='11111111-1111-1111-1111-111111111111',PERSON='22222222-2222-2222-2222-222222222222',AS_OF='2026-10-29T12:00:00Z';
const item=(id=42,extra={})=>({id,rev:7,fields:{'System.TeamProject':'Client Project','System.Title':'Fix assigned task','System.State':'Active','System.AssignedTo':{id:PERSON,displayName:'Fixture owner'},'System.Description':'<p>Repair the task.</p>','Microsoft.VSTS.Common.AcceptanceCriteria':'The test passes.'},...extra});
const pr=(extra={})=>({pullRequestId:17,repository:{id:REPO},sourceRefName:'refs/heads/tupies/task-42',targetRefName:'refs/heads/main',title:'Fix task 42',description:'Verified change.',status:'active',isDraft:true,...extra});
function fixture(handler,config={}) {
  const calls=[];const client=new AzureDevOps({organization:'fixture-org',project:'Client Project',token:TOKEN,...config,request:async(url,options)=>{const call={url:new URL(url),...options};calls.push(call);const data=await handler(call,calls);return data?.response ?? {status:200,data};}});return {client,calls};
}
function readFixture(call) {
  if(call.url.pathname.endsWith('/wiql'))return {queryType:'flat',asOf:AS_OF,workItems:[{id:42}]};
  if(call.url.pathname.endsWith('/workitemsbatch'))return {count:1,value:[item()]};
  if(call.url.pathname.endsWith(`/repositories/${REPO}`))return {id:REPO,name:'fixture-repo',project:{id:'33333333-3333-3333-3333-333333333333',name:'Client Project'},defaultBranch:'refs/heads/main',remoteUrl:`https://dev.azure.com/fixture-org/Client%20Project/_git/${REPO}`};
  if(call.url.pathname.endsWith('/workitems'))return {value:[{id:'42'}]};
  return pr();
}
const prInput={repositoryId:REPO,sourceBranch:'tupies/task-42',targetBranch:'main',title:'Fix task 42',description:'Verified change.',workItemId:42};

test('Azure assigned work is scoped to fixed organization/project and authenticated @Me snapshot',async()=>{
  const {client,calls}=fixture(readFixture);const result=await client.assignedWorkItems();
  assert.equal(result.items[0].id,42);assert.equal(result.items[0].rev,7);assert.equal(result.items[0].assignedToMe,true);assert.equal(result.items[0].asOf,AS_OF);assert.equal(result.truncated,false);
  assert.match(calls[0].body.query,/\[System.TeamProject\] = @Project AND \[System.AssignedTo\] = @Me/);assert.equal(calls[0].url.searchParams.get('$top'),'101');assert.equal(calls[1].body.asOf,AS_OF);
  for(const call of calls){assert.equal(call.url.origin,'https://dev.azure.com');assert.ok(call.url.pathname.startsWith('/fixture-org/Client%20Project/_apis/'));assert.equal(call.url.searchParams.get('api-version'),'7.1');assert.equal(call.headers.Authorization,`Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`);assert.equal(call.allowPrivateHttp,false);assert.equal(call.maxBytes,2_000_000);assert.equal(call.timeoutMs,30_000);assert.equal(call.responseType,'json');}
  assert.ok(!JSON.stringify(client).includes(TOKEN));assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('Azure rejects URL/path/WIQL injection and unsafe IDs before requests',async()=>{
  for(const organization of ['https://dev.azure.com/org','org/../../evil','org?x=y','org%2fother','localhost:80'])assert.throws(()=>new AzureDevOps({organization,project:'P',token:TOKEN}));
  for(const project of ['..','a/b','a\\b','a%2fb','P?foo=bar','\u0000'])assert.throws(()=>new AzureDevOps({organization:'org',project,token:TOKEN}));
  assert.throws(()=>new AzureDevOps({organization:'org',project:'P',token:'x\nAuthorization:y'}));
  const {client,calls}=fixture(readFixture);for(const id of ['1 OR 1=1','../../x',0,-1,1.5,true,2_147_483_648])await assert.rejects(client.workItem(id));
  await assert.rejects(client.repository('https://evil.example/repo'));assert.equal(calls.length,0);
  const quoted=fixture(call=>({queryType:'flat',asOf:AS_OF,workItems:[]}),{project:"Owner's [Project]"});await quoted.client.assignedWorkItems();assert.ok(!quoted.calls[0].body.query.includes("Owner's"));
});

test('Azure exact work item admission refuses unassigned items and preserves snapshot revision',async()=>{
  const denied=fixture(()=>({queryType:'flat',asOf:AS_OF,workItems:[]}));await assert.rejects(denied.client.workItem(42),error=>error.status===403);assert.equal(denied.calls.length,1);
  const {client,calls}=fixture(readFixture);const result=await client.workItem('42');assert.equal(result.rev,7);assert.match(calls[0].body.query,/\[System.Id\] = 42/);assert.equal(calls[0].url.searchParams.get('$top'),'1');assert.equal(calls[1].body.asOf,AS_OF);
});

test('Azure refuses incomplete, duplicate, unmatched and oversized read evidence',async()=>{
  for(const data of [{queryType:'flat',asOf:AS_OF,workItems:[{id:42},{id:42}]},{queryType:'flat',asOf:'invalid',workItems:[]},{queryType:'tree',asOf:AS_OF,workItems:[]}])await assert.rejects(fixture(()=>data).client.assignedWorkItems());
  for(const values of [[],[item(99)],[item(42,{fields:{...item().fields,'System.TeamProject':'Other'}})],[item(42,{fields:{...item().fields,'System.AssignedTo':null}})]])await assert.rejects(fixture(call=>call.url.pathname.endsWith('/wiql')?readFixture(call):{value:values}).client.workItem(42));
  await assert.rejects(fixture(()=>({value:'x'.repeat(2_000_001)})).client.assignedWorkItems(),/oversized/);
});

test('Azure caps assignment batches and remote content and omits untrusted external links',async()=>{
  const {client,calls}=fixture(call=>call.url.pathname.endsWith('/wiql')?{queryType:'flat',asOf:AS_OF,workItems:Array.from({length:101},(_,i)=>({id:i+1}))}:{value:call.body.ids.map(id=>item(id,{fields:{...item().fields,'System.Description':id===1?'x'.repeat(21_000):''},_links:{safe:{href:`https://dev.azure.com/fixture-org/_apis/wit/workItems/${id}`},external:{href:'https://evil.example/steal'},credentials:{href:'https://secret@dev.azure.com/fixture-org/x'}}}))});
  const result=await client.assignedWorkItems();assert.equal(result.items.length,100);assert.equal(result.truncated,true);assert.equal(calls[1].body.ids.length,100);assert.equal(result.items[0].description.length,20_000);assert.equal(result.items[0].contentTruncated,true);assert.deepEqual(result.items[0].links.map(link=>link.name),['safe']);
});

test('Azure rejects redirects and credential-reflecting transport errors without following or leaking',async()=>{
  for(const status of [302,307,401,403,500]){const {client,calls}=fixture(()=>({response:{status,data:{message:TOKEN},headers:{location:'https://evil.example/'}}}));await assert.rejects(client.assignedWorkItems(),error=>!error.message.includes(TOKEN));assert.equal(calls.length,1);}
  const {client,calls}=fixture(()=>{throw new Error(TOKEN);});await assert.rejects(client.assignedWorkItems(),error=>!error.message.includes(TOKEN));assert.equal(calls.length,1);
});

test('Azure draft PR creation requires exact approval and verifies the linked item without merging',async()=>{
  const {client,calls}=fixture(readFixture);await assert.rejects(client.pullRequest(prInput),/exact approval/);assert.equal(calls.length,0);
  for(const override of [{sourceBranch:'main'},{sourceBranch:'refs/tags/v1'},{sourceBranch:'x..y'},{sourceBranch:'x.lock'},{title:'x\nBad'},{autoCompleteSetBy:{id:PERSON}}])await assert.rejects(client.pullRequest({...prInput,...override},{approved:true}));assert.equal(calls.length,0);
  const result=await client.pullRequest(prInput,{approved:true});assert.equal(result.outcome,'created');assert.equal(result.verified,true);assert.equal(result.workItemLinked,true);assert.equal(result.isDraft,true);
  const writes=calls.filter(call=>call.url.pathname.endsWith('/pullrequests'));assert.equal(writes.length,1);assert.deepEqual(writes[0].body,{sourceRefName:'refs/heads/tupies/task-42',targetRefName:'refs/heads/main',title:'Fix task 42',description:'Verified change.',isDraft:true,workItemRefs:[{id:'42'}]});assert.ok(calls.every(call=>['GET','POST'].includes(call.method)));
});

test('Azure uncertain PR writes are never retried and preserve an unknown outcome',async()=>{
  for(const outcome of ['transport',502,302,'malformed']){
    const {client,calls}=fixture(call=>{if(!call.url.pathname.endsWith('/pullrequests'))return readFixture(call);if(outcome==='transport')throw new Error(`lost ack ${TOKEN}`);if(outcome==='malformed')return {pullRequestId:17};return {response:{status:outcome,data:{message:TOKEN}}};});
    await assert.rejects(client.pullRequest(prInput,{approved:true}),error=>error.outcome==='unknown' && error.code==='azure_write_outcome_unknown' && !error.message.includes(TOKEN));assert.equal(calls.filter(call=>call.url.pathname.endsWith('/pullrequests')).length,1);
  }
});

test('Azure keeps a created PR when read-back fails and distinguishes rejected writes',async()=>{
  const {client,calls}=fixture(call=>{if(call.url.pathname.endsWith('/pullrequests/17'))throw new Error(TOKEN);return readFixture(call);});const result=await client.pullRequest(prInput,{approved:true});assert.equal(result.outcome,'created');assert.equal(result.id,17);assert.equal(result.verified,false);assert.equal(result.workItemLinked,false);assert.equal(calls.filter(call=>call.url.pathname.endsWith('/pullrequests')).length,1);
  const rejected=fixture(call=>call.url.pathname.endsWith('/pullrequests')?{response:{status:403,data:{message:TOKEN}}}:readFixture(call));await assert.rejects(rejected.client.pullRequest(prInput,{approved:true}),error=>error.outcome==='rejected' && error.status===401);
});

test('Azure cancellation before dispatch causes no request and no claimed write outcome',async()=>{
  const {client,calls}=fixture(readFixture),controller=new AbortController();controller.abort(new Error(TOKEN));await assert.rejects(client.pullRequest(prInput,{approved:true,signal:controller.signal}),error=>error.status===499 && !error.outcome && !error.message.includes(TOKEN));assert.equal(calls.length,0);
});

test('Azure resolves only the requested repository name and returns its verified UUID destination',async()=>{
  const {client,calls}=fixture(()=>({id:REPO,name:'Client Repository',project:{id:PERSON,name:'Client Project'},defaultBranch:'refs/heads/main',remoteUrl:'https://secret:token@evil.example/repo'}));
  const result=await client.resolveRepository('Client Repository');assert.equal(result.id,REPO);assert.equal(calls[0].url.pathname,`/fixture-org/Client%20Project/_apis/git/repositories/Client%20Repository`);assert.equal(result.remoteUrl,`https://dev.azure.com/fixture-org/Client%20Project/_git/${REPO}`);assert.ok(!JSON.stringify(result).includes('secret'));
  for(const value of ['../other','https://evil.example','a%2fb'])await assert.rejects(client.resolveRepository(value));assert.equal(calls.length,1);
  await assert.rejects(fixture(()=>({id:REPO,name:'Different repository',project:{name:'Client Project'}})).client.resolveRepository('Requested'),/unmatched/);
  await assert.rejects(fixture(()=>({id:REPO,name:'Requested',project:{name:'Other'}})).client.resolveRepository('Requested'),/unmatched/);
});
