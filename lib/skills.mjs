import { promises as fs, constants as FS } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensure, HttpError, id, now } from './store.mjs';
import { bundledSkills, skillPackageManifest } from './skill-catalog.mjs';
import { parseSkillMetadata, parsePortableSkillPackage } from './skill-import.mjs';

const TERMINAL = new Set(['completed','failed','cancelled','interrupted','unknown']);
const active = run => Boolean(run && !TERMINAL.has(run.status));
const hash = value => createHash('sha256').update(value).digest('hex');
const safeId = value => typeof value==='string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const safeResource = value => typeof value==='string' && value.length<=240 && !/[\\\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && !/^[a-z]:/i.test(value) && value.split('/').every(part=>part && part!=='.' && part!=='..');
const aborted = signal => { if(signal?.aborted)throw signal.reason || Object.assign(new Error('Skill installation cancelled.'),{name:'AbortError'}); };
const DEFAULT_GROUPS=['workspace','memory','skills','web','integrations','delegation','automation','setup'];
const groupsFor = bot => Array.isArray(bot?.tools)?bot.tools:DEFAULT_GROUPS;
// Attribution describes newly written catalog adaptations; external imports cannot supply catalog trust.
const adaptationDetails = entry => entry?.attribution?{attribution:structuredClone(entry.attribution),capabilityNotes:[...(entry.capabilityNotes || [])]}:{};

const TOOL_GROUPS = Object.fromEntries([
  ['workspace',['workspace_structure','workspace_initialize','workspace_list','workspace_read','workspace_write','workspace_edit','workspace_delete','workspace_glob','workspace_search','documents_read','documents_create','scripts_list','scripts_inspect','scripts_register']],
  ['skills',['skills_list','skills_read','skills_file','skills_create','skills_run','skills_search','skills_inspect','skills_install']],
  ['memory',['memory_search','memory_set','memory_delete','brain_search','brain_read','brain_write','brain_append','brain_links']],
  ['web',['http_fetch','web_search']],['terminal',['terminal','execute_code','shell_run','shell_start','shell_read','shell_list','shell_stop','lsp_start','scripts_run']],
  ['integrations',['integration_list','integration_call']],['delegation',['delegate_task']],['automation',['routines_list','routines_create','routines_update','routines_delete']],['setup',['bots_list','bots_create','bots_update','skills_assign']],
  ['browser',['browser_open','browser_snapshot','browser_screenshot','browser_text','browser_click','browser_scroll','browser_back']]
].flatMap(([group,tools])=>tools.map(tool=>[tool,group])));

/** Engine-local diagnostics; metadata describes requirements and never grants access. */
export function skillCompatibility(store,skill,bot,{platform=process.platform}={}) {
  const metadata=skill.compatibilityMetadata || skill.metadata || {},reasons=[],unsupported=[];
  const platforms=metadata.platforms || [],aliases={macos:'darwin',mac:'darwin',osx:'darwin',linux:'linux',windows:'win32',win:'win32'};
  if(platforms.length && !platforms.some(item=>(aliases[String(item).toLowerCase()] || String(item).toLowerCase())===platform))unsupported.push(`Requires ${platforms.join(' or ')}; this Engine runs ${platform}.`);
  const unsupportedLabels={'hermes-runtime':'Requires the Hermes runtime; adapt the workflow to Tupies tools.','inline-shell-expansion':'Inline shell expansion is not supported and will not be executed.','automatic-setup':'Automatic setup or hooks require an explicit adaptation.','yaml-aliases-or-tags':'YAML aliases and tags are not evaluated; review the metadata.'};
  for(const item of metadata.unsupportedFeatures || [])unsupported.push(unsupportedLabels[item] || String(item).slice(0,300));
  for(const diagnostic of metadata.diagnostics || [])reasons.push(`Metadata review: ${String(diagnostic).slice(0,300)}`);
  if(bot) {
    const groups=groupsFor(bot),required=[...new Set(['skills',...(skill.requiredGroups || []),...(metadata.requiresToolsets || [])])];
    for(const group of required)if(!DEFAULT_GROUPS.includes(group) && !['terminal','browser'].includes(group))reasons.push(`Requires the ${group} toolset; review its Tupies equivalent.`);else if(!groups.includes(group))reasons.push(`Enable the ${group} tools for this bot.`);
    for(const tool of metadata.requiresTools || []) {
      const group=TOOL_GROUPS[tool];
      if(!group)reasons.push(`Requires the foreign tool ${tool}; review its Tupies equivalent.`);
      else if(!groups.includes(group))reasons.push(`Enable the ${group} tools required by ${tool}.`);
    }
  }
  if((metadata.requiresToolsets || []).includes('browser') || (metadata.requiresTools || []).some(tool=>TOOL_GROUPS[tool]==='browser'))reasons.push('Requires browser support on this Engine; browser availability must be checked before use.');
  for(const bin of metadata.requiresBins || [])reasons.push(`Requires ${bin} on this Engine; its availability has not been verified.`);
  for(const env of metadata.requiresEnv || [])reasons.push(`Requires ${env}; configure its connection on this Engine without adding secrets to the skill.`);
  for(const config of metadata.requiresConfig || [])reasons.push(`Requires the ${config} setting; review its configuration for this Engine.`);
  if(metadata.compatibility)reasons.push(`Publisher requirement: ${String(metadata.compatibility).slice(0,500)}`);
  if((skill.files || []).some(file=>/\.(?:py|sh|mjs|cjs|js)$/i.test(typeof file==='string'?file:file.path)) && !skill.trustedCatalog)reasons.push('Contains code. Review scripts and dependencies; every execution still requires exact approval.');
  const all=[...new Set([...unsupported,...reasons])];
  return {status:unsupported.length?'unsupported':reasons.length?'needs_setup':'ready',reasons:all,platform};
}

