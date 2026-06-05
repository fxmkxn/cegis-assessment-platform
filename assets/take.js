// CEGIS Assessment Platform - respondent "take" page.
// Reached by a link like take.html?a=<assessment-id>  (objective assessment)
// or take.html?k=<access-key>  (a shared key that resolves to an objective
// assessment OR a WPCAS 360 review task).
//
// IMPORTANT security notes carried over from the first build:
//   * All scoring happens on the SERVER. This page never receives the answer
//     key, so a respondent cannot read the correct answers from the browser.
//   * Anti-cheat events (tab switch, leaving full screen, copy, dev-tools, etc.)
//     are LOGGED on the server but never block or end the attempt.
//   * Whether an assessment may be started is decided by the server (the
//     `is_open` flag below already folds in is_active + the activate/deactivate
//     window + whether the instance is live). The browser only mirrors it.
//
// Shared helpers (escHtml, escAttr, toast, showModal, friendlyError, fmtDuration,
// readLS/writeLS/removeLS, onReady, initSupabase) all live in common.js and are
// NOT redefined here.
//
// Plain language, single-line comments, since the maintainer mostly uses
// Python and HTML.

var TAKE = {
  aId: null,            // assessment id from the URL
  assessment: null,     // public assessment row
  questions: [],        // questions in display order
  respondentId: null,   // returned by start_respondent / start_wpca
  answers: {},          // { questionId: [optionNumbers] }
  flags: {},            // { questionId: true }
  order: [],            // question ids in display order
  idx: 0,               // current question index (one-at-a-time mode)
  mode: "one_at_a_time",
  deadlineMs: null,     // when the timer runs out (client clock, persisted)
  timerHandle: null,
  secActive: false,     // are the anti-cheat listeners live?
  secCount: 0,          // how many security events we have seen
  watermark: "",        // name + email shown faintly across the screen
  wpca: null,           // set when this is a 360 review task
  wpcaKey: null         // the access key used to start a 360 review
};

// ---------------------------------------------------------------- boot
onReady(function () {
  if (!initSupabase()) {
    render('<div class="card pad" style="max-width:560px;margin:40px auto">'
      + '<h2 style="color:var(--red)">Setup needed</h2>'
      + '<p class="muted" style="margin-top:8px">This link is not configured yet. '
      + 'The administrator needs to set the Supabase keys in assets/config.js.</p></div>');
    return;
  }
  var params = new URLSearchParams(window.location.search);
  TAKE.aId = params.get("a");
  var key = params.get("k");
  if (key) { resolveKey(key); return; }
  if (!TAKE.aId) {
    render(noticeCard("Invalid link", "This assessment link is missing its code. Please use the full link you were given."));
    return;
  }
  loadIntro();
});

// a shared access key can point at an objective assessment or a WPCAS task
function resolveKey(key) {
  showLoader("Opening...");
  db.rpc("resolve_key", { p_key: key }).then(function (r) {
    hideLoader();
    if (r.error || !r.data || r.data.kind === "none") {
      render(noticeCard("Not found", "We could not find anything for this key. Please check the key you were given."));
      return;
    }
    var d = r.data;
    if (d.kind === "wpca") {
      if (d.is_completed) { render(noticeCard("Already submitted", "You have already completed this review. Thank you.", "ok")); return; }
      TAKE.aId = d.assessment_id;
      TAKE.wpca = d;
      TAKE.wpcaKey = key;
      loadWpcaIntro();
    } else {
      TAKE.aId = d.assessment_id;
      loadIntro();
    }
  });
}

// put markup into the page body region
function render(html) { document.getElementById("stage").innerHTML = html; }

// a simple centered message card
function noticeCard(title, msg, tone) {
  var color = tone === "ok" ? "var(--green-d)" : tone === "warn" ? "var(--ochre-d)" : "var(--red)";
  return '<div class="card pad" style="max-width:560px;margin:40px auto;text-align:center">'
    + '<h2 style="color:' + color + '">' + escHtml(title) + '</h2>'
    + '<p class="muted" style="margin-top:10px">' + escHtml(msg) + '</p></div>';
}

// Build the right "not open" message from the schedule fields. The server is the
// source of truth (is_open); we only word the reason nicely for the respondent.
function closedNotice(a) {
  var now = Date.now();
  var act = a.activate_at ? new Date(a.activate_at).getTime() : null;
  var deact = a.deactivate_at ? new Date(a.deactivate_at).getTime() : null;
  if (act && now < act) {
    return noticeCard("Not open yet",
      "This assessment opens on " + fmtDate(a.activate_at) + ". Please come back then.", "warn");
  }
  if (deact && now > deact) {
    return noticeCard("Closed",
      "This assessment closed on " + fmtDate(a.deactivate_at) + ". Please contact the administrator.", "warn");
  }
  // is_active false, or the instance is not live yet
  return noticeCard("Not open right now",
    "This assessment is not currently open. Please check with the administrator.", "warn");
}

