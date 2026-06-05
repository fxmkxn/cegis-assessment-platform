// CEGIS Assessment Platform - Participant portal.
// Participants are bulk-created by an admin and given an auto-generated password.
// They sign in here to complete tasks in this order:
//   1. Set their review panel (pick manager, reportees, and up to 6 peers).
//   2. Take their assigned assessments (baseline, endline, EOCA, objective).
//   3. Return to complete any WPCAS reviews they owe for other respondents.
// Auth is a lightweight token kept in localStorage.

var PORTAL = { token: null, me: null, roster: [] };
var TOKEN_KEY = "cegis_participant_token";

// ---------------------------------------------------------------- boot
onReady(function () {
  if (!initSupabase()) {
    render('<div class="card pad" style="max-width:560px;margin:40px auto"><h2 style="color:var(--red)">Setup needed</h2>'
      + '<p class="muted" style="margin-top:8px">This portal is not configured yet. The administrator needs to set the Supabase keys in assets/config.js.</p></div>');
    return;
  }
  PORTAL.token = readLS(TOKEN_KEY);
  if (PORTAL.token) loadHome(); else showLogin();
});

function render(html) { document.getElementById("stage").innerHTML = html; }
function setHeader(show) {
  var h = document.getElementById("phbar");
  if (!h) return;
  h.style.display = show ? "flex" : "none";
  if (show && PORTAL.me) {
    document.getElementById("phName").textContent = PORTAL.me.full_name || PORTAL.me.email;
    document.getElementById("phAv").textContent = initials(PORTAL.me.full_name || PORTAL.me.email);
  }
}

// ---------------------------------------------------------------- login
function showLogin() {
  setHeader(false);
  render('<div class="auth-wrap" style="min-height:60vh">'
    + '<div class="auth-left"><h2>Your assessments</h2>'
    + '<p>Sign in with the email and password your administrator shared with you.</p>'
    + '<p>From here you can set your review panel, take your assessments, and complete the WPCAS reviews you have been asked to give.</p></div>'
    + '<div class="auth-right"><div class="auth-card">'
    + '<h1>Sign in</h1><div class="sub">Use the credentials you were given.</div>'
    + '<div class="alert" id="p-login-err"></div>'
    + '<div class="field"><label class="label" for="p-email">Email</label><input class="input" id="p-email" type="email" placeholder="you@example.com"></div>'
    + '<div class="field"><label class="label" for="p-pass">Password</label><input class="input" id="p-pass" type="password" placeholder="Your password"></div>'
    + '<button class="btn" style="width:100%" onclick="doParticipantLogin()">Sign in</button>'
    + '</div></div></div>');
  var p = document.getElementById("p-pass");
  if (p) p.addEventListener("keydown", function (e) { if (e.key === "Enter") doParticipantLogin(); });
}
function doParticipantLogin() {
  var email = (document.getElementById("p-email").value || "").trim().toLowerCase();
  var pass  = document.getElementById("p-pass").value;
  if (!email || !pass) { loginErr("Enter your email and password."); return; }
  showLoader("Signing in...");
  db.rpc("participant_login", { p_email: email, p_password: pass }).then(function (r) {
    hideLoader();
    if (r.error) { loginErr(friendlyError(r.error)); return; }
    PORTAL.token = r.data.token;
    PORTAL.me    = r.data;
    writeLS(TOKEN_KEY, PORTAL.token);
    loadHome();
  });
}
function loginErr(msg) { var e = document.getElementById("p-login-err"); if (e) { e.textContent = msg; e.className = "alert err show"; } }
function doParticipantSignout() { removeLS(TOKEN_KEY); PORTAL.token = null; PORTAL.me = null; showLogin(); }

