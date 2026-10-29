import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runRetrievalEvaluation } from '../eval/retrieval-runner.mjs';

try {
  const args=process.argv.slice(2);let k=4,output='';
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--help'){process.stdout.write('Evaluate public local retrieval fixtures: npm run eval:retrieval -- --k 4 --output output/eval/retrieval.json\nNo account, model or network is used. Scores retain misses and stale candidates.\n');process.exit(0);}
    if(args[i]==='--k')k=Number(args[++i]);else if(args[i]==='--output'){output=args[++i];if(!output || output.startsWith('--'))throw new Error('Give an output path.');}else throw new Error('Use --k, --output or --help.');
  }
  const report=await runRetrievalEvaluation({k}),body=JSON.stringify(report,null,2)+'\n';
  if(output){const target=path.resolve(output);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,body,{mode:0o600});process.stdout.write(`Saved ${report.queryCount}-query retrieval report; measured misses are retained.\n`);}else process.stdout.write(body);
}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
