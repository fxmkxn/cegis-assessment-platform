/* =====================================================================
 * CEGIS — js/historical.js  (Batch C · #1)
 *
 * ADMIN — import OLDER / pre-platform marks for a cohort.
 *
 * A historical checkpoint is a standalone point-in-time (a technical stage +
 * a label like "Baseline 2024") with NO instrument — just per-competency
 * percentages per participant. Several are allowed per cohort. On the
 * participant's report these merge onto the SAME per-competency axes as the
 * in-app assessments: each competency COLUMN is matched to the cohort's
 * objective codes → titles server-side (import_historical_scores), so a
 * column called "obj 1" (or its title) lines up with the in-app series
 * rather than standing on its own.
 *
 * Sheet shape (first row = headers):
 *   - one column of participant emails (a header containing "email"; else col 1)
 *   - every other column = a competency (its objective code or title)
 *   - each cell   = that participant's % in that competency (0–100)
 *
 * Loaded AFTER assessments.js (which calls histBtn() in its list header) and
 * BEFORE app.js. Renders into .main like the wizard/objectives flows; the
 * Back button repaints the admin screen via renderAdmin().
 *
 * DUAL MODE: in demo (placeholder config) the picker + parse + preview all
 * work so the flow is explorable; only the final write needs a live backend.
 * ===================================================================== */

var HIST = {
  stage: 'baseline',
  label: '',
  date: '',
  fileName: '',
  cols: [],       // competency headers parsed from the sheet
  rows: [],       // [{ email, scores:{ comp: pct } }]
  parseErr: null,
  busy: false
};

function histLive(){ return !!(window.SUPABASE_CONFIGURED && window.sb); }

function histEsc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}

/* Cohort accessor — same defensive lookup the other admin modules use. */
function histCohortId(){
  try { if (typeof window.getCurrentCohortId === 'function'){ var v=window.getCurrentCohortId(); if(v) return v; } } catch(e){}
  if (window.CURRENT_COHORT_ID) return window.CURRENT_COHORT_ID;
  if (typeof state !== 'undefined' && state && state.cohortId) return state.cohortId;
  var sel = document.getElementById('cohortSel');
  if (sel){
    if (sel.dataset && sel.dataset.id) return sel.dataset.id;
    var opt = sel.options && sel.options[sel.selectedIndex];
    if (opt && opt.dataset && opt.dataset.id) return opt.dataset.id;
    if (opt && opt.value && opt.value !== '') return opt.value;
  }
  return null;
}

/* Button injected into the Assessments list header by assessments.js. */
function histBtn(){
  return '<button class="btn ghost" onclick="histOpen()">⤒ Import historical marks</button>';
}

function histOpen(){
  HIST.label=''; HIST.date=''; HIST.fileName='';
  HIST.cols=[]; HIST.rows=[]; HIST.parseErr=null; HIST.busy=false;
  histRender();
}

function histBack(){
  if (typeof renderAdmin === 'function') renderAdmin();
}

