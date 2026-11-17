import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectLocalRuntimes,isLoopbackUrl,LOCAL_RUNTIMES} from '../lib/local-runtimes.mjs';
import {createStudioServer} from '../server.mjs';

// Fixture runtimes on random loopback ports. No real Ollama or MLX server is started or contacted.
async function fixture(t,handler){
  const hits=[];const server=http.createServer((req,res)=>{hits.push(req.url);handler(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(()=>resolve());}));
  return {origin:`http://127.0.0.1:${server.address().port}`,hits};
}
const json=(res,body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const ollama=(req,res)=>{
  if(req.url==='/api/version')return json(res,{version:'0.13.0'});
  if(req.url==='/api/tags')return json(res,{models:[{name:'qwen3.8:27b',model:'qwen3.8:27b',size:17_700_000_000,details:{family:'qwen35',parameter_size:'27.8B',quantization_level:'Q4_K_M'}},{name:'nomic-embed-text:latest',model:'nomic-embed-text:latest',details:{family:'nomic-bert'}}]});
  json(res,{error:'not found'},404);
};
const mlx=(req,res)=>{
  if(req.url==='/v1/models')return json(res,{object:'list',data:[{id:'mlx-community/Qwen3.8-27B-4bit',object:'model'}]});
  if(req.url==='/health')return json(res,{status:'ok'});
  json(res,{error:'not found'},404);
};
// A port nothing listens on: bind, read the port, close.
async function closedPort(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const {port}=server.address();await new Promise(resolve=>server.close(resolve));return `http://127.0.0.1:${port}`;}
const noFiles={exists:async()=>false,pathEnv:'',home:'/nonexistent-home'};

test('running Ollama and MLX are detected with their models, versions, start commands and install links',async t=>{
  const o=await fixture(t,ollama),m=await fixture(t,mlx);
  const result=await detectLocalRuntimes({urls:{ollama:o.origin,mlx:m.origin},platform:'darwin',...noFiles});
  assert.equal(result.platform,'darwin');assert.ok(Date.parse(result.checkedAt));
  const [first,second]=result.runtimes;
  assert.equal(first.type,'ollama');assert.equal(first.running,true);assert.equal(first.version,'0.13.0');assert.equal(first.baseUrl,`${o.origin}/v1`);assert.equal(first.installed,true);
  assert.deepEqual(first.models,[{id:'qwen3.8:27b',sizeBytes:17_700_000_000,parameterSize:'27.8B',quantization:'Q4_K_M',family:'qwen35'},{id:'nomic-embed-text:latest',family:'nomic-bert',embedding:true}]);
  assert.equal(first.startCommand,'ollama serve');assert.equal(first.installUrl,'https://ollama.com/download');
  assert.equal(second.type,'mlx');assert.equal(second.running,true);assert.deepEqual(second.models,[{id:'mlx-community/Qwen3.8-27B-4bit'}]);
  assert.equal(second.startCommand,'mlx_lm.server --model <model> --port 8080');assert.deepEqual(second.alternativeCommands,['APC_ENABLED=1 mlx_vlm.server --model <model> --port 8080']);
  assert.equal(second.installUrl,'https://github.com/ml-explore/mlx-lm');
  assert.deepEqual(o.hits.sort(),['/api/tags','/api/version']);assert.deepEqual(m.hits.sort(),['/health','/v1/models'],'only read-only GETs are sent');
});

test('mlx_vlm answering only /health counts as running; a foreign server on the port is a conflict, not a runtime',async t=>{
  const vlm=await fixture(t,(req,res)=>req.url==='/health'?json(res,{status:'healthy'}):json(res,{detail:'Not Found'},404));
  const other=await fixture(t,(req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>dev server</html>');});
  const result=await detectLocalRuntimes({urls:{ollama:other.origin,mlx:vlm.origin},platform:'darwin',...noFiles});
  const [o,m]=result.runtimes;
  assert.equal(m.running,true);assert.deepEqual(m.models,[]);
  assert.equal(o.running,false);assert.equal(o.conflict,true);assert.equal(o.installed,false,'Ollama absent from its fixed install places is reported as not installed');
});

test('stopped runtimes report not running; MLX installation is unknown unless found, and non-Macs never guess',async t=>{
  const closed=await closedPort();
  const mac=await detectLocalRuntimes({urls:{ollama:closed,mlx:closed},platform:'darwin',pathEnv:'/fixture/bin',home:'/fixture-home',exists:async file=>file==='/fixture/bin/mlx_lm.server'});
  assert.deepEqual(mac.runtimes.map(item=>[item.type,item.running,item.installed]),[['ollama',false,false],['mlx',false,true]]);
  const unknown=await detectLocalRuntimes({urls:{ollama:closed,mlx:closed},platform:'darwin',...noFiles});
  assert.equal(unknown.runtimes[1].installed,null,'MLX may live in a virtual environment, so absence is unknown');
  const linux=await detectLocalRuntimes({urls:{ollama:closed,mlx:closed},platform:'linux',exists:async()=>true});
  assert.deepEqual(linux.runtimes.map(item=>[item.running,item.installed]),[[false,null],[false,null]]);
  assert.deepEqual(linux.runtimes.map(item=>item.models),[[],[]]);
});

test('only loopback is ever probed, and a silent runtime is abandoned within the short timeout',async t=>{
  assert.equal(isLoopbackUrl('http://127.0.0.1:11434'),true);assert.equal(isLoopbackUrl('http://localhost:8080'),true);assert.equal(isLoopbackUrl('http://[::1]:8080'),true);
  for(const value of ['http://10.0.0.5:11434','http://192.168.1.4:8080','https://127.0.0.1:8080','http://studio-mac.tailnet.test:11434','not a url'])assert.equal(isLoopbackUrl(value),false,value);
  for(const runtime of LOCAL_RUNTIMES)assert.equal(isLoopbackUrl(runtime.probeUrl),true);
  const silent=await fixture(t,()=>{});
  const started=Date.now();
  const result=await detectLocalRuntimes({urls:{ollama:'http://10.255.255.1:11434',mlx:silent.origin},timeoutMs:200,platform:'linux'});
  assert.ok(Date.now()-started<1500,`probes are bounded (${Date.now()-started} ms)`);
  assert.deepEqual(result.runtimes.map(item=>item.running),[false,false]);
  assert.equal(result.runtimes[0].baseUrl,'http://10.255.255.1:11434/v1');
  assert.ok(silent.hits.length>=1,'the loopback fixture was asked');
});

test('GET /api/local-runtimes requires the owner session and returns the detection result',async t=>{
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tupies-local-runtimes-')));
  const o=await fixture(t,ollama),closed=await closedPort();let app;
  t.after(async()=>{if(app)await app.close();await fs.rm(directory,{recursive:true,force:true});});
  app=await createStudioServer({dataDir:path.join(directory,'data'),scheduler:false,logErrors:false,localRuntimes:{urls:{ollama:o.origin,mlx:closed},platform:'linux'}});
  const {url}=await app.listen(0,'127.0.0.1');
  const anonymous=await fetch(`${url}/api/local-runtimes`,{signal:AbortSignal.timeout(10000)});assert.equal(anonymous.status,401);
  const setup=await fetch(`${url}/api/setup`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json'},body:JSON.stringify({token:app.bootstrapToken,password:'disposable-local-runtimes-password'})});
  assert.equal(setup.status,201);const cookie=setup.headers.get('set-cookie').split(';')[0];
  const response=await fetch(`${url}/api/local-runtimes`,{signal:AbortSignal.timeout(10000),headers:{Cookie:cookie}});assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.platform,'linux');assert.deepEqual(body.runtimes.map(item=>[item.type,item.running]),[['ollama',true],['mlx',false]]);
  assert.equal(body.runtimes[0].models[0].id,'qwen3.8:27b');
  assert.equal((await fetch(`${url}/api/local-runtimes`,{method:'POST',signal:AbortSignal.timeout(10000),headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status>=400,true,'the route is read-only');
});

test('Ollama cloud models are marked as not local',async t=>{
  const f=await fixture(t,(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/version')return res.end(JSON.stringify({version:'0.40.16'}));
    if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'gemma4:cloud',model:'gemma4:cloud',remote_model:'gemma4:31b',remote_host:'https://ollama.example:443',size:387},{name:'mystery:latest',model:'mystery:latest',remote_host:'https://ollama.example:443'},{name:'qwen3.8:27b',model:'qwen3.8:27b',size:17_700_000_000}]}));
    res.writeHead(404);res.end('{}');
  });
  const result=await detectLocalRuntimes({urls:{ollama:f.origin,mlx:'http://127.0.0.1:9'},timeoutMs:500,platform:'darwin',exists:async()=>true});
  const ollama=result.runtimes.find(item=>item.type==='ollama');
  assert.deepEqual(ollama.models.map(model=>[model.id,!!model.cloud]),[['gemma4:cloud',true],['mystery:latest',true],['qwen3.8:27b',false]]);
});
