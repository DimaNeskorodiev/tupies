import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runEvaluation, CASES } from '../eval/runner.mjs';

const HELP=`Run Tupies evaluations on disposable data. No .env or operational account is loaded.

npm run eval:agent -- --list
npm run eval:agent -- --mode fixture --repeat 3 --output output/eval/report.json

Live runs require --mode live, explicit --provider and --model, and input/output
USD prices per million tokens (--input-price / --output-price). API credentials
come only from STUDIO_EVAL_API_KEY. --base-url is optional; credentials are sent
only through the normal provider destination checks.

Owner-authorized subscription runs instead require --provider chatgpt,
--authorized-subscription and --subscription-source /absolute/home/engine/data.
Only the running home engine's current access token is read per request; copied
tokens are never renewed. No account or transcript enters the disposable store.
Subscription cost and remote output-token enforcement are unavailable.

Options: --cases id,id --repeat 1 --max-inferences 16 --max-tools 40
  --max-ms 120000 --max-tokens 1000000 --max-output-tokens 2048 --max-cost 2
  --provider openai|anthropic|xai|openrouter|ollama|custom|chatgpt --model MODEL --image-input auto|on|off
  --input-price USD --output-price USD --base-url URL --output PATH
  --authorized-subscription --subscription-source PATH --subscription-connection ID

Fixture passes certify mechanical harness behavior, not model quality. Missing
vision coverage is reported separately. Live requests incur the provider's charges.
`;
const numeric=new Set(['repeat','max-inferences','max-tools','max-ms','max-tokens','max-output-tokens','max-cost','input-price','output-price']);
const known=new Set([...numeric,'mode','cases','provider','model','image-input','base-url','output','subscription-source','subscription-connection']);
function parse(args){const options={};for(let index=0;index<args.length;index++){const arg=args[index];if(arg==='--help' || arg==='-h')return {help:true};if(arg==='--list')return {list:true};if(arg==='--authorized-subscription'){options.authorizedSubscription=true;continue;}if(!arg.startsWith('--') || !known.has(arg.slice(2)))throw new Error('Unknown evaluation option. Use --help.');const key=arg.slice(2),value=args[++index];if(value===undefined || value.startsWith('--'))throw new Error(`Missing value for ${arg}.`);options[key.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=numeric.has(key)?Number(value):key==='cases'?value.split(','):value;}return options;}
try {
  const options=parse(process.argv.slice(2));
  if(options.help)process.stdout.write(HELP);
  else if(options.list)for(const item of CASES)process.stdout.write(`${item.id}\t${item.family}\n`);
  else {
    const report=await runEvaluation(options),serialized=`${JSON.stringify(report,null,2)}\n`;
    if(options.output){const destination=path.resolve(options.output);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,serialized,{mode:0o600});process.stdout.write(`Saved sanitized evaluation report (${report.summary.executed} cases).\n`);}
    else process.stdout.write(serialized);
    if(report.summary.failed || report.summary.budgetExhausted || report.summary.executed<report.summary.requested)process.exitCode=1;
  }
} catch(error){process.stderr.write(`${error.message?.startsWith('Use ') || error.message?.startsWith('Live ') || error.message?.startsWith('Mode ') || error.message?.startsWith('Select ') || error.message?.startsWith('Unknown ') || error.message?.startsWith('Missing ') || error.message?.includes('must be')?error.message:'Evaluation could not start. Check explicit provider settings and budgets; private error details were omitted.'}\n`);process.exitCode=1;}
