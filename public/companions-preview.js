/* Standalone production-art review; no account or engine API is read here. */
(() => {
  const avatars = window.StudioAvatars;
  const select = document.querySelector('#state');
  const paused = document.querySelector('#paused');
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const bots=avatars.shapes.map(shape=>({id:`preview_${shape.id.slice(10)}`,icon:shape.id,name:shape.label.replace(/ cushion$/,''),motion:shape.motion,frames:shape.frames}));
  for (const state of avatars.states) {
    const option = document.createElement('option');
    option.value = state; option.textContent = state;
    select.append(option);
  }
  document.querySelector('#companions').innerHTML = bots.map((bot,index)=>`<article class="companion-card" tabindex="0" aria-label="${esc(bot.name)}, focus to wave"><span class="companion-number">${String(index+1).padStart(2,'0')}</span><div class="mascot">${avatars.markup(bot,'large',{presentation:'mascot'})}</div><h2>${esc(bot.name)}</h2><p>${bot.frames?'Blink · look · wave':'Original companion'}</p><div class="portrait"><span>${avatars.markup(bot,'small')}<small>52px</small></span><span>${avatars.markup(bot,'tiny')}<small>40px</small></span></div>${bot.frames?`<a class="animation-download" href="/assets/companions/companion-${bot.icon.slice(10)}-animated.webp" download aria-label="Download ${esc(bot.name)} animation">Download animation</a>`:''}</article>`).join('');
  document.querySelector('#roster').innerHTML = bots.slice(4,8).map(bot=>`<div class="roster-row">${avatars.markup(bot,'small')}<div><strong>${esc(bot.name)}</strong><p>Ready for your next idea</p></div>${avatars.markup(bot,'tiny')}</div>`).join('');
  const update = () => {
    for (const node of document.querySelectorAll('.companion-avatar')) {
      node.classList.toggle('is-paused',paused.checked);
      avatars.setState(node,select.value);
    }
    document.querySelector('#motion-status').textContent=reduced?.matches?'Reduced motion is on. Every companion shows its calm pose.':paused.checked?'All animation is paused. Every companion shows its calm pose.':`${bots.length} companions in motion. Hover or keyboard-focus a card to wave.`;
  };
  select.addEventListener('change',update);
  paused.addEventListener('change',update);
  reduced?.addEventListener?.('change',update);
  update();
})();
