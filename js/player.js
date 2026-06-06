/* =====================================================================
 * CEGIS — js/player.js  (Phase 8)
 *
 * The participant assessment player. Consumes a deployed technical
 * assessment via the Phase-8 RPCs:
 *   list_player_assessments · start_player_assessment · save_response ·
 *   record_proctor_event · submit_attempt
 *
 * Features: live load + resume, per-answer autosave with the saving/saved
 * indicator, flag-for-review, an always-live review grid, a per-assessment
 * countdown that AUTO-SUBMITS at zero, and proctoring that AUTO-SUBMITS on
 * tab/window switch (plus copy/paste/context-menu/devtools blocking and a
 * navigation guard). The score is computed server-side and NEVER shown.
 *
 * Loaded AFTER participant.js so it overrides the prototype's player stubs.
 * Globals from earlier phases: sb, state, mountOctopus, toast,
 * showModal/closeModal, renderParticipant, pgo.
 * ===================================================================== */

/* ---------------- Tasks list (live) ---------------- */
function pTasks(){
  if (state.tasks === undefined){
    if (!state.tasksLoading){ state.tasksLoading = true; loadMyTasks(); }
    return `<div class="page-head"><h1>My Tasks</h1></div>${playerLoading('Loading your tasks…')}`;
  }
  const me = (typeof ME === 'function') ? ME() : { n:'there' };
  const first = (me.n || 'there').split(/\s+/)[0];
  const live = state.tasks.filter(t => t.attempt_status !== 'submitted');
  const done = state.tasks.filter(t => t.attempt_status === 'submitted');
  const card = t => {
    const mins = t.time_limit_minutes ? `${t.time_limit_minutes} min limit` : 'no time limit';
    const sub = `${t.question_count} questions · ${mins}`;
    if (t.attempt_status === 'submitted')
      return `<div class="task done"><div class="ic2">✓</div>
        <div style="flex:1"><b>${t.name}</b><div class="muted small">${sub} · submitted</div></div>
        <span class="pill closed">Completed</span></div>`;
    const verb = t.attempt_status === 'in_progress' ? 'Resume' : 'Begin';
    return `<div class="task"><div class="ic2">✎</div>
      <div style="flex:1"><b>${t.name}</b><div class="muted small">${sub}${t.attempt_status==='in_progress'?' · in progress':''}</div></div>
      <button class="btn" onclick="startPlayerForAssessment('${t.id}')">${verb} →</button></div>`;
  };
  return `<div class="page-head"><h1>Welcome back, ${first}</h1></div>
    <h3 style="margin-bottom:12px">Do now</h3>
    ${live.length ? live.map(card).join('') : '<p class="muted">No assessments awaiting you right now.</p>'}
    ${done.length ? `<hr><h3 style="margin-bottom:12px">Completed</h3>${done.map(card).join('')}` : ''}`;
}
function loadMyTasks(){
  sb.rpc('list_player_assessments').then(({ data, error }) => {
    state.tasksLoading = false;
    state.tasks = error ? [] : (data || []);
    if (error) toast('Could not load tasks: ' + error.message, 'err');
    if (state.ptab === 'tasks') renderParticipant();
  });
}
function playerLoading(msg){
  return `<div class="oct-loading"><div class="oct-msg">${msg}</div></div>`;
}

/* ---------------- Start / resume an attempt ---------------- */
function startPlayer(){ /* legacy entry: route through tasks */ pgo('tasks'); }

