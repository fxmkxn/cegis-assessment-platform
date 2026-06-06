// db.js — Phase 5: live Supabase data for the admin (cohorts + roster).
// Bridges DB rows into the prototype's ROSTER shape so the existing
// dashboard / roster / WPCA screens render real data unchanged.

let DB_COHORTS = [];

// ---------- data access (RLS-gated reads/writes; import via RPC) ----------
async function dbCohorts() {
  const { data, error } = await sb.from('cohorts')
    .select('id,name,starts_on,ends_on').order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function dbCreateCohort(name) {
  const { data, error } = await sb.from('cohorts')
    .insert({ org_id: AUTH.orgId, name }).select().single();
  if (error) throw error;
  return data;
}

async function dbParticipants(cohortId) {
  const { data, error } = await sb.from('participants')
    .select('id,name,email,designation,workstream,location,manager_participant_id,extra')
    .eq('cohort_id', cohortId).is('deleted_at', null).order('name');
  if (error) throw error;
  return data || [];
}

async function dbImportRoster(cohortId, rows, columnMap, filePath) {
  const { data, error } = await sb.rpc('import_roster', {
    p_cohort_id: cohortId, p_rows: rows,
    p_file_path: filePath || '(in-browser)', p_column_map: columnMap || {}
  });
  if (error) throw error;
  return data;
}

// best-effort: upload the original file if the optional bucket exists
async function dbUploadRaw(file, cohortId) {
  try {
    const path = `${AUTH.orgId}/${cohortId}/${Date.now()}_${file.name}`;
    const { error } = await sb.storage.from('roster-uploads').upload(path, file, { upsert: false });
    if (error) { console.warn('[CEGIS] raw upload skipped:', error.message); return null; }
    return path;
  } catch (e) { console.warn('[CEGIS] raw upload error:', e); return null; }
}

// ---------- DB -> prototype ROSTER shape ----------
async function loadRosterFromDb(cohortId) {
  const ps = await dbParticipants(cohortId);
  const byId = {}; ps.forEach(p => { byId[p.id] = p; });
  ROSTER = ps.map(p => ({
    id: p.email || p.id,
    n: p.name,
    des: p.designation || '',
    ws: p.workstream || '',
    loc: p.location || '',
    mgr: (p.manager_participant_id && byId[p.manager_participant_id])
      ? (byId[p.manager_participant_id].email || byId[p.manager_participant_id].id) : null,
    _pid: p.id,
    _mgrPid: p.manager_participant_id || null
  }));
  DATA_SOURCE = 'supabase';
  recomputeDerived();
}

// ---------- browser-side parse (SheetJS) ----------
async function parseRosterWorkbook(file) {
  await ensureXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let hr = 0;
  for (let i = 0; i < Math.min(aoa.length, 8); i++) {
    const cells = aoa[i].map(c => String(c).toLowerCase());
    if (cells.some(c => c.includes('name') || c.includes('email'))) { hr = i; break; }
  }
  const headers = (aoa[hr] || []).map(c => String(c).trim());
  const objRows = aoa.slice(hr + 1)
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => { const o = {}; headers.forEach((h, i) => o[h] = r[i]); return o; });
  return mapRosterRows(objRows);
}

// fuzzy column mapping + lossless overflow into `extra`
function mapRosterRows(objRows) {
  if (!objRows.length) return { rows: [], columnMap: {}, warnings: ['No rows found in the file.'] };
  const keys = Object.keys(objRows[0]);
  const findKey = (...pats) => keys.find(k => { const l = String(k).toLowerCase(); return pats.some(p => l.includes(p)); });
  const kName = keys.find(k => { const l = String(k).toLowerCase(); return l.includes('name') && !l.includes('manager') && !l.includes('report') && !l.includes('supervis'); }) || findKey('employee', 'member', 'full name');
  const kId = findKey('email', 'e-mail', 'mail') || findKey('emp id', 'employee id') || findKey('id');
  const kDes = findKey('designation', 'role', 'title', 'position', 'grade', 'level');
  const kWs = findKey('workstream', 'work stream', 'vertical', 'stream', 'function', 'department', 'dept', 'team', 'practice');
  const kLoc = findKey('location', 'office', 'city', 'base', 'region', 'site');
  const kMgr = keys.find(k => { const l = String(k).toLowerCase(); return l.includes('manager') || l.includes('reports to') || l.includes('reporting') || l.includes('supervis'); });
  const mapped = new Set([kName, kId, kDes, kWs, kLoc, kMgr].filter(Boolean));
  const val = (r, k) => k ? String(r[k] == null ? '' : r[k]).trim() : '';

  const rows = objRows.filter(r => val(r, kName) || val(r, kId)).map(r => {
    const extra = {};
    keys.forEach(k => { if (!mapped.has(k)) { const v = val(r, k); if (v) extra[k] = v; } });
    return {
      name: val(r, kName) || '(unnamed)',
      email: val(r, kId).toLowerCase(),
      designation: val(r, kDes),
      workstream: val(r, kWs),
      location: val(r, kLoc),
      manager: val(r, kMgr),
      extra
    };
  });
  const columnMap = { name: kName || null, email: kId || null, designation: kDes || null, workstream: kWs || null, location: kLoc || null, manager: kMgr || null };
  const warnings = [];
  if (!kId) warnings.push('No email column detected — rows without an email cannot be imported.');
  if (!kName) warnings.push('No name column detected.');
  return { rows, columnMap, warnings };
}