// ---------------------------------------------------------------- home
function loadHome() {
  showLoader("Loading your tasks...");
  db.rpc("participant_home", { p_token: PORTAL.token }).then(function (r) {
    hideLoader();
    if (r.error) { removeLS(TOKEN_KEY); showLogin(); loginErr("Please sign in again."); return; }
    PORTAL.me = r.data;
    setHeader(true);
    renderHome(r.data);
  });
}
function renderHome(d) {
  // the home page shows tasks in priority order:
  // 1. panel not yet set: force this first
  // 2. assessments to take (baseline / endline / eoca / objective)
  // 3. wpcas reviews to complete (shown last, after the respondent has done their own assessments)

  var panelBlock = "";
  if (!d.panel_submitted) {
    // panel is mandatory before anything else; show it as a prominent banner
    panelBlock = '<div class="card pad" style="margin-bottom:18px;border-left:4px solid var(--red)">'
      + '<div class="flex jb ac wrap" style="gap:10px">'
      + '<div><h3>Step 1: Set your review panel</h3>'
      + '<p class="muted small" style="margin-top:4px">Before you can take any assessments you must select your manager, reportees, and up to 6 peers. Your administrator will confirm the final list.</p></div>'
      + '<button class="btn" onclick="openPanel()">Choose people now</button>'
      + '</div></div>';
  } else {
    panelBlock = '<div class="card pad" style="margin-bottom:14px">'
      + '<div class="flex jb ac wrap" style="gap:10px">'
      + '<div><span class="pill live">Panel submitted</span>'
      + '<p class="muted small" style="margin-top:6px">Your panel has been submitted. You can update it until your administrator finalises it.</p></div>'
      + '<button class="btn ghost sm" onclick="openPanel()">Edit panel</button>'
      + '</div></div>';
  }

  // assessments section: only shown after panel is set
  var assBlock = "";
  if (d.panel_submitted) {
    var ass = d.assessments || [];
    var assHtml;
    if (!ass.length) {
      assHtml = '<p class="muted small">No assessments are open for you right now. Check back later.</p>';
    } else {
      assHtml = ass.map(function (a) {
        // check if this respondent has already completed this assessment
        // (the participant_home function filters to active assessments; completion state
        //  is not returned here so we just show a "Start" button — the take page handles duplicates)
        var typeTag = a.stage ? '<span class="tag" style="margin-right:6px">' + escHtml(a.stage) + '</span>' : '';
        return '<div class="task"><div class="ic2">&#9638;</div><div style="flex:1">'
          + '<div style="font-weight:600">' + escHtml(a.title) + '</div>'
          + '<div class="muted small" style="margin-top:2px">' + typeTag + (a.time_limit_minutes ? a.time_limit_minutes + " min" : "No time limit") + '</div></div>'
          + '<button class="btn sm" onclick="launchKey(\'' + escAttr(a.access_key) + '\')">Start</button></div>';
      }).join("");
    }
    assBlock = '<h3 style="margin:0 0 10px">Step 2: Your assessments</h3>' + assHtml;
  }

  // wpcas reviews section: shown after assessments; separate heading so it is clear these come last
  var reviewBlock = "";
  if (d.panel_submitted) {
    var tasks = d.review_tasks || [];
    var taskHtml;
    if (!tasks.length) {
      taskHtml = '<p class="muted small">No WPCAS reviews have been assigned to you yet.</p>';
    } else {
      taskHtml = tasks.map(function (t) {
        var done = t.is_completed;
        return '<div class="task ' + (done ? "done" : "") + '"><div class="ic2">' + (done ? "&#10003;" : "&#9733;") + '</div>'
          + '<div style="flex:1"><div style="font-weight:600">Review: ' + escHtml(t.subject_name) + '</div>'
          + '<div class="muted small">' + escHtml(t.title) + ' &middot; as their ' + escHtml(t.relationship) + '</div></div>'
          + (done ? '<span class="pill closed">Done</span>'
                  : '<button class="btn sm" onclick="launchKey(\'' + escAttr(t.access_key) + '\')">Start review</button>') + '</div>';
      }).join("");
    }
    reviewBlock = '<h3 style="margin:22px 0 10px">Step 3: WPCAS reviews to complete</h3>'
      + '<p class="muted small" style="margin-bottom:10px">These are the WPCAS reviews you owe for other people. Complete your own assessments first, then come back for these.</p>'
      + taskHtml;
  }

  render('<div class="report-wrap">'
    + '<div class="page-head"><h1>Hello, ' + escHtml((d.full_name || "").split(" ")[0] || d.full_name) + '</h1></div>'
    + panelBlock
    + (d.panel_submitted ? '<div style="margin-bottom:22px">' + assBlock + '</div><div>' + reviewBlock + '</div>' : "")
    + '</div>');
}
function launchKey(key) {
  // open the take page with the access key
  var base = window.location.pathname.replace(/portal\.html$/, "");
  window.location.href = window.location.origin + base + "take.html?k=" + encodeURIComponent(key);
}

