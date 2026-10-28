// Liquid controls: a drop spreads from where a button is pressed and a soft highlight follows the pointer.
// Decorative only: it sets CSS variables and one class on the pressed element (styles in buttons.css) and adds no DOM.
(()=>{
  const SELECTOR='.primary-button,.secondary-button,.accent-button,.danger-button,.icon-button,.open-chat,.segment,.settings-tab,.composer-footer .send,.artifact-actions button,.artifact-actions a';
  const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const control=event=>event.target instanceof Element?event.target.closest(SELECTOR):null;
  function drop(element,x,y){
    if(reduced?.matches||element.disabled||element.getAttribute('aria-disabled')==='true')return;
    const box=element.getBoundingClientRect();
    element.style.setProperty('--drop-x',`${x-box.left}px`);
    element.style.setProperty('--drop-y',`${y-box.top}px`);
    element.style.setProperty('--drop-size',`${Math.round(Math.max(box.width,box.height)*1.15)}px`);
    // Restarting the animation needs the class removed for one style flush.
    element.classList.remove('is-dropping');void element.offsetWidth;element.classList.add('is-dropping');
  }
  document.addEventListener('pointerdown',event=>{if(event.button!==0)return;const element=control(event);if(element)drop(element,event.clientX,event.clientY);},{passive:true});
  // Keyboard presses (Enter/Space) have no pointer, so the drop starts from the centre.
  document.addEventListener('click',event=>{if(event.detail!==0)return;const element=control(event);if(!element)return;const box=element.getBoundingClientRect();drop(element,box.left+box.width/2,box.top+box.height/2);});
  document.addEventListener('animationend',event=>{if(event.animationName==='liquid-drop')event.target.classList?.remove('is-dropping');});
  let frame=0,last=null;
  document.addEventListener('pointermove',event=>{
    if(event.pointerType!=='mouse')return;last=event;if(frame)return;
    frame=requestAnimationFrame(()=>{frame=0;const element=control(last);if(!element)return;const box=element.getBoundingClientRect();element.style.setProperty('--mx',`${last.clientX-box.left}px`);element.style.setProperty('--my',`${last.clientY-box.top}px`);});
  },{passive:true});
})();