// ---------------------------------------------------------------- intro (objective)
function loadIntro() {
  showLoader("Loading assessment...");
  db.rpc("get_public_assessment", { p_assessment_id: TAKE.aId }).then(function (res) {
    hideLoader();
    if (res.error) { render(noticeCard("Not available", friendlyError(res.error))); return; }
    var row = (res.data && res.data[0]) || null;
    if (!row) { render(noticeCard("Not found", "We could not find this assessment. The link may be wrong or it may have been removed.")); return; }
    TAKE.assessment = row;
    // schedule + instance-live + active are all folded into is_open by the server
    if (!row.is_open) { render(closedNotice(row)); return; }
    if (row.seats_left !== null && row.seats_left <= 0) {
      render(noticeCard("Fully subscribed", "This assessment has reached its respondent limit. No more responses can be accepted.", "warn"));
      return;
    }
    renderIntro(row);
  });
}

function renderIntro(a) {
  var qn = a.question_count || 0;
  var tmin = a.time_limit_minutes;
  var seats = a.seats_left;
  var meta = ''
    + chip("📋", qn + " question" + (qn === 1 ? "" : "s"))
    + (tmin ? chip("⏱", tmin + " min time limit") : chip("⏱", "No time limit"))
    + (seats !== null ? chip("👥", seats + " place" + (seats === 1 ? "" : "s") + " left") : "")
    + (a.deactivate_at ? chip("📅", "Closes " + fmtDate(a.deactivate_at)) : "");

  render(''
    + '<div class="player-wrap">'
    + '<div class="card pad" style="margin-bottom:18px">'
    + '<h1 style="font-size:24px">' + escHtml(a.title) + '</h1>'
    + (a.intro_text ? '<p class="muted" style="margin-top:10px;white-space:pre-wrap">' + escHtml(a.intro_text) + '</p>' : '')
    + '<div class="flex g8 wrap" style="margin-top:16px">' + meta + '</div>'
    + '</div>'

    + '<div class="card pad">'
    + '<h3 style="margin-bottom:4px">Your details</h3>'
    + '<p class="muted small" style="margin-bottom:16px">We use these to record your result. Fields marked * are required.</p>'
    + '<div class="alert" id="intro-err"></div>'
    + '<div class="row2">'
    + field("Full name *", '<input class="input" id="f-name" type="text" placeholder="Your full name">')
    + field("Email *", '<input class="input" id="f-email" type="email" placeholder="you@example.com">')
    + '</div>'
    + '<div class="row2">'
    + field("Organisation", '<input class="input" id="f-org" type="text" placeholder="Optional">')
    + field("Department", '<input class="input" id="f-dept" type="text" placeholder="Optional">')
    + '</div>'
    + field("Employee ID", '<input class="input" id="f-emp" type="text" placeholder="Optional">')
    + '<label class="switch" style="margin-top:6px"><input type="checkbox" id="f-consent"> '
    + '<span class="small">I understand my responses will be recorded and scored, and I agree to take this assessment honestly.</span></label>'
    + '<div class="flagbanner" style="margin-top:14px">⚠ This is a secure assessment. Please stay on this tab and do not leave full screen until you submit.</div>'
    + '<button class="btn" style="width:100%;margin-top:6px" onclick="beginAttempt()">Begin assessment</button>'
    + '</div>'
    + '</div>');
}

function chip(ic, txt) {
  return '<span class="tag">' + ic + ' ' + escHtml(txt) + '</span>';
}
function field(label, inner) {
  return '<div class="field"><label class="label">' + label + '</label>' + inner + '</div>';
}

// ---------------------------------------------------------------- begin (objective)
// triggered by a button click, so this is a user gesture and we can ask for
// full screen here.
function beginAttempt() {
  var name = (val("f-name") || "").trim();
  var email = (val("f-email") || "").trim().toLowerCase();
  var consent = document.getElementById("f-consent").checked;
  if (!name || !email) { intoAlert("Please enter your name and email."); return; }
  if (email.indexOf("@") === -1) { intoAlert("Please enter a valid email address."); return; }
  if (!consent) { intoAlert("Please tick the consent box to continue."); return; }

  // try full screen now while we still have the click gesture
  requestFullscreen();

  showLoader("Starting your attempt...");
  db.rpc("start_respondent", {
    p_assessment_id: TAKE.aId,
    p_full_name: name,
    p_email: email,
    p_organization: (val("f-org") || "").trim() || null,
    p_department: (val("f-dept") || "").trim() || null,
    p_employee_id: (val("f-emp") || "").trim() || null,
    p_user_agent: navigator.userAgent
  }).then(function (res) {
    if (res.error) { hideLoader(); intoAlert(friendlyError(res.error)); return; }
    TAKE.respondentId = res.data;            // scalar uuid
    TAKE.watermark = name + " · " + email;
    loadQuestions();
  });
}
function intoAlert(msg) {
  var el = document.getElementById("intro-err");
  if (el) { el.textContent = msg; el.className = "alert err show"; }
}
function val(id) { var e = document.getElementById(id); return e ? e.value : ""; }

