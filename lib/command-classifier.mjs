// Pattern-based risk classification for terminal commands and execute_code snippets.
// Pure and synchronous: no filesystem, no network, no model. It is a conservative policy
// aid, not an OS sandbox. Anything it cannot parse confidently is never read_only, and
// anything it cannot parse at all is dangerous (owner review).
import path from 'node:path';

export const RISKS=['read_only','normal','dangerous'];
const RANK={read_only:0,normal:1,dangerous:2};
const MAX_COMMAND=20_000, MAX_CODE=100_000, MAX_DEPTH=4, MAX_REASONS=6;
/** Stand-in workspace root when the real one is not known yet: absolute paths are then judged outside. */
export const WORKSPACE_PLACEHOLDER='/__tupies_workspace__';
const VIRTUAL_ROOT=WORKSPACE_PLACEHOLDER;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
const READ_ONLY=new Set(['ls','cat','head','tail','wc','grep','egrep','fgrep','rg','ag','ack','tree','pwd','echo','printf','date','cal','whoami','id','groups','uname','uptime','df','du','file','stat','which','whereis','type','basename','dirname','realpath','readlink','sort','uniq','cut','tr','nl','fold','fmt','column','paste','join','expand','unexpand','rev','tac','diff','cmp','comm','jq','md5','md5sum','shasum','sha1sum','sha256sum','sha512sum','cksum','b2sum','xxd','hexdump','od','strings','true','false','test','[','seq','printenv','sleep','nproc','sw_vers','arch','locale','getconf','less','more','cd','pushd','popd','dirs',':','sed','awk','find','git','env','command','hash','expr','tsort','look','numfmt','iconv']);
const NO_FILES=new Set(['echo','printf','sleep','seq','true','false',':','expr','whoami','id','groups','uname','uptime','nproc','sw_vers','arch','locale','getconf','pwd','date','cal','printenv','type','which','whereis','command','hash','test','[','dirs','numfmt']);
const PRIVILEGE=new Set(['sudo','su','doas','pkexec','run0']);
const ALWAYS_DANGEROUS=new Map([
  ...['rm','rmdir','unlink','shred','srm','trash','truncate'].map(name=>[name,'deletes or truncates files']),
  ...['dd','fdisk','sfdisk','parted','wipefs','mount','umount','newfs','diskutil'].map(name=>[name,'writes to disks or volumes']),
  ...['kill','pkill','killall','skill','xkill'].map(name=>[name,'kills processes']),
  ...['shutdown','reboot','halt','poweroff'].map(name=>[name,'stops or restarts the machine']),
  ...['launchctl','service','crontab','at','batch'].map(name=>[name,'changes background services or scheduled jobs']),
  ...['chown','chgrp','chflags'].map(name=>[name,'changes file ownership or flags']),
  ...['passwd','chpasswd','useradd','userdel','usermod','groupadd','groupdel','dscl','sysadminctl','security','networksetup','scutil','csrutil','spctl','tccutil','pfctl','iptables','ip6tables','nft','ufw','firewall-cmd'].map(name=>[name,'changes accounts, keychain or security settings']),
  ...['nc','ncat','netcat','socat','telnet','ssh','scp','sftp','ftp','mail','mailx','sendmail'].map(name=>[name,'opens a remote connection or sends data off this machine']),
  ['osascript','controls other applications'],
]);
const SYSTEM_PACKAGES=new Set(['brew','apt','apt-get','yum','dnf','pacman','apk','port','snap','flatpak','softwareupdate','mas','zypper']);
const PACKAGE_READ=new Set(['list','info','search','show','--version','-v','help','outdated','doctor','config','policy','desc']);
const CLOUD=new Set(['aws','gcloud','az','kubectl','helm','terraform','tofu','pulumi','heroku','fly','flyctl','vercel','netlify','doctl','firebase','wrangler','gh','glab','docker','podman']);
const CLOUD_MUTATING=/^(delete|destroy|apply|deploy|publish|push|rm|rmi|remove|create|update|put|set|scale|rollout|release|merge|close|edit|kill|stop|prune|login|logout|import|upgrade|uninstall|install|run|exec|cp|sync|invoke|send|comment|review|approve|reopen|transfer|archive|rename|fork|secret|token|auth)$/;
const PUBLISH=[['npm',['publish','unpublish','deprecate','owner','access','token','adduser','login','dist-tag','link']],['yarn',['publish','npm']],['pnpm',['publish']],['bun',['publish']],['cargo',['publish','yank','owner','login']],['twine',['upload','register']],['gem',['push','yank','owner','signin']],['poetry',['publish']],['flit',['publish']],['hatch',['publish']],['uv',['publish']],['mvn',['deploy','release:perform']],['gradle',['publish']],['pod',['trunk']],['vsce',['publish']],['ovsx',['publish']]];
const SHELLS=new Set(['sh','bash','zsh','dash','ksh','fish','csh','tcsh']);
const PYTHON=/^python(?:[23](?:\.\d+)?)?$/;
const NODE=new Set(['node','nodejs','deno','bun']);
const OTHER_INTERPRETERS=new Set(['perl','ruby','php','lua','osascript','Rscript','julia','tclsh','swift']);
const NETWORK_FETCH=new Set(['curl','wget','http','https','xh','fetch','aria2c','nc','ncat','netcat','socat']);
const WRITE_COMMANDS=new Set(['cp','mv','tee','touch','mkdir','ln','install','rsync','patch','mkfifo','split','csplit','chmod','tar','unzip','zip','gzip','gunzip','bzip2','xz','7z','ditto','cpio']);
const WRAPPERS=new Set(['nice','nohup','time','timeout','stdbuf','ionice','caffeinate','builtin','exec','chronic','unbuffer','xargs','command','env','!']);
const KEYWORDS=new Set(['if','then','elif','else','fi','while','until','do','done','for','in','case','esac','select','function','{','}','!','[[',']]','time','coproc']);
const DANGEROUS_ENV=/^(LD_\w+|DYLD_\w+|BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|BASH_FUNC_.*|IFS)$/;
const SENSITIVE_ENV=/^(PATH|PYTHONPATH|PYTHONSTARTUP|NODE_OPTIONS|NODE_PATH|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|GIT_\w+|HOME|TMPDIR|XDG_\w+|SSH_\w+|CDPATH|GLOBIGNORE|HISTFILE)$/;
const DEVICE=/^\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)$/;
const RAW_DEVICE=/^\/dev\/(r?disk|sd|nvme|hd|xvd|mmcblk|mapper\/|md\d)/;

