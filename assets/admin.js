// CEGIS Assessment Platform - Admin portal logic.
// Single-page console: auth gate, then a left-rail app shell.
// All data access goes through Supabase with Row-Level Security; destructive
// actions are soft deletes via RPCs (never a real DELETE).
//
// FLOW OVERVIEW (revised):
// 1. Admin creates an Instance (the container for everything).
// 2. Within the instance: upload respondents (passwords auto-generated).
// 3. Within the instance: create assessments and assign them to this instance.
//    - WPCAS: yes/no questions, raters assigned per person.
//    - Baseline / Endline / EOCA: MCQ questions, optional images per question.
//    - Each assessment gets activation date + deactivation date.
// 4. Once all assessments are ready the admin clicks "Go live" on the instance.
// 5. Respondents log in at portal.html, pick their panel, then take assessments,
//    then come back to complete any WPCAS reviews they owe.
// 6. Admin finalises WPCAS raters: auto (1 manager + 2 same-city + 1 diff-city)
//    or manually ticking nominations.

var ADMIN = { user: null, view: "dashboard", assessmentId: null };
var CACHE = { assessments: [], qCounts: {}, rCounts: {}, rAvg: {}, flagCounts: {} };
var UPLOAD = { step: 0, fileName: "", questions: [], valid: [] };

