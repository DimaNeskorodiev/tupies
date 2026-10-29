import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const now = () => new Date().toISOString();
export const id = prefix => `${prefix}_${randomBytes(9).toString('hex')}`;
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const ensure = (condition, status, message) => { if (!condition) throw new HttpError(status, message); };
export function string(value, label, max = 1000, required = true) {
  ensure(typeof value === 'string', 400, `${label} must be text.`);
  const result = value.trim();
  ensure((!required || result.length > 0) && result.length <= max, 400, `${label} must contain ${required ? '1' : '0'}–${max} characters.`);
  return result;
}
export async function atomicWrite(file, content) {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try { await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
const initial = () => ({version: 2, password: null, bots: [
  {id:'bot_atlas', name:'Roki', title:'Chief of staff', description:'A thoughtful partner for your plans, priorities, and daily work.', instructions:'You are Roki, a thoughtful chief of staff. Turn goals into clear priorities and useful outcomes. Ask for missing context and obtain approval before external actions.',color:'slate',icon:'roki'},
  {id:'bot_nova', name:'Nova', title:'Creative partner', description:'From a first spark to a considered draft. Make something worth sharing.', instructions:'You are Nova, a creative partner. Develop original concepts, write clearly, and explain creative choices. Never claim a draft was published or sent without evidence.',color:'lavender',icon:'orbit'},
  {id:'bot_scout', name:'Scout', title:'Research analyst', description:'Connect the dots, check the sources, and bring back the useful details.', instructions:'You are Scout, a careful researcher. Distinguish facts from inferences, cite primary sources, and keep uncertainty visible.',color:'peach',icon:'compass'}
].map(b => ({...b, connectionId:'',model:'',reasoningEffort:'',skills:[],tools:['workspace','memory','skills','web','integrations','delegation','automation'],collaborators:[],integrationIds:[],enabled:true,createdAt:now()})), settings:{},connections:[],integrations:[],channels:[],conversations:{},memory:{},routines:[],skills:[],activity:[],messages:{},runs:{},rooms:[],roomMessages:{},roomDrives:{},devices:[],presence:{},seedSkillsInstalled:false});

export class Store {
  constructor(directory) { this.directory = path.resolve(directory); this.file = path.join(this.directory,'state.json'); this.queue = Promise.resolve(); this.created = false; this.commitListeners = new Set(); this.revision = 0; this.saved = null; this.secretCache = new Map(); }
  async init() {
    await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    await fs.chmod(this.directory,0o700);
    const keyPath = path.join(this.directory,'vault.key');
    const retainedRuntime=async()=>{for(const name of ['state.json','sync','skills','workspaces','process-homes','notifications.json']){const exists=await fs.lstat(path.join(this.directory,name)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});if(exists)return true;}return false;};
    try { this.key = await fs.readFile(keyPath); }
    catch (err) {
      if(err.code !== 'ENOENT') throw err;
      // Missing keys are a recovery failure, never an invitation to re-key existing sealed data.
      const existing=await retainedRuntime();
      ensure(!existing,500,'The vault key is missing from an existing workspace. Restore the complete data backup before starting Tupies.');
      this.key = randomBytes(32); await fs.writeFile(keyPath,this.key,{flag:'wx',mode:0o600});
    }
    ensure(this.key.length === 32,500,'Vault key is invalid. Restore your data backup.');
    await fs.chmod(keyPath,0o600);
    try { this.state = JSON.parse(await fs.readFile(this.file,'utf8')); }
    catch (err) {
      if(err.code !== 'ENOENT') throw err;
      ensure(!await retainedRuntime(),500,'The state file is missing from an existing workspace. Restore the complete data backup before starting Tupies.');
      this.state = initial(); this.created = true; await this.save();
    }
    if((this.state.version || 1)<2)await atomicWrite(path.join(this.directory,'state.v1-backup.json'),JSON.stringify(this.state,null,2));
    this.state.rooms ||= []; this.state.roomMessages ||= {}; this.state.roomDrives ||= {};
    this.state.integrations ||= [];this.state.channels ||= [];this.state.conversations ||= {};this.state.sessions ||= [];this.state.memory ||= {};
    this.state.settings ||= {};this.state.devices ||= [];this.state.presence ||= {};
    for(const bot of this.state.bots){if(!['','none','minimal','low','medium','high','xhigh','max'].includes(bot.reasoningEffort))bot.reasoningEffort='';bot.tools ||= ['workspace','memory','skills','web','integrations','delegation','automation'];bot.collaborators ||= [];bot.integrationIds ||= [];if(!this.state.conversations[bot.id])this.state.conversations[bot.id]=(this.state.messages[bot.id]||[]).filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,content:m.content}));}
    for(const connection of this.state.connections){if(!connection.type){connection.type='legacy-hermes';connection.status='migration_required';connection.migrationMessage='Choose a model provider and enter its credentials. Gateway keys are never reused as provider keys.';}}
    for(const room of this.state.rooms){room.autoCollaborate ??= false;room.maxRounds ??= 4;}
    this.state.version=2;
    await fs.chmod(this.file,0o600);
    await fs.mkdir(path.join(this.directory,'skills'),{recursive:true,mode:0o700});
    if (!this.state.seedSkillsInstalled) {
      for (const [name,description,body] of [
        ['daily-brief','Turn scattered priorities into a focused daily brief.','Summarize available context into: priorities, upcoming commitments, blockers, and next actions. Never invent calendar or email access.'],
        ['source-check','Research with evidence and make uncertainty visible.','Use available research tools to verify claims. Prefer original sources, include source URLs, and label assumptions. If tools are unavailable, explain what could not be checked.']
      ]) {
        const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
        await fs.mkdir(path.join(this.directory,'skills',name),{recursive:true,mode:0o700});
        await atomicWrite(path.join(this.directory,'skills',name,'SKILL.md'),content);
        if(!this.state.skills.some(s=>s.id===name))this.state.skills.push({id:name,name,description,source:'local',createdAt:now(),size:Buffer.byteLength(content),resourceCount:0,fileCount:1,files:['SKILL.md']});
      }
      this.state.seedSkillsInstalled = true;
      await this.save();
    }
    await this.save();
    return this;
  }
  /** The committed bytes double as the rollback point, so a mutation never has to deep-copy the whole state first. */
  async save() { const data = Buffer.from(JSON.stringify(this.state,null,2)); await atomicWrite(this.file,data); this.saved = data; }
  /** Applies fn and commits it. `local: true` marks run-progress-only changes that hold no replicated documents. */
  async mutate(fn, { local = false } = {}) {
    const operation = this.queue.then(async () => {
      try { const result = await fn(this.state); await this.save(); this.revision++; for (const listener of this.commitListeners) listener({ local }); return result; }
      catch (err) { this.state = JSON.parse(this.saved.toString('utf8')); this.revision++; throw err; }
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  /** Runs fn in the mutation queue without saving, so readers never observe a half-applied mutation. */
  serialize(fn) { const operation = this.queue.then(fn); this.queue = operation.catch(() => {}); return operation; }
  onCommit(listener) { this.commitListeners.add(listener); return () => this.commitListeners.delete(listener); }
  seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,iv);
    const encrypted = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),encrypted].map(b=>b.toString('base64')).join('.');
  }
  unseal(value) {
    if (!value) return '';
    const [iv,tag,encrypted] = value.split('.').map(v=>Buffer.from(v,'base64'));
    // Only the full 128-bit tag that seal() writes is accepted; a truncated tag would weaken the integrity check.
    ensure(iv?.length===12 && tag?.length===16 && encrypted,500,'A stored credential is damaged. Enter it again.');
    const cipher = createDecipheriv('aes-256-gcm',this.key,iv,{authTagLength:16}); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted),cipher.final()]).toString('utf8');
  }
  publicState() {
    const {bots,connections,integrations,channels,routines,skills,activity,rooms} = this.state;
    const runs = Object.fromEntries(Object.entries(this.state.runs).map(([botId,run])=>[botId,{id:run.id,status:run.status,updatedAt:run.updatedAt,...(run.error?{error:run.error}:{}),...(run.pollError?{pollError:run.pollError}:{})}]));
    const roomDrives = Object.fromEntries(Object.entries(this.state.roomDrives).map(([roomId,d])=>[roomId,{id:d.id,status:d.status,currentBotId:d.currentBotId,remaining:d.remaining,updatedAt:d.updatedAt,...(d.error?{error:d.error}:{})}]));
    return {version:2,engine:{name:'Tupies Engine',version:'0.5.0',independent:true},settings:{defaultConnectionId:this.state.settings.defaultConnectionId||'',defaultModel:this.state.settings.defaultModel||'',timezone:this.state.settings.timezone||''},bots,connections:connections.map(({secret,oauthSecret,...c})=>({...c,hasKey:!!secret,hasOAuth:!!oauthSecret})),integrations:integrations.map(({secret,...integration})=>({...integration,hasKey:!!secret})),channels:channels.map(({secret,...channel})=>({...channel,hasToken:!!secret})),routines,skills,activity,runs,rooms,roomDrives};
  }
  audit(type, title, botId = null, extra = {}) {
    this.state.activity.unshift({id:id('event'),type,title,botId,createdAt:now(),...extra});
    this.state.activity = this.state.activity.slice(0,500);
  }
  redactValue(value) {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(v => this.redactValue(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [this.redact(k),this.redactValue(v)]));
    return value;
  }
  /** Plaintext of every stored credential, memoized per sealed value. Replaced credentials drop out of the memo on the next call. */
  knownSecrets() {
    const secrets = [], current = new Set();
    for (const c of [...this.state.connections,...(this.state.integrations || []),...(this.state.channels || [])]) {
      for (const [sealed,bundle] of [[c.secret,false],[c.oauthSecret,true]]) {
        if (!sealed) continue;
        current.add(sealed);
        if (!this.secretCache.has(sealed)) {
          let values = [];
          try { const plain = this.unseal(sealed); values = bundle ? Object.entries(JSON.parse(plain)).filter(([key,value])=>/token|secret/i.test(key) && typeof value==='string' && value).map(([,value])=>value) : plain ? [plain] : []; } catch {}
          this.secretCache.set(sealed,values);
        }
        secrets.push(...this.secretCache.get(sealed));
      }
    }
    if (this.secretCache.size > current.size) for (const sealed of this.secretCache.keys()) if (!current.has(sealed)) this.secretCache.delete(sealed);
    return secrets;
  }
  redact(value) {
    let result = String(value);
    for (const secret of this.knownSecrets()) result = result.split(secret).join('[redacted]');
    return result;
  }
}

