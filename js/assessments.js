/* =====================================================================
 * CEGIS — js/assessments.js  (Phase 7)
 *
 * The assessment upload wizard: Upload → Validate & fix → Preview → Deploy.
 *
 *   • Parses .xlsx/.xls/.csv in the BROWSER with SheetJS (CDN).
 *   • Validates against the EXPECTED per-stage template (technical vs WPCA),
 *     reporting precise per-row / per-column errors.
 *   • Normalizes BOTH formats into the single questions + question_options
 *     shape, then performs the AUTHORITATIVE insert via the import_assessment
 *     RPC, and deploys via the deploy_assessment RPC (migration 0006).
 *
 * Loaded AFTER admin.js so these definitions override the prototype stubs.
 *
 * --- COLUMN CONTRACTS ---
 * Technical (baseline/eoca/endline):
 *   qno, competency, level, qtype, marks, ques,
 *   opt1..opt5, isopt1correct..isopt5correct
 *   qtype ∈ { mcqsca (one correct), mcqmca (2+ correct), tf }
 * WPCA (wpca stage) — rating scale:
 *   qno, competency, ques, opt1..opt5
 *   opt1..opt5 are the scale LABELS (any ordered words, opt1 = lowest);
 *   you are NOT limited to the standard agree/disagree wording.
 *
 * Integration points (earlier phases): sb, state, mountOctopus, toast,
 * showModal/closeModal, renderAdmin/go, and a selected cohort id resolved
 * by currentCohortId().
 * ===================================================================== */

/* ---------- canonical templates ---------- */
const ASMT_FORMATS = {
  technical: {
    label: 'Technical (mcqsca / mcqmca / tf)',
    stages: ['baseline', 'eoca', 'endline'],
    headers: ['qno','competency','level','qtype','marks','ques',
              'opt1','opt2','opt3','opt4','opt5',
              'isopt1correct','isopt2correct','isopt3correct','isopt4correct','isopt5correct'],
  },
  wpca: {
    label: 'WPCA · 360 (rating scale)',
    stages: ['wpca'],
    // opt1..opt5 hold the scale LABELS — any ordered words, not just Likert agreement.
    // qtype marks a row as 'gate' (Yes/Partially/No) or 'likert'; blank = likert.
    headers: ['qno','competency','qtype','ques','opt1','opt2','opt3','opt4','opt5'],
  },
};

/* qtype tokens accepted in the technical format -> internal question_type */
const QTYPE_MAP = {
  mcqsca: 'mcq',    // single correct answer
  mcqmca: 'multi',  // 2+ correct answers
  tf:     'tf',     // true / false
  // tolerant synonyms (still resolve to the three allowed kinds)
  sca: 'mcq', mcq: 'mcq', single: 'mcq',
  mca: 'multi', mcqma: 'multi', multi: 'multi', multiple: 'multi',
  'true/false': 'tf', truefalse: 'tf', boolean: 'tf',
};

/* ---------- small helpers ---------- */
function _truthy(v){
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y'
      || s === 't' || s === '✓' || s === 'correct' || s === 'x';
}
function _splitComp(v){
  return String(v == null ? '' : v).split(/[,;|]/).map(s => s.trim()).filter(Boolean);
}
function _normToken(v){
  return String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_\-]+/g, '');
}
// resolve the cohort currently selected in the context bar.
// Matches Phase 6 credentials.js: the #cohortSel option VALUE is the cohort uuid.
function currentCohortId(){
  const sel = document.getElementById('cohortSel');
  if (sel && sel.value) return sel.value;                       // primary: same source Phase 6 uses
  if (typeof window.getCurrentCohortId === 'function') return window.getCurrentCohortId();
  if (window.CURRENT_COHORT_ID) return window.CURRENT_COHORT_ID;
  if (typeof state === 'object' && state && state.cohortId) return state.cohortId;
  if (sel && sel.selectedOptions && sel.selectedOptions[0])     // last resort: a data-id attr
    return sel.selectedOptions[0].dataset.id || null;
  return null;
}

/* ---------- SheetJS read: file -> {headers, rows} ---------- */
async function readSheet(file){
  if (!window.XLSX && typeof ensureXLSX === 'function') await ensureXLSX();
  if (!window.XLSX) throw new Error('Spreadsheet parser (SheetJS) failed to load.');
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: 'array' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!aoa.length) throw new Error('The sheet is empty.');
  // find the header row: first of the first 8 rows containing "ques"/"question" or "qno"
  let hr = 0;
  for (let i = 0; i < Math.min(aoa.length, 8); i++){
    const cells = aoa[i].map(c => String(c).toLowerCase());
    if (cells.some(c => c.includes('ques') || c === 'qno' || c.includes('question'))){ hr = i; break; }
  }
  const headers = aoa[hr].map(c => String(c).trim());
  const rows = aoa.slice(hr + 1)
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => { const o = {}; headers.forEach((h, i) => o[h] = r[i]); return o; });
  return { headers, rows };
}

/* ---------- fuzzy header mapping onto canonical fields ---------- */
function mapAssessmentHeaders(headers){
  const norm = headers.map(_normToken);
  const findBy = pred => { for (let i = 0; i < norm.length; i++) if (pred(norm[i])) return headers[i]; return null; };
  const map = {
    qno:        findBy(s => ['qno','questionno','qnumber','sno','srno','no','q'].includes(s) || s === '#'),
    qtype:      findBy(s => ['qtype','questiontype','type','format'].includes(s)),
    competency: findBy(s => s.includes('competenc') || ['skill','axis','dimension'].includes(s)),
    level:      findBy(s => ['level','difficulty','tier','band','complexity'].includes(s)),
    ques:       findBy(s => s.includes('ques') || s.includes('question') || ['prompt','text','item'].includes(s)),
    marks:      findBy(s => ['marks','mark','points','point','score','weight','weightage'].includes(s)),
  };
  for (let n = 1; n <= 5; n++){
    // option label column: contains opt/option/choice + the digit, but NOT a correctness flag
    map['option'+n] = findBy(s => !s.includes('correct') && !s.startsWith('is')
      && (s === 'opt'+n || s === 'option'+n || s === 'choice'+n || s === 'o'+n
          || s.startsWith('opt'+n) || s.startsWith('option'+n)));
    // correctness column: contains 'correct' + the digit (isopt1correct / is1correct / correct1 …)
    map['is'+n+'correct'] = findBy(s => s.includes('correct') && s.includes(String(n)));
  }
  return map;
}

/* ---------- validation + normalization ----------
 * returns { questions:[normalized], errors:[{row,col,msg}], warnings:[...] }
 */
