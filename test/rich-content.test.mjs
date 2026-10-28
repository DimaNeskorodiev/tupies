import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://studio.local/'});
globalThis.window=dom.window;globalThis.document=dom.window.document;
const rich=await import('../public/rich-content.mjs');
const fragment=html=>{const root=document.createElement('div');root.innerHTML=html;return root;};

test('chat Markdown renders headings, emphasis, lists, tables, quotes and highlighted fenced code',()=>{
  const html=rich.render('# A useful answer\n\n**Clear** and *considered*.\n\n- First\n- Second\n\n> A quote\n\n| Name | Value |\n| --- | --- |\n| Sample | 42 |\n\n```javascript\nconst answer = 42;\n```');
  const root=fragment(html);
  assert.equal(root.querySelector('h1').textContent,'A useful answer');assert.equal(root.querySelectorAll('li').length,2);
  assert.equal(root.querySelector('strong').textContent,'Clear');assert.ok(root.querySelector('blockquote'));assert.ok(root.querySelector('table'));
  assert.equal(root.querySelector('code').textContent,'const answer = 42;');assert.ok(root.querySelector('.hljs-keyword'));assert.equal(root.querySelector('[data-rich-action]').dataset.richAction,'copy-code');
});

test('untrusted HTML, URL schemes, images and event handlers cannot create active chat content',()=>{
  const html=rich.render('<script>alert(1)</script>\n\n<img src="https://tracker.invalid/a" onerror="alert(1)">\n\n[bad](javascript:alert(1)) [data](data:text/html,hello) [safe](https://example.com/hello)\n\n![private](https://tracker.invalid/pixel)');
  const root=fragment(html);
  assert.equal(root.querySelectorAll('script,img,iframe,object,style').length,0);
  assert.equal(root.querySelectorAll('a').length,1);assert.equal(root.querySelector('a').href,'https://example.com/hello');assert.equal(root.querySelector('a').rel,'noopener noreferrer');
  const sanitized=fragment(rich.safeHTML('<p style="background:url(https://tracker.invalid)">Safe</p><a href="javascript:alert(1)" onclick="alert(1)">bad</a><svg onload="alert(1)"></svg><iframe src="https://tracker.invalid"></iframe>'));
  assert.equal(sanitized.querySelectorAll('[style],[onclick],[onload],svg,iframe,[src]').length,0);assert.equal(sanitized.querySelector('a').hasAttribute('href'),false);
});

test('only validated same-server workspace file links are used for artifact downloads',()=>{
  assert.equal(rich.safeFileURL('/api/bots/bot_1/files/download?path=reports%2Fplan.pdf'),'/api/bots/bot_1/files/download?path=reports%2Fplan.pdf');
  for(const url of ['https://evil.invalid/api/bots/bot_1/files/download?path=plan.pdf','/api/bots/bot_1/files/download?path=..%2Fsecret','/api/bots/bot_1/files/view?path=%2Fetc%2Fpasswd','/api/bots/bot_1/files/view?path=folder%5Csecret','/api/logout'])assert.equal(rich.safeFileURL(url),'');
  const card=fragment(rich.attachmentMarkup({path:'reports/plan.pdf',name:'<img onerror=alert(1)>',downloadUrl:'javascript:alert(1)',format:'pdf',size:2048},'bot_1'));
  assert.ok(card.querySelector('[data-action="preview-document"]'));assert.match(card.querySelector('a').getAttribute('href'),/^\/api\/bots\/bot_1\/files\/download/);assert.equal(card.querySelectorAll('img').length,0);
});

test('charts accept only bounded declarative numeric data and support the export tool series schema',()=>{
  const spec=rich.chartSpec({type:'area',title:'Growth',labels:['Q1','Q2'],series:[{name:'Revenue',values:[3,5]}]});
  assert.deepEqual(spec.datasets,[{label:'Revenue',values:[3,5]}]);
  for(const input of [{type:'bubble',datasets:[{values:[1]}]},{type:'bar',labels:['A'],datasets:[{values:[1,2]}]},{type:'bar',datasets:[{values:[Infinity]}]},{type:'bar',datasets:[{values:Array(201).fill(1)}]},{type:'bar',datasets:[{values:[1]}],options:{onClick:'alert(1)'}},{type:'pie',datasets:[{values:[-1,2]}]}])assert.throws(()=>rich.chartSpec(input));
  const root=fragment(rich.render('```chart\n{"type":"line","labels":["Q1","Q2"],"datasets":[{"label":"Growth","values":[3,5]}]}\n```'));
  assert.equal(root.querySelector('[data-rich]').dataset.rich,'chart');assert.equal(JSON.parse(root.querySelector('.rich-source').textContent).title,undefined);
});

