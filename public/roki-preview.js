(() => {
  const bot={id:'roki-preview',name:'Roki',icon:'roki',color:'slate'};
  const poses=[['idle','У спокої'],['blink','Кліпання'],['look','Цікавість'],['thinking','Роздуми'],['working','За роботою'],['success','Готово!'],['greeting','Привітання'],['sad','Сум'],['floating','Зависання']];
  const hero=document.querySelector('#hero-avatar');hero.innerHTML=StudioAvatars.markup(bot,'large',{presentation:'mascot'});
  const portraitStates=[['idle','Спокій'],['greeting','Радість'],['thinking','Зосередженість'],['look','Цікавість'],['blink','Закриті очі'],['sad','Сонливість']];
  document.querySelector('#portrait-grid').innerHTML=portraitStates.map(([state,label])=>`<figure>${StudioAvatars.markup(bot,'',{state})}<figcaption>${label}</figcaption></figure>`).join('');
  const grid=document.querySelector('#poses');
  grid.innerHTML=poses.map(([state,label])=>`<button class="pose" data-state="${state}" aria-label="${label}" aria-pressed="${state==='idle'}">${StudioAvatars.markup(bot,'',{state,presentation:'mascot',paused:true})}<span>${label}</span></button>`).join('');
  grid.addEventListener('click',event=>{const button=event.target.closest('[data-state]');if(!button)return;StudioAvatars.setState(hero.querySelector('.roki-avatar'),button.dataset.state);document.querySelector('#current-state').textContent=poses.find(([state])=>state===button.dataset.state)[1];for(const item of grid.children)item.setAttribute('aria-pressed',String(item===button));});
  document.querySelector('#motion-toggle').addEventListener('click',event=>{const paused=event.target.getAttribute('aria-pressed')!=='true';event.target.setAttribute('aria-pressed',String(paused));event.target.textContent=paused?'Відновити рух':'Призупинити рух';for(const avatar of document.querySelectorAll('.roki-avatar'))avatar.classList.toggle('is-paused',paused);});
  document.querySelector('#sizes').innerHTML=[128,64,32].map(size=>`<figure><img class="portrait-icon" src="/assets/roki/roki-portrait-idle-${size}.png" width="${size}" height="${size}" alt="Рокі ${size} пікселів"><figcaption>${size} × ${size}</figcaption></figure>`).join('');
  const assets=(id,prefix,items)=>{document.querySelector(id).innerHTML=items.map(([key,label])=>`<figure><img src="/assets/roki/roki-${prefix}-${key}-256.webp" alt="${label}" loading="lazy" width="256" height="256"><figcaption>${label}</figcaption></figure>`).join('');};
  assets('#expressions','expression',[['default','Спокій'],['happy','Радість'],['focused','Зосередженість'],['curious','Цікавість'],['sleepy','Сонливість'],['excited','Захват'],['surprised','Здивування'],['winking','Підморгування']]);
  assets('#turns','turn',[['front','Спереду'],['front-right','Праворуч 45°'],['right','Праворуч'],['back-right','Ззаду 45°'],['back','Ззаду'],['back-left','Зліва ззаду'],['left','Ліворуч'],['front-left','Ліворуч 45°']]);
})();
