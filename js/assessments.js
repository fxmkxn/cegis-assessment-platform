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
    // opt1..opt5 hold the scale LABELS — any ordered words, not just Likert agreement
    headers: ['qno','competency','ques','opt1','opt2','opt3','opt4','opt5'],
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
      q.type = 'likert';
      q.marks = null;
      q.level = null;                       // level is a technical-only concept
      if (competency.length === 0) push('competency', 'a competency (the 360 radar axis) is required');
      if (options.length === 1) push('options', 'a rating scale needs at least 2 labels');
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

/* ---------- wizard view (overrides the prototype stub) ---------- */
function vAssessments(){
  const A = state.asmt || (state.asmt = { kind:'technical', stage:'eoca', name:'', step:0, creating:false });
  if (!A.creating) return asmtListView();          // list-first; the wizard is opened via ＋ New assessment
  state.uploadStep = A.step;
  const steps = ['Upload file','Validate & fix','Preview','Deploy'];
  let stepper = '<div class="stepper">';
  steps.forEach((s,i)=>{ stepper += `<div class="step ${A.step===i?'active':A.step>i?'done':''}">
    <span class="n">${A.step>i?'✓':i+1}</span>${s}</div>${i<3?'<span class="arrow">→</span>':''}`; });
  stepper += '</div>';

  let body;
  if (A.step === 0) body = asmtUploadView(A);
  else if (A.step === 1) body = asmtValidateView(A);
  else if (A.step === 2) body = asmtPreviewView(A);
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
      <button class="btn" onclick="asmtNew()">＋ New assessment</button></div>
    <div id="asmtListBody"><div class="card pad"><p class="muted small" style="margin:0">Loading…</p></div></div>`;
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
    <td style="text-align:right"><button class="btn ghost sm" onclick="asmtDelete('${a.id}')">Delete</button></td>
  </tr>`).join('');
  return `<div class="card">
    <div class="pad" style="border-bottom:1px solid var(--g200)"><div class="flex jb ac"><h3>Assessments in this cohort</h3><span class="muted small">${list.length} created</span></div></div>
    <div style="overflow:auto"><table><thead><tr><th>Name</th><th>Type</th><th>Stage</th><th>Status</th><th>Window</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
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
  if (!cid){ el.innerHTML = `<div class="card pad"><p class="muted small" style="margin:0">Select a cohort in the top bar to see its assessments.</p></div>`; return; }
  if (!force && _asmtListCache.cid===cid && _asmtListCache.list){ el.innerHTML = renderAsmtList(_asmtListCache.list); return; }
  el.innerHTML = `<div class="card pad"><p class="muted small" style="margin:0">Loading…</p></div>`;
  try{
    const { data, error } = await sb.from('assessments')
      .select('id,name,kind,stage,status,opens_at,closes_at,created_at')
      .eq('cohort_id', cid).is('deleted_at', null)
      .order('created_at', { ascending:false });
    if (error) throw error;
    _asmtListCache = { cid, list: data||[] };
    el.innerHTML = renderAsmtList(_asmtListCache.list);
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
      <td style="max-width:300px">${q.prompt || '<span class="muted">(blank)</span>'}</td>
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
  const cards = A.questions.slice(0,3).map(q => `<div class="card pad" style="margin-bottom:14px">
    <div class="flex jb"><span class="tag">${(q.type==='mcq'?'mcqsca':q.type==='multi'?'mcqmca':q.type).toUpperCase()}${q.level?' · '+q.level:''}</span><span class="muted small">Q${q.ordinal}</span></div>
    <p style="font-weight:600;margin:10px 0 12px">${q.prompt}</p>${asmtPreviewControls(q)}</div>`).join('');
  const more = A.questions.length > 3
    ? `<div class="muted small" style="text-align:center;margin:6px 0">…${A.questions.length-3} more questions</div>` : '';
  return `<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12"><span class="badge info">i</span>
      <div>This is how participants will see each question. Competency tags drive the LLM report blueprint.</div></div></div>
    ${cards}${more}
    <div class="flex g12" style="margin-top:16px;justify-content:flex-end">
      <button class="btn ghost" onclick="state.asmt.step=1;renderAdmin()">← Back</button>
      <button class="btn" onclick="state.asmt.step=3;renderAdmin()">Continue to deploy →</button></div>`;
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

function asmtDeployView(A){
  if (!A.opensAt){ const d=new Date(); A.opensAt = d.toISOString().slice(0,10); }
  if (!A.closesAt){ const d=new Date(Date.now()+14*864e5); A.closesAt = d.toISOString().slice(0,10); }
  const scored = A.questions.some(q => q.marks != null);
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
    <div class="kv ac"><span class="muted">Auto-submit if the participant leaves the tab</span>
      <input type="checkbox" ${A.proctored!==false?'checked':''} onchange="state.asmt.proctored=this.checked"
             style="width:18px;height:18px"></div>
    <div class="flex g12" style="margin-top:18px">
      <button class="btn ghost" onclick="state.asmt.step=2;renderAdmin()">← Back</button>
      <button class="btn" onclick="asmtConfirmDeploy()">Deploy to cohort</button></div>
    <p class="muted small" style="margin-top:12px">⚠ Deployment is participant-visible and cannot be undone once released.</p></div>`;
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
    level: q.level, competency: q.competency, marks: q.marks, options: q.options
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
      p_proctored: A.proctored !== false
    });
    if (depErr){
      toast('Imported as draft, but deploy failed: ' + depErr.message, 'err');
      _asmtListCache = { cid:null, list:null };
      state.asmt = { kind:'technical', stage:'eoca', name:'', step:0, creating:false };
      go('assessments'); return;
    }

    toast(`${A.name} deployed (${imp.question_count} questions)`, 'ok');
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
    csv = 'qno,competency,ques,opt1,opt2,opt3,opt4,opt5\n'
      + '1,Communication,"Communicates analytical findings clearly to non-technical audiences.",Never,Rarely,Sometimes,Often,Always\n'
      + '2,Collaboration,"Actively supports and unblocks teammates.",Strongly disagree,Disagree,Neutral,Agree,Strongly agree\n'
      + '3,Reliability,"Delivers dependable work under deadlines.",Poor,Fair,Good,Very good,Excellent\n';
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
