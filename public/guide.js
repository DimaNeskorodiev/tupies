import { guides } from './guide-content.js';

const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const guideHref = href => {
  if(/(?:^|\/)README\.md$/.test(href))return '#getting-started';
  const file=href.split('/').at(-1).replace(/\.md$/,'');
  if(guides.some(g=>g.id===file))return `#${file}`;
  if(/^https:\/\//.test(href))return href;
  return null;
};
function inline(value) {
  const tokens=[];
  const token=html=>`\u0000${tokens.push(html)-1}\u0000`;
  let text=value.replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,url)=>{
    const href=guideHref(url),caption=escape(label).replace(/`([^`]+)`/g,'<code>$1</code>');
    return token(href ? `<a href="${escape(href)}"${href.startsWith('https:')?' target="_blank" rel="noopener noreferrer"':''}>${caption}</a>` : caption);
  });
  text=text.replace(/`([^`]+)`/g,(_,code)=>token(`<code>${escape(code)}</code>`));
  return escape(text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\u0000(\d+)\u0000/g,(_,i)=>tokens[Number(i)]);
}
function renderMarkdown(source) {
  const lines=source.replace(/\r/g,'').split('\n');let html='',paragraph=[],list=null;
  const flush=()=>{if(paragraph.length){html+=`<p>${inline(paragraph.join(' '))}</p>`;paragraph=[];}};
  const closeList=()=>{if(list){html+=`</${list}>`;list=null;}};
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    if(/^```/.test(line)){flush();closeList();let code=[];while(++i<lines.length && !/^```/.test(lines[i]))code.push(lines[i]);html+=`<pre><code>${escape(code.join('\n'))}</code></pre>`;continue;}
    if(/^\s*$/.test(line)){flush();closeList();continue;}
    const heading=line.match(/^(#{1,4})\s+(.+)$/);
    if(heading){flush();closeList();const level=heading[1].length;html+=`<h${level}>${inline(heading[2])}</h${level}>`;continue;}
    if(line.startsWith('|') && /^\|[\s:|-]+\|\s*$/.test(lines[i+1] || '')) {
      flush();closeList();const cells=row=>row.replace(/^\||\|\s*$/g,'').split('|').map(c=>c.trim());
      html+='<div class="table-wrap"><table><thead><tr>'+cells(line).map(c=>`<th scope="col">${inline(c)}</th>`).join('')+'</tr></thead><tbody>';i++;
      while(i+1<lines.length && lines[i+1].startsWith('|'))html+='<tr>'+cells(lines[++i]).map(c=>`<td>${inline(c)}</td>`).join('')+'</tr>';
      html+='</tbody></table></div>';continue;
    }
    const item=line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if(item){flush();const kind=item[1]?'ul':'ol';if(list!==kind){closeList();list=kind;html+=`<${kind}>`;}html+=`<li>${inline(item[2])}</li>`;continue;}
    if(/^>\s?/.test(line)){flush();closeList();html+=`<blockquote>${inline(line.replace(/^>\s?/,''))}</blockquote>`;continue;}
    if(/^---+$/.test(line)){flush();closeList();html+='<hr>';continue;}
    closeList();paragraph.push(line.trim());
  }
  flush();closeList();return html;
}
const nav=document.querySelector('#guide-nav'), main=document.querySelector('#guide-main');
function showGuide(){const id=location.hash.slice(1) || 'getting-started',guide=guides.find(g=>g.id===id) || guides[0];
  nav.innerHTML=guides.map(g=>`<a href="#${escape(g.id)}"${g===guide?' aria-current="page"':''}>${escape(g.title)}</a>`).join('');
  main.innerHTML=renderMarkdown(guide.content);document.title=`${guide.title} · Tupies`;window.scrollTo(0,0);
}
window.addEventListener('hashchange',showGuide);showGuide();
