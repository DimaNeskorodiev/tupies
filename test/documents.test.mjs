import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { inspectDocument, createDocument, supportedDocumentFormats, validateDocumentSpec } from '../lib/documents.mjs';
import { safeOfficeZip } from '../lib/document-zip.mjs';

async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hermes-documents-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {directory};}
const document={title:'Привіт — Quarterly report',subtitle:'Portable Unicode export',content:'## Results\n\nRevenue grew steadily.\n\n- Reviewed by the team\n- Figures supplied by the user',blocks:[{type:'table',headers:['Month','Revenue'],rows:[['January',12],['February',18]]},{type:'chart',chart:{type:'bar',title:'Revenue by month',labels:['January','February'],datasets:[{label:'Revenue',values:[12,18]}]}}],sheets:[{name:'Results',rows:[['Month','Revenue'],['January',12],['February',18],['Total',{formula:'SUM(B2:B3)'}],['Average',{formula:'AVERAGE(B2:B3)'}],['Arithmetic',{formula:'(B2+B3)*2'}]]}]};

test('native exports round trip all eight formats with Unicode, real charts and cached formulas',async t=>{
  const store=await fixture(t);
  for(const format of ['pdf','docx','pptx','xlsx','md','txt','csv','json'])await t.test(format,async()=>{
    const made=await createDocument(store,'bot_one',{path:`reports/quarter.${format}`,document});
    assert.equal(made.written,true);assert.ok(made.size>10);assert.equal(made.artifact.format,format);assert.match(made.artifact.downloadUrl,/path=reports%2Fquarter\./);
    const read=await inspectDocument(store,'bot_one',made.path);assert.equal(read.size,made.size);assert.equal(read.format,format);assert.equal(read.path,made.path);assert.ok(Array.isArray(read.warnings));
    if(format==='csv')assert.match(read.text,/January,12/);else if(format!=='xlsx')assert.match(read.text,/Привіт/);
    const file=path.join(store.directory,'workspaces','bot_one',made.path),bytes=await fs.readFile(file);
    if(['docx','pptx','xlsx'].includes(format)){const zip=safeOfficeZip(bytes);assert.ok([...zip.keys()].some(n=>/\/media\/.*\.png$/.test(n)));}
    if(format==='pdf'){assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.equal(read.preview.pageCount,1);assert.equal(read.preview.pages.length,1);assert.match(read.text,/Revenue grew/);}
    if(format==='docx'){assert.match(read.preview.html,/<h2>Results<\/h2>/);assert.match(read.preview.html,/<table>/);assert.match(read.preview.html,/<img src="data:image\/png;base64,/);assert.doesNotMatch(read.preview.html,/javascript:|onload=|style=/);assert.ok(read.preview.html.length<=500000);assert.match(read.text,/February/);}
    if(format==='pptx'){assert.ok(read.preview.slides.length>=2);const table=read.preview.slides.flatMap(s=>s.blocks).find(b=>b.type==='table');assert.deepEqual(table.rows[1],['January','12']);const chart=read.preview.slides.flatMap(s=>s.blocks).find(b=>b.type==='chart');assert.deepEqual(chart.chart.series[0].values,[12,18]);assert.match(read.text,/January: Revenue 12/);}
    if(format==='xlsx'){assert.match(read.text,/SUM\(B2:B3\) \[cached: 30\]/);assert.match(read.text,/AVERAGE\(B2:B3\) \[cached: 15\]/);assert.match(read.text,/\(B2\+B3\)\*2 \[cached: 60\]/);assert.equal(read.preview.sheets[0].formulaCount,3);}
  });
});

test('declarative validation rejects executable inputs, unsafe formulas and unbounded specs',()=>{
  assert.equal(supportedDocumentFormats().length,8);
  for(const formula of ['WEBSERVICE("https://example.com")','HYPERLINK(A1)','[other.xlsx]Sheet1!A1','DDE(A1)','INDIRECT(A1)','SUM(A1) & A2','cmd|calc!A1'])assert.throws(()=>validateDocumentSpec({title:'Bad',sheets:[{name:'Test',rows:[[{formula}]]}]}));
  assert.throws(()=>validateDocumentSpec({title:'Bad',html:'<script>run()</script>'}),/supported fields/);
  assert.throws(()=>validateDocumentSpec({title:'Bad',content:'x'.repeat(180001)}),/180000/);
  assert.throws(()=>validateDocumentSpec({title:'Bad',sheets:[{name:'A/B',rows:[]}]}),/sheet name/);
  assert.throws(()=>validateDocumentSpec({title:'Bad',sheets:[{name:'X',rows:[]},{name:'x',rows:[]}]}),/unique/);
  assert.throws(()=>validateDocumentSpec({title:'Bad',blocks:[{type:'chart',chart:{type:'pie',labels:['A'],series:[{name:'S',values:[-1]}]}}]}),/Pie charts/);
});

test('unsupported but safe formulas remain uncached and explicitly request recalculation',async t=>{
  const store=await fixture(t);const created=await createDocument(store,'bot_one',{path:'circular.xlsx',document:{title:'Formulas',sheets:[{name:'Data',rows:[[{formula:'B1'},{formula:'A1'}],[{formula:'1/0'}]]}]}});
  assert.ok(created.warnings.some(v=>/recalculation/.test(v)));const read=await inspectDocument(store,'bot_one',created.path);assert.match(read.text,/recalculation required/);assert.doesNotMatch(read.text,/cached: 0/);
});

test('safe formula caching handles references and negative rounding without inventing unsupported results',async t=>{
  const store=await fixture(t),made=await createDocument(store,'bot_one',{path:'formulas.xlsx',document:{title:'Formula results',sheets:[{name:'Data',rows:[[3,4],[{formula:'SUM(A1:B1)'},{formula:'ABS(-4)'}],[{formula:'ROUND(-1.5,0)'},{formula:'ROUND(1.005,2)'}],[{formula:'2^3^2'},{formula:'ROUND(5)'}]]}]}});const read=await inspectDocument(store,'bot_one',made.path);assert.match(read.text,/SUM\(A1:B1\) \[cached: 7\]/);assert.match(read.text,/ABS\(-4\) \[cached: 4\]/);assert.match(read.text,/ROUND\(-1.5,0\) \[cached: -2\]/);assert.match(read.text,/ROUND\(1.005,2\) \[cached: 1.01\]/);assert.match(read.text,/2\^3\^2 \[recalculation required\]/);assert.match(read.text,/ROUND\(5\) \[recalculation required\]/);
});

test('workspace isolation rejects traversal and symlinks and commits atomically with private permissions',async t=>{
  const store=await fixture(t),spec={title:'First',content:'Original'};
  for(const name of ['../escape.pdf','/absolute.pdf','nested/../../escape.pdf','a\\escape.pdf'])await assert.rejects(createDocument(store,'bot_one',{path:name,document:spec}));
  await assert.rejects(createDocument(store,'bot_one',{path:'legacy.xlsm',document:spec}),e=>e.status===415);
  await createDocument(store,'bot_one',{path:'document.txt',document:spec});
  const root=path.join(store.directory,'workspaces','bot_one');await fs.symlink('document.txt',path.join(root,'linked.txt'));
  await assert.rejects(inspectDocument(store,'bot_one','linked.txt'),/Symbolic/);await assert.rejects(createDocument(store,'bot_one',{path:'linked.txt',document:spec}),/Symbolic/);
  await fs.mkdir(path.join(root,'real'));await fs.symlink('real',path.join(root,'linked-dir'));
  await assert.rejects(createDocument(store,'bot_one',{path:'linked-dir/doc.pdf',document:spec}),/Symbolic/);
  await fs.mkdir(path.join(root,'directory.pdf'));await assert.rejects(createDocument(store,'bot_one',{path:'directory.pdf',document:spec}),e=>e.status===422);
  await fs.link(path.join(root,'document.txt'),path.join(root,'hardlink.txt'));await assert.rejects(createDocument(store,'bot_one',{path:'hardlink.txt',document:spec}),e=>e.status===422);await fs.unlink(path.join(root,'hardlink.txt'));
  await createDocument(store,'bot_one',{path:'document.txt',document:{title:'Second',content:'Replacement'}});assert.match((await inspectDocument(store,'bot_one','document.txt')).text,/Replacement/);
  assert.equal((await fs.stat(path.join(root,'document.txt'))).mode&0o777,0o600);assert.deepEqual((await fs.readdir(root)).filter(n=>n.startsWith('.document-')),[]);
  await assert.rejects(inspectDocument(store,'bot_two','document.txt'),e=>e.status===404);
});

function officeZip(extra={}){return Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),'word/document.xml':strToU8('<document><body><p><r><t>Safe</t></r></p></body></document>'),...extra}));}
test('ZIP preflight rejects entity expansion, traversal, macros, forged sizes and overlapping entries before libraries parse',async t=>{
  assert.ok(safeOfficeZip(officeZip()).has('word/document.xml'));
  assert.throws(()=>safeOfficeZip(officeZip({'../outside.xml':strToU8('bad')})),/entry path/);
  assert.throws(()=>safeOfficeZip(officeZip({'word/vbaProject.bin':new Uint8Array([1])})),/macros/);
  assert.throws(()=>safeOfficeZip(officeZip({'word/document.xml':strToU8('<!DOCTYPE x [<!ENTITY x "bad">]><document>&x;</document>')})),/entities/);
  assert.throws(()=>safeOfficeZip(officeZip({'word/document.xml':Buffer.from('\ufeff<!DOCTYPE x><document/>','utf16le')})),/UTF-8/);
  const bomb=officeZip();const central=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bomb.writeUInt32LE(60_000_001,central+24);assert.throws(()=>safeOfficeZip(bomb),/safe limits/);
  const duplicate=officeZip({'word/Document.xml':strToU8('duplicate')});assert.throws(()=>safeOfficeZip(duplicate),/Duplicate/);
  const store=await fixture(t);await createDocument(store,'bot_one',{path:'ready.txt',document:{title:'Ready'}});await fs.writeFile(path.join(store.directory,'workspaces','bot_one','attack.docx'),bomb);await assert.rejects(inspectDocument(store,'bot_one','attack.docx'),/safe limits/);
});

