// CEGIS Assessment Platform - Admin console logic.
// Single-page console: an auth gate, then a left-rail app shell.
//
// The flow this console drives:
//   1. Create an INSTANCE (one programme cycle).
//   2. Upload PARTICIPANTS (Excel) - a login password is generated per person.
//   3. Add ASSESSMENTS inside the instance. Only four categories are allowed:
//        WPCAS (360, Yes/No)  ·  Baseline  ·  Endline  ·  EoCA  (objective).
//      Set an activate / deactivate window on each one.
//   4. For objective assessments, attach an IMAGE to questions if needed.
//   5. GO LIVE with the instance.
//   6. Participants sign in to the portal, set their panel (manager / reportees
//      / up to 6 peers), and take their assessments.
//   7. Finalise WPCAS reviewers - AUTOMATICALLY (1 manager + 3 peers, 2 from the
//      same city + 1 from a different city) or MANUALLY per subject.
//   8. Review objective results and WPCAS reports.
//
// Security: all data access goes through Supabase with Row-Level Security;
// destructive actions are soft deletes via RPCs (never a real DELETE); scoring
// happens on the server. Shared helpers (escHtml, escAttr, toast, showModal,
// friendlyError, fmtDate, fmtDuration, initials, onReady, the Excel readers and
// the SVG charts) all live in common.js and are NOT redefined here.

var ADMIN = { user: null, view: "dashboard", assessmentId: null, presetInstance: null };
var CACHE = { assessments: [], qCounts: {}, rCounts: {}, rAvg: {}, flagCounts: {}, instances: [] };
var UPLOAD = { step: 0, fileName: "", questions: [], valid: [] };

// the four allowed assessment categories, mapped to (assessment_type, stage)
var CATS = [
  ["wpca",     "WPCAS (360 - Yes/No)"],
  ["baseline", "Baseline (objective)"],
  ["endline",  "Endline (objective)"],
  ["eoca",     "EoCA (objective)"]
];
// category -> { assessment_type, stage }
function catToType(cat) {
  return cat === "wpca" ? { assessment_type: "wpca", stage: "wpca" }
                        : { assessment_type: "objective", stage: cat };
}
// assessment row -> category code
function typeToCat(a) {
  if (a.assessment_type === "wpca") return "wpca";
  return a.stage || "baseline";
}
function catLabel(cat) {
  for (var i = 0; i < CATS.length; i++) if (CATS[i][0] === cat) return CATS[i][1];
  return cat;
}
function isWpcaRow(a) { return a && a.assessment_type === "wpca"; }

// ---------------------------------------------------------------- boot
onReady(function () {
  if (!initSupabase()) {
    document.getElementById("app").style.display = "flex";
    document.getElementById("app").innerHTML =
      '<div class="main"><div class="card pad" style="max-width:560px;margin:40px auto">'
      + '<h2 style="color:var(--red)">Configuration needed</h2>'
      + '<p class="muted" style="margin-top:8px">Open <b>assets/config.js</b> and set your Supabase URL and anon key, '
      + 'then reload. See the README for the full setup.</p></div></div>';
    return;
  }
  bindAuth();
  db.auth.getSession().then(function (res) {
    if (res.data.session) enterApp(res.data.session.user);
    else showAuth();
  });
  db.auth.onAuthStateChange(function (_evt, session) {
    if (!session) showAuth();
  });
});

// ---------------------------------------------------------------- auth
function showAuth() {
  document.getElementById("authScreen").style.display = "flex";
  document.getElementById("app").style.display = "none";
  document.getElementById("hbar").style.display = "none";
}
function switchTab(which) {
  document.querySelectorAll(".auth-tab").forEach(function (t) { t.classList.remove("active"); });
  document.querySelectorAll(".auth-panel").forEach(function (p) { p.classList.remove("active"); });
  document.getElementById("tab-" + which + "-btn").classList.add("active");
  document.getElementById("tab-" + which).classList.add("active");
}
function alertBox(id, msg, type) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || "";
  el.className = "alert " + (type || "err") + (msg ? " show" : "");
}
function bindAuth() {
  var lp = document.getElementById("login-pass");
  if (lp) lp.addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
}
function doLogin() {
  var email = document.getElementById("login-email").value.trim().toLowerCase();
  var pass = document.getElementById("login-pass").value;
  if (!email || !pass) { alertBox("login-err", "Enter your email and password."); return; }
  showLoader("Signing in...");
  db.auth.signInWithPassword({ email: email, password: pass }).then(function (res) {
    hideLoader();
    if (res.error) { alertBox("login-err", res.error.message); return; }
    enterApp(res.data.user);
  });
}
function doSignup() {
  var name = document.getElementById("signup-name").value.trim();
  var email = document.getElementById("signup-email").value.trim().toLowerCase();
  var pass = document.getElementById("signup-pass").value;
  if (!name || !email || pass.length < 8) { alertBox("signup-err", "Name, email and an 8+ character password are required."); return; }
  showLoader("Creating your account...");
  db.auth.signUp({
    email: email, password: pass,
    options: { data: { full_name: name }, emailRedirectTo: window.location.origin + window.location.pathname }
  }).then(function (res) {
    hideLoader();
    if (res.error) { alertBox("signup-err", res.error.message); return; }
    alertBox("signup-ok", "Account created. Check your email to verify, then sign in.", "ok");
  });
}
function doForgot() {
  var email = document.getElementById("login-email").value.trim().toLowerCase();
  if (!email) { alertBox("login-err", "Enter your email above first, then click reset."); return; }
  db.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname }).then(function () {
    alertBox("login-ok", "If that email exists, a reset link is on its way.", "ok");
  });
}
function doSignout() { db.auth.signOut().then(function () { location.reload(); }); }

// ---------------------------------------------------------------- enter app
function enterApp(user) {
  ADMIN.user = user;
  document.getElementById("authScreen").style.display = "none";
  document.getElementById("app").style.display = "flex";
  document.getElementById("hbar").style.display = "flex";
  var name = (user.user_metadata && user.user_metadata.full_name) || user.email;
  document.getElementById("hbarName").textContent = name;
  document.getElementById("hbarAv").textContent = initials(name);
  // make sure an admins row exists for this user (upsert is allowed by RLS)
  db.from("admins").upsert({ id: user.id, full_name: name, email: user.email }, { onConflict: "id" }).then(function () {});
  ADMIN.view = "dashboard";
  loadDashboard();
}

// ---------------------------------------------------------------- logging
function logActivity(action, targetId, metadata) {
  db.from("admin_activity_log").insert({
    admin_id: ADMIN.user.id, action: action, target_id: targetId || null, metadata: metadata || null
  }).then(function () {});
}

// ---------------------------------------------------------------- shell + nav
var NAV = [
  { grp: "Overview" },
  { k: "dashboard", ic: "▦", label: "Dashboard" },
  { k: "instances", ic: "◷", label: "Instances" },
  { grp: "Manage" },
  { k: "new", ic: "＋", label: "New assessment" },
  { grp: "Account" },
  { k: "settings", ic: "⚙", label: "Settings" }
];
function shell(content) {
  var rail = '<div class="rail">';
  NAV.forEach(function (n) {
    if (n.grp) { rail += '<div class="grp">' + n.grp + '</div>'; return; }
    var active = (ADMIN.view === n.k) ? " active" : "";
    rail += '<button class="nav-item' + active + '" onclick="go(\'' + n.k + '\')">'
      + '<span class="ic">' + n.ic + '</span>' + n.label + '</button>';
  });
  rail += '</div>';
  document.getElementById("app").innerHTML = rail + '<div class="main">' + content + '</div>';
}
function go(view, assessmentId) {
  ADMIN.view = view;
  ADMIN.assessmentId = assessmentId || null;
  window.scrollTo(0, 0);
  if (view === "dashboard") loadDashboard();
  else if (view === "new") newForm();
  else if (view === "edit") loadEdit(assessmentId);
  else if (view === "detail") loadDetail(assessmentId);
  else if (view === "questions") loadQuestions(assessmentId);
  else if (view === "images") loadImages(assessmentId);
  else if (view === "results") loadResults(assessmentId);
  else if (view === "instances") loadInstances();
  else if (view === "instance") loadInstance(assessmentId);
  else if (view === "settings") shell(settingsView());
}

// load the admin's instances into the cache, then run cb
function withInstances(cb) {
  db.from("active_instances").select("*").order("created_at", { ascending: false }).then(function (r) {
    CACHE.instances = r.data || [];
    cb();
  });
}
function newForm() { withInstances(function () { shell(formView(null)); catHint(); }); }