// ---------------------------------------------------------------- load questions
function loadQuestions() {
  db.rpc("get_public_questions", { p_assessment_id: TAKE.aId }).then(function (res) {
    hideLoader();
    if (res.error) { render(noticeCard("Could not load", friendlyError(res.error))); return; }
    var qs = res.data || [];
    if (!qs.length) { render(noticeCard("Not ready", "This assessment has no questions yet. Please check back later.", "warn")); return; }

    // index questions by id for quick lookup
    var byId = {}; qs.forEach(function (q) { byId[q.id] = q; });
    TAKE.questions = qs;

    // decide the display order. if shuffling is on we keep the same shuffled
    // order across reloads by storing it in localStorage for this attempt.
    TAKE.mode = TAKE.assessment.display_mode || "one_at_a_time";
    var orderKey = "cegis_order_" + TAKE.respondentId;
    var savedOrder = readLS(orderKey);
    if (savedOrder && Array.isArray(savedOrder) && savedOrder.length === qs.length) {
      TAKE.order = savedOrder.filter(function (id) { return byId[id]; });
    } else if (TAKE.assessment.shuffle_questions) {
      TAKE.order = shuffle(qs.map(function (q) { return q.id; }));
      writeLS(orderKey, TAKE.order);
    } else {
      TAKE.order = qs.map(function (q) { return q.id; });
    }
    // make sure questions array follows the order
    TAKE.questions = TAKE.order.map(function (id) { return byId[id]; });

    // restore any answers / flags saved on this device for this attempt
    var saved = readLS("cegis_ans_" + TAKE.respondentId) || {};
    TAKE.answers = saved.answers || {};
    TAKE.flags = saved.flags || {};

    // timer: anchor the start time once and reuse it on reload so a refresh
    // does not reset the countdown. the server still records the true time.
    if (TAKE.assessment.time_limit_minutes) {
      var startKey = "cegis_start_" + TAKE.respondentId;
      var startMs = readLS(startKey);
      if (!startMs) { startMs = Date.now(); writeLS(startKey, startMs); }
      TAKE.deadlineMs = startMs + TAKE.assessment.time_limit_minutes * 60000;
    } else {
      TAKE.deadlineMs = null;
    }

    TAKE.idx = 0;
    if (!TAKE.wpca) startSecurity();   // anti-cheat is for objective tests, not 360 reviews
    if (TAKE.mode === "all_on_page") renderAllOnPage();
    else renderPlayer();
    startTimer();
  });
}

// ---------------------------------------------------------------- WPCAS (360) intro
function loadWpcaIntro() {
  showLoader("Loading review...");
  db.rpc("get_public_assessment", { p_assessment_id: TAKE.aId }).then(function (res) {
    hideLoader();
    if (res.error || !res.data || !res.data[0]) { render(noticeCard("Not available", "This review could not be loaded.")); return; }
    var a = res.data[0];
    TAKE.assessment = a;
    // the review window is governed by the same is_open rule as objective tests
    if (!a.is_open) { render(closedNotice(a)); return; }
    var w = TAKE.wpca;
    render('<div class="player-wrap">'
      + '<div class="card pad" style="margin-bottom:18px">'
      + '<span class="tag" style="color:var(--blue-d);border-color:var(--blue)">WPCAS 360 review</span>'
      + '<h1 style="font-size:24px;margin-top:8px">' + escHtml(a.title) + '</h1>'
      + '<p style="margin-top:10px">You are reviewing <b>' + escHtml(w.subject_name) + '</b> as their <b>' + escHtml(w.relationship) + '</b>.</p>'
      + (a.intro_text ? '<p class="muted" style="margin-top:8px;white-space:pre-wrap">' + escHtml(a.intro_text) + '</p>' : '')
      + '<div class="flex g8 wrap" style="margin-top:14px">' + chip("📋", a.question_count + " item" + (a.question_count === 1 ? "" : "s")) + chip("🔒", "Your individual answers stay confidential") + '</div>'
      + '</div>'
      + '<div class="card pad">'
      + '<h3 style="margin-bottom:4px">Confirm it is you</h3>'
      + '<p class="muted small" style="margin-bottom:16px">We recorded this review for the address below.</p>'
      + '<div class="alert" id="intro-err"></div>'
      + field("Your name", '<input class="input" id="f-name" type="text" value="' + escAttr(w.rater_name || "") + '">')
      + field("Your email", '<input class="input" id="f-email" type="email" value="' + escAttr(w.rater_email || "") + '" readonly>')
      + '<label class="switch" style="margin-top:6px"><input type="checkbox" id="f-consent"> '
      + '<span class="small">I will answer honestly and understand my individual responses are kept confidential.</span></label>'
      + '<button class="btn" style="width:100%;margin-top:12px" onclick="beginWpca()">Begin review</button>'
      + '</div></div>');
  });
}
function beginWpca() {
  var name = (val("f-name") || "").trim();
  if (!document.getElementById("f-consent").checked) { intoAlert("Please tick the box to continue."); return; }
  showLoader("Starting your review...");
  db.rpc("start_wpca", { p_key: TAKE.wpcaKey }).then(function (res) {
    if (res.error) { hideLoader(); intoAlert(friendlyError(res.error)); return; }
    TAKE.respondentId = res.data;
    TAKE.watermark = (name || TAKE.wpca.rater_name || TAKE.wpca.rater_email) + " · reviewing " + TAKE.wpca.subject_name;
    loadQuestions();
  });
}