export function parseSkill(content) {
  string(content,'SKILL.md',100_000);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  ensure(match,400,'SKILL.md must start with YAML frontmatter containing name and description.');
  const extract = key => {
    const lines=match[1].split(/\r?\n/),matches=lines.map((line,index)=>({match:line.match(new RegExp(`^${key}:\\s*(.*)$`)),index})).filter(item=>item.match);
    ensure(matches.length<=1,400,`Skill ${key} appears more than once.`);if(!matches.length)return undefined;
    const {match:field,index}=matches[0],value=field[1].trim();
    if(/^[>|][+-]?$/.test(value)) {
      const block=[];for(let i=index+1;i<lines.length;i++){if(lines[i] && !/^\s/.test(lines[i]))break;block.push(lines[i].trim());}
      return block.join(value[0]==='>'?' ':'\n').trim();
    }
    if(value.startsWith("'") && value.endsWith("'"))return value.slice(1,-1).replace(/''/g,"'");
    if(value.startsWith('"') && value.endsWith('"')){try{return JSON.parse(value);}catch{ensure(false,400,`Skill ${key} has invalid quoted text.`);}}
    const comment=value.search(/\s#/);
    return (comment<0?value:value.slice(0,comment)).trim();
  };
  const name = extract('name'), description = extract('description');
  ensure(name && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name),400,'Skill name must be a lowercase slug of up to 64 characters.');
  ensure(description && description.length <= 1000,400,'Skill description must be a single YAML line of 1–1000 characters.');
  return {id:name,name,description};
}