function validateAssessment(rows, map, format){
  const errors = [], warnings = [], questions = [];
  const seenOrd = new Set();

  rows.forEach((r, idx) => {
    const rowNo = idx + 1;
    const push = (col, msg) => errors.push({ row: rowNo, col, msg });
    const get = key => map[key] != null ? String(r[map[key]] == null ? '' : r[map[key]]).trim() : '';

    // ordinal
    let ordinal = parseInt(get('qno'), 10);
    if (!Number.isFinite(ordinal)) { ordinal = rowNo; warnings.push({ row: rowNo, col:'qno', msg:'no qno — using row position' }); }
    if (seenOrd.has(ordinal)) push('qno', `duplicate question number ${ordinal}`);
    seenOrd.add(ordinal);

    // prompt
    const prompt = get('ques');
    if (!prompt) push('ques', 'question text is required');

    // competency + level
    const competency = _splitComp(get('competency'));
    const level = get('level') || null;

    // option labels present (skip blank columns)
    const options = [];
    for (let n = 1; n <= 5; n++){
      const label = get('opt'+n) || get('option'+n);
      if (label === '') continue;
      const is_correct = format === 'wpca' ? false : _truthy(get('is'+n+'correct'));
      options.push({ ordinal: n, label, is_correct });
    }
    const nCorrect = options.filter(o => o.is_correct).length;

    const q = { ordinal, prompt, level, competency, marks: null, options };

    if (format === 'wpca'){
      // WPCA rows are unscored. Most are 'likert' rating items. A row may also
      // be a 'gate' item — the "apply this competency at work" Yes/Partially/No
      // question — flagged with qtype = gate. Both share the same rules (no
      // marks, a competency tag so the gate ties to its ratings, plain labels).
      // A blank/absent qtype defaults to likert, so older 21-row templates with
      // no qtype column keep working unchanged.
      const wtype = _normToken(get('qtype'));          // '', 'gate', 'likert', …
      q.type = (wtype === 'gate') ? 'gate' : 'likert';
      q.marks = null;
      q.level = null;                       // level is a technical-only concept
      if (competency.length === 0) push('competency', 'a competency (the 360 radar axis) is required');
      if (options.length === 1) push('options', (q.type === 'gate' ? 'a gate question' : 'a rating scale') + ' needs at least 2 labels');
      q.options = options.map(o => ({ ...o, is_correct: false }));   // labels only; any words
    } else {
      // technical: qtype is required, one of mcqsca / mcqmca / tf
      const raw = _normToken(get('qtype'));
      let internal = QTYPE_MAP[raw];
      if (!raw){
        // tolerate a blank qtype by inferring, but warn
        if (options.length === 2 && options.every(o => ['true','false'].includes(o.label.toLowerCase()))) internal = 'tf';
        else internal = nCorrect >= 2 ? 'multi' : 'mcq';
        warnings.push({ row: rowNo, col:'qtype', msg:`qtype blank — inferred ${internal === 'mcq' ? 'mcqsca' : internal === 'multi' ? 'mcqmca' : 'tf'}` });
      } else if (!internal){
        push('qtype', `qtype must be mcqsca, mcqmca, or tf (got "${get('qtype')}")`);
        internal = 'mcq';
      }
      q.type = internal;

      // marks (required, positive)
      const marksRaw = get('marks');
      const marks = parseFloat(marksRaw);
      if (marksRaw === '' || !Number.isFinite(marks) || marks <= 0) push('marks', 'a positive marks value is required');
      else q.marks = marks;

      // per-type rules
      if (options.length < 2) push('options', `${raw || internal} needs at least 2 options`);
      if (internal === 'multi' && nCorrect < 2) push('correct', 'mcqmca needs 2 or more correct answers');
      if (internal === 'mcq'   && nCorrect !== 1) push('correct', `mcqsca needs exactly 1 correct answer (found ${nCorrect})`);
      if (internal === 'tf'){
        if (options.length !== 2) push('options', 'tf needs exactly 2 options (True / False)');
        if (nCorrect !== 1) push('correct', `tf needs exactly 1 correct answer (found ${nCorrect})`);
      }
    }

    q._row = rowNo;
    questions.push(q);
  });

  if (questions.length === 0) errors.push({ row: 0, col:'file', msg:'no question rows found' });
  return { questions, errors, warnings };
}

/* ---------- wizard view (overrides the prototype stub) ----------
 * Steps are keyed (not raw indices) so the technical flow can carry an extra
 * "Objectives" step between Preview and Deploy while WPCA keeps four steps. */
function asmtStepKeys(A){
  return A.kind === 'wpca'
    ? ['upload','validate','preview','deploy']
    : ['upload','validate','preview','objectives','deploy'];   // #2 objectives step
}
const ASMT_STEP_LABELS = { upload:'Upload file', validate:'Validate & fix', preview:'Preview', objectives:'Objectives', deploy:'Deploy' };
function asmtNextStep(){ const A=state.asmt; A.step = Math.min(asmtStepKeys(A).length-1, (A.step||0)+1); renderAdmin(); }
function asmtPrevStep(){ const A=state.asmt; A.step = Math.max(0, (A.step||0)-1); renderAdmin(); }

function vAssessments(){
  const A = state.asmt || (state.asmt = { kind:'technical', stage:'eoca', name:'', step:0, creating:false });
  if (!A.creating) return asmtListView();          // list-first; the wizard is opened via ＋ New assessment
  const keys = asmtStepKeys(A);
  if (A.step >= keys.length) A.step = keys.length - 1;
  state.uploadStep = A.step;
  const key = keys[A.step] || 'upload';

  let stepper = '<div class="stepper">';
  keys.forEach((k,i)=>{ stepper += `<div class="step ${A.step===i?'active':A.step>i?'done':''}">
    <span class="n">${A.step>i?'✓':i+1}</span>${ASMT_STEP_LABELS[k]}</div>${i<keys.length-1?'<span class="arrow">→</span>':''}`; });
  stepper += '</div>';

  let body;
  if (key === 'upload') body = asmtUploadView(A);
  else if (key === 'validate') body = asmtValidateView(A);
  else if (key === 'preview') body = asmtPreviewView(A);
  else if (key === 'objectives') body = asmtObjectivesView(A);
  else body = asmtDeployView(A);

  return `<div class="crumb">Assessments / New</div>
    <div class="page-head"><h1>New Assessment</h1>
      <button class="btn ghost" onclick="asmtBackToList()">← Back to list</button></div>${stepper}${body}`;
}

/* ---------- list view: created assessments for the active cohort ----------
 * Reuses the existing renderAdmin trigger: admin.js calls loadAssessmentList()
 * whenever the Assessments screen renders. This definition (loaded after
 * admin.js) overrides the earlier stub and targets #asmtListBody.
 */
function asmtListView(){
  return `<div class="crumb">Manage / Assessments</div>
    <div class="page-head"><h1>Assessments</h1>
      <div class="flex g12 ac">${typeof histBtn==='function'?histBtn():''}<button class="btn" onclick="asmtNew()">＋ New assessment</button></div></div>
    <div id="asmtListBody"><div class="card pad"><p class="muted small" style="margin:0">Loading…</p></div></div>
    <div id="histListBody"></div>`;
}
function asmtNew(){
  state.asmt = { kind:'technical', stage:'eoca', name:'', step:0, creating:true };
  renderAdmin();
}
function asmtBackToList(){
  state.asmt = { kind:'technical', stage:'eoca', name:'', step:0, creating:false };
  renderAdmin();
}

