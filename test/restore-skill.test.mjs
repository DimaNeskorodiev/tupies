import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { restoreSkill } from '../scripts/restore-skill.mjs';

test('skill export restores identical native resources, refuses traversal and existing directories',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-skill-export-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'skill.json'), target=path.join(directory,'restored');
  const content='---\nname: portable-skill\ndescription: A portable skill with support resources.\n---\n\nRead references/data.bin before answering.\n';
  const binary=Buffer.from([0,1,255,2,10]);
  const files=[{path:'SKILL.md',contentBase64:Buffer.from(content).toString('base64')},{path:'references/data.bin',contentBase64:binary.toString('base64')}];
  await fs.writeFile(source,JSON.stringify({files}));
  assert.equal((await restoreSkill(source,target)).fileCount,2);
  assert.equal(await fs.readFile(path.join(target,'SKILL.md'),'utf8'),content);
  assert.deepEqual(await fs.readFile(path.join(target,'references/data.bin')),binary);
  await assert.rejects(restoreSkill(source,target),/already exists/);
  await fs.writeFile(source,JSON.stringify({files:[...files,{path:'../escape',contentBase64:'YQ=='}]}));
  await assert.rejects(restoreSkill(source,path.join(directory,'unsafe')),/safe relative/);
  await assert.rejects(fs.access(path.join(directory,'unsafe')));
  await assert.rejects(fs.access(path.join(directory,'escape')));
});

test('exported Grok skills restore their original human-readable name, CRLF instructions and complete resources',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'tupies-grok-export-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'grok-research.skill.json'),target=path.join(directory,'restored');
  const name='Quarterly Research & Evidence Review / Follow-up';
  const content=Buffer.from(`---\r\nname: ${JSON.stringify(name)}\r\ndescription: "Research a topic and retain the evidence."\r\nmetadata:\r\n  author: "Original Grok workflow"\r\n---\r\n\r\n# Дослідження\r\nRead references/source.txt and use assets/template.bin.\r\n`);
  const resources=[{path:'SKILL.md',data:content},{path:'references/source.txt',data:Buffer.from('Original source: café\r\n')},{path:'assets/template.bin',data:Buffer.from([0,255,128,4,10])}];
  await fs.writeFile(source,JSON.stringify({files:resources.map(({path,data})=>({path,contentBase64:data.toString('base64')}))}));
  const restored=await restoreSkill(source,target);
  assert.equal(restored.name,name);assert.equal(restored.fileCount,resources.length);
  for(const {path:relative,data}of resources)assert.deepEqual(await fs.readFile(path.join(target,relative)),data,`${relative} must survive the export/restore roundtrip unchanged.`);
  await assert.rejects(restoreSkill(source,target),/already exists/);
});