async function startPlayerForAssessment(assessmentId){
  state.ptab = 'player';
  layout.innerHTML = `<div style="flex:1;display:flex;flex-direction:column;min-height:0"><div class="main"></div></div>`;
  mountOctopus(document.querySelector('.main'), 'Loading your assessment…');
  try {
    const { data, error } = await sb.rpc('start_player_assessment', { p_assessment_id: assessmentId });
    if (error) throw error;
    if (data.attempt && data.attempt.status === 'submitted'){
      toast('You have already submitted this assessment', 'ok');
      state.tasks = undefined; pgo('tasks'); return;
    }
    const ans = {}, flags = {};
    (data.responses || []).forEach(r => { if (r.answer) ans[r.question_id] = r.answer; if (r.flagged) flags[r.question_id] = true; });
    const skewMs = data.attempt.server_now ? (new Date(data.attempt.server_now).getTime() - Date.now()) : 0;
    state.player = {
      assessmentId, attemptId: data.attempt.id, name: data.assessment.name,
      questions: data.questions || [], answers: ans, flags,
      idx: 0, inReview: false, submitted: false, saveState: 'saved',
      deadlineAt: data.attempt.deadline_at ? new Date(data.attempt.deadline_at).getTime() : null,
      skewMs, dirty: {}, terminated: false, fsActive: false,
      proctored: data.assessment.proctored !== false
    };
    if (state.player.proctored) attachProctoring();
    startTimer();
    renderParticipant();
  } catch (e){
    toast('Could not start assessment: ' + (e.message || e), 'err');
    state.tasks = undefined; pgo('tasks');
  }
}

/* ---------------- Player render ---------------- */
function pPlayer(){
  const P = state.player;
  if (!P) { pgo('tasks'); return ''; }
  if (P.submitted) return playerDone();
  if (P.inReview) return playerReview();
  const q = P.questions[P.idx], total = P.questions.length;
  const flagged = !!P.flags[q.id];
  const ind = { saved:['','Saved'], saving:['saving','Saving…'], err:['err','Couldn’t save — retrying'] }[P.saveState] || ['','Saved'];
  const typeLabel = q.type==='fib'?'Fill in the blank':q.type==='tf'?'True / False':q.type==='multi'?'Select all that apply':q.type==='likert'?'Rating':'Multiple choice';
  return `<div class="player-wrap">
    <div class="flex jb ac" style="margin-bottom:14px">
      <button class="btn ghost sm" onclick="exitPlayer()">✕ Save & exit</button>
      <div class="flex g12 ac">
        ${P.deadlineAt ? `<span class="pill sched" id="playerTimer">--:--</span>` : ''}
        <span class="pill sched">${P.name}</span></div></div>
    <div class="player-top">
      <span class="small tnum" style="font-weight:600;white-space:nowrap">Question ${P.idx+1} of ${total}</span>
      <div class="qbar"><i style="width:${(P.idx+1)/total*100}%"></i></div>
      <div class="save-ind ${ind[0]}"><span class="d"></span>${ind[1]}</div></div>
    <div class="card pad" id="qArea" style="margin-top:18px">
      <span class="tag">${typeLabel}</span>
      <p style="font-size:17px;font-weight:600;margin:14px 0 18px;line-height:1.45">${q.prompt}</p>
      ${playerControls(q)}</div>
    <div class="flex jb ac" style="margin-top:18px">
      <button class="flagbtn ${flagged?'on':''}" onclick="playerFlag('${q.id}')">${flagged?'⚑ Flagged':'⚐ Flag for review'}</button>
      <div class="flex g12">
        <button class="btn ghost" onclick="playerNav(-1)" ${P.idx===0?'disabled':''}>← Previous</button>
        ${P.idx===total-1
          ? '<button class="btn" onclick="playerEnterReview()">Review answers →</button>'
          : '<button class="btn" onclick="playerNav(1)">Next →</button>'}</div></div>
  </div>`;
}

