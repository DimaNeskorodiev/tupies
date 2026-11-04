import {stageEngineSource} from './package-apple-engine.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
try {
  const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--output'||!path.isAbsolute(args[1]))throw new Error('Usage: node scripts/stage-engine-release.mjs --output /absolute/new/staging-directory');
  await stageEngineSource(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args[1]);
  console.log('Staged allowlisted Engine source. Install locked production dependencies on the target platform before signing.');
}catch(error){console.error(error.message);process.exitCode=1;}
