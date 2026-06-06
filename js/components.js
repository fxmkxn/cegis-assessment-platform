// components.js — shared modal + toast primitives (verbatim from prototype)

/* ---------- modal + toast ---------- */
function showModal({title,body,confirm,onConfirm}){
  window._mc=onConfirm;
  document.getElementById('modalRoot').innerHTML=`<div class="modal-bg" onclick="if(event.target===this)closeModal()">
    <div class="modal"><div class="mh"><h2>${title}</h2></div><div class="mb">${body}</div>
    <div class="mf"><button class="btn ghost" onclick="closeModal()">${confirm?'Cancel':'Close'}</button>
    ${confirm?`<button class="btn" onclick="window._mc&&window._mc()">${confirm}</button>`:''}</div></div></div>`;
}
function closeModal(){document.getElementById('modalRoot').innerHTML='';}
function toast(msg,type){const t=document.createElement('div');t.className='toast '+(type||'');t.innerHTML=`${type==='ok'?'✓':type==='err'?'⚠':'•'} ${msg}`;
  document.getElementById('toast').appendChild(t);setTimeout(()=>t.remove(),3000);}
