/* =====================================================================
 * branding.js — Batch B (#8): organisation / cohort branding settings.
 *
 * Overrides the prototype Settings screen (vSettings, defined in admin.js)
 * to let an admin set the org's ministry/department name + logo ONCE, with
 * an optional per-cohort override. This branding is inherited by every
 * assessment: shown to participants while they take an assessment (player.js)
 * and in the header of every report (reports.js / generate-report).
 *
 * Pure RLS writes — admins already have UPDATE on organizations/cohorts, and
 * the logo lives in the public, admin-write 'org-branding' bucket created by
 * the Batch B migration. No new RPCs.
 *
 * Same module contract as dashboard.js / reports.js:
 *   - captures the prototype stub (SETTINGS_PROTO.vSettings) for DEMO mode
 *   - reassigns the global vSettings; edits nothing else
 *   - load order: AFTER admin.js (defines the stub), BEFORE app.js:
 *       <script src="js/branding.js"></script>
 *
 * Globals from earlier phases: sb, SUPABASE_CONFIGURED, AUTH, state,
 * showModal/closeModal, toast, renderAdmin.
 * ===================================================================== */

var SETTINGS_PROTO = { vSettings: window.vSettings };

var BRAND = { org: null, cohorts: [], sel: '' };

function brandingLive(){ return !!(window.SUPABASE_CONFIGURED && window.sb && window.AUTH && AUTH.orgId && !AUTH.demo); }
function _brEsc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function _brVal(id){ const el = document.getElementById(id); return el ? (el.value || '').trim() : ''; }
function brandLogoUrl(path){
  if (!path) return null;
  const base = (window.CONFIG && window.CONFIG.SUPABASE_URL) || '';
  return base.replace(/\/+$/, '') + '/storage/v1/object/public/org-branding/' + path;
}
// drop empty keys; return null when nothing is set (so the column reads NULL)
function brandClean(b){
  const out = {};
  if (b.label) out.label = b.label;
  if (b.sublabel) out.sublabel = b.sublabel;
  if (b.logo_path) out.logo_path = b.logo_path;
  return Object.keys(out).length ? out : null;
}

/* ---------------- screen ---------------- */
function vSettings(){
  if (!brandingLive()) return SETTINGS_PROTO.vSettings ? SETTINGS_PROTO.vSettings() : '';
  setTimeout(brandingHydrate, 0);
  return `<div class="page-head"><h1>Settings</h1></div>
    <div id="brandingRoot"><div class="card pad"><p class="muted small" style="margin:0">Loading branding…</p></div></div>`;
}

async function brandingHydrate(){
  const host = document.getElementById('brandingRoot'); if (!host) return;
  try {
    const [{ data: org }, { data: cohorts }] = await Promise.all([
      sb.from('organizations').select('id,name,brand').eq('id', AUTH.orgId).maybeSingle(),
      sb.from('cohorts').select('id,name,brand').is('deleted_at', null).order('created_at', { ascending: true })
    ]);
    BRAND.org = org || { brand: null };
    BRAND.org.brand = BRAND.org.brand || {};
    BRAND.cohorts = cohorts || [];
    BRAND.cohorts.forEach(c => { c.brand = c.brand || {}; });
    host.innerHTML = brandingBody();
  } catch(e){
    host.innerHTML = `<div class="card pad"><span class="badge err">Couldn't load branding: ${_brEsc(e.message || e)}</span></div>`;
  }
}
function brandingRerender(){ const host = document.getElementById('brandingRoot'); if (host) host.innerHTML = brandingBody(); }

