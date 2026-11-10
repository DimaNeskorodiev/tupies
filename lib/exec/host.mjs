// `host` execution backend: today's behaviour. The process runs as the Engine's OS account with the
// curated environment from process-environment.mjs and no operating-system isolation.
export const hostBackend=Object.freeze({
  id:'host',
  label:'This computer, ask me',
  async available(){return {ok:true,reason:''};},
  describe(){return {id:'host',label:'This computer, ask me',summary:'Commands run on this computer with your account’s permissions. Anything that can change files asks you first.',isolated:false};},
  async prepare({executable,args,env,cwd}){return {executable,args:[...args],env:{...env},cwd};},
});
