import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('../public/activity-flow-model.js',import.meta.url),'utf8');
const sandbox={window:{},URL};vm.runInNewContext(source,sandbox,{filename:'activity-flow-model.js'});
const bot={id:'bot_fixture',name:'Atlas'};
const build=(run={},options={})=>JSON.parse(JSON.stringify(sandbox.window.StudioActivityModel.build(bot,{id:'run_fixture',status:'running',events:[],...run},options)));
const started=(tool,args={},id='call_1')=>({id:`start_${id}`,type:'tool.started',tool,arguments:args,toolCallId:id});
const completed=(tool,value,id='call_1',error=false)=>({id:`finish_${id}`,type:'tool.completed',tool,toolCallId:id,error,preview:typeof value==='string'?value:JSON.stringify(value)});
const allText=graph=>JSON.stringify(graph);
const factNodes=graph=>graph.nodes.filter(node=>node.id.startsWith('fact-'));

test('prompt classification changes geometry kind without inventing tool actions or arithmetic',()=>{
  for(const [prompt,kind] of [['Find sources on astronomy','research'],['Analyze this CSV','analysis'],['Choose a plan','reasoning'],['Delegate to a teammate','team'],['What is 12 + 7?','research']]) {
    const graph=build({}, {prompt});assert.equal(graph.kind,kind);assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,1);assert.equal(graph.caption,'Thinking');assert.equal(graph.context,'');
    assert.equal(factNodes(graph).length,0);assert.doesNotMatch(allText(graph),/HTTP 200|10°C|10,000|Indoor table|Reply received/);
  }
});

test('real tool events override prompt hints and expose only matched recorded results',()=>{
  const graph=build({events:[started('workspace_read',{path:'reports/data.csv'}),completed('workspace_read',{path:'reports/data.csv',size:123,rows:12})]}, {prompt:'Find the weather'});
  assert.equal(graph.kind,'analysis');assert.match(graph.caption,/Read workspace result received/);
  assert.ok(graph.nodes.some(node=>node.value==='reports/data.csv'));assert.ok(factNodes(graph).some(node=>node.value==='123'));assert.ok(factNodes(graph).some(node=>node.value==='12'));
  const pending=build({events:[started('http_fetch',{url:'https://example.com/one'},'a'),completed('http_fetch',{status:201},'b')]});
  assert.ok(pending.nodes.some(node=>node.label==='In progress')===false);
  assert.equal(pending.edges.filter(edge=>edge.from.startsWith('tool-')&&edge.to.startsWith('result-')).length,1);
  const sourceNode=pending.nodes.find(node=>node.value==='https://example.com/one');
  const pendingTool=pending.edges.find(edge=>edge.from===sourceNode.id).to;
  assert.ok(!pending.edges.some(edge=>edge.from===pendingTool&&edge.to.startsWith('result-')),'unmatched completion cannot complete another source');
});

test('HTTP facts require a complete JSON body and do not repair truncated work-log output',()=>{
  const events=[started('http_fetch',{url:'https://example.com/weather'}),completed('http_fetch',{url:'https://example.com/weather',status:200,contentType:'application/json',text:JSON.stringify({temperature:7,wind:14,condition:'Cloudy'})})];
  const graph=build({events});assert.equal(graph.kind,'research');assert.match(graph.context,/HTTP 200/);assert.ok(factNodes(graph).some(node=>node.value==='7'));assert.ok(factNodes(graph).some(node=>node.value==='14'));
  assert.ok(graph.edges.some(edge=>edge.from==='input'&&edge.text==='example.com/weather'&&edge.detail==='Recorded tool input'));
  const truncated=build({events:[events[0],{...events[1],preview:'{"status":200,"text":"'+'.'.repeat(1980)}]});
  assert.equal(factNodes(truncated).length,0);assert.match(truncated.context,/incomplete|display limit/i);assert.doesNotMatch(allText(truncated),/HTTP 200/);
  const bodyTruncated=build({events:[events[0],completed('http_fetch',{status:200,text:'{"temperature":7,'})]});
  assert.ok(!factNodes(bodyTruncated).some(node=>node.label==='temperature'));assert.ok(factNodes(bodyTruncated).some(node=>node.label==='status'));
});