// ---------------------------------------------------------------- player (one at a time)
function renderPlayer() {
  var total = TAKE.questions.length;
  var i = TAKE.idx;
  var q = TAKE.questions[i];
  var pct = Math.round(((i + 1) / total) * 100);

  var html = watermarkHtml()
    + '<div class="player-wrap">'
    + flagBannerHtml()
    + '<div class="player-top">'
    + '<div class="small" style="font-weight:700;white-space:nowrap">Question ' + (i + 1) + ' of ' + total + '</div>'
    + '<div class="qbar"><i style="width:' + pct + '%"></i></div>'
    + timerHtml()
    + '</div>'
    + '<div class="save-ind" id="saveInd"><span class="d"></span> Saved</div>'
    + '<div class="card pad" style="margin-top:12px">'
    + questionHtml(q, i)
    + '</div>'
    + '<div class="flex jb ac" style="margin-top:18px;gap:10px">'
    + '<button class="btn ghost" onclick="goPrev()"' + (i === 0 ? " disabled" : "") + '>← Previous</button>'
    + '<button class="flagbtn ' + (TAKE.flags[q.id] ? "on" : "") + '" onclick="toggleFlag(\'' + q.id + '\')">'
    + (TAKE.flags[q.id] ? "★ Flagged" : "☆ Flag for review") + '</button>'
    + (i === total - 1
        ? '<button class="btn" onclick="gotoReview()">Review answers →</button>'
        : '<button class="btn" onclick="goNext()">Next →</button>')
    + '</div>'
    + '</div>';
  render(html);
  paintTimer();
}
function renderAllOnPage() {
  var blocks = TAKE.questions.map(function (q, i) {
    return '<div class="card pad" style="margin-bottom:14px">'
      + '<div class="flex jb ac" style="margin-bottom:6px">'
      + '<div class="small muted" style="font-weight:700">Question ' + (i + 1) + ' of ' + TAKE.questions.length + '</div>'
      + '<button class="flagbtn ' + (TAKE.flags[q.id] ? "on" : "") + '" onclick="toggleFlag(\'' + q.id + '\');renderAllOnPage()">'
      + (TAKE.flags[q.id] ? "★ Flagged" : "☆ Flag") + '</button></div>'
      + questionHtml(q, i) + '</div>';
  }).join("");

  render(watermarkHtml()
    + '<div class="player-wrap">'
    + flagBannerHtml()
    + '<div class="player-top"><div class="small" style="font-weight:700">'
    + TAKE.questions.length + ' questions</div><div class="qbar"><i style="width:' + answeredPct() + '%"></i></div>' + timerHtml() + '</div>'
    + '<div class="save-ind" id="saveInd"><span class="d"></span> Saved</div>'
    + '<div style="margin-top:12px">' + blocks + '</div>'
    + '<button class="btn" style="width:100%;margin-top:6px" onclick="gotoReview()">Review answers →</button>'
    + '</div>');
  paintTimer();
}
function answeredPct() {
  var done = TAKE.questions.filter(function (q) { return (TAKE.answers[q.id] || []).length; }).length;
  return Math.round((done / TAKE.questions.length) * 100);
}

// build the question stem + optional image + options. text is not selectable.
function questionHtml(q, i) {
  var sel = TAKE.answers[q.id] || [];
  var stem = '<div style="user-select:none;-webkit-user-select:none;font-size:16px;font-weight:600;margin-bottom:6px">'
    + escHtml(q.q_stem) + '</div>';
  var meta = (q.q_competency || q.q_facet)
    ? '<div class="muted small" style="margin-bottom:14px">' + escHtml([q.q_competency, q.q_facet].filter(Boolean).join(" · ")) + '</div>'
    : '<div style="margin-bottom:10px"></div>';

  // NEW: a question may carry an image (baseline / endline / eoca only). The
  // image is served from the PUBLIC question-images bucket, so showing it to
  // every taker is fine - it is not part of the secret answer key. CSP on
  // take.html allows img-src from *.supabase.co.
  var img = (q.image_url && q.image_url.length)
    ? '<img class="q-image" src="' + escAttr(q.image_url) + '" alt="Question image" loading="lazy">'
    : "";

  var opts = [q.opt1, q.opt2, q.opt3, q.opt4, q.opt5];
  var body;

  if (q.q_type === "yesno") {
    // WPCAS format: a plain statement answered Yes / No. opt1 = Yes, opt2 = No
    // are fixed by the schema, but we render whatever option text came back so
    // the labels always match the stored options.
    var yn = opts.filter(function (o) { return o && o.length; });
    if (!yn.length) yn = YESNO_OPTS;   // safety net if options were blank
    body = '<div class="yesno">' + yn.map(function (o, k) {
      var n = k + 1;
      return '<button class="' + (sel.indexOf(n) !== -1 ? "sel" : "") + '" onclick="setSingle(\'' + q.id + '\',' + n + ')">' + escHtml(o) + '</button>';
    }).join("") + '</div>';
  } else if (q.q_type === "tf") {
    body = '<div class="tf">' + opts.filter(function (o) { return o && o.length; }).map(function (o, k) {
      var n = k + 1;
      return '<button class="' + (sel.indexOf(n) !== -1 ? "sel" : "") + '" onclick="setSingle(\'' + q.id + '\',' + n + ')">' + escHtml(o) + '</button>';
    }).join("") + '</div>';
  } else if (q.q_type === "mcqmca") {
    body = '<div class="muted small" style="margin-bottom:8px">Select all that apply.</div>'
      + opts.map(function (o, k) {
        if (!o || !o.length) return "";
        var n = k + 1, on = sel.indexOf(n) !== -1;
        return '<div class="opt ' + (on ? "sel" : "") + '" onclick="toggleMulti(\'' + q.id + '\',' + n + ')">'
          + '<span class="rd sq"></span><span>' + escHtml(o) + '</span></div>';
      }).join("");
  } else { // mcqsca
    body = opts.map(function (o, k) {
      if (!o || !o.length) return "";
      var n = k + 1, on = sel.indexOf(n) !== -1;
      return '<div class="opt ' + (on ? "sel" : "") + '" onclick="setSingle(\'' + q.id + '\',' + n + ')">'
        + '<span class="rd"></span><span>' + escHtml(o) + '</span></div>';
    }).join("");
  }
  return stem + meta + img + body;
}

