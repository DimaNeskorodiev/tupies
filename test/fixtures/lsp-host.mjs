import { Store } from '../../lib/store.mjs';
import { LanguageServers } from '../../lib/lsp.mjs';
import { writeWorkspace } from '../../lib/agent-tools.mjs';
import { fileURLToPath } from 'node:url';

const store=await new Store(process.argv[2]).init(),servers=new LanguageServers(store),owner={botId:'bot_atlas',runId:'run_host_fixture'};
await store.mutate(state=>{state.runs.bot_atlas={id:owner.runId,status:'running'};});
await writeWorkspace(store,owner.botId,'main.ts','fixture process identity');
const session=await servers.start({...owner,server:'custom',executable:process.execPath,args:[fileURLToPath(new URL('./lsp-server.mjs',import.meta.url)),'pid']});
const result=await servers.query({...owner,sessionId:session.id,path:'main.ts',operation:'hover'});
process.send({pid:Number(result.content)});
