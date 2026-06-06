// app.js — role-switch wiring + boot sequence (verbatim from prototype)

/* ---------- role switch ---------- */
document.getElementById('roleSwitch').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b)return;
  document.querySelectorAll('#roleSwitch button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); state.role=b.dataset.role;
  if(state.role==='participant') state.ptab='tasks'; else state.view='dashboard';
  render();
});

/* ---------- boot ---------- */
(async function init(){
  // octopus loader on first paint while the roster loads
  mountOctopus(document.querySelector('.main'),'Reading the cohort roster…');
  await loadRoster();
  const opt=document.querySelector('#cohortSel option');
  if(opt) opt.textContent=`Cohort 2026·A — Personnel Management (n=${ROSTER.length})`;
  render();
})();
