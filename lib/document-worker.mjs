import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_LIMITS, displayCell, escapeHTML, validateDocumentSpec } from './document-spec.mjs';
import { safeOfficeZip } from './document-zip.mjs';

// Documents never require network, subprocesses, user JS, filesystem writes or provider state.
// The parent additionally enforces Node filesystem permissions and a hard process deadline.
const require=createRequire(import.meta.url),deny=()=>{throw new Error('Network access is disabled in document workers.');};
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;
const tls=require('node:tls');tls.connect=deny;
// Every DNS entry point (callback, promise and Resolver forms) plus UDP and HTTP/2, so no lookup can carry data out either.
const dns=require('node:dns');for(const target of [dns,dns.promises,dns.Resolver.prototype,dns.promises.Resolver.prototype])for(const name of Object.getOwnPropertyNames(target))if(/^(lookup|resolve|reverse)/.test(name) && typeof target[name]==='function')target[name]=deny;
const dgram=require('node:dgram');dgram.createSocket=deny;require('node:http2').connect=deny;
globalThis.fetch=deny;globalThis.WebSocket=undefined;syncBuiltinESMExports();
// Parser diagnostics must never mix with the single JSON response on stdout.
console.log=console.info=console.warn=()=>{};
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),fonts=path.join(app,'assets','fonts');
const bad=(message,status=422)=>{const e=new Error(message);e.status=status;throw e;};
const many=v=>v===undefined?[]:Array.isArray(v)?v:[v];
const htmlText=s=>String(s).split(/\n\s*\n/).map(p=>`<p>${escapeHTML(p).replace(/\n/g,'<br>')}</p>`).join('');
const safeDocumentHTML=html=>html.replace(/<[^>]*>/g,tag=>{const match=tag.match(/^<(\/?)\s*([a-z][a-z0-9]*)\b/i);if(match?.[2].toLowerCase()==='img'){const source=tag.match(/\bsrc="(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)"/);return source?`<img src="${source[1]}" alt="Document image">`:'';}return match&&/^(p|h[1-6]|strong|em|ul|ol|li|table|tr|td|th|thead|tbody|br|blockquote|pre|code|sup|sub)$/.test(match[2].toLowerCase())?`<${match[1]}${match[2].toLowerCase()}>`:'';});
const clip=(s,n)=>String(s).slice(0,n);