function brandingBody(){
  const ob = BRAND.org.brand || {};
  return `
  <div class="card pad" style="margin-bottom:16px;max-width:640px">
    <h3 style="margin-bottom:4px">Organisation branding</h3>
    <p class="muted small" style="margin:0 0 14px">Shown to participants while they take assessments and in the header of every report. Set once here; a cohort can override it below.</p>
    ${brandForm('org', '', ob)}
    <div class="flex g12" style="margin-top:14px"><button class="btn" onclick="brandingSaveOrg()">Save organisation branding</button></div>
  </div>
  <div class="card pad" style="margin-bottom:16px;max-width:640px">
    <h3 style="margin-bottom:4px">Per-cohort override (optional)</h3>
    <p class="muted small" style="margin:0 0 12px">Choose a cohort to give it its own branding. Anything left blank inherits the organisation branding above.</p>
    <select class="cohort-sel" style="width:100%;margin-bottom:12px" onchange="brandingSelectCohort(this.value)">
      <option value="">— choose a cohort —</option>
      ${BRAND.cohorts.map(c => `<option value="${c.id}" ${BRAND.sel === c.id ? 'selected' : ''}>${_brEsc(c.name)}</option>`).join('')}
    </select>
    <div id="cohortBrandForm">${BRAND.sel ? brandCohortForm() : ''}</div>
  </div>
  ${brandingStubCards()}`;
}

// scope: 'org' | 'cohort'; pfx: '' for org, 'c' for cohort (distinct input ids)
function brandForm(scope, pfx, b){
  b = b || {};
  const logo = b.logo_path ? brandLogoUrl(b.logo_path) : null;
  const preview = logo
    ? `<img id="${pfx}brand_logo_img" src="${logo}" alt="" style="height:44px;width:auto;border:1px solid var(--g200);border-radius:8px;padding:4px;background:#fff">`
    : `<span id="${pfx}brand_logo_img" class="muted small">no logo</span>`;
  return `
    <div class="muted small" style="font-weight:600;margin-bottom:4px">Name / label (e.g. Ministry of …)</div>
    <input id="${pfx}brand_label" value="${_brEsc(b.label || '')}"
      style="width:100%;padding:10px 12px;border:1.5px solid var(--g300);border-radius:9px;font:inherit;margin-bottom:10px">
    <div class="muted small" style="font-weight:600;margin-bottom:4px">Sub-label (e.g. Department of …)</div>
    <input id="${pfx}brand_sub" value="${_brEsc(b.sublabel || '')}"
      style="width:100%;padding:10px 12px;border:1.5px solid var(--g300);border-radius:9px;font:inherit;margin-bottom:10px">
    <div class="muted small" style="font-weight:600;margin-bottom:4px">Logo</div>
    <div class="flex ac g12 wrap">
      ${preview}
      <input type="file" id="${pfx}brand_logo_file" accept="image/*" style="display:none" onchange="brandingUploadLogo('${scope}', this.files[0])">
      <button class="btn ghost sm" onclick="document.getElementById('${pfx}brand_logo_file').click()">Upload logo</button>
      ${b.logo_path ? `<button class="btn ghost sm" onclick="brandingClearLogo('${scope}')">Remove logo</button>` : ''}
    </div>`;
}
function brandCohortForm(){
  const c = BRAND.cohorts.find(x => x.id === BRAND.sel);
  const b = (c && c.brand) || {};
  return brandForm('cohort', 'c', b)
    + `<div class="flex g12" style="margin-top:14px">
         <button class="btn" onclick="brandingSaveCohort()">Save cohort override</button>
         <button class="btn ghost" onclick="brandingResetCohort()">Reset to inherit</button></div>`;
}
function brandingStubCards(){
  return `<div class="grid" style="grid-template-columns:1fr 1fr;max-width:640px">
    ${['Users & admin roles','Competency framework / blueprints','Integrations · LLM API key','Audit log']
      .map(s => `<div class="card pad"><h3 style="font-size:14px">${s}</h3><p class="muted small" style="margin:6px 0 0">Configure ${s.toLowerCase()}.</p></div>`).join('')}</div>`;
}

/* ---------------- interactions ---------------- */
function brandingSelectCohort(id){
  BRAND.sel = id;
  const el = document.getElementById('cohortBrandForm');
  if (el) el.innerHTML = id ? brandCohortForm() : '';
}