const SENSITIVE=[
  /(?:^|\/)\.ssh(?:\/|$)/,/(?:^|\/)\.aws(?:\/|$)/,/(?:^|\/)\.gnupg(?:\/|$)/,/(?:^|\/)\.kube(?:\/|$)/,/(?:^|\/)\.docker\/config\.json$/,
  /(?:^|\/)\.netrc$/,/(?:^|\/)\.npmrc$/,/(?:^|\/)\.pypirc$/,/(?:^|\/)\.git-credentials$/,/(?:^|\/)\.config\/(?:gh|gcloud|hub|op)(?:\/|$)/,
  /(?:^|\/)Keychains?(?:\/|$)/,/\.keychain(?:-db)?$/,/(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/,/(?:^|\/)\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/,
  /(?:^|\/)vault\.key$/,/^\/etc\/(?:shadow|gshadow|sudoers|master\.passwd)/,/\.(?:pem|p12|pfx|key)$/,
  /(?:^|\/)\.(?:bash|zsh|ksh|tcsh|csh)rc$/,/(?:^|\/)\.(?:bash_)?profile$/,/(?:^|\/)\.(?:zprofile|zshenv|zlogin|bash_login|bash_logout|inputrc)$/,/(?:^|\/)\.gitconfig$/,
  /(?:^|\/)Launch(?:Agents|Daemons)(?:\/|$)/,/(?:^|\/)\.config\/autostart(?:\/|$)/,/(?:^|\/)crontabs?(?:\/|$)/,/(?:^|\/)\.git\/(?:config|hooks)(?:\/|$)/,
];
const isSensitive=value=>typeof value==='string' && SENSITIVE.some(pattern=>pattern.test(value.replace(/\/+$/,'')));
const PROTECTED_GIT=value=>value.replaceAll('\\','/').split('/').some(part=>['.git','.gitconfig','.gitattributes','.gitmodules'].includes(part.toLowerCase())) || /^scripts\/[^/]+\/script\.json$/i.test(value);

// ---------------------------------------------------------------------------
// Result accumulation
// ---------------------------------------------------------------------------
class Verdict {
  constructor(){this.risk='read_only';this.entries=[];this.units=[];}
  raise(risk,reason){if(RANK[risk]>RANK[this.risk])this.risk=risk;if(reason && risk!=='read_only' && !this.entries.some(entry=>entry.reason===reason) && this.entries.length<MAX_REASONS*4)this.entries.push({risk,reason});}
  merge(other){this.raise(other.risk);for(const entry of other.entries || [])this.raise(entry.risk,entry.reason);this.units.push(...(other.units || []));}
  result(){
    // Dangerous reasons first so the approval card leads with the actual hazard.
    const reasons=[...this.entries].sort((a,b)=>RANK[b.risk]-RANK[a.risk]).map(entry=>entry.reason).slice(0,MAX_REASONS);
    return {risk:this.risk,reasons,units:this.units.slice(0,64),entries:this.entries};
  }
}

// ---------------------------------------------------------------------------
// Lexer: a conservative subset of bash. Returns words, operators and redirects.
// ---------------------------------------------------------------------------
class ParseError extends Error {}

function readBalanced(src,start,open,close) {
  // Returns [inner,endIndex] for a $( ... ) or <( ... ) body beginning after `open`.
  let depth=1,index=start,quote=null;
  while(index<src.length) {
    const ch=src[index];
    if(quote==="'"){if(ch==="'")quote=null;index++;continue;}
    if(ch==='\\'){index+=2;continue;}
    if(quote==='"'){if(ch==='"')quote=null;else if(ch==='$' && src[index+1]==='('){const [,end]=readBalanced(src,index+2,'(',')');index=end+1;continue;}index++;continue;}
    if(ch==="'" || ch==='"'){quote=ch;index++;continue;}
    if(ch==='`'){const end=src.indexOf('`',index+1);if(end<0)throw new ParseError('unterminated backquote');index=end+1;continue;}
    if(ch===open)depth++;
    else if(ch===close){depth--;if(depth===0)return [src.slice(start,index),index];}
    index++;
  }
  throw new ParseError('unbalanced parentheses');
}

function lex(src) {
  const tokens=[];let index=0;
  const heredocs=[];
  const pushOp=value=>tokens.push({type:'op',value});
  while(index<src.length) {
    const ch=src[index];
    if(ch===' ' || ch==='\t' || ch==='\r'){index++;continue;}
    if(ch==='\n') {
      pushOp(';');index++;
      // Consume pending here-document bodies after the line that introduced them.
      while(heredocs.length) {
        const doc=heredocs.shift(),lines=[];let found=false;
        while(index<=src.length) {
          const end=src.indexOf('\n',index),line=src.slice(index,end<0?src.length:end);index=end<0?src.length+1:end+1;
          if((doc.strip?line.replace(/^\t+/,''):line)===doc.delimiter){found=true;break;}
          lines.push(line);if(end<0)break;
        }
        if(!found)throw new ParseError('unterminated here-document');
        doc.token.body=lines.join('\n');
      }
      continue;
    }
    if(ch==='#'){const end=src.indexOf('\n',index);index=end<0?src.length:end;continue;}
    const three=src.slice(index,index+3),two=src.slice(index,index+2);
    if(three==='<<<'){tokens.push({type:'redir',op:'<<<'});index+=3;continue;}
    if(two==='<<') {
      index+=2;let strip=false;if(src[index]==='-'){strip=true;index++;}
      while(src[index]===' ' || src[index]==='\t')index++;
      const word=readWord(src,index);index=word.end;
      const delimiter=word.value;if(!delimiter)throw new ParseError('missing here-document delimiter');
      const token={type:'heredoc',delimiter,quoted:word.quoted,body:''};tokens.push(token);heredocs.push({delimiter,strip,token});continue;
    }
    if((ch==='<' || ch==='>') && src[index+1]==='('){const [inner,end]=readBalanced(src,index+2,'(',')');tokens.push({type:'word',value:'',raw:src.slice(index,end+1),expansion:true,subs:[inner],processSub:ch});index=end+1;continue;}
    if(['&&','||',';;','|&'].includes(two)){pushOp(two==='|&'?'|':two===';;'?';':two);index+=2;continue;}
    if(two==='&>'){index+=2;if(src[index]==='>')index++;tokens.push({type:'redir',op:'>',fd:'&'});continue;}
    const redirect=/^(\d*)(>>|>\||>&|<>|<&|>|<)/.exec(src.slice(index,index+6));
    if(redirect && (redirect[1]==='' || /[\s;&|()]/.test(src[index-1] || ' '))) {
      index+=redirect[0].length;tokens.push({type:'redir',op:redirect[2],fd:redirect[1] || (redirect[2].startsWith('<')?'0':'1')});continue;
    }
    if(ch==='|' || ch===';' || ch==='&' || ch==='(' || ch===')'){pushOp(ch);index++;continue;}
    const word=readWord(src,index);index=word.end;tokens.push({type:'word',...word});
  }
  if(heredocs.length) {
    // A here-document on the final line without a trailing newline cannot have a body.
    throw new ParseError('unterminated here-document');
  }
  return tokens;
}

function readWord(src,start) {
  let index=start,value='',quoted=false,expansion=false,tilde=src[start]==='~';const subs=[];
  while(index<src.length) {
    const ch=src[index];
    if(/[\s|;&()<>]/.test(ch))break;
    if(ch==='\\'){if(src[index+1]==='\n'){index+=2;continue;}value+=src[index+1] ?? '';index+=2;quoted=true;continue;}
    if(ch==="'"){const end=src.indexOf("'",index+1);if(end<0)throw new ParseError('unterminated single quote');value+=src.slice(index+1,end);index=end+1;quoted=true;continue;}
    if(ch==='"') {
      index++;quoted=true;
      while(true) {
        if(index>=src.length)throw new ParseError('unterminated double quote');
        const c=src[index];
        if(c==='"'){index++;break;}
        if(c==='\\'){value+=src[index+1] ?? '';index+=2;continue;}
        if(c==='$' && src[index+1]==='(' && src[index+2]!=='('){const [inner,end]=readBalanced(src,index+2,'(',')');subs.push(inner);expansion=true;value+='$('+inner+')';index=end+1;continue;}
        if(c==='`'){const end=src.indexOf('`',index+1);if(end<0)throw new ParseError('unterminated backquote');subs.push(src.slice(index+1,end));expansion=true;value+=src.slice(index,end+1);index=end+1;continue;}
        if(c==='$' && /[A-Za-z_{0-9@*#?$!-]/.test(src[index+1] || ''))expansion=true;
        value+=c;index++;
      }
      continue;
    }
    if(ch==='$' && src[index+1]==='(' && src[index+2]==='('){const [inner,end]=readBalanced(src,index+3,'(',')');expansion=true;value+='$(('+inner+')';index=end+1;if(src[index]===')')index++;continue;}
    if(ch==='$' && src[index+1]==='('){const [inner,end]=readBalanced(src,index+2,'(',')');subs.push(inner);expansion=true;value+='$('+inner+')';index=end+1;continue;}
    if(ch==='`'){const end=src.indexOf('`',index+1);if(end<0)throw new ParseError('unterminated backquote');subs.push(src.slice(index+1,end));expansion=true;value+=src.slice(index,end+1);index=end+1;continue;}
    if(ch==='$' && /[A-Za-z_{0-9@*#?$!-]/.test(src[index+1] || ''))expansion=true;
    value+=ch;index++;
  }
  return {value,end:index,quoted,expansion,tilde,subs,raw:src.slice(start,index)};
}

// ---------------------------------------------------------------------------
// Segments: simple commands split on control operators, with pipeline context.
// ---------------------------------------------------------------------------
function segments(tokens) {
  const result=[];let current={words:[],redirects:[],heredocs:[],pipedFrom:null,pipeline:0,functionDef:false};let pipeline=0;
  const flush=(op)=>{
    if(current.words.length || current.redirects.length || current.heredocs.length)result.push(current);
    const piped=op==='|'?current:null;if(op!=='|')pipeline++;
    current={words:[],redirects:[],heredocs:[],pipedFrom:piped && (piped.words.length?piped:piped.pipedFrom),pipeline,functionDef:false};
  };
  for(let index=0;index<tokens.length;index++) {
    const token=tokens[index];
    if(token.type==='op') {
      if(token.value==='(' && current.words.length===1 && tokens[index+1]?.type==='op' && tokens[index+1].value===')'){current.functionDef=true;result.push(current);index++;current={words:[],redirects:[],heredocs:[],pipedFrom:null,pipeline:++pipeline,functionDef:false};continue;}
      flush(token.value);continue;
    }
    if(token.type==='redir') {
      if(token.op==='<<<'){const target=tokens[index+1];if(target?.type==='word'){current.heredocs.push({body:target.value,quoted:!target.expansion,subs:target.subs,here:true});index++;}continue;}
      const target=tokens[index+1];
      if(target?.type!=='word')throw new ParseError('redirection without a target');
      current.redirects.push({op:token.op,fd:token.fd,target});index++;continue;
    }
    if(token.type==='heredoc'){current.heredocs.push(token);continue;}
    current.words.push(token);
  }
  flush(';');
  return result;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function location(word,scope) {
  // inside | outside | device | computed | sensitive
  const value=typeof word==='string'?word:word.value;
  if(typeof word!=='string' && (word.expansion && !word.processSub))return /^\$\{?HOME\b/.test(value)?'outside':'computed';
  if(isSensitive(value))return 'sensitive';
  if(typeof word!=='string' && word.tilde || value.startsWith('~'))return 'outside';
  if(DEVICE.test(value))return 'device';
  if(!scope.cwd && !value.startsWith('/'))return 'computed';
  const resolved=path.posix.resolve(scope.cwd || '/',value);
  if(isSensitive(resolved))return 'sensitive';
  return resolved===scope.root || resolved.startsWith(scope.root.endsWith('/')?scope.root:scope.root+'/')?'inside':'outside';
}
const looksLikePath=value=>/[/~]/.test(value) || value==='.' || value==='..' || value.startsWith('.') || isSensitive(value);
const optionValue=word=>{const match=/^--?[A-Za-z0-9][\w-]*=(.*)$/s.exec(word.value);return match?{...word,value:match[1],tilde:match[1].startsWith('~')}:null;};
function operands(words) {
  const result=[];let options=true;
  for(const word of words){if(options && word.value==='--' && !word.quoted){options=false;continue;}if(options && word.value.startsWith('-') && word.value.length>1 && !word.quoted){const value=optionValue(word);if(value)result.push(value);continue;}result.push(word);}
  return result;
}

// ---------------------------------------------------------------------------
// Command classification
// ---------------------------------------------------------------------------
function unwrap(words,verdict,scope) {
  // Strip env assignments and harmless wrappers; return the effective argv.
  let argv=[...words];
  while(argv.length) {
    const first=argv[0];
    const assignment=/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(first.value);
    if(assignment && !first.quoted || assignment && first.raw && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.raw)) {
      noteAssignment(assignment[1],verdict);argv=argv.slice(1);continue;
    }
    if(first.expansion)return argv;
    const name=path.posix.basename(first.value);
    if(first.value==='[[' && !first.quoted)return [{value:'test'},...argv.slice(1).filter(word=>word.value!==']]')];
    if(KEYWORDS.has(first.value) && !first.quoted){argv=argv.slice(1);if(first.value==='for' || first.value==='select' || first.value==='case')return [];continue;}
    if(PRIVILEGE.has(name)){verdict.raise('dangerous','runs with elevated privileges');return argv.slice(1).filter(word=>!word.value.startsWith('-'));}
    if(!WRAPPERS.has(name))return argv;
    if(name==='command' && argv.slice(1).some(word=>['-v','-V'].includes(word.value)))return [{value:'type'}];
    if(name==='env') {
      let rest=argv.slice(1);
      while(rest.length && (rest[0].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].value))) {
        const assign=/^([A-Za-z_][A-Za-z0-9_]*)=/.exec(rest[0].value);if(assign)noteAssignment(assign[1],verdict);
        if(['-u','-C','-S','-P','--unset','--chdir','--split-string'].includes(rest[0].value)){if(rest[0].value==='-S' || rest[0].value==='--split-string'){verdict.raise('normal','runs a split command string');}rest=rest.slice(2);}else rest=rest.slice(1);
      }
      if(!rest.length)return [{value:'printenv'}];
      argv=rest;continue;
    }
    if(name==='xargs') {
      let rest=argv.slice(1);
      while(rest.length && rest[0].value.startsWith('-')){const takes=['-I','-n','-P','-L','-s','-E','-d','-a'].includes(rest[0].value);rest=rest.slice(takes?2:1);}
      if(!rest.length)return [{value:'echo'}];
      // xargs appends arguments read at run time.
      argv=[...rest,{value:'$XARGS',raw:'$XARGS',expansion:true,subs:[]}];continue;
    }
    let rest=argv.slice(1);
    if(name==='timeout'){while(rest.length && rest[0].value.startsWith('-'))rest=rest.slice(rest[0].value==='-s' || rest[0].value==='-k'?2:1);rest=rest.slice(1);}
    else if(['nice','ionice','stdbuf','caffeinate','time','unbuffer','chronic'].includes(name)){while(rest.length && rest[0].value.startsWith('-'))rest=rest.slice(['-n','-c','-t','-w','-i'].includes(rest[0].value)?2:1);}
    if(!rest.length)return name==='time'?[]:[{value:'true'}];
    argv=rest;
  }
  return argv;
}

function noteAssignment(name,verdict) {
  if(DANGEROUS_ENV.test(name))verdict.raise('dangerous',`sets ${name}, which can inject code into later commands`);
  else if(SENSITIVE_ENV.test(name))verdict.raise('normal',`changes ${name} for later commands`);
}

function classifySegment(segment,scope,verdict,depth) {
  if(segment.functionDef){verdict.raise('normal','defines a shell function');return;}
  for(const word of segment.words)for(const sub of word.subs || [])verdict.merge(classifyCommandInner(sub,{...scope},depth+1));
  for(const redirect of segment.redirects)for(const sub of redirect.target.subs || [])verdict.merge(classifyCommandInner(sub,{...scope},depth+1));
  const argv=unwrap(segment.words,verdict,scope);
  classifyRedirects(segment,scope,verdict);
  if(!argv.length){if(segment.heredocs.length && !segment.words.length)verdict.raise('normal','feeds text to an unknown command');return;}
  const head=argv[0],args=argv.slice(1);
  if(head.expansion){verdict.raise('normal','the command name is computed when it runs');verdict.units.push({text:argv.map(word=>word.raw ?? word.value).join(' '),name:null,risk:'normal',computed:true});scanInterpreterInputs(argv,segment,scope,verdict,depth,true);return;}
  const name=path.posix.basename(head.value),pathCommand=head.value.includes('/');
  const text=argv.map(word=>word.value).join(' ');
  verdict.units.push({text,name});
  const unit=new Verdict();
  classifyName(name,args,{segment,scope,verdict:unit,depth,pathCommand,argv});
  // Arguments that name secrets or credential stores always need the owner.
  if(!NO_FILES.has(name))for(const word of args){const candidate=optionValue(word) || word;if(!candidate.value.startsWith('-') && isSensitive(candidate.value) || candidate!==word && isSensitive(candidate.value))unit.raise('dangerous',`touches a credential, key or shell profile (${bounded(candidate.value)})`);}
  if(!scope.inside && unit.risk==='read_only' && !NO_FILES.has(name))unit.raise('normal','works outside the workspace');
  verdict.units[verdict.units.length-1].risk=unit.risk;
  verdict.merge({...unit.result(),units:[]});
  if(name==='cd' || name==='pushd' || name==='popd')moveScope(name,args,scope);
}

function moveScope(name,args,scope) {
  // Later segments of the same command line are judged from the folder this one enters.
  const target=operands(args)[0];
  if(name==='popd' || !target || target.expansion || target.tilde || target.value==='-'){scope.cwd=null;scope.inside=false;return;}
  if(!scope.cwd && !target.value.startsWith('/'))return;
  const where=location(target,scope);
  scope.cwd=path.posix.resolve(scope.cwd || '/',target.value);scope.inside=where==='inside';
}

function classifyRedirects(segment,scope,verdict) {
  for(const {op,target} of segment.redirects) {
    if(op==='>&' || op==='<&'){if(/^\d+-?$|^-$/.test(target.value))continue;}
    const where=location(target,scope),value=bounded(target.value);
    if(op==='<'){if(where==='sensitive')verdict.raise('dangerous',`reads a credential, key or shell profile (${value})`);else if(where==='outside' || where==='computed')verdict.raise('normal',`reads ${value} outside the workspace`);continue;}
    if(where==='device'){continue;}
    if(RAW_DEVICE.test(target.value)){verdict.raise('dangerous',`writes to a raw device (${value})`);continue;}
    if(where==='sensitive')verdict.raise('dangerous',`writes to a credential, key or shell profile (${value})`);
    else if(where==='outside')verdict.raise('dangerous',`writes outside the workspace (${value})`);
    else if(where==='computed')verdict.raise('dangerous',`writes to a path computed when it runs (${value})`);
    else if(PROTECTED_GIT(target.value))verdict.raise('dangerous',`changes Git metadata (${value})`);
    else verdict.raise('normal',`writes ${value}`);
  }
}

function checkPaths(words,scope,verdict,{write=false,label='uses'}={}) {
  for(const word of operands(words)) {
    if(!write && !looksLikePath(word.value) && !word.expansion && !word.tilde)continue;
    const where=location(word,scope),value=bounded(word.value);
    if(where==='sensitive')verdict.raise('dangerous',`${write?'changes':'reads'} a credential, key or shell profile (${value})`);
    else if(write) {
      if(where==='outside')verdict.raise('dangerous',`writes outside the workspace (${value})`);
      else if(where==='computed')verdict.raise('normal',`writes to a path computed when it runs (${value})`);
      else if(where!=='device' && PROTECTED_GIT(word.value))verdict.raise('dangerous',`changes Git metadata (${value})`);
      else verdict.raise('normal',`${label} ${value}`);
    } else if(where==='outside')verdict.raise('normal',`reads ${value} outside the workspace`);
    else if(where==='computed')verdict.raise('normal',`reads a path computed when it runs (${value})`);
  }
}

function classifyName(name,args,context) {
  const {verdict,scope,segment,depth,pathCommand}=context;
  const values=args.map(word=>word.value),has=(...flags)=>values.some(value=>flags.includes(value) || flags.some(flag=>flag.startsWith('--') && value.startsWith(flag+'=')));
  const shortFlag=letter=>values.some(value=>/^-[A-Za-z]+$/.test(value) && value.includes(letter));
  if(values.length===1 && values[0]==='--version' && !pathCommand && !PRIVILEGE.has(name))return;
  if(ALWAYS_DANGEROUS.has(name)) {
    if(name==='diskutil' && ['list','info'].includes(values[0])){verdict.raise('normal','inspects disks');return;}
    verdict.raise('dangerous',`${name} ${ALWAYS_DANGEROUS.get(name)}`);return;
  }
  if(/^mkfs(\.|$)|^newfs_/.test(name)){verdict.raise('dangerous',`${name} formats a filesystem`);return;}
  if(name==='systemctl'){if(['status','list-units','list-unit-files','is-active','is-enabled','show','cat'].includes(values[0]))verdict.raise('normal','inspects services');else verdict.raise('dangerous','systemctl changes system services');return;}
  if(name==='defaults'){if(['read','read-type','domains','find'].includes(values[0]))verdict.raise('normal','reads system preferences');else verdict.raise('dangerous','defaults changes system or application settings');return;}
  if(name==='eval' || name==='source' || name==='.'){
    verdict.raise('normal',`${name} runs computed or file-based shell code`);
    if(name==='eval' && args.length && args.every(word=>!word.expansion))verdict.merge(classifyCommandInner(values.join(' '),scope,depth+1));
    scanInterpreterInputs([{value:name},...args],segment,scope,verdict,depth,true);return;
  }
  if(SHELLS.has(name)) {
    const index=values.findIndex(value=>/^-[a-zA-Z]*c[a-zA-Z]*$/.test(value));
    if(index>=0 && args[index+1]){const inner=args[index+1];if(inner.expansion)verdict.raise('normal','runs a computed shell command');verdict.merge(classifyCommandInner(inner.value,scope,depth+1));}
    else verdict.raise('normal',`runs a ${name} script`);
    for(const doc of segment.heredocs)verdict.merge(classifyCommandInner(doc.body,scope,depth+1));
    scanInterpreterInputs([{value:name},...args],segment,scope,verdict,depth,true);return;
  }
  if(PYTHON.test(name) || NODE.has(name)) {
    const language=PYTHON.test(name)?'python':'node';
    if(values.length===1 && ['--version','-V','-v'].includes(values[0])){return;}
    const flag=language==='python'?values.findIndex(value=>value==='-c'):values.findIndex(value=>['-e','--eval','-p','--print'].includes(value));
    if(flag>=0 && args[flag+1]){if(args[flag+1].expansion)verdict.raise('normal','runs computed code');verdict.merge(classifyCode(language,args[flag+1].value));}
    else if(language==='python' && values[0]==='-m' && ['http.server','smtpd'].includes(values[1]))verdict.raise('normal','starts a network server');
    else if(language==='python' && values[0]==='-m' && values[1]==='pip')classifyPip(values.slice(2),verdict);
    else if(segment.heredocs.length)for(const doc of segment.heredocs)verdict.merge(classifyCode(language,doc.body));
    else verdict.raise('normal',`runs ${name} code`);
    checkPaths(args.filter((word,index)=>index!==flag+1 || flag<0),scope,verdict);
    scanInterpreterInputs([{value:name},...args],segment,scope,verdict,depth,true);return;
  }
  if(OTHER_INTERPRETERS.has(name)) {
    verdict.raise('normal',`runs ${name} code`);
    const inline=values.join(' ');if(/\b(unlink|rmtree|rm\s+-r|system\s*\(|exec\s*\(|kill\b|`)/.test(inline))verdict.raise('dangerous',`inline ${name} code can delete files or run other commands`);
    scanInterpreterInputs([{value:name},...args],segment,scope,verdict,depth,true);return;
  }
  if(name==='pip' || name==='pip3'){classifyPip(values,verdict);return;}
  for(const [tool,verbs] of PUBLISH)if(name===tool && verbs.includes(values.find(value=>!value.startsWith('-')))){verdict.raise('dangerous',`${name} ${values.find(value=>!value.startsWith('-'))} publishes or changes a package registry`);return;}
  if(['npm','pnpm','yarn','bun'].includes(name)) {
    const verb=values.find(value=>!value.startsWith('-'));
    if(['i','install','add','update','upgrade','remove','uninstall','rm','un'].includes(verb) && has('-g','--global','--location=global'))verdict.raise('dangerous',`${name} changes globally installed packages`);
    else if(['ls','list','view','info','outdated','why','explain'].includes(verb))verdict.raise('normal',`${name} inspects packages`);
    else verdict.raise('normal',`${name} ${verb || ''} runs project scripts or installs packages`.replace(/\s+/g,' '));
    return;
  }
  if(SYSTEM_PACKAGES.has(name)){const verb=values.find(value=>!value.startsWith('-'));if(PACKAGE_READ.has(verb) || has('--version'))verdict.raise('normal',`${name} inspects installed software`);else verdict.raise('dangerous',`${name} changes system software`);return;}
  if(name==='git'){classifyGit(args,context);return;}
  if(CLOUD.has(name)) {
    const words=values.filter(value=>!value.startsWith('-'));
    if((name==='docker' || name==='podman') && dockerHostAccess(args,scope)){verdict.raise('dangerous',`${name} grants a container access to the host`);return;}
    if(name==='gh' && words[0]==='api'){if(has('-X','--method','-f','-F','--field','--raw-field','--input'))verdict.raise('dangerous','gh api sends a write request');else verdict.raise('normal','gh api reads from GitHub');return;}
    if(words.slice(0,3).some(word=>CLOUD_MUTATING.test(word))){verdict.raise('dangerous',`${name} ${words.slice(0,2).join(' ')} changes remote or container resources`);return;}
    verdict.raise('normal',`${name} uses remote or container resources`);return;
  }
  if(NETWORK_FETCH.has(name)){classifyNetwork(name,args,context);return;}
  if(name==='find'){classifyFind(args,context);return;}
  if(name==='chmod') {
    if(values.some(chmodDangerous) || shortFlag('R') || has('--recursive'))verdict.raise('dangerous','chmod makes files world-writable or setuid, or changes a whole tree');
    checkPaths(args.filter(word=>!/^(?:[0-7]{3,4}|[ugoa]*[+=-][rwxXst]+)$/.test(word.value)),scope,verdict,{write:true,label:'changes permissions on'});return;
  }
  if(name==='rsync'){if(has('--delete','--delete-after','--delete-before','--delete-during','--remove-source-files'))verdict.raise('dangerous','rsync deletes files');if(values.some(value=>/^[\w.-]+@?[\w.-]*:/.test(value) && !value.startsWith('/')))verdict.raise('dangerous','rsync copies to or from another machine');checkPaths(args.filter(word=>!/^[\w.-]+@?[\w.-]*:/.test(word.value)),scope,verdict,{write:true,label:'copies to'});return;}
  if(name==='tar') {
    const mode=values.find(value=>!value.startsWith('--')) || '',extract=/^-?[A-Za-z]*x/.test(mode) || has('--extract','--get'),writes=extract || /^-?[A-Za-z]*[cru]/.test(mode) || has('--create','--append','--update');
    const ops=args.filter(word=>!(/^-?[A-Za-z]+$/.test(word.value) && word===args[0]) && !(/^-[A-Za-z]+$/.test(word.value)));
    checkPaths(writes?[...ops,...(extract && !values.includes('-C')?[{value:'.'}]:[])]:ops,scope,verdict,writes?{write:true,label:extract?'extracts into':'creates'}:{});
    return;
  }
  if(name==='sed') {
    if(shortFlag('i') || has('--in-place')){checkPaths(args.slice(1),scope,verdict,{write:true,label:'edits'});return;}
    if(values.some(value=>/(?:^|[;\n{}])\s*[ewWrR](?:\s|$)|\/[gIpmM0-9]*e[gIpmM0-9]*(?:\s*(?:;|}|$))/.test(value)))verdict.raise('normal','sed script reads, writes or executes files');
    checkPaths(args.slice(1),scope,verdict);return;
  }
  if(name==='awk' || name==='gawk' || name==='mawk' || name==='nawk') {
    if(has('-f') || values.some(value=>/system\s*\(|\||>|getline/.test(value)))verdict.raise('normal','awk program writes files or runs commands');
    checkPaths(args.slice(1),scope,verdict);return;
  }
  if(name==='sort' && (has('-o','--output'))){checkPaths(args,scope,verdict,{write:true,label:'writes'});return;}
  if(name==='uniq' && operands(args).length>1){checkPaths(operands(args).slice(1),scope,verdict,{write:true,label:'writes'});return;}
  if(name==='hostname' && operands(args).length){verdict.raise('dangerous','hostname changes the machine name');return;}
  if(name==='xxd' && shortFlag('r') && operands(args).length>1){checkPaths(operands(args).slice(1),scope,verdict,{write:true,label:'writes'});return;}
  if(name==='export' || name==='declare' || name==='typeset' || name==='readonly' || name==='local' || name==='set' || name==='unset' || name==='shopt' || name==='alias' || name==='unalias' || name==='trap' || name==='ulimit' || name==='umask') {
    if(['export','declare','typeset','readonly','local'].includes(name) && has('-f'))verdict.raise('dangerous',`${name} -f exports a shell function into later commands`);
    for(const word of args){const match=/^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(word.value);if(match && !word.value.startsWith('-'))noteAssignment(match[1],verdict);}
    if(['alias','trap','set','shopt'].includes(name) && args.length)verdict.raise('normal',`${name} changes shell behaviour`);
    return;
  }
  if(WRITE_COMMANDS.has(name)) {
    const ops=operands(args);
    if(name==='mv'){checkPaths(ops,scope,verdict,{write:true,label:'moves'});return;}
    if(['cp','ln','install','ditto'].includes(name)){checkPaths(ops.slice(0,-1),scope,verdict);checkPaths(ops.slice(-1),scope,verdict,{write:true,label:'writes to'});if(name==='install' || name==='cp' && has('-t','--target-directory'))checkPaths(ops,scope,verdict,{write:true,label:'writes to'});return;}
    if(name==='unzip'){const index=values.indexOf('-d');checkPaths(index>=0?[args[index+1]].filter(Boolean):[{value:'.'}],scope,verdict,{write:true,label:'extracts into'});checkPaths(ops,scope,verdict);return;}
    checkPaths(ops.length?ops:[{value:'.'}],scope,verdict,{write:true,label:name==='mkdir'?'creates':'writes'});return;
  }
  if(READ_ONLY.has(name) && !pathCommand) {
    if(name==='env' || name==='command' || name==='printenv' || name==='hash')return;
    if(name==='less' || name==='more'){checkPaths(args,scope,verdict);return;}
    if(['cd','pushd','popd','dirs'].includes(name)){const target=operands(args)[0];if(target && name!=='dirs'){const where=location(target,scope);if(where==='sensitive')verdict.raise('dangerous','enters a credential or key folder');else if(where!=='inside')verdict.raise('normal',`changes to a folder outside the workspace (${bounded(target.value)})`);}else if(!target && name==='cd')verdict.raise('normal','changes to the home folder');return;}
    if(name==='date' && values.some(value=>!value.startsWith('+') && !value.startsWith('-') || ['-s','--set'].includes(value))){verdict.raise('dangerous','date sets the system clock');return;}
    if(NO_FILES.has(name))return;
    checkPaths(args,scope,verdict);return;
  }
  if(values.length===1 && values[0]==='--version' && !pathCommand)return;
  verdict.raise('normal',pathCommand?`runs ${bounded(context.argv[0].value)}`:`runs ${name}`);
  checkPaths(args,scope,verdict);
}

function classifyPip(values,verdict) {
  const verb=values.find(value=>!value.startsWith('-'));
  if(['list','show','freeze','check','--version','help','index','inspect'].includes(verb))return verdict.raise('normal','pip inspects packages');
  if(values.some(value=>['--break-system-packages','--target','--prefix','--root'].includes(value) || value.startsWith('--target=') || value.startsWith('--prefix=')))return verdict.raise('dangerous','pip changes packages outside a project environment');
  if(verb==='uninstall')return verdict.raise('dangerous','pip removes packages');
  verdict.raise('normal','pip installs packages');
}

function classifyGit(args,{verdict,scope}) {
  let rest=[...args];
  while(rest.length && rest[0].value.startsWith('-')) {
    const flag=rest[0].value;
    if(flag==='-c' || flag.startsWith('--config-env') || flag==='--exec-path' || flag.startsWith('--exec-path=')){verdict.raise('dangerous','git configuration override can run hooks or helpers');rest=rest.slice(2);continue;}
    if(['-C','--git-dir','--work-tree','--namespace'].includes(flag)){const target=rest[1];if(target){const where=location(target,scope);if(where==='sensitive')verdict.raise('dangerous','git targets a protected folder');else if(where!=='inside')verdict.raise('normal','git works outside the workspace');}rest=rest.slice(2);continue;}
    if(/^--(git-dir|work-tree)=/.test(flag)){verdict.raise('normal','git works with an explicit repository');rest=rest.slice(1);continue;}
    rest=rest.slice(1);
  }
  const verb=rest[0]?.value,more=rest.slice(1).map(word=>word.value),has=(...flags)=>more.some(value=>flags.includes(value));
  if(!verb || ['--version','version','help','status','log','diff','show','blame','rev-parse','ls-files','ls-tree','cat-file','describe','shortlog','grep','whatchanged','name-rev','merge-base','count-objects','rev-list','show-ref','for-each-ref','check-ignore','var','annotate','cherry','range-diff','diff-tree','diff-files','diff-index','show-branch','ls-remote'].includes(verb)) {
    if(verb==='ls-remote')verdict.raise('normal','git contacts a remote');
    if(has('--output') || more.some(value=>value.startsWith('--output=')))verdict.raise('normal','git writes command output to a file');
    if(!scope.inside)verdict.raise('normal','git reads a repository outside the workspace');
    return;
  }
  const dangerous=reason=>verdict.raise('dangerous',reason);
  switch(verb) {
    case 'push':case 'send-email':case 'request-pull':return dangerous(`git ${verb} sends commits or data to another place`);
    case 'credential':case 'credential-store':case 'credential-cache':return dangerous('git credential reads or stores credentials');
    case 'config':{if(more.some(value=>['--get','--get-all','--get-regexp','--list','-l','--show-origin','--show-scope','--name-only','--get-urlmatch'].includes(value)) || more.filter(value=>!value.startsWith('-')).length===1 && !has('--unset','--unset-all','--add','--replace-all','--edit','-e','--remove-section','--rename-section'))return;return dangerous('git config changes repository or global configuration');}
    case 'reset':if(has('--hard','--merge','--keep'))return dangerous('git reset discards local changes');break;
    case 'clean':return dangerous('git clean deletes untracked files');
    case 'checkout':if(has('--','-f','--force','.','--ours','--theirs') || more.includes('-p'))return dangerous('git checkout discards local changes');break;
    case 'restore':if(!has('--staged','-S') || has('--worktree','-W'))return dangerous('git restore discards local changes');break;
    case 'switch':if(has('-f','--force','--discard-changes','-C'))return dangerous('git switch discards local changes');break;
    case 'branch':if(has('-d','-D','--delete','-m','-M','--move','-c','-C','-f','--force','--set-upstream-to','-u','--unset-upstream','--edit-description'))return dangerous('git branch deletes, renames or forces a branch');if(!more.filter(value=>!value.startsWith('-')).length || has('-a','-r','-l','--list','-v','-vv','--show-current','--contains','--merged','--no-merged'))return;break;
    case 'tag':if(has('-d','--delete','-f','--force'))return dangerous('git tag deletes or replaces a tag');if(!more.length || has('-l','--list','-n','--contains','--points-at'))return;break;
    case 'remote':if(!more.length || ['-v','show','get-url','--verbose'].includes(more[0]))return;return dangerous('git remote changes where commits are sent');
    case 'stash':if(['list','show'].includes(more[0]))return;if(['drop','clear'].includes(more[0]))return dangerous('git stash drop deletes saved changes');break;
    case 'reflog':if(['expire','delete'].includes(more[0]))return dangerous('git reflog removes recovery history');if(!more.length || more[0]==='show')return;break;
    case 'worktree':if(more[0]==='list')return;if(['remove','prune'].includes(more[0]))return dangerous('git worktree removes a working tree');break;
    case 'gc':case 'prune':if(more.some(value=>value.startsWith('--prune')) || verb==='prune')return dangerous('git prunes unreachable history');break;
    case 'filter-branch':case 'filter-repo':case 'replace':case 'update-ref':case 'symbolic-ref':return dangerous(`git ${verb} rewrites history or references`);
    case 'rm':return dangerous('git rm deletes files');
    case 'submodule':case 'clone':case 'fetch':case 'pull':verdict.raise('normal',`git ${verb} downloads and can run repository code`);
      if(verb==='clone'){const ops=operands(rest.slice(1));if(ops.length>1)checkPaths(ops.slice(-1),scope,verdict,{write:true,label:'clones into'});}
      return;
    case 'hook':return dangerous('git hook runs repository hooks');
    default:break;
  }
  if(!scope.inside)return dangerous('git changes a repository outside the workspace');
  verdict.raise('normal',`git ${verb} changes the repository`);
}

function classifyNetwork(name,args,{verdict,scope,segment}) {
  const values=args.map(word=>word.value),has=(...flags)=>values.some(value=>flags.includes(value) || flags.some(flag=>flag.startsWith('--') && value.startsWith(flag+'=')));
  if(['nc','ncat','netcat','socat'].includes(name))return verdict.raise('dangerous',`${name} opens a raw network connection`);
  const sends=name==='curl'?has('-d','--data','--data-raw','--data-binary','--data-urlencode','--data-ascii','-F','--form','--form-string','-T','--upload-file','--json','-u','--user','-K','--config','-E','--cert','--key','-b','--cookie','--netrc','-n') || values.some(value=>/^-[A-Za-z]{2,}$/.test(value) && /[dFTKEbun]/.test(value.slice(1))) || values.some(value=>/^(authorization|cookie|proxy-authorization|x-api-key|api-key)\s*:/i.test(value))
    : name==='wget'?has('--post-data','--post-file','--body-data','--body-file','--method','--user','--password','--http-user','--http-password','--load-cookies','--header')
    : values.some(value=>/^[A-Za-z_][\w.-]*(?::=|=|@)/.test(value) || /^(POST|PUT|PATCH|DELETE)$/.test(value));
  const method=values.findIndex(value=>value==='-X' || value==='--request' || value==='--method');
  const methodValue=method>=0?values[method+1]:values.find(value=>/^--request=|^--method=/.test(value))?.split('=')[1];
  if(sends || methodValue && !/^(GET|HEAD|OPTIONS)$/i.test(methodValue))return verdict.raise('dangerous',`${name} sends data or credentials to a network destination`);
  if(values.some(value=>/^file:/i.test(value)))return verdict.raise('dangerous',`${name} reads local files through a URL`);
  verdict.raise('normal',`${name} downloads from the network`);
  const output=[];
  args.forEach((word,index)=>{const prev=args[index-1]?.value;if(['-o','--output','-O','--output-document','-P','--directory-prefix','--output-dir'].includes(prev) && !(name==='curl' && prev==='-O'))output.push(word);const inline=/^--(?:output|output-document|directory-prefix|output-dir)=(.*)$/.exec(word.value);if(inline)output.push({...word,value:inline[1]});});
  checkPaths(output,scope,verdict,{write:true,label:'saves'});
  if(!output.length && !scope.inside && (has('-O','--remote-name') || name==='wget'))verdict.raise('dangerous','downloads into a folder outside the workspace');
  void segment;
}

function classifyFind(args,context) {
  const {verdict,scope,depth}=context,values=args.map(word=>word.value);
  if(values.includes('-delete'))verdict.raise('dangerous','find -delete removes files');
  if(values.some(value=>/^-f(print0?|printf|ls)$/.test(value)))verdict.raise('normal','find writes its results to a file');
  for(let index=0;index<args.length;index++) {
    if(!['-exec','-execdir','-ok','-okdir'].includes(values[index]))continue;
    let end=index+1;while(end<args.length && ![';','+','\\;'].includes(values[end]))end++;
    const inner=args.slice(index+1,end).map(word=>word.value==='{}'?{...word,value:'found-file'}:word);
    if(inner.length){const sub=new Verdict();classifySegment({words:inner,redirects:[],heredocs:[],pipedFrom:null},{...scope},sub,depth+1);if(sub.risk==='read_only')sub.raise('normal','find runs a command for each match');verdict.merge(sub.result());}
    index=end;
  }
  const starts=[];for(const word of args){if(word.value.startsWith('-') || ['!','(',')'].includes(word.value))break;starts.push(word);}
  checkPaths(starts.length?starts:[{value:'.'}],scope,verdict);
}

function scanInterpreterInputs(argv,segment,scope,verdict,depth,interpreter=false) {
  // Downloaded content piped or substituted into an interpreter is remote code execution.
  const fetches=text=>{try{return segments(lex(text)).some(item=>{const words=unwrap(item.words,new Verdict(),scope);return words[0] && NETWORK_FETCH.has(path.posix.basename(words[0].value));});}catch{return true;}};
  const remote=argv.some(word=>(word.subs || []).some(fetches)) || segment.redirects.some(r=>r.op==='<' && (r.target.subs || []).some(fetches)) || segment.heredocs.some(doc=>(doc.subs || []).some(fetches));
  let upstream=segment.pipedFrom,piped=false;
  while(upstream){const words=unwrap(upstream.words,new Verdict(),scope);if(words[0] && NETWORK_FETCH.has(path.posix.basename(words[0].value)) || upstream.words.some(word=>(word.subs || []).some(fetches)))piped=true;upstream=upstream.pipedFrom;}
  if(interpreter && (remote || piped))verdict.raise('dangerous','runs code downloaded from the network');
  void depth;
}

function chmodDangerous(mode) {
  if(/^[0-7]{3,4}$/.test(mode)){const digits=mode.padStart(4,'0');return /[2367]/.test(digits[3]) || digits[0]!=='0';}
  if(!/^[ugoa]*[+=-][rwxXstugo]+(?:,[ugoa]*[+=-][rwxXstugo]+)*$/.test(mode))return false;
  return mode.split(',').some(part=>{const [who,perms='']=part.split(/[+=-]/),adds=/[+=]/.test(part);return adds && (/[st]/.test(perms) || /w/.test(perms) && /[ao]/.test(who));});
}

function dockerHostAccess(args,scope) {
  const values=args.map(word=>word.value);
  if(values.some(value=>value==='--privileged' || /^--(?:pid|network|net|ipc|uts|userns)=host$/.test(value) || /^--cap-add/.test(value) || /^--device/.test(value)))return true;
  return args.some((word,index)=>{
    const flag=args[index-1]?.value,inline=/^(?:-v|--volume|--mount)=(.*)$/.exec(word.value),spec=inline?inline[1]:['-v','--volume','--mount'].includes(flag)?word.value:null;
    if(!spec)return false;
    const source=spec.startsWith('type=')?(/(?:^|,)(?:source|src)=([^,]+)/.exec(spec)?.[1] || ''):spec.split(':')[0];
    if(!source.startsWith('/') && !source.startsWith('~') && !source.startsWith('$'))return false;
    return source.startsWith('$') || location(source,scope)!=='inside';
  });
}

const bounded=value=>{const text=String(value ?? '');return text.length>80?text.slice(0,77)+'…':text;};

function makeScope({workspaceRoot,cwd}={}) {
  const root=typeof workspaceRoot==='string' && workspaceRoot.startsWith('/')?path.posix.normalize(workspaceRoot).replace(/(.)\/$/,'$1'):VIRTUAL_ROOT;
  const current=typeof cwd==='string' && cwd.startsWith('/')?path.posix.normalize(cwd):root;
  const inside=current===root || current.startsWith(root==='/'?'/':root+'/');
  return {root,cwd:current,inside};
}

function classifyCommandInner(command,scope,depth) {
  const verdict=new Verdict();
  if(depth>MAX_DEPTH){verdict.raise('dangerous','nested commands are too deep to review automatically');return verdict.result();}
  if(/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)){verdict.raise('dangerous','fork bomb');return verdict.result();}
  let parsed;
  try{parsed=segments(lex(command));}
  catch(error){verdict.raise('dangerous',`the command could not be parsed for review (${error instanceof ParseError?error.message:'syntax'})`);return verdict.result();}
  for(const segment of parsed) {
    try{classifySegment(segment,scope,verdict,depth);}
    catch(error){verdict.raise('dangerous',`the command could not be parsed for review (${error instanceof ParseError?error.message:'syntax'})`);}
    if(segment.heredocs.length && segment.words.length) {
      for(const doc of segment.heredocs)if(!doc.quoted && /\$\(|`/.test(doc.body || '')){try{for(const sub of substitutions(doc.body))verdict.merge(classifyCommandInner(sub,scope,depth+1));}catch{verdict.raise('dangerous','a here-document runs commands that could not be parsed');}}
    }
  }
  return verdict.result();
}

function substitutions(text) {
  const found=[];
  for(let index=0;index<text.length;index++) {
    if(text[index]==='$' && text[index+1]==='(' && text[index+2]!=='('){const [inner,end]=readBalanced(text,index+2,'(',')');found.push(inner);index=end;}
    else if(text[index]==='`'){const end=text.indexOf('`',index+1);if(end<0)throw new ParseError('unterminated backquote');found.push(text.slice(index+1,end));index=end;}
  }
  return found;
}

/**
 * Classifies one bash command line. Options: workspaceRoot and cwd (absolute POSIX paths)
 * let the classifier tell writes inside the workspace from writes outside it.
 * Returns {risk:'read_only'|'normal'|'dangerous', reasons:string[], units:[{text,name,risk}]}.
 */
export function classifyCommand(command,options={}) {
  if(typeof command!=='string' || !command.trim())return {risk:'dangerous',reasons:['the command is empty or invalid'],units:[]};
  if(command.length>MAX_COMMAND || /\0/.test(command))return {risk:'dangerous',reasons:['the command is too long or contains a NUL byte'],units:[]};
  const scope=makeScope(options);
  const result=classifyCommandInner(command,scope,0);
  if(!result.units.length && result.risk==='read_only')return {...result,risk:'normal',reasons:['no command could be identified']};
  return result;
}

// ---------------------------------------------------------------------------
// Code snippets
// ---------------------------------------------------------------------------
const PY_SAFE_MODULES=new Set(['math','cmath','json','re','statistics','decimal','fractions','itertools','functools','collections','datetime','time','calendar','random','string','textwrap','hashlib','base64','uuid','operator','typing','dataclasses','enum','heapq','bisect','copy','pprint','unicodedata','zoneinfo','numbers','array','struct','binascii','difflib','colorsys','secrets']);
const CODE_RULES={
  python:[
    [/\b(?:subprocess|os\.system|os\.popen|os\.exec[lv]p?e?|os\.spawn\w*|os\.posix_spawn\w*|pty\.spawn|commands\.getoutput|asyncio\.create_subprocess_\w+)\b/,'dangerous','starts other commands; use the terminal tool so each command is reviewed'],
    [/\b(?:os\.(?:remove|unlink|rmdir|removedirs|truncate)|shutil\.(?:rmtree|move)|send2trash)\b|\.(?:unlink|rmdir)\s*\(/,'dangerous','deletes, moves or truncates files'],
    [/\b(?:os\.kill|os\.killpg|signal\.pthread_kill|psutil)\b/,'dangerous','kills or inspects other processes'],
    [/\b(?:os\.(?:chmod|chown|lchown|setuid|setgid|seteuid|setegid)|ctypes|cffi)\b/,'dangerous','changes permissions or loads native code'],
    [/\b(?:requests|httpx|aiohttp|session)\.(?:post|put|patch|delete|request)\s*\(|\burlopen\s*\([^)]*data\s*=|\bRequest\s*\([^)]*(?:data\s*=|method\s*=\s*['"](?:POST|PUT|PATCH|DELETE))|\b(?:smtplib|ftplib|telnetlib|paramiko|socketserver|socket)\b|\bhttp\.client\b/,'dangerous','sends data over the network'],
    [/\bkeyring\b|\bsecurity\s+find-|Keychain/,'dangerous','reads stored credentials'],
    [/\bwinreg\b|\bplistlib\.dump/,'normal','writes system or application settings'],
  ],
  node:[
    [/\bchild_process\b|\b(?:execSync|execFileSync|spawnSync|execFile|spawn|fork)\s*\(|\bexec\s*\(\s*['"`]|Bun\.spawn|Deno\.(?:run|Command)/,'dangerous','starts other commands; use the terminal tool so each command is reviewed'],
    [/\b(?:rmSync|rmdirSync|unlinkSync|truncateSync|renameSync)\b|\bfs(?:\.promises)?\.(?:rm|rmdir|unlink|truncate|rename)\b|\.(?:rm|rmdir|unlink)\s*\(|Deno\.remove/,'dangerous','deletes, moves or truncates files'],
    [/\bprocess\.kill\b/,'dangerous','kills other processes'],
    [/\b(?:chmodSync|chownSync|lchownSync)\b|\bfs(?:\.promises)?\.(?:chmod|chown)\b|process\.set[ug]id|process\.dlopen|\bffi\b/,'dangerous','changes permissions or loads native code'],
    [/\bmethod\s*:\s*['"`](?:POST|PUT|PATCH|DELETE)['"`]|\baxios\.(?:post|put|patch|delete)\b|\b(?:https?|http2)\.request\s*\(|\brequire\s*\(\s*['"](?:node:)?(?:net|dgram|tls)['"]\)|\bfrom\s+['"](?:node:)?(?:net|dgram|tls)['"]|\bnew\s+WebSocket\b|\bnodemailer\b/,'dangerous','sends data over the network'],
    [/\bkeytar\b|\bsecurity\s+find-|Keychain/,'dangerous','reads stored credentials'],
  ],
};
const PATH_LITERAL=/(['"`])((?:\/|~\/|\.\.\/)[^'"`\n]*)\1/g;
const WRITE_HINT={python:/\bopen\s*\([^)]*['"][wax+]|write_(?:text|bytes)\s*\(|\.(?:copy\w*|copytree|rename|replace|symlink_to|mkdir|touch)\s*\(|shutil\.copy|os\.(?:rename|replace|makedirs|mkdir|symlink|link)/,node:/\b(?:writeFile|appendFile|createWriteStream|copyFile|cp|mkdir|symlink|link|rename|open)(?:Sync)?\s*\(|Bun\.write|Deno\.write/};
const NETWORK_GET={python:/\b(?:requests|httpx|aiohttp)\.get\s*\(|\burlopen\s*\(|urllib\.request/,node:/\bfetch\s*\(|\b(?:https?|http2)\.get\s*\(|\baxios\b/};
const DYNAMIC={python:/\b(?:eval|exec|compile|__import__|importlib|getattr|globals|locals|vars|breakpoint)\s*\(|__\w+__/,node:/\b(?:eval|Function|require|import)\s*\(|\bnew\s+Function\b|\bvm\b|constructor|__proto__|globalThis|\bprocess\b|\bBuffer\b|\bimport\s/};

/**
 * Classifies a Python or Node snippet. Only pure computation with no file, process,
 * network or dynamic-code access is read_only; process control, deletion, data sends
 * and access to credentials, other machines or paths outside the workspace are dangerous.
 */
export function classifyCode(language,code) {
  const verdict=new Verdict();
  const lang=language==='javascript' || language==='js'?'node':language;
  if(!['python','node'].includes(lang)){verdict.raise('dangerous','unsupported language');return verdict.result();}
  if(typeof code!=='string' || !code.trim()){verdict.raise('dangerous','the code is empty or invalid');return verdict.result();}
  if(code.length>MAX_CODE || /\0/.test(code)){verdict.raise('dangerous','the code is too long or contains a NUL byte');return verdict.result();}
  for(const [pattern,risk,reason] of CODE_RULES[lang])if(pattern.test(code))verdict.raise(risk,reason);
  for(const match of code.matchAll(PATH_LITERAL)) {
    const value=match[2];
    if(isSensitive(value) || isSensitive(value.replace(/^~\//,'')))verdict.raise('dangerous',`touches a credential, key or shell profile (${bounded(value)})`);
    else if(DEVICE.test(value))continue;
    else if(WRITE_HINT[lang].test(code))verdict.raise('dangerous',`may write outside the workspace (${bounded(value)})`);
    else verdict.raise('normal',`reads ${bounded(value)} outside the workspace`);
  }
  for(const match of code.matchAll(/['"`]([^'"`\n]{1,200})['"`]/g))if(isSensitive(match[1]))verdict.raise('dangerous',`touches a credential, key or shell profile (${bounded(match[1])})`);
  if(/expanduser|Path\.home\s*\(|os\.homedir\s*\(|process\.env\.HOME|os\.environ\[['"]HOME/.test(code) && WRITE_HINT[lang].test(code))verdict.raise('dangerous','may write into the home folder');
  if(NETWORK_GET[lang].test(code)){verdict.raise('normal','reads from the network');if(DYNAMIC[lang].test(code) && /\b(?:eval|exec|Function|compile)\b/.test(code))verdict.raise('dangerous','runs code downloaded from the network');}
  if(verdict.risk==='read_only') {
    if(WRITE_HINT[lang].test(code))verdict.raise('normal','writes files');
    if(lang==='python') {
      if(/\bopen\s*\(|\bPath\s*\(|\bos\b|\bsys\b|\bglob\b|\bpathlib\b|\binput\s*\(/.test(code))verdict.raise('normal','reads files or the environment');
      for(const match of code.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+?)(?:\s+as\s+\w+)?\s*$)/gm)) {
        const modules=(match[1] || match[2]).split(',').map(name=>name.trim().split(/\s+/)[0].split('.')[0]).filter(Boolean);
        if(modules.some(name=>!PY_SAFE_MODULES.has(name)))verdict.raise('normal',`imports ${modules.filter(name=>!PY_SAFE_MODULES.has(name)).join(', ')}`);
      }
      if(/\bimport\b/.test(code.replace(/^\s*(?:from\s+[\w.]+\s+import[^\n]*|import\s+[^\n]*)$/gm,'')))verdict.raise('normal','uses a dynamic import');
    }
    if(DYNAMIC[lang].test(code))verdict.raise('normal',lang==='python'?'uses dynamic code or interpreter internals':'uses modules, the process object or dynamic code');
  }
  verdict.units.push({text:`${lang} snippet`,name:lang,risk:verdict.risk});
  return verdict.result();
}

/** Quotes argv for display and classification of literal executable/argument tools such as shell_run. */
export function shellQuote(argv) {
  return argv.map(value=>{const text=String(value);return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text)?text:`'${text.replaceAll("'","'\\''")}'`;}).join(' ');
}

/** Classifies a literal executable plus arguments (shell_run/shell_start) without shell interpretation. */
export function classifyArgv(executable,args=[],options={}) {
  if(typeof executable!=='string' || !executable || !Array.isArray(args))return {risk:'dangerous',reasons:['the command is invalid'],units:[]};
  return classifyCommand(shellQuote([executable,...args]),options);
}

export function riskRank(risk){return RANK[risk] ?? RANK.dangerous;}