function playerControls(q){
  const a = state.player.answers[q.id] || {};
  const sel = a.selected || [];
  const isSel = ord => sel.indexOf(ord) !== -1;
  if (q.type === 'tf')
    return `<div class="tf">`+q.options.map(o=>`<button class="${isSel(o.ordinal)?'sel':''}" onclick="playerPick('${q.id}',${o.ordinal})">${o.label}</button>`).join('')+`</div>`;
  if (q.type === 'fib')
    return `<div class="fib"><input placeholder="Type your answer…" value="${(a.text||'').replace(/"/g,'&quot;')}" oninput="playerText('${q.id}',this.value)"></div>`;
  if (q.type === 'likert')
    return `<div class="likert">`+q.options.map(o=>`<button class="${isSel(o.ordinal)?'sel':''}" onclick="playerPick('${q.id}',${o.ordinal})">${o.label}</button>`).join('')+`</div>`;
  if (q.type === 'multi')
    return `<div>`+q.options.map(o=>`<div class="opt ${isSel(o.ordinal)?'sel':''}" onclick="playerToggle('${q.id}',${o.ordinal})"><span class="rd"></span>${o.label}</div>`).join('')+`</div>`;
  // mcq (single)
  return `<div>`+q.options.map(o=>`<div class="opt ${isSel(o.ordinal)?'sel':''}" onclick="playerPick('${q.id}',${o.ordinal})"><span class="rd"></span>${o.label}</div>`).join('')+`</div>`;
}

/* ---------------- Answer handlers + autosave ---------------- */
function playerPick(qid, ord){ state.player.answers[qid] = { selected:[ord] }; queueSave(qid); renderParticipant(); }
function playerToggle(qid, ord){
  const a = state.player.answers[qid] || { selected:[] };
  const s = new Set(a.selected || []);
  if (s.has(ord)) s.delete(ord); else s.add(ord);
  state.player.answers[qid] = { selected:[...s].sort((x,y)=>x-y) };
  queueSave(qid); renderParticipant();
}
function playerText(qid, v){ state.player.answers[qid] = { text: v }; queueSave(qid); }
function playerFlag(qid){ state.player.flags[qid] = !state.player.flags[qid]; queueSave(qid); renderParticipant(); }

let _saveTimer;
function queueSave(qid){
  const P = state.player; if (!P || P.terminated) return;
  P.dirty[qid] = true; P.saveState = 'saving'; updateSaveIndicator();
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSaves, 600);
}
async function flushSaves(){
  const P = state.player; if (!P || P.terminated) return;
  const ids = Object.keys(P.dirty); if (!ids.length) return;
  P.dirty = {};
  try {
    for (const qid of ids){
      const { error } = await sb.rpc('save_response', {
        p_attempt_id: P.attemptId, p_question_id: qid,
        p_answer: P.answers[qid] || null, p_flagged: !!P.flags[qid]
      });
      if (error) throw error;
    }
    P.saveState = 'saved';
  } catch (e){
    P.saveState = 'err';
    // if the server says time is up, finalize
    if (String(e.message||e).toLowerCase().includes('time is up')){ autoSubmit('time'); return; }
    ids.forEach(id => P.dirty[id] = true);     // re-queue for retry
    clearTimeout(_saveTimer); _saveTimer = setTimeout(flushSaves, 1500);
  }
  updateSaveIndicator();
}
function updateSaveIndicator(){
  const P = state.player; if (!P) return;
  const el = document.querySelector('.save-ind'); if (!el) return;
  const map = { saved:['','Saved'], saving:['saving','Saving…'], err:['err','Couldn’t save — retrying'] };
  const [cls,txt] = map[P.saveState] || map.saved;
  el.className = 'save-ind ' + cls;
  el.innerHTML = `<span class="d"></span>${txt}`;
}

/* ---------------- Nav + review ---------------- */
function playerNav(d){
  const P = state.player; P.idx = Math.max(0, Math.min(P.questions.length-1, P.idx+d));
  renderParticipant(); const m = document.querySelector('.main'); if (m) m.scrollTo(0,0);
}
function playerEnterReview(){ state.player.inReview = true; renderParticipant(); }

