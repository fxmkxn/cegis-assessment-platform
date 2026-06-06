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
  // octopus loader on first paint while we restore the session + roster
  mountOctopus(document.querySelector('.main'),'Starting up…');
  await initAuth();                 // restore Supabase session (or enter demo mode)
  await loadRoster();               // sample data for now (real data lands in Phase 5)
  const opt=document.querySelector('#cohortSel option');
  if(opt) opt.textContent=`Cohort 2026·A — Personnel Management (n=${ROSTER.length})`;
  routeAuth();                      // show login, the claims-error screen, or the app
})();