let _asmtListCache = { cid:null, list:null };
function _asmtEsc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
// Markdown subset -> safe HTML. Escape first (so no raw HTML survives), then
// apply only **bold**, *italic*, and newlines. Shared with the player (loaded later).
function mdToSafeHtml(text){
  let h = _asmtEsc(text);
  h = h.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
  h = h.replace(/\r?\n/g, '<br>');
  return h;
}
function renderAsmtList(list){
  const pillClass = s => ({live:'live',scheduled:'sched',closed:'closed'})[s] || 'idle';
  const fmt = d => d ? new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short'}) : '—';
  const kindLabel = k => k==='wpca' ? 'WPCA · 360' : 'Technical';
  if (!list.length){
    return `<div class="card pad"><div class="flex jb ac"><h3>Assessments in this cohort</h3><span class="muted small">0 created</span></div>
      <p class="muted small" style="margin:8px 0 0">None yet. Click <b>＋ New assessment</b> to upload and deploy your first instrument.</p></div>`;
  }
  const rows = list.map(a => `<tr>
    <td><b>${_asmtEsc(a.name)}</b></td>
    <td><span class="tag">${kindLabel(a.kind)}</span></td>
    <td>${_asmtEsc((a.stage||'').toUpperCase())}</td>
    <td><span class="pill ${pillClass(a.status)}">${_asmtEsc(a.status||'draft')}</span></td>
    <td class="muted small">${fmt(a.opens_at)} → ${fmt(a.closes_at)}</td>
    <td style="text-align:right">${a.kind==='technical'?`<button class="btn ghost sm" onclick="asmtOpenObjectives('${a.id}','${_asmtEsc(a.name).replace(/'/g,"\\'")}')">Objectives</button> `:''}<button class="btn ghost sm" onclick="asmtDelete('${a.id}')">Delete</button></td>
  </tr>`).join('');
  return `<div class="card">
    <div class="pad" style="border-bottom:1px solid var(--g200)"><div class="flex jb ac"><h3>Assessments in this cohort</h3><span class="muted small">${list.length} created</span></div></div>
    <div style="overflow:auto"><table><thead><tr><th>Name</th><th>Type</th><th>Stage</th><th>Status</th><th>Window</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
/* ---------- historical checkpoints (listed under the assessments) ----------
 * A checkpoint is a point-in-time set of per-competency percentages with NO
 * instrument, so it can't be a normal assessment row (no Type/Status/Window).
 * We show them in their own card right below the assessments table. Data comes
 * from the list_historical_checkpoints RPC (admin + org checked server-side);
 * historical.js busts _histListCache after an import so a new one shows up.
 */
let _histListCache = { cid:null, list:null };

// stage code -> friendly label (matches the picker in historical.js)
const _histStageLabel = s => ({
  baseline:'Baseline', eoca:'EoCA / mid-line', endline:'Endline', wpca:'WPCA'
}[s] || (s || '—'));

function renderHistList(list){
  const fmt = d => d ? new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}) : '—';
  // No checkpoints -> render nothing (keep the screen uncluttered).
  if (!list.length) return '';
  const rows = list.map(h => `<tr>
    <td><b>${_asmtEsc(h.label)}</b></td>
    <td><span class="tag">${_asmtEsc(_histStageLabel(h.stage))}</span></td>
    <td class="muted small">${fmt(h.occurred_on)}</td>
    <td class="muted small">${(h.participant_count||0)} participant(s) · ${(h.score_count||0)} score(s)</td>
    <td style="text-align:right"><button class="btn ghost sm" onclick="histDelete('${h.id}')">Delete</button></td>
  </tr>`).join('');
  return `<div class="card" style="margin-top:16px">
    <div class="pad" style="border-bottom:1px solid var(--g200)"><div class="flex jb ac">
      <h3>Historical checkpoints</h3><span class="muted small">${list.length} imported</span></div>
      <p class="muted small" style="margin:6px 0 0">Pre-platform marks — no online test. These appear on participants' reports alongside the in-app checkpoints.</p></div>
    <div style="overflow:auto"><table><thead><tr><th>Label</th><th>Stage</th><th>Date</th><th>Coverage</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

async function loadHistoricalList(force){
  const el = document.getElementById('histListBody');
  if (!el) return;                                  // not on the list screen
  const authed = !!(typeof AUTH!=='undefined' && AUTH.session && !AUTH.demo);
  if (!authed){ el.innerHTML = ''; return; }         // demo mode: nothing to show
  const cid = currentCohortId();
  if (!cid){ el.innerHTML = ''; return; }            // no cohort selected
  // serve from cache unless forced
  if (!force && _histListCache.cid===cid && _histListCache.list){ el.innerHTML = renderHistList(_histListCache.list); return; }
  try{
    const { data, error } = await sb.rpc('list_historical_checkpoints', { p_cohort_id: cid });
    if (error) throw error;
    _histListCache = { cid, list: data||[] };
    el.innerHTML = renderHistList(_histListCache.list);
  }catch(e){
    // Non-fatal: never break the assessments screen if this read fails.
    el.innerHTML = `<div class="card pad" style="margin-top:16px"><p class="muted small" style="margin:0">Couldn't load historical checkpoints: ${_asmtEsc((e&&e.message)||e)}</p></div>`;
  }
}

function histDelete(id){
  const h = (_histListCache.list||[]).find(x=>x.id===id);
  const name = h ? h.label : 'this checkpoint';
  showModal({
    title: 'Delete historical checkpoint?',
    body: `Delete <b>${_asmtEsc(name)}</b> and all of its imported scores? This permanently removes those marks from participants' reports and cannot be undone.`,
    confirm: 'Delete',
    onConfirm: async () => {
      closeModal();
      try{
        const { error } = await sb.rpc('delete_historical_checkpoint', { p_checkpoint_id: id });
        if (error) throw error;
        toast('Checkpoint deleted', 'ok');
        _histListCache = { cid:null, list:null };     // bust cache so the row disappears
        loadHistoricalList(true);
      }catch(e){ toast('Delete failed: ' + (e.message || e), 'err'); }
    }
  });
}