// ---------------------------------------------------------------- dashboard
function loadDashboard() {
  shell('<div class="main" style="padding:0"></div>');
  showLoader();
  Promise.all([
    db.from("active_assessments").select("*").order("created_at", { ascending: false }),
    db.from("active_questions").select("assessment_id"),
    db.from("respondents").select("assessment_id,is_completed,score_percent")
  ]).then(function (r) {
    hideLoader();
    if (r[0].error) { shell(errCard(r[0].error)); return; }
    CACHE.assessments = r[0].data || [];
    CACHE.qCounts = {}; (r[1].data || []).forEach(function (q) { CACHE.qCounts[q.assessment_id] = (CACHE.qCounts[q.assessment_id] || 0) + 1; });
    CACHE.rCounts = {}; var sums = {}, ns = {};
    (r[2].data || []).forEach(function (x) {
      CACHE.rCounts[x.assessment_id] = (CACHE.rCounts[x.assessment_id] || 0) + 1;
      if (x.is_completed && x.score_percent != null) {
        sums[x.assessment_id] = (sums[x.assessment_id] || 0) + Number(x.score_percent);
        ns[x.assessment_id] = (ns[x.assessment_id] || 0) + 1;
      }
    });
    CACHE.rAvg = {}; Object.keys(sums).forEach(function (id) { CACHE.rAvg[id] = (sums[id] / ns[id]); });
    renderDashboard();
  });
}
function renderDashboard() {
  var list = CACHE.assessments;
  var totalResp = Object.values(CACHE.rCounts).reduce(function (a, b) { return a + b; }, 0);
  var active = list.filter(function (a) { return a.is_active; }).length;
  var avgAll = (function () {
    var vals = Object.values(CACHE.rAvg); if (!vals.length) return "—";
    return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length) + "%";
  })();

  var tiles = '<div class="tiles grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">'
    + tile(list.length, "Assessments") + tile(active, "Active now")
    + tile(totalResp, "Total respondents") + tile(avgAll, "Average score") + '</div>';

  var rows;
  if (!list.length) {
    rows = '<div class="card pad" style="text-align:center;padding:48px">'
      + '<div style="font-size:38px">▦</div><h3 style="margin:10px 0 4px">No assessments yet</h3>'
      + '<p class="muted">Create an instance, then add assessments to it.</p>'
      + '<button class="btn" style="margin-top:14px" onclick="go(\'instances\')">Go to instances</button></div>';
  } else {
    var trs = list.map(function (a) {
      var qc = CACHE.qCounts[a.id] || 0, rc = CACHE.rCounts[a.id] || 0;
      var status = a.is_active ? '<span class="pill live">Active</span>' : '<span class="pill closed">Inactive</span>';
      var sched = schedulePill(a);
      var lim = a.max_respondents == null ? "∞" : (rc + " / " + a.max_respondents);
      var typeTag = isWpcaRow(a)
        ? '<span class="tag" style="color:var(--blue-d);border-color:var(--blue)">WPCAS</span>'
        : '<span class="tag">' + escHtml(catLabel(typeToCat(a)).split(" ")[0]) + '</span>';
      return '<tr>'
        + '<td><b style="cursor:pointer" onclick="go(\'detail\',\'' + a.id + '\')">' + escHtml(a.title) + '</b>'
        + '<div class="muted small">' + typeTag + ' · v' + a.version + ' · created ' + new Date(a.created_at).toLocaleDateString() + '</div></td>'
        + '<td class="tnum">' + qc + '</td>'
        + '<td class="tnum">' + lim + '</td>'
        + '<td>' + status + ' ' + sched + '</td>'
        + '<td><div class="flex g8 wrap">'
        + '<button class="btn ghost sm" onclick="go(\'questions\',\'' + a.id + '\')">Questions</button>'
        + '<button class="btn ghost sm" onclick="go(\'results\',\'' + a.id + '\')">Results</button>'
        + (isWpcaRow(a) ? "" : '<button class="btn ghost sm" onclick="copyLink(\'' + a.id + '\')">Copy link</button>')
        + '<button class="btn ' + (a.is_active ? "ghost" : "green") + ' sm" onclick="toggleActive(\'' + a.id + '\',' + (!a.is_active) + ')">' + (a.is_active ? "Deactivate" : "Activate") + '</button>'
        + '<button class="btn danger sm" onclick="confirmDelete(\'' + a.id + '\',\'' + escAttr(a.title) + '\')">Delete</button>'
        + '</div></td></tr>';
    }).join("");
    rows = '<div class="card"><table><thead><tr><th>Assessment</th><th>Questions</th><th>Respondents</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
  }

  shell('<div class="page-head"><div><div class="crumb">Console</div><h1>Assessment Library</h1></div>'
    + '<button class="btn" onclick="go(\'new\')">＋ New assessment</button></div>'
    + tiles + rows);
}

// small pill describing where "now" sits in the activate/deactivate window
function schedulePill(a) {
  var now = Date.now();
  var act = a.activate_at ? new Date(a.activate_at).getTime() : null;
  var deact = a.deactivate_at ? new Date(a.deactivate_at).getTime() : null;
  if (act && now < act) return '<span class="pill sched">Opens ' + fmtDate(a.activate_at) + '</span>';
  if (deact && now > deact) return '<span class="pill closed">Closed</span>';
  if (act || deact) return '<span class="pill win">In window</span>';
  return "";
}

// ---------------------------------------------------------------- create / edit
function loadEdit(id) {
  showLoader();
  db.from("active_assessments").select("*").eq("id", id).single().then(function (r) {
    hideLoader();
    if (r.error) { shell(errCard(r.error)); return; }
    withInstances(function () { shell(formView(r.data)); catHint(); });
  });
}
function formView(a) {
  a = a || {};
  var isEdit = !!a.id;
  function v(x, d) { return a[x] == null ? (d == null ? "" : d) : a[x]; }
  function dt(x) { return a[x] ? String(a[x]).slice(0, 16) : ""; }
  var dm1 = (v("display_mode", "one_at_a_time") === "one_at_a_time") ? "selected" : "";
  var dm2 = (v("display_mode") === "all_on_page") ? "selected" : "";
  var curCat = isEdit ? typeToCat(a) : "baseline";
  var curInst = v("instance_id", ADMIN.presetInstance || "");
  ADMIN.presetInstance = null;   // consume the preset so the rail's "New" starts clean
  var catOpts = CATS.map(function (c) { return '<option value="' + c[0] + '"' + (curCat === c[0] ? " selected" : "") + '>' + c[1] + '</option>'; }).join("");
  var instOpts = '<option value="">Standalone (no instance)</option>'
    + (CACHE.instances || []).map(function (i) { return '<option value="' + i.id + '"' + (curInst === i.id ? " selected" : "") + '>' + escHtml(i.name) + '</option>'; }).join("");

  return '<div class="crumb">' + (isEdit ? "Edit assessment" : "New assessment") + '</div>'
    + '<div class="page-head"><h1>' + (isEdit ? "Edit assessment" : "New assessment") + '</h1></div>'
    + '<div class="card pad" style="max-width:680px">'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Assessment category</label><select class="input" id="f-cat" onchange="catHint()">' + catOpts + '</select>'
    + '<div class="muted small" id="cathint" style="margin-top:4px"></div></div>'
    + '<div class="field"><label class="label">Instance / cycle</label><select class="input" id="f-instance">' + instOpts + '</select></div>'
    + '</div>'
    + '<div class="field"><label class="label">Title</label><input class="input" id="f-title" value="' + escAttr(v("title")) + '" placeholder="e.g. Data Capacity — Baseline"></div>'
    + '<div class="field"><label class="label">Intro text (shown before respondents start)</label><textarea class="input" id="f-intro" placeholder="Explain the purpose, rules and time needed.">' + escHtml(v("intro_text")) + '</textarea></div>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Opens (activate at)</label><input class="input" id="f-activate" type="datetime-local" value="' + dt("activate_at") + '"><div class="muted small" style="margin-top:4px">Leave blank for no start bound.</div></div>'
    + '<div class="field"><label class="label">Closes (deactivate at)</label><input class="input" id="f-deactivate" type="datetime-local" value="' + dt("deactivate_at") + '"><div class="muted small" style="margin-top:4px">Leave blank for no end bound.</div></div>'
    + '</div>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Time limit (minutes, optional)</label><input class="input" id="f-time" type="number" min="1" value="' + escAttr(v("time_limit_minutes")) + '" placeholder="No limit"></div>'
    + '<div class="field"><label class="label">Passing score % (optional)</label><input class="input" id="f-pass" type="number" min="0" max="100" value="' + escAttr(v("passing_score_percent")) + '" placeholder="No pass mark"></div>'
    + '</div>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Respondent limit (optional)</label><input class="input" id="f-max" type="number" min="1" value="' + escAttr(v("max_respondents")) + '" placeholder="Unlimited"><div class="muted small" style="margin-top:4px">Link closes automatically once this many people start.</div></div>'
    + '<div class="field"><label class="label">Display mode</label><select class="input" id="f-mode"><option value="one_at_a_time" ' + dm1 + '>One question at a time</option><option value="all_on_page" ' + dm2 + '>All on one page</option></select></div>'
    + '</div>'
    + '<div class="switch"><input type="checkbox" id="f-shuffle" ' + (v("shuffle_questions") ? "checked" : "") + '><label for="f-shuffle">Shuffle question order for each respondent</label></div>'
    + '<div class="switch"><input type="checkbox" id="f-showres" ' + (v("show_results_immediately", true) ? "checked" : "") + '><label for="f-showres">Show results to respondents immediately after submitting</label></div>'
    + '<div class="switch"><input type="checkbox" id="f-active" ' + (v("is_active", isEdit ? a.is_active : true) ? "checked" : "") + '><label for="f-active">Active (master switch — the assessment is open only when active, inside its window, and its instance is live)</label></div>'
    + '<div class="flex g12" style="margin-top:18px"><button class="btn ghost" onclick="go(\'dashboard\')">Cancel</button>'
    + '<button class="btn" onclick="saveAssessment(' + (isEdit ? '\'' + a.id + '\'' : "null") + ')">' + (isEdit ? "Save changes" : "Create assessment") + '</button></div>'
    + '</div>';
}
// describe the chosen category beneath the dropdown
function catHint() {
  var el = document.getElementById("cathint");
  var cat = document.getElementById("f-cat");
  if (!el || !cat) return;
  el.textContent = cat.value === "wpca"
    ? "WPCAS: a 360 instrument. Upload statements; each is answered Yes / No. Reviewers are finalised per subject."
    : "Objective: auto-scored MCQ / multi / true-false items. You can attach an image to any question.";
}
function readForm() {
  function num(id) { var x = document.getElementById(id).value; return x === "" ? null : Number(x); }
  function dtv(id) { var x = document.getElementById(id).value; return x ? x : null; }
  var cat = document.getElementById("f-cat").value;
  var mapped = catToType(cat);
  return {
    title: document.getElementById("f-title").value.trim(),
    intro_text: document.getElementById("f-intro").value.trim(),
    assessment_type: mapped.assessment_type,
    stage: mapped.stage,
    instance_id: document.getElementById("f-instance").value || null,
    activate_at: dtv("f-activate"),
    deactivate_at: dtv("f-deactivate"),
    time_limit_minutes: num("f-time"),
    passing_score_percent: num("f-pass"),
    max_respondents: num("f-max"),
    display_mode: document.getElementById("f-mode").value,
    shuffle_questions: document.getElementById("f-shuffle").checked,
    show_results_immediately: document.getElementById("f-showres").checked,
    is_active: document.getElementById("f-active").checked
  };
}
function saveAssessment(id) {
  var form = readForm();
  if (!form.title) { toast("Title is required", "err"); return; }
  if (!form.intro_text) { toast("Intro text is required", "err"); return; }
  if (form.activate_at && form.deactivate_at && new Date(form.activate_at) >= new Date(form.deactivate_at)) {
    toast("The close time must be after the open time", "err"); return;
  }
  showLoader(id ? "Saving changes..." : "Creating assessment...");
  if (id) {
    db.from("assessments").update(form).eq("id", id).then(function (r) {
      hideLoader();
      if (r.error) { toast(friendlyError(r.error), "err"); return; }
      logActivity("updated_assessment", id, { title: form.title });
      toast("Saved", "ok"); go("detail", id);
    });
  } else {
    form.admin_id = ADMIN.user.id;
    form.access_key = genKey();
    db.from("assessments").insert(form).select().single().then(function (r) {
      hideLoader();
      if (r.error) { toast(friendlyError(r.error), "err"); return; }
      logActivity("created_assessment", r.data.id, { title: form.title });
      toast("Assessment created — now add questions", "ok");
      go("questions", r.data.id);
    });
  }
}