// ---------------------------------------------------------------- answer handlers
function setSingle(qid, n) {
  TAKE.answers[qid] = [n];
  persist();
  if (TAKE.mode === "all_on_page") refreshOpt(qid); else renderPlayer();
}
function toggleMulti(qid, n) {
  var cur = TAKE.answers[qid] || [];
  var pos = cur.indexOf(n);
  if (pos === -1) cur.push(n); else cur.splice(pos, 1);
  cur.sort(function (a, b) { return a - b; });
  TAKE.answers[qid] = cur;
  persist();
  if (TAKE.mode === "all_on_page") refreshOpt(qid); else renderPlayer();
}
function toggleFlag(qid) {
  if (TAKE.flags[qid]) delete TAKE.flags[qid]; else TAKE.flags[qid] = true;
  persist();
  if (TAKE.mode === "one_at_a_time") renderPlayer();
}
// in all-on-page mode we re-render the page so options reflect the click,
// keeping the scroll position so the page does not jump to the top
function refreshOpt() { var y = window.scrollY; renderAllOnPage(); window.scrollTo(0, y); }

function goNext() { if (TAKE.idx < TAKE.questions.length - 1) { TAKE.idx++; renderPlayer(); } }
function goPrev() { if (TAKE.idx > 0) { TAKE.idx--; renderPlayer(); } }

// save answers + flags locally so a reload does not lose progress
function persist() {
  writeLS("cegis_ans_" + TAKE.respondentId, { answers: TAKE.answers, flags: TAKE.flags });
  var ind = document.getElementById("saveInd");
  if (ind) { ind.className = "save-ind saving"; ind.innerHTML = '<span class="d"></span> Saving'; setTimeout(function () { var x = document.getElementById("saveInd"); if (x) { x.className = "save-ind"; x.innerHTML = '<span class="d"></span> Saved'; } }, 350); }
}

// ---------------------------------------------------------------- review
function gotoReview() {
  var cells = TAKE.questions.map(function (q, i) {
    var answered = (TAKE.answers[q.id] || []).length > 0;
    var cls = "rcell" + (TAKE.flags[q.id] ? " flag" : answered ? " ans" : "");
    var jump = TAKE.mode === "one_at_a_time"
      ? ' onclick="TAKE.idx=' + i + ';renderPlayer()"' : '';
    return '<div class="' + cls + '"' + jump + '>' + (i + 1) + '</div>';
  }).join("");

  var answered = TAKE.questions.filter(function (q) { return (TAKE.answers[q.id] || []).length; }).length;
  var unanswered = TAKE.questions.length - answered;
  var flagged = Object.keys(TAKE.flags).length;
  // wording differs for WPCAS (no right/wrong) vs objective (marked wrong)
  var unansweredWarn = TAKE.wpca
    ? '⚠ You have ' + unanswered + ' unanswered item' + (unanswered === 1 ? "" : "s") + '. Please answer them before submitting.'
    : '⚠ You have ' + unanswered + ' unanswered question' + (unanswered === 1 ? "" : "s") + '. You can still submit, but they will be marked wrong.';

  render(watermarkHtml()
    + '<div class="player-wrap">'
    + flagBannerHtml()
    + '<div class="card pad">'
    + '<h2>Review your answers</h2>'
    + '<div class="flex g8 wrap" style="margin:14px 0">'
    + tagPill("var(--blue-d)", answered + " answered")
    + tagPill("var(--n600)", unanswered + " unanswered")
    + tagPill("var(--ochre-d)", flagged + " flagged")
    + '</div>'
    + (unanswered > 0 ? '<div class="flagbanner" style="background:var(--warn-l);color:var(--ochre-d);border-color:var(--ochre)">' + unansweredWarn + '</div>' : '')
    + '<div class="review-grid" style="margin:6px 0 16px">' + cells + '</div>'
    + '<div class="legend"><span><i style="background:var(--blue)"></i>Answered</span>'
    + '<span><i style="background:var(--n300)"></i>Not answered</span>'
    + '<span><i style="background:var(--ochre)"></i>Flagged</span></div>'
    + '</div>'
    + '<div class="flex jb" style="margin-top:16px;gap:10px">'
    + (TAKE.mode === "one_at_a_time" ? '<button class="btn ghost" onclick="renderPlayer()">← Back to questions</button>' : '<button class="btn ghost" onclick="renderAllOnPage()">← Back to questions</button>')
    + '<button class="btn green" onclick="confirmSubmit()">Submit</button>'
    + '</div>'
    + '</div>');
}
function tagPill(color, txt) {
  return '<span class="tag" style="color:' + color + ';border-color:' + color + '">' + escHtml(txt) + '</span>';
}