async function regularDirectory(directory) {
  const stat=await fs.lstat(directory);
  ensure(stat.isDirectory() && !stat.isSymbolicLink(),409,'Skill storage must be a real directory.');
}

async function packageFile(root,relative,maxBytes) {
  ensure(safeResource(relative),409,'Skill manifest contains an unsafe file path.');
  let current=root;await regularDirectory(current);
  const parts=relative.split('/');
  for(const part of parts.slice(0,-1)){current=path.join(current,part);await regularDirectory(current);}
  const handle=await fs.open(path.join(root,...parts),FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0));
  try {
    const stat=await handle.stat();ensure(stat.isFile() && stat.size<=maxBytes,409,'Skill resource is not a bounded regular file.');
    const chunks=[];let total=0;
    while(total<=maxBytes) {
      const buffer=Buffer.allocUnsafe(Math.min(65536,maxBytes+1-total)),{bytesRead}=await handle.read(buffer,0,buffer.length,null);
      if(!bytesRead)break;total+=bytesRead;ensure(total<=maxBytes,409,'Skill resource changed beyond its package limit.');chunks.push(buffer.subarray(0,bytesRead));
    }
    return Buffer.concat(chunks,total);
  } finally {await handle.close();}
}

/** A synced package stays unavailable until every listed byte matches its activation manifest.
 * Returned bytes can be used directly for the read, avoiding a second open after verification.
 */
export async function assertSkillIntegrity(store,skill) {
  if(!skill.packageDigest)return {verified:false,files:null};
  ensure(safeId(skill.id) && /^[a-f0-9]{64}$/.test(skill.packageDigest),409,'Skill package identity is invalid.');
  const hashes=skill.fileHashes,sizes=skill.fileSizes,paths=Object.keys(hashes || {});
  ensure(paths.length>=1 && paths.length<=100 && paths.includes('SKILL.md') && sizes && paths.every(file=>safeResource(file) && /^[a-f0-9]{64}$/.test(hashes[file]) && Number.isSafeInteger(sizes[file]) && sizes[file]>=0 && sizes[file]<=5_000_000),409,'Skill package manifest is invalid.');
  ensure(Array.isArray(skill.files) && skill.files.length===paths.length && skill.files.every(file=>Object.hasOwn(hashes,file)),409,'Skill package file list does not match its manifest.');
  const root=path.join(store.directory,'skills',skill.id),files=new Map();let total=0;
  try {
    await regularDirectory(path.join(store.directory,'skills'));
    for(const relative of paths) {
      total+=sizes[relative];ensure(total<=5_000_000,409,'Skill package exceeds its byte limit.');
      const data=await packageFile(root,relative,sizes[relative]);
      ensure(data.length===sizes[relative] && hash(data)===hashes[relative],409,'Skill package is incomplete or changed. Wait for sync, or reinstall the exact version.');
      files.set(relative,data);
    }
  } catch(error) {
    if(error instanceof HttpError)throw error;
    throw new HttpError(409,'Skill package is not available on this Engine yet. Wait for sync, or reinstall the exact version.');
  }
  ensure(skillPackageManifest([...files].map(([file,data])=>({path:file,data}))).digest===skill.packageDigest,409,'Skill package manifest does not match its digest.');
  return {verified:true,digest:skill.packageDigest,files};
}

