// CEGIS Assessment Platform - shared helpers used by all portals.
// Plain language, single-line comments only, since the maintainer is most
// comfortable with Python and HTML.

// ---- Supabase client ----
// Created from the values in config.js. supabase-js is loaded from the CDN.
var db = null;
function initSupabase() {
  var c = window.CEGIS_CONFIG || {};
  if (!window.supabase || !c.SUPABASE_URL || c.SUPABASE_URL.indexOf("YOUR-PROJECT") !== -1) {
    return null;
  }
  db = window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY);
  return db;
}

// the WPCAS answer scale is always the same two choices, in this fixed order:
// option 1 = "Yes", option 2 = "No". (The server scores "Yes" as the marks.)
var YESNO_OPTS = ["Yes", "No"];

// ---- small DOM + text helpers ----
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escAttr(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function initials(n) {
  return String(n || "?").trim().split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase();
}
function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}
function fmtDuration(sec) {
  if (sec == null) return "—";
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + "m " + s + "s";
}

// ---- toast ----
function toast(msg, type) {
  var holder = document.getElementById("toast");
  if (!holder) { holder = document.createElement("div"); holder.id = "toast"; document.body.appendChild(holder); }
  var t = document.createElement("div");
  t.className = "toast " + (type || "");
  t.innerHTML = (type === "ok" ? "✓ " : type === "err" ? "! " : "• ") + escHtml(msg);
  holder.appendChild(t);
  setTimeout(function () { t.remove(); }, 2800);
}

// ---- modal ----
// onConfirm is stored on window so the inline onclick can reach it.
function showModal(opts) {
  window._modalConfirm = opts.onConfirm || null;
  var root = document.getElementById("modalRoot");
  if (!root) { root = document.createElement("div"); root.id = "modalRoot"; document.body.appendChild(root); }
  var cancelLabel = opts.confirm ? "Cancel" : "Close";
  root.innerHTML =
    '<div class="modal-bg" onclick="if(event.target===this)closeModal()">'
    + '<div class="modal"><div class="mh"><h2>' + escHtml(opts.title) + '</h2></div>'
    + '<div class="mb">' + (opts.body || "") + '</div>'
    + '<div class="mf"><button class="btn ghost" onclick="closeModal()">' + cancelLabel + '</button>'
    + (opts.confirm
        ? '<button class="btn ' + (opts.danger ? "danger" : "") + '" onclick="window._modalConfirm&&window._modalConfirm()">' + escHtml(opts.confirm) + '</button>'
        : '')
    + '</div></div></div>';
}
function closeModal() { var r = document.getElementById("modalRoot"); if (r) r.innerHTML = ""; }

// ---- friendly error text ----
// Maps the database error codes from the RPCs to plain messages, so we never
// show raw Postgres or JavaScript error text to a user.
function friendlyError(err) {
  var msg = (err && (err.message || err.error_description || err.details)) || String(err || "Something went wrong");
  var map = {
    "not currently open": "This assessment is not open right now.",
    "already completed": "This email has already completed the assessment.",
    "respondent limit": "This assessment has reached its respondent limit.",
    "already submitted": "This attempt has already been submitted.",
    "Name and email are required": "Please enter your name and email.",
    "Invalid email or password": "That email or password is not correct.",
    "window is not open yet": "Your assessment window is not open yet. Please check with your administrator.",
    "at most 6 peers": "You can choose at most 6 peers."
  };
  for (var k in map) { if (msg.indexOf(k) !== -1) return map[k]; }
  // strip anything that looks like internal noise
  if (/jwt|policy|violates|relation|column|function/i.test(msg)) return "Something went wrong. Please try again.";
  return msg;
}

// =====================================================================
// EXCEL PARSING + VALIDATION  (uses the global XLSX from the CDN)
//
// Objective assessments (Baseline / Endline / EoCA) keep the original headers:
//   no, q_type, q_level, q_competency, q_facet, q_stem, opt1..opt5,
//   isopt1correct..isopt5correct, marks, and an optional image / image_url.
//
// WPCAS assessments are SIMPLER: each row is just a statement answered Yes/No.
// The only column that matters is q_stem (plus optional no, q_competency,
// q_facet, marks). We force q_type = 'yesno' and ignore any options column.
// =====================================================================
function normHeader(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim(); }

