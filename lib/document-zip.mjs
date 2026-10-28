import { inflateRawSync } from 'node:zlib';
import { DOCUMENT_LIMITS } from './document-spec.mjs';
const bad=message=>{const e=new Error(message);e.status=422;throw e;};
/** Validate central and local ZIP headers before allocating any expanded entry. */
export function safeOfficeZip(bytes){
  const b=Buffer.from(bytes);if(b.length<22)bad('This is not a valid Office ZIP document.');
  let end=-1;for(let n=b.length-22;n>=Math.max(0,b.length-65557);n--)if(b.readUInt32LE(n)===0x06054b50&&n+22+b.readUInt16LE(n+20)===b.length){end=n;break;}
  if(end<0)bad('Office ZIP directory is missing or invalid.');
  if(b.readUInt16LE(end+4)||b.readUInt16LE(end+6)||b.readUInt16LE(end+8)!==b.readUInt16LE(end+10))bad('Multipart ZIP documents are not supported.');
  const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
  if(count===65535||count>DOCUMENT_LIMITS.zipEntries||offset===0xffffffff||offset+size!==end)bad('Office ZIP directory exceeds the safe limits.');
  let cursor=offset,total=0;const entries=[],names=new Set(),spans=[];
  for(let i=0;i<count;i++){
    if(cursor+46>end||b.readUInt32LE(cursor)!==0x02014b50)bad('Invalid ZIP directory entry.');
    const flags=b.readUInt16LE(cursor+8),method=b.readUInt16LE(cursor+10),compressed=b.readUInt32LE(cursor+20),expanded=b.readUInt32LE(cursor+24),length=b.readUInt16LE(cursor+28),extra=b.readUInt16LE(cursor+30),comment=b.readUInt16LE(cursor+32),local=b.readUInt32LE(cursor+42);
    if(cursor+46+length+extra+comment>end)bad('Truncated ZIP directory entry.');
    const name=b.subarray(cursor+46,cursor+46+length).toString('utf8');
    if(!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||/^[a-z]:/i.test(name)||name.split('/').some(p=>p==='..'||p==='.'))bad('Unsafe ZIP entry path.');
    if(names.has(name.toLowerCase()))bad('Duplicate ZIP entries are prohibited.');names.add(name.toLowerCase());
    // Native PowerPoint charts carry an opaque XLSX data part. Do not open or recurse into it;
    // previews read only the separately bounded chart XML cache.
    const chartWorkbook=/^ppt\/embeddings\/[^/]+\.xlsx$/i.test(name);
    if(!name.endsWith('/')&&/vbaproject\.|\/embeddings\/|\.bin$/i.test(name)&&!chartWorkbook&&! /^(xl|ppt)\/printerSettings\/printerSettings\d+\.bin$/i.test(name))bad('Embedded binary objects and macros are not supported.');
    total+=expanded;
    if((flags&1)||![0,8].includes(method)||expanded>DOCUMENT_LIMITS.inputBytes||total>DOCUMENT_LIMITS.zipBytes||expanded>Math.max(1,compressed)*250)bad('Office ZIP compression exceeds safe limits.');
    if(local+30>offset||b.readUInt32LE(local)!==0x04034b50)bad('Invalid ZIP local header.');
    const localFlags=b.readUInt16LE(local+6),localMethod=b.readUInt16LE(local+8),localName=b.readUInt16LE(local+26),localExtra=b.readUInt16LE(local+28),start=local+30+localName+localExtra;
    if(localFlags!==flags||localMethod!==method||start+compressed>offset||b.subarray(local+30,local+30+localName).toString('utf8')!==name)bad('ZIP local and central headers disagree.');
    if(!(flags&8)&&(b.readUInt32LE(local+18)!==compressed||b.readUInt32LE(local+22)!==expanded))bad('ZIP local entry sizes disagree with the directory.');
    spans.push([local,start+compressed]);entries.push({name,method,compressed,expanded,start});cursor+=46+length+extra+comment;
  }
  if(cursor!==end)bad('ZIP directory size does not match its entries.');
  spans.sort((a,b)=>a[0]-b[0]);for(let i=1;i<spans.length;i++)if(spans[i][0]<spans[i-1][1])bad('Overlapping ZIP entries are prohibited.');
  const files=new Map();
  for(const entry of entries){
    const packed=b.subarray(entry.start,entry.start+entry.compressed);let data;
    try{data=entry.method===0?Buffer.from(packed):inflateRawSync(packed,{maxOutputLength:Math.max(1,entry.expanded)});}catch{bad('An Office ZIP entry failed bounded decompression.');}
    if(data.length!==entry.expanded)bad('ZIP expanded size does not match its directory.');
    if(/\.(xml|rels)$/i.test(entry.name)){
      if(data.includes(0)||data[0]===0xff||data[0]===0xfe)bad('Office XML must use UTF-8 without binary characters.');
      if(/<!\s*(DOCTYPE|ENTITY)\b/i.test(data.toString('utf8')))bad('XML entities and document type declarations are prohibited.');
    }
    files.set(entry.name,data);
  }
  if(!files.has('[Content_Types].xml'))bad('Office content types are missing.');
  return files;
}
