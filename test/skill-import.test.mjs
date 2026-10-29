import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseSkill } from '../lib/store.mjs';
import { parseSkillMetadata, parsePortableSkillPackage, parseSkillArchive, prepareSkillImport, fetchSkillImport } from '../lib/skill-import.mjs';

const content=(name='portable-skill',description='A portable workflow.')=>`---\nname: ${name}\ndescription: ${description}\n---\n\nRead references/source.txt before answering.\n`;
const archive=files=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key,value])=>[key,typeof value==='string'?strToU8(value):value])),{level:0}));
function central(bytes,index=0){let count=0;for(let i=0;i<bytes.length-4;i++)if(bytes.readUInt32LE(i)===0x02014b50){if(count++===index)return i;}throw new Error('No central entry.');}

test('skill metadata recognizes standard and Hermes requirements without executing or rewriting source',()=>{
  const raw=`---\nname: hermes-workflow\ndescription: >-\n  Read source material\n  and prepare a report.\nlicense: MIT\nplatforms: [darwin, linux]\ncompatibility: Requires Python and a connected account.\nmetadata:\n  hermes:\n    requires_tools: [web_search, terminal]\n    requires_toolsets:\n      - browser\n    requires:\n      bins: [python3, uv]\n      env: [WORKFLOW_API_KEY]\n---\nUse the given resources.\n`;
  const before=Buffer.from(raw),metadata=parseSkillMetadata(raw);
  assert.deepEqual(metadata.platforms,['darwin','linux']);assert.deepEqual(metadata.requiresTools,['web_search','terminal']);
  assert.deepEqual(metadata.requiresToolsets,['browser']);assert.deepEqual(metadata.requiresBins,['python3','uv']);assert.deepEqual(metadata.requiresEnv,['WORKFLOW_API_KEY']);
  assert.equal(metadata.license,'MIT');assert.match(metadata.compatibility,/connected account/);assert.deepEqual(Buffer.from(raw),before);
  const json=parseSkillMetadata(`---\nname: json-metadata\ndescription: Inspect JSON metadata.\nmetadata: {"hermes":{"requires_tools":["read_file"],"requires":{"bins":["jq"]}}}\n---\n`);
  assert.deepEqual(json.requiresTools,['read_file']);assert.deepEqual(json.requiresBins,['jq']);
});

test('skill metadata exposes unsupported expansion, setup and structured requirements as diagnostics',()=>{
  const raw=`---\nname: review-only\ndescription: Review unsupported metadata.\nmetadata:\n  hermes:\n    requires_tools: &tools [terminal]\n    install: [python setup.py]\n    required_environment_variables:\n      - name: SERVICE_TOKEN\n        prompt: Supply a token\n---\nRun !\`touch /tmp/never-execute-fixture\` then hermes setup using \${HERMES_HOME}.\n`;
  const metadata=parseSkillMetadata(raw);
  assert.ok(metadata.unsupportedFeatures.includes('yaml-aliases-or-tags'));assert.ok(metadata.unsupportedFeatures.includes('inline-shell-expansion'));
  assert.ok(metadata.unsupportedFeatures.includes('automatic-setup'));assert.ok(metadata.unsupportedFeatures.includes('hermes-runtime'));
  assert.ok(metadata.diagnostics.length);assert.deepEqual(metadata.requiresEnv,[]);
  assert.equal(parseSkill(content('long-description','a'.repeat(1024))).description.length,1024);
  assert.throws(()=>parseSkill(content('too-long','a'.repeat(1025))),/1024/);
  const invalid=parseSkillMetadata('---\nname: typed-metadata\ndescription: Review typed requirements.\nmetadata: {"hermes":{"requires_tools":[true],"install":{"command":"python setup.py"}}}\n---\n');
  assert.ok(invalid.diagnostics.some(item=>item.includes('unsupported metadata value')));assert.ok(invalid.unsupportedFeatures.includes('automatic-setup'));
});