async function loadAssessmentList(force){
  const el = document.getElementById('asmtListBody');
  if (!el) return;                                  // not on the list (wizard mode / other screen)
  const authed = !!(typeof AUTH!=='undefined' && AUTH.session && !AUTH.demo);
  if (!authed){
    el.innerHTML = `<div class="card pad"><div class="flex jb ac"><h3>Assessments in this cohort</h3><span class="badge warn">demo</span></div>
      <p class="muted small" style="margin:8px 0 0">Connect Supabase to create and manage assessments for a cohort.</p></div>`;
    return;
  }
  const cid = currentCohortId();
  if (!cid){ el.innerHTML = `<div class="card pad"><p class="muted small" style="margin:0">Select a cohort in the top bar to see its assessments.</p></div>`; loadHistoricalList(force); return; }
  if (!force && _asmtListCache.cid===cid && _asmtListCache.list){ el.innerHTML = renderAsmtList(_asmtListCache.list); loadHistoricalList(force); return; }
  el.innerHTML = `<div class="card pad"><p class="muted small" style="margin:0">Loading…</p></div>`;
  try{
    const { data, error } = await sb.from('assessments')
      .select('id,name,kind,stage,status,opens_at,closes_at,created_at')
      .eq('cohort_id', cid).is('deleted_at', null)
      .order('created_at', { ascending:false });
    if (error) throw error;
    _asmtListCache = { cid, list: data||[] };
    el.innerHTML = renderAsmtList(_asmtListCache.list);
    loadHistoricalList(force);                        // show this cohort's checkpoints too
  }catch(e){
    el.innerHTML = `<div class="card pad"><p class="badge err" style="margin:0">Couldn't load assessments: ${_asmtEsc((e&&e.message)||e)}</p></div>`;
  }
}
function asmtDelete(id){
  const a = (_asmtListCache.list||[]).find(x=>x.id===id);
  const name = a ? a.name : 'this assessment';
  showModal({
    title: 'Delete assessment?',
    body: `Delete <b>${_asmtEsc(name)}</b> from this cohort? This soft-deletes it (recoverable in the database) and removes it from participants' view.`,
    confirm: 'Delete',
    onConfirm: async () => {
      closeModal();
      try{
        const { error } = await sb.rpc('delete_assessment', { p_assessment_id: id });
        if (error) throw error;
        toast('Assessment deleted', 'ok');
        _asmtListCache = { cid:null, list:null };   // bust cache so the row disappears
        loadAssessmentList(true);
      }catch(e){ toast('Delete failed: ' + (e.message || e), 'err'); }
    }
  });
}