test('inspection limits, strict UTF-8 and harmless HTML preview apply to untrusted local files',async t=>{
  const store=await fixture(t);await createDocument(store,'bot_one',{path:'long.txt',document:{title:'Long',content:'abcdef '.repeat(200)}});const read=await inspectDocument(store,'bot_one','long.txt',{maxChars:100});assert.equal(read.text.length,100);assert.equal(read.truncated,true);assert.equal(read.preview.content.length,100);
  const root=path.join(store.directory,'workspaces','bot_one');await fs.writeFile(path.join(root,'binary.txt'),Buffer.from([0xff,0xfe,0]));await assert.rejects(inspectDocument(store,'bot_one','binary.txt'),/UTF-8/);
  const handle=await fs.open(path.join(root,'large.txt'),'w');await handle.truncate(20_000_001);await handle.close();await assert.rejects(inspectDocument(store,'bot_one','large.txt'),e=>e.status===413);
  await fs.writeFile(path.join(root,'bad.pdf'),'not a PDF');await assert.rejects(inspectDocument(store,'bot_one','bad.pdf'),/not a PDF/);
  await createDocument(store,'bot_one',{path:'html.docx',document:{title:'Untrusted',content:'<script>alert(1)</script>\n\n<img src="https://private.invalid/x">'}});const html=(await inspectDocument(store,'bot_one','html.docx')).preview.html;assert.doesNotMatch(html,/<script|<img/);assert.match(html,/&lt;script&gt;/);
});

