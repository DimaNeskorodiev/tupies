// Every regression is run, with the existing timing-sensitive browser/task fixtures isolated.
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
const sequential=new Set(['browser-actions.test.mjs','browser-control.test.mjs','lsp.test.mjs','questions-history.test.mjs','team.test.mjs','missions-durable.test.mjs','runtime-verification.test.mjs']);
async function run(files,concurrency){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--test',`--test-concurrency=${concurrency}`,...files.map(file=>`test/${file}`)],{stdio:'inherit'});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Release regressions failed.')));});}
try {const files=(await fs.readdir('test')).filter(file=>file.endsWith('.test.mjs')).sort();await run(files.filter(file=>sequential.has(file)),1);await run(files.filter(file=>!sequential.has(file)),4);}catch(error){console.error(error.message);process.exitCode=1;}
