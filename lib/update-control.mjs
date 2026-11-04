import net from 'node:net';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {controlSocketPath} from './control.mjs';

export async function updateControl(dataDir,command,token) {
  const file=controlSocketPath(dataDir),owner=await fs.lstat(dataDir),directory=await fs.lstat(path.dirname(file)),socket=await fs.lstat(file);
  if(!owner.isDirectory()||owner.isSymbolicLink()||owner.mode&0o077||!directory.isDirectory()||directory.isSymbolicLink()||directory.mode&0o077||!socket.isSocket()||socket.uid!==owner.uid||directory.uid!==owner.uid||(process.getuid?.()!==0 && owner.uid!==process.getuid?.()))throw new Error('The update socket must belong to the private Engine data owner.');
  if(!['update-status','update-claim','update-release','update-activate'].includes(command))throw new Error('Unsupported update command.');
  return new Promise((resolve,reject)=>{
    let input='';const connection=net.connect(file);const timer=setTimeout(()=>connection.destroy(new Error('Engine update control timed out.')),10_000);
    connection.on('connect',()=>connection.write(JSON.stringify({v:1,command,...(token?{token}:{})})+'\n'));
    connection.on('data',bytes=>{input+=bytes;if(input.length>32_000)connection.destroy(new Error('Oversized update reply.'));});
    connection.on('error',reject);connection.on('close',()=>clearTimeout(timer));
    connection.on('end',()=>{try{const reply=JSON.parse(input);if(!reply.ok||reply.update?.protocol!==1)throw new Error(reply.error || 'Update this Engine manually before enabling automatic updates.');resolve(reply.update);}catch(error){reject(error);}});
  });
}
