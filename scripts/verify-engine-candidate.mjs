// Operator CLI only: planning is inert; --run opts into the pinned container policy.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensure } from '../lib/store.mjs';
import { readVerifierBundle, verifierConfig, runEngineVerification, VERIFIER_POLICY } from '../lib/engine-verifier.mjs';

export function parseVerifierArguments(argv){
  const [file,...rest]=argv,options={};ensure(file&&!file.startsWith('--'),400,'Choose a contribution JSON file.');
  const names={'--reviewed':'reviewedDigest','--image':'image','--docker':'executable','--socket':'socket','--output':'output'};
  for(let i=0;i<rest.length;i++){const flag=rest[i];if(flag==='--run'){ensure(!options.run,400,'Repeated --run.');options.run=true;continue;}ensure(names[flag]&&!Object.hasOwn(options,names[flag])&&rest[i+1]&&!rest[i+1].startsWith('--'),400,'Unknown, repeated or incomplete verifier argument.');options[names[flag]]=rest[++i];}
  verifierConfig(options);ensure(options.reviewedDigest,400,'Pass --reviewed with the exact contribution digest.');ensure(!options.run||options.output,400,'A run requires --output with a new receipt file.');return {file,...options};
}
export async function verifyCandidateCLI(argv){
  const options=parseVerifierArguments(argv),bundle=await readVerifierBundle(options.file,options.reviewedDigest);
  if(!options.run)return {planOnly:true,proposalDigest:bundle.digest,image:options.image,policy:VERIFIER_POLICY,steps:['Exact base reconstruction in the dedicated image','Syntax checks','Complete regression suite, rejecting skips','Web-only product build','Container removal'],notice:'No Docker command or candidate execution occurred. Review the source, dedicated image and fixed policy; add --run --output NEW_RECEIPT.json to execute. No automatic image pull, install, source application or deployment.'};
  // Check the receipt destination before any container is created; never overwrite a prior receipt.
  const output=path.resolve(options.output);await fs.access(path.dirname(output));try{await fs.lstat(output);throw new Error('Choose a new receipt path.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const controller=new AbortController(),stop=()=>controller.abort(new Error('Operator stopped verification.'));
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{const report=await runEngineVerification(bundle,{...options,signal:controller.signal});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});return {...report,receipt:output};}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{const result=await verifyCandidateCLI(process.argv.slice(2));console.log(JSON.stringify(result,null,2));if(result.passed===false)process.exitCode=1;}
  catch(error){console.error(error.message);process.exitCode=1;}
}