// ---------------------------------------------------------------- 360 / WPCAS panel
// The panel picker lets the respondent pick:
//   - exactly 1 manager
//   - any number of reportees
//   - up to 6 peers
// The admin later finalises the WPCAS raters from these nominations.
function openPanel() {
  showLoader("Loading people...");
  db.rpc("participant_roster", { p_token: PORTAL.token }).then(function (r) {
    hideLoader();
    if (r.error) { toast(friendlyError(r.error), "err"); return; }
    PORTAL.roster = r.data || [];
    // seed picks from any previously saved nominations if we have them
    PORTAL._picks = PORTAL._picks || {};
    renderPanel("");
  });
}
function renderPanel(filter) {
  var f = (filter || "").toLowerCase();
  var list = PORTAL.roster.filter(function (p) {
    return !f || (p.full_name + " " + p.email + " " + (p.department || "") + " " + (p.location || "")).toLowerCase().indexOf(f) !== -1;
  });
  var picks = PORTAL._picks || {};
  var rows = list.map(function (p) {
    var cur = picks[p.id] || "";
    function opt(v, label) { return '<option value="' + v + '"' + (cur === v ? " selected" : "") + '>' + label + '</option>'; }
    var loc = p.location ? '<span class="muted small"> &middot; ' + escHtml(p.location) + '</span>' : '';
    return '<tr><td><b>' + escHtml(p.full_name) + '</b>' + loc + '<div class="muted small">' + escHtml(p.email) + '</div></td>'
      + '<td class="muted small">' + escHtml([p.designation, p.department].filter(Boolean).join(" &middot; ") || "—") + '</td>'
      + '<td><select class="input" style="padding:6px 8px" onchange="setPick(\'' + p.id + '\',this.value)">'
      + opt("", "— none —") + opt("manager", "Manager") + opt("reportee", "Reportee") + opt("peer", "Peer")
      + '</select></td></tr>';
  }).join("");
  var peers    = Object.keys(picks).filter(function (k) { return picks[k] === "peer"; }).length;
  var mgrs     = Object.keys(picks).filter(function (k) { return picks[k] === "manager"; }).length;
  var reps     = Object.keys(picks).filter(function (k) { return picks[k] === "reportee"; }).length;
  var tooMany  = peers > 6 || mgrs > 1;
  var counters = '<div class="flex g8 wrap" style="margin-top:10px">'
    + '<span class="tag" style="' + (mgrs > 1 ? "color:var(--red);border-color:var(--red)" : "") + '">' + mgrs + ' manager' + (mgrs === 1 ? "" : "s") + (mgrs > 1 ? " — max 1" : "") + '</span>'
    + '<span class="tag">' + reps + ' reportee' + (reps === 1 ? "" : "s") + '</span>'
    + '<span class="tag" style="' + (peers > 6 ? "color:var(--red);border-color:var(--red)" : "") + '">' + peers + ' / 6 peers' + (peers > 6 ? " — too many" : "") + '</span></div>';

  render('<div class="report-wrap">'
    + '<div class="crumb"><a href="#" onclick="loadHome();return false">Home</a> / Review panel</div>'
    + '<div class="page-head"><h1>Choose your review panel</h1></div>'
    + '<div class="card pad" style="margin-bottom:14px">'
    + '<p class="muted small">Mark each colleague as your <b>manager</b> (exactly 1), <b>reportee</b>, or <b>peer</b> (up to 6 peers). Your administrator will use these nominations to confirm the final WPCAS reviewers.</p>'
    + counters + '</div>'
    + '<div class="card pad" style="margin-bottom:12px"><input class="input" placeholder="Search people..." oninput="renderPanel(this.value)" value="' + escAttr(filter || "") + '"></div>'
    + '<div class="card"><table><thead><tr><th>Person</th><th>Role</th><th>Relationship</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="flex jb" style="margin-top:16px;gap:10px">'
    + '<button class="btn ghost" onclick="loadHome()">Cancel</button>'
    + '<button class="btn green" onclick="savePanel()">Save panel</button>'
    + '</div></div>');
}
function setPick(id, rel) {
  PORTAL._picks = PORTAL._picks || {};
  if (rel) PORTAL._picks[id] = rel;
  else delete PORTAL._picks[id];
}
function savePanel() {
  PORTAL._picks = PORTAL._picks || {};
  var byId = {}; PORTAL.roster.forEach(function (p) { byId[p.id] = p; });
  var picks = Object.keys(PORTAL._picks).map(function (id) {
    var p = byId[id];
    if (!p) return null;
    return { rater_id: id, rater_name: p.full_name, rater_email: p.email, relationship: PORTAL._picks[id] };
  }).filter(Boolean);
  var peers = picks.filter(function (p) { return p.relationship === "peer"; }).length;
  var mgrs  = picks.filter(function (p) { return p.relationship === "manager"; }).length;
  if (peers > 6) { toast("Please choose at most 6 peers.", "err"); return; }
  if (mgrs  > 1) { toast("Please choose only 1 manager.", "err"); return; }
  if (!picks.length) { toast("Choose at least one person.", "err"); return; }
  showLoader("Saving your panel...");
  db.rpc("save_nominations", { p_token: PORTAL.token, p_picks: picks }).then(function (r) {
    hideLoader();
    if (r.error) { toast(friendlyError(r.error), "err"); return; }
    toast("Panel saved", "ok");
    PORTAL._picks = {};
    loadHome();
  });
}

// ---------------------------------------------------------------- local storage
function readLS(k)  { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function removeLS(k)   { try { localStorage.removeItem(k); } catch (e) {} }
function escAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

// run fn once the DOM is ready, even if that already happened
function onReady(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
  else fn();
}
