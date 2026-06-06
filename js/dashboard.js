/* =====================================================================
 * dashboard.js — Phase 11: Admin dashboard wiring
 * =====================================================================
 * Makes the Program Dashboard real for the selected cohort:
 *   • KPI tiles, the five-stage pipeline, the action queue and recent
 *     activity all come from ONE round-trip: the dashboard_summary(cohort)
 *     RPC (migration 20260111000000). No client-side score math.
 *   • Supabase Realtime — the one genuinely new capability — subscribes to
 *     `attempts` and `wpca_panels` changes and silently re-pulls the summary
 *     so completion numbers tick up live as participants submit.
 *
 * Same module contract as wpca.js / reports.js:
 *   - captures the prototype stub (DASH_PROTO.vDashboard) for DEMO mode
 *   - reassigns the global vDashboard; edits nothing else
 *   - load order: AFTER admin.js (defines the stub), BEFORE app.js:
 *       <script src="js/dashboard.js"></script>
 *
 * Globals from earlier phases: sb, SUPABASE_CONFIGURED, mountOctopus,
 * toast, tile, aq, act, go, render, renderAdmin, state.
 * ===================================================================== */

/* keep the prototype implementation for DEMO mode (no backend) */
var DASH_PROTO = { vDashboard: window.vDashboard };

var DASH = {
  cohortId: null,     // cohort the cached summary belongs to
  summary:  null,     // last dashboard_summary() result
  loading:  false,
  err:      null,
  channel:  null,     // the realtime channel handle
  channelOrg: null,   // cohort the channel was opened for
  refreshTimer: null  // debounce handle for realtime-driven refetch
};

