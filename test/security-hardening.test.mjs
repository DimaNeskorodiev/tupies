import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import { isPrivateAddress, isRestrictedAddress, validateServiceUrl } from '../lib/provider-net.mjs';
import { assertPublicUrl } from '../lib/net-policy.mjs';

const WORKER=fileURLToPath(new URL('../lib/document-worker.mjs',import.meta.url));

test('service URLs judge IPv6 forms that carry an IPv4 address by that IPv4 address',()=>{
  for(const address of ['64:ff9b::a9fe:a9fe','64:ff9b::169.254.169.254','::a9fe:a9fe','2002:a9fe:a9fe::1'])assert.equal(isRestrictedAddress(address),true,address);
  for(const address of ['64:ff9b::7f00:1','2002:7f00:1::1','64:ff9b::a00:1','64:ff9b:1::808:808','fec0::1'])assert.equal(isPrivateAddress(address),true,address);
  for(const address of ['64:ff9b::808:808','2002:808:808::1','2001:4860:4860::8888'])assert.equal(isPrivateAddress(address) || isRestrictedAddress(address),false,address);
  assert.throws(()=>validateServiceUrl('https://[64:ff9b::a9fe:a9fe]/v1'),/metadata/);
  assert.throws(()=>validateServiceUrl('https://[64:ff9b::a00:1]/v1'),/private-network/);
  assert.equal(validateServiceUrl('https://[64:ff9b::a00:1]/v1',{allowPrivateHttp:true}).hostname,'[64:ff9b::a00:1]');
  assert.equal(isPrivateAddress('::1'),true);assert.equal(isRestrictedAddress('::1'),false);
});

test('web tools treat a trailing dot as the same local name',()=>{
  for(const url of ['https://localhost./','https://printer.local./','https://metadata.google.internal./'])assert.throws(()=>assertPublicUrl(url),/Private and local/);
  assert.equal(assertPublicUrl('https://example.com./page').hostname,'example.com.');
});

test('sealed credentials only open with the full authentication tag',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-seal-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=await new Store(directory).init(),sealed=store.seal('provider-secret-value'),[iv,tag,data]=sealed.split('.');
  assert.equal(store.unseal(sealed),'provider-secret-value');
  const short=[iv,Buffer.from(tag,'base64').subarray(0,8).toString('base64'),data].join('.');
  assert.throws(()=>store.unseal(short),/damaged/);
  assert.throws(()=>store.unseal([iv,tag].join('.')),/damaged/);
  store.state.connections.push({id:'conn_damaged',type:'openai',secret:short});
  assert.equal(store.redact('provider-secret-value'),'provider-secret-value','a damaged credential is skipped by redaction, not fatal');
});

test('document workers have no DNS, UDP, HTTP/2 or fetch access',()=>{
  const probe=`await import(${JSON.stringify(WORKER)}).catch(()=>{});const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
const dns=require('node:dns'),open=[];
const tries={promiseLookup:()=>dns.promises.lookup('example.com'),promisesModule:()=>require('node:dns/promises').resolveTxt('example.com'),resolver:()=>new dns.Resolver().resolve4('example.com',()=>{}),promiseResolver:()=>new dns.promises.Resolver().resolveAny('example.com'),mx:()=>dns.resolveMx('example.com',()=>{}),service:()=>dns.lookupService('127.0.0.1',22,()=>{}),udp:()=>require('node:dgram').createSocket('udp4'),http2:()=>require('node:http2').connect('https://example.com'),fetch:()=>fetch('https://example.com')};
for(const [name,attempt] of Object.entries(tries)){try{const result=attempt();result?.catch?.(()=>{});open.push(name);}catch(error){if(!/disabled/.test(error.message))open.push(name);}}
process.stderr.write(JSON.stringify(open));process.exit(0);`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',probe],{encoding:'utf8',input:'',timeout:20000});
  assert.deepEqual(JSON.parse(result.stderr.trim().split('\n').at(-1)),[]);
});
