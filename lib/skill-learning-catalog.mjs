import { readFileSync } from 'node:fs';

// Only these reviewed instruction resources enter the offline catalog. Loading
// this package never reads a bot's files or installs an execution dependency.
const resources = ['SKILL.md','references/learning-rules.md','references/documents.md','references/video.md','references/knowledge-template.md','references/apply-and-correct.md'];
const source = resources.map(path=>({path,data:readFileSync(new URL(`./skills/tupies-learning/${path}`,import.meta.url))}));

export function tupiesLearningBundles() {
  const files=source.map(file=>({path:file.path,data:Buffer.from(file.data)}));
  return [{
    catalogId:'tupies-learn-from-material',name:'tupies-learn-from-material',title:'Learn from material',category:'Learning',
    description:"Learn role-relevant knowledge and reusable methods from supplied documents, books or video transcripts, integrate them with existing Brain notes, and apply or correct them in later work. Use when the owner asks a specialist bot to study material or improve its retained knowledge; ordinary summarization does not imply permission to retain it.",
    examples:['Вивчи цю енциклопедію для своєї роботи з SEO.','Навчися корисного з документів і відео.','Learn useful methods from this book and transcript.','Correct what you learned about this project.'],
    author:'Tupies',source:'tupies',version:'1.0.0',license:'MIT',requiredGroups:['workspace','memory'],
    content:files[0].data.toString('utf8'),files,
  }];
}