function playerReview(){
  const P = state.player, total = P.questions.length;
  const answeredOf = q => { const a = P.answers[q.id]; return a && ((a.selected && a.selected.length) || (a.text && a.text.trim() !== '')); };
  const answered = P.questions.filter(answeredOf).length;
  const cells = P.questions.map((q,i)=>{
    const a = answeredOf(q), f = P.flags[q.id];
    return `<div class="rcell ${a?'ans':''} ${f?'flag':''}" onclick="state.player.inReview=false;state.player.idx=${i};renderParticipant()">${q.ordinal}</div>`;
  }).join('');
  return `<div class="player-wrap">
    <div class="flex jb ac" style="margin-bottom:10px">
      <h1>Review your answers</h1>
      ${P.deadlineAt ? `<span class="pill sched" id="playerTimer">--:--</span>` : ''}</div>
    <p class="muted" style="margin-bottom:18px">${answered} of ${total} answered${answered<total?` · ${total-answered} unanswered`:''}. Tap any number to jump back.</p>
    <div class="card pad"><div class="review-grid">${cells}</div>
      <div class="legend" style="margin-top:16px">
        <span><i style="background:var(--indigo);width:12px;height:12px;border-radius:3px"></i>Answered</span>
        <span><i style="background:#fff;border:1.5px solid var(--g300);width:12px;height:12px;border-radius:3px"></i>Unanswered</span>
        <span><i style="background:var(--warn-l);border:1.5px solid var(--warn);width:12px;height:12px;border-radius:3px"></i>Flagged</span></div></div>
    <div class="flex jb" style="margin-top:18px">
      <button class="btn ghost" onclick="state.player.inReview=false;renderParticipant()">← Back to questions</button>
      <button class="btn" onclick="playerConfirmSubmit(${answered},${total})">Submit assessment</button></div></div>`;
}

function playerConfirmSubmit(answered,total){
  showModal({
    title:'Submit this assessment?',
    body: answered<total
      ? `You have <b>${total-answered} unanswered question(s)</b>. You can still submit, but they will be marked blank. This cannot be undone.`
      : `All ${total} questions answered. Once submitted you cannot change your responses.`,
    confirm:'Submit now',
    onConfirm: () => { closeModal(); submitNow('manual'); }
  });
}

async function submitNow(reason){
  const P = state.player; if (!P || P.terminated) return; P.terminated = true;
  detachProctoring(); stopTimer();
  layout.innerHTML = `<div style="flex:1;display:flex;flex-direction:column;min-height:0"><div class="main"></div></div>`;
  mountOctopus(document.querySelector('.main'), 'Submitting your answers…');
  try { await flushSaves(); } catch(e){}
  try {
    const { error } = await sb.rpc('submit_attempt', { p_attempt_id: P.attemptId, p_reason: reason });
    if (error) throw error;
  } catch (e){ toast('Submit error: ' + (e.message||e), 'err'); }
  P.submitted = true; state.tasks = undefined; renderParticipant();
}

/* auto-submit (timeout / proctoring) — no confirmation */
function autoSubmit(reason){
  const P = state.player; if (!P || P.terminated) return;
  submitNow(reason);
  const labels = { time:'time expired', tab_switch:'you left the tab', window_blur:'you left the window', fullscreen_exit:'you exited full screen' };
  toast('Assessment auto-submitted — ' + (labels[reason]||reason), 'err');
}

function playerDone(){
  return `<div class="player-wrap" style="text-align:center;padding-top:40px">
    <div style="font-size:54px">✅</div>
    <h1 style="margin:14px 0 6px">Assessment submitted</h1>
    <p class="muted">Your responses are saved. Your report will be released once the stage closes.</p>
    <button class="btn" style="margin-top:18px" onclick="leavePlayer()">Back to my tasks</button></div>`;
}
function exitPlayer(){
  const P = state.player; if (P){ P.terminated = true; }
  detachProctoring(); stopTimer();
  flushSaves();
  toast('Progress saved', 'ok');
  leavePlayer();
}
function leavePlayer(){ state.player = null; state.tasks = undefined; pgo('tasks'); }

