import {createRuntimeSnapshot,inspectRuntimeSnapshot,restoreRuntimeSnapshot} from '../lib/runtime-backup.mjs';

// Explicit paths only. No operational data, .env, provider or scheduler is opened implicitly.
const [operation,...args]=process.argv.slice(2),options={};
try {
  for(let index=0;index<args.length;index+=2){const name=args[index];if(!['--source','--target'].includes(name)||!args[index+1]||args[index+1].startsWith('--'))throw new Error('Use explicit --source and --target paths.');if(options[name.slice(2)])throw new Error('An option was repeated.');options[name.slice(2)]=args[index+1];}
  if(!['create','verify','restore'].includes(operation)||!options.source||(operation!=='verify'&&!options.target)||(operation==='verify'&&options.target))throw new Error('Usage: node scripts/runtime-backup.mjs create|restore --source PATH --target NEW_PATH; verify --source SNAPSHOT.');
  const result=operation==='create'?await createRuntimeSnapshot(options):operation==='restore'?await restoreRuntimeSnapshot(options):(await inspectRuntimeSnapshot(options)).summary;
  console.log(JSON.stringify({operation,verified:true,...result,encrypted:false,engineStarted:false}));
} catch(error) {console.error(error.message);process.exitCode=1;}