function preparedPackage(prepared) {
  ensure(prepared?.package && Array.isArray(prepared.package.files),400,'Choose one inspected skill package.');
  // Revalidate bytes rather than trusting caller-supplied parsed identity or resource paths.
  const parsed=parsePortableSkillPackage({files:prepared.package.files.map(file=>({path:file.path,contentBase64:Buffer.from(file.data).toString('base64')}))});
  const metadata=parseSkillMetadata(parsed.content);
  // Import preview may discover missing linked resources or incomplete transport metadata.
  // Retain only bounded additional restrictions; prepared data cannot erase parsed requirements.
  for(const key of ['platforms','requiresTools','requiresToolsets','requiresBins','requiresEnv','requiresConfig','unsupportedFeatures','diagnostics'])metadata[key]=[...new Set([...(metadata[key] || []),...(Array.isArray(prepared.metadata?.[key])?prepared.metadata[key].filter(value=>typeof value==='string').map(value=>value.slice(0,300)):[])])].slice(0,50);
  return {...parsed,metadata};
}

export class SkillsService {
  constructor(store,options={}) {this.store=store;this.options=options;this.catalog=bundledSkills();}
  bot(botId) {
    if(botId===undefined || botId==='')return null;
    ensure(typeof botId==='string',400,'Choose an existing bot.');
    const bot=this.store.state.bots.find(item=>item.id===botId);ensure(bot,404,'Bot not found.');return bot;
  }
  entry(args,{exact=false}={}) {
    ensure(args && typeof args==='object' && typeof args.catalogId==='string',400,'Choose a catalog skill.');
    const entry=this.catalog.find(item=>item.catalogId===args.catalogId);ensure(entry,404,'Catalog skill not found.');
    if(exact || args.version!==undefined)ensure(args.version===entry.version,409,'This catalog version changed. Inspect the skill again.');
    if(exact || args.digest!==undefined)ensure(args.digest===entry.digest,409,'This catalog package changed. Inspect the skill again.');
    return entry;
  }
  summary(entry,bot) {
    const installed=this.store.state.skills.find(skill=>skill.catalogId===entry.catalogId && skill.packageDigest===entry.digest);
    return {catalogId:entry.catalogId,name:entry.name,title:entry.title,description:entry.description,category:entry.category,author:entry.author,source:entry.source,version:entry.version,digest:entry.digest,license:entry.license,examples:[...entry.examples],...adaptationDetails(entry),compatibility:skillCompatibility(this.store,{...entry,files:entry.files.map(file=>file.path),trustedCatalog:true},bot),installedSkillId:installed?.id || null,assigned:Boolean(installed && bot?.skills?.includes(installed.id)),trusted:true};
  }
  async search({query='',category='',botId}={}) {
    ensure(typeof query==='string' && query.length<=300 && typeof category==='string' && category.length<=60,400,'Use a short skill search and category.');
    const bot=this.bot(botId),terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const entries=this.catalog.filter(entry=>(!category || entry.category===category) && terms.every(term=>[entry.name,entry.title,entry.description,entry.category,entry.attribution?.author || '',entry.attribution?.title || '',...entry.examples].join(' ').toLowerCase().includes(term)));
    return {skills:entries.map(entry=>this.summary(entry,bot)),categories:[...new Set(this.catalog.map(entry=>entry.category))].sort(),source:'tupies',offline:true};
  }
  async inspect(args={}) {
    const entry=this.entry(args),bot=this.bot(args.botId);
    return {...this.summary(entry,bot),content:entry.content,files:entry.files.map(file=>file.path),size:entry.files.reduce((sum,file)=>sum+file.data.length,0)};
  }
  canAutoInstall(bot,args) {
    try {
      const current=this.bot(bot?.id),entry=this.entry(args,{exact:true});
      return bot?.skillInstallPolicy==='trusted' && current?.skillInstallPolicy==='trusted' && bot?.approvalPolicy!=='strict' && current?.approvalPolicy!=='strict' && skillCompatibility(this.store,{...entry,trustedCatalog:true},bot).status==='ready' && skillCompatibility(this.store,{...entry,trustedCatalog:true},current).status==='ready';
    } catch {return false;}
  }
  async installed({botId}={}) {
    const bot=this.bot(botId),skills=[];
    for(const skill of this.store.state.skills) {
      let availability={ready:true},metadata=skill.compatibilityMetadata;
      try {
        if(skill.packageDigest)await assertSkillIntegrity(this.store,skill);
        else {
          ensure(safeId(skill.id),409,'Skill identity is invalid.');await regularDirectory(path.join(this.store.directory,'skills'));
          const content=await packageFile(path.join(this.store.directory,'skills',skill.id),'SKILL.md',250_000);
          metadata=parseSkillMetadata(new TextDecoder('utf-8',{fatal:true}).decode(content));
        }
      } catch(error){availability={ready:false,reason:error instanceof HttpError?error.message:'This skill is not available on this Engine yet.'};}
      const compatibility=skillCompatibility(this.store,{...skill,compatibilityMetadata:metadata},bot);
      skills.push({...skill,compatibility:availability.ready?compatibility:{...compatibility,status:'needs_setup',reasons:[availability.reason,...compatibility.reasons]},available:availability.ready,assigned:Boolean(bot?.skills?.includes(skill.id)),assignedTo:this.store.state.bots.filter(item=>item.skills?.includes(skill.id)).map(item=>item.id)});
    }
    return {skills,platform:process.platform};
  }
  inspectPrepared(prepared,{botId}={}) {
    const parsed=preparedPackage(prepared),manifest=skillPackageManifest(parsed.files),bot=this.bot(botId);
    return {...parsed.skill,digest:manifest.digest,content:parsed.content,files:parsed.files.map(file=>file.path),metadata:parsed.metadata,provenance:prepared.provenance || {source:'local'},compatibility:skillCompatibility(this.store,{...parsed.skill,compatibilityMetadata:parsed.metadata},bot)};
  }
  async install(args,options={}) {
    const entry=this.entry(args,{exact:true});
    const prepared={package:{files:entry.files},provenance:{source:'tupies',catalogId:entry.catalogId,version:entry.version,digest:entry.digest},metadata:{}};
    return this.installPrepared(prepared,{...options,botId:args.botId,catalogEntry:entry});
  }
  async assign({skillId,botId,enabled=true}={}, {signal}={}) {
    ensure(safeId(skillId) && typeof enabled==='boolean',400,'Choose a valid skill and assignment.');
    return this.store.mutate(async state=>{
      const allowed=()=>{
        aborted(signal);this.options.assertAdmission?.();
        const bot=state.bots.find(item=>item.id===botId),skill=state.skills.find(item=>item.id===skillId);
        ensure(bot && skill,404,'Bot or skill not found.');
        ensure(!this.options.busyElsewhere?.(botId) && !active(state.runs[botId]) && !this.options.isBusy?.(botId),409,'This bot is working. Wait for it to finish before changing skills.');
        return {bot,skill};
      };
      let {bot,skill}=allowed();
      if(enabled)await assertSkillIntegrity(this.store,skill);
      ({bot,skill}=allowed());
      const replacedSkillIds=enabled && skill.catalogId?(bot.skills || []).filter(item=>item!==skillId && state.skills.some(other=>other.id===item && other.catalogId===skill.catalogId)):[];
      const retained=(bot.skills || []).filter(item=>item!==skillId && !replacedSkillIds.includes(item));
      if(enabled)ensure(retained.length<30,400,'This bot already has 30 assigned skills. Remove one before adding another.');
      bot.skills=enabled?[...retained,skillId]:retained;
      this.store.audit('skill.assigned',`${bot.name} ${enabled?'enabled':'disabled'} ${skill.title || skill.name}`,botId,{skillId,enabled});
      return {skill,assignedTo:botId,assigned:enabled,replacedSkillIds,compatibility:skillCompatibility(this.store,skill,bot)};
    });
  }
  async installPrepared(prepared,{botId,signal,actor='owner',runId,approved=false,catalogEntry}={}) {
    ensure(actor==='owner' || actor==='bot',403,'Unknown skill installation actor.');
    if(actor==='bot')ensure(catalogEntry && this.catalog.includes(catalogEntry),403,'Bots can install only an exact inspected catalog package.');
    aborted(signal);this.options.assertAdmission?.();
    const parsed=preparedPackage(prepared),manifest=skillPackageManifest(parsed.files);
    if(catalogEntry)ensure(manifest.digest===catalogEntry.digest,409,'Catalog package failed its digest check.');
    const source=prepared.provenance || {},sourceKey=catalogEntry?`catalog:${catalogEntry.catalogId}`:JSON.stringify([source.kind || source.source || 'local',source.repository || '',source.url || '',source.skillPath || '',source.archiveSha256 || '']);
    const internalId=`tp-${parsed.skill.id.slice(0,34).replace(/-+$/,'')}-${hash(sourceKey).slice(0,8)}-${manifest.digest.slice(0,12)}`;
    ensure(safeId(internalId),400,'Skill package could not be assigned a safe identity.');
    const skillsRoot=path.join(this.store.directory,'skills'),target=path.join(skillsRoot,internalId),staging=path.join(skillsRoot,`.import-${id('stage')}`);
    let created=false,staged=false;
    const metadata={...parsed.skill,id:internalId,source:catalogEntry?'catalog':'imported',title:catalogEntry?.title || parsed.skill.name,immutable:true,packageDigest:manifest.digest,fileHashes:manifest.fileHashes,fileSizes:manifest.fileSizes,compatibilityMetadata:parsed.metadata,provenance:catalogEntry?{source:'tupies',catalogId:catalogEntry.catalogId,version:catalogEntry.version,digest:manifest.digest}:{...prepared.provenance,digest:manifest.digest},...(catalogEntry?{catalogId:catalogEntry.catalogId,catalogSource:'tupies',catalogVersion:catalogEntry.version,trustedCatalog:true,requiredGroups:[...catalogEntry.requiredGroups],license:catalogEntry.license,...adaptationDetails(catalogEntry)}:{}),createdAt:now()};
    try {
      return await this.store.mutate(async state=>{
        const assertAllowed=()=>{
          aborted(signal);this.options.assertAdmission?.();
          const bot=state.bots.find(item=>item.id===botId);ensure(bot,404,'Choose an existing bot.');
          ensure(!this.options.busyElsewhere?.(botId),409,'This bot is working on another Engine. Wait for it to finish.');
          if(actor==='owner')ensure(!active(state.runs[botId]) && !this.options.isBusy?.(botId),409,'This bot is working. Wait for it to finish before installing a skill.');
          else {
            const run=state.runs[botId];ensure(runId && run?.id===runId && active(run) && run.status!=='stopping',409,'This installation belongs to an older or stopped task.');
            ensure(approved || this.canAutoInstall(bot,{catalogId:catalogEntry.catalogId,version:catalogEntry.version,digest:manifest.digest}),403,'This skill installation requires exact approval.');
          }
          return bot;
        };
        let bot=assertAllowed();
        await regularDirectory(skillsRoot);
        const existing=state.skills.find(skill=>skill.id===internalId);
        if(existing) {
          ensure(existing.packageDigest===manifest.digest && (!catalogEntry || existing.catalogId===catalogEntry.catalogId),409,'A different package already uses this skill identity.');
          await assertSkillIntegrity(this.store,existing);
        } else {
          ensure(state.skills.length<200,400,'This workspace supports up to 200 skills.');
          // Never replace an unregistered directory, including one left by an interrupted install.
          ensure(!await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),409,'This skill directory already exists and will not be overwritten.');
        }
        const replacedSkillIds=catalogEntry?(bot.skills || []).filter(skillId=>skillId!==internalId && state.skills.some(skill=>skill.id===skillId && skill.catalogId===catalogEntry.catalogId)):[];
        const retainedAssignments=(bot.skills || []).filter(skillId=>!replacedSkillIds.includes(skillId));
        const assigning=!retainedAssignments.includes(internalId);
        if(assigning)ensure(retainedAssignments.length<30,400,'This bot already has 30 assigned skills. Remove one before adding another.');
        if(actor==='bot' && assigning)ensure((state.runs[botId].skillInstallCount || 0)<3,400,'This task has reached its limit of three skill installations.');
        if(!existing) {
          await fs.mkdir(staging,{mode:0o700});staged=true;
          for(const file of parsed.files) {
            aborted(signal);const destination=path.join(staging,...file.path.split('/'));
            await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});await fs.writeFile(destination,file.data,{mode:0o600,flag:'wx'});
          }
          bot=assertAllowed();
          await fs.rename(staging,target);created=true;staged=false;
          // A stopped task cannot turn a completed download into a committed assignment.
          bot=assertAllowed();state.skills.push(metadata);
        } else bot=assertAllowed();
        bot.skills=[...new Set([...retainedAssignments,internalId])];
        if(actor==='bot' && assigning)state.runs[botId].skillInstallCount=(state.runs[botId].skillInstallCount || 0)+1;
        if(!existing || assigning)this.store.audit('skill.installed',`${bot.name} added ${metadata.title}`,botId,{skillId:internalId,packageDigest:manifest.digest,...(catalogEntry?{catalogId:catalogEntry.catalogId,version:catalogEntry.version}:{}),...(runId?{runId}:{})});
        return {skill:existing || metadata,assignedTo:botId,compatibility:skillCompatibility(this.store,existing || metadata,bot),alreadyInstalled:Boolean(existing),alreadyAssigned:!assigning,replacedSkillIds};
      });
    } catch(error) {
      if(created)await fs.rm(target,{recursive:true,force:true}).catch(()=>{});
      throw error;
    } finally {if(staged)await fs.rm(staging,{recursive:true,force:true}).catch(()=>{});}
  }
}