// pull the currently-typed label/sublabel into the working copy so a logo
// upload (which re-renders) doesn't discard unsaved text.
function brandingCaptureInputs(scope){
  if (scope === 'cohort'){
    const c = BRAND.cohorts.find(x => x.id === BRAND.sel); if (!c) return;
    c.brand = c.brand || {};
    if (document.getElementById('cbrand_label')) c.brand.label = _brVal('cbrand_label');
    if (document.getElementById('cbrand_sub'))   c.brand.sublabel = _brVal('cbrand_sub');
  } else {
    BRAND.org.brand = BRAND.org.brand || {};
    if (document.getElementById('brand_label')) BRAND.org.brand.label = _brVal('brand_label');
    if (document.getElementById('brand_sub'))   BRAND.org.brand.sublabel = _brVal('brand_sub');
  }
}

async function brandingUploadLogo(scope, file){
  if (!file) return;
  if (!/^image\//.test(file.type)){ toast('Choose an image file', 'err'); return; }
  if (file.size > 5 * 1024 * 1024){ toast('Logo must be under 5 MB', 'err'); return; }
  const ext = ((file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'png';
  const tag = scope === 'cohort' ? ('cohort-' + BRAND.sel) : 'org';
  const path = `${AUTH.orgId}/${tag}-${Date.now()}.${ext}`;
  brandingCaptureInputs(scope);
  toast('Uploading logo…');
  try {
    const { error } = await sb.storage.from('org-branding').upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw error;
    if (scope === 'cohort'){ const c = BRAND.cohorts.find(x => x.id === BRAND.sel); if (c){ c.brand = c.brand || {}; c.brand.logo_path = path; } }
    else { BRAND.org.brand = BRAND.org.brand || {}; BRAND.org.brand.logo_path = path; }
    toast('Logo uploaded — click Save to apply', 'ok');
    brandingRerender();
  } catch(e){ toast('Upload failed: ' + (e.message || e), 'err'); }
}
function brandingClearLogo(scope){
  brandingCaptureInputs(scope);
  if (scope === 'cohort'){ const c = BRAND.cohorts.find(x => x.id === BRAND.sel); if (c && c.brand) c.brand.logo_path = null; }
  else if (BRAND.org.brand) BRAND.org.brand.logo_path = null;
  brandingRerender();
}

async function brandingSaveOrg(){
  const brand = brandClean({
    label: _brVal('brand_label'),
    sublabel: _brVal('brand_sub'),
    logo_path: (BRAND.org.brand && BRAND.org.brand.logo_path) || null
  });
  try {
    const { error } = await sb.from('organizations').update({ brand }).eq('id', AUTH.orgId);
    if (error) throw error;
    BRAND.org.brand = brand || {};
    toast('Organisation branding saved', 'ok');
  } catch(e){ toast('Save failed: ' + (e.message || e), 'err'); }
}
async function brandingSaveCohort(){
  const c = BRAND.cohorts.find(x => x.id === BRAND.sel);
  if (!c){ toast('Choose a cohort first', 'err'); return; }
  const brand = brandClean({
    label: _brVal('cbrand_label'),
    sublabel: _brVal('cbrand_sub'),
    logo_path: (c.brand && c.brand.logo_path) || null
  });
  try {
    const { error } = await sb.from('cohorts').update({ brand }).eq('id', c.id);
    if (error) throw error;
    c.brand = brand || {};
    toast('Cohort branding saved', 'ok');
  } catch(e){ toast('Save failed: ' + (e.message || e), 'err'); }
}
async function brandingResetCohort(){
  const c = BRAND.cohorts.find(x => x.id === BRAND.sel);
  if (!c) return;
  try {
    const { error } = await sb.from('cohorts').update({ brand: null }).eq('id', c.id);
    if (error) throw error;
    c.brand = {};
    toast('Cohort now inherits organisation branding', 'ok');
    const el = document.getElementById('cohortBrandForm'); if (el) el.innerHTML = brandCohortForm();
  } catch(e){ toast('Reset failed: ' + (e.message || e), 'err'); }
}

/* expose the override */
window.vSettings = vSettings;