function dashLive(){ return !!(window.SUPABASE_CONFIGURED && window.sb); }
function dEsc(s){ return String(s==null?'':s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* current cohort id — canonical accessor: the #cohortSel option VALUE is
   the cohort uuid (same source credentials.js / assessments.js use). */
function dashCohortId(){
  var sel = document.getElementById('cohortSel');
  if (sel && sel.value) return sel.value;
  if (typeof window.getCurrentCohortId === 'function'){ var v = window.getCurrentCohortId(); if (v) return v; }
  if (window.CURRENT_COHORT_ID) return window.CURRENT_COHORT_ID;
  if (window.state && window.state.cohortId) return window.state.cohortId;
  if (sel && sel.selectedOptions && sel.selectedOptions[0]) return sel.selectedOptions[0].dataset.id || null;
  return null;
}

/* ---------- static lifecycle metadata (names / nav targets) ---------- */
var DASH_STAGE_META = {
  baseline:  { n:1, name:'Baseline',     short:'Baseline',  nav:'assessments' },
  eoca:      { n:2, name:'EoCA',         short:'EoCA',      nav:'assessments' },
  endline:   { n:3, name:'Endline',      short:'Endline',   nav:'assessments' },
  wpca:      { n:4, name:'WPCA · 360',   short:'WPCA',      nav:'wpca' },
  reporting: { n:5, name:'Reporting',    short:'Reporting', nav:'reports' }
};
var DASH_PILL = { live:'Live', sched:'Scheduled', closed:'Closed', idle:'Not started', gen:'In progress' };

/* relative time for recent activity */
function dashAgo(iso){
  var t = Date.parse(iso); if (isNaN(t)) return '';
  var s = Math.round((Date.now() - t) / 1000);
  if (s < 45)    return 'just now';
  if (s < 3600)  return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  if (s < 172800)return 'Yesterday';
  return new Date(t).toLocaleDateString();
}

/* ============================================================
   RENDER
   ============================================================ */
function vDashboard(){
  // DEMO mode → unchanged prototype dashboard
  if (!dashLive()) return DASH_PROTO.vDashboard ? DASH_PROTO.vDashboard() : '';

  var cid = dashCohortId();
  if (!cid){
    dashTeardownRealtime();
    return `<div class="crumb">Program</div>
      <div class="page-head"><h1>Program Dashboard</h1></div>
      <div class="card pad"><p class="muted" style="margin:0">No cohort selected yet — create or pick a cohort from the top bar, then import a roster from <b>Cohorts</b> to populate the dashboard.</p></div>`;
  }

  // cohort changed (or first load) → (re)load + (re)subscribe, show skeleton
  if (DASH.cohortId !== cid){
    DASH.cohortId = cid;
    DASH.summary = null;
    DASH.err = null;
    dashLoad(cid);                 // async; re-renders on resolve
    dashEnsureRealtime(cid);
    return dashShell(dashSkeleton());
  }

  if (DASH.err)     return dashShell(`<div class="card pad"><p class="muted" style="margin:0">Couldn't load the dashboard: ${dEsc(DASH.err)}. <button class="btn ghost sm" onclick="dashReload()">Retry</button></p></div>`);
  if (!DASH.summary) return dashShell(dashSkeleton());

  dashEnsureRealtime(cid);          // keep the subscription alive on re-renders
  return dashShell(dashBody(DASH.summary));
}

/* page head + a container the silent refresh patches in place */
function dashShell(inner){
  return `<div class="crumb">Program · live</div>
    <div class="page-head"><h1>Program Dashboard</h1>
      <button class="btn" onclick="go('reports')">＋ Generate cohort report</button></div>
    <div id="dashRoot">${inner}</div>`;
}

function dashSkeleton(){
  var t = (l)=>`<div class="card pad"><div style="font-size:26px;font-weight:700;color:var(--g300)">—</div><div class="muted small">${l}</div></div>`;
  return `<div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
      ${t('Participants')}${t('Active stage')}${t('Overall completion')}${t('Reports generated')}</div>
    <div class="oct-msg" style="margin:30px auto">Loading live cohort data…</div>`;
}

function dashBody(s){
  var actLabel = (s.active_stage && DASH_STAGE_META[s.active_stage])
    ? DASH_STAGE_META[s.active_stage].short : '—';

  var kpis = `<div class="grid dash-kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
      ${tile(s.participants, 'Participants')}
      ${tile(actLabel, 'Active stage')}
      ${tile(s.overall + '%', 'Overall completion')}
      ${tile(s.reports, 'Reports generated')}</div>`;

  return kpis +
    `<h3 style="margin:6px 0 12px">Five-stage lifecycle</h3>${dashPipeline(s)}
    <div class="grid" style="grid-template-columns:1.3fr 1fr;margin-top:22px">
      <div class="card pad"><div class="flex jb ac" style="margin-bottom:12px"><h3>Action queue</h3>
          <span class="muted small">${(s.action_queue||[]).length} item${(s.action_queue||[]).length===1?'':'s'}</span></div>
        <div id="dashQueue">${dashQueue(s.action_queue)}</div></div>
      <div class="card pad"><h3 style="margin-bottom:12px">Recent activity</h3>
        <div id="dashActivity">${dashActivity(s.recent_activity)}</div></div>
    </div>`;
}

function dashPipeline(s){
  // order by stage num using the metadata
  var stages = (s.stages||[]).slice().sort(function(a,b){ return (a.num||0)-(b.num||0); });
  var pipe = '<div class="pipeline" id="dashPipe">';
  stages.forEach(function(st){
    var meta = DASH_STAGE_META[st.code] || { name: st.code, nav:'assessments' };
    var pill = DASH_PILL[st.status] || st.status;
    pipe += `<div class="stage"><div class="stage-card" onclick="go('${meta.nav}')">
      <div class="flex jb ac"><div class="stage-num">${meta.n||st.num||''}</div>
        <span class="pill ${st.status}">${pill}</span></div>
      <h3>${dEsc(meta.name)}</h3>
      <div class="muted small">${dashStageSub(st)}</div>
      <div class="bar"><i style="width:${st.pct||0}%"></i></div>
      <div class="flex jb ac small"><span class="muted">${st.pct||0}% complete</span>
        <span style="color:var(--indigo-d);font-weight:600">Open →</span></div>
    </div></div>`;
  });
  return pipe + '</div>';
}

function dashStageSub(st){
  if (st.code === 'wpca'){
    if (!st.panels_total) return 'No panels yet';
    return st.panels_done + '/' + st.panels_total + ' reviews complete';
  }
  if (st.code === 'reporting') return (st.pct||0) + '% participants reported';
  // technical stages
  if (!st.expected) return 'Not deployed';
  return st.submitted + '/' + st.expected + ' submitted';
}

function dashQueue(items){
  items = items || [];
  if (!items.length) return `<div class="muted small" style="padding:8px 0">All clear — no items need attention.</div>`;
  return items.map(function(it){
    var nav = it.action || 'dashboard';
    return aq(it.severity, dEsc(it.text), 'Open →', `go('${nav}')`);
  }).join('');
}

function dashActivity(rows){
  rows = rows || [];
  if (!rows.length) return `<div class="muted small" style="padding:8px 0">No activity yet — import a roster from <b>Cohorts</b> to get started.</div>`;
  return rows.map(function(r){
    var who = r.actor_name ? dEsc(r.actor_name) + ' · ' : '';
    var txt = who + dEsc(r.action) + (r.entity ? ' (' + dEsc(r.entity) + ')' : '');
    return act(txt, dashAgo(r.at));
  }).join('');
}

/* ============================================================
   DATA LOAD (one round-trip)
   ============================================================ */
function dashLoad(cid){
  if (!dashLive()){ return; }
  DASH.loading = true; DASH.err = null;
  window.sb.rpc('dashboard_summary', { p_cohort: cid })
    .then(function(res){
      DASH.loading = false;
      if (res.error){ DASH.err = res.error.message || String(res.error); }
      else { DASH.summary = res.data; DASH.err = null; }
      dashRepaintIfVisible(cid);
    })
    .catch(function(e){
      DASH.loading = false; DASH.err = (e && e.message) ? e.message : String(e);
      dashRepaintIfVisible(cid);
    });
}

function dashReload(){
  DASH.summary = null; DASH.err = null;
  if (DASH.cohortId) dashLoad(DASH.cohortId);
  if (window.renderAdmin) renderAdmin();
}

/* re-render only if the admin is still looking at this cohort's dashboard */
function dashRepaintIfVisible(cid){
  var onDash = window.state && state.role === 'admin' && state.view === 'dashboard';
  if (!onDash || DASH.cohortId !== cid) return;

  // first paint (skeleton → full): rebuild the whole view
  var root = document.getElementById('dashRoot');
  if (!root){ if (window.renderAdmin) renderAdmin(); return; }

  if (DASH.err){ root.innerHTML = `<div class="card pad"><p class="muted" style="margin:0">Couldn't load the dashboard: ${dEsc(DASH.err)}. <button class="btn ghost sm" onclick="dashReload()">Retry</button></p></div>`; return; }
  if (!DASH.summary){ root.innerHTML = dashSkeleton(); return; }

  // already-rendered → patch the live regions in place (keeps scroll)
  var s = DASH.summary;
  var kpis = document.querySelector('#dashRoot .dash-kpis');
  var pipe = document.getElementById('dashPipe');
  var q    = document.getElementById('dashQueue');
  var a    = document.getElementById('dashActivity');
  if (kpis && pipe && q && a){
    root.querySelector('.dash-kpis').outerHTML = dashBodyKpis(s);
    pipe.outerHTML = dashPipeline(s);
    q.innerHTML = dashQueue(s.action_queue);
    a.innerHTML = dashActivity(s.recent_activity);
  } else {
    root.innerHTML = dashBody(s);
  }
}

/* the KPI grid alone (used by the in-place patch) */
function dashBodyKpis(s){
  var actLabel = (s.active_stage && DASH_STAGE_META[s.active_stage])
    ? DASH_STAGE_META[s.active_stage].short : '—';
  return `<div class="grid dash-kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
      ${tile(s.participants, 'Participants')}
      ${tile(actLabel, 'Active stage')}
      ${tile(s.overall + '%', 'Overall completion')}
      ${tile(s.reports, 'Reports generated')}</div>`;
}

/* ============================================================
   REALTIME — live completion counts
   ============================================================ */
function dashEnsureRealtime(cid){
  if (!dashLive() || !cid) return;
  if (DASH.channel && DASH.channelOrg === cid) return;  // already subscribed for this cohort
  dashTeardownRealtime();
  DASH.channelOrg = cid;

  // Unfiltered subscription: RLS on attempts/wpca_panels means the realtime
  // server only delivers this org's rows. attempts carry no cohort_id, so we
  // react to any change by silently re-pulling the SELECTED cohort's summary.
  try {
    DASH.channel = window.sb.channel('dash-' + cid)
      .on('postgres_changes', { event:'*', schema:'public', table:'attempts' },     dashOnRealtime)
      .on('postgres_changes', { event:'*', schema:'public', table:'wpca_panels' },  dashOnRealtime)
      .subscribe();
  } catch (e){ /* realtime optional; dashboard still works without it */ }
}

function dashOnRealtime(){
  // debounce bursts (a cohort submitting together) into a single refetch
  if (DASH.refreshTimer) clearTimeout(DASH.refreshTimer);
  DASH.refreshTimer = setTimeout(function(){
    var onDash = window.state && state.role === 'admin' && state.view === 'dashboard';
    if (!onDash){ dashTeardownRealtime(); return; }   // navigated away → stop
    if (DASH.cohortId) dashLoad(DASH.cohortId);        // re-pull → silent in-place patch
  }, 1200);
}

function dashTeardownRealtime(){
  if (DASH.refreshTimer){ clearTimeout(DASH.refreshTimer); DASH.refreshTimer = null; }
  if (DASH.channel){
    try { window.sb.removeChannel(DASH.channel); } catch(e){}
    DASH.channel = null; DASH.channelOrg = null;
  }
}

/* tear the channel down when the admin navigates away from the dashboard */
(function wrapGo(){
  var _go = window.go;
  if (typeof _go !== 'function') return;
  window.go = function(k){
    if (k !== 'dashboard') dashTeardownRealtime();
    return _go.apply(this, arguments);
  };
})();

/* expose the override */
window.vDashboard = vDashboard;