function asmtUploadView(A){
  const fmt = ASMT_FORMATS[A.kind];
  const stageOpts = fmt.stages.map(s =>
    `<option value="${s}" ${A.stage===s?'selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('');
  return `<div class="card pad">
    <div class="grid" style="grid-template-columns:1fr 1fr 1.4fr;gap:14px;margin-bottom:16px">
      <div><label class="muted small" style="font-weight:600">Format</label>
        <select class="cohort-sel" style="width:100%" onchange="asmtSetKind(this.value)">
          <option value="technical" ${A.kind==='technical'?'selected':''}>Technical (mcqsca / mcqmca / tf)</option>
          <option value="wpca" ${A.kind==='wpca'?'selected':''}>WPCA · 360 (rating scale)</option>
        </select></div>
      <div><label class="muted small" style="font-weight:600">Stage</label>
        <select class="cohort-sel" style="width:100%" onchange="state.asmt.stage=this.value">${stageOpts}</select></div>
      <div><label class="muted small" style="font-weight:600">Assessment name</label>
        <input class="cohort-sel" style="width:100%" placeholder="e.g. EoCA 2 — Data Capacity"
               value="${A.name||''}" oninput="state.asmt.name=this.value"></div>
    </div>
    <div class="flex jb ac wrap" style="margin-bottom:10px">
      <h3>Upload ${fmt.label} instrument</h3>
      <span class="tag">Columns: ${fmt.headers.slice(0,6).join(' · ')} …</span></div>
    <input type="file" id="asmtFile" accept=".xlsx,.xls,.csv" style="display:none" onchange="asmtPick(this.files[0])">
    <div class="dz" id="asmtDz" onclick="document.getElementById('asmtFile').click()"
         ondragover="event.preventDefault();this.classList.add('drag')"
         ondragleave="this.classList.remove('drag')"
         ondrop="event.preventDefault();this.classList.remove('drag');asmtPick(event.dataTransfer.files[0])">
      <div style="font-size:34px">⤓</div>
      <div style="font-weight:600;margin-top:6px">Drop your .xlsx / .csv here or click to choose a file</div>
      <div class="muted small">Parsed in your browser — nothing uploads until you deploy.</div>
    </div>
    <div class="flex g12 wrap" style="margin-top:12px">
      <button class="btn ghost sm" onclick="asmtDownloadTemplate('technical')">↓ Technical CSV template</button>
      <button class="btn ghost sm" onclick="asmtDownloadTemplate('wpca')">↓ WPCA CSV template</button>
    </div></div>`;
}
function asmtSetKind(kind){
  state.asmt.kind = kind;
  state.asmt.stage = ASMT_FORMATS[kind].stages[0];
  renderAdmin();
}
function asmtPick(file){
  if (!file) return;
  const A = state.asmt;
  if (!A.name || !A.name.trim()){ toast('Give the assessment a name first','err'); return; }
  if (!currentCohortId()){ toast('Select a cohort in the top bar first','err'); return; }
  A.file = file; A.fileName = file.name;
  mountOctopus(document.querySelector('.main'), 'Parsing your question bank…');
  (async () => {
    try {
      const { headers, rows } = await readSheet(file);
      const map = mapAssessmentHeaders(headers);
      const result = validateAssessment(rows, map, A.kind);
      A.headers = headers; A.map = map;
      A.questions = result.questions; A.errors = result.errors; A.warnings = result.warnings;
      A.rowCount = rows.length;
      A.step = 1;
      const bad = result.errors.length;
      toast(bad ? `Parsed ${rows.length} rows — ${bad} issue(s) to review`
                : `Parsed ${rows.length} questions cleanly`, bad ? 'err' : 'ok');
      renderAdmin();
    } catch (e){
      toast('Could not read file: ' + e.message, 'err');
      A.step = 0; renderAdmin();
    }
  })();
}

function asmtValidateView(A){
  const hardErrs = A.errors.filter(e => e.row !== 0);
  const fileErr = A.errors.find(e => e.row === 0);
  const rows = A.questions.map(q => {
    const errs = A.errors.filter(e => e.row === q._row);
    const warns = A.warnings.filter(w => w.row === q._row);
    const status = errs.length
      ? `<span class="badge err">⚠ ${errs.map(e=>e.msg).join('; ')}</span>`
      : warns.length
        ? `<span class="badge warn">⚠ ${warns.map(w=>w.msg).join('; ')}</span>`
        : '<span class="badge ok">✓ Valid</span>';
    return `<tr><td class="tnum">${q.ordinal}</td>
      <td><span class="tag">${(q.type==='mcq'?'mcqsca':q.type==='multi'?'mcqmca':q.type).toUpperCase()}</span></td>
      <td>${q.level?`<span class="tag">${q.level}</span>`:'—'}</td>
      <td style="max-width:300px">${A.kind==='wpca'
        ? (q.prompt
            ? (typeof wpca360PromptHtml === 'function'
                ? wpca360PromptHtml(q.prompt)
                : `In the last two weeks, did <span class="muted">[name]</span> ${_asmtEsc(q.prompt)}?`)
            : '<span class="muted">(blank)</span>')
        : (q.prompt || '<span class="muted">(blank)</span>')}</td>
      <td>${q.options.length || '—'}</td>
      <td>${(q.competency||[]).map(c=>`<span class="tag">${c}</span>`).join(' ')||'—'}</td>
      <td>${status}</td></tr>`;
  }).join('');
  const ok = A.questions.length - new Set(hardErrs.map(e=>e.row)).size;
  const banner = (hardErrs.length || fileErr)
    ? `<span class="badge err" style="font-size:13px;padding:6px 12px">⚠</span>
       <div><b>${ok} of ${A.questions.length} questions valid.</b>
       <span class="muted">${fileErr?fileErr.msg+'. ':''}Fix the flagged rows in your file and re-upload.</span></div>`
    : `<span class="badge ok" style="font-size:13px;padding:6px 12px">✓</span>
       <div><b>All ${A.questions.length} questions parsed cleanly.</b>
       <span class="muted">Detected format: ${ASMT_FORMATS[A.kind].label}.</span></div>`;
  const blocked = hardErrs.length > 0 || !!fileErr;
  return `<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12">${banner}</div></div>
    <div class="card"><div style="overflow:auto"><table>
      <thead><tr><th>#</th><th>Type</th><th>Level</th><th>Question text</th><th>Options</th><th>Competency</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>
    <div class="flex g12" style="margin-top:16px;justify-content:flex-end">
      <button class="btn ghost" onclick="state.asmt.step=0;renderAdmin()">← Re-upload</button>
      <button class="btn" ${blocked?'disabled title="Resolve all errors first"':''}
        onclick="state.asmt.step=2;renderAdmin()">Continue to preview →</button></div>`;
}

function asmtPreviewView(A){
  const cards = A.questions.map((q, i) => asmtEditorCard(q, i)).join('');
  return `<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12"><span class="badge info">i</span>
      <div>Edit each question's text and optionally attach an image. <b>**bold**</b>, <i>*italic*</i> and line breaks render for participants. Options, marks and competency tags come from your file.</div></div></div>
    ${cards}
    <div class="flex g12" style="margin-top:16px;justify-content:flex-end">
      <button class="btn ghost" onclick="state.asmt.step=1;renderAdmin()">← Back</button>
      <button class="btn" onclick="asmtNextStep()">Continue →</button></div>`;
}

// One editable question card: type tag, text editor with a B/I/↵ toolbar,
// a live participant-eye preview, and an image attach/remove control.
function asmtEditorCard(q, i){
  const typeTag = (q.type==='mcq'?'mcqsca':q.type==='multi'?'mcqmca':q.type).toUpperCase();
  const isW = !!(state.asmt && state.asmt.kind === 'wpca');   // WPCA uses the role stem
  const hasImg  = !!(q._imgURL || q.image_path);
  const imgBlock = hasImg
    ? `<div class="flex ac g12" style="margin-top:6px">
         ${q._imgURL ? `<img src="${q._imgURL}" alt="" style="max-height:120px;max-width:100%;border-radius:8px;border:1px solid var(--g200)">`
                     : `<span class="muted small">image attached</span>`}
         <button class="btn ghost sm" onclick="asmtRemoveImage(${i})">Remove image</button>
       </div>`
    : `<input type="file" id="asmtImg${i}" accept="image/*" style="display:none" onchange="asmtPickImage(${i}, this.files[0])">
       <button class="btn ghost sm" style="margin-top:6px" onclick="document.getElementById('asmtImg${i}').click()">＋ Attach image</button>`;
  return `<div class="card pad" style="margin-bottom:14px">
    <div class="flex jb ac"><span class="tag">${typeTag}${q.level?' · '+q.level:''}</span><span class="muted small">Q${q.ordinal}</span></div>

    <div class="muted small" style="margin:12px 0 4px;font-weight:600">Question text</div>
    <div class="flex g8 ac wrap" style="margin-bottom:6px">
      <button class="btn ghost sm" type="button" onmousedown="event.preventDefault()" onclick="asmtFmt(${i},'**')"><b>B</b></button>
      <button class="btn ghost sm" type="button" onmousedown="event.preventDefault()" onclick="asmtFmt(${i},'*')"><i>I</i></button>
      <button class="btn ghost sm" type="button" onmousedown="event.preventDefault()" onclick="asmtNewline(${i})">↵ Line break</button>
      <span class="muted small">Select text, then Bold / Italic</span>
    </div>
    <textarea id="asmtPrompt${i}" rows="3" oninput="asmtEditPrompt(${i}, this.value)"
      style="width:100%;padding:11px 13px;border:1.5px solid var(--g300);border-radius:10px;font:inherit;line-height:1.5;resize:vertical">${_asmtEsc(q.prompt)}</textarea>

    <div class="muted small" style="margin:12px 0 4px;font-weight:600">Participant preview</div>
    <div style="background:var(--g50);border:1px solid var(--g200);border-radius:8px;padding:12px">
      <div style="font-weight:600;line-height:1.5">${
        isW
          ? (typeof wpca360PromptHtml === 'function'
              ? wpca360PromptHtml(q.prompt, 'asmtPrev'+i)
              /* fallback if wpca.js isn't loaded — same markup the shared fn emits */
              : `<span class="muted">In the last two weeks, did [name] </span><span id="asmtPrev${i}">${mdToSafeHtml(q.prompt)||'<span class="muted">(empty)</span>'}</span><span class="muted">?</span>`)
          : `<span id="asmtPrev${i}">${mdToSafeHtml(q.prompt)||'<span class="muted">(empty)</span>'}</span>`
      }</div>
      <div style="margin-top:12px">${asmtPreviewControls(q)}</div>
    </div>

    <div class="muted small" style="margin:14px 0 0;font-weight:600">Image</div>
    ${imgBlock}
  </div>`;
}

function asmtEditPrompt(i, val){
  const q = state.asmt.questions[i]; if (!q) return;
  q.prompt = val;
  const el = document.getElementById('asmtPrev'+i);
  if (el) el.innerHTML = mdToSafeHtml(val) || '<span class="muted">(empty)</span>';
}

// wrap the current selection (or a placeholder) in a markdown marker
function asmtFmt(i, marker){
  const ta = document.getElementById('asmtPrompt'+i); if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const sel = (s !== e) ? v.slice(s, e) : (marker==='**' ? 'bold text' : 'italic text');
  ta.value = v.slice(0, s) + marker + sel + marker + v.slice(e);
  const ns = s + marker.length;
  ta.focus(); ta.setSelectionRange(ns, ns + sel.length);
  asmtEditPrompt(i, ta.value);
}
function asmtNewline(i){
  const ta = document.getElementById('asmtPrompt'+i); if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  ta.value = v.slice(0, s) + '\n' + v.slice(e);
  const c = s + 1; ta.focus(); ta.setSelectionRange(c, c);
  asmtEditPrompt(i, ta.value);
}

// upload an image to the private question-images bucket; store the org-scoped path
async function asmtPickImage(i, file){
  const q = state.asmt.questions[i];
  if (!q || !file) return;
  if (!/^image\//.test(file.type)){ toast('Please choose an image file', 'err'); return; }
  if (file.size > 5 * 1024 * 1024){ toast('Image must be under 5 MB', 'err'); return; }
  const cohortId = currentCohortId();
  if (!cohortId){ toast('Select a cohort first', 'err'); return; }
  if (!window.AUTH || !AUTH.orgId){ toast('Not signed in', 'err'); return; }
  const ext  = ((file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'png';
  const path = `${AUTH.orgId}/${cohortId}/q${q.ordinal}-${Date.now()}.${ext}`;
  toast('Uploading image…');
  try {
    const { error } = await sb.storage.from('question-images').upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw error;
    if (q.image_path && q.image_path !== path){ try { sb.storage.from('question-images').remove([q.image_path]); } catch(e){} }
    if (q._imgURL){ try { URL.revokeObjectURL(q._imgURL); } catch(e){} }
    q.image_path = path;
    q._imgURL = URL.createObjectURL(file);
    toast('Image attached', 'ok');
    renderAdmin();
  } catch(e){ toast('Upload failed: ' + (e.message || e), 'err'); }
}
function asmtRemoveImage(i){
  const q = state.asmt.questions[i]; if (!q) return;
  if (q.image_path){ try { sb.storage.from('question-images').remove([q.image_path]); } catch(e){} }
  if (q._imgURL){ try { URL.revokeObjectURL(q._imgURL); } catch(e){} }
  q.image_path = null; q._imgURL = null;
  renderAdmin();
}
function asmtPreviewControls(q){
  const dis = 'style="pointer-events:none;opacity:.85"';
  if (q.type === 'tf')
    return `<div class="tf" ${dis}>`+q.options.map(o=>`<button>${o.label}</button>`).join('')+`</div>`;
  if (q.type === 'likert'){
    const labs = q.options.length ? q.options.map(o=>o.label) : ['Strongly disagree','Disagree','Neutral','Agree','Strongly agree'];
    return `<div class="likert" ${dis}>`+labs.map(o=>`<button>${o}</button>`).join('')+`</div>`;
  }
  // mcqsca / mcqmca
  return `<div ${dis}>`+q.options.map(o=>`<div class="opt"><span class="rd"></span>${o.label}</div>`).join('')+`</div>`;
}

/* ============================================================
   #2 OBJECTIVES  — map each competency code used by the instrument to a
   full objective title (+ optional learning outcome). Prospective: a wizard
   step between Preview and Deploy. Retrospective: a modal off the list.
   ============================================================ */
function asmtDistinctCodes(questions){
  const seen = new Set(), out = [];
  (questions || []).forEach(q => (q.competency || []).forEach(c => {
    const t = String(c == null ? '' : c).trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }));
  return out;
}
// live edit store keyed by array index (codes can contain spaces/quotes)
function asmtSetObj(i, field, val){
  const A = state.asmt; const code = (A.objCodes || [])[i]; if (code == null) return;
  A.objMap = A.objMap || {};
  A.objMap[code] = A.objMap[code] || { title:'', learning_outcome:'' };
  A.objMap[code][field] = val;
}
function asmtCollectObjectives(){
  const A = state.asmt, out = [];
  (A.objCodes || []).forEach((code, idx) => {
    const o = (A.objMap || {})[code] || {};
    if (o.title && o.title.trim()){
      out.push({ code, title: o.title.trim(),
                 learning_outcome: (o.learning_outcome || '').trim() || null, ordinal: idx + 1 });
    }
  });
  return out;
}
function asmtObjectivesView(A){
  A.objCodes = asmtDistinctCodes(A.questions);
  A.objMap = A.objMap || {};
  A.objCodes.forEach(c => { A.objMap[c] = A.objMap[c] || { title:'', learning_outcome:'' }; });
  const rows = A.objCodes.length
    ? A.objCodes.map((c,i) => `<div class="card pad" style="margin-bottom:12px">
        <span class="tag">${_asmtEsc(c)}</span>
        <input id="wobj_t_${i}" placeholder="Objective title — shown in reports instead of &quot;${_asmtEsc(c)}&quot;"
          value="${_asmtEsc(A.objMap[c].title||'')}" oninput="asmtSetObj(${i},'title',this.value)"
          style="width:100%;margin-top:8px;padding:10px 12px;border:1.5px solid var(--g300);border-radius:9px;font:inherit">
        <textarea id="wobj_o_${i}" rows="2" placeholder="Learning outcome (optional)"
          oninput="asmtSetObj(${i},'learning_outcome',this.value)"
          style="width:100%;margin-top:8px;padding:10px 12px;border:1.5px solid var(--g300);border-radius:9px;font:inherit;resize:vertical">${_asmtEsc(A.objMap[c].learning_outcome||'')}</textarea>
      </div>`).join('')
    : `<div class="card pad"><p class="muted small" style="margin:0">No competency tags were found in these questions, so there are no objectives to define — you can continue to deploy.</p></div>`;
  return `<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12"><span class="badge info">i</span>
      <div>Map each competency code in this instrument to a full objective (and optionally a learning outcome). Reports show the objective title instead of the code. You can edit these later from the assessment list.</div></div></div>
    ${rows}
    <div class="flex g12" style="margin-top:16px;justify-content:flex-end">
      <button class="btn ghost" onclick="asmtPrevStep()">← Back</button>
      <button class="btn" onclick="asmtNextStep()">Continue to deploy →</button></div>`;
}

/* retrospective: open the same editor for an already-deployed assessment */
async function asmtOpenObjectives(assessmentId, name){
  toast('Loading objectives…');
  try {
    const { data, error } = await sb.rpc('get_objectives', { p_assessment_id: assessmentId });
    if (error) throw error;
    const codes = (data && data.codes) || [];
    const existing = {};
    ((data && data.objectives) || []).forEach(o => { existing[o.code] = { title:o.title||'', learning_outcome:o.learning_outcome||'' }; });
    asmtObjModal(assessmentId, name, codes, existing);
  } catch(e){ toast('Could not load objectives: ' + (e.message || e), 'err'); }
}
function asmtObjModal(assessmentId, name, codes, existing){
  const all = codes.slice();
  Object.keys(existing).forEach(c => { if (!all.some(x => x.toLowerCase() === c.toLowerCase())) all.push(c); });
  window.__objEdit = { assessmentId, codes: all, map: {} };
  all.forEach(c => { window.__objEdit.map[c] = existing[c] ? { title:existing[c].title||'', learning_outcome:existing[c].learning_outcome||'' } : { title:'', learning_outcome:'' }; });
  const rows = all.length
    ? all.map((c,i) => `<div class="card pad" style="margin-bottom:10px">
        <span class="tag">${_asmtEsc(c)}</span>
        <input id="obr_t_${i}" placeholder="Objective title" value="${_asmtEsc(window.__objEdit.map[c].title)}"
          oninput="asmtObjEdit(${i},'title',this.value)"
          style="width:100%;margin-top:8px;padding:10px 12px;border:1.5px solid var(--g300);border-radius:9px;font:inherit">
        <textarea id="obr_o_${i}" rows="2" placeholder="Learning outcome (optional)"
          oninput="asmtObjEdit(${i},'learning_outcome',this.value)"
          style="width:100%;margin-top:8px;padding:10px 12px;border:1.5px solid var(--g300);border-radius:9px;font:inherit;resize:vertical">${_asmtEsc(window.__objEdit.map[c].learning_outcome)}</textarea>
      </div>`).join('')
    : '<p class="muted small">No competency tags on this assessment, so there are no objectives to define.</p>';
  showModal({
    title: `Objectives — ${_asmtEsc(name)}`,
    body: `<div class="muted small" style="margin-bottom:10px">Give each competency code a full objective title (shown in reports instead of the code) and an optional learning outcome.</div>
      <div style="max-height:52vh;overflow:auto">${rows}</div>`,
    confirm: all.length ? 'Save objectives' : null,
    onConfirm: all.length ? asmtObjModalSave : null
  });
}
function asmtObjEdit(i, field, val){
  const E = window.__objEdit; if (!E) return;
  const code = E.codes[i]; if (code == null) return;
  E.map[code] = E.map[code] || {}; E.map[code][field] = val;
}
async function asmtObjModalSave(){
  const E = window.__objEdit; if (!E) return;
  const rows = E.codes.map((c,idx) => {
    const o = E.map[c] || {};
    return (o.title && o.title.trim())
      ? { code:c, title:o.title.trim(), learning_outcome:(o.learning_outcome||'').trim() || null, ordinal:idx+1 }
      : null;
  }).filter(Boolean);
  closeModal();
  try {
    const { error } = await sb.rpc('set_objectives', { p_assessment_id: E.assessmentId, p_rows: rows });
    if (error) throw error;
    toast('Objectives saved', 'ok');
  } catch(e){ toast('Save failed: ' + (e.message || e), 'err'); }
}

/* ============================================================
   #12 PROCTORING toggles (deploy step)
   ============================================================ */
function asmtDefaultProctoring(){ return { tab_switch:true, copy_paste:true, right_click:true, devtools:true, fullscreen:true, nav_guard:true }; }
function asmtProctoringObj(A){ return A.proctoring || asmtDefaultProctoring(); }
function asmtAnyProctor(A){ const p = asmtProctoringObj(A); return Object.keys(p).some(k => p[k]); }
function asmtSetProctor(key, val){ const A = state.asmt; A.proctoring = A.proctoring || asmtDefaultProctoring(); A.proctoring[key] = val; }
function asmtProctorToggle(key, label){
  const A = state.asmt; A.proctoring = A.proctoring || asmtDefaultProctoring();
  const on = A.proctoring[key] !== false;
  return `<label class="kv ac" style="cursor:pointer"><span class="muted">${label}</span>
    <input type="checkbox" ${on?'checked':''} onchange="asmtSetProctor('${key}',this.checked)" style="width:18px;height:18px"></label>`;
}

function asmtDeployView(A){
  if (!A.opensAt){ const d=new Date(); A.opensAt = d.toISOString().slice(0,10); }
  if (!A.closesAt){ const d=new Date(Date.now()+14*864e5); A.closesAt = d.toISOString().slice(0,10); }
  const scored = A.questions.some(q => q.marks != null);
  setTimeout(asmtHydrateBrand, 0);
  return `<div class="card pad" style="max-width:560px"><h3 style="margin-bottom:14px">Deploy to cohort</h3>
    <div class="kv"><span class="muted">Instrument</span><b>${A.name}</b></div>
    <div class="kv"><span class="muted">Format / stage</span><b>${ASMT_FORMATS[A.kind].label} · ${A.stage}</b></div>
    <div class="kv"><span class="muted">Questions</span><b>${A.questions.length}${scored?'':' (rating scale)'}</b></div>
    <div class="kv"><span class="muted">Target cohort</span><b>selected cohort</b></div>
    <div class="kv ac"><span class="muted">Opens</span>
      <input type="date" class="cohort-sel" value="${A.opensAt}" onchange="state.asmt.opensAt=this.value"></div>
    <div class="kv ac"><span class="muted">Closes</span>
      <input type="date" class="cohort-sel" value="${A.closesAt}" onchange="state.asmt.closesAt=this.value"></div>
    <div class="kv ac"><span class="muted">Time limit</span>
      <span class="flex ac g8"><input type="number" min="1" class="cohort-sel" style="width:90px" placeholder="none"
        value="${A.timeLimit||''}" oninput="state.asmt.timeLimit=this.value"> <span class="muted small">minutes (blank = untimed)</span></span></div>
    <div class="kv ac"><span class="muted">Release</span>
      <select class="cohort-sel" onchange="state.asmt.deployStatus=this.value">
        <option value="live">Live now</option><option value="scheduled">Scheduled (opens on date)</option></select></div>
    <div style="margin-top:12px">
      <div class="muted small" style="font-weight:600;margin-bottom:6px">Participant instructions (optional)</div>
      <textarea id="asmtInstr" rows="3" oninput="state.asmt.instructions=this.value"
        placeholder="Shown before the participant begins. Leave blank to use the default instructions. **bold**, *italic* and line breaks are supported."
        style="width:100%;padding:11px 13px;border:1.5px solid var(--g300);border-radius:10px;font:inherit;line-height:1.5;resize:vertical">${_asmtEsc(A.instructions||'')}</textarea>
    </div>
    <div style="margin-top:14px">
      <div class="muted small" style="font-weight:600;margin-bottom:2px">Proctoring</div>
      ${asmtProctorToggle('tab_switch','Auto-submit if the participant leaves the tab / window')}
      ${asmtProctorToggle('fullscreen','Require full screen (exiting counts as a violation)')}
      ${asmtProctorToggle('copy_paste','Block copy / cut / paste')}
      ${asmtProctorToggle('right_click','Block right-click / context menu')}
      ${asmtProctorToggle('devtools','Block developer tools &amp; save/print shortcuts')}
      ${asmtProctorToggle('nav_guard','Warn before leaving or closing the page')}
    </div>
    <div style="margin-top:16px" id="asmtBrandBox">
      <div class="muted small" style="font-weight:600;margin-bottom:2px">Banner shown to participants (saved to this cohort)</div>
      <div class="muted small" style="margin-bottom:8px">Appears under the header and on report headers. Leave blank to inherit the organisation's branding.</div>
      <input class="cohort-sel" style="width:100%;margin-bottom:8px" id="asmtBrandMinistry" placeholder="Ministry (e.g. Ministry of Panchayati Raj)"
        value="${_asmtEsc((A.brand&&A.brand.ministry)||'')}" oninput="asmtSetBrand('ministry',this.value)">
      <input class="cohort-sel" style="width:100%;margin-bottom:8px" id="asmtBrandDept" placeholder="Department (e.g. Department of Rural Development)"
        value="${_asmtEsc((A.brand&&A.brand.department)||'')}" oninput="asmtSetBrand('department',this.value)">
      <input class="cohort-sel" style="width:100%" id="asmtBrandOrg" placeholder="Organisation (e.g. State Institute of Rural Development)"
        value="${_asmtEsc((A.brand&&A.brand.organisation)||'')}" oninput="asmtSetBrand('organisation',this.value)">
    </div>
    <div class="flex g12" style="margin-top:18px">
      <button class="btn ghost" onclick="asmtPrevStep()">← Back</button>
      <button class="btn" onclick="asmtConfirmDeploy()">Deploy to cohort</button></div>
    <p class="muted small" style="margin-top:12px">⚠ Deployment is participant-visible and cannot be undone once released.</p></div>`;
}

/* ---------- cohort banner branding (Ministry / Department / Organisation) ---------- */
function asmtSetBrand(key, val){ const A = state.asmt; A.brand = A.brand || {}; A.brand[key] = val; A.brandTouched = true; }
async function asmtHydrateBrand(){
  const A = state.asmt; if (!A) return;
  if (A.brand !== undefined) return;                    // already loaded or user has typed
  A.brand = {};                                         // mark loaded to avoid refetch loops
  const cid = currentCohortId();
  if (!cid || !window.sb || !window.AUTH || !AUTH.orgId) return;
  try {
    const { data } = await sb.from('cohorts').select('brand').eq('id', cid).maybeSingle();
    const b = (data && data.brand) || {};
    A.brand = { ministry: b.ministry || '', department: b.department || '', organisation: b.organisation || '' };
    if (A.brandTouched) return;                          // don't clobber anything typed while loading
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    set('asmtBrandMinistry', A.brand.ministry);
    set('asmtBrandDept',     A.brand.department);
    set('asmtBrandOrg',      A.brand.organisation);
  } catch (e){ /* leave the fields blank on failure */ }
}

function asmtConfirmDeploy(){
  const A = state.asmt;
  const status = A.deployStatus || 'live';
  showModal({
    title: 'Deploy this assessment?',
    body: `This inserts <b>${A.name} (${A.questions.length} questions)</b> and makes it
           <b>${status==='live'?'live now':'scheduled'}</b> for the selected cohort. This cannot be undone.`,
    confirm: 'Deploy now',
    onConfirm: () => { closeModal(); asmtDoDeploy(); }
  });
}

async function asmtDoDeploy(){
  const A = state.asmt;
  const cohortId = currentCohortId();
  if (!cohortId){ toast('No cohort selected','err'); return; }
  mountOctopus(document.querySelector('.main'), 'Deploying your assessment…');

  const payload = A.questions.map(q => ({
    ordinal: q.ordinal, type: q.type, prompt: q.prompt,
    level: q.level, competency: q.competency, marks: q.marks,
    image_path: q.image_path || null,
    options: q.options
  }));

  try {
    const { data: imp, error: impErr } = await sb.rpc('import_assessment', {
      p_cohort_id: cohortId,
      p_name: A.name,
      p_kind: A.kind,
      p_stage: A.stage,
      p_questions: payload,
      p_file_path: A.fileName || 'inline',   // raw-file upload is a later/optional phase
      p_column_map: A.map || null,
      p_row_count: A.rowCount || payload.length
    });
    if (impErr) throw impErr;
    const assessmentId = imp.assessment_id;

    const status = A.deployStatus || 'live';
    const tl = parseInt(A.timeLimit, 10);
    const { error: depErr } = await sb.rpc('deploy_assessment', {
      p_assessment_id: assessmentId,
      p_opens_at: A.opensAt ? new Date(A.opensAt).toISOString() : null,
      p_closes_at: A.closesAt ? new Date(A.closesAt).toISOString() : null,
      p_status: status,
      p_time_limit_minutes: Number.isFinite(tl) && tl > 0 ? tl : null,
      p_proctored: asmtAnyProctor(A),
      p_instructions: (A.instructions && A.instructions.trim()) ? A.instructions : null,
      p_proctoring: asmtProctoringObj(A)
    });
    if (depErr){
      toast('Imported as draft, but deploy failed: ' + depErr.message, 'err');
      _asmtListCache = { cid:null, list:null };
      state.asmt = { kind:'technical', stage:'eoca', name:'', step:0, creating:false };
      go('assessments'); return;
    }

    toast(`${A.name} deployed (${imp.question_count} questions)`, 'ok');

    // #2 persist objectives now that we have the assessment id (technical only)
    if (A.kind === 'technical'){
      const objs = asmtCollectObjectives();
      if (objs.length){
        try {
          const { error: oErr } = await sb.rpc('set_objectives', { p_assessment_id: assessmentId, p_rows: objs });
          if (oErr) throw oErr;
        } catch(e){ toast('Deployed, but saving objectives failed: ' + (e.message || e), 'err'); }
      }
    }
    // persist the cohort banner (Ministry / Department / Organisation) entered here
    if (A.brand && (A.brand.ministry || A.brand.department || A.brand.organisation)){
      try {
        const { data: cur } = await sb.from('cohorts').select('brand').eq('id', cohortId).maybeSingle();
        const merged = Object.assign({}, (cur && cur.brand) || {}, {
          ministry:     (A.brand.ministry || '').trim(),
          department:   (A.brand.department || '').trim(),
          organisation: (A.brand.organisation || '').trim()
        });
        Object.keys(merged).forEach(k => { if (!merged[k]) delete merged[k]; });
        await sb.from('cohorts').update({ brand: merged }).eq('id', cohortId);
        if (typeof window.renderOrgBanner === 'function') window.renderOrgBanner();
      } catch (e){ /* non-fatal: the assessment is already deployed */ }
    }
    _asmtListCache = { cid:null, list:null };
    state.asmt = { kind:'technical', stage:'eoca', name:'', step:0, creating:false };
    go('assessments');
  } catch (e){
    toast('Deploy failed: ' + (e.message || e), 'err');
    state.asmt.step = 3; renderAdmin();
  }
}

/* ---------- CSV templates ---------- */
function asmtDownloadTemplate(kind){
  let csv;
  if (kind === 'technical'){
    csv = 'qno,competency,level,qtype,marks,ques,opt1,opt2,opt3,opt4,opt5,isopt1correct,isopt2correct,isopt3correct,isopt4correct,isopt5correct\n'
      + '1,Statistics,Foundational,mcqsca,1,"Which measure is most robust to outliers?",Mean,Median,Mode,Range,,FALSE,TRUE,FALSE,FALSE,\n'
      + '2,Statistical reasoning,Foundational,tf,1,"Correlation implies causation.",True,False,,,,FALSE,TRUE,,,\n'
      + '3,Statistics,Intermediate,mcqmca,2,"Select all measures of spread.",Variance,Std deviation,Median,Range,,TRUE,TRUE,FALSE,TRUE,\n';
  } else {
    // WPCA v3: qtype column, one 'gate' row (Yes/Partially/No) per competency
    // followed by its rating rows. Prompts are BARE verb phrases — the review
    // player prepends "…did you / did {name} …" at rating time.
    csv = 'qno,competency,qtype,ques,opt1,opt2,opt3,opt4,opt5\n'
      + '1,Data-led Decision Making,gate,"apply this competency at work",Yes,Partially,No,,\n'
      + '2,Data-led Decision Making,likert,"use data or evidence rather than assumption or precedent alone to support a recommendation","Seen but inconsistent","Consistent, independent","Consistent + guides others",,\n'
      + '3,Data-led Decision Making,likert,"use tools like Excel, Power BI, or AI-supported platforms to find trends in data","Seen but inconsistent","Consistent, independent","Consistent + guides others",,\n'
      + '4,Data-led Decision Making,likert,"support the team in using data to track or improve implementation","Seen but inconsistent","Consistent, independent","Consistent + guides others",,\n';
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cegis_${kind}_template.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

/* keep the prototype's old global name harmless if anything still calls it */
function parseCSV(){ /* superseded by asmtPick() */ }
