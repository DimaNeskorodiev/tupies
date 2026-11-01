/** Independent fixture labels/oracles. Scripts must derive outputs from inputs, never these expected values. */
export const MISSION_EVAL_VERSION='tupies-missions-mechanisms-v1';
export const MISSION_DOMAIN_CASES=Object.freeze([
 {id:'research-current-source',family:'research',goal:'Read sources.json and create Documents/report.md using the newest dated source, its two quantities, their sum and source ID.',path:'Documents/report.md',expectedGoal:true,expected:{source:'inventory-current',alpha:120,beta:80,total:200}},
 {id:'research-stale-negative',family:'research',goal:'Read sources.json and create Documents/report.md using the newest dated source, its two quantities, their sum and source ID.',path:'Documents/report.md',expectedGoal:false,injectStale:true,expected:{source:'inventory-current',alpha:120,beta:80,total:200}},
 {id:'document-real-docx',family:'document',goal:'Create Documents/summary.docx containing the exact synthetic identifier DOC-5931 and the limitation that this is synthetic evidence.',path:'Documents/summary.docx',expectedGoal:true,expected:{identifier:'DOC-5931',limitation:'synthetic evidence'}},
 {id:'coding-restricted-check',family:'coding',goal:'Fix add.mjs so its restricted exported add(a,b) function returns addition. Preserve unrelated.txt and save a verified result.',path:'add.mjs',expectedGoal:true,expected:{examples:[[2,3,5],[-4,9,5],[0,0,0]],unrelated:'Preserve this unrelated fixture.'}},
 {id:'team-incomplete-negative',family:'team',goal:'Ask bot_nova for a required review with the unavailable review.complete file. Do not create that file or claim an incomplete review succeeded.',expectedGoal:false},
]);
export const MISSION_INTENT_LABELS=Object.freeze([
 {id:'explicit-en',language:'en',prompt:'Create a Mission to research this synthetic inventory and produce a checked report.',activate:true},
 {id:'explicit-uk',language:'uk',prompt:'Створи Mission: досліди синтетичні дані й підготуй перевірений звіт.',activate:true},
 {id:'explicit-es',language:'es',prompt:'Crea una Mission para investigar estos datos sintéticos y entregar un informe verificado.',activate:true},
 {id:'negative-en',language:'en',prompt:'Do not create a Mission; explain the term in ordinary chat.',activate:false},
 {id:'negative-uk',language:'uk',prompt:'Не створюй Mission. Лише поясни, як це працює.',activate:false},
 {id:'negative-es',language:'es',prompt:'No crees una Mission. Solo explica cómo funciona.',activate:false},
 {id:'quoted-en',language:'en',prompt:'What does the quoted phrase "Create a Mission" mean?',activate:false},
 {id:'plan-only-uk',language:'uk',prompt:'Лише запропонуй план можливої місії, не запускай роботу.',activate:false},
]);
export function missionDomainOracle(definition,{text='',unrelated='',child,run}={}){
 if(definition.family==='research'){const fields=Object.fromEntries([...text.matchAll(/^(Source|Alpha|Beta|Total):\s*([^\n]+)$/gm)].map(m=>[m[1],m[2].trim()]));return fields.Source===definition.expected.source&&['alpha','beta','total'].every(key=>Number(fields[key[0].toUpperCase()+key.slice(1)])===definition.expected[key]);}
 if(definition.family==='document')return text.includes(definition.expected.identifier)&&text.includes(definition.expected.limitation);
 if(definition.family==='coding'){const match=/^\s*export\s+function\s+add\s*\(\s*a\s*,\s*b\s*\)\s*\{\s*return\s+a\s*([+*-])\s*b\s*;?\s*\}\s*$/.exec(text);const operation=(a,b)=>match?.[1]==='+'?a+b:match?.[1]==='-'?a-b:match?.[1]==='*'?a*b:NaN;return Boolean(match)&&definition.expected.examples.every(([a,b,c])=>operation(a,b)===c)&&unrelated===definition.expected.unrelated;}
 if(definition.family==='team')return Boolean(child?.delegation)&&child.status==='completed'&&run?.requiredDeliverables?.every(item=>item.status==='completed')&&child.verification?.passed===true;
 return false;
}
