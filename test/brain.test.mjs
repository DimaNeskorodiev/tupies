import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { AgentTools, getWorkspaceRoot } from '../lib/agent-tools.mjs';
import { appendToBody, notePath, parseNote } from '../lib/brain.mjs';

async function fixture(t,policy='balanced') {
  const directory=await fs.mkdtemp(path.join(tmpdir(),'studio-brain-')),store=await new Store(directory).init();
  t.after(async()=>{await store.queue;await fs.rm(directory,{recursive:true,force:true});});
  const bot={...store.state.bots[0],approvalPolicy:policy},tools=new AgentTools(store),root=await getWorkspaceRoot(store,bot.id);
  const execute=(name,args,options)=>tools.execute(bot,name,args,options);
  return {directory,store,bot,tools,root,brain:path.join(root,'brain'),execute};
}

test('long-term notes are Obsidian-compatible Markdown with links, backlinks and inflection-tolerant search',async t=>{
  const {brain,execute}=await fixture(t);
  const acme=await execute('brain_write',{path:'projects/acme',content:'# Acme launch\n\nShip the пілотний проєкт with [[Ada Lovelace]] by March. #launch\n\n```\n[[not-a-link]] #not-a-tag\n```\n',tags:['project/acme'],type:'project'});
  assert.equal(acme.path,'projects/acme.md');assert.equal(acme.created,true);
  const written=await fs.readFile(path.join(brain,'projects/acme.md'),'utf8');
  assert.match(written,/^---\ntype: project\ntags: \["project\/acme"\]\ncreated: \d{4}-\d\d-\d\dT[\d:]+Z\nupdated: [\dT:-]+Z\n---\n# Acme launch\n/);
  await execute('brain_write',{path:'people/Ada Lovelace',content:'Ada leads analytics for [[acme]].',aliases:['Ada']});
  await execute('brain_write',{path:'topics/gardening',content:'Tomatoes need sun.'});
  await execute('brain_append',{path:'daily/2026-10-26',content:'- Met [[Ada]] about the launch'});
  const english=await execute('brain_search',{query:'launched'});
  assert.equal(english.results[0].path,'projects/acme.md');assert.equal(english.results[0].backlinks,1);
  assert.ok(!english.results.some(result=>result.path==='topics/gardening.md'));
  const inflected=await execute('brain_search',{query:'пілотного проєкту'});
  assert.deepEqual(inflected.results.map(result=>result.path),['projects/acme.md']);assert.match(inflected.results[0].snippet,/пілотний проєкт/);
  assert.deepEqual((await execute('brain_search',{query:'',tag:'project'})).results.map(result=>result.path),['projects/acme.md']);
  assert.deepEqual((await execute('brain_search',{query:'',folder:'people'})).results.map(result=>result.path),['people/Ada Lovelace.md']);
  assert.equal((await execute('brain_search',{query:''})).results.length,4);
  const read=await execute('brain_read',{path:'projects/acme.md'});
  assert.deepEqual(read.tags,['project/acme','launch']);assert.equal(read.type,'project');assert.match(read.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(read.links,[{target:'Ada Lovelace',path:'people/Ada Lovelace.md'}]);
  assert.deepEqual(read.backlinks.map(link=>link.path),['people/Ada Lovelace.md']);
  assert.deepEqual((await execute('brain_read',{path:'people/Ada Lovelace'})).backlinks.map(link=>link.path),['daily/2026-10-26.md','projects/acme.md']);
  const overview=await execute('brain_links',{});
  assert.deepEqual(overview.orphans,['topics/gardening.md']);assert.deepEqual(overview.hubs.map(hub=>[hub.path,hub.backlinks]),[['people/Ada Lovelace.md',2],['projects/acme.md',1]]);
  assert.deepEqual(overview.tags.map(tag=>tag.tag).sort(),['launch','project/acme']);
  await execute('brain_append',{path:'topics/gardening',content:'See [[Missing note]].'});
  assert.deepEqual((await execute('brain_links',{})).unresolved,[{target:'Missing note',sources:1}]);
  const neighbourhood=await execute('brain_links',{path:'daily/2026-10-26',depth:2});
  assert.deepEqual(neighbourhood.nodes.map(node=>[node.path,node.distance]).sort(),[['daily/2026-10-26.md',0],['people/Ada Lovelace.md',1],['projects/acme.md',2]]);
});

test('replacing a note requires its current sha256 and keeps the owner’s other properties',async t=>{
  const {brain,execute}=await fixture(t);
  await execute('brain_write',{path:'decisions/stack',content:'Use Node.',tags:['tech']});
  const file=path.join(brain,'decisions/stack.md'),original=await fs.readFile(file,'utf8'),created=original.match(/created: (.+)/)[1];
  await assert.rejects(execute('brain_write',{path:'decisions/stack',content:'Overwrite blindly.'}),/already exists/);
  // The owner adds a property and text in Obsidian between the bot's read and write.
  const first=await execute('brain_read',{path:'decisions/stack'});
  await fs.writeFile(file,original.replace('---\n',`---\ncssclasses: ["wide"]\n`).replace('Use Node.','Use Node 22.'));
  await assert.rejects(execute('brain_write',{path:'decisions/stack',content:'Stale replacement.',expectedSha256:first.sha256}),/changed since it was read/);
  const fresh=await execute('brain_read',{path:'decisions/stack'});
  await execute('brain_write',{path:'decisions/stack',content:'---\nstatus: accepted\n---\nUse Node 22 everywhere.',expectedSha256:fresh.sha256,type:'decision'});
  const replaced=await fs.readFile(file,'utf8');
  assert.match(replaced,/cssclasses: \["wide"\]/);assert.match(replaced,/tags: \["tech"\]/);assert.match(replaced,/status: accepted/);assert.match(replaced,/type: decision/);
  assert.match(replaced,new RegExp(`created: ${created}`));assert.match(replaced,/---\nUse Node 22 everywhere\.$/);
  await assert.rejects(execute('brain_write',{path:'decisions/new',content:'x',expectedSha256:fresh.sha256}),/no longer exists/);
  await assert.rejects(execute('brain_write',{path:'decisions/huge',content:'x'.repeat(100001)}),/1–100000/);
  await assert.rejects(execute('brain_write',{path:'decisions/bad',content:'x',tags:['two words']}),/Tags use/);
  await assert.rejects(execute('brain_write',{path:'decisions/bad',content:'x',type:'Not A Type'}),/Note type/);
});

test('appends land in order under sections, and concurrent appends to one note are serialized',async t=>{
  assert.equal(appendToBody('# Day\n\n## Log\n\n- one\n\n## Ideas\n\nKeep.\n','- two','Log'),'# Day\n\n## Log\n\n- one\n- two\n\n## Ideas\n\nKeep.\n');
  assert.equal(appendToBody('Intro\n\n```\n## Log\n```\n','Entry','Log'),'Intro\n\n```\n## Log\n```\n\n## Log\n\nEntry\n');
  assert.equal(appendToBody('Paragraph.','Next paragraph.'),'Paragraph.\n\nNext paragraph.\n');
  const {brain,execute}=await fixture(t);
  await Promise.all(Array.from({length:10},(_,index)=>execute('brain_append',{path:'daily/today',content:`- entry ${index}`,heading:'Log'})));
  const content=await fs.readFile(path.join(brain,'daily/today.md'),'utf8');
  assert.equal(content.match(/^- entry \d$/gm).length,10);assert.equal(content.match(/^## Log$/gm).length,1);
  await fs.writeFile(path.join(brain,'plain.md'),'No frontmatter here.');
  await execute('brain_append',{path:'plain',content:'Added.'});
  assert.equal(await fs.readFile(path.join(brain,'plain.md'),'utf8'),'No frontmatter here.\n\nAdded.\n');
  await assert.rejects(execute('brain_append',{path:'daily/today',content:'x'.repeat(20001)}),/1–20000/);
});

test('the index follows files edited outside Tupies and ignores hidden, symlinked and non-Markdown files',async t=>{
  const {directory,store,brain,root,execute}=await fixture(t);
  await fs.mkdir(path.join(brain,'.obsidian'),{recursive:true});
  await fs.writeFile(path.join(brain,'.obsidian/workspace.md'),'quasar hidden settings');
  await fs.writeFile(path.join(brain,'quasar.txt'),'quasar plain text');
  await fs.writeFile(path.join(brain,'Observatory.md'),'---\ntags:\n  - space\naliases: [Obs]\n---\nThe quasar survey.');
  let result=await execute('brain_search',{query:'quasar'});
  assert.deepEqual(result.results.map(item=>item.path),['Observatory.md']);assert.deepEqual(result.results[0].tags,['space']);
  await fs.writeFile(path.join(brain,'Observatory.md'),'Now about pulsars.');
  assert.equal((await execute('brain_search',{query:'quasar'})).results.length,0);
  assert.equal((await execute('brain_search',{query:'pulsar'})).results[0].path,'Observatory.md');
  await fs.symlink(path.join(directory,'state.json'),path.join(brain,'linked.md'));
  assert.equal((await execute('brain_search',{query:''})).notes,1);
  await assert.rejects(execute('brain_read',{path:'linked'}),/Symbolic links/);
  await assert.rejects(execute('brain_append',{path:'linked',content:'x'}),/Symbolic links/);
  for(const bad of ['../state','brain/../../x','.obsidian/app','projects/.hidden','a/b/c/d/e/f/g/h/i'])assert.throws(()=>notePath(bad),/Note paths|note path/);
  await assert.rejects(execute('brain_read',{path:'../../state'}),/Note paths/);
  await fs.unlink(path.join(brain,'Observatory.md'));
  assert.equal((await execute('brain_search',{query:'pulsar'})).results.length,0);
  const other={...store.state.bots[1],approvalPolicy:'balanced'},tools=new AgentTools(store);
  await execute('brain_write',{path:'private',content:'Only for the first bot.'});
  assert.equal((await tools.execute(other,'brain_search',{query:'first bot'})).results.length,0);
  await fs.rm(brain,{recursive:true});await fs.symlink(directory,brain);
  await assert.rejects(execute('brain_search',{query:''}),/Symbolic links/);
  assert.ok(root.startsWith(directory));
});

test('note writes follow the approval policy, belong to the memory tools and never keep provider secrets',async t=>{
  const {store,bot,tools,execute}=await fixture(t,'strict');
  for(const name of ['brain_search','brain_read','brain_write','brain_append','brain_links'])assert.ok(tools.definitions(bot).some(item=>item.name===name),name);
  assert.ok(!tools.definitions({...bot,tools:['workspace']}).some(item=>item.name.startsWith('brain_')));
  await assert.rejects(tools.execute({...bot,tools:['workspace']},'brain_search',{query:''}),/not enabled/);
  assert.equal(tools.requiresApproval('brain_write',bot),true);assert.equal(tools.requiresApproval('brain_append',bot),true);
  assert.equal(tools.requiresApproval('brain_write',{...bot,approvalPolicy:'balanced'}),false);assert.equal(tools.requiresApproval('brain_search',bot),false);
  await assert.rejects(execute('brain_append',{path:'log',content:'x'}),/approval/);
  await store.mutate(state=>{state.connections.push({id:'brain-provider',type:'openai',name:'Fixture',model:'test-model',secret:store.seal('fixture-private-key')});});
  const saved=await execute('brain_write',{path:'service',content:'The key was fixture-private-key.',aliases:['fixture-private-key alias']},{approved:true});
  const content=await fs.readFile(path.join(await getWorkspaceRoot(store,bot.id),'brain',saved.path),'utf8');
  assert.doesNotMatch(content,/fixture-private-key/);assert.match(content,/\[redacted\]/);
});

test('note parsing reads common Obsidian property forms without treating code as links',()=>{
  const note=parseNote('people/grace.md','---\ntitle: Grace Hopper\ntag: navy, compilers\nalias:\n  - "Amazing Grace"\n---\n# Career\nSee [[cobol|COBOL]] and ![[diagram.png]] or [[projects/flow-matic#History]]. `[[inline]]` #2024 #history\n');
  assert.equal(note.title,'Grace Hopper');assert.deepEqual(note.aliases,['Amazing Grace']);
  assert.deepEqual(note.tags,['navy','compilers','history']);assert.deepEqual(note.links,['cobol','projects/flow-matic']);
});

test('hostile headings and frontmatter parse in linear time with the same section semantics',()=>{
  const spaces=' '.repeat(100_000),started=performance.now();
  const note=parseNote('topics/launch.md',`---\ntitle: Launch${spaces}x #comment${spaces}\n---\n# a${spaces}b\n## Plan ##   \n# C#\n#######  too deep\n#${spaces}\n`);
  const body=appendToBody(`# a${spaces}b\n\nkept${spaces}\n`,'Added.',`a${spaces}b`),elapsed=performance.now()-started;
  assert.ok(elapsed<1000,`parsing took ${Math.round(elapsed)} ms`);
  assert.equal(note.title,`Launch${spaces}x`);
  // Heading terms weigh 2 on top of the text's 1; closing #s and spaces are not part of the heading.
  assert.equal(note.terms.get('plan'),3);assert.equal(note.terms.get('deep'),1);
  assert.equal(body,`# a${spaces}b\n\nkept\n\nAdded.\n`);
  assert.equal(appendToBody('## Plan ##\n\nFirst.\n\n## Other\n\nx\n','Second.','plan'),'## Plan ##\n\nFirst.\n\nSecond.\n\n## Other\n\nx\n');
});