export function parseSkillPackage(input) {
  let files;
  if (Object.hasOwn(input,'files')) {
    ensure(!Object.hasOwn(input,'content'),400,'Provide either content or files, not both.');
    ensure(Array.isArray(input.files) && input.files.length>=1 && input.files.length<=100,400,'A skill package must contain 1–100 files.');
    const seen=new Set();let total=0;
    files=input.files.map(file=>{
      ensure(file && typeof file==='object' && !Array.isArray(file),400,'Each skill file must be an object.');
      const filePath=string(file.path,'File path',240);
      ensure(!filePath.startsWith('/') && !/^[a-zA-Z]:/.test(filePath) && !/[\\\x00-\x1f\x7f]/.test(filePath) && filePath.split('/').every(part=>part && part!=='.' && part!=='..'),400,'Skill file paths must be safe relative paths.');
      ensure(!seen.has(filePath),400,'Skill package contains duplicate file paths.');seen.add(filePath);
      ensure(typeof file.contentBase64==='string' && file.contentBase64.length<=6_700_000 && file.contentBase64.length%4===0 && !/[^A-Za-z0-9+/=]/.test(file.contentBase64),400,'Skill files must use canonical padded base64.');
      const data=Buffer.from(file.contentBase64,'base64');
      ensure(data.toString('base64')===file.contentBase64,400,'Skill files must use canonical padded base64.');
      total+=data.length;ensure(total<=5_000_000,413,'Skill package exceeds the 5 MB decoded limit.');
      return {path:filePath,data};
    });
    ensure(seen.has('SKILL.md'),400,'Skill package needs SKILL.md at its root.');
    // A file cannot also be a parent directory of another file.
    for(const filePath of seen){const segments=filePath.split('/');segments.pop();while(segments.length){ensure(!seen.has(segments.join('/')),400,'A skill file conflicts with a directory path.');segments.pop();}}
  } else {
    const content=input.content;string(content,'SKILL.md',100_000);
    files=[{path:'SKILL.md',data:Buffer.from(content,'utf8')}];
  }
  const root=files.find(file=>file.path==='SKILL.md');let content;
  try {content=new TextDecoder('utf-8',{fatal:true}).decode(root.data);}catch{ensure(false,400,'SKILL.md must contain valid UTF-8 text.');}
  const skill=parseSkill(content);
  return {skill:{...skill,source:'local',createdAt:now(),size:files.reduce((sum,file)=>sum+file.data.length,0),resourceCount:files.length-1,fileCount:files.length,files:files.map(file=>file.path)},files,content};
}