test('folder and ZIP imports preserve CRLF text and binary resources exactly',async()=>{
  const raw=content().replaceAll('\n','\r\n'),binary=Buffer.from([0,255,16,4,10]),files=[{path:'SKILL.md',contentBase64:Buffer.from(raw).toString('base64')},{path:'assets/reference.bin',contentBase64:binary.toString('base64')}];
  const direct=await prepareSkillImport({files});assert.equal(direct.requiresSelection,false);assert.equal(direct.packages[0].package.content,raw);
  assert.deepEqual(direct.packages[0].package.files.find(file=>file.path==='assets/reference.bin').data,binary);
  const bytes=archive({'portable/SKILL.md':raw,'portable/assets/reference.bin':binary}),result=parseSkillArchive(bytes);
  assert.equal(result.packages[0].key,'portable');assert.equal(result.packages[0].package.content,raw);
  assert.deepEqual(result.packages[0].package.files.find(file=>file.path==='assets/reference.bin').data,binary);
  assert.match(result.packages[0].provenance.archiveSha256,/^[a-f0-9]{64}$/);
});

test('portable imports retain Grok human-readable names without changing legacy validation or resource bytes',async()=>{
  const name='Grok Research & Evidence '.repeat(3).trim(),raw=content(JSON.stringify(name)),binary=Buffer.from([0,255,128]);
  assert.throws(()=>parseSkill(raw),/lowercase slug/);
  const parsed=parsePortableSkillPackage({files:[{path:'SKILL.md',contentBase64:Buffer.from(raw).toString('base64')},{path:'assets/sample.bin',contentBase64:binary.toString('base64')}]});
  assert.equal(parsed.skill.name,name);assert.match(parsed.skill.id,/^[a-z0-9][a-z0-9-]{0,63}$/);assert.equal(parsed.content,raw);
  assert.deepEqual(parsed.files[0].data,Buffer.from(raw));assert.deepEqual(parsed.files[1].data,binary);assert.equal(parsed.skill.size,Buffer.byteLength(raw)+binary.length);
  const archived=parseSkillArchive(archive({'grok/SKILL.md':raw}));assert.equal(archived.packages[0].package.skill.name,name);
  await assert.rejects(prepareSkillImport({content:content('"'+ 'a'.repeat(81)+'"')}),/1–80/);
  await assert.rejects(prepareSkillImport({content:content('"bad\\nname"')}),/printable/);
});

test('Grok Bot OpenBot exports expose only listed skills and require selection for multiple packages',async()=>{
  const first='agents/research/skills/evidence',second='agents/research/skills/summary';
  const manifest={format:'openbot-agent-import',version:1,source:{app:'grok-bot'},agents:[{key:'research',name:'Research',skills:[first,second],memories:['Private memory must not be imported.']}]};
  const bytes=archive({'openbot-import.json':JSON.stringify(manifest),[`${first}/SKILL.md`]:content('evidence'),[`${first}/references/source.txt`]:'A retained resource.',[`${second}/SKILL.md`]:content('summary'),'agents/research/files/private.txt':'An unrelated workspace file.','unlisted/SKILL.md':content('unlisted')});
  const preview=await prepareSkillImport({archiveBase64:bytes.toString('base64')});assert.equal(preview.requiresSelection,true);assert.equal(preview.packages.length,2);
  assert.ok(preview.packages.every(item=>item.provenance.sourceApp==='grok-bot'));assert.deepEqual(preview.packages.map(item=>item.label),['evidence','summary']);
  const selected=parseSkillArchive(bytes,{skillPath:first});assert.equal(selected.requiresSelection,false);assert.equal(selected.packages[0].package.files.length,2);
  assert.ok(!JSON.stringify(selected).includes('Private memory'));assert.ok(!selected.packages[0].package.files.some(file=>file.path.includes('private')));
  assert.throws(()=>parseSkillArchive(bytes,{skillPath:'unlisted'}),/preview/);
  manifest.agents[0].skills=['unlisted'];assert.throws(()=>parseSkillArchive(archive({'openbot-import.json':JSON.stringify(manifest),'unlisted/SKILL.md':content()})),/outside its agent/);
});

test('ZIP imports reject traversal, secrets, dependencies, nested archives and case collisions',()=>{
  for(const unsafe of ['../escape','folder/../escape','/absolute','C:/drive','folder\\escape','.git/config','.env','keys/private-key.txt','cert/server.key','node_modules/dependency.js','scripts/package.zip']){
    assert.throws(()=>parseSkillArchive(archive({'SKILL.md':content(),[unsafe]:'x'})),/safe relative|credentials|Nested archives/);
  }
  assert.throws(()=>parseSkillArchive(archive({'SKILL.md':content(),'Assets/source.txt':'a','assets/Source.txt':'b'})),/case-conflicting/);
  assert.throws(()=>parseSkillArchive(archive({'SKILL.md':content(),'references':'a','references/data.txt':'b'})),/conflicts with a directory/);
  assert.throws(()=>parseSkillArchive(archive({'SKILL.md':content(),'nested/SKILL.md':content('nested')})),/Nested skill/);
});

