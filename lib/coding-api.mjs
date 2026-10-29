import { ensure } from './store.mjs';

/** Normal workspace authentication/CSRF applies before this local-only setup route. */
export async function codingApi(req,res,url,{runtime,body,json,clientAddress}) {
  if(!url.pathname.startsWith('/api/local-coding'))return false;
  const service=runtime.localCoding,reply=data=>{json(res,data);return true;};
  const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(clientAddress || req.socket.remoteAddress);
  if(url.pathname==='/api/local-coding'&&req.method==='GET')return reply(local?await service.status():{available:false,agents:[],projects:[],jobs:[]});
  ensure(local,403,'Local coding connections can only be managed from this Mac.');service.assertAvailable();
  if(url.pathname==='/api/local-coding/discover'&&req.method==='POST')return reply(await service.discover(await body(req,1000)));
  const agent=url.pathname.match(/^\/api\/local-coding\/agents\/(claude|codex)$/);
  if(agent&&req.method==='PUT')return reply(await service.configureAgent(agent[1],await body(req,5000)));
  if(url.pathname==='/api/local-coding/projects'&&req.method==='POST')return reply(await service.configureProject(await body(req,64000)));
  const items=url.pathname.match(/^\/api\/local-coding\/projects\/([A-Za-z0-9_-]+)\/work-items$/);
  if(items&&req.method==='GET'){const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort(new Error('Request closed.'));};res.once('close',abort);try{return reply(await service.workItems(items[1],{signal:controller.signal}));}finally{res.off('close',abort);}}
  ensure(false,404,'Local coding route not found.');
}
