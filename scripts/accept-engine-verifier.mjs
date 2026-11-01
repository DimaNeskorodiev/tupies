// Explicit Linux acceptance command for disposable CI runners, never a product tool.
import { promises as fs } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyEngineCandidate } from '../lib/engine-workshop.mjs';
import { workshopDigest } from '../lib/workshop.mjs';
import { runEngineVerification, verifierConfig } from '../lib/engine-verifier.mjs';

const probe=`import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import net from 'node:net';
test('real verifier boundary: non-root, immutable baseline, no Docker socket, no credentials or external route',async()=>{
  assert.equal(process.platform,'linux');assert.equal(process.getuid(),10001);
  await assert.rejects(fs.writeFile('/opt/tupies-source/host-mutation','refuse'),e=>['EROFS','EACCES'].includes(e.code));
  await assert.rejects(fs.access('/var/run/docker.sock'));
  for(const key of ['GITHUB_TOKEN','GH_TOKEN','AWS_SECRET_ACCESS_KEY','DOCKER_HOST','STUDIO_DATA_DIR'])assert.equal(process.env[key],undefined);
  const connected=await new Promise(resolve=>{const socket=net.connect({host:'1.1.1.1',port:443});const done=value=>{socket.destroy();resolve(value);};socket.setTimeout(1500,()=>done(false));socket.once('connect',()=>done(true));socket.once('error',()=>done(false));});
  assert.equal(connected,false);
});\n`;
export async function acceptEngineVerifier({image,executable,socket,output}){
  assert.equal(process.platform,'linux','Acceptance requires a disposable Linux runner.');
  const config=verifierConfig({image,executable,socket});await fs.mkdir(output,{recursive:true});
  const candidate=await verifyEngineCandidate({changes:[{path:'test/verifier-acceptance/boundary.test.mjs',sha256:null,oldText:'',newText:probe}],dependencies:[],tests:[]});
  const proposal={format:'tupies-improvement-v1',kind:'engine',title:'Synthetic container boundary probe',summary:'Disposable verification only.',patch:candidate.patch,candidate:{format:candidate.format,request:candidate.request,base:candidate.base}};
  const bundle={format:'tupies-contribution-v1',proposal,digest:workshopDigest(proposal)};
  const persist=async(name,receipt)=>{await fs.writeFile(path.join(output,name+'.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({case:name,...receipt}));return receipt;};
  const passed=await persist('full',await runEngineVerification(bundle,{...config,reviewedDigest:bundle.digest}));
  assert.equal(passed.passed,true,passed.error || JSON.stringify(passed.checks));assert.equal(passed.cleanup,'removed');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Acceptance Stop')),10000);
  try{const stopped=await persist('stop',await runEngineVerification(bundle,{...config,reviewedDigest:bundle.digest,signal:controller.signal}));assert.equal(stopped.passed,false);assert.equal(stopped.outcome,'interrupted');assert.equal(stopped.cleanup,'removed');}finally{clearTimeout(timer);}
  const stale=structuredClone(bundle);stale.proposal.candidate.request.changes[0]={path:'lib/store.mjs',sha256:'0'.repeat(64),oldText:'missing-base',newText:'changed'};stale.digest=workshopDigest(stale.proposal);
  const refused=await persist('stale-base',await runEngineVerification(stale,{...config,reviewedDigest:stale.digest}));assert.equal(refused.passed,false);assert.equal(refused.outcome,'failed');assert.equal(refused.cleanup,'removed');assert.equal(refused.checks.length,0);
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const [image,executable,socket,output,...extra]=process.argv.slice(2);assert.ok(output&&!extra.length,'Usage: node scripts/accept-engine-verifier.mjs IMAGE DOCKER SOCKET NEW_OUTPUT_DIR');
  await acceptEngineVerifier({image,executable,socket,output});
}
