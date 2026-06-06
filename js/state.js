// state.js — global app state + top-level router (verbatim from prototype)

/* ============================================================
   APP STATE + ROUTER
   ============================================================ */
const layout = document.getElementById('layout');
let state = { role:'admin', view:'dashboard', ptab:'tasks',
  uploadStep:0, parsed:false,
  pidx:0, answers:{}, flags:{}, playerStage:'EoCA 2', inReview:false, submitted:false, saveState:'saved',
  reportSection:'summary',
  cohortId:null, rosterPreview:null };

function render(){
  document.getElementById('contextBar').style.display = state.role==='admin'?'':'none';
  document.getElementById('userAv').textContent = state.role==='admin'?'AD':initials(ME().n);
  if(state.role==='admin') renderAdmin(); else renderParticipant();
}
