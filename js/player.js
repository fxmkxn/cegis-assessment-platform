/* =====================================================================
 * CEGIS — js/player.js  (Phase 8, + persistent navigator rail)
 *
 * Participant assessment player. Consumes a deployed technical assessment
 * via the Phase-8 RPCs. Features: live load + resume, per-answer autosave,
 * flag-for-review, a PERSISTENT right-rail question navigator (always shows
 * answered / unanswered / flagged), a large countdown that auto-submits at
 * zero, proctoring (tab/window-switch auto-submit + copy/paste/devtools
 * blocking + nav guard + best-effort full screen), and server-side scoring.
 * The score is never shown.
 *
 * Load AFTER participant.js. Globals: sb, state, layout, mountOctopus,
 * toast, showModal/closeModal, renderParticipant, pgo, ME, initials.
 * ===================================================================== */

/* ---------------- one-time CSS (timer size + two-column layout) ---------------- */
function ensurePlayerStyles(){
  if (document.getElementById('playerStyles')) return;
  const s = document.createElement('style');
  s.id = 'playerStyles';
  s.textContent = `
    #playerTimer{font-size:22px;padding:8px 18px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:.5px}
    .player-grid{display:grid;grid-template-columns:1fr 250px;gap:24px;max-width:1060px;margin:0 auto;align-items:start}
    .nav-rail{position:sticky;top:6px}
    .nav-rail .review-grid{grid-template-columns:repeat(auto-fill,minmax(38px,1fr))}
    @media(max-width:860px){.player-grid{grid-template-columns:1fr}.nav-rail{position:static}}
  `;
  document.head.appendChild(s);
}

