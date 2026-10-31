import { readFileSync } from 'node:fs';

// Reviewed instruction bytes ship with the Engine. Only these explicit resources
// enter the catalog; this does not scan installed skills or an operational store.
const resources = ['SKILL.md','references/product-workflows.md','references/troubleshooting.md','references/operator-recovery.md'];
const source = resources.map(path=>({path,data:readFileSync(new URL(`./skills/tupies-product/${path}`,import.meta.url))}));

export function tupiesProductBundles() {
  const files=source.map(file=>({path:file.path,data:Buffer.from(file.data)}));
  return [{
    catalogId:'tupies-product',name:'tupies-product',title:'Tupies product guide',category:'Tupies',
    description:"Use Tupies correctly, configure bots, skills and routines with available Engine tools, and diagnose product errors from observed evidence. Use for Tupies setup, missing capabilities, failed tasks, provider connections, browser sign-in, files or engine differences; not as a replacement for a domain task's own workflow.",
    examples:['Як користуватися Tupies?','Виправ помилку Tupies: рутина не запускається.','Diagnose a Tupies skill or provider error.'],
    author:'Tupies',source:'tupies',version:'1.0.0',license:'MIT',requiredGroups:[],
    content:files[0].data.toString('utf8'),files,
  }];
}
