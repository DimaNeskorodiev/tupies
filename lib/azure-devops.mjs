import { HttpError, ensure, string } from './store.mjs';
import { serviceRequest } from './provider-net.mjs';

const API_VERSION='7.1', MAX_ITEMS=100, MAX_BYTES=2_000_000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FIELDS=['System.Id','System.TeamProject','System.Title','System.State','System.WorkItemType','System.AssignedTo','System.Description','System.ChangedDate','Microsoft.VSTS.Common.AcceptanceCriteria'];
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const bounded=(value,max)=>typeof value==='string'?value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,max):'';
function positiveId(value,label='Work item ID') {
  ensure(typeof value==='number' || typeof value==='string' && /^[1-9][0-9]{0,9}$/.test(value),400,`${label} must be a positive integer.`);
  const result=Number(value);ensure(Number.isInteger(result) && result>0 && result<=2_147_483_647,400,`${label} must be a positive integer.`);return result;
}
function repositoryId(value){ensure(typeof value==='string' && UUID.test(value),400,'Repository ID must be an Azure repository UUID.');return value.toLowerCase();}
function projectName(value){const result=string(value,'Azure project',200);ensure(!/[\x00-\x1f\x7f/\\%?#]/.test(result) && !['.','..'].includes(result),400,'Azure project must be a name or ID, not a URL or path.');return result;}
function branch(value){
  const input=string(value,'Branch',240),result=input.startsWith('refs/heads/')?input:`refs/heads/${input}`;
  ensure(!input.startsWith('refs/') || input.startsWith('refs/heads/'),400,'Choose a branch under refs/heads.');
  ensure(!/[\x00-\x20\x7f~^:?*\[\\]/.test(result) && !result.includes('..') && !result.includes('@{') && result.split('/').every(part=>part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')),400,'Choose a valid Git branch name.');return result;
}
function protocolError(message){return new HttpError(502,`Azure DevOps ${message}`);}
function unknownWrite(){const error=protocolError('pull request outcome is unknown. Inspect the repository before trying again; the request was not replayed.');error.code='azure_write_outcome_unknown';error.outcome='unknown';return error;}

/** Fixed Azure DevOps Services adapter. Remote text remains untrusted data, never HTML to execute.
 * Credentials are supplied by the engine's sealed local configuration, never by model arguments.
 * WIQL is a fixed read query: @Me is resolved by Azure for the authenticated credential.
 */
export class AzureDevOps {
  #organization; #project; #base; #token; #request;
  constructor({organization,project,token,request=serviceRequest}={}) {
    this.#organization=string(organization,'Azure organization',50);
    ensure(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(this.#organization),400,'Azure organization must be its name, not a URL or path.');
    this.#project=projectName(project);this.#token=string(token,'Azure personal access token',8192);
    ensure(!/[\x00-\x20\x7f]/.test(this.#token),400,'Azure personal access token cannot contain whitespace or control characters.');
    ensure(typeof request==='function',400,'Azure request transport is unavailable.');this.#request=request;
    this.#base=`https://dev.azure.com/${this.#organization}/${encodeURIComponent(this.#project)}`;
  }
  async #call(path,{method='GET',body,signal,write=false,query={}}={}) {
    if(signal?.aborted)throw new HttpError(499,'Azure DevOps request cancelled before dispatch.');
    const params=new URLSearchParams({'api-version':API_VERSION,...query});
    let response;
    try {
      response=await this.#request(`${this.#base}/_apis/${path}?${params}`,{method,headers:{Accept:'application/json','User-Agent':'Tupies/0.5.0',Authorization:`Basic ${Buffer.from(`:${this.#token}`).toString('base64')}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body,signal,timeoutMs:30_000,maxBytes:MAX_BYTES,allowPrivateHttp:false,responseType:'json'});
    } catch {
      if(write)throw unknownWrite();
      throw new HttpError(signal?.aborted?499:502,signal?.aborted?'Azure DevOps request cancelled.':'Azure DevOps could not be reached or returned an invalid response. Check the connection; no request was replayed.');
    }
    if(!Number.isInteger(response?.status) || response.status<200 || response.status>=300) {
      const status=response?.status;
      if(write && (!Number.isInteger(status) || status>=500 || status>=300 && status<400 || status===408))throw unknownWrite();
      const error=new HttpError(status===401 || status===403?401:status===404?404:502,`Azure DevOps refused the request${Number.isInteger(status)?` (HTTP ${status})`:''}. Check the connection, scope and permissions.`);
      if(write)error.outcome='rejected';throw error;
    }
    // Also enforce bounds and shape when an injected test/embedding transport is used.
    let bytes;try{bytes=Buffer.byteLength(JSON.stringify(response.data));}catch{throw write?unknownWrite():protocolError('returned invalid JSON.');}
    if(!object(response.data) || bytes>MAX_BYTES)throw write?unknownWrite():protocolError('returned an invalid or oversized response.');
    return response.data;
  }
  #url(path){return `${this.#base}/${path}`;}
  #safeLink(value) {
    if(typeof value!=='string' || value.length>2000)return '';
    try{const url=new URL(value);if(url.origin!=='https://dev.azure.com' || url.username || url.password || url.hash || !url.pathname.toLowerCase().startsWith(`/${this.#organization.toLowerCase()}/`))return '';return url.href;}catch{return '';}
  }
  async #assignedQuery(id,signal) {
    const data=await this.#call('wit/wiql',{method:'POST',signal,query:{$top:String(id?1:MAX_ITEMS+1)},body:{query:`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @Project AND [System.AssignedTo] = @Me${id?` AND [System.Id] = ${id}`:''} ORDER BY [System.ChangedDate] DESC`}});
    ensure(data.queryType==='flat' && Array.isArray(data.workItems) && data.workItems.length<=(id?1:MAX_ITEMS+1),502,'Azure DevOps returned an invalid assigned-work query.');
    ensure(typeof data.asOf==='string' && data.asOf.length<=40 && Number.isFinite(Date.parse(data.asOf)),502,'Azure DevOps did not provide a valid assignment snapshot time.');
    const ids=data.workItems.map(item=>{try{return positiveId(item?.id);}catch{throw protocolError('returned an invalid work item ID.');}});
    ensure(new Set(ids).size===ids.length && (!id || ids.every(value=>value===id)),502,'Azure DevOps returned unmatched or duplicate work items.');
    return {ids:ids.slice(0,MAX_ITEMS),asOf:data.asOf,truncated:ids.length>MAX_ITEMS};
  }
  #item(value,asOf) {
    ensure(object(value) && object(value.fields) && Number.isInteger(value.rev) && value.rev>0,502,'Azure DevOps returned an invalid work item.');
    const fields=value.fields,id=positiveId(value.id),assigned=fields['System.AssignedTo'];
    ensure(object(assigned) && typeof assigned.id==='string' && UUID.test(assigned.id),502,'Azure DevOps returned a work item without a verifiable assignee.');
    ensure(typeof fields['System.TeamProject']==='string' && (UUID.test(this.#project) || fields['System.TeamProject'].toLowerCase()===this.#project.toLowerCase()),502,'Azure DevOps returned a work item from another project.');
    ensure(typeof fields['System.Title']==='string' && typeof fields['System.State']==='string',502,'Azure DevOps returned incomplete work item fields.');
    const links=[];for(const [name,link] of Object.entries(object(value._links)?value._links:{}).slice(0,20)){const url=this.#safeLink(link?.href);if(url)links.push({name:bounded(name,100),url});}
    return {id,rev:value.rev,title:bounded(fields['System.Title'],500),description:bounded(fields['System.Description'],20_000),acceptanceCriteria:bounded(fields['Microsoft.VSTS.Common.AcceptanceCriteria'],20_000),state:bounded(fields['System.State'],100),type:bounded(fields['System.WorkItemType'],100),project:bounded(fields['System.TeamProject'],200),assignedTo:{id:assigned.id.toLowerCase(),displayName:bounded(assigned.displayName,200)},assignedToMe:true,asOf,changedAt:bounded(fields['System.ChangedDate'],40),url:this.#url(`_workitems/edit/${id}`),links,contentTruncated:['System.Description','Microsoft.VSTS.Common.AcceptanceCriteria'].some(key=>typeof fields[key]==='string' && fields[key].length>20_000)};
  }
  async #items(ids,asOf,signal) {
    if(!ids.length)return [];
    const data=await this.#call('wit/workitemsbatch',{method:'POST',signal,body:{ids,asOf,fields:FIELDS,errorPolicy:'Fail'}});
    ensure(Array.isArray(data.value) && data.value.length===ids.length,502,'Azure DevOps returned an incomplete work item batch.');
    const items=data.value.map(value=>this.#item(value,asOf)),byId=new Map(items.map(item=>[item.id,item]));
    ensure(byId.size===ids.length && ids.every(id=>byId.has(id)),502,'Azure DevOps returned unmatched work items.');return ids.map(id=>byId.get(id));
  }
  async assignedWorkItems({signal}={}) {const query=await this.#assignedQuery(undefined,signal);return {items:await this.#items(query.ids,query.asOf,signal),asOf:query.asOf,truncated:query.truncated};}
  async workItem(value,{signal}={}) {const id=positiveId(value),query=await this.#assignedQuery(id,signal);ensure(query.ids.length===1,403,'This work item is not assigned to the connected Azure DevOps account in this project.');return (await this.#items(query.ids,query.asOf,signal))[0];}
  async repository(value,{signal}={}) {
    const id=repositoryId(value),data=await this.#call(`git/repositories/${id}`,{signal});
    ensure(typeof data.id==='string' && data.id.toLowerCase()===id && object(data.project) && (String(data.project.id).toLowerCase()===this.#project.toLowerCase() || String(data.project.name).toLowerCase()===this.#project.toLowerCase()),502,'Azure DevOps returned an unmatched repository or project.');
    // Derive the clone destination from the verified IDs; do not forward server-supplied userinfo.
    return {id,name:bounded(data.name,200),project:{id:bounded(data.project.id,100),name:bounded(data.project.name,200)},defaultBranch:bounded(data.defaultBranch,250),url:this.#url(`_git/${id}`),remoteUrl:this.#url(`_git/${id}`)};
  }
  async resolveRepository(value,{signal}={}) {
    const name=projectName(value);
    if(UUID.test(name))return this.repository(name,{signal});
    const data=await this.#call(`git/repositories/${encodeURIComponent(name)}`,{signal});
    ensure(typeof data.id==='string' && UUID.test(data.id) && typeof data.name==='string' && data.name.toLowerCase()===name.toLowerCase() && object(data.project) && (String(data.project.id).toLowerCase()===this.#project.toLowerCase() || String(data.project.name).toLowerCase()===this.#project.toLowerCase()),502,'Azure DevOps returned an unmatched repository or project.');
    const id=data.id.toLowerCase();return {id,name:bounded(data.name,200),project:{id:bounded(data.project.id,100),name:bounded(data.project.name,200)},defaultBranch:bounded(data.defaultBranch,250),url:this.#url(`_git/${id}`),remoteUrl:this.#url(`_git/${id}`)};
  }
  #pullRequest(data,repository) {
    ensure(object(data) && typeof data.repository?.id==='string' && data.repository.id.toLowerCase()===repository,502,'Azure DevOps returned a pull request for another repository.');
    const id=positiveId(data.pullRequestId,'Pull request ID');
    ensure(typeof data.sourceRefName==='string' && typeof data.targetRefName==='string' && ['active','completed','abandoned'].includes(data.status),502,'Azure DevOps returned an incomplete pull request.');
    return {id,pullRequestId:id,repositoryId:repository,title:bounded(data.title,500),description:bounded(data.description,20_000),sourceBranch:bounded(data.sourceRefName,250),targetBranch:bounded(data.targetRefName,250),status:data.status,isDraft:data.isDraft===true,mergeStatus:bounded(data.mergeStatus,100),url:this.#url(`_git/${repository}/pullrequest/${id}`)};
  }
  async inspectPullRequest({repositoryId:repository,pullRequestId},{signal}={}) {
    const repo=repositoryId(repository),id=positiveId(pullRequestId,'Pull request ID'),base=`git/repositories/${repo}/pullrequests/${id}`;
    const data=this.#pullRequest(await this.#call(base,{signal}),repo);ensure(data.id===id,502,'Azure DevOps returned an unmatched pull request.');
    const linked=await this.#call(`${base}/workitems`,{signal});ensure(Array.isArray(linked.value) && linked.value.length<=200,502,'Azure DevOps returned an invalid pull request work item list.');
    return {...data,workItemIds:linked.value.map(value=>positiveId(value?.id))};
  }
  async pullRequest(input,{signal,approved=false}={}) {
    ensure(approved===true,403,'Creating an Azure pull request requires exact approval.');
    ensure(object(input) && Object.keys(input).every(key=>['repositoryId','sourceBranch','targetBranch','title','description','workItemId'].includes(key)),400,'Use the supported pull request fields.');
    const repo=repositoryId(input.repositoryId),source=branch(input.sourceBranch),target=branch(input.targetBranch),workItemId=positiveId(input.workItemId),title=string(input.title,'Pull request title',300),description=string(input.description ?? '','Pull request description',20_000,false);
    ensure(source!==target,400,'Pull request source and target branches must differ.');
    ensure(!/[\x00-\x1f\x7f]/.test(title) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description),400,'Pull request text contains unsupported control characters.');
    // Reads are safe to repeat; this sole external mutation is dispatched exactly once.
    await this.workItem(workItemId,{signal});await this.repository(repo,{signal});
    const data=await this.#call(`git/repositories/${repo}/pullrequests`,{method:'POST',signal,write:true,body:{sourceRefName:source,targetRefName:target,title,description,isDraft:true,workItemRefs:[{id:String(workItemId)}]}});
    let created;try{created=this.#pullRequest(data,repo);ensure(created.sourceBranch===source && created.targetBranch===target && created.isDraft && created.status==='active',502,'Unmatched created pull request.');}catch{throw unknownWrite();}
    // A failed read-back does not erase the verified created ID and must never trigger another POST.
    try{const verified=await this.inspectPullRequest({repositoryId:repo,pullRequestId:created.id},{signal});return {...verified,outcome:'created',workItemLinked:verified.workItemIds.includes(workItemId),verified:true};}
    catch{return {...created,outcome:'created',workItemLinked:false,verified:false,verificationError:'The pull request was created, but its current state and work item link could not be verified. Inspect it before further action.'};}
  }
}