function confirmSubmit() {
  showModal({
    title: "Submit?",
    body: '<p>Once you submit you cannot change your answers. Are you ready?</p>',
    confirm: "Yes, submit",
    onConfirm: function () { closeModal(); doSubmit(); }
  });
}

// ---------------------------------------------------------------- submit
function doSubmit() {
  stopTimer();
  showLoader("Submitting your answers...");
  // The SERVER scores this. We only send the chosen option numbers; the browser
  // never learns which were correct.
  db.rpc("submit_assessment", { p_respondent_id: TAKE.respondentId, p_answers: TAKE.answers }).then(function (res) {
    if (res.error) {
      hideLoader();
      // if it was already submitted, just show the result
      if (String(res.error.message || "").indexOf("already submitted") !== -1) { loadResult(); return; }
      toast(friendlyError(res.error), "err");
      startTimer();
      return;
    }
    stopSecurity();
    // clear the local progress for this attempt
    removeLS("cegis_ans_" + TAKE.respondentId);
    removeLS("cegis_order_" + TAKE.respondentId);
    removeLS("cegis_start_" + TAKE.respondentId);
    exitFullscreen();
    loadResult();
  });
}

// ---------------------------------------------------------------- result
function loadResult() {
  showLoader("Preparing your result...");
  db.rpc("get_respondent_result", { p_respondent_id: TAKE.respondentId }).then(function (res) {
    hideLoader();
    if (res.error) { render(noticeCard("Submitted", "Your answers were submitted, but we could not load the result page.", "ok")); return; }
    var r = res.data;
    if (r.assessment_type === "wpca") { renderWpcaThanks(r); return; }   // 360 stays confidential
    if (!r.show_results) { renderThankYou(r); return; }
    renderResult(r);
  });
}

function renderWpcaThanks(r) {
  render('<div class="player-wrap"><div class="card pad" style="text-align:center;padding:46px">'
    + '<div style="font-size:46px">✓</div>'
    + '<h1 style="margin:12px 0 6px">Thank you</h1>'
    + '<p class="muted">Your WPCAS review has been recorded. Individual responses are kept confidential and are only used in the combined report.</p>'
    + '</div></div>');
}
function renderThankYou(r) {
  render('<div class="player-wrap"><div class="card pad" style="text-align:center;padding:46px">'
    + '<div style="font-size:46px">✓</div>'
    + '<h1 style="margin:12px 0 6px">Thank you, ' + escHtml(r.full_name) + '</h1>'
    + '<p class="muted">Your responses for <b>' + escHtml(r.title) + '</b> have been recorded. '
    + 'Results will be shared by the administrator.</p>'
    + '</div></div>');
}

function renderResult(r) {
  var pct = Number(r.score_percent || 0);
  var passLine = (r.is_passed === null || r.passing_score_percent == null)
    ? '' : '<div class="mt"><div class="v">' + (r.is_passed ? "Passed" : "Not passed") + '</div><div class="l">Pass mark ' + r.passing_score_percent + '%</div></div>';

  // group the per-question breakdown by competency
  var groups = {};
  (r.breakdown || []).forEach(function (b) {
    var key = b.q_competency || "General";
    (groups[key] = groups[key] || []).push(b);
  });
  var sections = Object.keys(groups).map(function (comp) {
    var items = groups[comp];
    var correct = items.filter(function (b) { return b.is_correct; }).length;
    var rows = items.map(breakdownRow).join("");
    return '<div class="card pad" style="margin-bottom:14px">'
      + '<div class="flex jb ac" style="margin-bottom:10px">'
      + '<h3>' + escHtml(comp) + '</h3>'
      + '<span class="tag">' + correct + " / " + items.length + ' correct</span></div>'
      + rows + '</div>';
  }).join("");

  render('<div class="report-wrap" id="resultDoc">'
    + watermarkHtml()
    + '<div class="summary-band">'
    + '<div class="small" style="opacity:.85;font-weight:600">RESULT</div>'
    + '<h1 style="color:#fff;font-size:26px;margin-top:4px">' + escHtml(r.title) + '</h1>'
    + '<div style="opacity:.9;margin-top:4px">' + escHtml(r.full_name) + ' · ' + escHtml(r.email) + '</div>'
    + '<div class="metric-tiles">'
    + '<div class="mt"><div class="v">' + pct + '%</div><div class="l">Score</div></div>'
    + '<div class="mt"><div class="v">' + (r.score_raw || 0) + ' / ' + (r.breakdown ? r.breakdown.length : 0) + '</div><div class="l">Correct answers</div></div>'
    + '<div class="mt"><div class="v">' + fmtDuration(r.time_taken_seconds) + '</div><div class="l">Time taken</div></div>'
    + passLine
    + '</div></div>'
    + '<div class="flex jb ac" style="margin:18px 0 12px">'
    + '<h2>Question breakdown</h2>'
    + '<button class="btn ghost sm" id="pdfBtn" onclick="downloadPdf()">⬇ Download PDF</button>'
    + '</div>'
    + sections
    + '</div>');
}

