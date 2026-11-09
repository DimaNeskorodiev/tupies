/* Read-only presentation of Tupies's recorded run events. No sample results, tool
   execution, model inference, or private reasoning is produced by this adapter. */
(() => {
  'use strict';
  const LIMITS={nodes:24,edges:40,events:160,calls:4,facts:12,preview:2000};
  const secretKey=/password|passwd|secret|token|authorization|credential|cookie|headers?|api.?key|private.?key|vault|account|email|phone|ssn|social.?security|id$|(?:^|[_-])id(?:$|[_-])/i;
  const terminal=new Set(['completed','failed','cancelled','interrupted']);
  const statusLabels={queued:'Getting ready',stopping:'Stopping',waiting_for_approval:'Waiting for approval',waiting_for_delegate:'Waiting for a teammate',waiting_for_input:'Waiting for your input',completed:'Task completed',failed:'Task failed',cancelled:'Task stopped',interrupted:'Task interrupted',remote:'Working on another engine',working_elsewhere:'Working on another engine',busy_elsewhere:'Working on another engine'};
  const hash=value=>{let result=2166136261;for(const character of String(value))result=Math.imul(result^character.charCodeAt(0),16777619);return result>>>0;};
  const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
  function url(value) {
    try {
      const parsed=new URL(String(value));
      if(!['https:','http:'].includes(parsed.protocol))return '';
      // URL queries, fragments and userinfo may contain credentials. They are
      // never copied into labels, inspection data, signatures or packet text.
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0,260);
    } catch {return '';}
  }
  function text(value,limit=180) {
    if(typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')return '';
    return String(value).slice(0,4000)
      .replace(/https?:\/\/[^\s<>"']+/gi,match=>url(match)||'[URL]')
      .replace(/\bBearer\s+[^\s,;]+/gi,'Bearer [redacted]')
      .replace(/\b(?:sk|sk-proj|sk-ant)-[a-z0-9_-]{8,}/gi,'[redacted]')
      .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*["']?[^\s,;"']+/gi,'[redacted]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
      .replace(/\s+/g,' ').trim().slice(0,limit);
  }
  function path(value) {
    const result=text(value,260).replace(/[?#].*$/,'').replaceAll('\\','/');
    // Host filesystem locations are not useful to this private-workspace UI.
    return /^(?:\/|[a-z]:\/)/i.test(result)?result.split('/').filter(Boolean).at(-1)||'File':result;
  }
  function safeTarget(arguments_,tool) {
    const args=plain(arguments_)?arguments_:{};
    if(typeof args.url==='string')return url(args.url);
    if(typeof args.path==='string')return path(args.path);
    if(typeof args.rootPath==='string')return path(args.rootPath)||'Workspace';
    if(typeof args.cwd==='string')return path(args.cwd)||'Workspace';
    if(typeof args.executable==='string')return path(args.executable);
    if(typeof args.query==='string')return text(args.query,100);
    if(typeof args.skillId==='string')return text(args.skillId,80);
    return text(tool,80);
  }
  function targetLabel(value) {
    const parsed=url(value);
    if(parsed){try{const location=new URL(parsed);return text(`${location.hostname}${location.pathname==='/'?'':location.pathname}`,44);}catch{}}
    return text(value,44)||'Tool';
  }
  function parsePreview(value) {
    if(typeof value!=='string'||!value.trim())return {value:null,complete:false,reason:'No result preview'};
    if(value.length>LIMITS.preview)return {value:null,complete:false,reason:'Result preview exceeds the display limit'};
    try {return {value:JSON.parse(value),complete:true,reason:''};}
    catch {return {value:null,complete:false,reason:value.length>=LIMITS.preview?'Result preview is incomplete':'Unstructured result preview'};}
  }
  function facts(value,budget=LIMITS.facts) {
    const result=[];
    const add=(label,value_,detail='Observed tool result')=>{
      if(result.length>=budget)return;
      const safeLabel=text(label,48),safeValue=text(value_,100);
      if(safeLabel&&safeValue)result.push({label:safeLabel,value:safeValue,detail:text(detail,180)});
    };
    function visit(item,prefix='',depth=0) {
      if(depth>2||result.length>=budget||!item||typeof item!=='object')return;
      if(Array.isArray(item)) {
        if(prefix)add(prefix,`${item.length} item${item.length===1?'':'s'}`,'Item count in the retained result');
        // Only a bounded number of structured rows is inspected. Free-form text
        // and credentials in array cells are not promoted into moving labels.
        item.slice(0,3).forEach((row,index)=>{if(plain(row))visit(row,`${prefix} ${index+1}`.trim(),depth+1);});return;
      }
      for(const [key,child] of Object.entries(item).slice(0,40)) {
        if(result.length>=budget)break;
        if(secretKey.test(key)||['__proto__','prototype','constructor','text','content','stdout','stderr','output','preview','url','path','downloadUrl','previewUrl','sha256','message','error','instruction'].includes(key))continue;
        const label=prefix?`${prefix} · ${key}`:key;
        if(typeof child==='number'&&Number.isFinite(child)&&Math.abs(child)<1e15)add(label,child);
        else if(typeof child==='boolean'&&/^(?:written|created|deleted|remembered|truncated|timedOut|complete|success|pinned)$/i.test(key))add(label,child?'Yes':'No');
        else if(typeof child==='string'&&child.length<=100&&/^(?:status|name|title|format|mime|contentType|encoding|type|weather|condition|currency|unit|units|temp_?C|FeelsLikeC|windspeedKmph)$/i.test(key))add(label,child);
        else if(child&&typeof child==='object')visit(child,label,depth+1);
      }
    }
    visit(value);
    return result;
  }
  function csvRows(content,delimiter) {
    if(typeof content!=='string'||content.length>LIMITS.preview)return null;
    const rows=[];let row=[],cell='',quoted=false,closed=false;
    const pushCell=()=>{row.push(cell);cell='';closed=false;};
    const pushRow=()=>{pushCell();if(row.some(value=>value!==''))rows.push(row);row=[];};
    for(let index=0;index<content.length;index++) {
      const character=content[index];
      if(quoted){if(character==='"'){if(content[index+1]==='"'){cell+='"';index++;}else{quoted=false;closed=true;}}else cell+=character;}
      else if(character===delimiter)pushCell();
      else if(character==='\n'||character==='\r'){if(character==='\r'&&content[index+1]==='\n')index++;pushRow();}
      else if(character==='"'&&!cell&&!closed)quoted=true;
      else if(closed||character==='"')return null;
      else cell+=character;
      if(cell.length>300||row.length>20||rows.length>40)return null;
    }
    if(quoted)return null;
    if(cell||row.length||closed)pushRow();
    return rows.length&&rows.every(values=>values.length===rows[0].length)?rows:null;
  }
  function tableFacts(call,value,budget) {
    if(!plain(value)||!['workspace_read','documents_read'].includes(call.tool))return [];
    const observed=[];
    const add=(label,value_,detail)=>{if(observed.length<budget)observed.push({label:text(label,48),value:text(value_,100),detail:text(detail,180)});};
    function cells(rows,name,partial=false) {
      if(!Array.isArray(rows)||rows.length<2||!Array.isArray(rows[0]))return;
      const headers=rows[0].slice(0,20).map(value_=>text(value_,45));
      rows.slice(1,5).forEach((row,index)=>{
        if(!Array.isArray(row))return;
        row.slice(0,headers.length).forEach((cell,column)=>{
          const header=headers[column];if(!header||secretKey.test(header)||observed.length>=budget)return;
          const numeric=typeof cell==='number'&&Number.isFinite(cell)&&Math.abs(cell)<1e15;
          const numericText=typeof cell==='string'&&/^[-+]?(?:[$€£]\s*)?\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:EUR|USD|GBP|%))?$/.test(cell.trim())&&cell.length<=60;
          const named=typeof cell==='string'&&cell.length<=80&&/^(?:category|item|name|title|label|region|status|type|format)$/i.test(header);
          if(numeric||numericText||named)add(`${name} · ${header} ${index+1}`,cell,`${partial?'Visible retained':'Observed'} cell; no totals were calculated by the visualization`);
        });
      });
    }
    const sheets=plain(value.preview)&&Array.isArray(value.preview.sheets)?value.preview.sheets:[];
    sheets.slice(0,2).forEach(sheet=>{
      if(!plain(sheet))return;
      const name=text(sheet.name,30)||'Sheet';
      if(Number.isInteger(sheet.rowCount)&&sheet.rowCount>=0)add(`${name} rows`,sheet.rowCount,'Row count returned by documents_read');
      if(Number.isInteger(sheet.columnCount)&&sheet.columnCount>=0)add(`${name} columns`,sheet.columnCount,'Column count returned by documents_read');
      cells(sheet.rows,name,Boolean(value.truncated));
    });
    if(observed.length)return observed;
    const source=path(call.arguments.path||value.path),complete=!value.truncated&&!(Number(value.offset)>1)&&!(Number(value.column)>1);
    if(complete&&/\.(?:csv|tsv)$/i.test(source)) {
      const rows=csvRows(value.content,/\.tsv$/i.test(source)?'\t':',');
      if(rows?.length>1){add('CSV data rows',rows.length-1,'Nonempty data rows in the complete observed CSV');cells(rows,'CSV');}
    }else if(complete&&/\.json$/i.test(source)&&typeof value.content==='string') {
      const parsed=parsePreview(value.content);if(parsed.complete)return facts(parsed.value,budget).map(fact=>({...fact,detail:'Observed value from the complete retained JSON file'}));
    }
    return observed;
  }
  function toolKind(name,args={}) {
    if(/^delegate_task$/.test(name))return 'team';
    if(/^task_plan_/.test(name))return 'reasoning';
    if(/^(web_search|web_extract|http_fetch|browser_|brain_|memory_|skills_read|skills_file|skills_list)/.test(name)||name==='integration_call'&&/internet|page/.test(operation(name,args)))return 'research';
    return 'analysis';
  }
  function promptKind(prompt) {
    if(/\b(teammate|delegate|collaborat\w*|teamwork)\b/i.test(prompt))return 'team';
    if(/\b(budget|csv|data|calculate|analy[sz]\w*|code|file|document|spreadsheet)\b/i.test(prompt))return 'analysis';
    if(/\b(why|think|plan|decide|choose|options|strategy)\b/i.test(prompt))return 'reasoning';
    return 'research';
  }
  function operation(name,args={}) {
    const tool=name==='integration_call'?text(args?.tool,100):text(name,100);
    if(name==='web_search'||name==='integration_call'&&/search/i.test(tool))return 'Searching the internet';
    if(name==='http_fetch'||name==='web_extract'||/^browser_(text|snapshot)$/.test(name)||name==='integration_call'&&/read|fetch|browse|crawl/i.test(tool))return 'Reading a page';
    if(/^browser_/.test(name))return 'Browsing a page';
    if(/^workspace_(write|edit)$/.test(name))return 'Editing files';
    if(name==='workspace_delete')return 'Removing a file';
    if(name==='workspace_image')return 'Looking at an image';
    if(/^workspace_/.test(name))return 'Looking through files';
    if(name==='documents_create')return 'Creating a document';
    if(name==='documents_read')return 'Reading a document';
    if(/^(brain|memory)_(write|append|set)$/.test(name))return 'Updating notes';
    if(/^(brain|memory)_/.test(name))return 'Checking memory';
    if(/^task_plan_/.test(name))return 'Planning the task';
    if(/^task_outcome_/.test(name))return 'Checking the result';
    if(/^shell_|^terminal|^skills_run/.test(name))return 'Running a command';
    if(/^lsp_/.test(name))return 'Checking code';
    if(/^skills_/.test(name))return 'Reading a playbook';
    if(/^integration_/.test(name))return 'Using a connected service';
    if(/^routines_/.test(name))return 'Arranging a routine';
    return 'Working';
  }
  function resultState(call) {
    if(!call.completed)return {label:'In progress',failed:false,parsed:null,complete:false,detail:'The tool started; no completion has been recorded.'};
    const parsed=parsePreview(call.completed.preview),value=plain(parsed.value)?parsed.value:null;
    const failed=Boolean(call.completed.error||value?.error||value?.timedOut||['failed','cancelled','timed_out','output_limit','interrupted'].includes(value?.status)||(Number.isInteger(value?.exitCode)&&value.exitCode!==0)||(call.tool==='http_fetch'&&Number.isInteger(value?.status)&&value.status>=400));
    const label=failed?'Tool failed':(call.tool==='http_fetch'||call.tool==='web_extract')&&Number.isInteger(value?.status)?`HTTP ${value.status}`:parsed.complete?'Result received':parsed.reason;
    return {label,failed,parsed:parsed.value,complete:parsed.complete,detail:failed?text(typeof value?.error==='string'?value.error:'The tool returned an error.',180):parsed.complete?'Actual recorded tool result.':`${parsed.reason}. No structured result values were inferred.`};
  }
  function collectCalls(events) {
    const calls=[],byId=new Map();
    events.forEach((event,index)=>{
      const key=typeof event.toolCallId==='string'?event.toolCallId.slice(0,150):'';
      if(event.type==='tool.started') {
        const call={key:key||`event-${index}`,tool:text(event.tool,80)||'Tool',arguments:plain(event.arguments)?event.arguments:{},index,started:event,completed:null};calls.push(call);if(key)byId.set(key,call);
      } else if(event.type==='tool.completed') {
        const call=key?byId.get(key):null;
        if(call&&call.tool===event.tool)call.completed=event;
        else calls.push({key:key||`result-${index}`,tool:text(event.tool,80)||'Tool',arguments:{},index,started:null,completed:event});
      }
    });
    return calls;
  }
  function teammateCaption(name,mate) {
    const state=text(mate.status,40),tool=text(mate.tool,60);
    if(state==='waiting_for_approval')return `${name} needs your approval`;
    if(state==='waiting_for_delegate')return `${name} is asking a teammate`;
    if(state==='queued')return `${name} is getting ready`;
    if(mate.event==='tool.started'&&tool)return `${name}: ${operation(tool)}`;
    if(['model.started','model.completed','tool.completed','context.compacted','memory.recalled','run.started'].includes(mate.event))return `${name} is thinking`;
    return `${name} is working`;
  }
  function build(bot={},run={},options={}) {
    if(!plain(bot))bot={};if(!plain(run))run={};if(!plain(options))options={};
    const prompt=text(options.prompt,260),events=(Array.isArray(run.events)?run.events:[]).filter(event=>plain(event)&&event.type!=='model.delta').slice(-LIMITS.events);
    const calls=collectCalls(events),latestCall=calls.at(-1),last=events.findLast(event=>['tool.started','tool.completed','model.started','delegation.started','delegation.completed','plan.updated','memory.recalled'].includes(event.type));
    const latestDelegation=events.findLast(event=>event.type==='delegation.started'||event.type==='delegation.completed');
    let kind=latestCall?toolKind(latestCall.tool,latestCall.arguments):promptKind(prompt);
    if(run.status==='waiting_for_delegate'||latestDelegation&&events.indexOf(latestDelegation)>=(latestCall?.index??-1))kind='team';
    const status=text(run.status,50)||'running',botName=text(bot.name,48)||'Bot',nodes=[],edges=[],nodeIds=new Set();
    const seed=hash(`${text(bot.id,100)}|${text(run.id,100)}|${prompt}`);
    const add=(id,label,value,detail,x,y,kind_='transform',major=false)=>{
      if(nodes.length>=LIMITS.nodes||nodeIds.has(id))return null;
      const jitter=((hash(`${seed}|${id}`)%1000)/1000-.5)*.035;
      nodes.push({id,label:text(label,48),value:text(value,260),detail:text(detail,220),kind:kind_,x:Math.max(.05,Math.min(.95,x+jitter)),y:Math.max(.09,Math.min(.91,y+jitter)),major:Boolean(major)});nodeIds.add(id);return id;
    };
    const link=(from,to,label,detail='',bend=0,color=0)=>{
      if(!from||!to||!nodeIds.has(from)||!nodeIds.has(to)||edges.length>=LIMITS.edges)return;
      edges.push({id:`${from}:${to}`,from,to,text:text(label,64),detail:text(detail,220),weight:1,bend,color});
    };
    const input=add('input','Task',prompt||'Current task','User task context; not a tool result',.07,.5,'input');
    const core=add('core',botName,botName,'Current bot',.4,.5,'agent',true);
    link(input,core,'Task','The bot received this task',-.06,0);
    let caption=statusLabels[status]||'Thinking',context='',failed=false;
    const plan=plain(run.plan)&&Array.isArray(run.plan.steps)?run.plan.steps.filter(step=>plain(step)&&typeof step.title==='string').slice(0,12):[];
    const activeStep=plan.find(step=>step.status==='in_progress');
    if(activeStep&&!statusLabels[status])caption=`Working on step ${plan.indexOf(activeStep)+1} of ${plan.length}`;
    const peers=Array.isArray(options.peers)?options.peers:[];
    if(kind==='team'&&latestDelegation) {
      const target=latestDelegation.targetBotId||latestDelegation.botId,peer=peers.find(item=>plain(item)&&item.id===target),peerName=text(peer?.name,48)||'Teammate';
      const peerId=add('peer',peerName,peerName,'Actual recorded delegation target',.77,.5,'agent',true);
      const request=calls.findLast(call=>call.tool==='delegate_task'&&call.arguments.botId===target),task=text(request?.arguments.task,220);
      link(core,peerId,task?text(task,60):'Request sent',task||'A teammate handoff was recorded.',-.5,0);
      if(latestDelegation.type==='delegation.completed') {
        const delegateStatus=text(latestDelegation.status,40),complete=delegateStatus==='completed';
        const reply=text(latestDelegation.outputPreview,220),replyLabel=complete?'Reply received':delegateStatus==='cancelled'?'Teammate stopped':'Teammate failed';
        link(peerId,core,reply||replyLabel,`Recorded teammate status: ${delegateStatus||'unknown'}${reply?` · ${reply}`:''}`,-.5,2);
        context=complete?`${peerName}'s reply is available`:`${peerName}: ${delegateStatus||'unknown status'}`;
        failed=!complete;
        if(last?.type!=='model.started'&&!statusLabels[status])caption=complete?`Reading ${peerName}'s reply`:replyLabel;
      }else {
        context=task||'Waiting for the recorded teammate response';
        if(!statusLabels[status])caption=`Talking with ${peerName}`;
        // While this bot waits, the engine mirrors the teammate's own recorded progress.
        const mate=status==='waiting_for_delegate'&&plain(run.teammate)&&run.teammate.botId===target?run.teammate:null;
        if(mate) {
          caption=teammateCaption(peerName,mate);
          const steps=Number.isSafeInteger(mate.steps)&&mate.steps>0?`Step ${mate.steps}`:'';
          context=mate.status==='waiting_for_approval'?`Open ${peerName}'s chat to review the exact action.`:[steps,task].filter(Boolean).join(' · ')||context;
        }
      }
    } else if(kind==='reasoning'&&plan.length) {
      plan.forEach((step,index)=>{
        const id=add(`plan-${text(step.id,64)||index}`,`Step ${index+1}`,step.title,`Visible plan step · ${text(step.status,30)||'pending'}`,index%2?.83:.65,.14+index*.7/Math.max(1,plan.length-1),'transform',step.status==='in_progress');
        const stepStatus=text(step.status,30)||'pending',statusLabel=stepStatus==='completed'?'Done':stepStatus==='in_progress'?'In progress':'Pending',packet=`Step ${index+1} · ${statusLabel}`;
        link(core,id,packet,`Visible plan step · ${stepStatus}; plan metadata, not proof that an action succeeded`,(index%3-1)*.17,index%3);
      });
      context=`${plan.filter(step=>step.status==='completed').length} of ${plan.length} visible plan steps completed`;
    } else {
      const selected=calls.filter(call=>call.tool!=='delegate_task'&&!/^task_plan_/.test(call.tool)).slice(-LIMITS.calls);
      let factBudget=LIMITS.facts,completedCount=0;
      selected.forEach((call,index)=>{
        const key=hash(`${call.key}|${call.started?.id||call.started?.seq||call.completed?.id||call.completed?.seq||call.index}`).toString(36),target=safeTarget(call.arguments,call.tool),y=.2+index*.6/Math.max(1,selected.length-1);
        const action=operation(call.tool,call.arguments),web=/internet|page/.test(action),sourceLabel=web?(action==='Searching the internet'?'Search':'Page'):call.tool==='integration_call'?'Connected service':target===call.tool?'Input':targetLabel(target);
        const sourceId=add(`source-${key}`,sourceLabel,target||call.tool,call.started?`Requested input · ${call.tool}`:'Input unavailable in retained events',.16,y,'source',index===selected.length-1);
        const actionTag=action.split(' ')[0],toolId=add(`tool-${key}`,actionTag,call.tool,call.started?'Actual tool.started event':'Actual tool.completed event; input not retained',.43,y,'transform',index===selected.length-1);
        link(input,sourceId,sourceLabel,'Recorded tool input',(index-1.5)*.06,1);link(sourceId,toolId,actionTag,call.tool,(index%3-1)*.08,0);
        const outcome=resultState(call);
        if(call.completed){
          completedCount++;
          const outputId=add(`result-${key}`,outcome.label,outcome.label,outcome.detail,.68,y,'output',index===selected.length-1);
          link(toolId,outputId,outcome.label,outcome.detail,(index%3-1)*-.08,outcome.failed?0:2);
          if(!outcome.failed&&outcome.complete&&factBudget>0) {
            let value=outcome.parsed;
            // publicFetch returns an outer tool envelope. A complete JSON body
            // may provide fields, but an incomplete body is never repaired.
            if(call.tool==='http_fetch'&&plain(value)&&typeof value.text==='string') {
              const body=parsePreview(value.text);value=body.complete?body.value:value;
            }
            const limit=Math.min(6,factBudget),table=tableFacts(call,value,limit),observed=[...table,...facts(value,limit-table.length)].slice(0,limit);factBudget-=observed.length;
            observed.forEach((fact,factIndex)=>{
              const factY=.12+((index+(factIndex+.5)/observed.length)/selected.length)*.76;
              const factId=add(`fact-${key}-${factIndex}`,fact.label,fact.value,fact.detail,.9,factY,'fact',false);
              link(outputId,factId,`${fact.label}: ${fact.value}`,fact.detail,(factIndex-1.5)*.06,factIndex%3);
            });
          }
          if(index===selected.length-1){failed=outcome.failed;context=target?`${targetLabel(target)} · ${outcome.label}`:outcome.label;}
        }else if(index===selected.length-1)context=target||call.tool;
        if(index===selected.length-1&&!statusLabels[status]&&last?.type!=='model.started')caption=call.completed?(outcome.failed?'Action failed':'Reviewing results'):action;
      });
      if(kind==='analysis'&&completedCount>1&&nodes.length<LIMITS.nodes) {
        const summary=add('results','Results',`${completedCount} tool results received`,'Count of recorded completions; no values were synthesized',.91,.5,'output',true);
        nodes.filter(node=>node.id.startsWith('result-')).forEach(node=>link(node.id,summary,'Recorded result','This tool produced a recorded result',.04,2));
      }
      if(!selected.length&&plan.length)context=text(activeStep?.title,160)||'Visible task plan available';
    }
    if(status==='queued')context='The task is queued; no tool action is implied.';
    if(['remote','working_elsewhere','busy_elsewhere'].includes(status))context='Live work is taking place on another engine.';
    if(status==='waiting_for_approval')context='The engine is waiting for approval of the exact action.';
    if(status==='stopping')context='Cancellation has been requested. Available results remain visible.';
    if(run.partialOutput&&!statusLabels[status])caption='Writing the reply';
    if(status==='failed'||status==='interrupted')failed=true;
    if(!context&&activeStep)context=text(activeStep.title,160);
    const result={kind,nodes,edges,caption:text(caption,240),context:text(context,180),seed,status,failed,terminal:terminal.has(status)};
    result.signature=hash(JSON.stringify(result)).toString(36);
    return result;
  }
  window.StudioActivityModel=Object.freeze({build,describeTool:operation});
})();