// ---------------------------------------------------------------- detail
function loadDetail(id) {
  showLoader();
  Promise.all([
    db.from("active_assessments").select("*").eq("id", id).single(),
    db.from("active_questions").select("id", { count: "exact", head: true }).eq("assessment_id", id),
    db.from("respondents").select("id", { count: "exact", head: true }).eq("assessment_id", id),
    db.from("admin_activity_log").select("*").eq("target_id", id).order("performed_at", { ascending: false }).limit(20)
  ]).then(function (r) {
    hideLoader();
    if (r[0].error) { shell(errCard(r[0].error)); return; }
    var a = r[0].data, qc = r[1].count || 0, rc = r[2].count || 0, log = r[3].data || [];
    var wpca = isWpcaRow(a);
    var steps = ["Created", "Questions added", "Scheduled", "Active", "Results"];
    var hasWindow = !!(a.activate_at || a.deactivate_at);
    var current = !qc ? 1 : (!hasWindow ? 2 : (!a.is_active ? 3 : (rc ? 4 : 3)));
    var stepper = '<div class="stepper">';
    steps.forEach(function (s, i) {
      var cls = i < current ? "done" : (i === current ? "active" : "");
      stepper += '<div class="step ' + cls + '"><span class="n">' + (i < current ? "✓" : i + 1) + '</span>' + s + '</div>' + (i < steps.length - 1 ? '<span class="arrow">→</span>' : "");
    });
    stepper += '</div>';
    var lim = a.max_respondents == null ? "Unlimited" : (rc + " of " + a.max_respondents + " used");
    var actions = log.length ? log.map(function (l) {
      return '<div class="flex ac g12" style="padding:9px 0;border-bottom:1px solid var(--n100)">'
        + '<div style="width:8px;height:8px;border-radius:50%;background:var(--blue)"></div>'
        + '<div style="flex:1"><div>' + escHtml(l.action.replace(/_/g, " ")) + (l.metadata && l.metadata.title ? ' — ' + escHtml(l.metadata.title) : "") + '</div>'
        + '<div class="muted small">' + fmtDate(l.performed_at) + '</div></div></div>';
    }).join("") : '<p class="muted small">No activity recorded yet.</p>';

    var keyRow = wpca
      ? kv("Access", '<span class="muted small">Reviewers get their own keys once you finalise panels.</span>')
      : kv("Access key", '<b style="font-family:ui-monospace,monospace;letter-spacing:1px">' + escHtml(a.access_key || "—") + '</b>'
          + ' <button class="btn ghost sm" style="margin-left:8px" onclick="copyKey(\'' + escAttr(a.access_key || "") + '\')">Copy key link</button>');

    shell('<div class="crumb"><a href="#" onclick="go(\'dashboard\');return false">Library</a> / ' + escHtml(a.title) + '</div>'
      + '<div class="page-head"><h1>' + escHtml(a.title) + '</h1>'
      + '<div class="flex g8 wrap"><button class="btn ghost" onclick="go(\'edit\',\'' + a.id + '\')">Edit settings</button>'
      + (wpca ? "" : '<button class="btn ghost" onclick="copyLink(\'' + a.id + '\')">Copy link</button>')
      + '<button class="btn ' + (a.is_active ? "ghost" : "green") + '" onclick="toggleActive(\'' + a.id + '\',' + (!a.is_active) + ')">' + (a.is_active ? "Deactivate" : "Activate") + '</button></div></div>'
      + stepper
      + '<div class="grid" style="grid-template-columns:1.3fr 1fr">'
      + '<div class="card pad"><h3 style="margin-bottom:12px">Overview</h3>'
      + kv("Category", wpca ? '<span class="tag" style="color:var(--blue-d);border-color:var(--blue)">WPCAS (360)</span>' : escHtml(catLabel(typeToCat(a))))
      + kv("Status", a.is_active ? '<span class="pill live">Active</span>' : '<span class="pill closed">Inactive</span>')
      + keyRow
      + kv("Opens", a.activate_at ? fmtDate(a.activate_at) : "No start bound")
      + kv("Closes", a.deactivate_at ? fmtDate(a.deactivate_at) : "No end bound")
      + kv("Version", "v" + a.version) + kv("Questions", qc) + kv(wpca ? "Reviews received" : "Respondents", rc)
      + kv("Respondent limit", lim)
      + kv("Time limit", a.time_limit_minutes ? a.time_limit_minutes + " min" : "None")
      + kv("Passing score", a.passing_score_percent != null ? a.passing_score_percent + "%" : "None")
      + kv("Shuffle", a.shuffle_questions ? "On" : "Off")
      + kv("Show results", a.show_results_immediately ? "Immediately" : "Hidden")
      + '<div class="flex g8 wrap" style="margin-top:14px"><button class="btn ghost sm" onclick="go(\'questions\',\'' + a.id + '\')">Manage questions</button>'
      + (wpca ? "" : '<button class="btn ghost sm" onclick="go(\'images\',\'' + a.id + '\')">Question images</button>')
      + '<button class="btn ghost sm" onclick="go(\'results\',\'' + a.id + '\')">View results</button>'
      + '<button class="btn danger sm" onclick="confirmDelete(\'' + a.id + '\',\'' + escAttr(a.title) + '\')">Delete</button></div></div>'
      + '<div class="card pad"><h3 style="margin-bottom:12px">Activity log</h3>' + actions + '</div>'
      + '</div>');
  });
}

