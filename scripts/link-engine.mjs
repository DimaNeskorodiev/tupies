// Same-user Unix administration. Pairing links enter on stdin, never argv or output.
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {controlSocketPath,assertOwnedControlSocket} from '../lib/control.mjs';
const [operation,confirm,...extra]=process.argv.slice(2);
if(!['connect','disconnect'].includes(operation)||confirm!=='--confirm'||extra.length){console.error('Usage: node scripts/link-engine.mjs connect|disconnect --confirm. For connect, supply the exact trusted engine pairing link on stdin.');process.exit(1);}
try{
 let link='';
 if(operation==='connect'){
  if(process.stdin.isTTY)throw new Error();
  for await(const chunk of process.stdin){link+=chunk;if(Buffer.byteLength(link)>3000)throw new Error();}
  link=link.trim();if(!link||/[\r\n]/.test(link))throw new Error();
 }
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const file=controlSocketPath(process.env.STUDIO_DATA_DIR||path.join(root,'data'));await assertOwnedControlSocket(file);
 const reply=await new Promise((resolve,reject)=>{
  const socket=net.connect(file);let bytes='';socket.setTimeout(35_000,()=>{socket.destroy();reject(new Error());});
  socket.once('connect',()=>socket.write(JSON.stringify({v:1,command:operation==='connect'?'connect-home':'disconnect-home',confirm:true,...(link?{link}:{})})+'\n'));
  socket.on('data',chunk=>{bytes+=chunk;if(bytes.length>4096){socket.destroy();reject(new Error());}});
  socket.once('end',()=>{try{resolve(JSON.parse(bytes));}catch{reject(new Error());}});socket.once('error',reject);
 });
 if(!reply.ok)throw new Error();
 console.log(JSON.stringify({ok:true,...(operation==='connect'?{connected:reply.connected,protocol:reply.protocol}:{disconnected:reply.disconnected,automationSuspended:reply.automationSuspended})}));
}catch{console.error('Home-server link unchanged or not confirmed. Check the private engine socket, trusted link, engine updates, active work and network; no pairing secret was printed.');process.exitCode=1;}
