import {ensure} from './store.mjs';

/** Setup belongs to the local owner UI, never a model-callable configuration tool. */
export async function desktopApi(req,res,url,{runtime,body,json,clientAddress}) {
  if(!url.pathname.startsWith('/api/desktop'))return false;
  const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(clientAddress||req.socket.remoteAddress),reply=value=>{json(res,value);return true;};
  if(url.pathname==='/api/desktop'&&req.method==='GET')return reply(local?await runtime.desktop.status():{available:false,enabled:false,apps:[]});
  ensure(local,403,'Desktop settings can only be managed from this Mac.');
  if(url.pathname==='/api/desktop'&&req.method==='PUT')return reply(await runtime.desktop.configure(await body(req,32000)));
  if(url.pathname==='/api/desktop/check'&&req.method==='POST'){const input=await body(req,1000);ensure(input&&Object.keys(input).length===0,400,'Desktop checks accept no command arguments.');const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort(new Error('Desktop check closed.'));};res.once('close',abort);try{return reply(await runtime.desktop.status({probe:true,signal:controller.signal}));}finally{res.off('close',abort);}}
  ensure(false,404,'Desktop route not found.');
}