test('an error flag, HTTP error, process failure or returned error never becomes successful output facts',()=>{
  for(const [tool,result,error] of [['http_fetch',{status:403,temperature:55},false],['workspace_read',{error:'Access denied',size:50},false],['shell_read',{status:'failed',exitCode:1},false],['documents_create',{written:true,size:100},true]]) {
    const graph=build({events:[started(tool,{path:'report.md'}),completed(tool,result,'call_1',error)]});
    assert.equal(graph.failed,true);assert.equal(factNodes(graph).length,0);assert.match(graph.caption,/failed/);assert.ok(graph.nodes.some(node=>node.label==='Tool failed'));
  }
});

test('credential destinations and sensitive fields are omitted even from signatures and inspection values',()=>{
  const secret='super-sensitive-example-value';
  const graph=build({events:[started('http_fetch',{url:`https://alice:${secret}@example.com/data?api_key=${secret}#${secret}`}),completed('http_fetch',{status:200,text:JSON.stringify({temperature:12,password:secret,accessToken:secret,apiKey:secret,headers:{authorization:secret},nested:{sessionId:1234,email:secret},name:`Bearer ${secret}`})})]}, {prompt:`Read https://alice:${secret}@example.com/data?token=${secret}`});
  assert.doesNotMatch(allText(graph),new RegExp(secret));assert.doesNotMatch(allText(graph),/alice|api_key|sessionId|authorization|password|accessToken/);
  assert.ok(graph.nodes.some(node=>node.value==='https://example.com/data'));assert.ok(factNodes(graph).some(node=>node.value==='12'));
  const host=build({events:[started('workspace_read',{path:'/Users/example/private/file.txt'})]});assert.doesNotMatch(allText(host),/\/Users\/example\/private/);assert.match(allText(host),/file\.txt/);
});

test('visible plan steps branch without implying pending steps or generic private reasoning completed',()=>{
  const graph=build({events:[{type:'model.started'}],plan:{steps:[{id:'one',title:'Read the evidence',status:'completed'},{id:'two',title:'Compare the options',status:'in_progress'},{id:'three',title:'Save a report',status:'pending'}]}}, {prompt:'Choose a plan'});
  assert.equal(graph.kind,'reasoning');assert.equal(graph.caption,'Compare the options');assert.match(graph.context,/1 of 3/);
  const pending=graph.nodes.find(node=>node.id==='plan-three');assert.equal(pending.detail,'Visible plan step · pending');assert.equal(pending.value,'Save a report');
  assert.ok(graph.edges.some(edge=>edge.to===pending.id&&edge.text==='Save a report · pending'&&edge.detail.includes('plan metadata')));assert.doesNotMatch(allText(graph),/private thoughts|confidence|weighing/);
  const longTitle='Review the original evidence and compare every available source with the report';
  const long=build({plan:{steps:[{id:'long',title:longTitle,status:'in_progress'}]}},{prompt:'Choose a plan'});
  assert.ok(long.edges.some(edge=>edge.to==='plan-long'&&edge.text===longTitle.slice(0,64).trim()&&edge.detail.includes('in_progress')));
});