function truthy(v) {
  var s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1" || s === "correct" || s === "t";
}

// turn a parsed worksheet (array of row objects) into normalised question rows
function parseQuestionRows(rows) {
  return rows.map(function (raw) {
    // build a header-normalised lookup so spacing/case in headers does not matter
    var map = {};
    Object.keys(raw).forEach(function (k) { map[normHeader(k)] = raw[k]; });
    function g(name) { var v = map[normHeader(name)]; return v == null ? "" : String(v).trim(); }
    var q = {
      no: g("no") || g("questionno") || g("qno"),
      q_type: (g("q_type") || g("qtype") || g("questiontype")).toLowerCase(),
      q_level: g("q_level") || g("level"),
      q_competency: g("q_competency") || g("competency"),
      q_facet: g("q_facet") || g("facet"),
      q_stem: g("q_stem") || g("questiontext") || g("question") || g("statement") || g("stem"),
      // optional image: either a full URL the admin pasted, or a file name they
      // will upload later (admin.js resolves names to uploaded URLs).
      image_url: g("image_url") || g("imageurl") || g("image"),
      opt1: g("opt1"), opt2: g("opt2"), opt3: g("opt3"), opt4: g("opt4"), opt5: g("opt5"),
      marks: (function () { var m = parseFloat(g("marks")); return isNaN(m) ? 0 : m; })(),
      isopt1correct: truthy(map[normHeader("isopt1correct")]),
      isopt2correct: truthy(map[normHeader("isopt2correct")]),
      isopt3correct: truthy(map[normHeader("isopt3correct")]),
      isopt4correct: truthy(map[normHeader("isopt4correct")]),
      isopt5correct: truthy(map[normHeader("isopt5correct")])
    };
    // normalise common type spellings
    var t = q.q_type.replace(/[^a-z]/g, "");
    if (t === "mcqsca" || t === "sca" || t === "single") q.q_type = "mcqsca";
    else if (t === "mcqmca" || t === "mca" || t === "multi" || t === "multiple") q.q_type = "mcqmca";
    else if (t === "tf" || t === "truefalse" || t === "boolean") q.q_type = "tf";
    else if (t === "yesno" || t === "yn" || t === "yesorno") q.q_type = "yesno";
    return q;
  });
}

// validate one normalised question; returns {level:'ok'|'warn'|'err', msg}
// pass isWpca=true for a WPCAS assessment, where every item is a Yes/No statement
function validateQuestion(q, isWpca) {
  if (!q.q_stem) return { level: "err", msg: "Question text is empty" };
  if (isWpca) {
    // WPCAS: only the statement matters; options are fixed to Yes / No
    if (q.q_type && q.q_type !== "yesno") return { level: "warn", msg: "WPCAS items are Yes/No; type will be set to yesno" };
    if (!q.q_competency) return { level: "warn", msg: "No competency set — results will group under 'General'" };
    return { level: "ok", msg: "Valid Yes/No item" };
  }
  // objective items
  var opts = [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5].filter(function (o) { return o && o.length; });
  if (["mcqsca", "mcqmca", "tf"].indexOf(q.q_type) === -1)
    return { level: "err", msg: "Unknown type '" + (q.q_type || "blank") + "' (use mcqsca, mcqmca, tf)" };
  var keys = [q.isopt1correct, q.isopt2correct, q.isopt3correct, q.isopt4correct, q.isopt5correct];
  var correctCount = keys.filter(Boolean).length;
  if (q.q_type === "mcqsca") {
    if (opts.length < 2) return { level: "err", msg: "Single-answer needs at least 2 options" };
    if (correctCount !== 1) return { level: "err", msg: "Single-answer must have exactly one correct option" };
  }
  if (q.q_type === "mcqmca") {
    if (opts.length < 2) return { level: "err", msg: "Multi-answer needs at least 2 options" };
    if (correctCount < 2) return { level: "warn", msg: "Multi-answer usually has 2+ correct options" };
  }
  if (q.q_type === "tf") {
    if (opts.length !== 2) return { level: "warn", msg: "True/False should have exactly 2 options" };
    if (correctCount !== 1) return { level: "err", msg: "True/False must have exactly one correct option" };
  }
  return { level: "ok", msg: "Valid" };
}