// ---------------------------------------------------------------- question upload
function loadQuestions(id) {
  ADMIN.assessmentId = id;
  UPLOAD = { step: 0, fileName: "", questions: [], valid: [] };
  showLoader();
  db.from("active_assessments").select("*").eq("id", id).single().then(function (r) {
    hideLoader();
    if (r.error) { shell(errCard(r.error)); return; }
    ADMIN._assessment = r.data;
    renderUpload();
  });
}
function renderUpload() {
  var a = ADMIN._assessment;
  var isW = isWpcaRow(a);
  var steps = ["Upload Excel", "Validate & fix", "Preview", "Import"];
  var stepper = '<div class="stepper">';
  steps.forEach(function (s, i) {
    var cls = UPLOAD.step === i ? "active" : UPLOAD.step > i ? "done" : "";
    stepper += '<div class="step ' + cls + '"><span class="n">' + (UPLOAD.step > i ? "✓" : i + 1) + '</span>' + s + '</div>' + (i < 3 ? '<span class="arrow">→</span>' : "");
  });
  stepper += '</div>';
  var body;
  if (UPLOAD.step === 0) {
    var cols = isW
      ? "q_stem · q_competency · marks   (each statement is answered Yes / No)"
      : "no · q_type · q_level · q_competency · q_facet · q_stem · image_url · opt1-5 · isopt1-5correct · marks";
    body = '<div class="card pad">'
      + '<div class="flex jb ac wrap" style="margin-bottom:14px"><h3>Upload ' + (isW ? "WPCAS statements" : "question") + ' file (.xlsx)</h3>'
      + '<span class="tag">Columns: ' + cols + '</span></div>'
      + '<div class="dz" id="dz"><div style="font-size:34px">⤓</div>'
      + '<div style="font-weight:600;margin-top:6px">Drop your .xlsx here, or click to choose a file</div>'
      + '<div class="muted small">' + (isW ? "Each row is one Yes/No statement. Options are fixed to Yes / No. marks is what a \"Yes\" earns." : "q_type must be mcqsca, mcqmca or tf. image_url is optional. marks default to 0 if left blank.") + '</div></div>'
      + '<input type="file" id="fileInput" accept=".xlsx,.xls" style="display:none">'
      + '<div class="muted small" style="margin-top:10px;cursor:pointer;color:var(--blue)" onclick="downloadTemplate()">↓ Download Excel template</div></div>';
  } else if (UPLOAD.step === 1) body = validationView();
  else if (UPLOAD.step === 2) body = previewView();
  else body = importView();
  shell('<div class="crumb"><a href="#" onclick="go(\'detail\',\'' + a.id + '\');return false">' + escHtml(a.title) + '</a> / Questions</div>'
    + '<div class="page-head"><h1>Questions — ' + escHtml(a.title) + '</h1></div>' + stepper + body);
  if (UPLOAD.step === 0) wireDropzone();
}
function wireDropzone() {
  var dz = document.getElementById("dz"), input = document.getElementById("fileInput");
  if (!dz) return;
  dz.onclick = function () { input.click(); };
  input.onchange = function (e) { if (e.target.files[0]) handleFile(e.target.files[0]); };
  dz.ondragover = function (e) { e.preventDefault(); dz.classList.add("drag"); };
  dz.ondragleave = function () { dz.classList.remove("drag"); };
  dz.ondrop = function (e) { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); };
}
function handleFile(file) {
  UPLOAD.fileName = file.name;
  showLoader("Reading questions...");
  var reader = new FileReader();
  reader.onload = function (ev) {
    var res = readWorkbook(new Uint8Array(ev.target.result));
    hideLoader();
    if (res.error) { toast(res.error, "err"); return; }
    if (!res.questions.length) { toast("No rows found in the spreadsheet", "err"); return; }
    UPLOAD.questions = res.questions;
    var isW = isWpcaRow(ADMIN._assessment);
    UPLOAD.valid = res.questions.map(function (q) { return validateQuestion(q, isW); });
    UPLOAD._rawFile = file;
    UPLOAD.step = 1;
    var bad = UPLOAD.valid.filter(function (v) { return v.level === "err"; }).length;
    var warn = UPLOAD.valid.filter(function (v) { return v.level === "warn"; }).length;
    toast("Parsed " + res.questions.length + " questions" + (bad ? " — " + bad + " need fixing" : warn ? " — " + warn + " to check" : ""), bad ? "err" : "ok");
    renderUpload();
  };
  reader.readAsArrayBuffer(file);
}
function validationView() {
  var isW = isWpcaRow(ADMIN._assessment);
  var bad = UPLOAD.valid.filter(function (v) { return v.level === "err"; }).length;
  var warn = UPLOAD.valid.filter(function (v) { return v.level === "warn"; }).length;
  var clean = UPLOAD.valid.length - bad - warn;
  var banner = bad
    ? '<span class="badge err" style="font-size:13px;padding:6px 12px">!</span><div><b>' + bad + ' question(s) must be fixed</b> <span class="muted">before importing. ' + clean + ' clean, ' + warn + ' to check.</span></div>'
    : warn
      ? '<span class="badge warn" style="font-size:13px;padding:6px 12px">⚠</span><div><b>' + clean + ' of ' + UPLOAD.valid.length + ' parsed cleanly.</b> <span class="muted">' + warn + ' to double-check, none blocking.</span></div>'
      : '<span class="badge ok" style="font-size:13px;padding:6px 12px">✓</span><div><b>All ' + UPLOAD.valid.length + ' questions parsed cleanly.</b></div>';
  var rows = UPLOAD.questions.map(function (q, i) {
    var val = UPLOAD.valid[i];
    var badge = val.level === "err" ? '<span class="badge err">! ' + escHtml(val.msg) + '</span>'
      : val.level === "warn" ? '<span class="badge warn">⚠ ' + escHtml(val.msg) + '</span>'
        : '<span class="badge ok">✓ Valid</span>';
    var nopts = isW ? 2 : [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5].filter(function (o) { return o; }).length;
    var typeShown = isW ? "yesno" : (q.q_type || "?");
    var hasImg = q.image_url ? ' <span class="tag">img</span>' : "";
    return '<tr><td class="tnum">' + escHtml(q.no || (i + 1)) + '</td><td><span class="tag">' + escHtml(typeShown) + '</span></td>'
      + '<td style="max-width:320px">' + escHtml(q.q_stem || "(empty)") + hasImg + '</td><td class="tnum">' + nopts + '</td><td class="tnum">' + escHtml(q.marks != null ? q.marks : 0) + '</td><td>' + badge + '</td></tr>';
  }).join("");
  return '<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12">' + banner + '</div></div>'
    + '<div class="card"><table><thead><tr><th>#</th><th>Type</th><th>Question text</th><th>Options</th><th>Marks</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="flex g12" style="margin-top:16px;justify-content:flex-end">'
    + '<button class="btn ghost" onclick="UPLOAD.step=0;renderUpload()">← Re-upload</button>'
    + '<button class="btn" ' + (bad ? "disabled title='Fix the blocking errors first'" : "") + ' onclick="UPLOAD.step=2;renderUpload()">Continue to preview →</button></div>';
}
function previewView() {
  var cards = UPLOAD.questions.slice(0, 4).map(function (q) {
    return '<div class="card pad" style="margin-bottom:14px"><div class="flex jb"><span class="tag">' + escHtml(isWpcaRow(ADMIN._assessment) ? "yesno" : q.q_type) + '</span>'
      + (q.q_competency ? '<span class="muted small">' + escHtml(q.q_competency) + '</span>' : "") + '</div>'
      + '<p style="font-weight:600;margin:10px 0 12px">' + escHtml(q.q_stem) + '</p>' + previewControls(q) + '</div>';
  }).join("");
  return '<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12"><span class="badge info">i</span>'
    + '<div>This is how respondents will see each question. Showing the first few of ' + UPLOAD.questions.length + '.</div></div></div>'
    + cards + '<div class="flex g12" style="margin-top:16px;justify-content:flex-end">'
    + '<button class="btn ghost" onclick="UPLOAD.step=1;renderUpload()">← Back</button>'
    + '<button class="btn" onclick="UPLOAD.step=3;renderUpload()">Continue to import →</button></div>';
}
function previewControls(q) {
  var isW = isWpcaRow(ADMIN._assessment);
  if (isW || q.q_type === "yesno") {
    return '<div class="yesno" style="pointer-events:none;opacity:.9"><button>Yes</button><button>No</button></div>'
      + '<div class="muted small" style="margin-top:6px">Yes/No item · "Yes" earns ' + escHtml(q.marks != null ? q.marks : 0) + ' mark(s)</div>';
  }
  var opts = [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5].filter(function (o) { return o; });
  if (q.q_type === "tf") opts = ["True", "False"];
  var sq = q.q_type === "mcqmca";
  var img = q.image_url ? '<div class="muted small" style="margin:6px 0">🖼 image attached</div>' : "";
  return img + '<div style="pointer-events:none;opacity:.9">' + opts.map(function (o) {
    return '<div class="opt"><span class="rd' + (sq ? " sq" : "") + '"></span>' + escHtml(o) + '</div>';
  }).join("") + '</div>'
    + '<div class="muted small" style="margin-top:6px">Marks: ' + escHtml(q.marks != null ? q.marks : 0) + '</div>';
}
function importView() {
  var a = ADMIN._assessment;
  var n = UPLOAD.questions.length;
  return '<div class="card pad" style="max-width:560px"><h3 style="margin-bottom:14px">Import questions</h3>'
    + kv("Assessment", escHtml(a.title)) + kv("Questions to import", n)
    + kv("New version", "v" + (a.version + 1)) + kv("Source file", escHtml(UPLOAD.fileName))
    + '<p class="muted small" style="margin:12px 0">Importing soft-deletes the previous question set, bumps the version, '
    + 'and keeps the original file in storage. Past respondents keep the version they saw.</p>'
    + '<div class="flex g12"><button class="btn ghost" onclick="UPLOAD.step=2;renderUpload()">← Back</button>'
    + '<button class="btn" onclick="doImport()">Import ' + n + ' questions</button></div></div>';
}
function doImport() {
  var a = ADMIN._assessment, id = a.id;
  // for a WPCAS assessment, blank/other types become Yes/No items (the server
  // also coerces this, but setting it here keeps the preview honest)
  if (isWpcaRow(a)) {
    UPLOAD.questions.forEach(function (q) { q.q_type = "yesno"; });
  }
  showLoader("Importing questions...");
  db.rpc("replace_questions", { p_assessment_id: id, p_questions: UPLOAD.questions }).then(function (r) {
    if (r.error) { hideLoader(); toast(friendlyError(r.error), "err"); return; }
    var count = r.data;
    var newVersion = a.version + 1;
    logActivity("uploaded_questions", id, { count: count, version: newVersion, file: UPLOAD.fileName });
    // store the original file (best effort; the import already succeeded)
    if (UPLOAD._rawFile) {
      var path = ADMIN.user.id + "/" + id + "/v" + newVersion + "/" + UPLOAD.fileName;
      db.storage.from("assessment-files").upload(path, UPLOAD._rawFile, { upsert: true }).then(function (up) {
        if (!up.error) db.from("uploaded_files").insert({ assessment_id: id, admin_id: ADMIN.user.id, file_name: UPLOAD.fileName, storage_path: path }).then(function () {});
        hideLoader();
        toast("Imported " + count + " questions (v" + newVersion + ")", "ok");
        if (isWpcaRow(a)) go("detail", id); else go("images", id);
      });
    } else {
      hideLoader();
      toast("Imported " + count + " questions", "ok");
      if (isWpcaRow(a)) go("detail", id); else go("images", id);
    }
  });
}
function downloadTemplate() {
  var isW = isWpcaRow(ADMIN._assessment);
  var headers, sample;
  if (isW) {
    headers = ["q_stem", "q_competency", "marks"];
    sample = [
      ["Shares information openly with the team.", "Collaboration", 1],
      ["Explains complex ideas clearly.", "Communication", 1]
    ];
  } else {
    headers = ["no", "q_type", "q_level", "q_competency", "q_facet", "q_stem", "image_url", "opt1", "opt2", "opt3", "opt4", "opt5", "isopt1correct", "isopt2correct", "isopt3correct", "isopt4correct", "isopt5correct", "marks"];
    sample = [
      [1, "mcqsca", "basic", "Data", "Central tendency", "Which measure is most robust to outliers?", "", "Mean", "Median", "Mode", "Range", "", false, true, false, false, false, 1],
      [2, "tf", "basic", "Stats", "p-values", "A p-value of 0.04 means a 96% chance the alternative is true.", "", "True", "False", "", "", "", false, true, false, false, false, 1],
      [3, "mcqmca", "intermediate", "Data", "Charts", "Which are good for showing distributions? (select all)", "", "Histogram", "Box plot", "Pie chart", "Scatter", "", true, true, false, false, false, 2]
    ];
  }
  var ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
  var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, isW ? "WPCAS items" : "Questions");
  XLSX.writeFile(wb, isW ? "cegis_wpcas_template.xlsx" : "cegis_question_template.xlsx");
}

// ---------------------------------------------------------------- question images
// Objective questions can carry an image. We upload the file to the PUBLIC
// question-images bucket (path: adminId/assessmentId/questionId_filename), then
// store its public URL on the question via set_question_image.
function loadImages(id) {
  ADMIN.assessmentId = id;
  showLoader();
  db.from("active_assessments").select("*").eq("id", id).single().then(function (r) {
    if (r.error) { hideLoader(); shell(errCard(r.error)); return; }
    ADMIN._assessment = r.data;
    if (isWpcaRow(r.data)) { hideLoader(); shell(errCard({ message: "WPCAS items do not use images." })); return; }
    db.from("active_questions").select("*").eq("assessment_id", id).eq("assessment_version", r.data.version).order("no", { ascending: true }).then(function (q) {
      hideLoader();
      if (q.error) { shell(errCard(q.error)); return; }
      ADMIN._imgQuestions = q.data || [];
      renderImages();
    });
  });
}
function renderImages() {
  var a = ADMIN._assessment, qs = ADMIN._imgQuestions;
  var rows = qs.length ? qs.map(function (q) {
    var thumb = q.image_url
      ? '<img src="' + escAttr(q.image_url) + '" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--n200)">'
      : '<span class="muted small">none</span>';
    return '<tr><td class="tnum">' + escHtml(q.no || "") + '</td>'
      + '<td style="max-width:360px">' + escHtml(q.q_stem) + '</td>'
      + '<td>' + thumb + '</td>'
      + '<td><div class="flex g8 wrap">'
      + '<button class="btn ghost sm" onclick="pickImage(\'' + q.id + '\')">' + (q.image_url ? "Replace" : "Add image") + '</button>'
      + (q.image_url ? '<button class="btn ghost sm" onclick="clearImage(\'' + q.id + '\')">Remove</button>' : "")
      + '</div></td></tr>';
  }).join("") : '<tr><td colspan="4" class="muted" style="padding:18px;text-align:center">No questions in the current version. Import questions first.</td></tr>';
  shell('<div class="crumb"><a href="#" onclick="go(\'detail\',\'' + a.id + '\');return false">' + escHtml(a.title) + '</a> / Images</div>'
    + '<div class="page-head"><h1>Question images — ' + escHtml(a.title) + '</h1></div>'
    + '<div class="card pad" style="margin-bottom:14px"><p class="muted small">Attach an image to any question. Images are stored in the public <b>question-images</b> bucket and shown to every taker alongside the question — they are not part of the secret answer key.</p></div>'
    + '<input type="file" id="imgInput" accept="image/*" style="display:none">'
    + '<div class="card"><table><thead><tr><th>#</th><th>Question</th><th>Image</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>');
  var inp = document.getElementById("imgInput");
  if (inp) inp.onchange = function (e) { if (e.target.files[0]) uploadImage(e.target.files[0]); };
}
function pickImage(qid) { ADMIN._imgTarget = qid; document.getElementById("imgInput").click(); }
function uploadImage(file) {
  var qid = ADMIN._imgTarget, a = ADMIN._assessment;
  if (!qid) return;
  var safe = file.name.replace(/[^a-z0-9._-]+/gi, "_");
  var path = ADMIN.user.id + "/" + a.id + "/" + qid + "_" + safe;
  showLoader("Uploading image...");
  db.storage.from("question-images").upload(path, file, { upsert: true }).then(function (up) {
    if (up.error) { hideLoader(); toast(friendlyError(up.error), "err"); return; }
    var pub = db.storage.from("question-images").getPublicUrl(path);
    var url = pub.data.publicUrl;
    db.rpc("set_question_image", { p_question_id: qid, p_image_url: url }).then(function (r) {
      hideLoader();
      if (r.error) { toast(friendlyError(r.error), "err"); return; }
      toast("Image saved", "ok");
      loadImages(a.id);
    });
  });
}
function clearImage(qid) {
  showLoader("Removing image...");
  db.rpc("set_question_image", { p_question_id: qid, p_image_url: null }).then(function (r) {
    hideLoader();
    if (r.error) { toast(friendlyError(r.error), "err"); return; }
    toast("Image removed", "ok");
    loadImages(ADMIN._assessment.id);
  });
}

