// auth.js — Phase 4: real Supabase Auth gating + JWT claim verification.
//
// Two modes:
//   * DEMO mode — when config.js still has placeholder Supabase values.
//     Keeps the prototype's Admin/Participant toggle and sample data so
//     the deployed site still demonstrates without a backend.
//   * AUTHENTICATED mode — when a real Supabase URL + anon key are set.
//     Requires login; the user's role/org come from the JWT (stamped by
//     the custom_access_token_hook), never from a manual toggle.

let AUTH = { demo: false, session: null, user: null, orgId: null, role: null };
// also expose on window so code in other modules can reference it either way
window.AUTH = AUTH;

// Decode a JWT payload (base64url) so we read EXACTLY the claims the
// access-token hook produced, rather than trusting a cached user object.
function _decodeJwt(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = part + '==='.slice((part.length + 3) % 4);
    const bin = atob(pad);
    const json = decodeURIComponent(
      Array.prototype.map.call(bin, c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(json);
  } catch (e) { return {}; }
}

function _applySession(session) {
  AUTH.session = session || null;
  AUTH.user = session ? session.user : null;
  AUTH.orgId = null;
  AUTH.role = null;
  if (session && session.access_token) {
    const claims = _decodeJwt(session.access_token);
    const meta = (claims && claims.app_metadata) || (session.user && session.user.app_metadata) || {};
    AUTH.orgId = meta.org_id || null;
    AUTH.role = meta.role || null;
  }
}

async function initAuth() {
  if (!window.SUPABASE_CONFIGURED) { AUTH.demo = true; return null; }
  const { data: { session } } = await sb.auth.getSession();
  _applySession(session);
  // re-route whenever auth state changes (login, logout, token refresh)
  sb.auth.onAuthStateChange((_event, s) => { _applySession(s); routeAuth(); });
  return session;
}

// Decide what to show based on auth state. Called on boot and on changes.
function routeAuth() {
  const rs = document.getElementById('roleSwitch');
  const ac = document.getElementById('authChrome');
  const av = document.getElementById('userAv');

  if (AUTH.demo) {
    if (rs) rs.style.display = '';
    if (ac) ac.style.display = 'none';
    if (av) av.style.display = 'none';
    render();
    return;
  }
  if (!AUTH.session) { renderLogin(); return; }
  if (!AUTH.role || !AUTH.orgId) { renderClaimsError(); return; }

  // authenticated: role is fixed by the account; hide the demo toggle
  state.role = AUTH.role;
  if (rs) rs.style.display = 'none';
  if (av) av.style.display = 'none';
  if (ac) {
    ac.style.display = '';
    const who = _authDisplayName();
    ac.innerHTML =
      `<span class="small muted" style="font-weight:600">${AUTH.role === 'admin' ? 'Admin' : 'Participant'}</span>
       <button class="btn ghost sm authName" onclick="openAccount()" title="Account settings">${who}</button>
       <button class="btn ghost sm" onclick="doLogout()">Sign out</button>`;
  }
  render();
  // load live cohorts + roster from Supabase (replaces sample data), then re-render
  if (AUTH.role === 'admin' && typeof initAdminData === 'function') initAdminData();
}

// Best available human label for the signed-in account: a real name if the
// account has one (user_metadata), otherwise the email. HTML-escaped.
function _authDisplayName() {
  const u = AUTH.user || {};
  const m = u.user_metadata || {};
  const raw = m.full_name || m.name || u.email || 'Account';
  return String(raw).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function _hideAppChrome() {
  document.getElementById('contextBar').style.display = 'none';
  const ob = document.getElementById('orgBanner'); if (ob) { ob.style.display = 'none'; ob.innerHTML = ''; }
  const rs = document.getElementById('roleSwitch'); if (rs) rs.style.display = 'none';
  const ac = document.getElementById('authChrome'); if (ac) ac.style.display = 'none';
  const av = document.getElementById('userAv'); if (av) av.style.display = 'none';
}

function renderLogin(message) {
  _hideAppChrome();
  layout.innerHTML = `<div class="main"><div class="card pad" style="max-width:380px;margin:8vh auto">
    <h2 style="margin-bottom:4px">Sign in</h2>
    <p class="muted small" style="margin-bottom:16px">Use the credentials provided by your program admin.</p>
    <div class="fib"><input id="loginEmail" type="email" placeholder="Email" autocomplete="username"></div>
    <div class="fib" style="margin-top:10px"><input id="loginPass" type="password" placeholder="Password" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()"></div>
    <div id="loginErr" class="badge err" style="${message ? '' : 'display:none'};margin-top:12px">${message || ''}</div>
    <button class="btn" style="width:100%;margin-top:16px" id="loginBtn" onclick="doLogin()">Sign in</button>
  </div></div>`;
}

function _loginError(msg) {
  const e = document.getElementById('loginErr');
  if (e) { e.style.display = 'inline-flex'; e.textContent = msg; }
  const b = document.getElementById('loginBtn');
  if (b) { b.disabled = false; b.textContent = 'Sign in'; }
}

async function doLogin() {
  const email = (document.getElementById('loginEmail').value || '').trim();
  const pass = document.getElementById('loginPass').value || '';
  if (!email || !pass) { _loginError('Enter your email and password.'); return; }
  const b = document.getElementById('loginBtn');
  if (b) { b.disabled = true; b.textContent = 'Signing in…'; }
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { _loginError(error.message || 'Sign-in failed.'); return; }
  // onAuthStateChange will route; refresh claims explicitly to be safe
  const { data: { session } } = await sb.auth.getSession();
  _applySession(session);
  routeAuth();
}

async function doLogout() {
  try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
  AUTH.session = null; AUTH.user = null; AUTH.orgId = null; AUTH.role = null;
  renderLogin();
}

function renderClaimsError() {
  _hideAppChrome();
  const ac = document.getElementById('authChrome');
  if (ac) { ac.style.display = ''; ac.innerHTML = `<button class="btn ghost sm" onclick="doLogout()">Sign out</button>`; }
  layout.innerHTML = `<div class="main"><div class="card pad" style="max-width:560px;margin:8vh auto">
    <div class="badge warn" style="margin-bottom:8px">⚠ Account not fully set up</div>
    <h2 style="margin-bottom:6px">Signed in, but no org/role in your token</h2>
    <p class="muted">Your access token has no <b>org_id</b>/<b>role</b> claim. Usually one of:</p>
    <ul class="muted small" style="margin:8px 0 8px 18px">
      <li>the <b>Customize Access Token</b> hook isn't enabled (Authentication → Hooks), or</li>
      <li>there's no <code>profiles</code> row linking your user to an organization.</li>
    </ul>
    <p class="muted small">Fix that, then <b>sign out and back in</b> — claims are stamped at login.</p>
    <button class="btn" style="margin-top:8px" onclick="doLogout()">Sign out</button>
  </div></div>`;
}

// optional self-serve password change (no forced reset on first login)
function openAccount() {
  showModal({
    title: 'Change password',
    body: `<p class="muted small" style="margin-bottom:10px">Set a new password for ${AUTH.user ? AUTH.user.email : 'your account'}.</p>
      <div class="fib"><input id="newPass" type="password" placeholder="New password (min 6 characters)"></div>`,
    confirm: 'Update password',
    onConfirm: doChangePassword
  });
}

async function doChangePassword() {
  const v = (document.getElementById('newPass') || {}).value || '';
  if (v.length < 6) { toast('Password must be at least 6 characters', 'err'); return; }
  const { error } = await sb.auth.updateUser({ password: v });
  closeModal();
  if (error) toast(error.message || 'Could not update password', 'err');
  else toast('Password updated', 'ok');
}

// =====================================================================
// Org / cohort branding banner (Ministry · Department · Organisation)
// Rendered under the header for BOTH roles. Reads the current cohort's
// brand (admin: the selected cohort; participant: their enrolment),
// merged over the organisation brand, falling back to organizations.name.
// Set from the assessment wizard (assessments.js) → cohorts.brand.
// =====================================================================
function _brandLines(b){
  if (!b) return [];
  return [b.ministry, b.department, b.organisation, b.label, b.sublabel]
    .map(x => (x == null ? '' : String(x).trim())).filter(Boolean);
}
function _bannerLogoUrl(path){
  if (!path) return null;
  const base = (window.CONFIG && window.CONFIG.SUPABASE_URL) || '';
  return base.replace(/\/+$/, '') + '/storage/v1/object/public/org-branding/' + path;
}
function _bannerEsc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

async function _bannerResolveCohortId(){
  if (AUTH.role === 'admin'){
    const sel = document.getElementById('cohortSel');
    if (sel && sel.value) return sel.value;
    if (window.state && state.cohortId) return state.cohortId;
    return null;
  }
  // participant: resolve their most-recent enrolment's cohort
  try {
    let uid = (AUTH.user && AUTH.user.id) || null;
    if (!uid){ const g = await sb.auth.getUser(); uid = g.data && g.data.user ? g.data.user.id : null; }
    if (!uid) return null;
    const { data } = await sb.from('participants').select('cohort_id,created_at')
      .eq('user_id', uid).is('deleted_at', null)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data ? data.cohort_id : null;
  } catch(e){ return null; }
}

async function renderOrgBanner(){
  const host = document.getElementById('orgBanner');
  if (!host) return;
  if (AUTH.demo || !window.SUPABASE_CONFIGURED || !window.sb || !AUTH.orgId){
    host.style.display = 'none'; host.innerHTML = ''; return;
  }
  // one-time: refresh the banner when the admin switches cohort in the context bar
  if (!AUTH._bannerHook){
    const sel = document.getElementById('cohortSel');
    if (sel){ sel.addEventListener('change', () => renderOrgBanner()); AUTH._bannerHook = true; }
  }
  try {
    const { data: org } = await sb.from('organizations').select('name,brand').eq('id', AUTH.orgId).maybeSingle();
    let brand = (org && org.brand) || {};
    const cid = await _bannerResolveCohortId();
    if (cid){
      const { data: coh } = await sb.from('cohorts').select('brand').eq('id', cid).maybeSingle();
      if (coh && coh.brand) brand = Object.assign({}, brand, coh.brand);
    }
    let lines = _brandLines(brand);
    if (!lines.length && org && org.name) lines = [org.name];   // fall back to organisation name
    const logo = _bannerLogoUrl(brand.logo_path);
    if (!lines.length && !logo){ host.style.display = 'none'; host.innerHTML = ''; return; }
    const txt = lines.map((l, i) => `<div class="ob-${Math.min(i + 1, 3)}">${_bannerEsc(l)}</div>`).join('');
    host.innerHTML = (logo ? `<img src="${logo}" alt="" onerror="this.style.display='none'">` : '') + `<div class="ob-text">${txt}</div>`;
    host.style.display = '';
  } catch(e){ host.style.display = 'none'; }
}
window.renderOrgBanner = renderOrgBanner;