// read an .xlsx file object, return {questions, error}
function readWorkbook(arrayBuffer) {
  try {
    var wb = XLSX.read(arrayBuffer, { type: "array" });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    // drop completely empty rows
    rows = rows.filter(function (r) { return Object.keys(r).some(function (k) { return String(r[k]).trim() !== ""; }); });
    var questions = parseQuestionRows(rows);
    return { questions: questions, error: null };
  } catch (e) {
    return { questions: [], error: "Could not read the spreadsheet. Make sure it is a valid .xlsx file." };
  }
}

// read an .xlsx of assessment-takers. Expected headers (forgiving):
//   full_name, email, employee_id, designation, department, location,
//   workstream, reporting_manager_email
// "location" is the city, used later by the automatic rater selection.
function readParticipants(arrayBuffer) {
  try {
    var wb = XLSX.read(arrayBuffer, { type: "array" });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    rows = rows.filter(function (r) { return Object.keys(r).some(function (k) { return String(r[k]).trim() !== ""; }); });
    var people = rows.map(function (raw) {
      var map = {}; Object.keys(raw).forEach(function (k) { map[normHeader(k)] = raw[k]; });
      function g() { for (var i = 0; i < arguments.length; i++) { var v = map[normHeader(arguments[i])]; if (v != null && String(v).trim() !== "") return String(v).trim(); } return ""; }
      return {
        full_name: g("full_name", "name", "fullname"),
        email: g("email", "emailid", "mail").toLowerCase(),
        employee_id: g("employee_id", "empid", "employeeid"),
        designation: g("designation", "role", "title"),
        department: g("department", "dept"),
        location: g("location", "office", "city"),
        workstream: g("workstream", "stream", "team"),
        reporting_manager_email: g("reporting_manager_email", "manageremail", "manager", "reportingmanager").toLowerCase()
      };
    });
    return { people: people, error: null };
  } catch (e) {
    return { people: [], error: "Could not read the spreadsheet. Make sure it is a valid .xlsx file." };
  }
}

// =====================================================================
// SVG CHARTS  (graph palette: orange / yellow-ochre / cherry, plus blue)
// =====================================================================
var CHART = { blue: "#016796", green: "#3c9052", orange: "#cc7003", yellow: "#d3a518", cherry: "#b77967", grid: "#e0e2e1", axis: "#9aa09e" };

// vertical bar chart. data = [{label, value}], opts {max, color, suffix}
function barChart(data, opts) {
  opts = opts || {};
  if (!data.length) return '<p class="muted small">No data yet.</p>';
  var W = 560, H = 240, pl = 34, pb = 46, pt = 10, pr = 10;
  var max = opts.max || Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
  var bw = (W - pl - pr) / data.length;
  var color = opts.color || CHART.blue;
  var grid = [0, 0.25, 0.5, 0.75, 1].map(function (f) {
    var y = pt + (1 - f) * (H - pt - pb);
    return '<line x1="' + pl + '" y1="' + y + '" x2="' + (W - pr) + '" y2="' + y + '" stroke="' + CHART.grid + '"/>'
      + '<text x="6" y="' + (y + 4) + '" font-size="10" fill="' + CHART.axis + '">' + Math.round(max * f) + '</text>';
  }).join("");
  var bars = data.map(function (d, i) {
    var h = (d.value / max) * (H - pt - pb);
    var x = pl + i * bw + bw * 0.18, y = pt + (H - pt - pb) - h, w = bw * 0.64;
    var lab = String(d.label);
    if (lab.length > 10) lab = lab.slice(0, 9) + "…";
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + Math.max(0, h) + '" rx="3" fill="' + color + '"/>'
      + '<text x="' + (x + w / 2) + '" y="' + (pt + (H - pt - pb) + 14) + '" font-size="9.5" fill="' + CHART.axis + '" text-anchor="middle" transform="rotate(20 ' + (x + w / 2) + ' ' + (pt + (H - pt - pb) + 14) + ')">' + escHtml(lab) + '</text>'
      + '<text x="' + (x + w / 2) + '" y="' + (y - 4) + '" font-size="10" fill="#3c403f" text-anchor="middle" font-weight="700">' + d.value + (opts.suffix || "") + '</text>';
  }).join("");
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%">' + grid + bars + '</svg>';
}