test('malformed and active diagram/visual blocks show recoverable source details',()=>{
  for(const code of ['```chart\n{invalid}\n```','```mermaid\nflowchart LR\nA-->B\nclick A "https://evil.invalid"\n```','```mermaid\n%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B\n```','```infographic\n{"title":"No metrics"}\n```']){
    const root=fragment(rich.render(code));assert.ok(root.querySelector('.rich-error summary'));assert.ok(root.querySelector('.rich-error pre'));assert.equal(root.querySelectorAll('script,iframe').length,0);
  }
  const large=rich.render(Array(30).fill('```chart\n{"type":"bar","datasets":[{"values":[1]}]}\n```').join('\n\n'));
  assert.equal(fragment(large).querySelectorAll('[data-rich="chart"]').length,20);assert.match(large,/too many visuals/);
});

test('infographics escape metric and step content and render polished data cards',()=>{
  const root=fragment(rich.render('```infographic\n'+JSON.stringify({title:'A clear picture',metrics:[{label:'Result',value:'42%',detail:'<script>bad</script>'}],steps:[{title:'Next',description:'Review together'}]})+'\n```'));
  assert.equal(root.querySelector('.rich-metrics strong').textContent,'42%');assert.equal(root.querySelectorAll('.rich-steps li').length,1);assert.equal(root.querySelectorAll('script').length,0);
});

test('math hydrates through KaTeX with trust disabled, and code can be copied',async()=>{
  const root=fragment(rich.render('Inline $x^2 + y^2$ and a formula.\n\n$$\\frac{a}{b}$$\n\n```txt\nhello <world>\n```'));document.body.append(root);
  let copied;Object.defineProperty(globalThis.navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copied=value;}}});
  await rich.hydrate(root);assert.equal(root.querySelectorAll('.katex').length,2);assert.equal(root.querySelectorAll('script,iframe,img').length,0);
  root.querySelector('[data-rich-action="copy-code"]').click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(copied,'hello <world>');root.remove();
});

test('document previews preserve useful content while treating every source string as untrusted',()=>{
  const doc=fragment(rich.previewMarkup({format:'docx',name:'Notes',preview:{kind:'document',html:'<h1>Notes</h1><p onclick="bad()">Hi<img src="https://evil.invalid"></p>'}}));
  assert.equal(doc.querySelector('h1').textContent,'Notes');assert.equal(doc.querySelectorAll('[onclick],img').length,0);
  const slides=fragment(rich.previewMarkup({format:'pptx',preview:{kind:'slides',slides:[{number:1,title:'<b>Title</b>',text:'Slide detail',blocks:[{type:'table',headers:['Metric'],rows:[['<script>bad</script>']]}]}]}}));
  assert.equal(slides.querySelector('h3').textContent,'<b>Title</b>');assert.equal(slides.querySelectorAll('script').length,0);assert.ok(slides.querySelector('td'));
  const sheet=fragment(rich.previewMarkup({format:'xlsx',preview:{kind:'spreadsheet',sheets:[{name:'Sheet 1',rows:[['Column'],['=SUM(A1:A2) [cached: 3]']],rowCount:2,columnCount:1,formulaCount:1}]}}));
  assert.match(sheet.textContent,/cached: 3/);assert.match(sheet.textContent,/1 formulas/);assert.ok(sheet.querySelector('details[open]'));
  assert.ok(fragment(rich.previewMarkup({format:'pdf',preview:{kind:'document'}})).querySelector('#document-pdf'));
  assert.ok(fragment(rich.previewMarkup({format:'md',text:'# Preview title',preview:{kind:'text',content:'# Preview title'}})).querySelector('h1'));
});

test('DOCX previews allow only bounded embedded raster images while chat images remain disabled',()=>{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=';
  const root=fragment(rich.safeDocumentHTML(`<h1>Report</h1><img src="data:image/png;base64,${png}" alt="Embedded chart" onerror="bad()"><img src="https://tracker.invalid/pixel"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="data:image/png;base64,PHN2Zz4=">`));
  assert.equal(root.querySelectorAll('img').length,1);assert.equal(root.querySelector('img').alt,'Embedded chart');assert.equal(root.querySelectorAll('[onerror]').length,0);assert.equal(root.querySelectorAll('.rich-image-note').length,3);
  const chat=fragment(rich.render(`<img src="data:image/png;base64,${png}">`));assert.equal(chat.querySelectorAll('img').length,0);
});

