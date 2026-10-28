import { spawn } from 'node:child_process';

// One owned process group per background command. Losing the Tupies IPC parent
// terminates the group; persisted OS PIDs are never adopted after restart.
let child=null,started=false,stopping=false,reported=false;
const report=message=>{if(process.connected)try{process.send(message);}catch{}};
function stop() {
  if(stopping)return;stopping=true;
  if(process.platform==='win32') {
    if(!child?.pid){process.exit(0);return;}
    const killer=spawn('taskkill.exe',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    killer.once('error',()=>{try{child.kill('SIGKILL');}catch{}process.exit(0);});
    killer.once('close',()=>process.exit(0));
    setTimeout(()=>process.exit(0),1000);return;
  }
  try{process.kill(-process.pid,'SIGTERM');}catch{}
  // Keep the guardian alive until the entire ordinary process group is killed.
  // A command deliberately escaping its group remains trusted host execution.
  setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{}process.exit(0);},250);
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);process.on('disconnect',stop);
process.on('message',message=>{
  if(message?.type==='stop'){stop();return;}
  if(message?.type!=='start' || started)return;started=true;
  if(stopping)return;
  const env={...process.env};delete env.NODE_CHANNEL_FD;delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  try {
    child=spawn(message.executable,message.args,{cwd:process.cwd(),shell:false,detached:false,windowsHide:true,stdio:[message.stdin==='pipe'?'inherit':'ignore','inherit','inherit'],env});
    child.once('spawn',()=>report({type:'started'}));
    child.once('error',error=>{reported=true;report({type:'start_error',code:error.code || 'unknown'});stop();});
    // exit, rather than close, catches descendants that inherited output pipes.
    child.once('exit',(code,signal)=>{if(!reported){reported=true;report({type:'exited',exitCode:code,signal});}stop();});
  } catch(error){report({type:'start_error',code:error.code || 'unknown'});stop();}
});
