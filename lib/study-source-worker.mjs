import { createRequire, syncBuiltinESMExports } from 'node:module';
import { safeOfficeZip } from './document-zip.mjs';
import { fitStudyImage, renderStudyPdfPage } from './study-media.mjs';

// Sources are inert input. The parent supplies bytes and enforces an independent
// process deadline/heap/read allowlist. No workspace or credential state enters.
const require=createRequire(import.meta.url),deny=()=>{throw new Error('Study workers do not have network access.');};
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;
require('node:tls').connect=deny;
const dns=require('node:dns');for(const target of [dns,dns.promises,dns.Resolver.prototype,dns.promises.Resolver.prototype])for(const name of Object.getOwnPropertyNames(target))if(/^(lookup|resolve|reverse)/.test(name)&&typeof target[name]==='function')target[name]=deny;
require('node:dgram').createSocket=deny;require('node:http2').connect=deny;globalThis.fetch=deny;globalThis.WebSocket=undefined;syncBuiltinESMExports();
console.log=console.warn=console.info=()=>{};
const fail=message=>{throw new Error(message);};
async function extract(request){
  const bytes=Buffer.from(request.data,'base64');if(bytes.length>24_000_000)fail('Study source exceeds 24 MB.');
  if(request.operation==='image')return fitStudyImage(bytes);
  if(request.operation==='render')return renderStudyPdfPage(bytes,request.page,request.maxPages);
  if(request.format==='docx'){
    const files=safeOfficeZip(bytes);if(!files.has('word/document.xml'))fail('This is not a Word document.');
    const {extractRawText}=await import('mammoth'),result=await extractRawText({buffer:bytes});
    if(result.value.length>request.maxChars)fail('Document text exceeds the study source limit.');
    const warnings=[];
    if([...files.keys()].some(name=>/^word\/media\//.test(name)))warnings.push('Document images and diagrams require a separate visual/OCR adapter; only text was extracted.');
    if(/<(?:\w+:)?tbl\b/.test(files.get('word/document.xml').toString()))warnings.push('Word tables are represented as extracted text; original visual table layout is unavailable.');
    if([...files.entries()].some(([name,data])=>name.endsWith('.rels')&&/TargetMode\s*=\s*["']External["']/i.test(data.toString())))warnings.push('External linked content was not fetched.');
    return {text:result.value,warnings,visualsUnavailable:warnings.some(message=>message.startsWith('Document images'))};
  }
  if(request.format!=='pdf'||bytes.subarray(0,5).toString()!=='%PDF-')fail('Unsupported or invalid study document.');
  const {getDocumentProxy}=await import('unpdf');
  const {OPS}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf=await getDocumentProxy(new Uint8Array(bytes),{isEvalSupported:false,maxImageSize:1_000_000,disableFontFace:true,useSystemFonts:false,disableRange:true,disableStream:true});
  try{
    if(pdf.numPages>request.maxPages)fail('PDF exceeds the study page limit.');
    if(request.operation==='inventory')return {pages:pdf.numPages};
    const first=request.firstPage,last=request.lastPage;
    if(!Number.isInteger(first)||!Number.isInteger(last)||first<1||last<first||last>pdf.numPages||last-first>=16)fail('Invalid study PDF page range.');
    const pages=[];
    for(let number=first;number<=last;number++){
      let page;
      try{
        page=await pdf.getPage(number);const content=await page.getTextContent({disableNormalization:false});
        let text='',tooLong=false;
        for(const item of content.items){const part=item.str?(item.str+(item.hasEOL?'\n':' ')):'';if(text.length+part.length>200_000){tooLong=true;break;}text+=part;}
        const warnings=tooLong?['Page text exceeds 200000 characters; the remaining page text was not inspected.']:text.trim()?[]:['No extractable text on this page; OCR/visual inspection is unavailable.'];
        let visuals=false;
        try{const operators=await page.getOperatorList();visuals=operators.fnArray.some(op=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.constructPath].includes(op));if(visuals)warnings.push('PDF images or vector drawings were not interpreted; extracted text alone may omit visual evidence.');}catch{visuals=true;warnings.push('PDF visual coverage could not be checked; only extracted text is available.');}
        pages.push({page:number,text:text.trim(),status:text.trim()?(tooLong||visuals?'partial':'ready'):'unavailable',warnings});
      }catch{pages.push({page:number,text:'',status:'failed',warnings:['PDF page text extraction failed.']});}
      finally{page?.cleanup();}
    }
    return {pages};
  }finally{if(typeof pdf.destroy==='function')await pdf.destroy();else if(pdf.loadingTask?.destroy)await pdf.loadingTask.destroy();else await pdf.cleanup?.();}
}
let size=0;const chunks=[];
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>33_000_000)fail('Study worker input exceeds its limit.');chunks.push(chunk);}
  const request=JSON.parse(Buffer.concat(chunks).toString('utf8')),result=await extract(request);
  process.stdout.write(JSON.stringify({ok:true,result}));
}catch{process.stdout.write(JSON.stringify({ok:false,error:'The study document could not be extracted within its resource or format limits.'}));}