// ---------------------------------------------------------------- boot
onReady(function () {
  if (!initSupabase()) {
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
  document.getElementById("login-pass").addEventListener("keydown", function (e) { if (e.key === "Enter") doLogin(); });
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
    alertBox("login-err", "If that email is registered you will receive a reset link.", "ok");
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
  // make sure an admins row exists for this user (upsert allowed by RLS)
  db.from("admins").upsert({ id: user.id, full_name: name, email: user.email }, { onConflict: "id" }).then(function () {});
  ADMIN.view = "instances";
  // land on instances list so the admin starts from there
  loadInstances();
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
  { k: "instances", ic: "◷", label: "Instances" },
  { k: "dashboard", ic: "▦", label: "Assessment Library" },
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
function go(view, id) {
  ADMIN.view = view;
  ADMIN.assessmentId = id || null;
  window.scrollTo(0, 0);
  if (view === "dashboard")  loadDashboard();
  else if (view === "new")   newForm(id);        // id = instance_id pre-fill
  else if (view === "edit")  loadEdit(id);
  else if (view === "detail") loadDetail(id);
  else if (view === "questions") loadQuestions(id);
  else if (view === "results")   loadResults(id);
  else if (view === "instances") loadInstances();
  else if (view === "instance")  loadInstance(id);
  else if (view === "settings")  shell(settingsView());
}

// load the admin's instances into the cache, then run cb
function withInstances(cb) {
  db.from("active_instances").select("*").order("created_at", { ascending: false }).then(function (r) {
    CACHE.instances = r.data || [];
    cb();
  });
}
// pass optional instance_id to pre-select it in the new assessment form
function newForm(instanceId) {
  ADMIN._preInstId = instanceId || null;
  withInstances(function () { shell(formView(null)); });
}

// ---------------------------------------------------------------- dashboard (library view, secondary)
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
      + '<p class="muted">Create assessments from within an instance.</p>'
      + '<button class="btn" style="margin-top:14px" onclick="go(\'instances\')">Go to Instances</button></div>';
  } else {
    var trs = list.map(function (a) {
      var qc = CACHE.qCounts[a.id] || 0, rc = CACHE.rCounts[a.id] || 0;
      var status = a.is_active ? '<span class="pill live">Active</span>' : '<span class="pill closed">Inactive</span>';
      var lim = a.max_respondents == null ? "—" : (rc + " / " + a.max_respondents);
      var typeTag = typeLabel(a.assessment_type);
      return '<tr>'
        + '<td><b style="cursor:pointer" onclick="go(\'detail\',\'' + a.id + '\')">' + escHtml(a.title) + '</b>'
        + '<div class="muted small">v' + a.version + (a.stage ? ' · ' + a.stage : '') + ' · created ' + new Date(a.created_at).toLocaleDateString() + '</div></td>'
        + '<td>' + typeTag + '</td>'
        + '<td class="tnum">' + qc + '</td>'
        + '<td class="tnum">' + lim + '</td>'
        + '<td>' + status + '</td>'
        + '<td><div class="flex g8 wrap">'
        + '<button class="btn ghost sm" onclick="go(\'questions\',\'' + a.id + '\')">Questions</button>'
        + '<button class="btn ghost sm" onclick="go(\'results\',\'' + a.id + '\')">Results</button>'
        + '<button class="btn ' + (a.is_active ? "ghost" : "green") + ' sm" onclick="toggleActive(\'' + a.id + '\',' + (!a.is_active) + ')">' + (a.is_active ? "Deactivate" : "Activate") + '</button>'
        + '<button class="btn danger sm" onclick="confirmDelete(\'' + a.id + '\',\'' + escAttr(a.title) + '\')">Delete</button>'
        + '</div></td></tr>';
    }).join("");
    rows = '<div class="card"><table><thead><tr><th>Assessment</th><th>Type</th><th>Questions</th><th>Respondents</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
  }
  shell('<div class="page-head"><div><div class="crumb">Console</div><h1>Assessment Library</h1></div>'
    + '<button class="btn" onclick="go(\'new\')">+ New assessment</button></div>'
    + tiles + rows);
}

// human-readable label for assessment type
function typeLabel(t) {
  var labels = { objective: "Objective", wpca: "WPCA (360 rating)", wpcas: "WPCAS (Yes/No)", baseline: "Baseline", endline: "Endline", eoca: "EOCA" };
  var colors = { wpca: "color:var(--blue-d);border-color:var(--blue)", wpcas: "color:var(--blue-d);border-color:var(--blue)", baseline: "color:var(--green-d);border-color:var(--green)", endline: "color:var(--green-d);border-color:var(--green)", eoca: "color:var(--ochre);border-color:var(--ochre)" };
  return '<span class="tag" style="' + (colors[t] || "") + '">' + (labels[t] || t) + '</span>';
}

// ---------------------------------------------------------------- create / edit
function loadEdit(id) {
  showLoader();
  db.from("active_assessments").select("*").eq("id", id).single().then(function (r) {
    hideLoader();
    if (r.error) { shell(errCard(r.error)); return; }
    withInstances(function () { shell(formView(r.data)); });
  });
}
function formView(a) {
  a = a || {};
  var isEdit = !!a.id;
  function v(x, d) { return a[x] == null ? (d == null ? "" : d) : a[x]; }
  function dt(x) { return a[x] ? String(a[x]).slice(0, 16) : ""; }
  var dm1 = (v("display_mode", "one_at_a_time") === "one_at_a_time") ? "selected" : "";
  var dm2 = (v("display_mode") === "all_on_page") ? "selected" : "";
  var curType = v("assessment_type", "objective");
  // use the pre-selected instance if creating new from an instance page
  var curInst = v("instance_id") || ADMIN._preInstId || "";
  var instOpts = '<option value="">Standalone (no instance)</option>'
    + (CACHE.instances || []).map(function (i) { return '<option value="' + i.id + '"' + (curInst === i.id ? " selected" : "") + '>' + escHtml(i.name) + '</option>'; }).join("");
  // assessment type dropdown with clear groupings
  var types = [
    { v: "objective",  l: "Objective (MCQ / multi / true-false)" },
    { v: "wpcas",      l: "WPCAS (Yes / No questions)" },
    { v: "wpca",       l: "WPCA (360 rating scale)" },
    { v: "baseline",   l: "Baseline assessment" },
    { v: "endline",    l: "Endline assessment" },
    { v: "eoca",       l: "EOCA assessment" }
  ];
  var typeOpts = types.map(function (t) { return '<option value="' + t.v + '"' + (curType === t.v ? " selected" : "") + '>' + t.l + '</option>'; }).join("");
  // type hint that updates on change
  var typeHints = {
    objective: "Auto-scored MCQ / multi / true-false items.",
    wpcas: "WPCAS: questions with only Yes / No as answer options. Raters are assigned per respondent.",
    wpca: "WPCA: a 360 rating scale instrument. Upload rating items; raters are assigned per subject.",
    baseline: "Baseline assessment: MCQ questions with optional images per question.",
    endline: "Endline assessment: MCQ questions with optional images per question.",
    eoca: "EOCA assessment: MCQ questions with optional images per question."
  };
  var curHint = typeHints[curType] || "";

  var backCrumb = ADMIN._preInstId
    ? '<a href="#" onclick="go(\'instance\',\'' + ADMIN._preInstId + '\');return false">Instance</a>'
    : '<a href="#" onclick="go(\'dashboard\');return false">Library</a>';

  return '<div class="crumb">' + backCrumb + ' / ' + (isEdit ? "Edit assessment" : "New assessment") + '</div>'
    + '<div class="page-head"><h1>' + (isEdit ? "Edit assessment" : "New assessment") + '</h1></div>'
    + '<div class="card pad" style="max-width:680px">'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Assessment type</label>'
    + '<select class="input" id="f-type" onchange="updateTypeHint(this.value)">'
    + typeOpts + '</select>'
    + '<div class="muted small" id="typehint" style="margin-top:4px">' + escHtml(curHint) + '</div></div>'
    + '<div class="field"><label class="label">Instance / cycle</label><select class="input" id="f-instance">' + instOpts + '</select></div>'
    + '</div>'
    + '<div class="field"><label class="label">Title</label><input class="input" id="f-title" value="' + escAttr(v("title")) + '" placeholder="e.g. Data Capacity — Baseline 2026"></div>'
    + '<div class="field"><label class="label">Intro text (shown before respondents start)</label><textarea class="input" id="f-intro" placeholder="Explain the purpose, rules and time needed.">' + escHtml(v("intro_text")) + '</textarea></div>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Activates at (optional)</label><input class="input" id="f-from" type="datetime-local" value="' + dt("active_from") + '"><div class="muted small" style="margin-top:4px">Leave blank to activate manually.</div></div>'
    + '<div class="field"><label class="label">Deactivates at (optional)</label><input class="input" id="f-until" type="datetime-local" value="' + dt("active_until") + '"></div>'
    + '</div>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Time limit (minutes, optional)</label><input class="input" id="f-time" type="number" min="1" value="' + escAttr(v("time_limit_minutes")) + '" placeholder="No limit"></div>'
    + '<div class="field"><label class="label">Passing score % (optional)</label><input class="input" id="f-pass" type="number" min="0" max="100" value="' + escAttr(v("passing_score_percent")) + '" placeholder="No pass mark"></div>'
    + '</div>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Respondent limit (optional)</label><input class="input" id="f-max" type="number" min="1" value="' + escAttr(v("max_respondents")) + '" placeholder="Unlimited"></div>'
    + '<div class="field"><label class="label">Display mode</label><select class="input" id="f-mode"><option value="one_at_a_time" ' + dm1 + '>One question at a time</option><option value="all_on_page" ' + dm2 + '>All on one page</option></select></div>'
    + '</div>'
    + '<div class="switch"><input type="checkbox" id="f-shuffle" ' + (v("shuffle_questions") ? "checked" : "") + '><label for="f-shuffle">Shuffle question order for each respondent</label></div>'
    + '<div class="switch"><input type="checkbox" id="f-showres" ' + (v("show_results_immediately", true) ? "checked" : "") + '><label for="f-showres">Show results to respondents immediately after submitting</label></div>'
    + '<div class="flex g12" style="margin-top:18px">'
    + '<button class="btn ghost" onclick="go(\'instances\')">Cancel</button>'
    + '<button class="btn" onclick="saveAssessment(' + (isEdit ? '\'' + a.id + '\'' : "null") + ')">' + (isEdit ? "Save changes" : "Create assessment") + '</button></div>'
    + '</div>';
}
// update the hint text when the type selector changes
function updateTypeHint(val) {
  var hints = {
    objective: "Auto-scored MCQ / multi / true-false items.",
    wpcas: "WPCAS: questions with only Yes / No as answer options. Raters are assigned per respondent.",
    wpca: "WPCA: a 360 rating scale instrument. Upload rating items; raters are assigned per subject.",
    baseline: "Baseline assessment: MCQ questions with optional images per question.",
    endline: "Endline assessment: MCQ questions with optional images per question.",
    eoca: "EOCA assessment: MCQ questions with optional images per question."
  };
  var el = document.getElementById("typehint");
  if (el) el.textContent = hints[val] || "";
}
function readForm() {
  function num(id) { var x = document.getElementById(id).value; return x === "" ? null : Number(x); }
  function dtv(id) { var x = document.getElementById(id).value; return x ? x : null; }
  return {
    title: document.getElementById("f-title").value.trim(),
    intro_text: document.getElementById("f-intro").value.trim(),
    assessment_type: document.getElementById("f-type").value,
    instance_id: document.getElementById("f-instance").value || null,
    active_from: dtv("f-from"),
    active_until: dtv("f-until"),
    time_limit_minutes: num("f-time"),
    passing_score_percent: num("f-pass"),
    max_respondents: num("f-max"),
    display_mode: document.getElementById("f-mode").value,
    shuffle_questions: document.getElementById("f-shuffle").checked,
    show_results_immediately: document.getElementById("f-showres").checked
  };
}
function saveAssessment(id) {
  var form = readForm();
  if (!form.title) { toast("Title is required", "err"); return; }
  if (!form.intro_text) { toast("Intro text is required", "err"); return; }
  showLoader(id ? "Saving changes..." : "Creating assessment...");
  if (id) {
    db.from("assessments").update(form).eq("id", id).then(function (r) {
      hideLoader();
      if (r.error) { toast(friendlyError(r.error), "err"); return; }
      logActivity("updated_assessment", id, { title: form.title });
      toast("Saved", "ok");
      // go back to the instance page if this assessment belongs to one
      if (form.instance_id) go("instance", form.instance_id);
      else go("detail", id);
    });
  } else {
    form.admin_id = ADMIN.user.id;
    form.access_key = genKey();
    db.from("assessments").insert(form).select().single().then(function (r) {
      hideLoader();
      if (r.error) { toast(friendlyError(r.error), "err"); return; }
      logActivity("created_assessment", r.data.id, { title: form.title });
      toast("Assessment created. Add questions next.", "ok");
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
    var steps = ["Created", "Questions added", "Activated", "Collecting", "Results"];
    var current = !qc ? 1 : (!a.is_active ? 2 : (rc ? 4 : 3));
    var stepper = '<div class="stepper">';
    steps.forEach(function (s, i) {
      var cls = i < current ? "done" : (i === current ? "active" : "");
      stepper += '<div class="step ' + cls + '"><span class="n">' + (i < current ? "v" : i + 1) + '</span>' + s + '</div>' + (i < steps.length - 1 ? '<span class="arrow">&rarr;</span>' : "");
    });
    stepper += '</div>';
    var lim = a.max_respondents == null ? "Unlimited" : (rc + " of " + a.max_respondents + " used");
    var actions = log.length ? log.map(function (l) {
      return '<div class="flex ac g12" style="padding:9px 0;border-bottom:1px solid var(--n100)">'
        + '<div style="width:8px;height:8px;border-radius:50%;background:var(--blue)"></div>'
        + '<div style="flex:1"><div>' + escHtml(l.action.replace(/_/g, " ")) + (l.metadata && l.metadata.title ? " — " + escHtml(l.metadata.title) : "") + '</div>'
        + '<div class="muted small">' + fmtDate(l.performed_at) + '</div></div></div>';
    }).join("") : '<p class="muted small">No activity recorded yet.</p>';

    // window info (activation/deactivation schedule)
    var windowInfo = "";
    if (a.active_from || a.active_until) {
      windowInfo = kv("Activates", a.active_from ? fmtDate(a.active_from) : "Manually") + kv("Deactivates", a.active_until ? fmtDate(a.active_until) : "Manually");
    }

    var backCrumb = a.instance_id
      ? '<a href="#" onclick="go(\'instance\',\'' + a.instance_id + '\');return false">Instance</a>'
      : '<a href="#" onclick="go(\'dashboard\');return false">Library</a>';

    shell('<div class="crumb">' + backCrumb + ' / ' + escHtml(a.title) + '</div>'
      + '<div class="page-head"><h1>' + escHtml(a.title) + '</h1>'
      + '<div class="flex g8 wrap"><button class="btn ghost" onclick="go(\'edit\',\'' + a.id + '\')">Edit settings</button>'
      + (a.assessment_type !== "wpcas" && a.assessment_type !== "wpca" ? '<button class="btn ghost" onclick="copyLink(\'' + a.id + '\')">Copy link</button>' : "")
      + '<button class="btn ' + (a.is_active ? "ghost" : "green") + '" onclick="toggleActive(\'' + a.id + '\',' + (!a.is_active) + ')">' + (a.is_active ? "Deactivate" : "Activate") + '</button></div></div>'
      + stepper
      + '<div class="grid" style="grid-template-columns:1.3fr 1fr">'
      + '<div class="card pad"><h3 style="margin-bottom:12px">Overview</h3>'
      + kv("Type", typeLabel(a.assessment_type))
      + kv("Status", a.is_active ? '<span class="pill live">Active</span>' : '<span class="pill closed">Inactive</span>')
      + windowInfo
      + kv("Access key", '<b style="font-family:ui-monospace,monospace;letter-spacing:1px">' + escHtml(a.access_key || "—") + '</b>' + (a.assessment_type === "wpcas" || a.assessment_type === "wpca" ? ' <span class="muted small">(raters get their own keys after panels are finalised)</span>' : ' <button class="btn ghost sm" style="margin-left:8px" onclick="copyKey(\'' + escAttr(a.access_key || "") + '\')">Copy key link</button>'))
      + kv("Version", "v" + a.version) + kv("Questions", qc) + kv("Respondents", rc)
      + kv("Respondent limit", lim)
      + kv("Time limit", a.time_limit_minutes ? a.time_limit_minutes + " min" : "None")
      + kv("Passing score", a.passing_score_percent != null ? a.passing_score_percent + "%" : "None")
      + '<div class="flex g8" style="margin-top:14px"><button class="btn ghost sm" onclick="go(\'questions\',\'' + a.id + '\')">Manage questions</button>'
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
  var isWpcas = a.assessment_type === "wpcas";
  var isWpca  = a.assessment_type === "wpca";
  var hasImages = ["baseline", "endline", "eoca"].indexOf(a.assessment_type) !== -1;
  // four upload steps: file -> validate -> preview -> import
  var steps = ["Upload Excel", "Validate & fix", "Preview", "Import"];
  var stepper = '<div class="stepper">';
  steps.forEach(function (s, i) {
    var cls = UPLOAD.step === i ? "active" : UPLOAD.step > i ? "done" : "";
    stepper += '<div class="step ' + cls + '"><span class="n">' + (UPLOAD.step > i ? "v" : i + 1) + '</span>' + s + '</div>' + (i < 3 ? '<span class="arrow">&rarr;</span>' : "");
  });
  stepper += '</div>';

  var body;
  if (UPLOAD.step === 0) {
    var cols;
    if (isWpcas) cols = "no · q_stem (the question text). Yes/No are the only answer options.";
    else if (isWpca) cols = "no · q_competency · q_facet · q_stem · opt1-5 (scale labels) · marks";
    else cols = "no · q_type · q_level · q_competency · q_facet · q_stem · opt1-5 · isopt1-5correct · marks";

    var imageNote = hasImages
      ? '<p class="muted small" style="margin-top:12px">After importing questions you can upload an image for each question from this page.</p>'
      : "";

    body = '<div class="card pad">'
      + '<div class="flex jb ac wrap" style="margin-bottom:14px"><h3>Upload question file (.xlsx)</h3>'
      + '<span class="tag">Columns: ' + cols + '</span></div>'
      + '<div class="dz" id="dz"><div style="font-size:34px">&#x21A7;</div>'
      + '<div style="font-weight:600;margin-top:6px">Drop your .xlsx here, or click to choose a file</div>'
      + '<div class="muted small">' + (isWpcas ? "One question per row. q_stem is the question. Yes and No options are generated automatically."
          : isWpca ? "Each row is a rating item. opt1..opt5 are the scale points."
          : "q_type must be mcqsca, mcqmca or tf. marks default to 0 if blank.") + '</div></div>'
      + '<input type="file" id="fileInput" accept=".xlsx,.xls" style="display:none">'
      + '<div class="muted small" style="margin-top:10px;cursor:pointer;color:var(--blue)" onclick="downloadTemplate()">Download Excel template</div>'
      + imageNote + '</div>';
  } else if (UPLOAD.step === 1) body = validationView();
  else if (UPLOAD.step === 2) body = previewView();
  else body = importView();

  var backCrumb = a.instance_id
    ? '<a href="#" onclick="go(\'instance\',\'' + a.instance_id + '\');return false">Instance</a> / '
    : '';
  shell('<div class="crumb">' + backCrumb + '<a href="#" onclick="go(\'detail\',\'' + a.id + '\');return false">' + escHtml(a.title) + '</a> / Questions</div>'
    + '<div class="page-head"><h1>Questions &mdash; ' + escHtml(a.title) + '</h1></div>' + stepper + body);
  if (UPLOAD.step === 0) wireDropzone();

  // show image upload section after a successful import for image-supporting types
  if (UPLOAD.step === 0 && hasImages && ADMIN._assessment.version > 1) {
    renderImageUploadSection(a);
  }
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
    var a = ADMIN._assessment;
    var isWpca  = a.assessment_type === "wpca";
    var isWpcas = a.assessment_type === "wpcas";
    var res = readWorkbook(new Uint8Array(ev.target.result));
    hideLoader();
    if (res.error) { toast(res.error, "err"); return; }
    if (!res.questions.length) { toast("No rows found in the spreadsheet", "err"); return; }
    // for wpcas: override q_type to 'yesno' and set opt1/opt2 to Yes/No
    if (isWpcas) {
      res.questions.forEach(function (q) {
        q.q_type = "yesno";
        q.opt1 = "Yes";
        q.opt2 = "No";
      });
    }
    UPLOAD.questions = res.questions;
    UPLOAD.valid = res.questions.map(function (q) { return validateQuestion(q, isWpca, isWpcas); });
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
  var a = ADMIN._assessment;
  var isWpcas = a.assessment_type === "wpcas";
  var isWpca  = a.assessment_type === "wpca";
  var bad  = UPLOAD.valid.filter(function (v) { return v.level === "err"; }).length;
  var warn = UPLOAD.valid.filter(function (v) { return v.level === "warn"; }).length;
  var clean = UPLOAD.valid.length - bad - warn;
  var banner = bad
    ? '<span class="badge err" style="font-size:13px;padding:6px 12px">!</span><div><b>' + bad + ' question(s) must be fixed</b> <span class="muted">before importing. ' + clean + ' clean, ' + warn + ' to check.</span></div>'
    : warn
      ? '<span class="badge warn" style="font-size:13px;padding:6px 12px">!</span><div><b>' + clean + ' of ' + UPLOAD.valid.length + ' parsed cleanly.</b> <span class="muted">' + warn + ' to double-check, none blocking.</span></div>'
      : '<span class="badge ok" style="font-size:13px;padding:6px 12px">v</span><div><b>All ' + UPLOAD.valid.length + ' questions parsed cleanly.</b></div>';
  var rows = UPLOAD.questions.map(function (q, i) {
    var val = UPLOAD.valid[i];
    var badge = val.level === "err" ? '<span class="badge err">! ' + escHtml(val.msg) + '</span>'
      : val.level === "warn" ? '<span class="badge warn">! ' + escHtml(val.msg) + '</span>'
        : '<span class="badge ok">Valid</span>';
    // show q_type as "yesno" for wpcas items
    var qType = isWpcas ? "yesno" : (isWpca ? (q.q_type || "rating") : (q.q_type || "?"));
    var nopts = isWpcas ? 2 : [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5].filter(function (o) { return o; }).length;
    return '<tr><td class="tnum">' + escHtml(q.no || (i + 1)) + '</td><td><span class="tag">' + qType + '</span></td>'
      + '<td style="max-width:320px">' + escHtml(q.q_stem || "(empty)") + '</td><td class="tnum">' + nopts + '</td><td class="tnum">' + escHtml(q.marks != null ? q.marks : 0) + '</td><td>' + badge + '</td></tr>';
  }).join("");
  return '<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12">' + banner + '</div></div>'
    + '<div class="card"><table><thead><tr><th>#</th><th>Type</th><th>Question text</th><th>Options</th><th>Marks</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="flex g12" style="margin-top:16px;justify-content:flex-end">'
    + '<button class="btn ghost" onclick="UPLOAD.step=0;renderUpload()">Re-upload</button>'
    + '<button class="btn" ' + (bad ? "disabled title=\"Fix the blocking errors first\"" : "") + ' onclick="UPLOAD.step=2;renderUpload()">Continue to preview</button></div>';
}
function previewView() {
  var a = ADMIN._assessment;
  var isWpcas = a.assessment_type === "wpcas";
  var cards = UPLOAD.questions.slice(0, 4).map(function (q) {
    return '<div class="card pad" style="margin-bottom:14px"><div class="flex jb"><span class="tag">' + escHtml(isWpcas ? "yesno" : (q.q_type || "rating")) + '</span>'
      + (q.q_competency ? '<span class="muted small">' + escHtml(q.q_competency) + '</span>' : "") + '</div>'
      + '<p style="font-weight:600;margin:10px 0 12px">' + escHtml(q.q_stem) + '</p>' + previewControls(q) + '</div>';
  }).join("");
  return '<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12"><span class="badge info">i</span>'
    + '<div>Showing the first few of ' + UPLOAD.questions.length + ' questions as respondents will see them.</div></div></div>'
    + cards + '<div class="flex g12" style="margin-top:16px;justify-content:flex-end">'
    + '<button class="btn ghost" onclick="UPLOAD.step=1;renderUpload()">Back</button>'
    + '<button class="btn" onclick="UPLOAD.step=3;renderUpload()">Continue to import</button></div>';
}
function previewControls(q) {
  var a = ADMIN._assessment;
  var isWpcas = a && a.assessment_type === "wpcas";
  var isWpca  = a && a.assessment_type === "wpca";
  var opts;
  if (isWpcas) {
    opts = ["Yes", "No"];
  } else if (q.q_type === "tf") {
    opts = ["True", "False"];
  } else {
    opts = [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5].filter(function (o) { return o; });
  }
  var multi = q.q_type === "mcqmca";
  return '<div style="pointer-events:none;opacity:.9">' + opts.map(function (o) {
    return '<div class="opt"><span class="rd' + (multi ? " sq" : "") + '"></span>' + escHtml(o) + '</div>';
  }).join("") + '</div>'
    + (isWpcas ? '' : '<div class="muted small" style="margin-top:6px">Marks: ' + escHtml(q.marks != null ? q.marks : 0) + '</div>');
}
function importView() {
  var a = ADMIN._assessment;
  var n = UPLOAD.questions.length;
  return '<div class="card pad" style="max-width:560px"><h3 style="margin-bottom:14px">Import questions</h3>'
    + kv("Assessment", escHtml(a.title)) + kv("Questions to import", n)
    + kv("New version", "v" + (a.version + 1)) + kv("Source file", escHtml(UPLOAD.fileName))
    + '<p class="muted small" style="margin:12px 0">Importing soft-deletes the previous question set, bumps the version, '
    + 'and keeps the original file in storage. Past respondents keep the version they saw.</p>'
    + '<div class="flex g12"><button class="btn ghost" onclick="UPLOAD.step=2;renderUpload()">Back</button>'
    + '<button class="btn" onclick="doImport()">Import ' + n + ' questions</button></div></div>';
}
function doImport() {
  var a = ADMIN._assessment, id = a.id;
  // for wpca: ensure q_type = 'rating' on items without an explicit type
  if (a.assessment_type === "wpca") {
    UPLOAD.questions.forEach(function (q) { if (!q.q_type) q.q_type = "rating"; });
  }
  // for wpcas: ensure q_type = 'yesno' on every item
  if (a.assessment_type === "wpcas") {
    UPLOAD.questions.forEach(function (q) { q.q_type = "yesno"; q.opt1 = "Yes"; q.opt2 = "No"; });
  }
  showLoader("Importing questions...");
  db.rpc("replace_questions", { p_assessment_id: id, p_questions: UPLOAD.questions }).then(function (r) {
    if (r.error) { hideLoader(); toast(friendlyError(r.error), "err"); return; }
    var count = r.data;
    var newVersion = a.version + 1;
    logActivity("uploaded_questions", id, { count: count, version: newVersion, file: UPLOAD.fileName });
    if (UPLOAD._rawFile) {
      var path = ADMIN.user.id + "/" + id + "/v" + newVersion + "/" + UPLOAD.fileName;
      db.storage.from("assessment-files").upload(path, UPLOAD._rawFile, { upsert: true }).then(function (up) {
        if (!up.error) db.from("uploaded_files").insert({ assessment_id: id, admin_id: ADMIN.user.id, file_name: UPLOAD.fileName, storage_path: path }).then(function () {});
        hideLoader(); toast("Imported " + count + " questions (v" + newVersion + ")", "ok");
        // after import, reload the questions page so the admin can optionally add images
        go("questions", id);
      });
    } else {
      hideLoader(); toast("Imported " + count + " questions", "ok"); go("questions", id);
    }
  });
}
// render a section below the dropzone for uploading images per question
// only shown for baseline / endline / eoca after questions have been imported
function renderImageUploadSection(a) {
  var hasImages = ["baseline", "endline", "eoca"].indexOf(a.assessment_type) !== -1;
  if (!hasImages) return;
  showLoader("Loading questions for image assignment...");
  db.from("active_questions").select("*").eq("assessment_id", a.id).eq("assessment_version", a.version).order("no").then(function (r) {
    hideLoader();
    var qs = r.data || [];
    if (!qs.length) return;
    var rows = qs.map(function (q) {
      var hasImg = !!q.image_url;
      return '<tr>'
        + '<td class="tnum">' + escHtml(q.no || "") + '</td>'
        + '<td style="max-width:260px">' + escHtml(q.q_stem) + '</td>'
        + '<td>' + (hasImg ? '<img src="' + escAttr(q.image_url) + '" style="height:40px;border-radius:4px"> <span class="pill live">Image set</span>' : '<span class="muted small">No image</span>') + '</td>'
        + '<td><label class="btn ghost sm" style="cursor:pointer">Upload<input type="file" accept="image/*" style="display:none" onchange="uploadQuestionImage(\'' + q.id + '\',this)"></label>'
        + (hasImg ? ' <button class="btn danger sm" onclick="clearQuestionImage(\'' + q.id + '\')">Remove</button>' : '')
        + '</td></tr>';
    }).join("");
    var section = document.createElement("div");
    section.className = "card pad";
    section.style.marginTop = "20px";
    section.innerHTML = '<h3 style="margin-bottom:12px">Question images (optional)</h3>'
      + '<p class="muted small" style="margin-bottom:12px">Upload an image for any question. Images are shown to respondents above the question text.</p>'
      + '<table><thead><tr><th>#</th><th>Question</th><th>Current image</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table>';
    var main = document.querySelector(".main");
    if (main) main.appendChild(section);
  });
}
// upload one question image to storage and save its public URL to the question row
function uploadQuestionImage(questionId, input) {
  var file = input.files[0];
  if (!file) return;
  var a = ADMIN._assessment;
  var path = ADMIN.user.id + "/" + a.id + "/images/" + questionId + "_" + file.name;
  showLoader("Uploading image...");
  db.storage.from("assessment-files").upload(path, file, { upsert: true }).then(function (up) {
    if (up.error) { hideLoader(); toast("Image upload failed: " + up.error.message, "err"); return; }
    // get a public URL for the uploaded image
    var pub = db.storage.from("assessment-files").getPublicUrl(path);
    var url = pub.data && pub.data.publicUrl;
    if (!url) { hideLoader(); toast("Could not get image URL", "err"); return; }
    // save the URL to the question row
    db.from("questions").update({ image_url: url }).eq("id", questionId).then(function (r2) {
      hideLoader();
      if (r2.error) { toast(friendlyError(r2.error), "err"); return; }
      toast("Image saved", "ok");
      // reload the image section to reflect the change
      ADMIN._assessment = a;
      renderImageUploadSection(a);
    });
  });
}
// clear a question's image URL
function clearQuestionImage(questionId) {
  showLoader("Removing image...");
  db.from("questions").update({ image_url: null }).eq("id", questionId).then(function (r) {
    hideLoader();
    if (r.error) { toast(friendlyError(r.error), "err"); return; }
    toast("Image removed", "ok");
    renderImageUploadSection(ADMIN._assessment);
  });
}
function downloadTemplate() {
  var a = ADMIN._assessment;
  var isWpca  = a && a.assessment_type === "wpca";
  var isWpcas = a && a.assessment_type === "wpcas";
  var headers, sample;
  if (isWpcas) {
    // wpcas template: only need question number and stem; Yes/No are auto-added
    headers = ["no", "q_competency", "q_stem"];
    sample = [
      [1, "Leadership", "The respondent communicates decisions clearly to the team."],
      [2, "Integrity", "The respondent demonstrates consistent ethical behaviour."]
    ];
  } else if (isWpca) {
    headers = ["no", "q_competency", "q_facet", "q_stem", "opt1", "opt2", "opt3", "opt4", "opt5", "marks"];
    sample = [
      [1, "Collaboration", "Teamwork", "Shares information openly with the team.", "1 - Rarely", "2 - Sometimes", "3 - Often", "4 - Usually", "5 - Always", 5],
      [2, "Communication", "Clarity", "Explains complex ideas clearly.", "1 - Rarely", "2 - Sometimes", "3 - Often", "4 - Usually", "5 - Always", 5]
    ];
  } else {
    headers = ["no", "q_type", "q_level", "q_competency", "q_facet", "q_stem", "opt1", "opt2", "opt3", "opt4", "opt5", "isopt1correct", "isopt2correct", "isopt3correct", "isopt4correct", "isopt5correct", "marks"];
    sample = [
      [1, "mcqsca", "basic", "Data", "Central tendency", "Which measure is most robust to outliers?", "Mean", "Median", "Mode", "Range", "", false, true, false, false, false, 1],
      [2, "tf", "basic", "Stats", "p-values", "A p-value of 0.04 means a 96% chance the alternative is true.", "True", "False", "", "", "", false, true, false, false, false, 1],
      [3, "mcqmca", "intermediate", "Data", "Charts", "Which are good for distributions? (select all)", "Histogram", "Box plot", "Pie chart", "Scatter", "", true, true, false, false, false, 2]
    ];
  }
  var ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
  var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, isWpcas ? "WPCAS Questions" : isWpca ? "Rating items" : "Questions");
  XLSX.writeFile(wb, isWpcas ? "cegis_wpcas_template.xlsx" : isWpca ? "cegis_wpca_template.xlsx" : "cegis_question_template.xlsx");
}

// extended validation: adds support for wpcas (yesno) and wpcas flag
function validateQuestion(q, isWpca, isWpcas) {
  // wpcas items just need a question stem; options are forced to Yes/No
  if (isWpcas) {
    if (!q.q_stem || !q.q_stem.trim()) return { level: "err", msg: "q_stem is required" };
    return { level: "ok", msg: "" };
  }
  // wpca rating items just need a stem
  if (isWpca) {
    if (!q.q_stem || !q.q_stem.trim()) return { level: "err", msg: "q_stem is required" };
    var opts = [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5].filter(function (o) { return o; });
    if (!opts.length) return { level: "warn", msg: "No scale points — will render without options" };
    return { level: "ok", msg: "" };
  }
  // standard objective question validation
  if (!q.q_stem || !q.q_stem.trim()) return { level: "err", msg: "q_stem is required" };
  var allowedTypes = ["mcqsca", "mcqmca", "tf"];
  if (allowedTypes.indexOf(q.q_type) === -1) return { level: "err", msg: "q_type must be mcqsca, mcqmca or tf" };
  var options = [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5].filter(function (o) { return o; });
  if (options.length < 2) return { level: "err", msg: "Need at least 2 options" };
  var correctFlags = [q.isopt1correct, q.isopt2correct, q.isopt3correct, q.isopt4correct, q.isopt5correct];
  var numCorrect = correctFlags.filter(function (f) { return f; }).length;
  if (q.q_type === "mcqsca" && numCorrect !== 1) return { level: "err", msg: "mcqsca needs exactly 1 correct option" };
  if (q.q_type === "tf"     && numCorrect !== 1) return { level: "err", msg: "tf needs exactly 1 correct option" };
  if (q.q_type === "mcqmca" && numCorrect < 1)  return { level: "warn", msg: "mcqmca has no correct options marked" };
  return { level: "ok", msg: "" };
}

// ---------------------------------------------------------------- results (admin)
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
  var done = all.filter(function (x) { return x.is_completed; });
  if (!all.length) {
    shell(resultsHead(a) + '<div class="card pad" style="text-align:center;padding:48px">'
      + '<div style="font-size:38px">&#9716;</div><h3 style="margin:10px 0 4px">No respondents yet</h3>'
      + '<p class="muted">Share the link to start collecting responses.</p></div>');
    return;
  }
  var pcts = done.map(function (x) { return Number(x.score_percent || 0); });
  var avg = pcts.length ? Math.round(pcts.reduce(function (s, v) { return s + v; }, 0) / pcts.length) : 0;
  var hi = pcts.length ? Math.max.apply(null, pcts) : 0;
  var lo = pcts.length ? Math.min.apply(null, pcts) : 0;
  var passable = done.filter(function (x) { return x.is_passed != null; });
  var passed   = passable.filter(function (x) { return x.is_passed; }).length;
  var passRate = passable.length ? Math.round((passed / passable.length) * 100) + "%" : "—";

  var tiles = '<div class="tiles grid" style="grid-template-columns:repeat(5,1fr);margin-bottom:18px">'
    + tile(all.length, "Respondents") + tile(done.length, "Completed")
    + tile(avg + "%", "Average") + tile(passRate, "Pass rate") + tile(hi + "% / " + lo + "%", "High / low") + '</div>';

  var charts = '<div class="grid" style="grid-template-columns:1fr;margin-bottom:18px">'
    + '<div class="card pad"><h3 style="margin-bottom:10px">Score distribution</h3>' + histogram(pcts) + '</div></div>';

  var rows = all.map(function (x) {
    var flags = CACHE.flagCounts[x.id] || 0;
    var status = !x.is_completed ? '<span class="pill sched">In progress</span>'
      : x.is_passed === true  ? '<span class="pill live">Passed</span>'
      : x.is_passed === false ? '<span class="badge err">Failed</span>'
      : '<span class="pill closed">Done</span>';
    return '<tr><td><b>' + escHtml(x.full_name) + '</b><div class="muted small">' + escHtml(x.email) + '</div></td>'
      + '<td>' + escHtml(x.organization || "—") + '</td>'
      + '<td class="tnum">' + (x.score_percent != null ? x.score_percent + "%" : "—") + '</td>'
      + '<td>' + status + '</td>'
      + '<td class="tnum">' + fmtDuration(x.time_taken_seconds) + '</td>'
      + '<td>' + (flags ? '<span class="badge warn">! ' + flags + '</span>' : '<span class="muted small">0</span>') + '</td>'
      + '<td><button class="btn ghost sm" ' + (x.is_completed ? "" : "disabled") + ' onclick="respondentDetail(\'' + x.id + '\')">View</button></td></tr>';
  }).join("");
  var table = '<div class="card"><div class="pad flex jb ac" style="border-bottom:1px solid var(--n200)"><h3>Respondents</h3>'
    + '<button class="btn ghost sm" onclick="exportResults()">Export to Excel</button></div>'
    + '<table><thead><tr><th>Name</th><th>Organisation</th><th>Score</th><th>Status</th><th>Time</th><th>Flags</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';

  shell(resultsHead(a) + tiles + charts + table);
}
function resultsHead(a) {
  var backCrumb = a.instance_id
    ? '<a href="#" onclick="go(\'instance\',\'' + a.instance_id + '\');return false">Instance</a> / '
    : '<a href="#" onclick="go(\'dashboard\');return false">Library</a> / ';
  return '<div class="crumb">' + backCrumb + '<a href="#" onclick="go(\'detail\',\'' + a.id + '\');return false">' + escHtml(a.title) + '</a> / Results</div>'
    + '<div class="page-head"><h1>Results &mdash; ' + escHtml(a.title) + '</h1>'
    + '<button class="btn ghost" onclick="copyLink(\'' + a.id + '\')">Copy link</button></div>';
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
        var mark = q.is_correct === true ? '<span class="badge ok">v</span>' : q.is_correct === false ? '<span class="badge err">x</span>' : '<span class="muted small">—</span>';
        return '<tr><td class="tnum">' + escHtml(q.no || "") + '</td><td style="max-width:260px">' + escHtml(q.q_stem) + '</td>'
          + '<td class="muted small">' + escHtml(q.q_competency || "—") + '</td>'
          + '<td class="tnum">' + sel + '</td><td class="tnum">' + key + '</td><td>' + mark + '</td></tr>';
      }).join("");
      var secRows = (sec.data || []).length
        ? (sec.data || []).map(function (s) { return '<div class="kv"><span>' + escHtml(s.event_type.replace(/_/g, " ")) + '</span><b>' + fmtDate(s.logged_at) + '</b></div>'; }).join("")
        : '<p class="muted small">No security events logged.</p>';
      showModal({
        title: d.full_name + " — breakdown",
        body: '<div class="muted small" style="margin-bottom:10px">' + escHtml(d.email) + ' &middot; score <b>' + d.score_percent + '%</b> (' + d.score_raw + ' correct)' + (d.is_passed != null ? ' &middot; ' + (d.is_passed ? "passed" : "failed") : "") + '</div>'
          + '<div style="max-height:300px;overflow:auto;border:1px solid var(--n200);border-radius:8px"><table><thead><tr><th>#</th><th>Question</th><th>Competency</th><th>Chose</th><th>Key</th><th>Correct</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
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
        (resp.selected_options || []).join(", "), resp.is_correct == null ? "—" : (resp.is_correct ? "yes" : "no")];
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
    + '<p class="muted small">Soft delete is enforced at the database level. Respondent records are never removed. '
    + 'Scores are calculated inside the database so the browser never sends a score.</p></div>'
    + '</div>';
}

// ---------------------------------------------------------------- small builders
function tile(v, l) { return '<div class="tile"><div class="v tnum">' + v + '</div><div class="l">' + l + '</div></div>'; }
function kv(k, v) { return '<div class="kv"><span class="muted">' + k + '</span><b>' + v + '</b></div>'; }
function escAttr(s) { return escHtml(s).replace(/'/g, "&#39;"); }
function errCard(err) {
  return '<div class="card pad" style="border-color:var(--red);background:var(--red-l)"><h3 style="color:var(--red-d)">Something went wrong</h3>'
    + '<p class="muted small" style="margin-top:8px">' + escHtml(friendlyError(err)) + '</p></div>';
}

// ============================================================================
// ACCESS KEYS
// ============================================================================
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
// INSTANCES (programs / cycles)
// The primary landing and organising unit. Admins start here.
// ============================================================================
function loadInstances() {
  showLoader();
  db.from("active_instances").select("*").order("created_at", { ascending: false }).then(function (r) {
    hideLoader();
    if (r.error) { shell(errCard(r.error)); return; }
    CACHE.instances = r.data || [];
    var rows = CACHE.instances.length ? CACHE.instances.map(function (i) {
      var livePill = i.is_live ? '<span class="pill live">Live</span>' : '<span class="pill sched">Draft</span>';
      return '<tr onclick="go(\'instance\',\'' + i.id + '\')" style="cursor:pointer">'
        + '<td><b>' + escHtml(i.name) + '</b><div class="muted small">' + escHtml(i.description || "") + '</div></td>'
        + '<td>' + livePill + '</td>'
        + '<td class="muted small">' + (i.nomination_opens_at ? fmtDate(i.nomination_opens_at) : "—") + '</td>'
        + '<td class="muted small">' + (i.rating_opens_at ? fmtDate(i.rating_opens_at) : "—") + '</td></tr>';
    }).join("") : '<tr><td colspan="4" class="muted" style="padding:20px;text-align:center">No instances yet. Create one to get started.</td></tr>';
    shell('<div class="page-head"><h1>Instances</h1><button class="btn" onclick="instanceForm(null)">+ New instance</button></div>'
      + '<p class="muted" style="margin-bottom:18px">Each instance is one cycle or programme. It groups respondents, assessments, and WPCAS reviews together.</p>'
      + '<div class="card"><table><thead><tr><th>Name</th><th>Status</th><th>Nominations open</th><th>Ratings open</th></tr></thead><tbody>' + rows + '</tbody></table></div>');
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
    + '<div class="field"><label class="label">Name</label><input class="input" id="i-name" value="' + escAttr(v("name")) + '" placeholder="e.g. District Officers Programme 2026"></div>'
    + '<div class="field"><label class="label">Description (optional)</label><textarea class="input" id="i-desc" placeholder="What this cycle covers.">' + escHtml(v("description")) + '</textarea></div>'
    + '<h3 style="margin:18px 0 10px;font-size:14px">Nomination window (when respondents pick their peers)</h3>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Nominations open</label><input class="input" id="i-nom-open" type="datetime-local" value="' + dt("nomination_opens_at") + '"></div>'
    + '<div class="field"><label class="label">Nominations close</label><input class="input" id="i-nom-close" type="datetime-local" value="' + dt("nomination_closes_at") + '"></div></div>'
    + '<h3 style="margin:18px 0 10px;font-size:14px">Rating window (when WPCAS reviews happen)</h3>'
    + '<div class="row2">'
    + '<div class="field"><label class="label">Ratings open</label><input class="input" id="i-rate-open" type="datetime-local" value="' + dt("rating_opens_at") + '"></div>'
    + '<div class="field"><label class="label">Ratings close</label><input class="input" id="i-rate-close" type="datetime-local" value="' + dt("rating_closes_at") + '"></div></div>'
    + '<div class="muted small" style="margin-top:14px;padding:10px;background:var(--n50);border-radius:6px">'
    + 'Individual assessment activation windows are set on each assessment separately. The "Go Live" button launches the instance once everything is ready.</div>'
    + '<div class="flex g12" style="margin-top:18px"><button class="btn ghost" onclick="go(\'instances\')">Cancel</button>'
    + '<button class="btn" onclick="saveInstance(' + (isEdit ? '\'' + inst.id + '\'' : "null") + ')">' + (isEdit ? "Save changes" : "Create instance") + '</button></div></div>');
}
function saveInstance(id) {
  function dv(x) { var e = document.getElementById(x).value; return e ? e : null; }
  var name = document.getElementById("i-name").value.trim();
  if (!name) { toast("Please enter a name", "err"); return; }
  var form = {
    name: name, description: document.getElementById("i-desc").value.trim() || null,
    nomination_opens_at: dv("i-nom-open"), nomination_closes_at: dv("i-nom-close"),
    rating_opens_at: dv("i-rate-open"), rating_closes_at: dv("i-rate-close")
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
  var tabs = [["overview", "Overview"], ["respondents", "Respondents"], ["assessments", "Assessments"], ["panels", "Panels & WPCAS raters"], ["reports", "WPCAS reports"]];
  var tabBar = '<div class="auth-tabs" style="margin-bottom:16px">' + tabs.map(function (t) {
    return '<button class="auth-tab ' + (ADMIN._itab === t[0] ? "active" : "") + '" onclick="instTab(\'' + t[0] + '\')">' + t[1] + '</button>';
  }).join("") + '</div>';
  var body = ADMIN._itab === "assessments" ? instAssessmentsTab()
    : ADMIN._itab === "respondents"  ? instParticipantsTab()
    : ADMIN._itab === "panels"       ? instPanelsTab()
    : ADMIN._itab === "reports"      ? instReportsTab()
    : instOverviewTab();
  shell('<div class="crumb"><a href="#" onclick="go(\'instances\');return false">Instances</a> / ' + escHtml(inst.name) + '</div>'
    + '<div class="page-head"><h1>' + escHtml(inst.name) + '</h1>'
    + '<div class="flex g8 wrap">'
    + '<button class="btn ghost" id="instEditBtn">Edit</button>'
    + (inst.is_live
        ? '<button class="btn ghost" onclick="goLiveInstance(false)">Take offline</button>'
        : '<button class="btn green" onclick="goLiveInstance(true)">Go live</button>')
    + '</div></div>'
    + tabBar + body);
  var eb = document.getElementById("instEditBtn");
  if (eb) eb.onclick = function () { instanceForm(ADMIN._inst); };
  if (ADMIN._itab === "respondents") wireParticipantDrop();
}
// toggle the is_live flag on the instance
function goLiveInstance(live) {
  var msg = live
    ? "Going live will make this instance active. Respondents will be able to log in and access assessments based on their scheduled windows. Continue?"
    : "Taking this instance offline will hide it from respondents. Assessments already submitted are not affected.";
  showModal({
    title: live ? "Go live?" : "Take offline?",
    body: msg, confirm: live ? "Go live" : "Take offline",
    onConfirm: function () {
      closeModal(); showLoader(live ? "Going live..." : "Taking offline...");
      db.from("instances").update({ is_live: live, is_active: live }).eq("id", ADMIN._instId).then(function (r) {
        hideLoader();
        if (r.error) { toast(friendlyError(r.error), "err"); return; }
        toast(live ? "Instance is now live" : "Instance taken offline", "ok");
        loadInstance(ADMIN._instId);
      });
    }
  });
}
function instOverviewTab() {
  var i = ADMIN._inst;
  var wpcas = ADMIN._instAssessments.filter(function (a) { return a.assessment_type === "wpcas"; });
  var others = ADMIN._instAssessments.filter(function (a) { return a.assessment_type !== "wpcas"; });
  // readiness checklist for going live
  var hasRespondents = ADMIN._participants.length > 0;
  var hasWpcas = wpcas.length > 0;
  var hasAssessments = others.length > 0;
  var allReady = hasRespondents && hasWpcas && hasAssessments;
  var checkItem = function (ok, label) {
    return '<div class="flex ac g8" style="margin:6px 0"><span style="font-size:16px;color:' + (ok ? 'var(--green)' : 'var(--n400)') + '">' + (ok ? 'v' : 'o') + '</span><span class="muted small">' + label + '</span></div>';
  };
  return '<div class="grid" style="grid-template-columns:1fr 1fr">'
    + '<div class="card pad"><h3 style="margin-bottom:12px">Cycle windows</h3>'
    + kv("Status", i.is_live ? '<span class="pill live">Live</span>' : '<span class="pill closed">Draft</span>')
    + kv("Nominations open", i.nomination_opens_at ? fmtDate(i.nomination_opens_at) : "—")
    + kv("Nominations close", i.nomination_closes_at ? fmtDate(i.nomination_closes_at) : "—")
    + kv("Ratings open", i.rating_opens_at ? fmtDate(i.rating_opens_at) : "—")
    + kv("Ratings close", i.rating_closes_at ? fmtDate(i.rating_closes_at) : "—")
    + kv("Respondents", ADMIN._participants.length)
    + kv("WPCAS instruments", wpcas.length)
    + kv("Other assessments", others.length)
    + '</div>'
    + '<div class="card pad"><h3 style="margin-bottom:12px">Go-live checklist</h3>'
    + checkItem(hasRespondents, "Respondents uploaded")
    + checkItem(hasWpcas, "WPCAS instrument created")
    + checkItem(hasAssessments, "At least one other assessment added")
    + '<p class="muted small" style="margin-top:12px">'
    + (allReady ? 'Everything looks ready. Click "Go live" above when you are set.' : 'Complete the items above before going live.')
    + '</p></div></div>';
}
function instAssessmentsTab() {
  var aRows = ADMIN._instAssessments.length ? ADMIN._instAssessments.map(function (a) {
    var rc = 0; // respondent counts not pre-loaded here; link to detail for that
    var statusPill = a.is_active ? '<span class="pill live">Active</span>' : '<span class="pill closed">Inactive</span>';
    var window_ = "";
    if (a.active_from || a.active_until) {
      window_ = '<div class="muted small" style="margin-top:2px">'
        + (a.active_from  ? "From: " + new Date(a.active_from).toLocaleString()  : "")
        + (a.active_from && a.active_until ? " &rarr; " : "")
        + (a.active_until ? new Date(a.active_until).toLocaleString() : "")
        + '</div>';
    }
    return '<tr>'
      + '<td><b style="cursor:pointer" onclick="go(\'detail\',\'' + a.id + '\')">' + escHtml(a.title) + '</b>'
      + window_
      + '</td>'
      + '<td>' + typeLabel(a.assessment_type) + '</td>'
      + '<td>' + statusPill + '</td>'
      + '<td><div class="flex g8 wrap">'
      + '<button class="btn ghost sm" onclick="go(\'questions\',\'' + a.id + '\')">Questions</button>'
      + '<button class="btn ghost sm" onclick="go(\'results\',\'' + a.id + '\')">Results</button>'
      + '<button class="btn ' + (a.is_active ? "ghost" : "green") + ' sm" onclick="toggleActive(\'' + a.id + '\',' + (!a.is_active) + ')">' + (a.is_active ? "Deactivate" : "Activate") + '</button>'
      + '</div></td></tr>';
  }).join("") : '<tr><td colspan="4" class="muted" style="padding:18px;text-align:center">No assessments yet. Add one below.</td></tr>';
  return '<div class="card" style="margin-bottom:14px"><table><thead><tr><th>Assessment</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead><tbody>' + aRows + '</tbody></table></div>'
    + '<button class="btn" onclick="go(\'new\',\'' + ADMIN._instId + '\')">+ Add assessment to this instance</button>';
}
// participants tab (renamed "Respondents" in the UI to match terminology)
function instParticipantsTab() {
  var creds = ADMIN._lastCreds;
  var credsBlock = "";
  if (creds && creds.length) {
    var crows = creds.map(function (c) {
      return '<tr><td>' + escHtml(c.full_name) + '</td><td>' + escHtml(c.email) + '</td><td><span style="font-family:ui-monospace,monospace">' + escHtml(c.password) + '</span></td></tr>';
    }).join("");
    credsBlock = '<div class="card pad" style="margin-bottom:14px;border-left:4px solid var(--green)">'
      + '<div class="flex jb ac wrap" style="gap:10px"><h3>New sign-in credentials (' + creds.length + ')</h3>'
      + '<button class="btn green sm" onclick="exportCreds()">Export credentials (.xlsx)</button></div>'
      + '<p class="muted small" style="margin:6px 0 10px">Passwords are shown only once. Export and share them with each respondent along with the portal link. You can reset a password later but cannot view it again.</p>'
      + '<div style="max-height:260px;overflow:auto"><table><thead><tr><th>Name</th><th>Email</th><th>Password</th></tr></thead><tbody>' + crows + '</tbody></table></div></div>';
  }
  var plist = ADMIN._participants.length ? ADMIN._participants.map(function (p) {
    return '<tr><td><b>' + escHtml(p.full_name) + '</b><div class="muted small">' + escHtml([p.designation, p.department, p.location].filter(Boolean).join(" · ")) + '</div></td>'
      + '<td class="muted small">' + escHtml(p.email) + '</td>'
      + '<td>' + (p.panel_submitted ? '<span class="pill live">Panel set</span>' : '<span class="pill sched">Awaiting panel</span>') + '</td>'
      + '<td><button class="btn ghost sm" onclick="resetPwd(\'' + p.id + '\',\'' + escAttr(p.full_name) + '\')">Reset password</button></td></tr>';
  }).join("") : '<tr><td colspan="4" class="muted" style="padding:18px;text-align:center">No respondents yet. Upload an Excel file to add them.</td></tr>';
  return credsBlock
    + '<div class="card pad" style="margin-bottom:14px">'
    + '<div class="flex jb ac wrap" style="margin-bottom:10px"><h3>Upload respondents (.xlsx)</h3>'
    + '<span class="tag">full_name &middot; email &middot; employee_id &middot; designation &middot; department &middot; location &middot; workstream &middot; reporting_manager_email</span></div>'
    + '<p class="muted small" style="margin-bottom:10px">A password is auto-generated for each new person. Existing emails are skipped. <b>location</b> is used for the WPCAS auto-rater logic (same-city vs different-city peers).</p>'
    + '<div class="dz" id="pdz"><div style="font-size:30px">&#x21A7;</div><div style="font-weight:600;margin-top:6px">Drop the respondents file here, or click to choose</div></div>'
    + '<input type="file" id="pFileInput" accept=".xlsx,.xls" style="display:none">'
    + '<div class="muted small" style="margin-top:10px;cursor:pointer;color:var(--blue)" onclick="downloadParticipantTemplate()">Download respondent template</div></div>'
    + '<div class="card"><table><thead><tr><th>Respondent</th><th>Email</th><th>Panel</th><th></th></tr></thead><tbody>' + plist + '</tbody></table></div>';
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
      toast("Added " + r.data.created_count + " respondent(s)" + (r.data.skipped ? ", skipped " + r.data.skipped + " existing" : ""), "ok");
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
  XLSX.writeFile(wb, "respondent_credentials.xlsx");
  toast("Credentials exported", "ok");
}
function downloadParticipantTemplate() {
  var headers = ["full_name", "email", "employee_id", "designation", "department", "location", "workstream", "reporting_manager_email"];
  var sample = [["Asha Rao", "asha.rao@example.gov.in", "EMP001", "Section Officer", "Revenue", "Pune", "Land Records", "manager1@example.gov.in"]];
  var ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
  var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Respondents");
  XLSX.writeFile(wb, "cegis_respondents_template.xlsx");
}
function resetPwd(id, name) {
  showModal({
    title: "Reset password?", body: "A new password will be generated for <b>" + escHtml(name) + "</b> and shown once. Their current password stops working.",
    confirm: "Reset", onConfirm: function () {
      closeModal(); showLoader("Resetting...");
      db.rpc("reset_participant_password", { p_participant_id: id }).then(function (r) {
        hideLoader();
        if (r.error) { toast(friendlyError(r.error), "err"); return; }
        showModal({ title: "New password for " + escHtml(name), body: '<p class="muted small" style="margin-bottom:8px">Share this with the respondent. It will not be shown again.</p><div class="link-box" style="font-family:ui-monospace,monospace;font-size:16px">' + escHtml(r.data) + '</div>', confirm: null });
      });
    }
  });
}

// ---- panels & WPCAS raters tab -------------------------------------------
// This tab handles finalising raters for WPCAS reviews.
// The admin can auto-assign (1 manager + 2 same-city peers + 1 diff-city peer)
// or manually tick nominations per respondent.
function instPanelsTab() {
  var subjOpts = '<option value="">Choose a respondent...</option>' + ADMIN._participants.map(function (p) {
    return '<option value="' + p.id + '"' + (ADMIN._panelSubject === p.id ? " selected" : "") + '>' + escHtml(p.full_name) + '</option>';
  }).join("");
  var wpcas = ADMIN._instAssessments.filter(function (a) { return a.assessment_type === "wpcas"; });
  var wpcasOpts = '<option value="">Choose a WPCAS instrument...</option>' + wpcas.map(function (a) {
    return '<option value="' + a.id + '"' + (ADMIN._panelAssessment === a.id ? " selected" : "") + '>' + escHtml(a.title) + '</option>';
  }).join("");
  var panel = '<div class="card pad" style="margin-bottom:14px"><div class="row2">'
    + '<div class="field"><label class="label">Subject (person being reviewed)</label><select class="input" id="pn-subject" onchange="ADMIN._panelSubject=this.value;loadNominations()">' + subjOpts + '</select></div>'
    + '<div class="field"><label class="label">WPCAS instrument</label><select class="input" id="pn-assessment" onchange="ADMIN._panelAssessment=this.value">' + wpcasOpts + '</select></div></div>'
    + (wpcas.length ? "" : '<p class="muted small" style="color:var(--red)">No WPCAS instrument in this instance yet. Create one from the Assessments tab first.</p>') + '</div>';
  return panel + '<div id="nomArea">' + (ADMIN._panelSubject ? '<p class="muted small">Loading nominations...</p>' : '<p class="muted small">Pick a respondent to see their nominated raters.</p>') + '</div>';
}
function loadNominations() {
  if (!ADMIN._panelSubject) { document.getElementById("nomArea").innerHTML = ""; return; }
  var area = document.getElementById("nomArea");
  area.innerHTML = '<p class="muted small">Loading nominations...</p>';
  Promise.all([
    db.rpc("subject_nominations", { p_subject_id: ADMIN._panelSubject }),
    db.from("active_rater_assignments").select("*").eq("subject_id", ADMIN._panelSubject)
  ]).then(function (r) {
    if (r[0].error) { area.innerHTML = errCard(r[0].error); return; }
    var noms = r[0].data || [], assigns = (r[1].data || []);
    ADMIN._noms = noms;
    var nrows = noms.length ? noms.map(function (n) {
      return '<tr><td><input type="checkbox" class="nomck" value="' + n.id + '"' + (n.is_finalized ? " checked disabled" : "") + '></td>'
        + '<td><b>' + escHtml(n.rater_name || n.rater_email) + '</b><div class="muted small">' + escHtml(n.rater_email) + '</div></td>'
        + '<td><span class="tag">' + escHtml(n.relationship) + '</span></td>'
        + '<td>' + (n.is_finalized ? '<span class="pill live">Finalised</span>' : '<span class="muted small">nominated</span>') + '</td></tr>';
    }).join("") : '<tr><td colspan="4" class="muted" style="padding:16px;text-align:center">This respondent has not nominated anyone yet.</td></tr>';
    var arows = assigns.length ? assigns.map(function (a) {
      return '<tr><td>' + escHtml(a.rater_name || a.rater_email) + '</td><td><span class="tag">' + escHtml(a.relationship) + '</span></td>'
        + '<td><span style="font-family:ui-monospace,monospace">' + escHtml(a.access_key) + '</span></td>'
        + '<td>' + (a.is_completed ? '<span class="pill live">Done</span>' : '<span class="pill sched">Pending</span>') + '</td>'
        + '<td><button class="btn ghost sm" onclick="copyKey(\'' + escAttr(a.access_key) + '\')">Copy key link</button></td></tr>';
    }).join("") : "";
    var assignBlock = assigns.length ? '<div class="card pad" style="margin-top:14px"><h3 style="margin-bottom:10px">Finalised raters and their keys</h3>'
      + '<p class="muted small" style="margin-bottom:8px">Share each key link with the rater, or they will see the task in their portal.</p>'
      + '<table><thead><tr><th>Rater</th><th>Relationship</th><th>Key</th><th>Status</th><th></th></tr></thead><tbody>' + arows + '</tbody></table></div>' : "";
    // show both auto and manual finalise options
    area.innerHTML = '<div class="card pad"><div class="flex jb ac wrap" style="margin-bottom:10px">'
      + '<h3>Nominated raters</h3>'
      + '<div class="flex g8 wrap">'
      + '<button class="btn ghost sm" onclick="doAutoFinalize()" title="Auto: 1 manager + 2 same-city peers + 1 different-city peer">Auto-select (1 mgr + 3 peers)</button>'
      + '<button class="btn green sm" onclick="doFinalize()">Finalise selected</button>'
      + '</div></div>'
      + '<p class="muted small" style="margin-bottom:10px">Tick the people who should review this respondent on the selected WPCAS instrument, then click "Finalise selected". Or use "Auto-select" to apply the 1 manager + 2 same-city peers + 1 different-city peer rule automatically.</p>'
      + '<table><thead><tr><th></th><th>Rater</th><th>Relationship</th><th>Status</th></tr></thead><tbody>' + nrows + '</tbody></table></div>'
      + assignBlock;
  });
}
// manually finalise selected nominations
function doFinalize() {
  if (!ADMIN._panelSubject) { toast("Choose a respondent first", "err"); return; }
  var aid = document.getElementById("pn-assessment").value;
  if (!aid) { toast("Choose a WPCAS instrument first", "err"); return; }
  var ids = Array.prototype.slice.call(document.querySelectorAll(".nomck:checked:not(:disabled)")).map(function (c) { return c.value; });
  if (!ids.length) { toast("Select at least one nominated rater", "err"); return; }
  showLoader("Creating rater tasks...");
  db.rpc("finalize_raters", { p_subject_id: ADMIN._panelSubject, p_assessment_id: aid, p_nomination_ids: ids }).then(function (r) {
    hideLoader();
    if (r.error) { toast(friendlyError(r.error), "err"); return; }
    toast("Finalised " + r.data + " rater(s)", "ok");
    loadNominations();
  });
}
// auto-finalise using city logic: 1 manager + 2 same-city + 1 different-city peer
function doAutoFinalize() {
  if (!ADMIN._panelSubject) { toast("Choose a respondent first", "err"); return; }
  var aid = document.getElementById("pn-assessment").value;
  if (!aid) { toast("Choose a WPCAS instrument first", "err"); return; }
  showModal({
    title: "Auto-select raters?",
    body: "This will automatically select 1 manager, 2 peers from the same city as the respondent, and 1 peer from a different city. Any previously finalised raters for this respondent will be replaced.",
    confirm: "Auto-select",
    onConfirm: function () {
      closeModal(); showLoader("Auto-selecting raters...");
      db.rpc("auto_finalize_wpcas_raters", { p_subject_id: ADMIN._panelSubject, p_assessment_id: aid }).then(function (r) {
        hideLoader();
        if (r.error) { toast(friendlyError(r.error), "err"); return; }
        var d = r.data || {};
        toast("Finalised " + d.finalized + " rater(s). Manager: " + (d.manager_included ? "yes" : "no") + ", same-city peers: " + (d.same_city_peers || 0) + ", diff-city peers: " + (d.diff_city_peers || 0) + ".", "ok");
        loadNominations();
      });
    }
  });
}

// ---- WPCAS reports tab ---------------------------------------------------
function instReportsTab() {
  var subjOpts = '<option value="">Choose a respondent...</option>' + ADMIN._participants.map(function (p) {
    return '<option value="' + p.id + '"' + (ADMIN._reportSubject === p.id ? " selected" : "") + '>' + escHtml(p.full_name) + '</option>';
  }).join("");
  return '<div class="card pad" style="margin-bottom:14px"><div class="field" style="max-width:420px"><label class="label">Subject</label>'
    + '<select class="input" id="rp-subject" onchange="ADMIN._reportSubject=this.value;loadWpcaReport()">' + subjOpts + '</select></div></div>'
    + '<div id="reportArea">' + (ADMIN._reportSubject ? '<p class="muted small">Loading...</p>' : '<p class="muted small">Pick a respondent to see their WPCAS report (self vs others, per competency).</p>') + '</div>';
}
function loadWpcaReport() {
  if (!ADMIN._reportSubject) { document.getElementById("reportArea").innerHTML = ""; return; }
  var area = document.getElementById("reportArea");
  area.innerHTML = '<p class="muted small">Loading...</p>';
  db.rpc("wpca_subject_report", { p_subject_id: ADMIN._reportSubject }).then(function (r) {
    if (r.error) { area.innerHTML = errCard(r.error); return; }
    var d = r.data, comps = d.competencies || [];
    if (!comps.length) { area.innerHTML = '<div class="card pad"><p class="muted">No completed WPCAS ratings for ' + escHtml(d.subject) + ' yet.</p></div>'; return; }
    var data = comps.map(function (c) { return { label: c.competency || "General", a: Number(c.self_pct) || 0, b: Number(c.others_pct) || 0 }; });
    var rows = comps.map(function (c) {
      var gap = (Number(c.others_pct) - Number(c.self_pct)).toFixed(1);
      return '<tr><td>' + escHtml(c.competency || "General") + '</td><td class="tnum">' + c.self_pct + '%</td><td class="tnum">' + c.others_pct + '%</td><td class="tnum">' + (gap > 0 ? "+" : "") + gap + '</td></tr>';
    }).join("");
    area.innerHTML = '<div class="card pad" style="margin-bottom:14px"><div class="summary-band"><div><h2 style="margin:0">' + escHtml(d.subject) + '</h2>'
      + '<p class="muted small">WPCAS review: self rating vs the average of all other raters</p></div>'
      + '<div class="metric-tiles"><div class="mt"><div class="v tnum">' + d.overall.self_pct + '%</div><div class="l">Self</div></div>'
      + '<div class="mt"><div class="v tnum">' + d.overall.others_pct + '%</div><div class="l">Others</div></div></div></div></div>'
      + '<div class="card pad" style="margin-bottom:14px"><h3 style="margin-bottom:10px">By competency</h3>' + groupedBars(data, { a: "Self", b: "Others" }) + '</div>'
      + '<div class="card"><table><thead><tr><th>Competency</th><th>Self</th><th>Others</th><th>Gap</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  });
}

// run fn once the DOM is ready, even if that already happened
function onReady(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
  else fn();
}