// one row of the per-question breakdown, showing the chosen and correct options.
// note: the answer key is only present here AFTER submission, returned by the
// server in get_respondent_result - never before the attempt is finished.
function breakdownRow(b) {
  var opts = [b.opt1, b.opt2, b.opt3, b.opt4, b.opt5];
  var sel = b.selected || [];
  var key = b.key || [];
  var lines = opts.map(function (o, k) {
    if (!o || !o.length) return "";
    var n = k + 1;
    var isKey = key.indexOf(n) !== -1;
    var isSel = sel.indexOf(n) !== -1;
    var mark = isKey ? '<span style="color:var(--green-d);font-weight:700">✓</span>'
      : (isSel ? '<span style="color:var(--red);font-weight:700">✗</span>' : '<span style="color:var(--n300)">•</span>');
    var bg = isKey ? "var(--green-l)" : (isSel && !isKey ? "var(--red-l)" : "transparent");
    return '<div style="display:flex;gap:10px;padding:6px 10px;border-radius:7px;background:' + bg + ';font-size:13px">'
      + mark + '<span>' + escHtml(o) + (isSel ? ' <span class="small muted">(your choice)</span>' : '') + '</span></div>';
  }).join("");
  var badge = b.is_correct
    ? '<span class="tag" style="color:var(--green-d);border-color:var(--green)">Correct</span>'
    : '<span class="tag" style="color:var(--red);border-color:var(--red)">Incorrect</span>';
  return '<div style="padding:12px 0;border-top:1px solid var(--n100)">'
    + '<div class="flex jb" style="gap:12px;margin-bottom:6px"><div style="font-weight:600">' + escHtml(b.q_stem) + '</div>' + badge + '</div>'
    + lines + '</div>';
}

// ---------------------------------------------------------------- PDF download
// Uses jsPDF + html2canvas (loaded from the CDN). Works on mobile because it
// renders the visible result node to an image and paginates it.
function downloadPdf() {
  var node = document.getElementById("resultDoc");
  if (!node || !window.html2canvas || !window.jspdf) { toast("PDF tools are still loading, try again.", "err"); return; }
  var btn = document.getElementById("pdfBtn"); if (btn) btn.disabled = true;
  showLoader("Building your PDF...");
  // temporarily hide the watermark + button so they do not appear in the file
  var wm = node.querySelector(".watermark"); if (wm) wm.style.display = "none";
  if (btn) btn.style.visibility = "hidden";

  window.html2canvas(node, { scale: 2, backgroundColor: "#ffffff", useCORS: true }).then(function (canvas) {
    var jsPDF = window.jspdf.jsPDF;
    var pdf = new jsPDF("p", "mm", "a4");
    var pageW = pdf.internal.pageSize.getWidth();
    var pageH = pdf.internal.pageSize.getHeight();
    var imgW = pageW;
    var imgH = (canvas.height * imgW) / canvas.width;
    var img = canvas.toDataURL("image/png");
    // paginate the tall image across A4 pages
    var remaining = imgH;
    var position = 0;
    pdf.addImage(img, "PNG", 0, position, imgW, imgH);
    remaining -= pageH;
    while (remaining > 0) {
      position -= pageH;
      pdf.addPage();
      pdf.addImage(img, "PNG", 0, position, imgW, imgH);
      remaining -= pageH;
    }
    // footer watermark with name + email on every page
    var pages = pdf.internal.getNumberOfPages();
    for (var p = 1; p <= pages; p++) {
      pdf.setPage(p);
      pdf.setFontSize(8); pdf.setTextColor(150);
      pdf.text(TAKE.watermark + "  ·  CEGIS Assessment Platform", 8, pageH - 5);
    }
    var fname = (TAKE.assessment.title || "assessment").replace(/[^a-z0-9]+/gi, "_").toLowerCase() + "_result.pdf";
    pdf.save(fname);
    hideLoader();
    if (wm) wm.style.display = "";
    if (btn) { btn.style.visibility = ""; btn.disabled = false; }
  }).catch(function () {
    hideLoader();
    if (wm) wm.style.display = "";
    if (btn) { btn.style.visibility = ""; btn.disabled = false; }
    toast("Could not build the PDF. You can print this page instead.", "err");
  });
}

