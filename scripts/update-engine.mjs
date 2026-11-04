import {promises as fs} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runEngineUpdate,validateUpdateConfig} from '../lib/engine-updater.mjs';
import {privateFile} from '../lib/update-artifacts.mjs';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw new Error('Usage: node scripts/update-engine.mjs --config /absolute/private/updater.json');
    if(process.platform!=='linux'||process.getuid()!==0)throw new Error('The installed VPS updater runs as root on Linux; Engine runs as its separate service account.');
    const [major,minor,patch]=process.versions.node.split('.').map(Number);if(major!==22||minor<23||minor===23&&patch<4)throw new Error('The VPS updater requires the verified Node 22.23.4 baseline or a later Node 22 patch.');
    const config=validateUpdateConfig(JSON.parse(await privateFile(args[1])));console.log(JSON.stringify(await runEngineUpdate(config)));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