// histogram for the score distribution (0-100 in 10 buckets)
function histogram(percents) {
  var buckets = new Array(10).fill(0);
  percents.forEach(function (p) { var b = Math.min(9, Math.floor(p / 10)); buckets[b]++; });
  var data = buckets.map(function (c, i) { return { label: (i * 10) + "-" + (i * 10 + 9), value: c }; });
  return barChart(data, { color: CHART.orange });
}

// grouped bars: two series per category (used for WPCAS self vs others).
// data = [{label, a, b}], names {a, b}
function groupedBars(data, names) {
  names = names || { a: "Self", b: "Others" };
  if (!data.length) return '<p class="muted small">No ratings yet.</p>';
  var W = 580, H = 260, pl = 34, pb = 64, pt = 10, pr = 10, max = 100;
  var gw = (W - pl - pr) / data.length;
  var grid = [0, 25, 50, 75, 100].map(function (f) {
    var y = pt + (1 - f / 100) * (H - pt - pb);
    return '<line x1="' + pl + '" y1="' + y + '" x2="' + (W - pr) + '" y2="' + y + '" stroke="' + CHART.grid + '"/>'
      + '<text x="6" y="' + (y + 4) + '" font-size="10" fill="' + CHART.axis + '">' + f + '</text>';
  }).join("");
  var bars = data.map(function (d, i) {
    var bw = gw * 0.30, x0 = pl + i * gw + gw * 0.12;
    var ha = (d.a / max) * (H - pt - pb), hb = (d.b / max) * (H - pt - pb);
    var lab = String(d.label); if (lab.length > 14) lab = lab.slice(0, 13) + "…";
    return '<rect x="' + x0 + '" y="' + (pt + (H - pt - pb) - ha) + '" width="' + bw + '" height="' + Math.max(0, ha) + '" rx="3" fill="' + CHART.blue + '"/>'
      + '<rect x="' + (x0 + bw + 4) + '" y="' + (pt + (H - pt - pb) - hb) + '" width="' + bw + '" height="' + Math.max(0, hb) + '" rx="3" fill="' + CHART.orange + '"/>'
      + '<text x="' + (x0 + bw) + '" y="' + (pt + (H - pt - pb) + 14) + '" font-size="9.5" fill="' + CHART.axis + '" text-anchor="middle" transform="rotate(20 ' + (x0 + bw) + ' ' + (pt + (H - pt - pb) + 14) + ')">' + escHtml(lab) + '</text>';
  }).join("");
  var legend = '<g><rect x="' + pl + '" y="' + (H - 16) + '" width="11" height="11" rx="2" fill="' + CHART.blue + '"/>'
    + '<text x="' + (pl + 16) + '" y="' + (H - 7) + '" font-size="11" fill="' + CHART.axis + '">' + escHtml(names.a) + '</text>'
    + '<rect x="' + (pl + 90) + '" y="' + (H - 16) + '" width="11" height="11" rx="2" fill="' + CHART.orange + '"/>'
    + '<text x="' + (pl + 106) + '" y="' + (H - 7) + '" font-size="11" fill="' + CHART.axis + '">' + escHtml(names.b) + '</text></g>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%">' + grid + bars + legend + '</svg>';
}

// ---- local storage + DOM-ready, shared by portal.js and take.js ----
function readLS(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function removeLS(k) { try { localStorage.removeItem(k); } catch (e) {} }

// run fn once the DOM is ready, even if that already happened
function onReady(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
  else fn();
}