test('ZIP imports reject symlinks, corrupted data, inconsistent headers and oversized expansion',()=>{
  const linked=archive({'SKILL.md':content(),'link':'target'}),linkOffset=central(linked,1);linked.writeUInt32LE((0xa1ff0000)>>>0,linkOffset+38);
  assert.throws(()=>parseSkillArchive(linked),/symlinks/);
  const corrupt=archive({'SKILL.md':content()}),dataStart=30+corrupt.readUInt16LE(26)+corrupt.readUInt16LE(28);corrupt[dataStart]^=1;
  assert.throws(()=>parseSkillArchive(corrupt),/checksum/);
  const mismatch=archive({'SKILL.md':content()});mismatch.writeUInt16LE(8,8);assert.throws(()=>parseSkillArchive(mismatch),/headers disagree/);
  const huge=archive({'SKILL.md':content()}),offset=central(huge);huge.writeUInt32LE(5_000_001,offset+24);
  assert.throws(()=>parseSkillArchive(huge),/compression/);
  const compressed=Buffer.from(zipSync({'SKILL.md':strToU8(content()),'assets/bomb.txt':strToU8('a'.repeat(1_000_000))},{level:9}));
  assert.throws(()=>parseSkillArchive(compressed),/compression/);
});

test('direct imports reject mixed sources, unsafe paths, malformed base64 and source byte limits',async()=>{
  await assert.rejects(prepareSkillImport({content:content(),url:'https://example.com/SKILL.md'}),/exactly one/);
  await assert.rejects(prepareSkillImport({archiveBase64:'SGk='}),/ZIP/);
  await assert.rejects(prepareSkillImport({archiveBase64:'????'}),/base64/);
  await assert.rejects(prepareSkillImport({files:[{path:'SKILL.md',contentBase64:Buffer.from(content()).toString('base64')},{path:'.env',contentBase64:'YQ=='}]}),/credentials/);
  await assert.rejects(prepareSkillImport({files:[{path:'SKILL.md',contentBase64:Buffer.from(content()).toString('base64')},{path:'Assets/x',contentBase64:'YQ=='},{path:'assets/X',contentBase64:'YQ=='}]}),/case-conflicting/);
});

test('remote imports refuse private addresses, credentials, ports, query strings and redirects before parsing',async()=>{
  let calls=0;const request=async()=>{calls++;return {status:200,bytes:Buffer.from(content())};};
  for(const url of ['http://example.com/SKILL.md','https://localhost/SKILL.md','https://127.0.0.1/SKILL.md','https://[::1]/SKILL.md','https://host.local/SKILL.md','https://user:secret@example.com/SKILL.md','https://example.com:8443/SKILL.md','https://example.com/SKILL.md?token=secret'])await assert.rejects(fetchSkillImport(url,{request}),/HTTPS|Private|query|credentials|port/);
  assert.equal(calls,0);
  await assert.rejects(fetchSkillImport('https://example.com/SKILL.md',{request:async()=>({status:302,bytes:Buffer.from('redirect')})}),/HTTP 302/);
  const response=await fetchSkillImport('https://example.com/SKILL.md',{request});assert.equal(response.packages[0].package.content,content());assert.match(response.packages[0].metadata.diagnostics[0],/standalone/);
  await assert.rejects(fetchSkillImport('https://example.com/SKILL.md',{request:async()=>({status:200,bytes:Buffer.alloc(10_000_001)})}),/size limit/);
});

test('pinned GitHub folders fetch supporting resources with engine-constructed URLs',async()=>{
  const revision='a'.repeat(40),requests=[],request=async(url,options)=>{
    requests.push({url,options});
    if(url.includes('/contents/skills/evidence?'))return {status:200,bytes:Buffer.from(JSON.stringify([{type:'file',name:'SKILL.md',path:'skills/evidence/SKILL.md',size:content().length},{type:'dir',name:'references',path:'skills/evidence/references'}]))};
    if(url.includes('/contents/skills/evidence/references?'))return {status:200,bytes:Buffer.from(JSON.stringify([{type:'file',name:'source.txt',path:'skills/evidence/references/source.txt',size:5}]))};
    return {status:200,bytes:Buffer.from(url.endsWith('/SKILL.md')?content():'hello')};
  };
  const result=await fetchSkillImport(`https://github.com/example/repo/tree/${revision}/skills/evidence`,{request});
  assert.equal(result.packages[0].package.files.length,2);assert.equal(result.packages[0].provenance.revision,revision);
  assert.ok(requests.every(item=>item.url.startsWith('https://api.github.com/')||item.url.startsWith(`https://raw.githubusercontent.com/example/repo/${revision}/`)));
  assert.ok(requests.every(item=>item.options.signal===undefined && item.options.headers['Accept-Encoding']==='identity'));
  const blob=await fetchSkillImport(`https://github.com/example/repo/blob/${revision}/skills/evidence/SKILL.md`,{request});assert.equal(blob.packages[0].package.files.length,2);
});

