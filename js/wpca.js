/* ============================================================
   WPCA · 360  — Phase 9
   ------------------------------------------------------------
   Two halves, both wired here:

     ADMIN  "Smart Configurator"
       - auto-assigns each subject a panel (self + manager +
         reportee + 3 peers) from the cohort hierarchy
         (ports the prototype's buildPanels()),
       - draws scrollable workload-health bars with a 2–6
         target band,
       - exposes the three constraint sliders,
       - peer-swap modal,
       - "Approve & roll out" — ONE atomic RPC
         (roll_out_wpca_round) that creates the wpca_rounds row
         and every wpca_panels row; the button stays disabled
         until every panel is complete.

     PARTICIPANT  "My 360 Tasks"
       - reviews owed, role-labeled, showing the SUBJECT being
         reviewed (the rater knows whom they rate; confidentiality
         protects the subject, not the rater),
       - a Likert questionnaire player that autosaves each answer
         to wpca_responses (save_wpca_response) and submits the
         panel (submit_wpca_panel). The instrument is the same
         per-question Likert assessment uploaded via the WPCA
         template in Phase 7.

   This file is loaded AFTER participant.js / player.js and BEFORE
   app.js, so the function definitions below OVERRIDE the stubs of
   the same name with the real, Supabase-wired implementations.

   DUAL MODE (consistent with player.js / assessments.js):
     - DEMO mode  (window.SUPABASE_CONFIGURED is false): everything
       runs on the in-memory sample roster exactly as the prototype
       did, so a placeholder-config deploy still demonstrates.
     - LIVE mode  (real Supabase config + a session): reads the
       cohort from the database and drives the RPCs above.

   CONFIDENTIALITY NOTE: nothing in this client can expose who rated
   whom or any individual rater answer. The DB refuses those reads
   even to an admin; 360 results are only ever surfaced through the
   wpca_competency_means() aggregate (used by the Phase-10 report
   screens, not here).
   ============================================================ */

/* ---- module state (single namespaced global to avoid clashes) ---- */
var WPCA = {
  // admin configurator working set (live mode mirrors the demo globals)
  loaded:   false,
  loading:  false,
  err:      null,
  cohortId: null,
  instrumentId: null,
  instrumentName: null,
  roster:   [],     // [{id,n,des,ws,loc,mgr,email}]
  subjects: [],     // subset of roster that get reviewed
  panels:   {},     // { subjectId: {mgr, reportee, peers:[...]} }
  hasHierarchy: true,

  // participant side
  tasks:    null,   // live: array from list_my_360_tasks(); null = not loaded
  tasksErr: null,
  review:   null    // active review session (see wpcaOpenReview)
};

var WPCA_LIKERT = ['Strongly disagree','Disagree','Neutral','Agree','Strongly agree'];

/* A small per-question Likert instrument used ONLY in demo mode, so the
   360 player is fully explorable without a backend. In live mode the
   questions come from start_wpca_review() (the uploaded WPCA template). */
var WPCA_DEMO_QUESTIONS = [
  { question_id:'d1', ordinal:1, competency:['Collaboration'],
    prompt:'Works generously with others and shares context proactively.' },
  { question_id:'d2', ordinal:2, competency:['Communication'],
    prompt:'Communicates analytical findings clearly to non-technical stakeholders.' },
  { question_id:'d3', ordinal:3, competency:['Ownership'],
    prompt:'Takes end-to-end ownership of commitments and follows through.' },
  { question_id:'d4', ordinal:4, competency:['Analytical rigor'],
    prompt:'Produces rigorous, well-documented analysis colleagues can trust and reuse.' },
  { question_id:'d5', ordinal:5, competency:['Adaptability'],
    prompt:'Adapts approach constructively when priorities or data change.' }
];

/* ============================================================
   SHARED HELPERS
   ============================================================ */
function wpcaLive(){ return !!(window.SUPABASE_CONFIGURED && window.sb); }

/* Defensive cohort-id lookup — mirrors assessments.js' accessor so the
   configurator works regardless of which global the rest of the app set. */
