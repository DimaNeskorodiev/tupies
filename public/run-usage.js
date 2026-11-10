/* What a finished task used: steps, tokens, cache reuse, time and an estimate in dollars. Numbers only; no model text. */
(()=>{
  const escape=value=>String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const whole=value=>Number.isFinite(value) && value>=0?Math.round(value):0;
  /** 950 → "950", 20_700 → "20.7K", 1_250_000 → "1.25M". */
  function tokens(value){
    const count=whole(value);
    if(count<1000)return String(count);
    if(count<1_000_000){const thousands=count/1000;return `${thousands<100?thousands.toFixed(1).replace(/\.0$/,''):Math.round(thousands)}K`;}
    return `${(count/1_000_000).toFixed(2).replace(/\.?0+$/,'')}M`;
  }
  /** Small amounts keep enough digits to be meaningful: $0.0004, $0.012, $1.25. */
  function dollars(value){
    if(!Number.isFinite(value) || value<0)return '';
    if(value===0)return '$0';
    if(value<0.01)return `$${value.toFixed(4).replace(/0+$/,'')}`;
    if(value<1)return `$${value.toFixed(3).replace(/0$/,'')}`;
    return `$${value.toFixed(2)}`;
  }
  function duration(ms){
    if(!Number.isFinite(ms) || ms<0)return '';
    const seconds=Math.round(ms/1000);
    if(seconds<60)return `${Math.max(1,seconds)} s`;
    const minutes=Math.floor(seconds/60),rest=seconds%60;
    if(minutes<60)return rest?`${minutes} min ${rest} s`:`${minutes} min`;
    return `${Math.floor(minutes/60)} h ${minutes%60} min`;
  }
  const SOURCES={
    provider:'Cost as reported by the provider.',
    catalog:'Estimate from the list prices in the provider’s model catalog.',
    owner:'Estimate from the prices set for this provider.',
    subscription:'Included in your subscription; no per-task price.',
  };
  /** Only finite, bounded numbers and two short strings are read from the record. */
  function valid(usage){
    return usage && typeof usage==='object' && !Array.isArray(usage) && Number.isFinite(usage.totalTokens) && Number.isFinite(usage.modelCalls) && usage.modelCalls>0;
  }
  function summary(usage){
    const parts=[];
    if(whole(usage.steps))parts.push(`${whole(usage.steps)} step${whole(usage.steps)===1?'':'s'}`);
    if(whole(usage.totalTokens))parts.push(`${tokens(usage.totalTokens)} tokens`);
    if(Number.isFinite(usage.cachePercent) && usage.cachePercent>0)parts.push(`${Math.min(100,whole(usage.cachePercent))}% cached`);
    if(Number.isFinite(usage.costUsd))parts.push(`≈ ${dollars(usage.costUsd)}`);
    const time=duration(usage.durationMs);if(time)parts.push(time);
    return parts;
  }
  /** Work that used no model (a saved script run): no tokens, no price, just that it cost nothing to think. */
  function zeroModel(usage){
    return usage && typeof usage==='object' && !Array.isArray(usage) && usage.modelCalls===0 && !whole(usage.totalTokens) && !whole(usage.inputTokens) && !whole(usage.outputTokens) && !whole(usage.cachedTokens);
  }
  function zeroFooter(usage){
    const commands=whole(usage.toolCalls),time=duration(usage.durationMs);
    const parts=['0 model calls',...(commands?[`${commands} command${commands===1?'':'s'}`]:[]),...(time?[time]:[])];
    return `<details class="run-usage"><summary aria-label="${escape(`Task usage: ${parts.join(', ')}`)}">${parts.map(part=>`<span>${escape(part)}</span>`).join('')}</summary><p>This ran without a model: no tokens were used.</p></details>`;
  }
  function footer(usage){
    if(zeroModel(usage))return zeroFooter(usage);
    if(!valid(usage))return '';
    const parts=summary(usage);if(!parts.length)return '';
    const row=(label,value)=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
    const priced=Number.isFinite(usage.costUsd);
    const note=priced?SOURCES[usage.costSource] || 'Estimated cost.':usage.costSource==='subscription'?SOURCES.subscription:whole(usage.totalTokens)?'No price is known for this model, so no cost is shown.':'The provider did not report token usage for this task.';
    const rows=[
      whole(usage.toolCalls)?row('Tool calls',String(whole(usage.toolCalls))):'',
      row('Model calls',String(whole(usage.modelCalls))),
      row('New input',`${tokens(usage.inputTokens)} tokens`),
      row('Cached input',`${tokens(usage.cachedTokens)} tokens`),
      whole(usage.cacheWriteTokens)?row('Cache writes',`${tokens(usage.cacheWriteTokens)} tokens`):'',
      row('Output',`${tokens(usage.outputTokens)} tokens${whole(usage.reasoningTokens)?` (${tokens(usage.reasoningTokens)} reasoning)`:''}`),
      typeof usage.model==='string' && usage.model?row('Model',usage.model.slice(0,120)):'',
    ].join('');
    return `<details class="run-usage"><summary aria-label="${escape(`Task usage: ${parts.join(', ')}`)}">${parts.map(part=>`<span>${escape(part)}</span>`).join('')}</summary><dl>${rows}</dl><p>${escape(note)}</p></details>`;
  }
  window.StudioRunUsage={footer,tokens,dollars,duration};
})();
