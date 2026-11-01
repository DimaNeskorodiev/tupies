import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runAssimilationEvaluation } from '../eval/assimilation/runner.mjs';

try {
  const args=process.argv.slice(2);let k=4,output='';
  for(let index=0;index<args.length;index++) {
    if(args[index]==='--help') {
      process.stdout.write('Evaluate public synthetic assimilation fixtures: npm run eval:assimilation -- --k 4 --output output/eval/assimilation.json\nUses real native study/publication/retrieval code with a deterministic fixture adapter and a disposable store. No account, external model or network is used. Semantic usefulness and human application scoring remain unmeasured.\n');
      process.exit(0);
    }
    if(args[index]==='--k')k=Number(args[++index]);
    else if(args[index]==='--output'){output=args[++index];if(!output||output.startsWith('--'))throw new Error('Give an output path.');}
    else throw new Error('Use --k, --output or --help. Live/provider and runtime-data options are not supported.');
  }
  const report=await runAssimilationEvaluation({k}),body=JSON.stringify(report,null,2)+'\n';
  if(output) {
    const target=path.resolve(output);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,body,{mode:0o600});
    process.stdout.write(`Saved deterministic assimilation report for ${report.reading.sourceCount} sources and ${report.retrieval.questions.length} questions; semantic/model usefulness remains unmeasured.\n`);
  }else process.stdout.write(body);
}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