test('cancellation kills a worker and never leaves a partial artifact',async t=>{
  const store=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(createDocument(store,'bot_one',{path:'pre.pdf',document},{signal:controller.signal}),e=>e.name==='AbortError');
  const active=new AbortController(),pending=createDocument(store,'bot_one',{path:'cancel.pdf',document:{title:'Cancellation',blocks:Array.from({length:300},(_,i)=>({type:'paragraph',text:`Paragraph ${i} `+'body '.repeat(40)}))}},{signal:active.signal});setTimeout(()=>active.abort(),30);await assert.rejects(pending,e=>e.name==='AbortError');
  const root=path.join(store.directory,'workspaces','bot_one');assert.equal((await fs.readdir(root)).some(n=>n==='cancel.pdf'||n.startsWith('.document-')),false);
});

test('CSV quotes cells and protects spreadsheet execution prefixes',async t=>{
  const store=await fixture(t),made=await createDocument(store,'bot_one',{path:'values.csv',document:{title:'CSV',sheets:[{name:'Data',rows:[['=SUM(1,2)','a,b','quote"text'],[-12,'@command','line\nwrap']]}]}});const read=await inspectDocument(store,'bot_one',made.path);assert.deepEqual(read.preview.sheets[0].rows,[["'=SUM(1,2)",'a,b','quote"text'],['-12',"'@command",'line\nwrap']]);assert.ok(made.warnings.length);
});