function histRender(){
  var main = document.querySelector('.main'); if (!main) return;

  var haveRows = HIST.rows.length > 0;
  var canImport = haveRows && HIST.label.trim() !== '' && !HIST.busy;

  var stageOpts = [['baseline','Baseline'],['eoca','EoCA / mid-line'],['endline','Endline']]
    .map(function(o){ return '<option value="'+o[0]+'"'+(HIST.stage===o[0]?' selected':'')+'>'+o[1]+'</option>'; }).join('');

  var demoNote = histLive() ? '' :
    '<div class="card pad" style="background:var(--warn-l);border-color:var(--warn);margin-bottom:14px">'+
    '<b>Demo mode.</b> <span class="muted small">You can pick a file and preview the parsed marks, '+
    'but importing needs a connected Supabase backend.</span></div>';

  main.innerHTML =
    '<div class="crumb">Manage / Assessments / Historical marks</div>'+
    '<div class="page-head"><h1>Import historical marks</h1>'+
      '<button class="btn ghost" onclick="histBack()">← Back to assessments</button></div>'+
    demoNote+
    '<div class="card pad" style="margin-bottom:14px;max-width:820px">'+
      '<p class="muted small" style="margin:0 0 14px">These are pre-platform scores for a past checkpoint. '+
      'Competency columns are matched to this cohort\u2019s assessment objectives (by code, then title) so they '+
      'line up with the in-app per-competency charts.</p>'+
      '<div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:12px">'+
        '<label class="fld"><span class="muted small">Stage</span>'+
          '<select onchange="HIST.stage=this.value" style="width:100%;padding:8px;border:1px solid var(--g300);border-radius:8px">'+stageOpts+'</select></label>'+
        '<label class="fld"><span class="muted small">Checkpoint label</span>'+
          '<input value="'+histEsc(HIST.label)+'" oninput="HIST.label=this.value;histSyncButtons()" placeholder="e.g. Baseline 2024" '+
          'style="width:100%;padding:8px;border:1px solid var(--g300);border-radius:8px"></label>'+
        '<label class="fld"><span class="muted small">Date (optional)</span>'+
          '<input type="date" value="'+histEsc(HIST.date)+'" oninput="HIST.date=this.value" '+
          'style="width:100%;padding:8px;border:1px solid var(--g300);border-radius:8px"></label>'+
      '</div>'+
      '<div style="margin-top:14px">'+
        '<input type="file" id="histFile" accept=".xlsx,.xls,.csv" onchange="histFile(this)" style="display:none">'+
        '<button class="btn ghost" onclick="document.getElementById(\'histFile\').click()">⤓ Choose sheet…</button>'+
        (HIST.fileName?'<span class="muted small" style="margin-left:10px">'+histEsc(HIST.fileName)+'</span>':'')+
      '</div>'+
      (HIST.parseErr?'<div class="badge err" style="margin-top:12px">⚠ '+histEsc(HIST.parseErr)+'</div>':'')+
    '</div>'+
    (haveRows ? histPreview() : '')+
    '<div class="flex jb ac" style="max-width:820px;margin-top:14px">'+
      '<span class="muted small">'+(haveRows?(HIST.rows.length+' participant row(s) · '+HIST.cols.length+' competenc'+(HIST.cols.length===1?'y':'ies')):'No file loaded yet')+'</span>'+
      '<button class="btn" '+(canImport?'':'disabled')+' onclick="histImport()">'+(HIST.busy?'Importing…':'Import marks')+'</button>'+
    '</div>';
}

function histSyncButtons(){
  // cheap enable/disable without a full repaint while typing the label
  var btns = document.querySelectorAll('.main .btn');
  var b = btns && btns[btns.length-1];
  if (b && b.textContent.indexOf('Import') === 0){
    b.disabled = !(HIST.rows.length>0 && HIST.label.trim()!=='' && !HIST.busy);
  }
}

function histPreview(){
  var cols = HIST.cols.slice(0, 8);
  var more = HIST.cols.length - cols.length;
  var head = '<th style="text-align:left">Email</th>'+
    cols.map(function(c){ return '<th style="text-align:left">'+histEsc(c)+'</th>'; }).join('')+
    (more>0?'<th class="muted small">+'+more+' more</th>':'');
  var body = HIST.rows.slice(0, 12).map(function(r){
    var cells = cols.map(function(c){
      var v = r.scores[c];
      return '<td>'+(v==null?'<span class="muted small">—</span>':histEsc(String(v)))+'</td>';
    }).join('');
    return '<tr><td class="muted small">'+histEsc(r.email)+'</td>'+cells+(more>0?'<td></td>':'')+'</tr>';
  }).join('');
  var extra = HIST.rows.length>12 ? '<div class="muted small" style="padding:8px 2px">…and '+(HIST.rows.length-12)+' more row(s)</div>' : '';
  return '<div class="card" style="max-width:820px;margin-bottom:4px"><div style="overflow:auto"><table>'+
    '<thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div>'+extra+'</div>';
}

function histFile(input){
  var f = input && input.files && input.files[0];
  if (!f) return;
  HIST.fileName = f.name; HIST.parseErr = null;
  var reader = new FileReader();
  reader.onload = function(e){
    try{
      if (typeof XLSX === 'undefined') throw new Error('Spreadsheet library not loaded');
      var wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var aoa = XLSX.utils.sheet_to_json(ws, { header:1, blankrows:false, defval:null });
      histParse(aoa);
    }catch(err){
      HIST.cols=[]; HIST.rows=[]; HIST.parseErr=(err&&err.message)||'Could not read that file';
    }
    histRender();
  };
  reader.onerror = function(){ HIST.parseErr='Could not read that file'; histRender(); };
  reader.readAsArrayBuffer(f);
}

