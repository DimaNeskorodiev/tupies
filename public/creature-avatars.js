/* Local cushion companions are presentation only: saved bot profiles and
   activity palettes are never migrated or rewritten by this renderer. */
(() => {
  const colorData = [
    ['mint', 'Seafoam', ['#a4f5d5', '#21c6a1', '#087a77', '#c4ffe7']],
    ['lavender', 'Lavender', ['#d9baff', '#9970ed', '#5931ad', '#efdcff']],
    ['peach', 'Peach', ['#ffd5ac', '#ff9b65', '#d75b36', '#fff0ce']],
    ['blue', 'Cobalt', ['#75caff', '#3189f7', '#1748ba', '#c2eaff']],
    ['rose', 'Rose', ['#ffaaca', '#ef4b98', '#a31f68', '#ffdfed']],
    ['amber', 'Amber', ['#ffe090', '#f2ad26', '#b6740c', '#fff1b8']],
    ['coral', 'Coral reef', ['#ffb5a6', '#ff6f70', '#cb3862', '#ffdfc7']],
    ['ruby', 'Ruby', ['#ff8c91', '#e53150', '#950a39', '#ffc4a9']],
    ['tangerine', 'Tangerine', ['#ffcf6e', '#fb861c', '#d24316', '#ffe7a5']],
    ['lemon', 'Lemon', ['#fff18d', '#e2cd24', '#9b8a10', '#ffffcb']],
    ['lime', 'Electric lime', ['#ddff81', '#91cf2a', '#3e8b27', '#f2ffbc']],
    ['forest', 'Forest', ['#8bdda4', '#35a265', '#146347', '#c4f2a7']],
    ['teal', 'Lagoon', ['#8beded', '#24b7ca', '#06748b', '#c6ffff']],
    ['ice', 'Glacier', ['#c2eaff', '#7db8e5', '#4568aa', '#eefaff']],
    ['indigo', 'Midnight', ['#a7b0ff', '#6662e8', '#30267f', '#cdd4ff']],
    ['plum', 'Plum', ['#d99be4', '#a847b8', '#652171', '#f3caf3']],
    ['orchid', 'Orchid', ['#ffb2ed', '#d665d2', '#9836ac', '#ffe1f6']],
    ['slate', 'Moonstone', ['#b8cedd', '#7c98b4', '#435a7a', '#e4edf3']],
  ];
  const colorsById = Object.fromEntries(colorData.map(([id, , colors]) => [id, colors]));
  const paletteOptions = Object.freeze(colorData.map(([id, label, colors]) => Object.freeze({
    id, label, swatch: `linear-gradient(135deg,${colors[0]} 0%,${colors[1]} 45%,${colors[2]} 100%)`,
  })));
  const aliases = {sage: 'mint', lilac: 'lavender'};
  // Implicit assignments keep the original four forever. Explicit new icons
  // also have a finite fallback if the separately shipped catalogue fails.
  const legacyVariants = Object.freeze(['blue', 'coral', 'jade', 'honey']);
  const fallback = [
    ['blue','breathe'],['coral','sway'],['jade','float'],['honey','bounce'],
    ['cloud','breathe'],['tangerine','bounce'],['lagoon','float'],['cherry','sway'],
    ['pistachio','rock'],['periwinkle','float'],['peach','sway'],['lemon','bounce'],
    ['rose','rock'],['teal','breathe'],['azure','float'],['scarlet','bounce'],
    ['butter','rock'],['mint','sway'],['cocoa','breathe'],['blush','rock'],
    ['cobalt','bounce'],['ice','float'],['apricot','sway'],['silver','breathe'],
  ];
  const motions = new Set(['breathe','sway','float','bounce','rock']);
  const supplied = new Map((Array.isArray(window.StudioCompanionCatalog)?window.StudioCompanionCatalog:[]).filter(item=>item&&typeof item==='object').map(item=>[item.id,item]));
  const catalog = Object.freeze(fallback.map(([id,motion],index)=>{
    const item=supplied.get(id),label=typeof item?.label==='string'?item.label.trim().slice(0,60):'';
    return Object.freeze({id,label:label||id[0].toUpperCase()+id.slice(1),motion:motions.has(item?.motion)?item.motion:motion,frames:index>=legacyVariants.length&&(item?.frames??true)===true});
  }));
  const byId = new Map(catalog.map(item=>[item.id,item]));
  const namedVariants = Object.freeze({atlas:'blue', nova:'coral', scout:'jade', echo:'honey'});
  const sizes = new Set(['small', 'tiny', 'large']);
  const states = Object.freeze(['idle', 'blink', 'look', 'thinking', 'working', 'success', 'greeting', 'sad', 'floating']);
  const stateSet = new Set(states);
  const hash = value => {
    let result = 2166136261;
    for (const char of String(value).slice(0, 200)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
    return result >>> 0;
  };
  function describe(bot = {}) {
    const seed = String(bot?.id || bot?.name || 'companion-preview');
    const rawColor = aliases[bot?.color] || bot?.color;
    const palette = Object.hasOwn(colorsById, rawColor) ? rawColor : 'slate';
    const requested = String(bot?.icon || '').startsWith('companion:')?String(bot.icon).slice(10):'';
    const explicit = byId.has(requested)?requested:'';
    const canonical = /^bot_(atlas|nova|scout|echo)$/.exec(String(bot?.id || ''))?.[1];
    const name = String(bot?.name || '').trim().toLowerCase();
    const identity = hash(seed);
    const variant = explicit || (canonical && namedVariants[canonical]) || (Object.hasOwn(namedVariants, name) && namedVariants[name]) || legacyVariants[identity % legacyVariants.length];
    const companion=byId.get(variant);
    return {variant, palette, identity, gradient:0,motion:companion.motion,frames:companion.frames};
  }
  const normalizeState = state => stateSet.has(state) ? state : state === 'curious' ? 'look' : state === 'sleepy' ? 'sad' : 'idle';
  // Every URL comes from this finite local catalogue, never from a profile URL.
  // Poses share a registered frame box; opacity changes never morph the art.
  // Task controls, rather than this presentation animation, carry run progress.
  const source = (variant, resolution, presentation, frame='idle') => `/assets/companions/companion-${variant}-${presentation}${frame==='idle'?'':`-${frame}`}-${resolution}.webp`;
  const resolutions = size => size === 'tiny' || size === 'small' ? [64, 128] : [256, 512];
  function markup(bot = {}, size = '', options = {}) {
    const {variant, palette, identity,motion,frames} = describe(bot);
    const safeSize = sizes.has(size) ? size : '';
    const presentation = options.presentation === 'mascot' ? 'mascot' : 'portrait';
    const state = normalizeState(options.state || (options.working ? 'thinking' : 'idle'));
    const [resolution, retina] = resolutions(safeSize);
    const stateClass = options.paused ? 'is-paused' : options.working ? 'is-working' : '';
    const phase = ` style="--companion-phase:-${((identity%83)/10).toFixed(1)}s;--companion-cycle:${(5.8+(identity%25)/10).toFixed(1)}s;--companion-blink-phase:-${((identity%97)/10).toFixed(1)}s;--companion-blink-cycle:${(6.4+(identity%37)/10).toFixed(1)}s;--companion-lean:${identity%2?'':'-'}0.8deg"`;
    const image=frame=>`<img class="companion-art companion-frame companion-frame-${frame}" src="${source(variant,resolution,presentation,frame)}" srcset="${source(variant,retina,presentation,frame)} 2x" alt="" width="${resolution}" height="${resolution}" decoding="async"${frame==='idle'?'':' loading="lazy"'} draggable="false">`;
    // data-roki-* remain compatibility metadata for older presentation callers.
    return `<span class="avatar creature-avatar companion-avatar companion-${presentation} ${safeSize} ${stateClass}" data-creature="${variant}" data-palette="${palette}" data-companion-motion="${motion}" data-companion-frames="${frames}" data-companion-presentation="${presentation}" data-companion-state="${state}" data-roki-presentation="${presentation}" data-roki-state="${state}"${phase} aria-hidden="true"><span class="companion-body">${image('idle')}${frames?['blink','look','wave'].map(image).join(''):''}</span></span>`;
  }
  function setState(element, requested) {
    if (!element?.classList?.contains('companion-avatar')) return;
    const state = normalizeState(requested);
    if (element.dataset.companionState === state) return;
    element.dataset.companionState = state;
    element.dataset.rokiState = state;
  }
  // Shared observers pause unseen art and unregister detached avatars. There
  // are no avatar timers or per-avatar event listeners to clean up.
  const tracked=new Set();let intersection=null,mutations=null,watching=false;
  const avatarsWithin=node=>node?.nodeType===1?[...(node.matches('.companion-avatar')?[node]:[]),...node.querySelectorAll('.companion-avatar')]:[];
  function watch(node){if(!intersection||tracked.has(node)||!node.isConnected)return;tracked.add(node);node.classList.add('companion-offscreen');intersection.observe(node);}
  function visibility(){document.documentElement?.classList.toggle('companion-tab-hidden',document.hidden);}
  function startWatching(){
    if(watching||!document.body)return;watching=true;visibility();
    if(typeof window.IntersectionObserver==='function')intersection=new window.IntersectionObserver(entries=>{for(const entry of entries)if(tracked.has(entry.target))entry.target.classList.toggle('companion-offscreen',!entry.isIntersecting);},{rootMargin:'80px'});
    for(const node of document.querySelectorAll('.companion-avatar'))watch(node);
    if(intersection&&typeof window.MutationObserver==='function'){
      mutations=new window.MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)for(const avatar of avatarsWithin(node))watch(avatar);for(const node of tracked)if(!node.isConnected){intersection.unobserve(node);tracked.delete(node);}});
      mutations.observe(document.body,{childList:true,subtree:true});
    }
  }
  function stopWatching(){mutations?.disconnect();intersection?.disconnect();mutations=null;intersection=null;tracked.clear();watching=false;}
  document.addEventListener('visibilitychange',visibility);
  window.addEventListener('pagehide',stopWatching);window.addEventListener('pageshow',startWatching);
  if(document.body)startWatching();else document.addEventListener('DOMContentLoaded',startWatching,{once:true});
  const colors = bot => [...colorsById[describe(bot).palette]];
  window.StudioAvatars = Object.freeze({markup, describe, colors, setState, states, palettes:paletteOptions, shapes:Object.freeze(catalog.map(item=>Object.freeze({id:`companion:${item.id}`,label:item.label,motion:item.motion,frames:item.frames})))});
})();
