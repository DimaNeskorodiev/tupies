import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createStudioServer} from '../server.mjs';
import {controlSocketPath} from '../lib/control.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-control-link-'));const app=await createStudioServer({dataDir:directory,scheduler:false,logErrors:false});const {url}=await app.listen(0);await app.openControl(controlSocketPath(directory),url);t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});return {directory,app,url};}
function cli(directory,operation,input=''){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/link-engine.mjs',operation,'--confirm'],{cwd:ROOT,env:{...process.env,STUDIO_DATA_DIR:directory},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);});}
function request(directory,value){return new Promise((resolve,reject)=>{const client=net.connect(controlSocketPath(directory));let text='';client.once('connect',()=>client.write(JSON.stringify(value)+'\n'));client.on('data',x=>text+=x);client.on('error',reject);client.on('end',()=>resolve(JSON.parse(text)));});}
test('owner control CLI links through normal protocol and disconnect suspends copied automation',async t=>{
 const hub=await fixture(t),replica=await fixture(t),pairing=hub.app.sync.devices.createPairing({kind:'engine',baseUrl:hub.url});
 const before=replica.app.sync.nodeId,result=await cli(replica.directory,'connect',pairing.link+'\n');
 assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{ok:true,connected:true,protocol:2});assert.doesNotMatch(result.stdout+result.stderr,new RegExp(pairing.code));
 assert.equal(replica.app.sync.config.hub.nodeId,hub.app.sync.nodeId);assert.equal(replica.app.sync.nodeId,before);
 const unlinked=await cli(replica.directory,'disconnect');assert.equal(unlinked.code,0,unlinked.stderr);assert.equal(JSON.parse(unlinked.stdout).automationSuspended,true);assert.equal(replica.app.sync.config.hub,null);assert.equal(replica.app.sync.runsAutomation(),false);
});
test('control link commands reject unconfirmed, extra-field, busy and malformed requests without echoing stdin',async t=>{
 const hub=await fixture(t),replica=await fixture(t),pairing=hub.app.sync.devices.createPairing({kind:'engine',baseUrl:hub.url});
 assert.equal((await request(replica.directory,{v:1,command:'connect-home',link:pairing.link})).ok,false);
 assert.equal((await request(replica.directory,{v:1,command:'disconnect-home',confirm:true,force:true})).ok,false);
 replica.app.sync.options.linkBusy=()=>true;const busy=await cli(replica.directory,'connect',pairing.link);assert.equal(busy.code,1);assert.doesNotMatch(busy.stdout+busy.stderr,new RegExp(pairing.code));assert.equal(replica.app.sync.config.hub,null);
 replica.app.sync.options.linkBusy=()=>false;const malformed=await cli(replica.directory,'connect','private-canary\nsecond-line');assert.equal(malformed.code,1);assert.doesNotMatch(malformed.stdout+malformed.stderr,/private-canary/);
});
