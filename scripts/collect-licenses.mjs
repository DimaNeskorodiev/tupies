import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(root,'assets','licenses');
await fs.mkdir(target,{recursive:true});
const found=new Map();
async function scan(directory){
  const entries=await fs.readdir(directory,{withFileTypes:true}).catch(()=>[]);
  for(const entry of entries){
    if(entry.name.startsWith('.')||!entry.isDirectory())continue;
    const folder=path.join(directory,entry.name);
    if(entry.name.startsWith('@')){await scan(folder);continue;}
    const manifest=await fs.readFile(path.join(folder,'package.json'),'utf8').then(JSON.parse).catch(()=>null);
    if(manifest?.name&&manifest.version){
      const key=`${manifest.name}@${manifest.version}`;
      if(!found.has(key)){
        const notices=[];
        for(const file of await fs.readdir(folder))if(/^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i.test(file)){
          const filePath=path.join(folder,file),stat=await fs.stat(filePath);
          if(stat.isFile()&&stat.size<=1_000_000)notices.push({file,text:await fs.readFile(filePath,'utf8')});
        }
        found.set(key,{name:manifest.name,version:manifest.version,license:manifest.license||'See package notices',homepage:manifest.homepage||'',notices});
      }
    }
    await scan(path.join(folder,'node_modules'));
  }
}
await scan(path.join(root,'node_modules'));
const records=[...found.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
await fs.writeFile(path.join(target,'dependencies.json'),JSON.stringify(records.map(({notices,...record})=>record),null,2)+'\n');
await fs.writeFile(path.join(target,'THIRD_PARTY_LICENSES.txt'),records.map(record=>[
  `${record.name} ${record.version}`,
  `Declared license: ${typeof record.license==='string'?record.license:JSON.stringify(record.license)}`,
  record.homepage,
  ...record.notices.map(notice=>`\n${notice.file}\n${notice.text}`)
].filter(Boolean).join('\n')).join('\n\n'+'='.repeat(72)+'\n\n'));
console.log(`Collected dependency attribution and notices for ${records.length} packages.`);