/* ---------------- Countdown timer ---------------- */
let _timerInt;
function startTimer(){
  stopTimer();
  if (!state.player || !state.player.deadlineAt) return;
  _timerInt = setInterval(tickTimer, 1000);
  tickTimer();
}
function stopTimer(){ if (_timerInt){ clearInterval(_timerInt); _timerInt = null; } }
function tickTimer(){
  const P = state.player; if (!P || P.terminated || !P.deadlineAt){ stopTimer(); return; }
  const serverNow = Date.now() + (P.skewMs || 0);
  let remain = Math.round((P.deadlineAt - serverNow) / 1000);
  if (remain <= 0){ stopTimer(); autoSubmit('time'); return; }
  const el = document.getElementById('playerTimer'); if (!el) return;
  const m = Math.floor(remain/60), s = remain % 60;
  el.textContent = `${m}:${String(s).padStart(2,'0')}`;
  el.style.background = remain <= 60 ? 'var(--err-l)' : '';
  el.style.color = remain <= 60 ? 'var(--err)' : '';
}

/* ---------------- Proctoring ---------------- */
let _proctor = {};
function proctorLog(ev){
  const P = state.player; if (!P) return;
  try { sb.rpc('record_proctor_event', { p_attempt_id: P.attemptId, p_event: ev }); } catch(e){}
}
function attachProctoring(){
  const P = state.player; if (!P) return;

  _proctor.vis = () => { if (document.hidden && !P.terminated){ autoSubmit('tab_switch'); } };
  _proctor.blur = () => { setTimeout(() => { if (!P.terminated && !document.hasFocus() && !document.hidden){ autoSubmit('window_blur'); } }, 200); };
  _proctor.block = e => { e.preventDefault(); proctorLog(e.type); toast('That action is disabled during the assessment','err'); };
  _proctor.keys = e => {
    const k = e.key.toLowerCase();
    const blocked = e.key === 'F12'
      || ((e.ctrlKey||e.metaKey) && e.shiftKey && ['i','j','c'].includes(k))
      || ((e.ctrlKey||e.metaKey) && ['c','v','x','p','u','s'].includes(k))
      || e.key === 'PrintScreen';
    if (blocked){ e.preventDefault(); proctorLog('key:'+k); }
  };
  _proctor.beforeunload = e => { if (!P.terminated){ e.preventDefault(); e.returnValue = ''; proctorLog('nav_attempt'); } };
  _proctor.fs = () => {
    const inFs = !!(document.fullscreenElement);
    if (inFs) P.fsActive = true;
    else if (P.fsActive && !P.terminated){ autoSubmit('fullscreen_exit'); }
  };

  document.addEventListener('visibilitychange', _proctor.vis);
  window.addEventListener('blur', _proctor.blur);
  document.addEventListener('contextmenu', _proctor.block);
  document.addEventListener('copy', _proctor.block);
  document.addEventListener('cut', _proctor.block);
  document.addEventListener('paste', _proctor.block);
  document.addEventListener('keydown', _proctor.keys, true);
  window.addEventListener('beforeunload', _proctor.beforeunload);
  document.addEventListener('fullscreenchange', _proctor.fs);

  // best-effort full screen (granted by the Begin click gesture)
  const el = document.documentElement;
  if (el.requestFullscreen){ el.requestFullscreen().then(()=>{ P.fsActive = true; }).catch(()=>{}); }
}
function detachProctoring(){
  if (!_proctor.vis) return;
  document.removeEventListener('visibilitychange', _proctor.vis);
  window.removeEventListener('blur', _proctor.blur);
  document.removeEventListener('contextmenu', _proctor.block);
  document.removeEventListener('copy', _proctor.block);
  document.removeEventListener('cut', _proctor.block);
  document.removeEventListener('paste', _proctor.block);
  document.removeEventListener('keydown', _proctor.keys, true);
  window.removeEventListener('beforeunload', _proctor.beforeunload);
  document.removeEventListener('fullscreenchange', _proctor.fs);
  _proctor = {};
  if (document.fullscreenElement && document.exitFullscreen){ document.exitFullscreen().catch(()=>{}); }
}