// ---------------------------------------------------------------- results
function loadResults(id) {
  ADMIN.assessmentId = id;
  showLoader();
  Promise.all([
    db.from("active_assessments").select("*").eq("id", id).single(),
    db.from("respondents").select("*").eq("assessment_id", id).order("started_at", { ascending: false }),
    db.from("active_security_logs").select("respondent_id")
  ]).then(function (r) {
    hideLoader();
    if (r[0].error) { shell(errCard(r[0].error)); return; }
    ADMIN._assessment = r[0].data;
    ADMIN._respondents = r[1].data || [];
    CACHE.flagCounts = {};
    (r[2].data || []).forEach(function (s) { CACHE.flagCounts[s.respondent_id] = (CACHE.flagCounts[s.respondent_id] || 0) + 1; });
    renderResults();
  });
}
function renderResults() {
  var a = ADMIN._assessment, all = ADMIN._respondents;
  var wpca = isWpcaRow(a);
  var done = all.filter(function (x) { return x.is_completed; });
  if (!all.length) {
    shell(resultsHead(a) + '<div class="card pad" style="text-align:center;padding:48px">'
      + '<div style="font-size:38px">◔</div><h3 style="margin:10px 0 4px">No respondents yet</h3>'
      + '<p class="muted">' + (wpca ? "Finalise reviewer panels so reviews can be completed." : "Share the link to start collecting responses.") + '</p>'
      + (wpca ? "" : '<button class="btn ghost" style="margin-top:14px" onclick="copyLink(\'' + a.id + '\')">Copy link</button>') + '</div>');
    return;
  }
  var pcts = done.map(function (x) { return Number(x.score_percent || 0); });
  var avg = pcts.length ? Math.round(pcts.reduce(function (s, v) { return s + v; }, 0) / pcts.length) : 0;
  var hi = pcts.length ? Math.max.apply(null, pcts) : 0;
  var lo = pcts.length ? Math.min.apply(null, pcts) : 0;
  var passable = done.filter(function (x) { return x.is_passed != null; });
  var passed = passable.filter(function (x) { return x.is_passed; }).length;
  var passRate = passable.length ? Math.round((passed / passable.length) * 100) + "%" : "—";

  var tiles = '<div class="tiles grid" style="grid-template-columns:repeat(5,1fr);margin-bottom:18px">'
    + tile(all.length, wpca ? "Reviews" : "Respondents") + tile(done.length, "Completed")
    + tile(avg + "%", wpca ? "Avg % Yes" : "Average") + tile(passRate, "Pass rate") + tile(hi + "% / " + lo + "%", "High / low") + '</div>';

  var charts = '<div class="grid" style="grid-template-columns:1fr;margin-bottom:18px">'
    + '<div class="card pad"><h3 style="margin-bottom:10px">' + (wpca ? "% Yes distribution" : "Score distribution") + '</h3>' + histogram(pcts) + '</div></div>';

  var rows = all.map(function (x) {
    var flags = CACHE.flagCounts[x.id] || 0;
    var status = !x.is_completed ? '<span class="pill sched">In progress</span>'
      : x.is_passed === true ? '<span class="pill live">Passed</span>'
        : x.is_passed === false ? '<span class="badge err">Failed</span>'
          : '<span class="pill closed">Done</span>';
    return '<tr><td><b>' + escHtml(x.full_name) + '</b><div class="muted small">' + escHtml(x.email) + '</div></td>'
      + '<td>' + escHtml(x.organization || "—") + '</td>'
      + '<td class="tnum">' + (x.score_percent != null ? x.score_percent + "%" : "—") + '</td>'
      + '<td>' + status + '</td>'
      + '<td class="tnum">' + fmtDuration(x.time_taken_seconds) + '</td>'
      + '<td>' + (flags ? '<span class="badge warn">⚠ ' + flags + '</span>' : '<span class="muted small">0</span>') + '</td>'
      + '<td><button class="btn ghost sm" ' + (x.is_completed ? "" : "disabled") + ' onclick="respondentDetail(\'' + x.id + '\')">View</button></td></tr>';
  }).join("");
  var table = '<div class="card"><div class="pad flex jb ac" style="border-bottom:1px solid var(--n200)"><h3>' + (wpca ? "Reviews" : "Respondents") + '</h3>'
    + '<button class="btn ghost sm" onclick="exportResults()">⤓ Export to Excel</button></div>'
    + '<table><thead><tr><th>Name</th><th>Organisation</th><th>' + (wpca ? "% Yes" : "Score") + '</th><th>Status</th><th>Time</th><th>Flags</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';

  shell(resultsHead(a) + tiles + charts + table);
}
function resultsHead(a) {
  return '<div class="crumb"><a href="#" onclick="go(\'detail\',\'' + a.id + '\');return false">' + escHtml(a.title) + '</a> / Results</div>'
    + '<div class="page-head"><h1>Results — ' + escHtml(a.title) + '</h1>'
    + (isWpcaRow(a) ? "" : '<button class="btn ghost" onclick="copyLink(\'' + a.id + '\')">Copy link</button>') + '</div>';
}
function respondentDetail(rid) {
  showLoader();
  db.rpc("admin_respondent_detail", { p_respondent_id: rid }).then(function (r) {
    var secP = db.from("active_security_logs").select("event_type,logged_at").eq("respondent_id", rid).order("logged_at");
    secP.then(function (sec) {
      hideLoader();
      if (r.error) { toast(friendlyError(r.error), "err"); return; }
      var d = r.data;
      var bd = d.breakdown || [];
      var rows = bd.map(function (q) {
        var sel = (q.selected || []).join(", ") || "—";
        var key = (q.key || []).join(", ") || "—";
        var mark = q.is_correct ? '<span class="badge ok">✓</span>' : '<span class="badge err">✗</span>';
        return '<tr><td class="tnum">' + escHtml(q.no || "") + '</td><td style="max-width:260px">' + escHtml(q.q_stem) + '</td>'
          + '<td class="muted small">' + escHtml(q.q_competency || "—") + '</td>'
          + '<td class="tnum">' + sel + '</td><td class="tnum">' + key + '</td><td>' + mark + '</td></tr>';
      }).join("");
      var secRows = (sec.data || []).length
        ? (sec.data || []).map(function (s) { return '<div class="kv"><span>' + escHtml(s.event_type.replace(/_/g, " ")) + '</span><b>' + fmtDate(s.logged_at) + '</b></div>'; }).join("")
        : '<p class="muted small">No security events logged.</p>';
      showModal({
        title: d.full_name + " — breakdown",
        body: '<div class="muted small" style="margin-bottom:10px">' + escHtml(d.email) + ' · score <b>' + d.score_percent + '%</b> (' + d.score_raw + ' raw)' + (d.is_passed != null ? ' · ' + (d.is_passed ? "passed" : "failed") : "") + '</div>'
          + '<div style="max-height:300px;overflow:auto;border:1px solid var(--n200);border-radius:8px"><table><thead><tr><th>#</th><th>Question</th><th>Competency</th><th>Chose</th><th>Key</th><th>✓</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          + '<h3 style="font-size:13px;margin:16px 0 6px">Security events</h3>' + secRows,
        confirm: null
      });
    });
  });
}
function exportResults() {
  showLoader("Building Excel export...");
  var a = ADMIN._assessment, all = ADMIN._respondents;
  Promise.all([
    db.from("active_questions").select("*").eq("assessment_id", a.id).eq("assessment_version", a.version),
    db.from("responses").select("respondent_id,question_id,selected_options,is_correct")
  ]).then(function (r) {
    hideLoader();
    var questions = r[0].data || [];
    var responses = r[1].data || [];
    var respHeader = ["Name", "Email", "Organisation", "Department", "Employee ID", "Started", "Submitted", "Completed", "Time (s)", "Score raw", "Score %", "Passed", "Security flags"];
    var summaryRows = all.map(function (x) {
      return [x.full_name, x.email, x.organization || "", x.department || "", x.employee_id || "",
      x.started_at || "", x.submitted_at || "", x.is_completed ? "yes" : "no", x.time_taken_seconds || "",
      x.score_raw == null ? "" : x.score_raw, x.score_percent == null ? "" : x.score_percent,
      x.is_passed == null ? "" : (x.is_passed ? "yes" : "no"), CACHE.flagCounts[x.id] || 0];
    });
    var qById = {}; questions.forEach(function (q) { qById[q.id] = q; });
    var detailHeader = ["Respondent", "Email", "Q#", "Competency", "Facet", "Question", "Selected options", "Correct?"];
    var respById = {}; all.forEach(function (x) { respById[x.id] = x; });
    var detailRows = responses.map(function (resp) {
      var q = qById[resp.question_id], person = respById[resp.respondent_id];
      if (!q || !person) return null;
      return [person.full_name, person.email, q.no, q.q_competency || "", q.q_facet || "", q.q_stem,
      (resp.selected_options || []).join(", "), resp.is_correct ? "yes" : "no"];
    }).filter(Boolean);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([respHeader].concat(summaryRows)), "Summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([detailHeader].concat(detailRows)), "Responses");
    XLSX.writeFile(wb, "results_" + a.title.replace(/[^a-z0-9]+/gi, "_").toLowerCase() + ".xlsx");
    logActivity("exported_results", a.id, { count: all.length });
    toast("Export downloaded", "ok");
  });
}

