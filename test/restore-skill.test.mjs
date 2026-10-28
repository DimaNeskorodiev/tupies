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