function histParse(aoa){
  if (!aoa || !aoa.length) throw new Error('The sheet is empty');
  var headers = (aoa[0]||[]).map(function(h){ return String(h==null?'':h).trim(); });
  var emailCol = headers.findIndex(function(h){ return /e-?mail/i.test(h); });
  if (emailCol < 0) emailCol = 0;
  var compCols = [];
  headers.forEach(function(h, idx){ if (idx!==emailCol && h!=='') compCols.push({ h:h, idx:idx }); });
  if (!compCols.length) throw new Error('No competency columns found next to the email column');

  var rows = [];
  for (var r=1; r<aoa.length; r++){
    var row = aoa[r]; if (!row) continue;
    var email = String(row[emailCol]==null?'':row[emailCol]).trim();
    if (!email) continue;
    var scores = {};
    compCols.forEach(function(o){
      var v = row[o.idx];
      if (v===null || v===undefined || String(v).trim()==='') return;
      var num = Number(String(v).replace('%','').trim());
      if (!isFinite(num)) return;
      if (num < 0) num = 0; if (num > 100) num = 100;
      scores[o.h] = num;
    });
    rows.push({ email:email, scores:scores });
  }
  if (!rows.length) throw new Error('No participant rows with an email were found');
  HIST.cols = compCols.map(function(o){ return o.h; });
  HIST.rows = rows;
  HIST.parseErr = null;
}

function histImport(){
  if (!(HIST.rows.length && HIST.label.trim())) return;
  if (!histLive()){ if (typeof toast==='function') toast('Connect a Supabase backend to import','err'); return; }
  var cohortId = histCohortId();
  if (!cohortId){ if (typeof toast==='function') toast('Select a cohort first','err'); return; }

  HIST.busy = true; histRender();
  sb.rpc('import_historical_scores', {
    p_cohort_id: cohortId,
    p_stage: HIST.stage,
    p_label: HIST.label.trim(),
    p_occurred_on: HIST.date || null,
    p_rows: HIST.rows
  }).then(function(res){
    HIST.busy = false;
    if (res.error){ if (typeof toast==='function') toast(res.error.message||'Import failed','err'); histRender(); return; }
    var d = res.data || {};
    if (typeof toast==='function')
      toast((d.participants||0)+' participant(s), '+(d.scores||0)+' score(s) imported'+(d.skipped?(' · '+d.skipped+' skipped'):''),'ok');
    histResult(d);
  }).catch(function(err){
    HIST.busy = false;
    if (typeof toast==='function') toast((err&&err.message)||'Import failed','err');
    histRender();
  });
}

function histResult(d){
  var main = document.querySelector('.main'); if (!main) return;
  main.innerHTML =
    '<div class="crumb">Manage / Assessments / Historical marks</div>'+
    '<div class="page-head"><h1>Historical marks imported</h1>'+
      '<button class="btn ghost" onclick="histBack()">← Back to assessments</button></div>'+
    '<div class="card pad" style="max-width:620px">'+
      '<div style="font-size:40px">✓</div>'+
      '<h3 style="margin:8px 0">'+histEsc(HIST.label)+' \u00b7 '+histEsc(HIST.stage)+'</h3>'+
      '<div class="grid" style="grid-template-columns:repeat(3,1fr);margin:14px 0">'+
        '<div class="card pad"><div class="tnum" style="font-size:24px;font-weight:700">'+(d.participants||0)+'</div><div class="muted small">Participants</div></div>'+
        '<div class="card pad"><div class="tnum" style="font-size:24px;font-weight:700">'+(d.scores||0)+'</div><div class="muted small">Scores</div></div>'+
        '<div class="card pad"><div class="tnum" style="font-size:24px;font-weight:700">'+(d.skipped||0)+'</div><div class="muted small">Skipped</div></div>'+
      '</div>'+
      '<p class="muted small" style="margin:0">Skipped rows are emails not found in this cohort. These marks now appear on each '+
      'participant\u2019s report alongside their in-app checkpoints. Re-importing the same label replaces its scores.</p>'+
      '<div style="margin-top:16px"><button class="btn ghost" onclick="histOpen()">Import another checkpoint</button></div>'+
    '</div>';
}