test('Markdown export preserves authored fences, code, links and formatting verbatim and fences explicit chart blocks',async t=>{
  const store=await fixture(t),content='# Authored title\n\n**Bold** and *emphasis* with [source](https://example.com).\n\n```js\nconst value = `kept`;\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```chart\n{"type":"bar","labels":["A"],"series":[{"name":"S","values":[3]}]}\n```\n',spec={title:'Fallback title',content,blocks:[{type:'chart',chart:{type:'line',title:'Explicit chart',labels:['A','B'],series:[{name:'Series',values:[3,4]}]}}]};await createDocument(store,'bot_one',{path:'authored.md',document:spec});const read=await inspectDocument(store,'bot_one','authored.md');assert.ok(read.text.includes(content));assert.ok(read.text.startsWith('# Authored title'));assert.doesNotMatch(read.text,/# Fallback title/);assert.equal((read.text.match(/```chart/g)||[]).length,2);assert.match(read.text,/"Explicit chart"/);
});

test('worker concurrency and backlog are bounded while admitted jobs complete',async t=>{
  const store=await fixture(t),jobs=Array.from({length:5},(_,i)=>createDocument(store,'bot_one',{path:`queued-${i}.pdf`,document:{title:`Queue ${i}`,content:'A worker produces a native PDF.'}}));
  const results=await Promise.allSettled(jobs);assert.equal(results.filter(r=>r.status==='fulfilled').length,4);const rejected=results.filter(r=>r.status==='rejected');assert.equal(rejected.length,1);assert.equal(rejected[0].reason.status,429);
});

test('PowerPoint uses presentation slide order and namespace-qualified IDs independent of attribute order',async t=>{
  const store=await fixture(t);await createDocument(store,'bot_one',{path:'ordered.pptx',document:{title:'Order',slides:[{title:'Alpha',content:'First source slide'},{title:'Beta',content:'Second source slide'}]}});const file=path.join(store.directory,'workspaces','bot_one','ordered.pptx'),entries=safeOfficeZip(await fs.readFile(file));
  let xml=entries.get('ppt/presentation.xml').toString();const tags=xml.match(/<p:sldId\s[^>]+>/g);assert.equal(tags.length,2);const reversed=tags.map(tag=>{const id=tag.match(/\bid="([^"]+)"/)[1],rid=tag.match(/\br:id="([^"]+)"/)[1];return `<p:sldId r:id="${rid}" id="${id}"/>`;}).reverse();let i=0;xml=xml.replace(/<p:sldId\s[^>]+>/g,()=>reversed[i++]);entries.set('ppt/presentation.xml',Buffer.from(xml));await fs.writeFile(file,zipSync(Object.fromEntries(entries)));
  const read=await inspectDocument(store,'bot_one','ordered.pptx');assert.equal(read.preview.slides[0].title,'Beta');assert.equal(read.preview.slides[1].title,'Alpha');assert.match(read.text,/Second source slide/);
});

test('long presentation lists continue onto readable slides without dropping their final items',async t=>{
  const store=await fixture(t),items=Array.from({length:80},(_,i)=>`Action ${i+1}: review the monthly plan.`);await createDocument(store,'bot_one',{path:'long-list.pptx',document:{title:'Actions',blocks:[{type:'list',items}]}});const read=await inspectDocument(store,'bot_one','long-list.pptx');assert.ok(read.preview.slides.length>=6);assert.match(read.text,/Action 1:/);assert.match(read.text,/Action 80:/);
});

test('native DOCX and PPTX keep headings with their following table or paragraph',async t=>{
  const store=await fixture(t),spec={title:'Layout',blocks:[{type:'paragraph',text:'Introductory paragraph.'},{type:'heading',level:2,text:'Monthly table'},{type:'table',headers:['Month','Value'],rows:[['Jan',12]]},{type:'heading',level:2,text:'Next steps'},{type:'page_break'},{type:'paragraph',text:'The action belongs with its heading.'}]};
  await createDocument(store,'bot_one',{path:'layout.docx',document:spec});const xml=safeOfficeZip(await fs.readFile(path.join(store.directory,'workspaces','bot_one','layout.docx'))).get('word/document.xml').toString();assert.match(xml,/<w:keepNext\/?\s*>/);assert.match(xml,/<w:keepLines\/?\s*>/);assert.ok(xml.indexOf('w:type="page"')<xml.indexOf('Next steps'));
  await createDocument(store,'bot_one',{path:'layout.pptx',document:spec});const read=await inspectDocument(store,'bot_one','layout.pptx');const tableSlide=read.preview.slides.find(s=>s.blocks.some(b=>b.type==='table'));assert.match(tableSlide.text,/Monthly table/);const nextSlide=read.preview.slides.find(s=>s.text.includes('Next steps'));assert.match(nextSlide.text,/The action belongs/);
});

test('native PowerPoint chart XML caches expose real categories and values without opening embedded workbooks',async t=>{
  const store=await fixture(t);await createDocument(store,'bot_one',{path:'seed.txt',document:{title:'Seed'}});const {default:PptxGenJS}=await import('pptxgenjs'),pptx=new PptxGenJS();const slide=pptx.addSlide();slide.addText('Native chart',{x:1,y:.2,w:8,h:.5});slide.addChart(pptx.ChartType.bar,[{name:'Revenue',labels:['July','August'],values:[84,96]}],{x:1,y:1,w:8,h:4});const file=path.join(store.directory,'workspaces','bot_one','native-chart.pptx');await fs.writeFile(file,await pptx.write({outputType:'nodebuffer'}));const read=await inspectDocument(store,'bot_one','native-chart.pptx'),chart=read.preview.slides[0].blocks.find(b=>b.type==='chart');assert.ok(chart);assert.deepEqual(chart.chart.labels,['July','August']);assert.deepEqual(chart.chart.series[0].values,[84,96]);assert.match(read.text,/July: Revenue 84/);assert.ok(read.warnings.some(w=>/Embedded workbooks are not opened/.test(w)));
});

test('spreadsheet print layout includes chart width and literal formula-like strings remain inert with a warning',async t=>{
  const store=await fixture(t),made=await createDocument(store,'bot_one',{path:'print.xlsx',document:{...document,sheets:[{name:'Print',rows:[['Month','Value'],['Jan',1.2345],['Literal','=SUM(B2:B2)'],['Real',{formula:'AVERAGE(B2:B2)'}]]}]}});assert.ok(made.warnings.some(w=>/preserved as literal text/.test(w)));const {default:ExcelJS}=await import('exceljs'),book=new ExcelJS.Workbook();await book.xlsx.readFile(path.join(store.directory,'workspaces','bot_one','print.xlsx'));const sheet=book.worksheets[0];assert.equal(sheet.pageSetup.orientation,'landscape');assert.equal(sheet.pageSetup.fitToWidth,1);assert.equal(sheet.pageSetup.fitToHeight,0);assert.match(sheet.pageSetup.printArea,/A1:[G-Z]/);assert.equal(sheet.getCell('B3').value,'=SUM(B2:B2)');assert.equal(sheet.getCell('B2').numFmt,'0.00');assert.equal(sheet.getCell('B4').numFmt,'0.00');
});

test('PDF page and workbook sheet/cell caps are checked before parsing fanout',async t=>{
  const store=await fixture(t);await createDocument(store,'bot_one',{path:'seed.txt',document:{title:'Seed'}});const root=path.join(store.directory,'workspaces','bot_one');
  await assert.rejects(createDocument(store,'bot_one',{path:'too-many.pdf',document:{title:'Pages',blocks:Array.from({length:100},()=>({type:'page_break'}))}}),e=>e.status===413);
  const {default:PDFDocument}=await import('pdfkit'),pdf=new PDFDocument(),parts=[];pdf.on('data',p=>parts.push(p));const end=new Promise(r=>pdf.on('end',r));for(let i=1;i<101;i++)pdf.addPage();pdf.end();await end;await fs.writeFile(path.join(root,'pages.pdf'),Buffer.concat(parts));await assert.rejects(inspectDocument(store,'bot_one','pages.pdf'),e=>e.status===413);
  const sheets={'[Content_Types].xml':strToU8('<Types/>'),'xl/workbook.xml':strToU8('<workbook/>')};for(let i=1;i<=33;i++)sheets[`xl/worksheets/sheet${i}.xml`]=strToU8('<worksheet/>');await fs.writeFile(path.join(root,'sheets.xlsx'),zipSync(sheets));await assert.rejects(inspectDocument(store,'bot_one','sheets.xlsx'),/32 sheets/);
  const cells={'[Content_Types].xml':strToU8('<Types/>'),'xl/workbook.xml':strToU8('<workbook/>'),'xl/worksheets/sheet1.xml':strToU8('<worksheet>'+('<c r="A1"><v>1</v></c>'.repeat(50001))+'</worksheet>')};await fs.writeFile(path.join(root,'cells.xlsx'),zipSync(cells,{level:0}));await assert.rejects(inspectDocument(store,'bot_one','cells.xlsx'),/50000 cells/);
});
