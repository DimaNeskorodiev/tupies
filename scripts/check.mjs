import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['server.mjs'];
for(const directory of ['lib','lib/sync','lib/exec','scripts','public','eval'])for(const entry of await readdir(path.join(root,directory)))if(/\.(?:mjs|js)$/.test(entry))files.push(`${directory}/${entry}`);
for(const file of files){const result=spawnSync(process.execPath,['--check',path.join(root,file)],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
console.log(`Syntax checked ${files.length} JavaScript modules.`);
