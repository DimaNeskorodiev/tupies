/* Settings › Usage: what tasks used per bot and per day. Numbers and short task titles from this engine only. */
(()=>{
  'use strict';
  let context=null,request=0;
  const state={days:14,loaded:false,loading:false,error:'',report:null};
  const e=value=>context.esc(String(value ?? ''));
  const format=()=>window.StudioRunUsage || {tokens:value=>String(value),dollars:()=>'',duration:()=>''};
  const whole=value=>Number.isFinite(value) && value>=0?Math.round(value):0;
  const current=()=>Boolean(context && context.route().view==='usage' && document.querySelector('[data-usage-page]'));
  /** "≈ $1.25", "≈ $1.25 + unpriced" when some tasks had no price, or "—" when none had. */
  function cost(row){
    if(!row || !whole(row.tasks))return '—';
    const priced=whole(row.tasks)-whole(row.unpricedTasks);
    if(!priced && !row.costUsd)return '—';
    return `≈ ${format().dollars(row.costUsd)}${whole(row.unpricedTasks)?' + unpriced':''}`;
  }
  const cached=row=>Number.isFinite(row?.cachePercent)?`${Math.min(100,whole(row.cachePercent))}%`:'—';
  const dayLabel=day=>{const date=new Date(`${day}T12:00:00`);return Number.isFinite(date.getTime())?date.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'}):day;};
  const weekday=day=>{const date=new Date(`${day}T12:00:00`);return Number.isFinite(date.getTime())?date.toLocaleDateString(undefined,{weekday:'short'}):'';};
  function tile(label,value,note=''){return `<div class="usage-tile glass-card"><span>${e(label)}</span><strong>${e(value)}</strong>${note?`<small>${e(note)}</small>`:''}</div>`;}
  /** One bar per day, scaled to the busiest day; the exact numbers are in the table below it. */
  function chart(daily){
    const max=Math.max(1,...daily.map(row=>whole(row.totalTokens)));
    // One series, one hue; each column is a hover and keyboard target with its exact value, and the By day table repeats the numbers.
    return `<figure class="usage-chart glass-card"><figcaption>Tokens per day</figcaption><div class="usage-bars" role="group" aria-label="Tokens per day for the last ${daily.length} days">${daily.map(row=>{
      const share=whole(row.totalTokens)/max,label=`${dayLabel(row.day)}: ${format().tokens(row.totalTokens)} tokens${whole(row.tasks)?`, ${whole(row.tasks)} task${whole(row.tasks)===1?'':'s'}`:''}`;
      return `<div class="usage-bar" tabindex="0" role="img" aria-label="${e(label)}" data-label="${e(label)}"><i style="height:${Math.max(whole(row.totalTokens)?4:0,Math.round(share*100))}%"></i><span aria-hidden="true">${e(weekday(row.day))}</span></div>`;
    }).join('')}</div></figure>`;
  }
  function table(caption,head,rows){
    return `<div class="usage-table glass-card"><table><caption>${e(caption)}</caption><thead><tr>${head.map((name,index)=>`<th scope="col"${index?' class="is-number"':''}>${e(name)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  const numbers=row=>`<td class="is-number">${whole(row.tasks)}</td><td class="is-number">${e(format().tokens(row.totalTokens))}</td><td class="is-number">${e(cached(row))}</td><td class="is-number">${e(cost(row))}</td>`;
  function body(){
    if(state.error)return `<div class="section-empty">${context.icon('activity')}<h3>Usage could not be loaded</h3><p>${e(state.error)}</p><button class="secondary-button" data-usage-retry>Try again</button></div>`;
    if(!state.loaded)return `<div class="section-empty" aria-busy="true">${context.icon('activity')}<p>Loading usage…</p></div>`;
    const report=state.report,totals=report.totals;
    if(!whole(totals.tasks))return `<div class="section-empty">${context.icon('activity')}<h3>No tasks in the last ${report.days} days</h3><p>When a bot finishes a task, what it used shows up here and under its reply.</p></div>`;
    const bots=report.bots.map(row=>`<tr><th scope="row"><a href="#/bot/${encodeURIComponent(row.botId)}">${e(row.name)}</a></th>${numbers(row)}</tr>`);
    const days=[...report.daily].reverse().filter(row=>whole(row.tasks)).map(row=>`<tr><th scope="row">${e(dayLabel(row.day))}</th>${numbers(row)}</tr>`);
    const top=report.top.map(row=>`<tr><th scope="row"><a href="#/bot/${encodeURIComponent(row.botId)}">${e(row.task || 'Task without a title')}</a><small>${e(row.botName)} · ${e(dayLabel(String(row.at).slice(0,10)))}${row.status && row.status!=='completed'?` · ${e(row.status)}`:''}</small></th><td class="is-number">${whole(row.usage.steps)}</td><td class="is-number">${e(format().tokens(row.usage.totalTokens))}</td><td class="is-number">${e(Number.isFinite(row.usage.cachePercent)?`${whole(row.usage.cachePercent)}%`:'—')}</td><td class="is-number">${e(Number.isFinite(row.usage.costUsd)?`≈ ${format().dollars(row.usage.costUsd)}`:'—')}</td></tr>`);
    const unpriced=whole(totals.unpricedTasks);
    return `<div class="usage-tiles">${tile('Tasks',String(whole(totals.tasks)))}${tile('Tokens',format().tokens(totals.totalTokens),`${format().tokens(totals.outputTokens)} written by models`)}${tile('From cache',cached(totals),'of what was sent to models')}${tile('Estimated cost',cost(totals),unpriced?`${unpriced} task${unpriced===1?'':'s'} without a known price`:'')}</div>
      ${chart(report.daily)}
      ${table('By bot',['Bot','Tasks','Tokens','Cached','Cost'],bots)}
      ${table(report.rankedBy==='cost'?'Tasks that cost the most':'Tasks that used the most tokens',['Task','Steps','Tokens','Cached','Cost'],top)}
      ${table('By day',['Day','Tasks','Tokens','Cached','Cost'],days)}
      <p class="usage-note">Costs are estimates from the provider’s own report or published prices; subscriptions and models without a known price show no cost. Counted from finished tasks kept on this engine. Summaries and background reviews are not included.</p>`;
  }
  function page(){
    return `<section class="page settings-page" data-usage-page>${context.settingsHeading('usage','What your bots used, from finished tasks on this engine.')}<div class="filterbar"><div class="segmented" role="group" aria-label="Period">${[7,14,30].map(days=>`<button class="segment ${state.days===days?'active':''}" data-usage-days="${days}" aria-pressed="${state.days===days}">${days} days</button>`).join('')}</div></div><div data-usage-body>${body()}</div></section>`;
  }
  function paint(){const host=document.querySelector('[data-usage-body]');if(host && current())host.innerHTML=body();for(const button of document.querySelectorAll('[data-usage-days]')){const active=Number(button.dataset.usageDays)===state.days;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}}
  async function load(){
    const mine=++request;state.loading=true;state.error='';
    try {
      const report=await context.api(`/api/usage?days=${state.days}`);
      if(mine!==request)return;
      state.report=report;state.loaded=true;
    } catch(error) {
      if(mine!==request)return;
      state.error=context.errorText?.(error) || 'Check the connection to this engine and try again.';
    } finally {if(mine===request){state.loading=false;paint();}}
  }
  document.addEventListener('click',event=>{
    if(!context)return;
    const days=event.target.closest?.('[data-usage-days]'),retry=event.target.closest?.('[data-usage-retry]');
    if(days){const value=Number(days.dataset.usageDays);if([7,14,30].includes(value) && value!==state.days){state.days=value;state.loaded=false;paint();void load();}}
    else if(retry){state.loaded=false;state.error='';paint();void load();}
  });
  /** Returns the page markup and refreshes its numbers each time the tab is opened. */
  function render(nextContext){context=nextContext;queueMicrotask(()=>void load());return page();}
  window.StudioUsage={render};
})();