function wpcaCohortId(){
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

/* The working set the admin views read from: live = WPCA.*, demo = globals. */
function wpcaSet(){
  if (wpcaLive()) return { roster: WPCA.roster, subjects: WPCA.subjects, panels: WPCA.panels, hier: WPCA.hasHierarchy };
  return {
    roster:   (typeof ROSTER   !== 'undefined') ? ROSTER   : [],
    subjects: (typeof SUBJECTS !== 'undefined') ? SUBJECTS : [],
    panels:   (typeof PANELS   !== 'undefined') ? PANELS   : {},
    hier:     (typeof HAS_HIERARCHY !== 'undefined') ? HAS_HIERARCHY : true
  };
}

/* Roster-aware label helpers (live roster may not be in the global ROSTER). */
function wpcaFind(id){ var rs = wpcaSet().roster; for (var i=0;i<rs.length;i++) if (rs[i].id===id) return rs[i]; return null; }
function wpcaName(id){ var r = wpcaFind(id); return (r && r.n) || (typeof nameOf==='function'?nameOf(id):id); }
function wpcaInitials(n){
  if (typeof initials === 'function') return initials(n);
  return (n||'?').split(/\s+/).map(function(w){return w[0];}).slice(0,2).join('').toUpperCase();
}
function wpcaMeta(p){
  if (typeof meta === 'function') return meta(p);
  return [p.des,p.ws,p.loc].filter(Boolean).join(' · ') || 'Team member';
}

/* ============================================================
   PANEL ASSIGNMENT  (ports the prototype's buildPanels)
   ------------------------------------------------------------
   Exclude self / manager / reportee from the peer pool, then rank
   the pool preferring a DIFFERENT location (diversity) and the SAME
   workstream (relevance); take the top 3 as peers. Backwards-
   compatible: called with no args it uses the demo globals, so
   data.js' recomputeDerived() keeps working unchanged.
   ============================================================ */
function buildPanels(roster, subjects){
  roster   = roster   || ((typeof ROSTER   !== 'undefined') ? ROSTER   : []);
  subjects = subjects || ((typeof SUBJECTS !== 'undefined') ? SUBJECTS : []);
  var panels = {};
  subjects.forEach(function(s){
    var reportee = null;
    for (var i=0;i<roster.length;i++){ if (roster[i].mgr === s.id){ reportee = roster[i]; break; } }
    var exclude = {}; [s.id, s.mgr, reportee?reportee.id:null].filter(Boolean).forEach(function(x){ exclude[x]=true; });
    var pool = roster.filter(function(r){ return !exclude[r.id]; });
    var score = function(r){ return (r.loc && r.loc!==s.loc ? -1 : 0) + (r.ws && r.ws===s.ws ? -0.5 : 0); };
    var ranked = pool.slice().sort(function(a,b){ return score(a)-score(b); });
    panels[s.id] = {
      mgr: (s.mgr && roster.some(function(x){return x.id===s.mgr;})) ? s.mgr : null,
      reportee: reportee ? reportee.id : null,
      peers: ranked.slice(0,3).map(function(r){ return r.id; })
    };
  });
  return panels;
}

function wpcaEligiblePeers(sub){
  return wpcaSet().roster.filter(function(r){ return r.id!==sub.id && r.id!==sub.mgr; });
}

/* reviews assigned to a given rater across the whole working set */
function workloadCount(pid){
  var set = wpcaSet(), c = 0;
  set.subjects.forEach(function(s){
    var p = set.panels[s.id]; if (!p) return;
    if (p.mgr === pid) c++;
    if (p.reportee === pid) c++;
    if (p.peers && p.peers.indexOf(pid) !== -1) c++;
  });
  return c;
}

/* ============================================================
   ADMIN — Smart Configurator view
   ============================================================ */
function vWPCA(){
  // LIVE: load the cohort + instrument the first time the view opens.
  if (wpcaLive() && !WPCA.loaded){
    if (!WPCA.loading){ wpcaLoadConfig(); }   // fire and re-render on completion
    if (WPCA.err){
      return '<div class="crumb">Lifecycle / WPCA · 360</div>'+
        '<div class="page-head"><h1>WPCA Smart Configurator</h1></div>'+
        '<div class="card pad"><span class="badge err">⚠ '+wpcaEsc(WPCA.err)+'</span>'+
        '<p class="muted small" style="margin-top:10px">Upload a WPCA Likert instrument for this cohort (Assessments → upload, kind <b>WPCA</b>) and add the roster, then reopen this screen.</p></div>';
    }
    return '<div class="crumb">Lifecycle / WPCA · 360</div>'+
      '<div class="page-head"><h1>WPCA Smart Configurator</h1></div>'+
      '<div class="card pad"><div class="muted">Loading the cohort and building panels…</div></div>';
  }

  var set = wpcaSet();
  var rows = set.subjects.map(function(s){
    var p = set.panels[s.id] || { peers:[] };
    var peerChips = (p.peers||[]).map(function(pid, idx){ return wpcaRaterChip(pid, s, 'peer', s.id, idx); }).join('') || '<span class="muted small">—</span>';
    var reChip  = p.reportee ? wpcaRaterChip(p.reportee, s, 'reportee', s.id) : '<span class="muted small">— none</span>';
    var mgrChip = p.mgr ? wpcaRaterChip(p.mgr, s, 'mgr', s.id)
      : (set.hier ? '<span class="badge warn">⚠ no manager</span>' : '<span class="tag">n/a</span>');
    var incomplete = ((p.peers||[]).length < 3) || (set.hier && !p.mgr);
    return '<tr><td><b>'+wpcaEsc(s.n)+'</b><div class="muted small">'+wpcaEsc(wpcaMeta(s))+'</div>'+
      (incomplete ? '<span class="badge warn" style="margin-top:4px">⚠ incomplete panel</span>' : '')+'</td>'+
      '<td><span class="chip"><span class="av">Self</span></span></td>'+
      '<td>'+mgrChip+'</td><td>'+reChip+'</td><td>'+peerChips+'</td></tr>';
  }).join('');

  var roundSel = '<select id="wpcaRound" class="btn ghost sm" style="appearance:auto">'+
    '<option>Week 2</option><option>Week 4</option><option>Week 6</option></select>';

  return '<div class="crumb">Lifecycle / WPCA · 360</div>'+
  '<div class="page-head"><h1>WPCA Smart Configurator</h1>'+
    '<div class="flex g12 ac">'+roundSel+
      '<button class="btn ghost" onclick="reassign()">↻ Re-run assignment</button>'+
      '<button class="btn" id="approveBtn" onclick="approveWPCA()">Approve &amp; roll out</button></div></div>'+
  '<div class="grid" style="grid-template-columns:300px 1fr">'+
    '<div>'+
      '<div class="card pad" style="margin-bottom:14px"><h3 style="margin-bottom:4px">Workload health</h3>'+
        '<div class="muted small" style="margin-bottom:14px">Reviews assigned per rater · target band 2–6</div>'+
        '<div id="workload"></div><hr style="margin:14px 0"><div id="wlstats" class="small"></div></div>'+
      '<div class="card pad"><h3 style="margin-bottom:8px;font-size:13px">Constraint priorities</h3>'+
        wpcaSlider('Location diversity',75)+wpcaSlider('Equitable load',85)+wpcaSlider('Workstream relevance',55)+'</div>'+
    '</div>'+
    '<div class="card">'+
      '<div class="pad" style="border-bottom:1px solid var(--g200)"><div class="flex jb ac wrap">'+
        '<h3>Peer matrix · '+set.subjects.length+' subjects</h3>'+
        '<span class="muted small">Click any peer chip to swap · 📍 same location · ⇄ cross-workstream</span></div></div>'+
      '<div style="overflow:auto"><table><thead><tr><th>Subject</th><th>Self</th><th>Manager</th><th>Reportee</th><th>Peers (×3)</th></tr></thead>'+
      '<tbody>'+rows+'</tbody></table></div>'+
    '</div></div>';
}

function wpcaSlider(l,v){
  return '<div style="margin-bottom:12px"><div class="flex jb small"><span class="muted">'+l+'</span><b>'+v+'%</b></div>'+
    '<div class="bar" style="margin:5px 0 0"><i style="width:'+v+'%"></i></div></div>';
}

function wpcaRaterChip(pid, sub, role, subId, peerIdx){
  var r = wpcaFind(pid); if (!r) return '';
  var over = workloadCount(pid) > 6;                    // 2–6 band: over-cap is >6
  var sameLoc = r.loc && r.loc === sub.loc;
  var crossWs = r.ws && r.ws !== sub.ws;
  var flags = (sameLoc?'📍':'') + (crossWs?'⇄':'');
  var clickable = role === 'peer';
  return '<span class="chip '+(over?'over':'')+'" '+(clickable?'onclick="openSwap(\''+subId+'\','+peerIdx+')"':'')+
    ' title="'+wpcaEsc(wpcaMeta(r))+' · load '+workloadCount(pid)+'">'+
    '<span class="av">'+wpcaInitials(r.n)+'</span>'+wpcaEsc(r.n.split(/\s+/)[0])+' <span class="fl">'+flags+'</span></span>';
}

/* Workload bars + stats. Target band 2–6 (over-cap is a health SIGNAL, not a
   blocker; only INCOMPLETE panels disable the roll-out button). */
function drawWorkload(){
  var el = document.getElementById('workload'); if (!el) return;
  var set = wpcaSet();
  var seen = {}, raters = [];
  set.subjects.forEach(function(s){
    var p = set.panels[s.id]; if (!p) return;
    [p.mgr, p.reportee].concat(p.peers||[]).filter(Boolean).forEach(function(id){ if(!seen[id]){ seen[id]=true; raters.push(id); } });
  });
  var data = raters.map(function(id){ return { id:id, n:wpcaName(id), c:workloadCount(id) }; })
                   .sort(function(a,b){ return b.c - a.c; });
  var max = Math.max(7, Math.max.apply(null, data.map(function(d){return d.c;}).concat([0])));

  el.innerHTML = data.map(function(d){
    var cls = d.c > 6 ? 'over' : (d.c < 2 ? 'under' : '');
    var bandLeft  = (2/max*100);
    var bandWidth = (4/max*100);           // band spans 2 → 6
    return '<div class="wl-row"><span class="wl-name" title="'+wpcaEsc(d.n)+'">'+wpcaEsc(d.n)+'</span>'+
      '<div class="wl-track"><div class="wl-band" style="left:'+bandLeft+'%;width:'+bandWidth+'%"></div>'+
      '<div class="wl-fill '+cls+'" style="width:'+(d.c/max*100)+'%"></div></div><span class="wl-val">'+d.c+'</span></div>';
  }).join('') || '<div class="muted small">No raters assigned.</div>';

  var counts = data.map(function(d){return d.c;});
  var mean = counts.length ? (counts.reduce(function(a,b){return a+b;},0)/counts.length).toFixed(1) : '0';
  var over = counts.filter(function(c){return c>6;}).length;
  var under = counts.filter(function(c){return c<2;}).length;
  var incomplete = set.subjects.filter(function(s){
    var p = set.panels[s.id] || {peers:[]};
    return (p.peers||[]).length < 3 || (set.hier && !p.mgr);
  }).length;

  var stats = document.getElementById('wlstats');
  if (stats) stats.innerHTML =
    '<div class="kv"><span class="muted">Mean reviews / rater</span><b>'+mean+'</b></div>'+
    '<div class="kv"><span class="muted">Over cap (&gt;6)</span><b style="color:'+(over?'var(--err)':'var(--ok)')+'">'+over+'</b></div>'+
    '<div class="kv"><span class="muted">Under band (&lt;2)</span><b style="color:'+(under?'var(--warn)':'var(--ok)')+'">'+under+'</b></div>'+
    '<div class="kv"><span class="muted">Incomplete panels</span><b style="color:'+(incomplete?'var(--warn)':'var(--ok)')+'">'+incomplete+'</b></div>';

  // Only incomplete panels block roll-out; an over-cap rater is a signal to swap.
  var ab = document.getElementById('approveBtn');
  if (ab){ ab.disabled = incomplete > 0; ab.title = incomplete > 0 ? 'Resolve incomplete panels first' : ''; }
}

/* Re-run the smart assignment (load-balancing). */
function reassign(){
  var set = wpcaSet();
  if (typeof mountOctopus === 'function'){ var m=document.querySelector('.main'); if(m) mountOctopus(m,'Running the load-balancing assignment…'); }
  setTimeout(function(){
    var fresh = buildPanels(set.roster, set.subjects);
    if (wpcaLive()) WPCA.panels = fresh; else if (typeof PANELS!=='undefined') { for (var k in PANELS) delete PANELS[k]; for (var j in fresh) PANELS[j]=fresh[j]; }
    if (typeof toast==='function') toast('Re-ran smart assignment','ok');
    if (typeof renderAdmin==='function') renderAdmin();
  }, 700);
}

/* Peer-swap modal — candidates ranked by current review load. */
function openSwap(subId, peerIdx){
  var set = wpcaSet();
  var sub = wpcaFind(subId); if (!sub) return;
  var panel = set.panels[subId]; if (!panel) return;
  var current = panel.peers[peerIdx];
  var used = {}; [subId, panel.mgr, panel.reportee].concat(panel.peers||[]).filter(Boolean).forEach(function(x){ used[x]=true; });
  var cands = wpcaEligiblePeers(sub)
    .filter(function(r){ return !used[r.id] || r.id===current; })
    .sort(function(a,b){ return workloadCount(a.id)-workloadCount(b.id); });
  var opts = cands.slice(0,8).map(function(r){
    var load = workloadCount(r.id);
    var badge = load>6 ? 'err' : (load<2 ? 'info' : 'ok');
    return '<div class="flex ac jb" style="padding:9px 10px;border:1px solid var(--g200);border-radius:9px;margin-bottom:7px;cursor:pointer'+(r.id===current?';background:var(--indigo-l)':'')+'" onclick="doSwap(\''+subId+'\','+peerIdx+',\''+r.id+'\')">'+
      '<div class="flex ac g8"><span class="av" style="width:28px;height:28px;border-radius:50%;background:var(--teal);color:#fff;display:grid;place-items:center;font-size:10px;font-weight:700">'+wpcaInitials(r.n)+'</span>'+
      '<div><b>'+wpcaEsc(r.n)+'</b><div class="muted small">'+wpcaEsc(wpcaMeta(r))+'</div></div></div>'+
      '<span class="badge '+badge+'">load '+load+'</span></div>';
  }).join('') || '<div class="muted small">No other eligible raters available.</div>';
  if (typeof showModal === 'function') showModal({
    title:'Swap a peer for '+wpcaEsc(sub.n.split(/\s+/)[0]),
    body:'<div class="muted small" style="margin-bottom:10px">Candidates ranked by current review load. Swapping recomputes the workload graph live.</div>'+opts,
    confirm:null, onConfirm:null
  });
}

function doSwap(subId, peerIdx, newId){
  var set = wpcaSet();
  if (set.panels[subId]) set.panels[subId].peers[peerIdx] = newId;
  if (typeof closeModal==='function') closeModal();
  if (typeof renderAdmin==='function') renderAdmin();
  if (typeof toast==='function') toast('Rater swapped — workload updated','ok');
}

/* Approve & roll out — ONE atomic RPC in live mode. */
function approveWPCA(){
  var set = wpcaSet();
  var total = 0;
  set.subjects.forEach(function(s){ var p=set.panels[s.id]||{peers:[]}; total += 1 + (p.mgr?1:0) + (p.reportee?1:0) + (p.peers||[]).length; });
  var roundName = (document.getElementById('wpcaRound') || {}).value || 'Week 2';

  if (typeof showModal === 'function') showModal({
    title:'Approve & roll out '+wpcaEsc(roundName)+' 360?',
    body:'This sends <b>'+total+' review invitations</b> across <b>'+set.subjects.length+' subjects</b> to their assigned raters. Self, manager, reportee and three peers per subject. This cannot be undone.',
    confirm:'Approve & roll out',
    onConfirm: function(){ wpcaDoRollout(roundName); }
  });
}

function wpcaDoRollout(roundName){
  if (typeof closeModal==='function') closeModal();
  var set = wpcaSet();
  var total = 0;
  set.subjects.forEach(function(s){ var p=set.panels[s.id]||{peers:[]}; total += 1 + (p.mgr?1:0) + (p.reportee?1:0) + (p.peers||[]).length; });

  if (!wpcaLive()){
    if (typeof toast==='function') toast('WPCA '+roundName+' rolled out · '+total+' invitations sent','ok');
    if (typeof go==='function') go('dashboard');
    return;
  }

  // LIVE: build the panels payload and call the atomic roll-out RPC.
  var payload = set.subjects.map(function(s){
    var p = set.panels[s.id] || { peers:[] };
    return { subject:s.id, manager:p.mgr||null, reportee:p.reportee||null, peers:(p.peers||[]).filter(Boolean) };
  });

  if (typeof mountOctopus==='function'){ var m=document.querySelector('.main'); if(m) mountOctopus(m,'Rolling out the 360 and sending invitations…'); }

  sb.rpc('roll_out_wpca_round', {
    p_cohort_id: WPCA.cohortId,
    p_assessment_id: WPCA.instrumentId,
    p_round_name: roundName,
    p_panels: payload
  }).then(function(res){
    if (res.error) throw res.error;
    var d = res.data || {};
    var inv = (d.invitations != null) ? d.invitations : total;
    if (typeof toast==='function') toast('WPCA '+roundName+' rolled out · '+inv+' invitations sent','ok');
    // force a fresh load next time the configurator opens
    WPCA.loaded = false; WPCA.tasks = null;
    if (typeof go==='function') go('dashboard'); else if (typeof renderAdmin==='function') renderAdmin();
  }).catch(function(err){
    if (typeof toast==='function') toast((err && err.message) || 'Roll-out failed','err');
    if (typeof renderAdmin==='function') renderAdmin();
  });
}

/* LIVE: load the cohort roster + the WPCA instrument, then build panels. */
function wpcaLoadConfig(){
  WPCA.loading = true; WPCA.err = null;
  var cohortId = wpcaCohortId();
  if (!cohortId){ WPCA.loading=false; WPCA.loaded=true; WPCA.err='No cohort selected.'; if(typeof renderAdmin==='function') renderAdmin(); return; }
  WPCA.cohortId = cohortId;

  // 1) the most recent WPCA-kind instrument for this cohort
  sb.from('assessments')
    .select('id,name,created_at')
    .eq('cohort_id', cohortId).eq('kind','wpca')
    .is('deleted_at', null)
    .order('created_at', { ascending:false }).limit(1)
    .then(function(aRes){
      if (aRes.error) throw aRes.error;
      if (!aRes.data || !aRes.data.length) throw new Error('No WPCA instrument uploaded for this cohort yet.');
      WPCA.instrumentId = aRes.data[0].id;
      WPCA.instrumentName = aRes.data[0].name;
      // 2) the cohort participants
      return sb.from('participants')
        .select('id,name,email,designation,workstream,location,manager_participant_id')
        .eq('cohort_id', cohortId).is('deleted_at', null);
    })
    .then(function(pRes){
      if (pRes.error) throw pRes.error;
      WPCA.roster = (pRes.data||[]).map(function(p){
        return { id:p.id, n:p.name, des:p.designation, ws:p.workstream, loc:p.location, mgr:p.manager_participant_id||null, email:p.email };
      });
      // hierarchy + subjects (same rule as the prototype's recomputeDerived)
      WPCA.hasHierarchy = WPCA.roster.some(function(r){ return r.mgr && WPCA.roster.some(function(x){return x.id===r.mgr;}); });
      WPCA.subjects = WPCA.hasHierarchy
        ? WPCA.roster.filter(function(r){ return r.mgr && WPCA.roster.some(function(x){return x.id===r.mgr;}); })
        : WPCA.roster.slice();
      if (!WPCA.subjects.length) WPCA.subjects = WPCA.roster.slice();
      WPCA.panels = buildPanels(WPCA.roster, WPCA.subjects);
      WPCA.loaded = true; WPCA.loading = false;
      if (typeof renderAdmin==='function') renderAdmin();
    })
    .catch(function(err){
      WPCA.loading=false; WPCA.loaded=true; WPCA.err=(err && err.message) || 'Could not load the cohort.';
      if (typeof renderAdmin==='function') renderAdmin();
    });
}

/* ============================================================
   PARTICIPANT — "My 360 Tasks"
   ============================================================ */
function p360(){
  if (wpcaLive()){
    if (WPCA.tasks === null){
      if (!WPCA._tasksLoading){ wpcaLoadTasks(); }
      return '<div class="page-head"><h1>My 360 Tasks</h1></div><div class="card pad"><div class="muted">Loading your reviews…</div></div>';
    }
    if (WPCA.tasksErr){
      return '<div class="page-head"><h1>My 360 Tasks</h1></div><div class="card pad"><span class="badge err">⚠ '+wpcaEsc(WPCA.tasksErr)+'</span></div>';
    }
    var owed = WPCA.tasks.filter(function(t){ return t.status !== 'complete'; });
    var done = WPCA.tasks.filter(function(t){ return t.status === 'complete'; });
    var groups = {};
    WPCA.tasks.forEach(function(t){ (groups[t.round_name] = groups[t.round_name] || []).push(t); });

    var sections = Object.keys(groups).map(function(rn){
      var rows = groups[rn].map(wpcaTaskRowLive).join('');
      return '<div class="card pad" style="margin-bottom:14px"><h3 style="margin-bottom:10px">Reviews I owe — '+wpcaEsc(rn)+'</h3>'+rows+'</div>';
    }).join('');

    return '<div class="page-head"><h1>My 360 Tasks</h1>'+
      '<span class="badge '+(owed.length?'warn':'ok')+'">'+(owed.length? owed.length+' to complete' : 'all done')+'</span></div>'+
      (WPCA.tasks.length ? sections : '<div class="card pad"><p class="muted">No reviews assigned to you yet.</p></div>');
  }

  /* DEMO: prototype behaviour, but each row opens a real (local) Likert player. */
  var me = (typeof ME==='function') ? ME() : {id:'',n:'You',mgr:null};
  var roster = (typeof ROSTER!=='undefined') ? ROSTER : [];
  var others = roster.filter(function(r){ return r.id!==me.id; }).slice(0,3);
  var rows = others.map(function(r){ return wpcaTaskRowDemo(me, r); }).join('') || '<p class="muted">No reviews assigned to you yet.</p>';
  return '<div class="page-head"><h1>My 360 Tasks</h1></div>'+
    '<div class="card pad"><h3 style="margin-bottom:10px">Reviews I owe — WPCA Week 2</h3>'+rows+'</div>';
}

function wpcaRoleLabel(role){
  return role==='self' ? 'Self-review'
       : role==='manager' ? 'As Manager'
       : role==='reportee' ? 'As Reportee'
       : 'As Peer';
}

function wpcaTaskRowLive(t){
  var initialsName = wpcaInitials(t.subject_name || '?');
  var pct = t.total_q ? Math.round((t.answered_q/t.total_q)*100) : 0;
  var done = t.status === 'complete';
  var sub = (t.rater_role==='self') ? 'Yourself' : wpcaEsc(t.subject_name);
  var btn = done
    ? '<span class="badge ok">✓ submitted</span>'
    : '<button class="btn ghost sm" onclick="wpcaOpenReview(\''+t.panel_id+'\')">'+(t.answered_q? 'Continue →':'Start review →')+'</button>';
  return '<div class="flex ac jb" style="padding:12px 0;border-bottom:1px solid var(--g100)">'+
    '<div class="flex ac g12"><div class="avatar" style="background:var(--teal)">'+initialsName+'</div>'+
      '<div><b>'+sub+'</b> <span class="tag">'+wpcaRoleLabel(t.rater_role)+'</span>'+
      '<div class="muted small">'+wpcaEsc(t.instrument||'WPCA')+(done?' · complete':' · '+t.answered_q+'/'+t.total_q+' answered ('+pct+'%)')+'</div></div></div>'+
    btn+'</div>';
}

function wpcaTaskRowDemo(me, r){
  var role = 'peer';
  if (me.mgr === r.id) role = 'reportee';        // I report to r → I review r as their reportee
  else if (r.mgr === me.id) role = 'manager';    // r reports to me → I review r as their manager
  var fl = [];
  if (r.loc && r.loc===me.loc) fl.push('📍 same location');
  if (r.ws && r.ws!==me.ws) fl.push('⇄ cross-workstream');
  return '<div class="flex ac jb" style="padding:12px 0;border-bottom:1px solid var(--g100)">'+
    '<div class="flex ac g12"><div class="avatar" style="background:var(--teal)">'+wpcaInitials(r.n)+'</div>'+
      '<div><b>'+wpcaEsc(r.n)+'</b> <span class="tag">'+wpcaRoleLabel(role)+'</span>'+
      '<div class="muted small">'+(fl.join(' · ')||wpcaEsc(wpcaMeta(r)))+'</div></div></div>'+
    '<button class="btn ghost sm" onclick="wpcaOpenReview(\'demo:'+r.id+'\')">Start review →</button></div>';
}

function wpcaLoadTasks(){
  WPCA._tasksLoading = true; WPCA.tasksErr = null;
  sb.rpc('list_my_360_tasks').then(function(res){
    WPCA._tasksLoading = false;
    if (res.error){ WPCA.tasksErr = res.error.message || 'Could not load tasks'; WPCA.tasks = []; }
    else { WPCA.tasks = res.data || []; }
    if (typeof renderParticipant==='function') renderParticipant();
  }).catch(function(err){
    WPCA._tasksLoading = false; WPCA.tasksErr = (err&&err.message)||'Could not load tasks'; WPCA.tasks = [];
    if (typeof renderParticipant==='function') renderParticipant();
  });
}

/* ============================================================
   PARTICIPANT — Likert questionnaire player
   ------------------------------------------------------------
   Renders into .main directly (no tab in renderParticipant's map),
   autosaves each answer, and submits the panel. The subject's name
   is shown to the rater (they know whom they review); nothing here
   ever reveals OTHER raters or their answers.
   ============================================================ */
function wpcaOpenReview(panelId){
  var demo = panelId.indexOf('demo:') === 0;
  WPCA.review = { panelId:panelId, demo:demo, loading:true, err:null, data:null, answers:{}, saving:{}, submitting:false };
  wpcaRenderReview();

  if (demo){
    var rid = panelId.slice(5);
    var r = (typeof ROSTER!=='undefined') ? ROSTER.filter(function(x){return x.id===rid;})[0] : null;
    WPCA.review.data = {
      panel_id: panelId,
      subject_name: r ? r.n : 'Colleague',
      instrument: 'WPCA Instrument (sample)',
      questions: WPCA_DEMO_QUESTIONS.map(function(q){ return Object.assign({}, q, { saved:null }); })
    };
    WPCA.review.loading = false;
    wpcaRenderReview();
    return;
  }

  sb.rpc('start_wpca_review', { p_panel_id: panelId }).then(function(res){
    if (res.error) throw res.error;
    WPCA.review.data = res.data;
    // rehydrate saved answers
    (res.data.questions||[]).forEach(function(q){ if (q.saved != null) WPCA.review.answers[q.question_id] = q.saved; });
    WPCA.review.loading = false;
    wpcaRenderReview();
  }).catch(function(err){
    WPCA.review.loading = false; WPCA.review.err = (err&&err.message)||'Could not open this review';
    wpcaRenderReview();
  });
}

function wpcaRenderReview(){
  var main = document.querySelector('.main'); if (!main) return;
  var R = WPCA.review; if (!R){ return; }

  if (R.loading){ main.innerHTML = '<div class="page-head"><h1>360 review</h1></div><div class="card pad"><div class="muted">Loading the questionnaire…</div></div>'; return; }
  if (R.err){ main.innerHTML = '<div class="page-head"><h1>360 review</h1></div><div class="card pad"><span class="badge err">⚠ '+wpcaEsc(R.err)+'</span><div style="margin-top:12px"><button class="btn ghost" onclick="wpcaCloseReview()">← Back to My 360 Tasks</button></div></div>'; return; }

  var d = R.data;
  var qs = d.questions || [];
  var answered = qs.filter(function(q){ return R.answers[q.question_id] != null; }).length;
  var pct = qs.length ? Math.round(answered/qs.length*100) : 0;

  var blocks = qs.map(function(q, i){
    var comp = Array.isArray(q.competency) ? q.competency.filter(Boolean).join(' · ') : (q.competency||'');
    var chosen = R.answers[q.question_id];
    var saving = R.saving[q.question_id];
    var btns = WPCA_LIKERT.map(function(lbl, idx){
      var val = idx+1;
      return '<button class="'+(chosen===val?'sel':'')+'" onclick="wpcaAnswer(\''+q.question_id+'\','+val+')">'+lbl+'</button>';
    }).join('');
    return '<div class="card pad" style="margin-bottom:12px">'+
      '<div class="flex jb ac" style="margin-bottom:6px"><span class="tag">Q'+(i+1)+(comp?(' · '+wpcaEsc(comp)):'')+'</span>'+
      (saving? '<span class="muted small">saving…</span>' : (chosen!=null?'<span class="muted small">saved ✓</span>':''))+'</div>'+
      '<p style="margin:0 0 12px;font-weight:600">'+wpcaEsc(q.prompt)+'</p>'+
      '<div class="likert">'+btns+'</div></div>';
  }).join('');

  var canSubmit = (answered === qs.length) && qs.length > 0 && !R.submitting;
  main.innerHTML =
    '<div class="page-head"><div><div class="crumb">My 360 Tasks / Review</div>'+
      '<h1>Reviewing '+wpcaEsc(d.subject_name||'colleague')+'</h1></div>'+
      '<button class="btn ghost" onclick="wpcaCloseReview()">← Back</button></div>'+
    '<div class="card pad" style="margin-bottom:14px"><div class="flex jb small"><span class="muted">'+wpcaEsc(d.instrument||'WPCA Instrument')+'</span><b>'+answered+'/'+qs.length+'</b></div>'+
      '<div class="bar" style="margin:8px 0 0"><i style="width:'+pct+'%"></i></div></div>'+
    blocks+
    '<div class="flex jb ac" style="margin-top:8px"><span class="muted small">Your individual ratings stay confidential — '+wpcaEsc(d.subject_name||'the subject')+' only ever sees pooled, anonymized competency scores.</span>'+
    '<button class="btn" '+(canSubmit?'':'disabled')+' onclick="wpcaSubmitReview()">'+(R.submitting?'Submitting…':'Submit review')+'</button></div>';
}

function wpcaAnswer(qid, val){
  var R = WPCA.review; if (!R) return;
  R.answers[qid] = val;

  if (R.demo){ wpcaRenderReview(); return; }

  R.saving[qid] = true; wpcaRenderReview();
  sb.rpc('save_wpca_response', { p_panel_id: R.panelId, p_question_id: qid, p_likert: val })
    .then(function(res){
      R.saving[qid] = false;
      if (res.error){ if(typeof toast==='function') toast(res.error.message||'Could not save answer','err'); delete R.answers[qid]; }
      wpcaRenderReview();
    })
    .catch(function(err){ R.saving[qid]=false; if(typeof toast==='function') toast((err&&err.message)||'Could not save answer','err'); delete R.answers[qid]; wpcaRenderReview(); });
}

function wpcaSubmitReview(){
  var R = WPCA.review; if (!R) return;
  R.submitting = true; wpcaRenderReview();

  if (R.demo){
    setTimeout(function(){
      if (typeof toast==='function') toast('Review submitted (demo) — thank you','ok');
      wpcaCloseReview();
    }, 500);
    return;
  }

  sb.rpc('submit_wpca_panel', { p_panel_id: R.panelId }).then(function(res){
    R.submitting = false;
    if (res.error){ if(typeof toast==='function') toast(res.error.message||'Could not submit','err'); wpcaRenderReview(); return; }
    if (typeof toast==='function') toast('360 review submitted','ok');
    WPCA.tasks = null;            // refresh the task list on return
    wpcaCloseReview();
  }).catch(function(err){
    R.submitting = false; if(typeof toast==='function') toast((err&&err.message)||'Could not submit','err'); wpcaRenderReview();
  });
}

function wpcaCloseReview(){
  WPCA.review = null;
  if (typeof state !== 'undefined' && state) state.ptab = 't360';
  if (typeof renderParticipant === 'function') renderParticipant();
}

/* ---- tiny HTML escaper for any DB/user-supplied text we interpolate ---- */
function wpcaEsc(s){
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}