// ---------------------------------------------------------------- actions
function toggleActive(id, next) {
  showLoader();
  db.from("assessments").update({ is_active: next }).eq("id", id).then(function (r) {
    hideLoader();
    if (r.error) { toast(friendlyError(r.error), "err"); return; }
    logActivity("toggled_active", id, { is_active: next });
    toast(next ? "Assessment activated" : "Assessment deactivated", "ok");
    if (ADMIN.view === "dashboard") loadDashboard(); else go("detail", id);
  });
}
function copyLink(id) {
  var url = window.location.origin + window.location.pathname.replace(/index\.html$/, "") + "take.html?a=" + id;
  navigator.clipboard.writeText(url).then(function () {
    logActivity("copied_link", id, null);
    toast("Public link copied", "ok");
  }).catch(function () { showModal({ title: "Public link", body: '<div class="link-box small" style="word-break:break-all">' + escHtml(url) + '</div>', confirm: null }); });
}
function confirmDelete(id, title) {
  showModal({
    title: "Delete this assessment?",
    body: "<b>" + escHtml(title) + "</b> and its questions will be hidden everywhere. Respondent data is always kept. This uses a soft delete, so nothing is wiped from the database.",
    confirm: "Delete", danger: true,
    onConfirm: function () {
      closeModal(); showLoader("Deleting...");
      db.rpc("soft_delete_assessment", { p_assessment_id: id }).then(function (r) {
        hideLoader();
        if (r.error) { toast(friendlyError(r.error), "err"); return; }
        logActivity("deleted_assessment", id, { title: title });
        toast("Assessment deleted", "ok"); go("dashboard");
      });
    }
  });
}

// ---------------------------------------------------------------- settings
function settingsView() {
  var u = ADMIN.user;
  var name = (u.user_metadata && u.user_metadata.full_name) || "—";
  return '<div class="page-head"><h1>Settings</h1></div>'
    + '<div class="grid" style="grid-template-columns:1fr 1fr">'
    + '<div class="card pad"><h3 style="margin-bottom:12px">Your account</h3>'
    + kv("Name", escHtml(name)) + kv("Email", escHtml(u.email))
    + '<button class="btn ghost sm" style="margin-top:12px" onclick="doSignout()">Sign out</button></div>'
    + '<div class="card pad"><h3 style="margin-bottom:12px">About this platform</h3>'
    + '<p class="muted small">Soft delete is enforced at the database level — a trigger blocks any hard DELETE, and respondent records are never removed. '
    + 'Scores are calculated inside the database so the browser never sends a score. See the README for the full setup.</p></div>'
    + '</div>';
}

// ---------------------------------------------------------------- small builders
function tile(v, l) { return '<div class="tile"><div class="v tnum">' + v + '</div><div class="l">' + l + '</div></div>'; }
function kv(k, v) { return '<div class="kv"><span class="muted">' + k + '</span><b>' + v + '</b></div>'; }
function errCard(err) {
  return '<div class="card pad" style="border-color:var(--red);background:var(--red-l)"><h3 style="color:var(--red-d)">Something went wrong</h3>'
    + '<p class="muted small" style="margin-top:8px">' + escHtml(friendlyError(err)) + '</p></div>';
}

// ============================================================================
// ACCESS KEYS
// ============================================================================
// an 8-char uppercase key generated in the browser when an assessment is made
function genKey() {
  var s = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", out = "";
  for (var i = 0; i < 8; i++) out += s.charAt(Math.floor(Math.random() * s.length));
  return out;
}
function keyUrl(key) {
  return window.location.origin + window.location.pathname.replace(/index\.html$/, "") + "take.html?k=" + key;
}
function copyKey(key) {
  if (!key) { toast("No key set", "err"); return; }
  var url = keyUrl(key);
  navigator.clipboard.writeText(url).then(function () { toast("Key link copied", "ok"); })
    .catch(function () { showModal({ title: "Key link", body: '<div class="link-box small" style="word-break:break-all">' + escHtml(url) + '</div>', confirm: null }); });
}

// ============================================================================
// INSTANCES (programme cycles)
// ============================================================================
function loadInstances() {
  showLoader();
  db.from("active_instances").select("*").order("created_at", { ascending: false }).then(function (r) {
    hideLoader();
    if (r.error) { shell(errCard(r.error)); return; }
    CACHE.instances = r.data || [];
    var rows = CACHE.instances.length ? CACHE.instances.map(function (i) {
      return '<tr onclick="go(\'instance\',\'' + i.id + '\')" style="cursor:pointer">'
        + '<td><b>' + escHtml(i.name) + '</b><div class="muted small">' + escHtml(i.description || "") + '</div></td>'
        + '<td>' + (i.is_live ? '<span class="pill live">Live</span>' : '<span class="pill closed">Draft</span>') + '</td>'
        + '<td class="muted small">' + fmtDate(i.created_at) + '</td></tr>';
    }).join("") : '<tr><td colspan="3" class="muted" style="padding:20px;text-align:center">No instances yet. Create one to run a cycle.</td></tr>';
    shell('<div class="page-head"><h1>Instances</h1><button class="btn" onclick="instanceForm(null)">＋ New instance</button></div>'
      + '<div class="card"><table><thead><tr><th>Name</th><th>Status</th><th>Created</th></tr></thead><tbody>' + rows + '</tbody></table></div>');
  });
}
function instanceForm(inst) {
  inst = inst || {};
  var isEdit = !!inst.id;
  function v(x) { return inst[x] == null ? "" : inst[x]; }
  function dt(x) { return inst[x] ? String(inst[x]).slice(0, 16) : ""; }
  shell('<div class="crumb"><a href="#" onclick="go(\'instances\');return false">Instances</a> / ' + (isEdit ? "Edit" : "New") + '</div>'
    + '<div class="page-head"><h1>' + (isEdit ? "Edit instance" : "New instance") + '</h1></div>'
    + '<div class="card pad" style="max-width:640px">'
    + '<div class="field"><label class="label">Name</label><input class="input" id="i-name" value="' + escAttr(v("name")) + '" placeholder="e.g. District Officers Programme — 2026 Cohort"></div>'
    + '<div class="field"><label class="label">Description (optional)</label><textarea class="input" id="i-desc" placeholder="What this cycle covers.">' + escHtml(v("description")) + '</textarea></div>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Nomination opens (optional)</label><input class="input" id="i-nom-open" type="datetime-local" value="' + dt("nomination_opens_at") + '"></div>'
    + '<div class="field"><label class="label">Nomination closes (optional)</label><input class="input" id="i-nom-close" type="datetime-local" value="' + dt("nomination_closes_at") + '"></div></div>'
    + '<p class="muted small">When you create an instance it starts as a <b>Draft</b>. Upload participants and add assessments, then use <b>Go live</b> on the instance page — participants cannot sign in until the instance is live.</p>'
    + '<div class="flex g12" style="margin-top:18px"><button class="btn ghost" onclick="go(\'instances\')">Cancel</button>'
    + '<button class="btn" onclick="saveInstance(' + (isEdit ? '\'' + inst.id + '\'' : "null") + ')">' + (isEdit ? "Save changes" : "Create instance") + '</button></div></div>');
}
function saveInstance(id) {
  function dv(x) { var e = document.getElementById(x).value; return e ? e : null; }
  var name = document.getElementById("i-name").value.trim();
  if (!name) { toast("Please enter a name", "err"); return; }
  var form = {
    name: name, description: document.getElementById("i-desc").value.trim() || null,
    nomination_opens_at: dv("i-nom-open"), nomination_closes_at: dv("i-nom-close")
  };
  showLoader("Saving...");
  var q = id ? db.from("instances").update(form).eq("id", id) : db.from("instances").insert(Object.assign({ admin_id: ADMIN.user.id }, form));
  q.select().single().then(function (r) {
    hideLoader();
    if (r.error) { toast(friendlyError(r.error), "err"); return; }
    toast("Instance saved", "ok"); go("instance", r.data.id);
  });
}