test('streamed incomplete visual blocks remain quiet until the turn finishes',async()=>{
  for(const source of ['```infographic\n{"title":"Still writing','```chart\n{"type":"bar","labels":[','```mermaid\nflowchart LR\nA[Still writing']){
    const working=fragment(rich.render(source,{streaming:true}));assert.equal(working.querySelectorAll('.rich-error').length,0);assert.ok(working.querySelector('.rich-pending'));assert.equal(working.querySelectorAll('[data-rich="mermaid"]').length,0);
    const finished=fragment(rich.render(source));assert.ok(finished.querySelector('.rich-error')||finished.querySelector('[data-rich="mermaid"]'));
  }
  const validChart='```chart\n{"type":"bar","datasets":[{"values":[1,2]}]}\n```';assert.ok(fragment(rich.render(validChart,{streaming:true})).querySelector('[data-rich="chart"]'));
  const formula=fragment(rich.render('$$\\frac{a}{$$',{streaming:true}));assert.ok(formula.querySelector('.rich-math-pending'));assert.equal(formula.querySelectorAll('[data-rich="math"]').length,0);
  const diagram=fragment(rich.render('```mermaid\nflowchart LR\nA-->B\n```'));assert.ok(diagram.querySelector('[data-rich="mermaid"]'));
});

test('PowerPoint previews explain content limits and keep title-only slides informative',()=>{
  const root=fragment(rich.previewMarkup({format:'pptx',preview:{kind:'slides',slides:[{number:2,title:'Quarterly chart',text:'Quarterly chart',blocks:[]}]}}));
  assert.match(root.querySelector('.preview-layout-note').textContent,/Text preview/);assert.match(root.textContent,/Charts, images and the original slide layout/);assert.ok(root.querySelector('.preview-slide-note'));assert.equal(root.querySelectorAll('.preview-slide>p:not(.preview-slide-note)').length,0);
  const chart=fragment(rich.previewMarkup({format:'pptx',preview:{kind:'slides',slides:[{number:1,title:'Growth',text:'Growth',blocks:[{type:'chart',spec:{type:'bar',title:'Revenue',labels:['Q1'],series:[{name:'Revenue',values:[12]}]}}]}]}}));
  assert.ok(chart.querySelector('[data-rich="chart"]'));assert.equal(chart.querySelectorAll('.preview-slide-note').length,0);assert.match(chart.querySelector('.preview-layout-note').textContent,/extracted charts/);
  const malformed=fragment(rich.previewMarkup({format:'pptx',preview:{kind:'slides',slides:[{title:'Chart',blocks:[{type:'chart',spec:{type:'script',options:'bad'}}]}]}}));assert.equal(malformed.querySelectorAll('script,canvas').length,0);assert.match(malformed.textContent,/chart is available in the downloaded presentation/);
});

test('Mermaid keeps SVG text labels after sanitization and removes temporary DOM on success and failure',async()=>{
  Object.defineProperty(window.SVGElement.prototype,'getBBox',{configurable:true,value(){return {x:0,y:0,width:Math.max(40,(this.textContent?.length||0)*7),height:24};}});
  Object.defineProperty(window.SVGElement.prototype,'getComputedTextLength',{configurable:true,value(){return (this.textContent?.length||0)*7;}});
  globalThis.SVGElement=window.SVGElement;globalThis.Element=window.Element;globalThis.HTMLElement=window.HTMLElement;globalThis.CSSStyleSheet=window.CSSStyleSheet;globalThis.getComputedStyle=window.getComputedStyle.bind(window);
  const root=fragment(rich.render('```mermaid\nflowchart LR\nA[Read brief] --> B[Draft report]\n```'));document.body.append(root);await rich.hydrate(root);
  assert.ok(root.querySelector('svg'));assert.equal(root.querySelectorAll('foreignObject').length,0);assert.match(root.querySelector('svg').textContent,/Read brief/);assert.match(root.querySelector('svg').textContent,/Draft report/);assert.ok(root.querySelector('svg text'));assert.equal(document.querySelectorAll('.rich-render-buffer').length,0);root.remove();
  const invalid=fragment(rich.render('```mermaid\nflowchart LR\nA[Unclosed label\n```'));document.body.append(invalid);await rich.hydrate(invalid);assert.ok(invalid.querySelector('.rich-error'));assert.equal(document.querySelectorAll('.rich-render-buffer,[id^="dstudio-diagram-"]').length,0);invalid.remove();
});

test('sanitized replies and document previews keep only the renderer data attributes, never app action hooks',()=>{
  for(const html of [rich.safeHTML('<p data-action="delete-bot" data-nav="settings" data-id="bot_atlas" data-rich="math" data-format="display">x</p>'),rich.safeDocumentHTML('<p data-action="delete-bot" data-nav="settings">y</p>')]){
    const root=fragment(html),node=root.querySelector('p');
    assert.equal(node.hasAttribute('data-action'),false);assert.equal(node.hasAttribute('data-nav'),false);assert.equal(node.hasAttribute('data-id'),false);
  }
  const kept=fragment(rich.safeHTML('<p data-rich="math" data-format="display">x</p>')).querySelector('p');
  assert.equal(kept.dataset.rich,'math');assert.equal(kept.dataset.format,'display');
});
