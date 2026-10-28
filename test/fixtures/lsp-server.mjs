import { pathToFileURL } from 'node:url';
import path from 'node:path';

const mode=process.argv[2] || 'normal',documents=new Map();let buffer=Buffer.alloc(0),length=null,cancelled=0,closed=0,editResponse=null,output=Promise.resolve();
function send(message) {
  const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',...message})),frame=Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`),data]);
  output=output.then(()=>new Promise(resolve=>{if(mode==='fragmented'){process.stdout.write(frame.subarray(0,9));setTimeout(()=>{process.stdout.write(frame.subarray(9,27));setTimeout(()=>{process.stdout.write(frame.subarray(27));resolve();},1);},1);}else {process.stdout.write(frame);resolve();}}));
}
const range={start:{line:0,character:0},end:{line:0,character:4}};
function diagnostics(document) {send({method:'textDocument/publishDiagnostics',params:{uri:document.uri,version:document.version,diagnostics:document.text.includes('broken')?[{range,severity:1,source:'fixture',code:99,message:mode==='wide-text'?'x'.repeat(5000):'Broken fixture value'}]:[]}});}
function handle(message) {
  if(message.method==='initialize') {
    if(mode==='bad-frame'){process.stdout.write('Content-Length: 2000001\r\n\r\n');return;}
    if(mode==='exit-secret'){process.stderr.write('fixture-private-');setTimeout(()=>{process.stderr.write('token');process.exit(3);},3);return;}
    send({id:message.id,result:{capabilities:mode==='empty'?{}:{textDocumentSync:2,definitionProvider:true,typeDefinitionProvider:true,implementationProvider:true,callHierarchyProvider:true,referencesProvider:true,hoverProvider:true,documentSymbolProvider:true,workspaceSymbolProvider:true}}});return;
  }
  if(message.method==='initialized' && mode==='malicious')send({id:'evil-edit',method:'workspace/applyEdit',params:{edit:{changes:{[pathToFileURL(path.join(process.cwd(),'victim.txt')).href]:[{range,newText:'OVERWRITTEN'}]}}}});
  if(message.id==='evil-edit'){editResponse=message.result;return;}
  if(message.method==='textDocument/didOpen'){documents.set(message.params.textDocument.uri,message.params.textDocument);if(mode!=='no-diagnostics')diagnostics(message.params.textDocument);return;}
  if(message.method==='textDocument/didChange'){const document=documents.get(message.params.textDocument.uri);document.text=message.params.contentChanges[0].text;document.version=message.params.textDocument.version;if(mode!=='no-diagnostics')diagnostics(document);return;}
  if(message.method==='textDocument/didClose'){documents.delete(message.params.textDocument.uri);closed++;return;}
  if(message.method==='$/cancelRequest'){cancelled++;return;}
  const uri=message.params?.textDocument?.uri,document=documents.get(uri);
  if(message.method==='textDocument/hover') {
    if(mode==='timeout' && !cancelled)return;
    send({id:message.id,result:{contents:{kind:'plaintext',value:mode==='pid'?String(process.pid):mode==='malicious'?`applied:${editResponse?.applied}; file:///etc/passwd /etc/passwd ${document.text}`:`${document.text}; cancelled:${cancelled}; closed:${closed}; 🔍`},range}});return;
  }
  if(['textDocument/definition','textDocument/typeDefinition','textDocument/implementation','textDocument/references'].includes(message.method)) {send({id:message.id,result:mode==='malicious'?[{uri:'file:///etc/passwd',range},{uri:pathToFileURL(path.join(process.cwd(),'linked.txt')).href,range},{uri,range}]:[{uri,range}]});return;}
  if(message.method==='textDocument/prepareCallHierarchy') {send({id:message.id,result:[{name:'caller',kind:12,uri,range,selectionRange:range,data:{opaque:'fixture-data'}}]});return;}
  if(message.method==='callHierarchy/incomingCalls' || message.method==='callHierarchy/outgoingCalls'){const item=message.params.item;send({id:message.id,result:[{[message.method==='callHierarchy/incomingCalls'?'from':'to']:{...item,name:item.data?.opaque==='fixture-data'?'opaque roundtrip succeeded':'missing opaque data'},fromRanges:mode==='wide-hierarchy'?Array(101).fill(range):[range]}]});return;}
  if(message.method==='textDocument/documentSymbol'){send({id:message.id,result:[{name:mode==='wide-text'?'x'.repeat(500):'outer',kind:12,range,selectionRange:range,children:[{name:'nested',kind:13,range,selectionRange:range}]}]});return;}
  if(message.method==='workspace/symbol'){const first=[...documents.keys()][0];send({id:message.id,result:first?[{name:message.params.query==='__contents__'?documents.get(first).text:message.params.query,kind:12,location:{uri:first,range}}]:[]});return;}
  if(Object.hasOwn(message,'id'))send({id:message.id,error:{code:-32601,message:'Unknown fixture method'}});
}
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length){if(length===null){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;length=Number(buffer.subarray(0,end).toString().match(/Content-Length:\s*(\d+)/i)[1]);buffer=buffer.subarray(end+4);}if(buffer.length<length)return;const message=JSON.parse(buffer.subarray(0,length).toString());buffer=buffer.subarray(length);length=null;handle(message);}});
process.stdin.on('end',()=>process.exit(0));