// ---- instance detail with tabs --------------------------------------------
function loadInstance(id) {
  ADMIN._instId = id;
  ADMIN._itab = ADMIN._itab || "overview";
  showLoader();
  Promise.all([
    db.from("active_instances").select("*").eq("id", id).single(),
    db.from("active_assessments").select("*").eq("instance_id", id).order("created_at", { ascending: true }),
    db.from("active_participants").select("*").eq("instance_id", id).order("full_name", { ascending: true })
  ]).then(function (r) {
    hideLoader();
    if (r[0].error) { shell(errCard(r[0].error)); return; }
    ADMIN._inst = r[0].data;
    ADMIN._instAssessments = r[1].data || [];
    ADMIN._participants = r[2].data || [];
    renderInstance();
  });
}
function instTab(name) { ADMIN._itab = name; renderInstance(); }
function renderInstance() {
  var inst = ADMIN._inst;
  var tabs = [["overview", "Overview"], ["assessments", "Assessments"], ["participants", "Participants"], ["panels", "Panels & reviewers"], ["reports", "WPCAS reports"]];
  var tabBar = '<div class="auth-tabs" style="margin-bottom:16px">' + tabs.map(function (t) {
    return '<button class="auth-tab ' + (ADMIN._itab === t[0] ? "active" : "") + '" onclick="instTab(\'' + t[0] + '\')">' + t[1] + '</button>';
  }).join("") + '</div>';
  var body = ADMIN._itab === "assessments" ? instAssessmentsTab()
    : ADMIN._itab === "participants" ? instParticipantsTab()
    : ADMIN._itab === "panels" ? instPanelsTab()
    : ADMIN._itab === "reports" ? instReportsTab()
    : instOverviewTab();
  var liveBtn = inst.is_live
    ? '<button class="btn ghost" onclick="setLive(false)">Take offline</button>'
    : '<button class="btn green" onclick="setLive(true)">Go live</button>';
  shell('<div class="crumb"><a href="#" onclick="go(\'instances\');return false">Instances</a> / ' + escHtml(inst.name) + '</div>'
    + '<div class="page-head"><h1>' + escHtml(inst.name) + ' ' + (inst.is_live ? '<span class="pill live">Live</span>' : '<span class="pill closed">Draft</span>') + '</h1>'
    + '<div class="flex g8"><button class="btn ghost" id="instEditBtn">Edit</button>' + liveBtn + '</div></div>'
    + tabBar + body);
  var eb = document.getElementById("instEditBtn");
  if (eb) eb.onclick = function () { instanceForm(ADMIN._inst); };
  if (ADMIN._itab === "participants") wireParticipantDrop();
}
function setLive(next) {
  var msg = next
    ? "Going live lets participants sign in to the portal and (within each assessment's window) take their assessments. Continue?"
    : "Taking the instance offline stops participants from signing in. Continue?";
  showModal({
    title: next ? "Go live?" : "Take offline?", body: msg, confirm: next ? "Go live" : "Take offline",
    onConfirm: function () {
      closeModal(); showLoader("Updating...");
      db.from("instances").update({ is_live: next }).eq("id", ADMIN._instId).then(function (r) {
        hideLoader();
        if (r.error) { toast(friendlyError(r.error), "err"); return; }
        logActivity(next ? "instance_live" : "instance_offline", ADMIN._instId, null);
        toast(next ? "Instance is live" : "Instance taken offline", "ok");
        loadInstance(ADMIN._instId);
      });
    }
  });
}
function instOverviewTab() {
  var i = ADMIN._inst;
  return '<div class="grid" style="grid-template-columns:1fr 1fr">'
    + '<div class="card pad"><h3 style="margin-bottom:12px">Cycle</h3>'
    + kv("Status", i.is_live ? '<span class="pill live">Live</span>' : '<span class="pill closed">Draft</span>')
    + kv("Nomination opens", i.nomination_opens_at ? fmtDate(i.nomination_opens_at) : "—")
    + kv("Nomination closes", i.nomination_closes_at ? fmtDate(i.nomination_closes_at) : "—")
    + kv("Created", fmtDate(i.created_at)) + '</div>'
    + '<div class="card pad"><h3 style="margin-bottom:12px">At a glance</h3>'
    + kv("Assessments", ADMIN._instAssessments.length)
    + kv("WPCAS instruments", ADMIN._instAssessments.filter(isWpcaRow).length)
    + kv("Participants", ADMIN._participants.length)
    + kv("Panels submitted", ADMIN._participants.filter(function (p) { return p.panel_submitted; }).length)
    + (i.description ? '<p class="muted small" style="margin-top:12px">' + escHtml(i.description) + '</p>' : "") + '</div></div>';
}
function instAssessmentsTab() {
  var rows = ADMIN._instAssessments.length ? ADMIN._instAssessments.map(function (a) {
    return '<tr><td><b>' + escHtml(a.title) + '</b></td>'
      + '<td>' + (isWpcaRow(a) ? '<span class="tag" style="color:var(--blue-d);border-color:var(--blue)">WPCAS</span>' : '<span class="tag">' + escHtml(catLabel(typeToCat(a)).split(" ")[0]) + '</span>') + '</td>'
      + '<td class="muted small">' + (a.activate_at ? fmtDate(a.activate_at) : "—") + '</td>'
      + '<td class="muted small">' + (a.deactivate_at ? fmtDate(a.deactivate_at) : "—") + '</td>'
      + '<td>' + (a.is_active ? '<span class="pill live">Active</span>' : '<span class="pill closed">Inactive</span>') + ' ' + schedulePill(a) + '</td>'
      + '<td><button class="btn ghost sm" onclick="go(\'detail\',\'' + a.id + '\')">Open</button></td></tr>';
  }).join("") : '<tr><td colspan="6" class="muted" style="padding:18px;text-align:center">No assessments in this instance yet.</td></tr>';
  return '<div class="flex jb ac" style="margin-bottom:12px"><p class="muted small">Add WPCAS, Baseline, Endline or EoCA assessments to this instance, and set each one\'s open/close window.</p>'
    + '<button class="btn sm" onclick="newAssessmentForInstance()">＋ New assessment</button></div>'
    + '<div class="card"><table><thead><tr><th>Title</th><th>Type</th><th>Opens</th><th>Closes</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}
function newAssessmentForInstance() {
  ADMIN.presetInstance = ADMIN._instId;   // preselect this instance in the form
  go("new");
}

// ---- participants tab (bulk upload + passwords) ----------------------------
function instParticipantsTab() {
  var creds = ADMIN._lastCreds;
  var credsBlock = "";
  if (creds && creds.length) {
    var crows = creds.map(function (c) {
      return '<tr><td>' + escHtml(c.full_name) + '</td><td>' + escHtml(c.email) + '</td><td><span style="font-family:ui-monospace,monospace">' + escHtml(c.password) + '</span></td></tr>';
    }).join("");
    credsBlock = '<div class="card pad" style="margin-bottom:14px;border-left:4px solid var(--green)">'
      + '<div class="flex jb ac wrap" style="gap:10px"><h3>New sign-in credentials (' + creds.length + ')</h3>'
      + '<button class="btn green sm" onclick="exportCreds()">↓ Export credentials (.xlsx)</button></div>'
      + '<p class="muted small" style="margin:6px 0 10px">These passwords are shown once. Share them with each participant separately. You can reset a password later, but you cannot view it again.</p>'
      + '<div style="max-height:260px;overflow:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Password</th></tr></thead><tbody>' + crows + '</tbody></table></div></div>';
  }
  var plist = ADMIN._participants.length ? ADMIN._participants.map(function (p) {
    return '<tr><td><b>' + escHtml(p.full_name) + '</b><div class="muted small">' + escHtml([p.designation, p.department, p.location].filter(Boolean).join(" · ")) + '</div></td>'
      + '<td class="muted small">' + escHtml(p.email) + '</td>'
      + '<td>' + (p.panel_submitted ? '<span class="pill live">Panel set</span>' : '<span class="pill sched">Awaiting panel</span>') + '</td>'
      + '<td><button class="btn ghost sm" onclick="resetPwd(\'' + p.id + '\',\'' + escAttr(p.full_name) + '\')">Reset password</button></td></tr>';
  }).join("") : '<tr><td colspan="4" class="muted" style="padding:18px;text-align:center">No participants yet. Upload an Excel file to add them.</td></tr>';
  return credsBlock
    + '<div class="card pad" style="margin-bottom:14px">'
    + '<div class="flex jb ac wrap" style="margin-bottom:10px"><h3>Upload participants (.xlsx)</h3>'
    + '<span class="tag">full_name · email · employee_id · designation · department · location · workstream · reporting_manager_email</span></div>'
    + '<div class="dz" id="pdz"><div style="font-size:30px">⤓</div><div style="font-weight:600;margin-top:6px">Drop the participants file here, or click to choose</div>'
    + '<div class="muted small">A password is auto-generated for each new person. Existing emails are skipped. <b>location</b> is the city used by automatic reviewer selection.</div></div>'
    + '<input type="file" id="pFileInput" accept=".xlsx,.xls" style="display:none">'
    + '<div class="muted small" style="margin-top:10px;cursor:pointer;color:var(--blue)" onclick="downloadParticipantTemplate()">↓ Download participant template</div></div>'
    + '<div class="card"><table><thead><tr><th>Participant</th><th>Email</th><th>Panel</th><th></th></tr></thead><tbody>' + plist + '</tbody></table></div>';
}
function wireParticipantDrop() {
  var dz = document.getElementById("pdz"), input = document.getElementById("pFileInput");
  if (!dz) return;
  dz.onclick = function () { input.click(); };
  input.onchange = function (e) { if (e.target.files[0]) handleParticipantFile(e.target.files[0]); };
  dz.ondragover = function (e) { e.preventDefault(); dz.classList.add("drag"); };
  dz.ondragleave = function () { dz.classList.remove("drag"); };
  dz.ondrop = function (e) { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) handleParticipantFile(e.dataTransfer.files[0]); };
}
function handleParticipantFile(file) {
  showLoader("Reading file...");
  var reader = new FileReader();
  reader.onload = function (ev) {
    var res = readParticipants(new Uint8Array(ev.target.result));
    if (res.error) { hideLoader(); toast(res.error, "err"); return; }
    var people = res.people.filter(function (p) { return p.full_name && p.email; });
    if (!people.length) { hideLoader(); toast("No rows with both a name and an email were found.", "err"); return; }
    db.rpc("bulk_create_participants", { p_instance_id: ADMIN._instId, p_rows: people }).then(function (r) {
      hideLoader();
      if (r.error) { toast(friendlyError(r.error), "err"); return; }
      ADMIN._lastCreds = r.data.created || [];
      toast("Added " + r.data.created_count + " participant(s)" + (r.data.skipped ? ", skipped " + r.data.skipped + " existing" : ""), "ok");
      loadInstance(ADMIN._instId);
    });
  };
  reader.readAsArrayBuffer(file);
}
function exportCreds() {
  var creds = ADMIN._lastCreds || [];
  var headers = ["full_name", "email", "password", "portal_url"];
  var url = window.location.origin + window.location.pathname.replace(/index\.html$/, "") + "portal.html";
  var rows = creds.map(function (c) { return [c.full_name, c.email, c.password, url]; });
  var ws = XLSX.utils.aoa_to_sheet([headers].concat(rows));
  var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Credentials");
  XLSX.writeFile(wb, "participant_credentials.xlsx");
  toast("Credentials exported", "ok");
}
function downloadParticipantTemplate() {
  var headers = ["full_name", "email", "employee_id", "designation", "department", "location", "workstream", "reporting_manager_email"];
  var sample = [["Asha Rao", "asha.rao@example.gov.in", "EMP001", "Section Officer", "Revenue", "Pune", "Land Records", "manager1@example.gov.in"]];
  var ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
  var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Participants");
  XLSX.writeFile(wb, "cegis_participants_template.xlsx");
}
function resetPwd(id, name) {
  showModal({
    title: "Reset password?", body: "A new password will be generated for <b>" + escHtml(name) + "</b> and shown once. Their current password stops working.",
    confirm: "Reset", onConfirm: function () {
      closeModal(); showLoader("Resetting...");
      db.rpc("reset_participant_password", { p_participant_id: id }).then(function (r) {
        hideLoader();
        if (r.error) { toast(friendlyError(r.error), "err"); return; }
        showModal({ title: "New password for " + escHtml(name), body: '<p class="muted small" style="margin-bottom:8px">Share this with the participant. It will not be shown again.</p><div class="link-box" style="font-family:ui-monospace,monospace;font-size:16px">' + escHtml(r.data) + '</div>', confirm: null });
      });
    }
  });
}