// ---------- admin data bootstrap + UI handlers ----------
async function initAdminData() {
  if (AUTH.demo || AUTH.role !== 'admin') return;
  try {
    DB_COHORTS = await dbCohorts();
    populateCohortSelect(DB_COHORTS);
    if (DB_COHORTS.length) {
      if (!state.cohortId || !DB_COHORTS.find(c => c.id === state.cohortId)) state.cohortId = DB_COHORTS[0].id;
      await loadRosterFromDb(state.cohortId);
    } else {
      ROSTER = []; DATA_SOURCE = 'supabase'; recomputeDerived();
    }
  } catch (e) {
    console.warn('[CEGIS] initAdminData failed:', e);
  }
  render();
}

function populateCohortSelect(cohorts) {
  const sel = document.getElementById('cohortSel');
  if (!sel) return;
  if (!cohorts.length) { sel.innerHTML = '<option>No cohorts yet</option>'; return; }
  sel.innerHTML = cohorts.map(c =>
    `<option value="${c.id}" ${c.id === state.cohortId ? 'selected' : ''}>${c.name}</option>`).join('');
  sel.onchange = (e) => onCohortChange(e.target.value);
}

async function onCohortChange(id) {
  state.cohortId = id;
  mountOctopus(document.querySelector('.main'), 'Loading roster…');
  try { await loadRosterFromDb(id); } catch (e) { toast('Could not load roster', 'err'); }
  render();
}

function createCohortPrompt() {
  showModal({
    title: 'New cohort',
    body: `<div class="fib"><input id="cohortName" placeholder="Cohort name (e.g. 2026·A — Personnel Management)"></div>`,
    confirm: 'Create',
    onConfirm: doCreateCohort
  });
}

async function doCreateCohort() {
  const name = (document.getElementById('cohortName') || {}).value || '';
  if (!name.trim()) { toast('Enter a cohort name', 'err'); return; }
  closeModal();
  try {
    const c = await dbCreateCohort(name.trim());
    DB_COHORTS.push(c); state.cohortId = c.id;
    populateCohortSelect(DB_COHORTS);
    ROSTER = []; recomputeDerived();
    toast('Cohort created', 'ok');
    render();
  } catch (e) { toast(e.message || 'Could not create cohort', 'err'); }
}

async function onRosterFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  mountOctopus(document.querySelector('.main'), 'Parsing your roster…');
  try {
    const res = await parseRosterWorkbook(file);
    state.rosterPreview = { rows: res.rows, columnMap: res.columnMap, warnings: res.warnings, fileName: file.name, _file: file };
  } catch (e) {
    toast('Could not read that file', 'err');
    state.rosterPreview = null;
  }
  renderAdmin();
}

function cancelRosterPreview() { state.rosterPreview = null; renderAdmin(); }

async function confirmRosterImport() {
  const p = state.rosterPreview; if (!p) return;
  mountOctopus(document.querySelector('.main'), 'Importing participants…');
  let filePath = null;
  if (p._file) filePath = await dbUploadRaw(p._file, state.cohortId); // best-effort
  try {
    const summary = await dbImportRoster(state.cohortId, p.rows, p.columnMap, filePath || p.fileName);
    state.rosterPreview = null;
    await loadRosterFromDb(state.cohortId);
    const msg = `Imported ${summary.inserted}` +
      (summary.skipped ? ` · ${summary.skipped} skipped` : '') +
      (summary.managers_resolved ? ` · ${summary.managers_resolved} managers linked` : '');
    toast(msg, 'ok');
  } catch (e) {
    toast(e.message || 'Import failed', 'err');
    state.rosterPreview = null;
  }
  renderAdmin();
}