/* ---------------- Tasks list (live) ---------------- */
function pTasks(){
  if (state.tasks === undefined){
    if (!state.tasksLoading){ state.tasksLoading = true; loadMyTasks(); }
    return `<div class="page-head"><h1>My Tasks</h1></div>${playerLoading('Loading your tasks…')}`;
  }
  // Greet the signed-in participant, not the sample roster. ME() is sample data
  // for participants (they don't load a full roster). _meFirstSync()/loadMyName()
  // live in participant.js; renderParticipant() already calls loadMyName() on the
  // tasks tab, which fills #pWelcome with the real name once fetched.
  const first = (typeof _meFirstSync === 'function')
    ? _meFirstSync()
    : (((typeof ME === 'function' ? ME().n : '') || 'there').split(/\s+/)[0]);
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
    // Fresh starts go through the instructions gate first; a resume drops straight
    // back in (the attempt — and its deadline — already started server-side).
    const launch = t.attempt_status === 'in_progress'
      ? "startPlayerForAssessment('" + t.id + "')"
      : "playerInstructions('" + t.id + "')";
    return `<div class="task"><div class="ic2">✎</div>
      <div style="flex:1"><b>${t.name}</b><div class="muted small">${sub}${t.attempt_status==='in_progress'?' · in progress':''}</div></div>
      <button class="btn" onclick="${launch}">${verb} →</button></div>`;
  };
  return `<div class="page-head"><h1 id="pWelcome">Welcome back, ${typeof _escP==='function'?_escP(first):first}</h1></div>
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
function playerLoading(msg){ return `<div class="oct-loading"><div class="oct-msg">${msg}</div></div>`; }

/* ---------------- Start / resume an attempt ---------------- */
function startPlayer(){ pgo('tasks'); }

/* ---------------- Pre-start instructions gate ----------------
   Shown before a fresh Begin so the rules are read BEFORE the attempt
   (and its server deadline) starts. "Begin assessment" is what actually
   calls start_player_assessment, so the clock never ticks while reading. */
function playerInstructions(assessmentId){
  ensurePlayerStyles();
  const t = (state.tasks || []).find(x => x.id === assessmentId);
  if (!t){ startPlayerForAssessment(assessmentId); return; }   // no metadata — just start
  const esc = (typeof _escP === 'function') ? _escP : (s => String(s == null ? '' : s));
  const timed = !!t.time_limit_minutes;
  const meta = `${t.question_count} question${t.question_count === 1 ? '' : 's'} · ${timed ? t.time_limit_minutes + ' minute limit' : 'no time limit'}`;
  layout.innerHTML = `<div style="flex:1;display:flex;flex-direction:column;min-height:0"><div class="main">
    <div class="player-wrap" style="max-width:600px;margin:0 auto">
      <button class="btn ghost sm" onclick="pgo('tasks')" style="margin-bottom:14px">← Back to tasks</button>
      <div class="card pad">
        <h1 style="font-size:20px;margin-bottom:4px">${esc(t.name)}</h1>
        <div class="muted small" style="margin-bottom:18px">${meta}</div>
        <div class="badge warn" style="font-size:13px;padding:7px 12px;margin-bottom:14px">⚠ Please read before you begin</div>
        <p style="margin:0 0 10px;line-height:1.6">Do not change tabs, minimise, or close the window.</p>
        ${timed ? `<p style="margin:0 0 10px;line-height:1.6">Assessment attempts are timed (<b>${t.time_limit_minutes} minutes</b>), and the moment time runs out, it will be auto-submitted.</p>` : ''}
        ${t.proctored === true ? `<p class="muted small" style="margin:0 0 4px">Leaving the assessment window is recorded; repeated violations will auto-submit your attempt.</p>` : ''}
        <div class="flex jb ac wrap g12" style="margin-top:20px">
          <span class="muted small">Once you begin${timed ? ', the timer starts immediately' : ''}.</span>
          <button class="btn" onclick="startPlayerForAssessment('${t.id}')">Begin assessment →</button>
        </div>
      </div>
    </div></div>`;
}

async function startPlayerForAssessment(assessmentId){
  ensurePlayerStyles();
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
      idx: 0, submitted: false, saveState: 'saved',
      deadlineAt: data.attempt.deadline_at ? new Date(data.attempt.deadline_at).getTime() : null,
      skewMs, dirty: {}, terminated: false, fsActive: false,
      proctored: data.assessment.proctored !== false
    };
    if (state.player.proctored) attachProctoring();
    startTimer();
    renderParticipant();
    tickTimer();
  } catch (e){
    toast('Could not start assessment: ' + (e.message || e), 'err');
    state.tasks = undefined; pgo('tasks');
  }
}

/* ---------------- Player render (two columns: question | navigator) ---------------- */
function answeredOf(q){ const a = state.player.answers[q.id]; return !!(a && ((a.selected && a.selected.length) || (a.text && a.text.trim() !== ''))); }

function pPlayer(){
  const P = state.player;
  if (!P) { pgo('tasks'); return ''; }
  if (P.submitted) return playerDone();
  ensurePlayerStyles();
  const q = P.questions[P.idx], total = P.questions.length;
  const flagged = !!P.flags[q.id];
  const ind = { saved:['','Saved'], saving:['saving','Saving…'], err:['err','Couldn’t save — retrying'] }[P.saveState] || ['','Saved'];
  const typeLabel = q.type==='fib'?'Fill in the blank':q.type==='tf'?'True / False':q.type==='multi'?'Select all that apply':q.type==='likert'?'Rating':'Multiple choice';
  return `<div>
    <div class="flex jb ac" style="margin-bottom:16px">
      <button class="btn ghost sm" onclick="exitPlayer()">✕ Save & exit</button>
      <div class="flex g12 ac">
        ${P.deadlineAt ? timerSpan() : ''}
        <span class="pill sched">${P.name}</span></div></div>
    <div class="player-grid">
      <div>
        <div class="player-top">
          <span class="small tnum" style="font-weight:600;white-space:nowrap">Question ${P.idx+1} of ${total}</span>
          <div class="qbar"><i style="width:${(P.idx+1)/total*100}%"></i></div>
          <div class="save-ind ${ind[0]}"><span class="d"></span>${ind[1]}</div></div>
        <div class="card pad" id="qArea" style="margin-top:18px">
          <span class="tag">${typeLabel}</span>
          <p style="font-size:17px;font-weight:600;margin:14px 0 18px;line-height:1.45">${q.prompt}</p>
          ${playerControls(q)}</div>
        <div class="flex jb ac" style="margin-top:18px">
          <button class="flagbtn ${flagged?'on':''}" id="flagBtn" onclick="playerFlag('${q.id}')">${flagged?'⚑ Flagged':'⚐ Flag for review'}</button>
          <div class="flex g12">
            <button class="btn ghost" onclick="playerNav(-1)" ${P.idx===0?'disabled':''}>← Previous</button>
            <button class="btn ghost" onclick="playerNav(1)" ${P.idx===total-1?'disabled':''}>Next →</button></div></div>
      </div>
      <div class="nav-rail" id="navRail">${navInner()}</div>
    </div></div>`;
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
  return `<div>`+q.options.map(o=>`<div class="opt ${isSel(o.ordinal)?'sel':''}" onclick="playerPick('${q.id}',${o.ordinal})"><span class="rd"></span>${o.label}</div>`).join('')+`</div>`;
}

/* navigator rail content (recomputed on every answer/flag, NOT a full re-render) */
function navInner(){
  const P = state.player, total = P.questions.length;
  const answered = P.questions.filter(answeredOf).length;
  const flagged  = P.questions.filter(q => P.flags[q.id]).length;
  const cells = P.questions.map((q,i)=>{
    const a = answeredOf(q), f = !!P.flags[q.id], cur = i === P.idx;
    return `<div id="rcell-${q.id}" class="rcell ${a?'ans':''} ${f?'flag':''}"
      style="${cur?'outline:2px solid var(--indigo);outline-offset:1px':''}"
      onclick="playerGoto(${i})" title="Question ${q.ordinal}">${q.ordinal}</div>`;
  }).join('');
  return `<div class="card pad">
    <h3 style="font-size:14px;margin-bottom:2px">Question navigator</h3>
    <div class="muted small" style="margin-bottom:12px">${answered}/${total} answered · ${flagged} flagged</div>
    <div class="review-grid">${cells}</div>
    <div class="legend" style="margin-top:14px;flex-direction:column;gap:6px">
      <span><i style="background:var(--indigo-l);border:1.5px solid var(--indigo);width:12px;height:12px;border-radius:3px"></i>Answered</span>
      <span><i style="background:#fff;border:1.5px solid var(--g300);width:12px;height:12px;border-radius:3px"></i>Unanswered</span>
      <span><i style="background:var(--warn-l);border:1.5px solid var(--warn);width:12px;height:12px;border-radius:3px"></i>Flagged</span></div>
    <button class="btn" style="width:100%;margin-top:16px" onclick="playerConfirmSubmit(${answered},${total})">Submit assessment</button>
  </div>`;
}
function refreshNav(){ const el = document.getElementById('navRail'); if (el) el.innerHTML = navInner(); }

/* ---------------- Answer handlers (in-place; the timer is never disturbed) ---------------- */
function playerPick(qid, ord){ state.player.answers[qid] = { selected:[ord] }; queueSave(qid); paintChoices(qid); refreshNav(); }
function playerToggle(qid, ord){
  const a = state.player.answers[qid] || { selected:[] };
  const s = new Set(a.selected || []);
  if (s.has(ord)) s.delete(ord); else s.add(ord);
  state.player.answers[qid] = { selected:[...s].sort((x,y)=>x-y) };
  queueSave(qid); paintChoices(qid); refreshNav();
}
function playerText(qid, v){ state.player.answers[qid] = { text: v }; queueSave(qid); refreshNav(); }
function playerFlag(qid){
  state.player.flags[qid] = !state.player.flags[qid]; queueSave(qid);
  const on = !!state.player.flags[qid];
  const btn = document.getElementById('flagBtn');
  if (btn){ btn.className = 'flagbtn ' + (on ? 'on' : ''); btn.textContent = on ? '⚑ Flagged' : '⚐ Flag for review'; }
  refreshNav();
}
// repaint only the current question's option highlights — keeps the timer steady (no flicker)
function paintChoices(qid){
  const P = state.player; const q = P && P.questions[P.idx];
  if (!q || q.id !== qid) return;
  const sel = (P.answers[qid] && P.answers[qid].selected) || [];
  const area = document.getElementById('qArea'); if (!area) return;
  const nodes = area.querySelectorAll('.opt, .tf button, .likert button');
  q.options.forEach((o, i) => { const n = nodes[i]; if (n) n.classList.toggle('sel', sel.indexOf(o.ordinal) !== -1); });
}

/* ---------------- Autosave ---------------- */
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
    if (String(e.message||e).toLowerCase().includes('time is up')){ autoSubmit('time'); return; }
    ids.forEach(id => P.dirty[id] = true);
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

/* ---------------- Navigation ---------------- */
function playerNav(d){
  const P = state.player; P.idx = Math.max(0, Math.min(P.questions.length-1, P.idx+d));
  renderParticipant(); tickTimer();
  const m = document.querySelector('.main'); if (m) m.scrollTo(0,0);
}
function playerGoto(i){
  state.player.idx = Math.max(0, Math.min(state.player.questions.length-1, i));
  renderParticipant(); tickTimer();
  const m = document.querySelector('.main'); if (m) m.scrollTo(0,0);
}

/* ---------------- Submit ---------------- */
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
  detachProctoring(); stopTimer(); flushSaves();
  toast('Progress saved', 'ok'); leavePlayer();
}
function leavePlayer(){ state.player = null; state.tasks = undefined; pgo('tasks'); }

/* ---------------- Countdown timer (large; updated text-only, never re-rendered on answer) ---------------- */
let _timerInt;
function timerText(){
  const P = state.player; if (!P || !P.deadlineAt) return '--:--';
  let r = Math.round((P.deadlineAt - (Date.now()+(P.skewMs||0)))/1000); if (r < 0) r = 0;
  return `${Math.floor(r/60)}:${String(r%60).padStart(2,'0')}`;
}
function timerSpan(){
  const P = state.player;
  const low = P && P.deadlineAt && (P.deadlineAt - (Date.now()+(P.skewMs||0)))/1000 <= 60;
  const danger = low ? 'background:var(--err-l);color:var(--err);' : '';
  return `<span class="pill sched" id="playerTimer" style="${danger}">${timerText()}</span>`;
}
function startTimer(){ stopTimer(); if (!state.player || !state.player.deadlineAt) return; _timerInt = setInterval(tickTimer, 1000); tickTimer(); }
function stopTimer(){ if (_timerInt){ clearInterval(_timerInt); _timerInt = null; } }
function tickTimer(){
  const P = state.player; if (!P || P.terminated || !P.deadlineAt){ stopTimer(); return; }
  let remain = Math.round((P.deadlineAt - (Date.now() + (P.skewMs||0))) / 1000);
  if (remain <= 0){ stopTimer(); autoSubmit('time'); return; }
  const el = document.getElementById('playerTimer'); if (!el) return;
  el.textContent = `${Math.floor(remain/60)}:${String(remain%60).padStart(2,'0')}`;
  el.style.background = remain <= 60 ? 'var(--err-l)' : '';
  el.style.color = remain <= 60 ? 'var(--err)' : '';
}

/* ---------------- Proctoring ---------------- */
let _proctor = {};
// Non-strike events (copy/paste/devtools/nav). Logged best-effort; never counted.
function proctorLog(ev){ const P = state.player; if (!P) return; try { sb.rpc('record_proctor_event', { p_attempt_id: P.attemptId, p_event: ev }); } catch(e){} }

// Strike events = leaving the assessment (tab switch / window blur / full-screen exit).
// Three strikes across the WHOLE attempt: warn on the 1st and 2nd, auto-submit on the 3rd.
// The running count is taken from the server (record_proctor_event), so it survives a
// page refresh once that RPC returns a count. Until then it falls back to an in-memory
// per-session count. A short debounce stops one "leave" (which can fire both
// visibilitychange and blur) from registering as two strikes.
const PROCTOR_STRIKE_LIMIT = 3;
async function registerViolation(reason){
  const P = state.player; if (!P || P.terminated) return;
  const now = Date.now();
  if (P._lastViolationAt && now - P._lastViolationAt < 1200) return;
  P._lastViolationAt = now;

  let count = null;
  try {
    const { data, error } = await sb.rpc('record_proctor_event', { p_attempt_id: P.attemptId, p_event: reason });
    if (error) throw error;
    if (data != null){
      count = (typeof data === 'number')
        ? data
        : (data.violation_count ?? data.violations ?? data.count ?? null);
    }
  } catch(e){ /* fall back to the in-memory count below */ }
  if (count == null){ P._strikes = (P._strikes || 0) + 1; count = P._strikes; }
  else { P._strikes = count; }

  if (P.terminated) return;
  if (count >= PROCTOR_STRIKE_LIMIT){ autoSubmit(reason); return; }
  proctorWarn(count, reason);
}
function proctorWarn(count, reason){
  const P = state.player; if (!P || P.terminated) return;
  const left = PROCTOR_STRIKE_LIMIT - count;
  const what = { tab_switch:'left the tab', window_blur:'left the window', fullscreen_exit:'exited full screen' }[reason] || 'left the assessment';
  // re-arm full screen so a further exit is detectable again
  if (reason === 'fullscreen_exit'){
    const el = document.documentElement;
    if (el.requestFullscreen){ el.requestFullscreen().then(()=>{ P.fsActive = true; }).catch(()=>{}); }
  }
  showModal({
    title: `Proctoring warning ${count} of ${PROCTOR_STRIKE_LIMIT}`,
    body: `You ${what} during a proctored assessment, which is not allowed. This has been recorded. `
      + (left === 1
          ? `<b>One more violation will automatically submit your assessment.</b>`
          : `After <b>${PROCTOR_STRIKE_LIMIT}</b> violations the assessment is submitted automatically.`),
    confirm: null,
    onConfirm: null
  });
}
function attachProctoring(){
  const P = state.player; if (!P) return;
  _proctor.vis = () => { if (document.hidden && !P.terminated){ registerViolation('tab_switch'); } };
  _proctor.blur = () => { setTimeout(() => { if (!P.terminated && !document.hasFocus() && !document.hidden){ registerViolation('window_blur'); } }, 200); };
  _proctor.block = e => { e.preventDefault(); proctorLog(e.type); toast('That action is disabled during the assessment','err'); };
  _proctor.keys = e => {
    const k = (e.key||'').toLowerCase();
    const blocked = e.key === 'F12'
      || ((e.ctrlKey||e.metaKey) && e.shiftKey && ['i','j','c'].includes(k))
      || ((e.ctrlKey||e.metaKey) && ['c','v','x','p','u','s'].includes(k))
      || e.key === 'PrintScreen';
    if (blocked){ e.preventDefault(); proctorLog('key:'+k); }
  };
  _proctor.beforeunload = e => { if (!P.terminated){ e.preventDefault(); e.returnValue = ''; proctorLog('nav_attempt'); } };
  _proctor.fs = () => { const inFs = !!document.fullscreenElement; if (inFs) P.fsActive = true; else if (P.fsActive && !P.terminated){ registerViolation('fullscreen_exit'); } };
  document.addEventListener('visibilitychange', _proctor.vis);
  window.addEventListener('blur', _proctor.blur);
  document.addEventListener('contextmenu', _proctor.block);
  document.addEventListener('copy', _proctor.block);
  document.addEventListener('cut', _proctor.block);
  document.addEventListener('paste', _proctor.block);
  document.addEventListener('keydown', _proctor.keys, true);
  window.addEventListener('beforeunload', _proctor.beforeunload);
  document.addEventListener('fullscreenchange', _proctor.fs);
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