// ---- panels & reviewers tab ------------------------------------------------
function instPanelsTab() {
  var wpca = ADMIN._instAssessments.filter(isWpcaRow);
  var subjOpts = '<option value="">Choose a participant…</option>' + ADMIN._participants.map(function (p) {
    return '<option value="' + p.id + '"' + (ADMIN._panelSubject === p.id ? " selected" : "") + '>' + escHtml(p.full_name) + (p.location ? " (" + escHtml(p.location) + ")" : "") + '</option>';
  }).join("");
  var wpcaOpts = '<option value="">Choose a WPCAS instrument…</option>' + wpca.map(function (a) {
    return '<option value="' + a.id + '"' + (ADMIN._panelAssessment === a.id ? " selected" : "") + '>' + escHtml(a.title) + '</option>';
  }).join("");
  var autoBlock = wpca.length
    ? '<div class="card pad" style="margin-bottom:14px;border-left:4px solid var(--blue)"><div class="flex jb ac wrap" style="gap:10px">'
      + '<div><h3 style="margin-bottom:4px">Automatic finalisation</h3><p class="muted small">For every participant who has submitted a panel: 1 manager + 3 peers (2 from the same city, 1 from a different city), plus a self review.</p></div>'
      + '<button class="btn" onclick="doAutoFinalize()">Auto-finalise all panels</button></div></div>'
    : "";
  var panel = '<div class="card pad" style="margin-bottom:14px"><div class="row2">'
    + '<div class="field"><label class="label">Subject (person being reviewed)</label><select class="input" id="pn-subject" onchange="ADMIN._panelSubject=this.value;loadNominations()">' + subjOpts + '</select></div>'
    + '<div class="field"><label class="label">WPCAS instrument</label><select class="input" id="pn-assessment" onchange="ADMIN._panelAssessment=this.value">' + wpcaOpts + '</select></div></div>'
    + (wpca.length ? "" : '<p class="muted small" style="color:var(--red)">No WPCAS instrument exists in this instance yet. Create one first (Assessments tab).</p>') + '</div>';
  return autoBlock + panel + '<div id="nomArea">' + (ADMIN._panelSubject ? '<p class="muted small">Loading nominations…</p>' : '<p class="muted small">Pick a subject to see their nominated reviewers, or use automatic finalisation above.</p>') + '</div>';
}
function doAutoFinalize() {
  var aid = document.getElementById("pn-assessment").value;
  if (!aid) { toast("Choose a WPCAS instrument first", "err"); return; }
  showModal({
    title: "Auto-finalise all panels?",
    body: "For every participant who has submitted their panel on this instrument, this builds a reviewer set of 1 manager + 3 peers (2 same-city, 1 different-city) and a self review. Existing incomplete reviewer tasks for those subjects are replaced.",
    confirm: "Auto-finalise",
    onConfirm: function () {
      closeModal(); showLoader("Building reviewer panels...");
      db.rpc("auto_finalize_raters", { p_instance_id: ADMIN._instId, p_assessment_id: aid }).then(function (r) {
        hideLoader();
        if (r.error) { toast(friendlyError(r.error), "err"); return; }
        toast("Finalised panels for " + (r.data && r.data.count != null ? r.data.count : 0) + " subject(s)", "ok");
        if (ADMIN._panelSubject) loadNominations();
      });
    }
  });
}
function loadNominations() {
  if (!ADMIN._panelSubject) { document.getElementById("nomArea").innerHTML = ""; return; }
  var area = document.getElementById("nomArea");
  area.innerHTML = '<p class="muted small">Loading nominations…</p>';
  // the subject's own city, so we can tag each rater as same / different city
  var subj = (ADMIN._participants || []).filter(function (p) { return p.id === ADMIN._panelSubject; })[0];
  var subjCity = subj ? (subj.location || "") : "";
  Promise.all([
    db.rpc("subject_nominations", { p_subject_id: ADMIN._panelSubject }),
    db.from("active_rater_assignments").select("*").eq("subject_id", ADMIN._panelSubject)
  ]).then(function (r) {
    if (r[0].error) { area.innerHTML = errCard(r[0].error); return; }
    var noms = r[0].data || [], assigns = (r[1].data || []);
    ADMIN._noms = noms;
    var nrows = noms.length ? noms.map(function (n) {
      var city = n.location || "";
      var cityTag = city
        ? '<span class="tag">' + escHtml(city) + (subjCity && city === subjCity ? " · same city" : subjCity ? " · diff city" : "") + '</span>'
        : "";
      return '<tr><td><input type="checkbox" class="nomck" value="' + n.id + '"' + (n.is_finalized ? " checked disabled" : "") + '></td>'
        + '<td><b>' + escHtml(n.rater_name || n.rater_email) + '</b><div class="muted small">' + escHtml(n.rater_email) + '</div></td>'
        + '<td><span class="tag">' + escHtml(n.relationship) + '</span></td>'
        + '<td>' + cityTag + '</td>'
        + '<td>' + (n.is_finalized ? '<span class="pill live">Finalised</span>' : '<span class="muted small">nominated</span>') + '</td></tr>';
    }).join("") : '<tr><td colspan="5" class="muted" style="padding:16px;text-align:center">This subject has not nominated anyone yet.</td></tr>';
    var arows = assigns.length ? assigns.map(function (a) {
      return '<tr><td>' + escHtml(a.rater_name || a.rater_email) + '</td><td><span class="tag">' + escHtml(a.relationship) + '</span></td>'
        + '<td><span style="font-family:ui-monospace,monospace">' + escHtml(a.access_key) + '</span></td>'
        + '<td>' + (a.is_completed ? '<span class="pill live">Done</span>' : '<span class="pill sched">Pending</span>') + '</td>'
        + '<td><button class="btn ghost sm" onclick="copyKey(\'' + escAttr(a.access_key) + '\')">Copy key link</button></td></tr>';
    }).join("") : "";
    var assignBlock = assigns.length ? '<div class="card pad" style="margin-top:14px"><h3 style="margin-bottom:10px">Finalised reviewers & their keys</h3>'
      + '<p class="muted small" style="margin-bottom:8px">Share each key link with the reviewer, or they will see the task in their portal.</p>'
      + '<table><thead><tr><th>Reviewer</th><th>Relationship</th><th>Key</th><th>Status</th><th></th></tr></thead><tbody>' + arows + '</tbody></table></div>' : "";
    area.innerHTML = '<div class="card pad"><div class="flex jb ac" style="margin-bottom:10px"><h3>Nominated reviewers</h3>'
      + '<button class="btn green sm" onclick="doFinalize()">Finalise selected (manual)</button></div>'
      + '<p class="muted small" style="margin-bottom:10px">Tick the people who should review this subject on the chosen WPCAS instrument, then finalise. A self review is always added. Each finalised reviewer gets a unique key.</p>'
      + '<table><thead><tr><th></th><th>Reviewer</th><th>Relationship</th><th>City</th><th>Status</th></tr></thead><tbody>' + nrows + '</tbody></table></div>'
      + assignBlock;
  });
}
function doFinalize() {
  if (!ADMIN._panelSubject) { toast("Choose a subject first", "err"); return; }
  var aid = document.getElementById("pn-assessment").value;
  if (!aid) { toast("Choose a WPCAS instrument first", "err"); return; }
  var ids = Array.prototype.slice.call(document.querySelectorAll(".nomck:checked:not(:disabled)")).map(function (c) { return c.value; });
  if (!ids.length) { toast("Select at least one nominated reviewer", "err"); return; }
  showLoader("Creating reviewer tasks...");
  db.rpc("finalize_raters", { p_subject_id: ADMIN._panelSubject, p_assessment_id: aid, p_nomination_ids: ids }).then(function (r) {
    hideLoader();
    if (r.error) { toast(friendlyError(r.error), "err"); return; }
    toast("Finalised " + r.data + " reviewer(s)", "ok");
    loadNominations();
  });
}

// ---- WPCAS reports tab -----------------------------------------------------
function instReportsTab() {
  var subjOpts = '<option value="">Choose a participant…</option>' + ADMIN._participants.map(function (p) {
    return '<option value="' + p.id + '"' + (ADMIN._reportSubject === p.id ? " selected" : "") + '>' + escHtml(p.full_name) + '</option>';
  }).join("");
  return '<div class="card pad" style="margin-bottom:14px"><div class="field" style="max-width:420px"><label class="label">Subject</label>'
    + '<select class="input" id="rp-subject" onchange="ADMIN._reportSubject=this.value;loadWpcaReport()">' + subjOpts + '</select></div></div>'
    + '<div id="reportArea">' + (ADMIN._reportSubject ? '<p class="muted small">Loading…</p>' : '<p class="muted small">Pick a subject to see their WPCAS report (self vs others, per competency).</p>') + '</div>';
}
function loadWpcaReport() {
  if (!ADMIN._reportSubject) { document.getElementById("reportArea").innerHTML = ""; return; }
  var area = document.getElementById("reportArea");
  area.innerHTML = '<p class="muted small">Loading…</p>';
  db.rpc("wpca_subject_report", { p_subject_id: ADMIN._reportSubject }).then(function (r) {
    if (r.error) { area.innerHTML = errCard(r.error); return; }
    var d = r.data, comps = d.competencies || [];
    if (!comps.length) { area.innerHTML = '<div class="card pad"><p class="muted">No completed WPCAS reviews for ' + escHtml(d.subject) + ' yet.</p></div>'; return; }
    var data = comps.map(function (c) { return { label: c.competency || "General", a: Number(c.self_pct) || 0, b: Number(c.others_pct) || 0 }; });
    var rows = comps.map(function (c) {
      var gap = (Number(c.others_pct) - Number(c.self_pct)).toFixed(1);
      return '<tr><td>' + escHtml(c.competency || "General") + '</td><td class="tnum">' + c.self_pct + '%</td><td class="tnum">' + c.others_pct + '%</td><td class="tnum">' + (gap > 0 ? "+" : "") + gap + '</td></tr>';
    }).join("");
    area.innerHTML = '<div class="card pad" style="margin-bottom:14px"><div class="summary-band"><div><h2 style="margin:0;color:#fff">' + escHtml(d.subject) + '</h2>'
      + '<p style="opacity:.9;margin-top:2px">WPCAS — share of "Yes": self vs the average of all other reviewers</p></div>'
      + '<div class="metric-tiles"><div class="mt"><div class="v tnum">' + d.overall.self_pct + '%</div><div class="l">Self</div></div>'
      + '<div class="mt"><div class="v tnum">' + d.overall.others_pct + '%</div><div class="l">Others</div></div></div></div></div>'
      + '<div class="card pad" style="margin-bottom:14px"><h3 style="margin-bottom:10px">By competency</h3>' + groupedBars(data, { a: "Self", b: "Others" }) + '</div>'
      + '<div class="card"><table><thead><tr><th>Competency</th><th>Self</th><th>Others</th><th>Gap</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  });
}
