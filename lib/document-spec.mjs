/** Declarative, bounded document input. No HTML, script, URLs or arbitrary assets run. */
export const DOCUMENT_LIMITS=Object.freeze({inputBytes:20_000_000,outputBytes:20_000_000,textChars:200_000,pages:100,sheets:32,cells:50_000,zipEntries:4000,zipBytes:60_000_000});
export const FORMATS=Object.freeze({pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',md:'text/markdown; charset=utf-8',txt:'text/plain; charset=utf-8',csv:'text/csv; charset=utf-8',json:'application/json; charset=utf-8'});
const fail=message=>{const e=new Error(message);e.status=400;throw e;};
const object=(v,label,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail(`${label} must be an object with supported fields only.`);};
const array=(v,label,max)=>{if(!Array.isArray(v)||v.length>max)fail(`${label} must be an array with at most ${max} items.`);return v;};
const string=(v,label,max=10000)=>{if(typeof v!=='string'||v.length>max||v.includes('\0'))fail(`${label} must be text up to ${max} characters.`);return v;};
export function validateFormula(value){
  const f=string(value,'Formula',500).replace(/^=/,'').trim();
  if(!f||!/^[$A-Z0-9:+\-*/^().,\s]+$/i.test(f))fail('Formulas support local cell references, arithmetic and safe aggregate functions only.');
  const functions=[...f.matchAll(/([A-Z]+)\s*\(/gi)].map(x=>x[1].toUpperCase());
  if(functions.some(fn=>!['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','ROUND','ABS'].includes(fn)))fail('This spreadsheet function is not supported. External links and executable formulas are prohibited.');
  // Bare names must be ordinary cell references, not named external or dynamic values.
  const bare=f.replace(/[A-Z]+\s*\(/gi,'(').match(/[A-Z]+\d*/gi)||[];
  if(bare.some(v=>!/^([A-Z]{1,3})[1-9]\d{0,6}$/i.test(v)))fail('Use bounded local cell references in formulas.');
  return f;
}
export function validateDocumentSpec(input){
  object(input,'Document',['title','subtitle','content','blocks','slides','sheets']);
  let chars=0,cells=0;
  const text=(v,label,max)=>{const s=string(v,label,max);chars+=s.length;if(chars>DOCUMENT_LIMITS.textChars)fail('Document text exceeds 200000 characters.');return s;};
  const cell=v=>{cells++;if(cells>DOCUMENT_LIMITS.cells)fail('Document exceeds 50000 cells.');if(v===null||typeof v==='boolean')return v;if(typeof v==='number'&&Number.isFinite(v))return v;if(v instanceof Date&&Number.isFinite(v.valueOf()))return v.toISOString();if(typeof v==='string')return text(v,'Cell',4000);object(v,'Cell',['formula']);return {formula:validateFormula(v.formula)};};
  const chart=value=>{
    object(value,'Chart',['type','title','labels','series','datasets']);
    if(!['bar','line','pie'].includes(value.type))fail('Choose a bar, line or pie chart.');
    const labels=array(value.labels,'Chart labels',60).map(v=>text(v,'Chart label',100));if(!labels.length)fail('Charts need labels.');
    if(value.series&&value.datasets)fail('Use either chart series or datasets.');
    const series=array(value.series??value.datasets,'Chart series',8).map(s=>{object(s,'Chart series',['name','label','values']);const name=text(s.name??s.label??'Series','Series name',100);const values=array(s.values,'Chart values',60);if(values.length!==labels.length||values.some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e15))fail('Chart values must be finite numbers matching its labels.');return {name,values};});
    if(!series.length||value.type==='pie'&&(labels.length>16||series.length!==1||series[0].values.some(v=>v<0)||!series[0].values.some(v=>v>0)))fail('Pie charts require at most 16 labels and one series of nonnegative values with a positive total.');
    return {type:value.type,title:value.title===undefined?'':text(value.title,'Chart title',200),labels,series};
  };
  const blocks=values=>array(values,'Blocks',1000).map(b=>{
    object(b,'Block',['type','text','level','headers','rows','items','chart']);
    if(!['heading','paragraph','table','list','chart','page_break'].includes(b.type))fail('Unsupported document block type.');
    if(b.type==='page_break')return {type:b.type};
    if(b.type==='chart')return {type:b.type,chart:chart(b.chart)};
    if(b.type==='table'){
      const headers=array(b.headers??[],'Table headers',20).map(cell),rows=array(b.rows,'Table rows',1000).map(r=>array(r,'Table row',20).map(cell));
      const width=Math.max(headers.length,...rows.map(r=>r.length),0);if(!width)fail('Tables need at least one column.');
      return {type:b.type,headers,rows};
    }
    if(b.type==='list')return {type:b.type,items:array(b.items,'List items',1000).map(i=>text(i,'List item',4000))};
    if(b.level!==undefined&&(!Number.isInteger(b.level)||b.level<1||b.level>6))fail('Heading levels must be 1–6.');
    return {type:b.type,text:text(b.text,'Block text',20000),...(b.type==='heading'?{level:b.level??2}:{})};
  });
  const out={title:text(input.title??'Untitled','Title',300)};
  if(input.subtitle!==undefined)out.subtitle=text(input.subtitle,'Subtitle',2000);
  if(input.content!==undefined)out.content=text(input.content,'Markdown content',180000);
  if(input.blocks!==undefined)out.blocks=blocks(input.blocks);
  if(input.slides!==undefined)out.slides=array(input.slides,'Slides',100).map(s=>{object(s,'Slide',['title','content','blocks']);return {title:text(s.title??'','Slide title',300),...(s.content!==undefined?{content:text(s.content,'Slide content',20000)}:{}),...(s.blocks!==undefined?{blocks:blocks(s.blocks)}:{})};});
  if(input.sheets!==undefined)out.sheets=array(input.sheets,'Sheets',32).map((s,i)=>{object(s,'Sheet',['name','rows']);const name=text(s.name??`Sheet ${i+1}`,'Sheet name',31);if(!name||/[\\/*?:\[\]]/.test(name))fail('Use a nonempty Excel sheet name without reserved characters.');return {name,rows:array(s.rows,'Sheet rows',50000).map(r=>array(r,'Sheet row',256).map(cell))};});
  if(out.sheets&&new Set(out.sheets.map(s=>s.name.toLowerCase())).size!==out.sheets.length)fail('Sheet names must be unique.');
  if(Buffer.byteLength(JSON.stringify(out))>1_000_000)fail('Document specification exceeds 1 MB.');
  return out;
}

export const displayCell=v=>v===null||v===undefined?'':typeof v==='object'&&v.formula?`=${v.formula}`:String(v);
export const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