async function parseXML(data){const {XMLParser}=await import('fast-xml-parser');return new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@',removeNSPrefix:false,transformTagName:name=>name.split(':').at(-1),parseTagValue:false,trimValues:false,processEntities:true}).parse(data.toString('utf8'));}
function findNodes(value,key,out=[]){if(!value||typeof value!=='object')return out;for(const [k,v]of Object.entries(value)){if(k===key)out.push(...many(v));else if(!k.startsWith('@'))for(const child of many(v))findNodes(child,key,out);}return out;}
function nodeText(node){if(typeof node==='string'||typeof node==='number')return String(node);if(!node||typeof node!=='object')return '';const texts=findNodes(node,'t');if(texts.length)return texts.map(n=>typeof n==='object'?n['#text']??'':String(n)).join('');return Object.hasOwn(node,'#text')?String(node['#text']):'';}
function externalWarnings(files){return [...files].some(([name,data])=>name.endsWith('.rels')&&/TargetMode\s*=\s*["']External["']/i.test(data.toString()))?['External relationships are ignored. Linked content was not fetched.']:[];}
function safeText(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{bad('Text documents must use UTF-8 encoding.');}}
const chartPrefix='HermesStudioChart:';
async function slideCharts(slide,files,slidePath,warnings){
  const blocks=[],seen=new Set();let cacheLimited=false;
  const add=chart=>{try{const normalized=validateDocumentSpec({title:'Chart',blocks:[{type:'chart',chart}]}).blocks[0].chart,key=JSON.stringify(normalized);if(!seen.has(key)&&blocks.length<20){seen.add(key);blocks.push({type:'chart',chart:normalized});}}catch{warnings.push('A presentation chart exceeds preview limits; download the presentation to inspect it.');}};
  for(const properties of findNodes(slide,'cNvPr')){const description=properties['@descr'];if(typeof description==='string'&&description.startsWith(chartPrefix)&&description.length<=100000)try{add(JSON.parse(description.slice(chartPrefix.length)));}catch{warnings.push('Invalid chart preview metadata was ignored.');}}
  const references=findNodes(slide,'chart');if(!references.length)return blocks;if(references.length>20)warnings.push('Presentation chart previews are limited to 20 charts per slide.');
  const relPath=path.posix.join(path.posix.dirname(slidePath),'_rels',path.posix.basename(slidePath)+'.rels');if(!files.has(relPath))return blocks;
  const relationships=new Map(many((await parseXML(files.get(relPath))).Relationships?.Relationship).map(r=>[r['@Id'],r]));
  const points=value=>{const result=new Map();for(const pt of findNodes(value,'pt')){const index=Number(pt['@idx']);if(Number.isInteger(index)&&index>=0&&index<60)result.set(index,String(pt.v??''));else if(index>=60&&!cacheLimited){cacheLimited=true;warnings.push('Presentation chart previews are limited to the first 60 categories.');}}return result;};
  for(const reference of references.slice(0,20)){
    const id=Object.entries(reference).find(([key])=>/^@[^:]+:id$/.test(key))?.[1],rel=relationships.get(id);if(!rel||rel['@TargetMode']==='External')continue;
    const raw=rel['@Target']||'',target=path.posix.normalize(raw.startsWith('/')?raw.slice(1):path.posix.join(path.posix.dirname(slidePath),raw));if(!/^ppt\/charts\/[^/]+\.xml$/.test(target)||!files.has(target))continue;
    const xml=await parseXML(files.get(target)),allSeries=findNodes(xml,'ser'),seriesNodes=allSeries.slice(0,8);if(allSeries.length>8)warnings.push('Presentation chart previews are limited to the first 8 series.');if(!seriesNodes.length){warnings.push('A presentation chart has no cached data; download it to inspect its linked values.');continue;}
    const categories=points(seriesNodes[0].cat??seriesNodes[0].xVal),values=seriesNodes.map(s=>points(s.val??s.yVal)),count=Math.min(60,Math.max(0,...categories.keys(),...values.flatMap(v=>[...v.keys()]))+1);
    if(!count)continue;
    const labels=Array.from({length:count},(_,i)=>clip(categories.get(i)??`Category ${i+1}`,100)),series=seriesNodes.map((s,j)=>({name:clip(nodeText(s.tx).trim()||findNodes(s.tx,'v').map(nodeText).join('').trim()||`Series ${j+1}`,100),values:labels.map((_,i)=>{const value=values[j].get(i);return value!==undefined&&value.trim()!==''&&Number.isFinite(Number(value))?Number(value):null;})}));
    const type=findNodes(xml,'barChart').length?'bar':findNodes(xml,'lineChart').length?'line':findNodes(xml,'pieChart').length?'pie':'';
    const title=clip(nodeText(findNodes(xml,'title')[0])||'Chart',200);
    if(type&&series.every(s=>s.values.every(v=>v!==null)))add({type,title,labels,series});
    else {blocks.push({type:'table',headers:['Category',...series.map(s=>s.name)],rows:labels.map((label,i)=>[label,...series.map(s=>s.values[i]??'')])});warnings.push('A presentation chart is shown as cached values; its full appearance is available in the downloaded presentation.');}
  }
  return blocks;
}

function csvRows(text){
  const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else if(!value||quoted)quoted=!quoted;else value+=c;}else if(c===','&&!quoted){row.push(value);value='';}else if((c==='\r'||c==='\n')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);rows.push(row);row=[];value='';}else value+=c;if(rows.length>50000||row.length>256)bad('CSV exceeds the row or column limits.');}
  if(quoted)bad('CSV contains an unterminated quoted field.');if(value||row.length)rows.push([...row,value]);if(rows.reduce((n,r)=>n+r.length,0)>DOCUMENT_LIMITS.cells)bad('CSV exceeds 50000 cells.');return rows;
}

async function inspect(request){
  const bytes=Buffer.from(request.data,'base64'),{format,maxChars,name}=request;
  if(bytes.length>DOCUMENT_LIMITS.inputBytes)bad('Document exceeds 20 MB.',413);
  let title=name,text='',preview,warnings=[];
  if(['txt','md','csv','json'].includes(format)){
    text=safeText(bytes);if(text.length>DOCUMENT_LIMITS.textChars)warnings.push('Text preview is limited to 200000 characters.');
    if(format==='json'){try{const data=JSON.parse(text);text=JSON.stringify(data,null,2);}catch{bad('This JSON document is invalid.');}}
    if(format==='csv'){
      if(text.length>DOCUMENT_LIMITS.textChars)bad('CSV text exceeds 200000 characters.',413);
      const rows=csvRows(text),budget=Math.max(1,Math.floor(maxChars/Math.max(1,Math.min(rows.length,200))));
      preview={kind:'spreadsheet',sheets:[{name:'CSV',rows:rows.slice(0,200).map(r=>r.map(v=>clip(v,Math.min(2000,budget)))),rowCount:rows.length,columnCount:Math.max(0,...rows.map(r=>r.length)),formulaCount:0}]};
      if(rows.length>200)warnings.push('Spreadsheet preview shows the first 200 rows.');
    }else preview={kind:'text',content:clip(text,maxChars)};
  }else if(format==='pdf'){
    if(bytes.subarray(0,5).toString()!=='%PDF-')bad('This is not a PDF document.');
    const {getDocumentProxy}=await import('unpdf');
    const pdf=await getDocumentProxy(new Uint8Array(bytes),{isEvalSupported:false,maxImageSize:1_000_000,disableFontFace:true,useSystemFonts:false,disableRange:true,disableStream:true});
    try{
      if(pdf.numPages>DOCUMENT_LIMITS.pages)bad('PDF exceeds 100 pages.',413);
      const pages=[];let remaining=maxChars;
      for(let n=1;n<=pdf.numPages;n++){
        const page=await pdf.getPage(n),content=await page.getTextContent({disableNormalization:false});
        const pageText=content.items.map(item=>item.str?(item.str+(item.hasEOL?'\n':' ')):'').join('').trim();
        if(text.length<DOCUMENT_LIMITS.textChars)text+=(text?'\n\n':'')+clip(pageText,DOCUMENT_LIMITS.textChars-text.length);
        pages.push({number:n,text:clip(pageText,Math.max(0,remaining))});remaining-=pages.at(-1).text.length;
        page.cleanup();
        if(text.length>=DOCUMENT_LIMITS.textChars){warnings.push('PDF text is limited to 200000 characters.');break;}
      }
      try{title=(await pdf.getMetadata()).info?.Title||name;}catch{}
      if(!text.trim())warnings.push('No extractable PDF text was found. Scanned pages require OCR, which is not included.');
      preview={kind:'document',pages,content:clip(text,maxChars),pageCount:pdf.numPages};
    }finally{if(typeof pdf.destroy==='function')await pdf.destroy();else if(pdf.loadingTask?.destroy)await pdf.loadingTask.destroy();else await pdf.cleanup?.();}
  }else{
    const files=safeOfficeZip(bytes);warnings=externalWarnings(files);
    if(files.has('docProps/core.xml'))try{title=nodeText((await parseXML(files.get('docProps/core.xml'))).coreProperties?.title)||name;}catch{}
    if(format==='docx'){
      if(!files.has('word/document.xml'))bad('This ZIP is not a Word document.');
      const documentXML=files.get('word/document.xml').toString();if((documentXML.match(/<(?:\w+:)?br\b[^>]*\b(?:\w+:)?type=["']page["']/g)||[]).length>=100)bad('Word document exceeds 100 explicit pages.',413);
      const mammoth=await import('mammoth'),result=await mammoth.extractRawText({buffer:bytes});
      text=result.value;let html=htmlText(clip(text,Math.min(maxChars,80000)));
      if(text.length<=maxChars){
        let imageBytes=0,imageChars=0;const imageConverter=mammoth.images.imgElement(async image=>{
          if(!['image/png','image/jpeg','image/webp'].includes(image.contentType)){warnings.push('Unsupported document image omitted from preview.');return {};}
          const data=await image.readAsBuffer(),png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=data[0]===255&&data[1]===216&&data[2]===255,webp=data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP';
          if(!({ 'image/png':png,'image/jpeg':jpeg,'image/webp':webp })[image.contentType]||data.length>1_000_000||imageBytes+data.length>3_000_000||imageChars+Math.ceil(data.length*4/3)>Math.max(0,450000-text.length*2)){warnings.push('A document image was omitted to keep the preview within its image and HTML limits.');return {};}
          const {default:sharp}=await import('sharp');const meta=await sharp(data,{limitInputPixels:20_000_000}).metadata();if(!meta.width||!meta.height||meta.width*meta.height>20_000_000){warnings.push('An oversized document image was omitted from preview.');return {};}
          imageBytes+=data.length;imageChars+=Math.ceil(data.length*4/3);return {src:`data:${image.contentType};base64,${data.toString('base64')}`};
        });
        const rich=await mammoth.convertToHtml({buffer:bytes},{externalFileAccess:false,includeEmbeddedStyleMap:false,styleMap:["p[style-name='Title'] => h1:fresh"],convertImage:imageConverter});
        warnings.push(...rich.messages.slice(0,8).map(m=>clip(m.message,300)));
        const sanitized=safeDocumentHTML(rich.value);if(sanitized.length<=500000)html=sanitized;else warnings.push('Rich HTML exceeded 500000 characters; a bounded text preview is shown.');
      }else warnings.push('Rich document preview is limited to the requested text length; embedded images are omitted from this truncated preview.');
      preview={kind:'document',html,content:clip(text,maxChars)};
      warnings.push(...result.messages.slice(0,8).map(m=>clip(m.message,300)));
    }else if(format==='pptx'){
      if(!files.has('ppt/presentation.xml'))bad('This ZIP is not a PowerPoint document.');
      if([...files.keys()].some(name=>/^ppt\/embeddings\/[^/]+\.xlsx$/i.test(name)))warnings.push('Chart values come from cached chart XML. Embedded workbooks are not opened or executed.');
      const presentation=await parseXML(files.get('ppt/presentation.xml')),rels=await parseXML(files.get('ppt/_rels/presentation.xml.rels'));
      const relationships=new Map(many(rels.Relationships?.Relationship).map(r=>[r['@Id'],r]));
      const order=many(presentation.presentation?.sldIdLst?.sldId);
      if(order.length>100)bad('Presentation exceeds 100 slides.',413);
      const slides=[];let remaining=maxChars;
      for(const [i,id]of order.entries()){
        const relationshipId=Object.entries(id).find(([key])=>/^@[^:]+:id$/.test(key))?.[1]??id['@id'];
        const rel=relationships.get(relationshipId);if(!rel||rel['@TargetMode']==='External')continue;
        const rawTarget=rel['@Target']||'',target=path.posix.normalize(rawTarget.startsWith('/')?rawTarget.slice(1):path.posix.join('ppt',rawTarget));
        if(!/^ppt\/slides\/slide\d+\.xml$/.test(target)||!files.has(target))bad('Invalid presentation slide relationship.');
        const xml=await parseXML(files.get(target)),paragraphs=findNodes(xml,'p').map(nodeText).filter(Boolean),charts=await slideCharts(xml,files,target,warnings),chartText=blocksText(charts),slideText=[paragraphs.join('\n'),chartText].filter(Boolean).join('\n');
        const tables=findNodes(xml,'tbl').map(t=>({type:'table',headers:[],rows:many(t.tr).map(r=>many(r.tc).map(nodeText))}));
        text+=(text?'\n\n':'')+`Slide ${i+1}\n${slideText}`;
        slides.push({number:i+1,title:clip(paragraphs[0]||`Slide ${i+1}`,300),text:clip(slideText,Math.max(0,remaining)),blocks:[...tables,...charts]});remaining-=slides.at(-1).text.length;
        if(text.length>DOCUMENT_LIMITS.textChars)bad('Presentation text exceeds 200000 characters.',413);
      }
      preview={kind:'slides',slides};
    }else if(format==='xlsx'){
      if(!files.has('xl/workbook.xml'))bad('This ZIP is not an Excel document.');
      const sheetFiles=[...files].filter(([n])=>/^xl\/worksheets\/[^/]+\.xml$/.test(n));
      if(sheetFiles.length>32)bad('Workbook exceeds 32 sheets.',413);
      let cellCount=0;
      for(const[,data]of sheetFiles){const xml=data.toString();cellCount+=(xml.match(/<(?:\w+:)?c(?:\s|>)/g)||[]).length;if(cellCount>50000||[...xml.matchAll(/<(?:\w+:)?row\s[^>]*\br=["'](\d+)["']/g)].some(m=>Number(m[1])>50000))bad('Workbook exceeds 50000 cells or rows.',413);}
      const {default:ExcelJS}=await import('exceljs'),book=new ExcelJS.Workbook();await book.xlsx.load(bytes);if(book.worksheets.length>32)bad('Workbook exceeds 32 sheets.',413);
      const sheets=[];let textBudget=DOCUMENT_LIMITS.textChars,previewBudget=maxChars,totalCells=0;
      for(const sheet of book.worksheets){
        const rows=[];let formulas=0,columnCount=0;const parts=[sheet.name];
        sheet.eachRow({includeEmpty:false},(row,rowNumber)=>{
          const values=[];row.eachCell({includeEmpty:false},(cell,col)=>{
            totalCells++;if(totalCells>50000||col>512)bad('Workbook exceeds the safe cell or column limits.',413);
            columnCount=Math.max(columnCount,col);let value=cell.value;
            if(value instanceof Date)value=value.toISOString();
            else if(value&&typeof value==='object'){
              if(value.formula||value.sharedFormula){formulas++;value=`=${value.formula||`shared ${value.sharedFormula}`} [${value.result!==undefined?`cached: ${displayCell(value.result)}`:'recalculation required'}]`;}
              else if(value.richText)value=value.richText.map(t=>t.text).join('');else if(value.error)value=value.error;else value=value.text??'';
            }
            const str=displayCell(value);if(str.length>4000)value=clip(str,4000);
            values[col-1]=value??null;
          });
          const rowText=values.map(displayCell).join('\t');if(textBudget>0){parts.push(clip(rowText,textBudget));textBudget-=rowText.length;}
          if(rows.length<200&&previewBudget>0){const clipped=values.map(v=>{if(v===undefined)return null;if(typeof v==='string'){const s=clip(v,Math.min(2000,Math.max(0,previewBudget)));previewBudget-=s.length;return s;}return v;});rows.push(clipped);}
        });
        if(sheet.actualRowCount>rows.length)warnings.push(`${sheet.name}: preview shows the first ${rows.length} populated rows.`);
        if(formulas)warnings.push(`${sheet.name}: ${formulas} formula cell(s); displayed results are cached and may require recalculation.`);
        sheets.push({name:sheet.name,rows,rowCount:sheet.rowCount,columnCount,formulaCount:formulas});text+=(text?'\n\n':'')+parts.join('\n');
      }
      preview={kind:'spreadsheet',sheets};
    }
  }
  const truncated=text.length>maxChars||warnings.some(w=>/limited|first \d|200000/.test(w));
  return {title:clip(title,300),text:clip(text,maxChars),preview,warnings:[...new Set(warnings)].slice(0,40),truncated};
}

async function markdownBlocks(content){
  if(!content)return [];
  const {lexer}=await import('marked'),out=[];
  const inline=t=>String(t).replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/`([^`]+)`/g,'$1');
  for(const token of lexer(content)){
    if(token.type==='space')continue;
    if(token.type==='heading')out.push({type:'heading',level:token.depth,text:inline(token.text)});
    else if(token.type==='table')out.push({type:'table',headers:token.header.map(x=>inline(x.text)),rows:token.rows.map(r=>r.map(x=>inline(x.text)))});
    else if(token.type==='list')out.push({type:'list',items:token.items.map(x=>inline(x.text))});
    else if(token.type==='hr')out.push({type:'paragraph',text:'—'});
    else out.push({type:'paragraph',text:inline(token.text??token.raw??'')});
  }
  return out;
}
async function documentBlocks(spec){return [...await markdownBlocks(spec.content),...(spec.blocks||[])];}
function paginationBlocks(blocks){const flow=[];for(const block of blocks){if(block.type==='page_break'){let index=flow.length;while(index&&flow[index-1].type==='heading')index--;flow.splice(index,0,block);}else flow.push(block);}return flow;}
function blocksText(blocks){return blocks.map(b=>b.type==='table'?[b.headers,...b.rows].filter(r=>r?.length).map(r=>r.map(displayCell).join('\t')).join('\n'):b.type==='list'?b.items.map(i=>`• ${i}`).join('\n'):b.type==='chart'?`${b.chart.title||b.chart.type+' chart'}\n${b.chart.labels.map((l,i)=>`${l}: ${b.chart.series.map(s=>`${s.name} ${s.values[i]}`).join(', ')}`).join('\n')}`:b.text??'').join('\n\n');}
const colors=['#3158a7','#23a98b','#e69b38','#9a65b8','#d45c75','#6a8e3e','#598ea9','#9c6f46'];
async function chartPNG(chart){
  const w=1100,h=610,left=85,top=65,pw=960,ph=400;let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="white"/><text x="30" y="35" font-family="Noto Sans,sans-serif" font-size="24" fill="#17253b">${escapeHTML(chart.title||'Chart')}</text>`;
  const values=chart.series.flatMap(s=>s.values),lo=Math.min(0,...values),hi=Math.max(0,...values),range=hi-lo||1;
  const y=v=>top+ph-(v-lo)/range*ph;
  if(chart.type==='pie'){
    const sum=values.reduce((a,b)=>a+b,0);let angle=-Math.PI/2;
    chart.labels.forEach((label,i)=>{const next=angle+values[i]/sum*Math.PI*2,x1=380+180*Math.cos(angle),y1=275+180*Math.sin(angle),x2=380+180*Math.cos(next),y2=275+180*Math.sin(next);if(values[i]===sum)svg+=`<circle cx="380" cy="275" r="180" fill="${colors[i%8]}"/>`;else if(values[i]>0)svg+=`<path d="M380 275 L${x1} ${y1} A180 180 0 ${next-angle>Math.PI?1:0} 1 ${x2} ${y2} Z" fill="${colors[i%8]}"/>`;svg+=`<rect x="660" y="${100+i*26}" width="14" height="14" fill="${colors[i%8]}"/><text x="684" y="${113+i*26}" font-family="sans-serif" font-size="16">${escapeHTML(clip(label,24))}: ${values[i]}</text>`;angle=next;});
  }else{
    for(let i=0;i<=4;i++){const v=lo+range*i/4,py=y(v);svg+=`<path d="M${left} ${py} H${left+pw}" stroke="#dde3ed"/><text x="${left-10}" y="${py+5}" text-anchor="end" font-family="sans-serif" font-size="14">${Number(v.toPrecision(4))}</text>`;}
    const step=pw/chart.labels.length;
    chart.labels.forEach((label,i)=>{if(chart.labels.length<=20||i%Math.ceil(chart.labels.length/20)===0)svg+=`<text x="${left+(i+.5)*step}" y="${top+ph+23}" text-anchor="middle" font-family="sans-serif" font-size="${chart.labels.length>12?11:14}">${escapeHTML(clip(label,14))}</text>`;});
    chart.series.forEach((series,j)=>{
      if(chart.type==='bar')series.values.forEach((v,i)=>{const bw=step*.8/chart.series.length,x=left+(i+.1)*step+j*bw,py=Math.min(y(v),y(0));svg+=`<rect x="${x}" y="${py}" width="${Math.max(1,bw-2)}" height="${Math.max(1,Math.abs(y(v)-y(0)))}" fill="${colors[j%8]}"/>`;});
      else{const points=series.values.map((v,i)=>`${left+(i+.5)*step},${y(v)}`).join(' ');svg+=`<polyline fill="none" stroke="${colors[j%8]}" stroke-width="3" points="${points}"/>`;series.values.forEach((v,i)=>{svg+=`<circle cx="${left+(i+.5)*step}" cy="${y(v)}" r="4" fill="${colors[j%8]}"/>`;});}
      svg+=`<rect x="${left+j*125}" y="535" width="15" height="15" fill="${colors[j%8]}"/><text x="${left+22+j*125}" y="548" font-family="sans-serif" font-size="14">${escapeHTML(clip(series.name,12))}</text>`;
    });
  }
  svg+='</svg>';const {default:sharp}=await import('sharp');return sharp(Buffer.from(svg),{limitInputPixels:1_000_000}).png().toBuffer();
}

async function createPDF(spec,blocks){
  const {default:PDFDocument}=await import('pdfkit');const doc=new PDFDocument({size:'A4',margin:48,bufferPages:true,info:{Title:spec.title,Author:'Tupies',Creator:'Tupies'}}),chunks=[];
  const done=new Promise((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  doc.registerFont('regular',path.join(fonts,'NotoSans-Regular.ttf'));doc.registerFont('bold',path.join(fonts,'NotoSans-Bold.ttf'));doc.font('regular');
  let pages=1;doc.on('pageAdded',()=>{if(++pages>100)bad('Generated PDF exceeds 100 pages.',413);});
  const width=doc.page.width-96,bottom=()=>doc.page.height-48,room=h=>{if(doc.y+h>bottom())doc.addPage();};
  doc.font('bold').fontSize(25).fillColor('#17253b').text(spec.title);if(spec.subtitle)doc.moveDown(.4).font('regular').fontSize(12).fillColor('#526174').text(spec.subtitle);doc.moveDown();
  for(const b of blocks){
    doc.x=48;
    if(b.type==='page_break'){doc.addPage();continue;}
    if(b.type==='chart'){room(295);doc.image(await chartPNG(b.chart),48,doc.y,{width,height:width*610/1100});doc.y+=width*610/1100+16;continue;}
    if(b.type==='table'){
      const count=Math.max(b.headers.length,...b.rows.map(r=>r.length)),cw=width/count,fontSize=count>8?7:9;
      const render=(row,header=false)=>{
        doc.font(header?'bold':'regular').fontSize(fontSize);
        const rowHeight=Math.max(24,...row.map(v=>doc.heightOfString(displayCell(v),{width:cw-12})+12));
        if(rowHeight>doc.page.height-120)bad('A table row is too tall for a PDF page. Split long cell contents into paragraphs.',400);
        if(doc.y+rowHeight>bottom()){doc.addPage();if(!header&&b.headers.length)render(b.headers,true);}
        const y=doc.y;for(let i=0;i<count;i++){doc.rect(48+i*cw,y,cw,rowHeight).fillAndStroke(header?'#e9eef8':'#ffffff','#d8dfe9');doc.fillColor('#17253b').text(displayCell(row[i]),54+i*cw,y+6,{width:cw-12,height:rowHeight-10});}doc.x=48;doc.y=y+rowHeight;
      };
      if(b.headers.length)render(b.headers,true);for(const row of b.rows)render(row);doc.moveDown();continue;
    }
    if(b.type==='heading'){room(60);doc.font('bold').fontSize(Math.max(12,22-b.level*2)).fillColor('#17253b').text(b.text,{width});doc.moveDown(.45);}
    else if(b.type==='list'){doc.font('regular').fontSize(10.5).fillColor('#17253b');for(const item of b.items)doc.text(`• ${item}`,{width,paragraphGap:5});doc.moveDown(.5);}
    else{doc.font('regular').fontSize(10.5).fillColor('#17253b').text(b.text,{width,paragraphGap:8,lineGap:2});doc.moveDown(.7);}
  }
  const range=doc.bufferedPageRange();for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);const margin=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.font('regular').fontSize(8).fillColor('#68758a').text(`${i+1} / ${range.count}`,48,doc.page.height-32,{width,height:15,align:'right',lineBreak:false});doc.page.margins.bottom=margin;}
  doc.end();return done;
}

async function createDOCX(spec,blocks){
  const d=await import('docx'),children=[];
  const para=(text,extra={})=>new d.Paragraph({...extra,children:[new d.TextRun({text,font:'Noto Sans'})]});
  children.push(para(spec.title,{heading:d.HeadingLevel.TITLE,spacing:{after:220},keepNext:true,keepLines:true}));if(spec.subtitle)children.push(para(spec.subtitle,{spacing:{after:280},keepNext:true,keepLines:true}));
  for(const b of paginationBlocks(blocks)){
    if(b.type==='page_break')children.push(new d.Paragraph({children:[new d.PageBreak()]}));
    else if(b.type==='heading')children.push(para(b.text,{heading:d.HeadingLevel[`HEADING_${b.level}`],spacing:{before:220,after:120},keepNext:true,keepLines:true}));
    else if(b.type==='list')for(const item of b.items)children.push(para(item,{bullet:{level:0},spacing:{after:90}}));
    else if(b.type==='table'){
      const rows=[...(b.headers.length?[b.headers]:[]),...b.rows];children.push(new d.Table({width:{size:100,type:d.WidthType.PERCENTAGE},rows:rows.map((r,i)=>new d.TableRow({tableHeader:i===0&&b.headers.length>0,children:r.map(v=>new d.TableCell({shading:i===0&&b.headers.length?{fill:'E9EEF8'}:undefined,children:[para(displayCell(v),{spacing:{after:80}})]}))}))}));children.push(para(''));
    }else if(b.type==='chart'){children.push(new d.Paragraph({children:[new d.ImageRun({type:'png',data:await chartPNG(b.chart),transformation:{width:600,height:333},altText:{title:b.chart.title||'Chart',description:blocksText([b]),name:'Data chart'}})]}));}
    else children.push(para(b.text,{spacing:{after:160},keepNext:false}));
  }
  const doc=new d.Document({title:spec.title,creator:'Tupies',styles:{default:{document:{run:{font:'Noto Sans',size:22},paragraph:{spacing:{line:300}}}}},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:850,right:850,bottom:850,left:850}}},children}]});
  return d.Packer.toBuffer(doc);
}

async function createPPTX(spec,blocks){
  const {default:PptxGenJS}=await import('pptxgenjs'),pptx=new PptxGenJS();pptx.layout='LAYOUT_WIDE';pptx.author='Tupies';pptx.subject=spec.subtitle||'';pptx.title=spec.title;pptx.company='';pptx.lang='en-US';pptx.theme={headFontFace:'Noto Sans',bodyFontFace:'Noto Sans',lang:'en-US'};
  const slides=spec.slides?.length?spec.slides:[{title:spec.title,blocks}];
  const makeSlide=title=>{const s=pptx.addSlide();s.background={color:'F8FAFD'};s.addShape(pptx.ShapeType.rect,{x:0,y:0,w:.16,h:7.5,fill:{color:'3158A7'},line:{color:'3158A7'}});s.addText(title,{x:.65,y:.42,w:12,h:.75,fontFace:'Noto Sans',fontSize:27,bold:true,color:'17253B',margin:0,breakLine:false,fit:'shrink'});return s;};
  let count=0;
  for(const input of slides){
    if(++count>100)bad('Generated presentation exceeds 100 slides.',413);let slide=makeSlide(input.title||spec.title),y=1.55;
    const items=paginationBlocks(input===slides[0]&&!spec.slides?[...(spec.subtitle?[{type:'paragraph',text:spec.subtitle}]:[]),...blocks]:await documentBlocks(input));let pendingHeading=false;
    const fresh=()=>{if(++count>100)bad('Generated presentation exceeds 100 slides.',413);slide=makeSlide(`${input.title||spec.title} (continued)`);y=1.55;pendingHeading=false;};
    const textLines=source=>{const lines=[];for(let line of String(source).split('\n')){while(line.length>95){let split=line.lastIndexOf(' ',95);if(split<35)split=95;lines.push(line.slice(0,split));line=line.slice(split).trimStart();}lines.push(line);}return lines;};
    for(const [blockIndex,b]of items.entries()){
      if(b.type==='page_break'){fresh();continue;}
      if(b.type==='chart'){if(y>1.6&&!pendingHeading)fresh();const height=Math.min(5.3,6.9-y),width=Math.min(11.85,height*1100/610);slide.addImage({data:`image/png;base64,${(await chartPNG(b.chart)).toString('base64')}`,altText:chartPrefix+JSON.stringify(b.chart),x:(13.333-width)/2,y,w:width,h:height});y=7;pendingHeading=false;continue;}
      if(b.type==='table'){
        const rows=b.rows.map(r=>r.map(displayCell)),header=b.headers.map(displayCell),perSlide=header.length?9:10,rowChunks=[];
        if(!rows.length&&header.length)rowChunks.push([header]);for(let i=0;i<rows.length;i+=perSlide)rowChunks.push([...(header.length?[header]:[]),...rows.slice(i,i+perSlide)]);
        for(const [chunkIndex,r]of rowChunks.entries()){if(chunkIndex||y>1.6&&!pendingHeading)fresh();slide.addTable(r,{x:.7,y,w:11.9,h:Math.min(4.8,6.9-y),fontFace:'Noto Sans',fontSize:Math.max(9,Math.min(16,130/(r[0]?.length||1))),border:{type:'solid',pt:.7,color:'CCD5E4'},fill:'FFFFFF',color:'17253B',margin:6,rowH:.4,autoPage:false,bold:false});y=7;pendingHeading=false;}continue;
      }
      const source=b.type==='list'?b.items.map(i=>`• ${i}`).join('\n'):b.text;
      // Count both explicit and wrapped lines: short bullet items still consume vertical space.
      const lines=textLines(source),heading=b.type==='heading',lineHeight=heading?.38:.31;
      if(heading){let index=blockIndex+1,following=0;while(items[index]?.type==='heading'){following+=Math.max(.45,textLines(items[index].text).length*.38+.18)+.22;index++;}const next=items[index];following+=next?.type==='table'?Math.min(4.8,(Math.min(9,next.rows.length)+(next.headers.length?1:0))*.4+.15):next?.type==='chart'?4.4:.8;if(y+Math.max(.45,lines.length*lineHeight+.18)+.22+following>6.9)fresh();}
      for(let offset=0;offset<lines.length;){let available=Math.floor((6.9-y-.18)/lineHeight);if(available<Math.min(2,lines.length-offset)){fresh();available=14;}const part=lines.slice(offset,offset+Math.min(14,available)),text=part.join('\n'),height=Math.max(.45,part.length*lineHeight+.18);slide.addText(text,{x:.75,y,w:11.8,h:Math.min(5.3,height),fontFace:'Noto Sans',fontSize:heading?21:17,bold:heading,color:'25354B',margin:0,breakLine:false,fit:'shrink',paraSpaceAfterPt:8});y+=height+.22;offset+=part.length;pendingHeading=heading;}
    }
  }
  return Buffer.from(await pptx.write({outputType:'nodebuffer'}));
}

function calculateSheet(rows,warnings){
  const memo=new Map(),visiting=new Set();
  const cellValue=(row,col)=>{
    const key=`${row}:${col}`;if(memo.has(key))return memo.get(key);if(visiting.has(key))throw new Error('Circular formula');
    visiting.add(key);const value=rows[row]?.[col];let result=value;
    if(value&&typeof value==='object'&&value.formula)result=evaluate(value.formula);
    visiting.delete(key);memo.set(key,result);return result;
  };
  const ref=token=>{const m=token.replaceAll('$','').match(/^([A-Z]+)(\d+)$/i);if(!m)throw new Error('Invalid reference');let col=0;for(const c of m[1].toUpperCase())col=col*26+c.charCodeAt(0)-64;const row=Number(m[2]);if(col>256||row>50000)throw new Error('Reference outside limits');return [row-1,col-1];};
  const evaluate=formula=>{
    // Exponent precedence varies between spreadsheet engines; retain the real formula uncached.
    if(formula.includes('^'))throw new Error('Exponent formulas require spreadsheet recalculation');
    const tokens=formula.toUpperCase().replaceAll('$','').match(/\d+(?:\.\d+)?|[A-Z]+\d*|[()+\-*/^,:]/g)||[];if(tokens.length>400)throw new Error('Formula too complex');let at=0;
    const numeric=v=>{if(Array.isArray(v))throw new Error('Expected a number');if(v===null||v===undefined||v==='')return 0;if(typeof v==='number'&&Number.isFinite(v))return v;throw new Error('Expected numeric data');};
    const expression=(minimum=0)=>{
      let token=tokens[at++],left;
      if(token==='+'||token==='-')left=(token==='-'?-1:1)*numeric(expression(4));
      else if(token==='('){left=expression();if(tokens[at++]!==')')throw new Error('Unclosed expression');}
      else if(/^\d/.test(token||''))left=Number(token);
      else if(/^[A-Z]+\d+$/.test(token||'')){
        const [r,c]=ref(token);
        if(tokens[at]===':'){at++;const [r2,c2]=ref(tokens[at++]);if((r2-r+1)*(c2-c+1)>50000||r2<r||c2<c)throw new Error('Range too large');left=[];for(let rr=r;rr<=r2;rr++)for(let cc=c;cc<=c2;cc++)left.push(cellValue(rr,cc));}
        else left=cellValue(r,c);
      }else if(/^[A-Z]+$/.test(token||'')&&tokens[at++]==='('){
        const args=[];if(tokens[at]!==')'){do{args.push(expression());if(tokens[at]!==',')break;at++;}while(true);}if(tokens[at++]!==')')throw new Error('Unclosed function');
        const vals=args.flat(),nums=vals.filter(v=>typeof v==='number'&&Number.isFinite(v));
        if(token==='SUM')left=nums.reduce((a,b)=>a+b,0);else if(token==='AVERAGE'){if(!nums.length)throw new Error('No numeric cells');left=nums.reduce((a,b)=>a+b,0)/nums.length;}else if(token==='MIN')left=nums.length?Math.min(...nums):0;else if(token==='MAX')left=nums.length?Math.max(...nums):0;else if(token==='COUNT')left=nums.length;else if(token==='COUNTA')left=vals.filter(v=>v!==null&&v!==undefined&&v!=='').length;else if(token==='ABS'){if(args.length!==1)throw new Error('ABS needs one argument');left=Math.abs(numeric(args[0]));}else if(token==='ROUND'){if(args.length!==2)throw new Error('ROUND needs two arguments');const places=Math.trunc(numeric(args[1])),value=numeric(args[0]);if(Math.abs(places)>12)throw new Error('Rounding exceeds limits');left=Math.sign(value)*Math.round((Math.abs(value)+Number.EPSILON)*10**places)/10**places;}else throw new Error('Unknown function');
      }else throw new Error('Invalid formula');
      const precedence={'+':1,'-':1,'*':2,'/':2,'^':3};
      while(precedence[tokens[at]]>=minimum){const op=tokens[at++],right=expression(precedence[op]+(op==='^'?0:1)),a=numeric(left),b=numeric(right);left=op==='+'?a+b:op==='-'?a-b:op==='*'?a*b:op==='/'?a/b:a**b;}
      return left;
    };
    const result=expression();if(at!==tokens.length||typeof result!=='number'||!Number.isFinite(result))throw new Error('Formula needs recalculation');return result;
  };
  return rows.map((row,r)=>row.map((v,c)=>{
    if(!v||typeof v!=='object'||!v.formula)return v;
    try{return {formula:v.formula,result:cellValue(r,c)};}catch{visiting.clear();warnings.push(`Formula ${v.formula} needs recalculation in Excel or another spreadsheet application.`);return {formula:v.formula};}
  }));
}

async function createXLSX(spec,blocks,warnings){
  const {default:ExcelJS}=await import('exceljs'),book=new ExcelJS.Workbook();book.creator='Tupies';book.title=spec.title;book.calcProperties.fullCalcOnLoad=true;
  let literalFormulas=0;
  const tables=blocks.filter(b=>b.type==='table'),sheets=spec.sheets?.length?spec.sheets:tables.length?tables.map((b,i)=>({name:`Sheet ${i+1}`,rows:[...(b.headers.length?[b.headers]:[]),...b.rows]})):[{name:'Document',rows:[[spec.title],...(spec.subtitle?[[spec.subtitle]]:[]),...blocksText(blocks).split('\n').map(v=>[v])]}];
  for(const input of sheets){const sheet=book.addWorksheet(input.name,{views:[{state:'frozen',ySplit:1}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,margins:{left:.3,right:.3,top:.35,bottom:.35,header:.15,footer:.15}}});sheet.addRows(calculateSheet(input.rows,warnings));sheet.getRow(1).font={name:'Noto Sans',bold:true,color:{argb:'FF17253B'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE9EEF8'}};sheet.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};row.eachCell(cell=>{cell.font={name:'Noto Sans',size:11,...(row.number===1?{bold:true}:{})};if(typeof cell.value==='string'&&/^\s*=/.test(cell.value))literalFormulas++;const value=typeof cell.value==='object'?cell.value?.result:cell.value;if(typeof value==='number'&&!Number.isInteger(value))cell.numFmt='0.00';});});
    for(let c=1;c<=sheet.columnCount;c++)sheet.getColumn(c).width=Math.min(55,Math.max(14,...input.rows.slice(0,150).map(r=>displayCell(r[c-1]).length+3)));sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:Math.max(1,sheet.columnCount)}};
  }
  const charts=blocks.filter(b=>b.type==='chart'),printColumns=new Map();if(charts.length){let sheet=book.worksheets[0],anchor=sheet.rowCount+3;for(const b of charts){sheet.getRow(anchor).addPageBreak();const image=book.addImage({buffer:await chartPNG(b.chart),extension:'png'});sheet.addImage(image,{tl:{col:0,row:anchor},ext:{width:880,height:488}});let pixels=0,col=0;while(pixels<900){col++;const column=sheet.getColumn(col);if(!column.width)column.width=14;pixels+=column.width*7+5;}printColumns.set(sheet.name,Math.max(printColumns.get(sheet.name)||0,col));anchor+=29;sheet.getCell(anchor+1,1).value=b.chart.title||'Chart data';sheet.getRow(anchor+2).values=['Label',...b.chart.series.map(s=>s.name)];for(let i=0;i<b.chart.labels.length;i++)sheet.getRow(anchor+3+i).values=[b.chart.labels[i],...b.chart.series.map(s=>s.values[i])];anchor+=b.chart.labels.length+6;}}
  const columnName=column=>{let name='';while(column){column--;name=String.fromCharCode(65+column%26)+name;column=Math.floor(column/26);}return name;};for(const sheet of book.worksheets){const column=Math.max(1,sheet.columnCount,printColumns.get(sheet.name)||0);sheet.pageSetup.printArea=`A1:${columnName(column)}${Math.max(1,sheet.rowCount)}`;sheet.pageSetup.printTitlesRow='1:1';}
  if(literalFormulas)warnings.push(`${literalFormulas} cell(s) beginning with "=" were preserved as literal text. Use a formula object such as {"formula":"SUM(B2:B4)"} for calculated spreadsheet formulas.`);
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function create(request){
  const spec=validateDocumentSpec(request.document),blocks=await documentBlocks(spec),warnings=[];let bytes;
  if(['pdf','docx','pptx'].includes(request.format)&&blocks.filter(b=>b.type==='page_break').length>=100)bad('Documents support at most 99 explicit page breaks.',413);
  if(request.format==='pdf')bytes=await createPDF(spec,blocks);
  else if(request.format==='docx')bytes=await createDOCX(spec,blocks);
  else if(request.format==='pptx')bytes=await createPPTX(spec,blocks);
  else if(request.format==='xlsx')bytes=await createXLSX(spec,blocks,warnings);
  else if(request.format==='json')bytes=Buffer.from(JSON.stringify(spec,null,2)+'\n');
  else if(request.format==='csv'){
    const table=spec.sheets?.[0]?.rows??blocks.find(b=>b.type==='table');const rows=Array.isArray(table)?table:table?[...(table.headers.length?[table.headers]:[]),...table.rows]:[[spec.title],...blocksText(blocks).split('\n').map(x=>[x])];
    const safe=v=>{let s=displayCell(v);if(/^[\s]*[=+@-]/.test(s)&&!(typeof v==='number')){s="'"+s;warnings.push('Spreadsheet-like CSV values were prefixed with an apostrophe to prevent formula execution.');}return /[,"\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};bytes=Buffer.from(rows.map(r=>r.map(safe).join(',')).join('\r\n')+'\r\n');
  }else if(request.format==='md'){
    const rendered=(spec.blocks||[]).map(b=>b.type==='heading'?'#'.repeat(b.level)+' '+b.text:b.type==='list'?b.items.map(i=>'- '+i).join('\n'):b.type==='table'?[...(b.headers.length?[b.headers,b.headers.map(()=>'---')]:[]),...b.rows].map(r=>'| '+r.map(v=>displayCell(v).replaceAll('|','\\|')).join(' | ')+' |').join('\n'):b.type==='chart'?'```chart\n'+JSON.stringify(b.chart,null,2)+'\n```':b.type==='page_break'?'---':b.text).join('\n\n');
    const prelude=/^\s{0,3}#\s/.test(spec.content||'')?'':`# ${spec.title}`;bytes=Buffer.from([prelude,spec.subtitle,spec.content,rendered].filter(v=>v!==undefined&&v!=='').join('\n\n')+'\n');
  }else bytes=Buffer.from([spec.title,spec.subtitle,blocksText(blocks)].filter(Boolean).join('\n\n')+'\n');
  if(bytes.length>DOCUMENT_LIMITS.outputBytes)bad('Document output exceeds 20 MB.',413);return {data:bytes.toString('base64'),warnings:[...new Set(warnings)].slice(0,40)};
}

// An attached image fitted for a model: oriented, within a 1568px edge and about 1.15 megapixels (where providers stop
// resizing on their side). A PNG or transparent image stays PNG, so screenshot text stays sharp, unless it is still too
// large; everything else becomes JPEG.
const IMAGE_EDGE=1568,IMAGE_PIXELS=1_150_000,IMAGE_BYTES=3_500_000;
async function image(request){
  const data=Buffer.from(String(request.data||''),'base64');
  const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=data[0]===255&&data[1]===216&&data[2]===255,webp=data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP';
  if(!(png||jpeg||webp))bad('Only PNG, JPEG and WebP images can be shown to a model.',415);
  const {default:sharp}=await import('sharp'),meta=await sharp(data,{limitInputPixels:40_000_000}).metadata();
  if(!meta.width||!meta.height)bad('The image has no readable size.',422);
  const turned=(meta.orientation||1)>=5,width=turned?meta.height:meta.width,height=turned?meta.width:meta.height;
  const scale=Math.min(1,IMAGE_EDGE/Math.max(width,height),Math.sqrt(IMAGE_PIXELS/(width*height)));
  const size={width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
  const fitted=()=>sharp(data,{limitInputPixels:40_000_000}).rotate().resize(size.width,size.height,{fit:'fill'});
  let output=png||meta.hasAlpha?await fitted().png({compressionLevel:9}).toBuffer():null,mediaType='image/png';
  if(!output||output.length>IMAGE_BYTES){output=await fitted().flatten({background:'#ffffff'}).jpeg({quality:85}).toBuffer();mediaType='image/jpeg';}
  if(output.length>IMAGE_BYTES)bad('The image is too large to show to a model, even after resizing.',413);
  return {mediaType,data:output.toString('base64'),...size,bytes:output.length};
}

let inputBytes=0;const inputChunks=[];for await(const chunk of process.stdin){inputBytes+=chunk.length;if(inputBytes>30_000_000)bad('Worker input exceeds its limit.',413);inputChunks.push(chunk);}const input=Buffer.concat(inputChunks).toString('utf8');
try{const request=JSON.parse(input),result=request.operation==='inspect'?await inspect(request):request.operation==='create'?await create(request):request.operation==='image'?await image(request):bad('Unknown document operation.');process.stdout.write(JSON.stringify({ok:true,result}));}
catch(error){process.stdout.write(JSON.stringify({ok:false,status:error.status||422,error:clip(error.message||'Document processing failed.',500)}));}