// ---------------------------------------------------------------- timer
function startTimer() {
  if (TAKE.deadlineMs == null) { paintTimer(); return; }
  stopTimer();
  TAKE.timerHandle = setInterval(function () {
    var left = TAKE.deadlineMs - Date.now();
    if (left <= 0) {
      stopTimer();
      toast("Time is up. Submitting your answers.", "err");
      doSubmit();
      return;
    }
    paintTimer();
  }, 1000);
  paintTimer();
}
function stopTimer() { if (TAKE.timerHandle) { clearInterval(TAKE.timerHandle); TAKE.timerHandle = null; } }
function paintTimer() {
  var el = document.getElementById("timer");
  if (!el) return;
  if (TAKE.deadlineMs == null) { el.textContent = "No limit"; return; }
  var left = Math.max(0, Math.floor((TAKE.deadlineMs - Date.now()) / 1000));
  var m = Math.floor(left / 60), s = left % 60;
  el.textContent = m + ":" + (s < 10 ? "0" : "") + s;
  el.style.color = left <= 60 ? "var(--red)" : "var(--n700)";
}
function timerHtml() {
  return '<div id="timer" class="small" style="font-weight:700;white-space:nowrap;min-width:54px;text-align:right">—</div>';
}

// ---------------------------------------------------------------- security / anti-cheat
// These never terminate the attempt. After three events we show a banner so the
// respondent knows the activity was noticed. Everything is logged on the server
// via log_security_event (an anon-callable SECURITY DEFINER RPC).
function startSecurity() {
  TAKE.secActive = true;
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("contextmenu", onContext);
  document.addEventListener("copy", onCopy);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
}
function stopSecurity() {
  TAKE.secActive = false;
  document.removeEventListener("visibilitychange", onVisibility);
  document.removeEventListener("fullscreenchange", onFsChange);
  document.removeEventListener("contextmenu", onContext);
  document.removeEventListener("copy", onCopy);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", onResize);
}
function logSec(type) {
  if (!TAKE.secActive || !TAKE.respondentId) return;
  TAKE.secCount++;
  db.rpc("log_security_event", { p_respondent_id: TAKE.respondentId, p_event_type: type }).then(function () {});
  if (TAKE.secCount >= 3) {
    var b = document.getElementById("flagBanner");
    if (b) b.style.display = "flex";
  }
}
function onVisibility() { if (document.hidden) logSec("tab_switch"); }
function onFsChange() { if (!document.fullscreenElement) logSec("fullscreen_exit"); }
function onContext(e) { e.preventDefault(); logSec("right_click"); }
function onCopy(e) { e.preventDefault(); logSec("copy_attempt"); }
function onKey(e) {
  var k = (e.key || "").toLowerCase();
  var block = (e.ctrlKey || e.metaKey) && (k === "c" || k === "p" || k === "u" || k === "s");
  var devtools = k === "f12" || ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === "i" || k === "j" || k === "c"));
  if (devtools) { e.preventDefault(); logSec("devtools_detected"); return; }
  if (block) { e.preventDefault(); logSec("keyboard_shortcut"); }
}
var _resizeT = null;
function onResize() {
  // a very rough devtools hint: a large gap between outer and inner size.
  // debounced so normal window resizing does not spam events.
  clearTimeout(_resizeT);
  _resizeT = setTimeout(function () {
    var wGap = window.outerWidth - window.innerWidth;
    var hGap = window.outerHeight - window.innerHeight;
    if (wGap > 220 || hGap > 220) logSec("devtools_detected");
  }, 600);
}

// full screen helpers (best effort; not all browsers allow it)
function requestFullscreen() {
  var el = document.documentElement;
  var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (fn) { try { fn.call(el); } catch (e) {} }
}
function exitFullscreen() {
  var fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (fn && document.fullscreenElement) { try { fn.call(document); } catch (e) {} }
}

// ---------------------------------------------------------------- shared markup bits
function watermarkHtml() {
  if (!TAKE.watermark) return "";
  // tile the faint name+email across the screen so screenshots are traceable
  var tiles = "";
  for (var r = 0; r < 6; r++) {
    for (var c = 0; c < 4; c++) {
      tiles += '<div class="wm" style="top:' + (r * 18 + 4) + '%;left:' + (c * 28 - 4) + '%">' + escHtml(TAKE.watermark) + '</div>';
    }
  }
  return '<div class="watermark">' + tiles + '</div>';
}
function flagBannerHtml() {
  var show = TAKE.secCount >= 3;
  return '<div class="flagbanner" id="flagBanner" style="display:' + (show ? "flex" : "none") + '">'
    + '⚠ Unusual activity (leaving the tab or full screen) has been recorded. Please stay on this page.</div>';
}

// ---------------------------------------------------------------- small utilities
// shuffle is local to this page (not shared). readLS/writeLS/removeLS/onReady and
// the esc* / toast / modal helpers all come from common.js.
function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
