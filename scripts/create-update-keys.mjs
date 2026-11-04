// Creates NEW operator keys in an explicit private directory. Never reads/exports Apple signing keys.
import {promises as fs} from 'node:fs';
import {generateKeyPairSync} from 'node:crypto';
import path from 'node:path';
const args=process.argv.slice(2);
try {
  if(args.length!==2||args[0]!=='--output'||!path.isAbsolute(args[1]))throw new Error('Usage: node scripts/create-update-keys.mjs --output /absolute/new/private-directory');
  const output=args[1];await fs.mkdir(output,{mode:0o700});
  const engine=generateKeyPairSync('ed25519'),mac=generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(output,'engine-private.pem'),engine.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
  await fs.writeFile(path.join(output,'engine-public.pem'),engine.publicKey.export({type:'spki',format:'pem'}),{mode:0o600,flag:'wx'});
  const macSeed=mac.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32),macPublic=mac.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64');
  await fs.writeFile(path.join(output,'sparkle-private.key'),macSeed.toString('base64')+'\n',{mode:0o600,flag:'wx'});
  await fs.writeFile(path.join(output,'sparkle-public.txt'),macPublic+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({created:true,sparklePublicKey:macPublic,privateKeysPrinted:false}));
}catch(error){console.error(error.message);process.exitCode=1;}