test('delegation has an outbound edge only until the actual returned event arrives',()=>{
  const events=[started('delegate_task',{botId:'bot_peer',task:'Review the source reliability.'}),{type:'delegation.started',targetBotId:'bot_peer'}];
  const options={prompt:'Check the sources',peers:[{id:'bot_peer',name:'Nova'}]};
  const outgoing=build({status:'waiting_for_delegate',events},options);
  assert.equal(outgoing.kind,'team');assert.ok(outgoing.edges.some(edge=>edge.from==='core'&&edge.to==='peer'));assert.ok(!outgoing.edges.some(edge=>edge.from==='peer'&&edge.to==='core'));assert.match(outgoing.caption,/Waiting/);assert.ok(outgoing.nodes.some(node=>node.label==='Nova'));
  const working=build({status:'waiting_for_delegate',events,teammate:{botId:'bot_peer',status:'running',steps:3,event:'tool.started',tool:'http_fetch'}},options);
  assert.equal(working.caption,'Nova: Read source');assert.equal(working.context,'Step 3 · Review the source reliability.');assert.notEqual(working.signature,outgoing.signature);
  const asking=build({status:'waiting_for_delegate',events,teammate:{botId:'bot_peer',status:'waiting_for_approval',steps:4,event:'approval.request'}},options);
  assert.equal(asking.caption,'Nova needs your approval');assert.match(asking.context,/Open Nova's chat/);
  // Progress of a bot other than the recorded target is never attributed to it.
  assert.match(build({status:'waiting_for_delegate',events,teammate:{botId:'bot_other',status:'running',steps:2,event:'model.started'}},options).caption,/Waiting/);
  const returned=build({events:[...events,{type:'delegation.completed',targetBotId:'bot_peer',status:'completed',outputPreview:'The original report is the primary source.'}]},options);
  assert.ok(returned.edges.some(edge=>edge.from==='peer'&&edge.to==='core'&&edge.text==='The original report is the primary source.'&&edge.detail.includes('Recorded teammate status: completed')));
  const noPreview=build({events:[...events,{type:'delegation.completed',targetBotId:'bot_peer',status:'completed',outputPreview:''}]},options);
  assert.ok(noPreview.edges.some(edge=>edge.from==='peer'&&edge.to==='core'&&edge.text==='Reply received'));
  const error=build({events:[...events,{type:'delegation.completed',targetBotId:'bot_peer',status:'failed',outputPreview:''}]},options);
  assert.equal(error.failed,true);assert.ok(error.edges.some(edge=>edge.text==='Teammate failed'));assert.doesNotMatch(allText(error),/Reply received/);
});

test('later actual tools supersede old delegation and model started never manufactures new reasoning',()=>{
  const graph=build({events:[{type:'delegation.started',targetBotId:'peer'},{type:'delegation.completed',targetBotId:'peer',status:'completed'},started('http_fetch',{url:'https://example.com/new'}),{type:'model.started'}]});
  assert.equal(graph.kind,'research');assert.equal(graph.caption,'Thinking');assert.ok(!graph.nodes.some(node=>node.id==='peer'));assert.equal(factNodes(graph).length,0);
});

test('identical retained data produces a stable signature; new facts and status alter it',()=>{
  const run={events:[started('http_fetch',{url:'https://example.com/'})]},options={prompt:'Check the source'};
  const first=build(run,options),same=build({...run,updatedAt:'tomorrow'},options);
  assert.equal(first.signature,same.signature);assert.equal(first.seed,same.seed);
  assert.notEqual(first.signature,build({...run,events:[...run.events,completed('http_fetch',{status:200})]},options).signature);
  assert.notEqual(first.signature,build({...run,status:'stopping'},options).signature);
});

test('rendering is bounded and every edge refers to an existing node even for hostile large results',()=>{
  const events=[];
  for(let i=0;i<80;i++){events.push(started('workspace_read',{path:`records/${i}.json`},`call_${i}`));events.push(completed('workspace_read',Object.fromEntries(Array.from({length:35},(_,j)=>[`metric${j}`,i+j])),`call_${i}`));}
  const graph=build({events}, {prompt:'Analyze data'}),ids=new Set(graph.nodes.map(node=>node.id));
  assert.ok(graph.nodes.length<=24);assert.ok(graph.edges.length<=40);assert.ok(factNodes(graph).length<=12);assert.equal(ids.size,graph.nodes.length);
  for(const edge of graph.edges){assert.ok(ids.has(edge.from));assert.ok(ids.has(edge.to));assert.ok(edge.text.length<=64);}
  for(const node of graph.nodes){assert.ok(node.x>=.05&&node.x<=.95);assert.ok(node.y>=.09&&node.y<=.91);assert.ok(node.value.length<=260);assert.ok(node.detail.length<=220);}
});

test('observed facts occupy distinct positions within their tool slots instead of stacking at the boundary',()=>{
  for(const counts of [[6],[2,6]]) {
    const events=counts.flatMap((count,index)=>[
      started('workspace_read',{path:`records/${index}.json`},`layout_${index}`),
      completed('workspace_read',Object.fromEntries(Array.from({length:count},(_,metric)=>[`metric${metric}`,metric+1])),`layout_${index}`),
    ]);
    const positions=factNodes(build({events})).map(node=>node.y);
    assert.equal(positions.length,counts.reduce((sum,count)=>sum+count,0));
    assert.equal(new Set(positions).size,positions.length);
    for(const [index,y] of positions.entries()) {
      assert.ok(y>=.12&&y<=.88);
      if(index)assert.ok(y-positions[index-1]>.02,'facts remain separated after deterministic jitter');
    }
  }
});

test('reused provider call IDs in separate turns stay separate graph entities',()=>{
  const a=started('workspace_read',{path:'first.txt'}),b=started('workspace_read',{path:'second.txt'});
  a.id='event_first';b.id='event_second';
  const graph=build({events:[a,completed('workspace_read',{size:1}),b,completed('workspace_read',{size:2})]});
  assert.equal(graph.nodes.filter(node=>node.id.startsWith('tool-')).length,2);assert.ok(graph.nodes.some(node=>node.value==='first.txt'));assert.ok(graph.nodes.some(node=>node.value==='second.txt'));
});

test('complete observed CSV rows become data labels without fabricated aggregation',()=>{
  const csv='category,cost_EUR,password\r\n"Venue, east",1400,private-cell\r\nCatering,900,another-private-cell\r\n';
  const graph=build({events:[started('workspace_read',{path:'launch/budget.csv'}),completed('workspace_read',{path:'launch/budget.csv',content:csv,size:csv.length,truncated:false,offset:1,column:1})]});
  assert.equal(graph.kind,'analysis');assert.ok(factNodes(graph).some(node=>node.value==='Venue, east'));assert.ok(factNodes(graph).some(node=>node.value==='1400'));assert.ok(factNodes(graph).some(node=>node.value==='900'));assert.ok(factNodes(graph).some(node=>node.label==='CSV data rows'&&node.value==='2'));
  assert.doesNotMatch(allText(graph),/private-cell|another-private-cell|2300|2,300/);
  const incomplete=build({events:[started('workspace_read',{path:'budget.csv'}),completed('workspace_read',{path:'budget.csv',content:'category,cost\nVenue,1400',truncated:true})]});
  assert.ok(!factNodes(incomplete).some(node=>node.value==='1400'));assert.ok(!factNodes(incomplete).some(node=>node.label==='CSV data rows'));
  const broken=build({events:[started('workspace_read',{path:'budget.csv'}),completed('workspace_read',{content:'item,cost\n"unfinished,1400',truncated:false})]});
  assert.ok(!factNodes(broken).some(node=>node.value==='1400'));
});

test('structured document cells are observed data while cached formula strings are not calculated',()=>{
  const value={path:'plan.xlsx',format:'xlsx',preview:{kind:'spreadsheet',sheets:[{name:'Costs',rowCount:4,columnCount:3,rows:[['item','amount','accessToken'],['Hall',75,'sensitive-cell'],['Food',25,'sensitive-cell'],['Total','=SUM(B2:B3) [cached: 100]','sensitive-cell']]}]},truncated:true};
  const graph=build({events:[started('documents_read',{path:'plan.xlsx'}),completed('documents_read',value)]});
  assert.ok(factNodes(graph).some(node=>node.label==='Costs rows'&&node.value==='4'));assert.ok(factNodes(graph).some(node=>node.value==='75'));assert.ok(factNodes(graph).some(node=>node.value==='25'));
  assert.doesNotMatch(allText(graph),/sensitive-cell|SUM\(B2|cached: 100/);
});

test('status and partial output snapshots are truthfully presented without changing input data',()=>{
  for(const [status,label] of [['queued','Getting ready'],['stopping','Stopping'],['waiting_for_approval','Waiting for approval'],['completed','Task completed'],['cancelled','Task stopped'],['interrupted','Task interrupted'],['remote','Working on another engine']]) {
    const graph=build({status});assert.equal(graph.caption,label);assert.equal(graph.status,status);
  }
  assert.equal(build({partialOutput:'Partial reply'}).caption,'Writing the reply');
  const run=Object.freeze({id:'fixed',status:'running',events:Object.freeze([Object.freeze(started('http_fetch',{url:'https://example.com/'}))])});
  const original=JSON.stringify(run);build(run);assert.equal(JSON.stringify(run),original);
});

test('hostile markup remains ordinary text and never expands the graph schema',()=>{
  const markup='<img src=x onerror="alert(1)">';
  const graph=build({events:[started('workspace_read',{path:`files/${markup}.txt`}),completed('workspace_read',{title:markup,size:7})]}, {prompt:markup});
  assert.ok(graph.nodes.some(node=>node.value.includes('<img')));assert.ok(graph.nodes.every(node=>!Object.hasOwn(node,'html')));assert.doesNotMatch(allText(graph),/onclick|javascript:/);
});