test('GitHub branch and tag links resolve once then fetch every file at the immutable preview commit',async()=>{
  const revision='d'.repeat(40),calls=[],request=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/commits/main')){assert.equal(options.headers.Accept,'application/vnd.github.sha');return {status:200,bytes:Buffer.from(`${revision}\n`)};}
    if(url.endsWith('/commits/v1.0'))return {status:200,bytes:Buffer.from(JSON.stringify({sha:revision}))};
    if(url.includes('/contents/skills/evidence?'))return {status:200,bytes:Buffer.from(JSON.stringify([{type:'file',name:'SKILL.md',path:'skills/evidence/SKILL.md',size:content().length},{type:'file',name:'data.txt',path:'skills/evidence/data.txt',size:8}]))};
    return {status:200,bytes:Buffer.from(url.endsWith('/SKILL.md')?content():'resource')};
  };
  const preview=await fetchSkillImport('https://github.com/example/repo/tree/main/skills/evidence',{request});
  assert.equal(preview.packages[0].provenance.revision,revision);assert.equal(preview.packages[0].provenance.requestedRef,'main');
  assert.equal(calls.filter(item=>item.url.includes('/commits/')).length,1);
  assert.ok(calls.filter(item=>item.url.includes('/contents/')).every(item=>item.url.endsWith(`?ref=${revision}`)));
  assert.ok(calls.filter(item=>item.url.includes('raw.githubusercontent')).every(item=>item.url.includes(`/${revision}/`)));
  assert.ok(!calls.some(item=>item.url.includes('raw.githubusercontent.com/example/repo/main/')));
  const tag=await fetchSkillImport('https://github.com/example/repo/blob/v1.0/skills/evidence/SKILL.md',{request});assert.equal(tag.packages[0].provenance.requestedRef,'v1.0');assert.equal(tag.packages[0].provenance.revision,revision);
});

test('GitHub ref resolution rejects malformed SHAs and explains ambiguous slash refs before reading files',async()=>{
  const url='https://github.com/example/repo/tree/main/skills/evidence';let calls=0;
  for(const value of ['not-a-sha',JSON.stringify({sha:'abc'}),JSON.stringify({sha:null}),'malformed'.repeat(700)]){
    await assert.rejects(fetchSkillImport(url,{request:async()=>{calls++;return {status:200,bytes:Buffer.from(value)};}}),/commit SHA|size limit/);
  }
  assert.equal(calls,4);
  await assert.rejects(fetchSkillImport('https://github.com/example/repo/tree/feature/branch/skills/evidence',{request:async()=>({status:404,bytes:Buffer.from('{}')})}),/names containing slashes/);
  await assert.rejects(fetchSkillImport('https://github.com/example/repo/tree/feature%2Fbranch/skills/evidence',{request:async()=>{throw new Error('No request expected.');}}),/names containing slashes/);
});

test('remote imports reject GitHub symlinks and out-of-folder entries and honor cancellation',async()=>{
  const revision='b'.repeat(40),url=`https://github.com/example/repo/tree/${revision}/skills/evidence`;
  await assert.rejects(fetchSkillImport(url,{request:async()=>({status:200,bytes:Buffer.from(JSON.stringify([{type:'symlink',name:'link',path:'skills/evidence/link'}]))})}),/symlinks/);
  await assert.rejects(fetchSkillImport(url,{request:async()=>({status:200,bytes:Buffer.from(JSON.stringify([{type:'file',name:'outside',path:'other/outside',size:1}]))})}),/outside/);
  const controller=new AbortController();let calls=0;controller.abort(new Error('Stopped fixture import.'));
  await assert.rejects(prepareSkillImport({url:'https://example.com/SKILL.md'},{signal:controller.signal,request:async()=>{calls++;}}),/Stopped fixture/);assert.equal(calls,0);
});
