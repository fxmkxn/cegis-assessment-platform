/* ============================================================
   CEGIS — js/reports.js  (v2 report contract)

   WHAT CHANGED FROM THE PREVIOUS VERSION

   1. SECTION-DRIVEN RENDERING. renderReportFrom() no longer knows which
      sections exist. It walks content.sections in order and calls a
      renderer per section key. A section that isn't in the array simply
      isn't drawn — and isn't in the nav either, because the nav is built
      from the same array.

   2. THE NAV HIGHLIGHT NOW WORKS. initReportScroll() is overridden here
      (reports.js loads after participant.js, so this wins) and derives its
      section list from the nav links instead of a hardcoded array. It is
      also called from renderReportFrom, so it runs on the ADMIN side too —
      previously only renderParticipant() called it, which is why an admin
      opening a report saw the highlight frozen on Summary.

   3. PURE SVG GENERATORS. Every chart is now a function returning ONLY an
      <svg> string. The HTML renderer wraps it; the PDF renderer embeds it
      directly. Previously the PDF had to dig the SVG back out of finished
      HTML with firstSvg() doing string-slicing, which would not survive
      four more chart types.

   4. NEW CHARTS. eocaBarsSVG (one bar per EOCA sitting) and lollipopSVG
      (one chart per rater group — self, peer, manager). The old WPCAS
      radar is retired; radarChart() is kept only for demo mode.

   5. VERSION GUARD. Anything that is not schema_version 2 is refused and
      shown as "needs updating" rather than rendered. This is what stops an
      old-shape report producing a broken page.

   6. THE 360 SCALE IS NO LONGER ASSUMED. lollipopSVG sizes its axis from
      the scale shipped inside the report, and prints the instrument's anchor
      labels beneath it. The metric tile reads its denominator from
      metrics.wpcas_scale_max. Previously both hardcoded 5, while the WPCAS
      instrument actually has three anchors — so every score rendered against
      an axis half again too long.

   7. COHORT FAN-OUT CAN BE STOPPED. The run now carries a cancel flag that
      the workers check between participants, plus a pre-flight dialog that
      defaults to skipping reports already on the current shape. Stop cannot
      abort requests already in flight — see the comment above the fan-out
      block for why, and what the dialog tells the admin instead.

   UNCHANGED ON PURPOSE
     • Participants keep both Generate and Regenerate.
     • All numbers come from the server. This module never computes a score.
     • Branding resolution behaves as before.

   Load order (unchanged): AFTER participant.js and wpca.js, BEFORE app.js.
   ============================================================ */

/* keep the prototype implementations for DEMO mode (no backend) */
var REPORTS_PROTO = {
  pReport:      window.pReport,
  vReports:     window.vReports,
  lineChart:    window.lineChart,
  radarChart:   window.radarChart,
  exportReport: window.exportReport
};

var REPORTS = {
  selfPid:     null,    // the logged-in participant's id (My Reports)
  _selfPidCohort: undefined,
  selfContent: null,
  selfState:   'idle',  // idle | loading | none | stale | ready | generating
  adminView:   null,    // { pid, name, content } when an admin opens one
  fanout:      null,    // live cohort run: items, counts, cancel flag
  _fanoutPlan: null     // what the pre-flight dialog worked out needs doing
};

/* the only report shape this file can draw */
var REPORT_SCHEMA_VERSION = 2;

function reportsLive(){ return !!(window.SUPABASE_CONFIGURED && window.sb); }
function rEsc(s){ return String(s==null?'':s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* Is this content object something we can render?
   Checked in three places (participant hydrate, admin open, renderReportFrom)
   because a wrong answer here is a blank page rather than a caught error. */
function reportsIsV2(content){
  return !!content
    && content.schema_version === REPORT_SCHEMA_VERSION
    && Array.isArray(content.sections);
}

/* current cohort id — same defensive accessor as assessments.js / wpca.js */
function reportsCohortId(){
  if (typeof window.getCurrentCohortId === 'function'){ const v=window.getCurrentCohortId(); if(v) return v; }
  if (window.CURRENT_COHORT_ID) return window.CURRENT_COHORT_ID;
  if (window.state && window.state.cohortId) return window.state.cohortId;
  const sel=document.getElementById('cohortSel');
  if (sel){ const opt=sel.options[sel.selectedIndex]; if(opt && opt.dataset && opt.dataset.id) return opt.dataset.id; if(sel.value) return sel.value; }
  return null;
}

/* ============================================================
   SHARED CHART COLOURS
   Same hex values the Edge Function uses in its PALETTE, so a competency
   keeps its colour whether it is drawn here or described there.
   ============================================================ */
var RCOLORS = {
  primary:   '#016796',   // endline / latest / self
  secondary: '#3c9052',   // baseline / peer
  accent:    '#c98a00',   // manager
  grid:      '#e2e8f0',
  ring:      '#e6f1f7',
  axis:      '#94a3b8',
  label:     '#475569'
};

/* one colour per rater group, keyed by the section's chart.key */
var WPCAS_GROUP_COLORS = {
  self:    RCOLORS.primary,
  peer:    RCOLORS.secondary,
  manager: RCOLORS.accent
};

/* ============================================================
   LABEL HELPERS
   ============================================================ */

/* Radar axis label: anchor by which side of centre it sits on, and split
   long competency names over two lines so they don't clip the viewBox. */
function _radarLabel(x,y,cx,text){
  const anchor = Math.abs(x-cx)<10 ? 'middle' : (x<cx?'end':'start');
  const t=String(text);
  if(t.length<=13) return `<text x="${x}" y="${y}" font-size="9.5" fill="${RCOLORS.label}" text-anchor="${anchor}">${rEsc(t)}</text>`;
  const w=t.split(/\s+/);
  const half = w.length<2 ? 1 : Math.ceil(w.length/2);
  const l1=w.slice(0,half).join(' '), l2=w.slice(half).join(' ');
  return `<text x="${x}" font-size="9.5" fill="${RCOLORS.label}" text-anchor="${anchor}">`
    + `<tspan x="${x}" y="${y-4}">${rEsc(l1)}</tspan>`
    + (l2?`<tspan x="${x}" y="${y+7}">${rEsc(l2)}</tspan>`:'')
    + `</text>`;
}

/* Truncate to a character budget, keeping the full text in a <title> so
   hovering still reveals it. Used for lollipop row labels, where the left
   margin is fixed and some competency names are 30+ characters. */
function _clip(text, maxChars){
  const t=String(text==null?'':text);
  return t.length<=maxChars ? rEsc(t) : rEsc(t.slice(0,maxChars-1))+'…';
}

/* Split a bar-chart x-axis label over at most two lines. SVG text does not
   wrap on its own — every line needs an explicit tspan. */
function _wrap2(text, x, y, maxChars){
  const t=String(text==null?'':text).trim();
  if(t.length<=maxChars){
    return `<tspan x="${x}" y="${y}">${rEsc(t)}</tspan>`;
  }
  const words=t.split(/\s+/);
  let l1='', l2='';
  for(const w of words){
    if((l1?l1+' '+w:w).length<=maxChars && !l2) l1 = l1?l1+' '+w:w;
    else l2 = l2?l2+' '+w:w;
  }
  if(!l1){ l1=t.slice(0,maxChars); l2=t.slice(maxChars); }
  if(l2.length>maxChars) l2=l2.slice(0,maxChars-1)+'…';
  return `<tspan x="${x}" y="${y}">${rEsc(l1)}</tspan>`
       + `<tspan x="${x}" y="${y+11}">${rEsc(l2)}</tspan>`;
}

/* ============================================================
   PURE SVG GENERATOR 1 — TECHNICAL RADAR (baseline vs endline)

   Takes the v2 `technical` section data and returns { axes, primary,
   primaryLabel, secondary, secondaryLabel } or null when a radar would be
   unreadable (fewer than three axes).

   "primary" is whichever series is the more recent one available, so a
   cohort with only a baseline still gets a filled polygon rather than an
   empty chart with a legend pointing at nothing.
   ============================================================ */
function techRadarData(data){
  if(!data || !Array.isArray(data.axes) || !Array.isArray(data.series)) return null;
  if(data.axes.length < 3) return null;          // a radar needs 3+ spokes to read

  const base = data.series.find(s=>s.key==='baseline') || null;
  const end  = data.series.find(s=>s.key==='endline')  || null;

  const primary   = end || base;
  if(!primary) return null;
  const secondary = (end && base) ? base : null;  // only a comparison if both exist

  return {
    axes: data.axes,
    primary:        primary.points || [],
    primaryLabel:   primary.label || (end?'Endline':'Baseline'),
    secondary:      secondary ? (secondary.points || []) : null,
    secondaryLabel: secondary ? (secondary.label || 'Baseline') : null
  };
}

function techRadarSVG(d){
  const axes=d.axes, N=axes.length, cx=220, cy=180, R=112, max=100;

  // Convert (axis index, value) to an x/y point on the web.
  // -PI/2 puts the first axis at the top rather than the right.
  const pt=(i,v)=>{
    const a=-Math.PI/2 + i*2*Math.PI/N;
    const r=(v==null?0:v)/max*R;
    return [cx+r*Math.cos(a), cy+r*Math.sin(a)];
  };
  const ringPath=l=>{let p='';for(let i=0;i<N;i++){const[x,y]=pt(i,l);p+=(i?'L':'M')+x+' '+y;}return p+'Z';};
  const poly=(arr,stroke,fill)=>{let p='';arr.forEach((v,i)=>{const[x,y]=pt(i,v);p+=(i?'L':'M')+x+' '+y;});return `<path d="${p}Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;};

  const rings=[25,50,75,100].map(l=>`<path d="${ringPath(l)}" fill="none" stroke="${RCOLORS.ring}"/>`).join('');
  const spokes=axes.map((_,i)=>{const[x,y]=pt(i,max);return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${RCOLORS.grid}"/>`;}).join('');
  const labs=axes.map((a,i)=>{const[x,y]=pt(i,max*1.16);return _radarLabel(x,y,cx,a);}).join('');

  // Draw the older series first so the newer one sits on top of it.
  const back = d.secondary ? poly(d.secondary, RCOLORS.secondary, 'rgba(60,144,82,.14)') : '';
  const front = poly(d.primary, RCOLORS.primary, 'rgba(1,103,150,.18)');

  return `<svg viewBox="0 0 440 360" width="100%" xmlns="http://www.w3.org/2000/svg">`
    + rings + spokes + back + front + labs + `</svg>`;
}

/* ============================================================
   PURE SVG GENERATOR 2 — EOCA BAR CHART
   One bar per EOCA sitting. Name on x, percentage on y.
   Objectives are deliberately not shown — the raw Obj/S2-Obj codes are
   unresolved in the objectives table and mean nothing to a participant.
   ============================================================ */
function eocaBarsSVG(bars){
  if(!bars || !bars.length) return null;

  const W=560, PL=36, PR=14, PT=16, PB=48;
  const H=250;
  const plotW=W-PL-PR, plotH=H-PT-PB;
  const y=v=>PT+(100-v)/100*plotH;

  const band=plotW/bars.length;
  const barW=Math.max(14, Math.min(56, band*0.58));

  const grid=[0,25,50,75,100].map(v=>
    `<line x1="${PL}" y1="${y(v)}" x2="${W-PR}" y2="${y(v)}" stroke="${RCOLORS.grid}"/>`
    + `<text x="6" y="${y(v)+4}" font-size="10" fill="${RCOLORS.axis}">${v}</text>`
  ).join('');

  // How many characters fit under one bar, roughly 5.6px per char at 10px.
  const maxChars=Math.max(6, Math.floor(band/5.6));

  const drawn=bars.map((b,i)=>{
    const cxBar=PL+band*i+band/2;
    const x0=cxBar-barW/2;
    const v=Number(b.pct);
    const top=y(v);
    return `<rect x="${x0}" y="${top}" width="${barW}" height="${Math.max(1,y(0)-top)}" rx="3" fill="${RCOLORS.primary}"/>`
      + `<text x="${cxBar}" y="${top-5}" font-size="10.5" fill="${RCOLORS.label}" text-anchor="middle">${v}%</text>`
      + `<text font-size="10" fill="${RCOLORS.axis}" text-anchor="middle">${_wrap2(b.name, cxBar, H-PB+16, maxChars)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">`
    + grid + drawn + `</svg>`;
}

/* ============================================================
   PURE SVG GENERATOR 3 — LOLLIPOP CHART
   One chart per rater group. Competency names down the y axis, score
   along the x axis. A "lollipop" is just a horizontal line from the
   scale minimum out to the score, with a filled circle at the end —
   easier to read than a bar when the baseline isn't zero, which it
   isn't here because the Likert scale starts at 1.
   ============================================================ */
function lollipopSVG(chart, scale){
  const pts=(chart && chart.points) || [];
  if(!pts.length) return null;

  const min=(scale && scale.min!=null) ? scale.min : 1;
  // Fallback of 3 matches the WPCAS instrument, but it should never be
  // reached — the Edge Function reads the real scale from the instrument and
  // ships it inside the report. An earlier version defaulted to 5, which
  // squeezed every score into the lower half of the axis.
  const max=(scale && scale.max!=null) ? scale.max : 3;
  const labels=(scale && Array.isArray(scale.labels)) ? scale.labels : [];
  const colour=WPCAS_GROUP_COLORS[chart.key] || RCOLORS.primary;

  const W=560, PL=196, PR=44, PT=14, ROW=26;
  // Room at the bottom for two lines: the scale numbers, then the anchor
  // legend explaining what those numbers mean.
  const legendH = labels.length ? 30 : 16;
  const rowsH = pts.length*ROW;
  const H=PT + rowsH + legendH;
  const plotW=W-PL-PR;

  const x=v=>PL + ((v-min)/(max-min))*plotW;
  const y=i=>PT + i*ROW + ROW/2;
  const numY = PT + rowsH + 14;

  // A vertical gridline and number at each whole point on the scale.
  let ticks='';
  for(let v=min; v<=max; v++){
    ticks += `<line x1="${x(v)}" y1="${PT}" x2="${x(v)}" y2="${PT+rowsH}" stroke="${RCOLORS.grid}"/>`
           + `<text x="${x(v)}" y="${numY}" font-size="10" fill="${RCOLORS.axis}" text-anchor="middle">${v}</text>`;
  }

  // The anchor legend. "2.4 out of 3" tells a participant nothing; naming the
  // anchors tells them what their raters actually selected. Rendered as one
  // centred line so it cannot collide with the tick numbers above it.
  let legend='';
  if(labels.length){
    const full=labels.map((l,i)=>`${i+1} ${l}`).join('  ·  ');
    // Long instruments would overflow the width, so drop to the two endpoints.
    const text = full.length<=115
      ? full
      : `${1} ${labels[0]}  →  ${labels.length} ${labels[labels.length-1]}`;
    legend=`<text x="${W/2}" y="${H-4}" font-size="8.5" fill="${RCOLORS.axis}" text-anchor="middle">${rEsc(text)}</text>`;
  }

  const rows=pts.map((p,i)=>{
    const v=Number(p.score);
    const yy=y(i);
    return `<text x="${PL-12}" y="${yy+3.5}" font-size="10.5" fill="${RCOLORS.label}" text-anchor="end">`
         + `<title>${rEsc(p.competency)}</title>${_clip(p.competency,32)}</text>`
         + `<line x1="${x(min)}" y1="${yy}" x2="${x(v)}" y2="${yy}" stroke="${colour}" stroke-width="2" stroke-linecap="round"/>`
         + `<circle cx="${x(v)}" cy="${yy}" r="5" fill="${colour}"/>`
         + `<text x="${x(v)+11}" y="${yy+3.5}" font-size="10.5" fill="${RCOLORS.label}">${v}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">`
    + ticks + rows + legend + `</svg>`;
}

/* ============================================================
   LEGACY DEMO CHARTS
   Only reached when there is no backend (reportsLive() is false). The v2
   renderer never calls these, but REPORTS_PROTO captured the prototype
   versions at load time and demo mode still needs them defined.
   ============================================================ */
function lineChart(chart){
  if(!chart) return REPORTS_PROTO.lineChart ? REPORTS_PROTO.lineChart() : '';
  const labels=chart.labels||[], series=chart.series||[];
  if(labels.length<2) return `<div class="muted small" style="padding:18px;text-align:center">Not enough checkpoints to chart.</div>`;
  const W=560,H=240,pl=36,pb=28,pt=12,pr=12;
  const x=i=>pl+i*((W-pl-pr)/(labels.length-1)), y=v=>pt+(100-v)/100*(H-pt-pb);
  const path=a=>{let d='',started=false;a.forEach((v,i)=>{if(v==null){return;}d+=(started?'L':'M')+x(i)+' '+y(v);started=true;});return d;};
  const dots=(a,c)=>a.map((v,i)=>v==null?'':`<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${c}"/>`).join('');
  const grid=[0,25,50,75,100].map(v=>`<line x1="${pl}" y1="${y(v)}" x2="${W-pr}" y2="${y(v)}" stroke="${RCOLORS.grid}"/><text x="6" y="${y(v)+4}" font-size="10" fill="${RCOLORS.axis}">${v}</text>`).join('');
  const xl=labels.map((l,i)=>`<text x="${x(i)}" y="${H-8}" font-size="10" fill="#64748b" text-anchor="middle">${rEsc(l)}</text>`).join('');
  const drawn=series.map((s,si)=>`<path d="${path(s.points)}" fill="none" stroke="${s.color}" stroke-width="${si===0?2.5:2}"/>${dots(s.points,s.color)}`);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${grid}${[...drawn.slice(1),drawn[0]].join('')}${xl}</svg>`;
}
function radarChart(radar){
  if(!radar && REPORTS_PROTO.radarChart) return REPORTS_PROTO.radarChart();
  return `<div class="muted small" style="padding:20px;text-align:center">No 360 data available.</div>`;
}
function firstSvg(html){ if(!html) return null; const a=html.indexOf('<svg'); const b=html.indexOf('</svg>'); return (a>=0&&b>=0)?html.slice(a,b+6):null; }

/* ============================================================
   HTML SECTION RENDERERS

   One function per section key. Each receives the section's `data` plus
   the whole content object (for metrics in the summary band) and returns
   the inner HTML for that <section>.

   A key with no entry here renders nothing, so the Edge Function can add
   a new section before the front end knows about it without breaking.
   ============================================================ */

function _metricTiles(m){
  if(!m) return '';
  const gain = m.technical_gain_pct==null ? '—' : (m.technical_gain_pct>=0?'+':'')+m.technical_gain_pct+'%';
  // Scale comes from metrics, so the tile cannot claim "of 5" on a 1-3
  // instrument. Falls back to a bare number if the scale is unknown, which
  // is better than asserting a wrong denominator.
  const wpMax = m.wpcas_scale_max;
  const wp   = m.wpcas_overall==null ? '—' : m.wpcas_overall;
  const wpLbl = wpMax ? `WPCAS overall (of ${wpMax})` : 'WPCAS overall';
  const stg  = m.stages_completed_pct==null ? '—' : m.stages_completed_pct+'%';
  const r    = m.raters || {};
  const tot  = (r.self||0)+(r.peer||0)+(r.manager||0);
  return `<div class="metric-tiles">
    <div class="mt"><div class="v tnum">${gain}</div><div class="l">Technical gain (baseline→endline)</div></div>
    <div class="mt"><div class="v tnum">${wp}</div><div class="l">${wpLbl}</div></div>
    <div class="mt"><div class="v tnum">${stg}</div><div class="l">Stages completed</div></div>
    <div class="mt"><div class="v tnum">${tot}</div><div class="l">Raters · 360</div></div></div>`;
}

/* Compact competency table used under the technical radar. Inline styles
   because the stylesheet has no table class. */
function _compTable(rows){
  if(!rows || !rows.length) return '';
  const cell='padding:6px 10px;border-bottom:1px solid var(--g100);font-size:12.5px';
  const head='padding:6px 10px;border-bottom:1px solid var(--g200);font-size:11px;color:var(--g500);text-align:left;font-weight:600';
  const anyBase = rows.some(r=>r.baseline_pct!=null);
  const anyEnd  = rows.some(r=>r.endline_pct!=null);
  const body=rows.map(r=>{
    const d = r.delta==null ? '—' : (r.delta>=0?'+':'')+r.delta;
    const dcol = r.delta==null ? 'var(--g500)' : (r.delta>=0?'#2a7040':'#a33');
    return `<tr><td style="${cell}">${rEsc(r.competency)}</td>`
      + (anyBase?`<td style="${cell};text-align:right" class="tnum">${r.baseline_pct==null?'—':r.baseline_pct+'%'}</td>`:'')
      + (anyEnd ?`<td style="${cell};text-align:right" class="tnum">${r.endline_pct==null?'—':r.endline_pct+'%'}</td>`:'')
      + (anyBase&&anyEnd?`<td style="${cell};text-align:right;color:${dcol}" class="tnum">${d}</td>`:'')
      + `</tr>`;
  }).join('');
  return `<div class="card pad" style="margin-top:12px;padding-top:8px">
    <table style="width:100%;border-collapse:collapse">
      <thead><tr><th style="${head}">Competency</th>
        ${anyBase?`<th style="${head};text-align:right">Baseline</th>`:''}
        ${anyEnd ?`<th style="${head};text-align:right">Endline</th>`:''}
        ${anyBase&&anyEnd?`<th style="${head};text-align:right">Change</th>`:''}
      </tr></thead><tbody>${body}</tbody></table></div>`;
}

function _aiBlock(label, text, teal){
  if(!text) return '';
  const style = teal ? ' style="border-color:var(--teal);background:#eef6f0"' : '';
  const lab   = teal ? ' style="background:#dcf0e3;color:#1f5b34"' : '';
  return `<div class="ai-block"${style}><span class="ai-label"${lab}>✦ ${rEsc(label)}</span>
    <p style="margin:8px 0 0">${rEsc(text)}</p></div>`;
}

var SECTION_HTML = {

  summary: function(data, content){
    const s=content.subject||{};
    return `<div class="summary-band"><div>
      <div class="ai-label" style="background:rgba(255,255,255,.18);color:#fff">✦ AI-generated</div>
      <h1 style="color:#fff;margin:10px 0 4px">${rEsc(s.name||'')} — ${content.type==='stage'?'Stage report':'Lifecycle report'}</h1>
      <div style="opacity:.85;font-size:13px">${rEsc(s.meta||'')}${s.cohort_name?' · '+rEsc(s.cohort_name):''}</div></div>
      <p style="margin:14px 0 0;opacity:.95;max-width:600px">${rEsc(data.narrative||'')}</p>
      ${_metricTiles(content.metrics)}</div>`;
  },

  technical: function(data){
    const d=techRadarData(data);
    // Below three competencies a radar is unreadable, so the table carries
    // the section on its own rather than drawing a triangle nobody can read.
    const chart = d
      ? `<div class="card pad" style="display:flex;justify-content:center">${techRadarSVG(d)}</div>
         <div class="legend" style="justify-content:center">
           ${d.secondary?`<span><i style="background:${RCOLORS.secondary}"></i>${rEsc(d.secondaryLabel)}</span>`:''}
           <span><i style="background:${RCOLORS.primary}"></i>${rEsc(d.primaryLabel)}</span></div>`
      : '';
    const oneSided = d && !d.secondary
      ? `<p class="muted small" style="margin:8px 0 0">Only one checkpoint is available, so no change over time is shown.</p>`
      : '';
    return `<p class="muted small" style="margin-bottom:12px">Percentage score per competency, baseline against endline.</p>
      ${chart}${oneSided}${_compTable(data.table)}
      ${_aiBlock('AI interpretation', data.narrative)}`;
  },

  eoca: function(data){
    const svg=eocaBarsSVG(data.bars);
    return `<p class="muted small" style="margin-bottom:12px">Percentage score in each end-of-course assessment.</p>
      ${svg?`<div class="card pad">${svg}</div>`:''}
      ${_aiBlock('AI interpretation', data.narrative)}`;
  },

  wpcas: function(data){
    const charts=(data.charts||[]).map(c=>{
      const svg=lollipopSVG(c, data.scale);
      if(!svg) return '';
      // n_raters is shown so the reader can weigh the number. A peer average
      // over three people and a single manager rating are different kinds of
      // evidence and should not look identical on the page.
      const n = c.n_raters===1 ? '1 rater' : (c.n_raters||0)+' raters';
      return `<div class="card pad" style="margin-top:12px">
        <div class="flex ac jb" style="margin-bottom:6px">
          <b style="font-size:13px">${rEsc(c.label)}</b>
          <span class="tag">${n}</span></div>${svg}</div>`;
    }).join('');

    const band=data.application_band;
    const focus=data.development_focus||[];
    const derived=(band || focus.length) ? `<div class="card pad" style="margin-top:12px">
        <span class="ai-label">✦ Derived from the ratings</span>
        <div class="rep-2col" style="margin-top:10px">
          <div><div class="muted small">Overall application</div><b>${rEsc(band||'—')}</b></div>
          <div><div class="muted small">Development focus (2 lowest)</div><b>${focus.map(rEsc).join(' · ')||'—'}</b></div>
        </div></div>` : '';

    // Describe the scale from the report's own data. Hardcoding "1-5" here
    // was wrong: the WPCAS instrument has three anchors, not five.
    const sc=data.scale||{};
    const scMin=sc.min!=null?sc.min:1, scMax=sc.max!=null?sc.max:3;
    const scaleNote=`Scores are on a ${scMin}–${scMax} scale.`;
    const roundNote = data.round_name
      ? `<p class="muted small" style="margin-bottom:4px">Round: ${rEsc(data.round_name)}. ${scaleNote}</p>`
      : `<p class="muted small" style="margin-bottom:4px">${scaleNote}</p>`;

    return `${roundNote}${charts}${derived}${_aiBlock('AI synthesis', data.narrative)}`;
  },

  per_competency: function(data){
    const rows=(data.rows||[]).map(r=>{
      const bit=(lab,v)=>v==null?'':`<span class="tag" style="margin-right:6px">${lab} ${v}</span>`;
      return `<div class="ai-block" style="margin-top:10px">
        <span class="ai-label">✦ ${rEsc(r.competency)}</span>
        <div style="margin:8px 0 0">
          ${r.technical_pct==null?'':`<span class="tag" style="margin-right:6px">Technical ${r.technical_pct}%</span>`}
          ${bit('Self',r.self)}${bit('Peer',r.peer)}${bit('Manager',r.manager)}
        </div>
        ${r.commentary?`<p style="margin:8px 0 0">${rEsc(r.commentary)}</p>`:''}</div>`;
    }).join('');
    return `<p class="muted small" style="margin-bottom:4px">Technical score and 360 ratings side by side, for competencies measured by both.</p>${rows}`;
  },

  strengths_gaps: function(data){
    const strengths=(data.strengths||[]).map(x=>`<li>${rEsc(x)}</li>`).join('');
    const devs=(data.development_areas||[]).map(x=>`<li>${rEsc(x)}</li>`).join('');
    return `<div class="rep-2col">
      <div class="card pad"><div class="badge ok" style="margin-bottom:8px">Strengths</div>
        <ul style="margin:0;padding-left:18px">${strengths||'<li class="muted">—</li>'}</ul></div>
      <div class="card pad"><div class="badge warn" style="margin-bottom:8px">Development areas</div>
        <ul style="margin:0;padding-left:18px">${devs||'<li class="muted">—</li>'}</ul></div></div>`;
  },

  recommendations: function(data){
    return _aiBlock('AI-generated', data.narrative, true);
  }
};

/* ============================================================
   RENDER A PERSISTED REPORT  (shared by participant + admin views)
   ============================================================ */
function reportsNeedsUpdateCard(opts){
  const btn = opts && opts.pid
    ? `<button class="btn" onclick="reportsRegenerate('${opts.pid}',${opts.admin?true:false})">Update this report</button>`
    : '';
  return `<div class="card pad" style="max-width:620px;text-align:center">
    <div style="font-size:40px">✦</div>
    <h3 style="margin:8px 0">This report needs updating</h3>
    <p class="muted" style="margin:0 auto 16px;max-width:460px">It was generated in an older format. Updating rebuilds it with the current sections and charts.</p>
    ${btn}</div>`;
}

function renderReportFrom(content, opts){
  opts=opts||{};

  // Guard first. An old-shape blob reaching the section walker below would
  // render as a page with a nav and no content, which looks like a bug
  // rather than a report that simply needs regenerating.
  if(!reportsIsV2(content)) return reportsNeedsUpdateCard(opts);

  const s=content.subject||{};
  const sections=content.sections;

  // The nav and the body are built from the same array in the same order,
  // so they cannot disagree about which sections exist.
  const nav=sections.map((sec,i)=>
    `<a href="#${rEsc(sec.key)}"${i===0?' class="on"':''}>${rEsc(sec.title||sec.key)}</a>`
  ).join('');

  const body=sections.map((sec,i)=>{
    const fn=SECTION_HTML[sec.key];
    if(!fn) return '';                        // unknown key: skip, don't break
    const inner=fn(sec.data||{}, content, opts);
    if(!inner) return '';
    const heading = sec.key==='summary' ? '' : `<h2 style="margin-bottom:4px">${rEsc(sec.title||sec.key)}</h2>`;
    return `<section id="${rEsc(sec.key)}"${i?' style="margin-top:26px"':''}>${heading}${inner}</section>`;
  }).join('');

  const regenBtn = opts.canRegenerate
    ? `<button class="btn ghost sm" onclick="reportsRegenerate('${opts.pid}',${opts.admin?true:false})">↻ Regenerate</button>` : '';
  const backBtn = opts.admin
    ? `<button class="btn ghost sm" onclick="REPORTS.adminView=null;renderAdmin()">← All reports</button>` : '';
  const genAt = content.generated_at ? new Date(content.generated_at).toLocaleString() : '';

  // Cache for the PDF export, then patch branding and wire the scroll-spy
  // once this HTML is actually in the DOM.
  REPORTS.exportCtx = { content, opts };
  setTimeout(()=>{ reportsBrandPatch(content, opts); initReportScroll(); }, 0);

  return `<div class="report-wrap"><div class="report-grid">
    <div class="section-nav" id="secNav">${nav}</div>
    <div id="reportRoot">
      <div id="reportBrand">${reportsBrandBarHtml(content.branding||null)}</div>
      <div class="flex jb ac" style="margin-bottom:16px">
        <div class="crumb">${opts.admin?'Reports / '+rEsc(s.name||''):'My Reports / Comprehensive'}</div>
        <div class="flex g8 ac">${backBtn}${regenBtn}
          <button class="btn ghost sm" id="exportPdfBtn" onclick="exportReport()">⤓ Export PDF</button></div></div>
      ${body}
      <p class="muted small" style="margin-top:16px">Narrative sections are generated from server-scored results and the question blueprint${genAt?' · generated '+rEsc(genAt):''}.</p>
    </div></div></div>`;
}

/* ============================================================
   SCROLL-SPY  (overrides participant.js)

   Two fixes over the previous version:
     • the section list is read from the nav links, so any set of sections
       works — previously it was the hardcoded array
       ['summary','technical','behavioral','themes','recs'].
     • renderReportFrom calls this itself, so it runs on the admin side too.
       Previously only renderParticipant() called it.
   ============================================================ */
function initReportScroll(){
  setTimeout(()=>{
    const main=document.querySelector('.main');
    const nav=document.getElementById('secNav');
    if(!main||!nav) return;

    const links=Array.from(nav.querySelectorAll('a'));
    const secs=links
      .map(a=>document.getElementById((a.getAttribute('href')||'').slice(1)))
      .filter(Boolean);
    if(!secs.length) return;

    // Whichever section's top has passed 200px from the viewport top is the
    // one being read. Iterating forwards means the LAST match wins, which is
    // the lowest section scrolled past.
    main.onscroll=()=>{
      let cur=secs[0].id;
      secs.forEach(sec=>{ if(sec.getBoundingClientRect().top<200) cur=sec.id; });
      links.forEach(a=>a.classList.toggle('on', a.getAttribute('href')==='#'+cur));
    };

    links.forEach(a=>a.onclick=e=>{
      e.preventDefault();
      const el=document.getElementById((a.getAttribute('href')||'').slice(1));
      if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
    });
  },50);
}

/* ============================================================
   REPORT BRANDING HEADER  (unchanged)
   ============================================================ */
function reportsBrandUrl(path){
  if (!path) return null;
  const base = (window.CONFIG && window.CONFIG.SUPABASE_URL) || '';
  return base.replace(/\/+$/, '') + '/storage/v1/object/public/org-branding/' + path;
}
function reportsBrandBarHtml(b){
  if (!b) return '';
  const lines = [b.ministry, b.department, b.organisation, b.label, b.sublabel]
    .map(x => (x == null ? '' : String(x).trim())).filter(Boolean);
  const logo  = reportsBrandUrl(b.logo_path);
  if (!lines.length && !logo) return '';
  const txt = lines.map((l, i) => i === 0
    ? `<div style="font-weight:700;color:var(--g800);line-height:1.2">${rEsc(l)}</div>`
    : `<div style="font-size:12px;color:var(--g500);line-height:1.25">${rEsc(l)}</div>`).join('');
  return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--g200)">`
    + (logo ? `<img src="${logo}" alt="" style="height:40px;width:auto;display:block" onerror="this.style.display='none'">` : '')
    + `<div style="min-width:0">${txt}</div></div>`;
}
async function reportsResolveBrand(content, opts){
  if (!reportsLive()) return (content && content.branding) || null;
  try {
    let cohortId = null;
    if ((!opts || !opts.admin) && REPORTS.selfSubject && REPORTS.selfSubject.cohort_id){
      cohortId = REPORTS.selfSubject.cohort_id;
    }
    if (!cohortId && opts && opts.pid){
      const { data } = await sb.from('participants').select('cohort_id').eq('id', opts.pid).maybeSingle();
      cohortId = data ? data.cohort_id : null;
    }
    const { data: org } = await sb.from('organizations').select('brand').limit(1).maybeSingle();
    let brand = (org && org.brand) || {};
    if (cohortId){
      const { data: coh } = await sb.from('cohorts').select('brand').eq('id', cohortId).maybeSingle();
      if (coh && coh.brand) brand = Object.assign({}, brand, coh.brand);
    }
    return Object.assign({}, (content && content.branding) || {}, brand);
  } catch (e){ return (content && content.branding) || null; }
}
async function reportsBrandPatch(content, opts){
  const eff = await reportsResolveBrand(content, opts);
  REPORTS.effectiveBrand = eff;
  const host = document.getElementById('reportBrand');
  if (host) host.innerHTML = reportsBrandBarHtml(eff);
}

/* ============================================================
   PARTICIPANT — My Reports
   Participants keep both Generate and Regenerate, by decision.
   ============================================================ */
function pReport(){
  if(!reportsLive()) return REPORTS_PROTO.pReport ? REPORTS_PROTO.pReport() : '';

  if(REPORTS.selfState==='ready' && REPORTS.selfContent){
    return renderReportFrom(REPORTS.selfContent, { canRegenerate:true, pid:REPORTS.selfPid });
  }
  if(REPORTS.selfState==='stale'){
    return `<div class="page-head"><h1>My Reports</h1></div>
      <div class="card pad" style="max-width:620px;text-align:center">
        <div style="font-size:40px">✦</div>
        <h3 style="margin:8px 0">Your report needs updating</h3>
        <p class="muted" style="margin:0 auto 16px;max-width:460px">It was generated in an older format. Rebuilding it will include your latest assessment scores and 360 feedback.</p>
        <button class="btn" onclick="reportsGenerateSelf()">Update my report</button></div>`;
  }
  if(REPORTS.selfState==='none'){
    return `<div class="page-head"><h1>My Reports</h1></div>
      <div class="card pad" style="max-width:620px;text-align:center">
        <div style="font-size:40px">✦</div>
        <h3 style="margin:8px 0">Your report isn't generated yet</h3>
        <p class="muted" style="margin:0 auto 16px;max-width:440px">We'll analyse your assessment scores against the question blueprint and synthesise your 360 feedback into a development report.</p>
        <button class="btn" onclick="reportsGenerateSelf()">Generate my report</button></div>`;
  }
  if(REPORTS.selfState==='idle'){ REPORTS.selfState='loading'; setTimeout(reportsHydrateSelf,0); }
  return `<div class="page-head"><h1>My Reports</h1></div>
    <div class="card pad" style="text-align:center"><div class="muted small">Loading your report…</div></div>`;
}

async function reportsResolveSelfPid(){
  const want = (window.state && state.pcohort) || null;
  if(REPORTS.selfPid && REPORTS._selfPidCohort===want) return REPORTS.selfPid;
  let uid = (window.AUTH && window.AUTH.uid) || null;
  if(!uid){ try{ const g=await sb.auth.getUser(); uid=g.data&&g.data.user?g.data.user.id:null; }catch(e){} }
  if(!uid) return null;
  const { data:rows } = await sb.from('participants')
    .select('id,name,designation,workstream,location,cohort_id,created_at')
    .eq('user_id', uid).is('deleted_at', null)
    .order('created_at',{ascending:false});
  if(!rows || !rows.length) return null;
  let pick = want ? rows.find(r=>r.cohort_id===want) : null;
  if(!pick) pick = rows[0];
  REPORTS.selfPid=pick.id; REPORTS.selfSubject=pick; REPORTS._selfPidCohort=want;
  return REPORTS.selfPid;
}

async function reportsHydrateSelf(){
  try{
    const pid = await reportsResolveSelfPid();
    if(!pid){ REPORTS.selfState='none'; renderParticipant(); return; }
    const { data } = await sb.from('reports')
      .select('id,content,generated_at,type,status')
      .eq('participant_id', pid).eq('scope','participant').is('deleted_at', null)
      .order('generated_at',{ascending:false}).limit(1).maybeSingle();

    if(!data || !data.content){
      REPORTS.selfState='none';
    } else if(!reportsIsV2(data.content) || data.status==='stale'){
      // A report exists but predates the current shape. Say so plainly
      // rather than pretending nothing is there.
      REPORTS.selfContent=null; REPORTS.selfState='stale';
    } else {
      REPORTS.selfContent=data.content; REPORTS.selfState='ready';
    }
  }catch(e){ console.warn('report hydrate failed',e); REPORTS.selfState='none'; }
  renderParticipant();
}

async function reportsGenerateSelf(){
  const pid = await reportsResolveSelfPid();
  if(!pid){ toast('Could not find your participant record','err'); return; }
  const main=document.querySelector('.main'); if(main) mountOctopus(main,'Analysing your results and writing your report…');
  REPORTS.selfState='generating';
  try{
    const { data, error } = await sb.functions.invoke('generate-report',{ body:{ participant_id:pid, type:'comprehensive' } });
    if(error || (data&&data.error)){ throw new Error((data&&data.error)||error.message||'generation failed'); }
    REPORTS.selfContent=data.content; REPORTS.selfState='ready';
    toast('Report ready','ok');
  }catch(e){
    REPORTS.selfState= REPORTS.selfContent ? 'ready':'none';
    toast(String(e.message||e),'err');
  }
  renderParticipant();
}

function reportsRegenerate(pid, isAdmin){
  showModal({ title:'Regenerate this report?',
    body:'This re-runs the analysis over the latest scores and 360 ratings and replaces the current report. This cannot be undone.',
    confirm:'Regenerate', onConfirm:async()=>{
      closeModal();
      const main=document.querySelector('.main'); if(main) mountOctopus(main,'Regenerating the report…');
      try{
        const { data, error } = await sb.functions.invoke('generate-report',{ body:{ participant_id:pid, type:'comprehensive', regenerate:true } });
        if(error || (data&&data.error)){ throw new Error((data&&data.error)||error.message); }
        if(isAdmin && REPORTS.adminView){ REPORTS.adminView.content=data.content; renderAdmin(); }
        else { REPORTS.selfContent=data.content; REPORTS.selfState='ready'; renderParticipant(); }
        toast('Report regenerated','ok');
      }catch(e){ toast(String(e.message||e),'err'); if(isAdmin) renderAdmin(); else renderParticipant(); }
    }});
}

/* ============================================================
   PDF EXPORT

   Built from the SAME pure SVG generators the HTML renderer uses, and
   driven by the SAME sections array in the same order. Previously the PDF
   had its own hardcoded section order and had to extract SVGs out of
   finished HTML — two things that could silently drift apart.
   ============================================================ */
function _pdfH2(t, margin){ return { text:t, fontSize:13, bold:true, color:'#0f172a', margin: margin || [0,14,0,2] }; }
function _pdfAI(text, stroke, fill){
  return { table:{ widths:['*'], body:[[{ text:text, fontSize:10, lineHeight:1.3, color:'#1e293b', margin:[8,6,8,6], fillColor: fill || '#e6f1f7' }]] },
    layout:{ hLineWidth:()=>0, vLineWidth:(i)=> i===0 ? 3 : 0, vLineColor:()=> stroke || RCOLORS.primary }, margin:[0,4,0,0] };
}
/* pdfmake wants no width attribute fighting its own sizing. */
function _pdfCleanSvg(svg){
  if (!svg) return svg;
  svg = svg.replace(/\swidth="100%"/,'');
  if (!/xmlns=/.test(svg)) svg = svg.replace('<svg','<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}
async function _pdfLogoDataUrl(path){
  try {
    const url = reportsBrandUrl(path); if (!url) return null;
    const r = await fetch(url); if (!r.ok) return null;
    const b = await r.blob();
    return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
  } catch (e){ return null; }
}

/* One PDF builder per section key, mirroring SECTION_HTML. Each pushes
   blocks onto the shared stack. */
var SECTION_PDF = {

  summary: function(data, content, stack){
    const s=content.subject||{}, m=content.metrics||{};
    stack.push({ columns:[
      { width:11, svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="9" height="9"><path d="M6 0 L7.2 4.8 L12 6 L7.2 7.2 L6 12 L4.8 7.2 L0 6 L4.8 4.8 Z" fill="#016796"/></svg>', margin:[0,1,0,0] },
      { width:'*', text:'AI-GENERATED', fontSize:8, bold:true, color:RCOLORS.primary }
    ], columnGap:3, margin:[0,0,0,3] });
    stack.push({ text:`${s.name||''} — ${content.type==='stage'?'Stage report':'Lifecycle report'}`, fontSize:18, bold:true, color:'#013d57' });
    const metaLine=[s.meta,s.cohort_name].filter(Boolean).join(' · ');
    if(metaLine) stack.push({ text:metaLine, fontSize:10, color:'#64748b', margin:[0,2,0,8] });
    if(data.narrative) stack.push({ text:data.narrative, fontSize:10.5, lineHeight:1.3, margin:[0,0,0,8] });

    const r=m.raters||{};
    const tiles=[
      ['Technical gain', m.technical_gain_pct==null?'—':(m.technical_gain_pct>=0?'+':'')+m.technical_gain_pct+'%'],
      ['WPCAS overall',  m.wpcas_overall==null?'—':String(m.wpcas_overall)+(m.wpcas_scale_max?' / '+m.wpcas_scale_max:'')],
      ['Stages done',    m.stages_completed_pct==null?'—':m.stages_completed_pct+'%'],
      ['Raters · 360',   String((r.self||0)+(r.peer||0)+(r.manager||0))]
    ];
    stack.push({ columns: tiles.map(([l,v])=>({ width:'*', stack:[
      { text:v, fontSize:13, bold:true, color:'#013d57' },
      { text:l, fontSize:8, color:'#64748b' }
    ]})), columnGap:10, margin:[0,0,0,10] });
  },

  technical: function(data, content, stack){
    stack.push(_pdfH2('Technical progression'));
    const d=techRadarData(data);
    if(d){
      stack.push({ svg:_pdfCleanSvg(techRadarSVG(d)), width:340, alignment:'center', margin:[0,4,0,2] });
      const legend=[d.secondary?d.secondaryLabel:null, d.primaryLabel].filter(Boolean).join('  vs  ');
      stack.push({ text:legend, fontSize:8, color:'#64748b', alignment:'center', margin:[0,0,0,6] });
    }
    const rows=data.table||[];
    if(rows.length){
      const anyBase=rows.some(r=>r.baseline_pct!=null), anyEnd=rows.some(r=>r.endline_pct!=null);
      const head=['Competency'];
      if(anyBase) head.push('Baseline');
      if(anyEnd)  head.push('Endline');
      if(anyBase&&anyEnd) head.push('Change');
      const body=[head.map(h=>({ text:h, fontSize:8, bold:true, color:'#64748b' }))];
      rows.forEach(r=>{
        const line=[{ text:r.competency||'', fontSize:9 }];
        if(anyBase) line.push({ text:r.baseline_pct==null?'—':r.baseline_pct+'%', fontSize:9, alignment:'right' });
        if(anyEnd)  line.push({ text:r.endline_pct==null?'—':r.endline_pct+'%', fontSize:9, alignment:'right' });
        if(anyBase&&anyEnd) line.push({ text:r.delta==null?'—':(r.delta>=0?'+':'')+r.delta, fontSize:9, alignment:'right' });
        body.push(line);
      });
      stack.push({ table:{ headerRows:1, widths:[ '*', ...head.slice(1).map(()=>46) ], body },
        layout:{ hLineWidth:(i)=> i===1?0.7:0.3, vLineWidth:()=>0, hLineColor:()=>'#e2e8f0' }, margin:[0,2,0,4] });
    }
    if(data.narrative) stack.push(_pdfAI(data.narrative));
  },

  eoca: function(data, content, stack){
    stack.push(_pdfH2('EOCA performance'));
    const svg=eocaBarsSVG(data.bars);
    if(svg) stack.push({ svg:_pdfCleanSvg(svg), width:400, alignment:'center', margin:[0,4,0,4] });
    if(data.narrative) stack.push(_pdfAI(data.narrative));
  },

  wpcas: function(data, content, stack){
    stack.push(_pdfH2('WPCAS 360 ratings'));
    (data.charts||[]).forEach(c=>{
      const svg=lollipopSVG(c, data.scale);
      if(!svg) return;
      const n = c.n_raters===1 ? '1 rater' : (c.n_raters||0)+' raters';
      stack.push({ text:`${c.label} · ${n}`, fontSize:9, bold:true, color:'#01536f', margin:[0,6,0,2] });
      stack.push({ svg:_pdfCleanSvg(svg), width:420, alignment:'center', margin:[0,0,0,4] });
    });
    if(data.application_band || (data.development_focus||[]).length){
      stack.push({ columns:[
        { width:'*', stack:[{ text:'Overall application', fontSize:8, color:'#64748b' }, { text:data.application_band||'—', fontSize:10, bold:true }] },
        { width:'*', stack:[{ text:'Development focus', fontSize:8, color:'#64748b' }, { text:(data.development_focus||[]).join(' · ')||'—', fontSize:10, bold:true }] }
      ], columnGap:16, margin:[0,4,0,4] });
    }
    if(data.narrative) stack.push(_pdfAI(data.narrative));
  },

  per_competency: function(data, content, stack){
    stack.push(_pdfH2('Per-competency performance'));
    (data.rows||[]).forEach(r=>{
      const bits=[];
      if(r.technical_pct!=null) bits.push('Technical '+r.technical_pct+'%');
      if(r.self!=null)    bits.push('Self '+r.self);
      if(r.peer!=null)    bits.push('Peer '+r.peer);
      if(r.manager!=null) bits.push('Manager '+r.manager);
      stack.push({ text:r.competency||'', bold:true, fontSize:10, color:'#01536f', margin:[0,6,0,1] });
      if(bits.length) stack.push({ text:bits.join('  ·  '), fontSize:8.5, color:'#64748b', margin:[0,0,0,2] });
      if(r.commentary) stack.push({ text:r.commentary, fontSize:10, lineHeight:1.3 });
    });
  },

  strengths_gaps: function(data, content, stack){
    stack.push(_pdfH2('Strengths & development areas'));
    const strengths=data.strengths||[], devs=data.development_areas||[];
    stack.push({ columns:[
      { width:'*', stack:[{ text:'Strengths', bold:true, fontSize:9, color:'#2a7040', margin:[0,2,0,3] }, strengths.length?{ ul:strengths, fontSize:10 }:{ text:'—', color:'#94a3b8' }] },
      { width:'*', stack:[{ text:'Development areas', bold:true, fontSize:9, color:'#8a6406', margin:[0,2,0,3] }, devs.length?{ ul:devs, fontSize:10 }:{ text:'—', color:'#94a3b8' }] }
    ], columnGap:16 });
  },

  recommendations: function(data, content, stack){
    stack.push(_pdfH2('Recommendations'));
    if(data.narrative) stack.push(_pdfAI(data.narrative, RCOLORS.secondary, '#eef6f0'));
  }
};

async function exportReport(){
  if(!reportsLive()) return REPORTS_PROTO.exportReport ? REPORTS_PROTO.exportReport() : null;
  const ctx = REPORTS.exportCtx;
  const content = ctx && ctx.content;
  if(!content){ toast('Nothing to export','err'); return; }
  if(!reportsIsV2(content)){ toast('This report needs updating before it can be exported','err'); return; }
  if(!window.pdfMake){ toast('PDF library not loaded','err'); return; }

  const btn=document.getElementById('exportPdfBtn');
  if(btn){ btn.disabled=true; btn.textContent='Preparing…'; }

  try{
    const s=content.subject||{};
    const brand = REPORTS.effectiveBrand || content.branding || null;
    const stack=[];

    // branding header
    const brandLines=[brand&&brand.ministry,brand&&brand.department,brand&&brand.organisation,brand&&brand.label,brand&&brand.sublabel]
      .map(x=>(x==null?'':String(x).trim())).filter(Boolean);
    const logoData = (brand&&brand.logo_path) ? await _pdfLogoDataUrl(brand.logo_path) : null;
    if(logoData || brandLines.length){
      const textStack=brandLines.map((l,i)=>({ text:l, bold:i===0, fontSize:i===0?12:9, color:i===0?'#1e293b':'#64748b' }));
      stack.push(logoData
        ? { columns:[{ image:logoData, width:38, margin:[0,0,10,0] }, { stack:textStack, width:'*' }], margin:[0,0,0,6] }
        : { stack:textStack, margin:[0,0,0,6] });
      stack.push({ canvas:[{ type:'line', x1:0, y1:0, x2:515, y2:0, lineWidth:0.7, lineColor:'#e2e8f0' }], margin:[0,0,0,12] });
    }

    // Same array, same order, same generators as the screen.
    content.sections.forEach(sec=>{
      const fn=SECTION_PDF[sec.key];
      if(fn) fn(sec.data||{}, content, stack);
    });

    const genAt=content.generated_at?new Date(content.generated_at).toLocaleString():'';
    stack.push({ text:`Narrative sections are generated from server-scored results and the question blueprint${genAt?' · generated '+genAt:''}.`, fontSize:8, color:'#94a3b8', margin:[0,14,0,0] });

    const docDef={ pageSize:'A4', pageMargins:[40,40,40,40], defaultStyle:{ fontSize:10, color:'#1e293b' }, content:stack };
    const who=(s.name||'report').replace(/[^a-z0-9]+/gi,'_');
    pdfMake.createPdf(docDef).download(who+'_report.pdf');
    toast('Report exported to PDF','ok');
  }catch(e){ console.warn(e); toast('PDF export failed','err'); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='⤓ Export PDF'; } }
}

/* ============================================================
   ADMIN — Reports list + open + cohort fan-out
   ============================================================ */
function vReports(){
  if(!reportsLive()) return REPORTS_PROTO.vReports ? REPORTS_PROTO.vReports() : '';
  if(REPORTS.adminView && REPORTS.adminView.content){
    return renderReportFrom(REPORTS.adminView.content, { admin:true, canRegenerate:true, pid:REPORTS.adminView.pid });
  }
  setTimeout(reportsHydrateAdminList,0);

  // If a cohort run is going and the admin closed the modal ("Run in
  // background"), there would otherwise be no sign it is still happening.
  const f=REPORTS.fanout;
  const banner=(f && f.running)
    ? `<div class="card pad flex ac jb" style="margin-bottom:12px;border-color:var(--indigo)">
        <div><b>Report generation running</b>
          <div class="muted small">${f.done} of ${f.total} complete${f.cancelRequested?' · stopping':''}</div></div>
        <button class="btn ghost sm" onclick="renderFanoutModal()">Show progress</button></div>`
    : '';

  return `<div class="crumb">Reports</div><div class="page-head"><h1>Reports</h1>
    <button class="btn" onclick="reportsCohortFanout()">＋ Generate cohort report</button></div>
    ${banner}
    <div class="card pad"><h3 style="margin-bottom:12px">Individual reports</h3>
      <div id="reportList"><div class="muted small">Loading participants…</div></div></div>`;
}

async function reportsHydrateAdminList(){
  const host=document.getElementById('reportList'); if(!host) return;
  const coh=reportsCohortId();
  if(!coh){ host.innerHTML='<div class="muted small">Select a cohort to see its participants.</div>'; return; }
  try{
    const [{data:parts},{data:reps}] = await Promise.all([
      sb.from('participants').select('id,name,designation,workstream,location').eq('cohort_id',coh).is('deleted_at',null).order('name'),
      // status is selected so the list can distinguish a current report from
      // one that predates the v2 shape, without pulling every content blob.
      sb.from('reports').select('participant_id,generated_at,type,status').eq('cohort_id',coh).eq('scope','participant').is('deleted_at',null)
    ]);
    const repBy={}; (reps||[]).forEach(r=>{ repBy[r.participant_id]=r; });
    if(!parts || !parts.length){ host.innerHTML='<div class="muted small">No participants in this cohort yet.</div>'; return; }

    host.innerHTML=parts.map(p=>{
      const rep=repBy[p.id];
      const safeName=rEsc(p.name).replace(/'/g,"\\'");
      let right;
      if(!rep){
        right=`<button class="btn ghost sm" onclick="reportsAdminGenerate('${p.id}',this)">Generate</button>`;
      } else if(rep.status==='stale'){
        right=`<div class="flex g8 ac"><span class="badge warn">needs update</span>
          <button class="btn ghost sm" onclick="reportsAdminGenerate('${p.id}',this)">Update</button></div>`;
      } else {
        right=`<div class="flex g8 ac"><span class="badge ok">✓ ready</span>
          <button class="btn ghost sm" onclick="reportsAdminOpen('${p.id}','${safeName}')">Open →</button></div>`;
      }
      return `<div class="flex ac jb" style="padding:11px 0;border-bottom:1px solid var(--g100)">
        <div class="flex ac g12"><div class="avatar" style="background:var(--teal)">${initials(p.name)}</div>
        <div><b>${rEsc(p.name)}</b><div class="muted small">${rEsc([p.designation,p.workstream,p.location].filter(Boolean).join(' · ')||'Team member')}</div></div></div>
        ${right}</div>`;
    }).join('');
  }catch(e){ host.innerHTML='<div class="badge err">Could not load: '+rEsc(e.message||e)+'</div>'; }
}

async function reportsAdminOpen(pid,name){
  const main=document.querySelector('.main'); if(main) main.innerHTML='<div class="card pad"><div class="muted small">Opening report…</div></div>';
  try{
    const { data } = await sb.from('reports').select('content').eq('participant_id',pid)
      .eq('scope','participant').is('deleted_at',null).order('generated_at',{ascending:false}).limit(1).maybeSingle();
    if(!data || !data.content){ toast('No report found','err'); REPORTS.adminView=null; renderAdmin(); return; }
    REPORTS.adminView={ pid, name, content:data.content };
    renderAdmin();
  }catch(e){ toast(String(e.message||e),'err'); REPORTS.adminView=null; renderAdmin(); }
}

async function reportsAdminGenerate(pid, btn){
  if(btn){ btn.disabled=true; btn.textContent='Generating…'; }
  try{
    // regenerate:true so an existing stale row is rebuilt rather than
    // returned as-is by the function's cheap re-read path.
    const { data, error } = await sb.functions.invoke('generate-report',{ body:{ participant_id:pid, type:'comprehensive', regenerate:true } });
    if(error || (data&&data.error)){ throw new Error((data&&data.error)||error.message); }
    toast('Report generated','ok'); reportsHydrateAdminList();
  }catch(e){ toast(String(e.message||e),'err'); if(btn){ btn.disabled=false; btn.textContent='Generate'; } }
}

/* ============================================================
   COHORT FAN-OUT — start, stop, and resume

   HOW "STOP" ACTUALLY WORKS, AND WHAT IT CANNOT DO

   Each report is a separate HTTPS request to the Edge Function. Once a
   request has left the browser there is no way to recall it — the server
   will finish generating that report whatever we do here.

   So cancellation is checked BETWEEN participants, at the top of each
   worker's loop. Pressing Stop means "start no more", not "abort what is
   running". With three workers, up to three reports finish after you press
   it. The dialog says so rather than pretending otherwise.

   The whole run lives in this browser tab. Closing the tab stops it — the
   reports already generated are saved, the rest simply never start. That is
   safe, just worth knowing before someone closes their laptop halfway.
   ============================================================ */

/* Step 1 — work out what actually needs generating, then ask.
   Regenerating a report that is already current costs a language-model call
   and produces the same document, so the default is to skip those. */
async function reportsCohortFanout(){
  const coh=reportsCohortId();
  if(!coh){ toast('Select a cohort first','err'); return; }

  // Already running? Just show the progress dialog again.
  if(REPORTS.fanout && REPORTS.fanout.running){ renderFanoutModal(); return; }

  let parts=null, reps=null;
  try{
    const res=await Promise.all([
      sb.from('participants').select('id,name').eq('cohort_id',coh).is('deleted_at',null).order('name'),
      sb.from('reports').select('participant_id,status').eq('cohort_id',coh).eq('scope','participant').is('deleted_at',null)
    ]);
    parts=res[0].data; reps=res[1].data;
  }catch(e){ toast('Could not load the cohort','err'); return; }

  if(!parts || !parts.length){ toast('No participants in this cohort','err'); return; }

  const statusBy={}; (reps||[]).forEach(r=>{ statusBy[r.participant_id]=r.status; });
  const missing = parts.filter(p=>!statusBy[p.id]);
  const stale   = parts.filter(p=>statusBy[p.id] && statusBy[p.id]!=='ready');
  const current = parts.filter(p=>statusBy[p.id]==='ready');
  const needing = missing.concat(stale);

  REPORTS._fanoutPlan={ all:parts, needing:needing };

  const allLink = `<p style="margin:12px 0 0"><a href="#" style="font-size:12px"
      onclick="event.preventDefault();reportsFanoutStart('all')">Or regenerate all ${parts.length}, including the ${current.length} already current</a></p>`;

  showModal({
    title:'Generate cohort reports',
    body:`<p class="muted small" style="margin-top:0">${parts.length} participant${parts.length===1?'':'s'} in this cohort.</p>
      <div class="kv" style="margin-bottom:12px">
        <div>No report yet</div><div class="tnum">${missing.length}</div>
        <div>Needs updating</div><div class="tnum">${stale.length}</div>
        <div>Already current</div><div class="tnum">${current.length}</div>
      </div>
      <p class="muted small">Each report is one language-model call, so the default skips reports that are already current.</p>
      <p class="muted small">This runs in this browser tab. You can close the dialog and keep working, but closing the tab stops it.</p>
      ${current.length?allLink:''}`,
    confirm: needing.length ? `Generate ${needing.length}` : 'Nothing to generate',
    onConfirm: needing.length ? function(){ reportsFanoutStart('needing'); } : closeModal
  });
}

/* Step 2 — run it. `mode` is 'needing' or 'all'. */
async function reportsFanoutStart(mode){
  const plan=REPORTS._fanoutPlan;
  if(!plan){ toast('Nothing planned','err'); return; }
  const list = (mode==='all') ? plan.all : plan.needing;
  if(!list.length){ closeModal(); return; }

  REPORTS.fanout={
    items: list.map(p=>({ id:p.id, name:p.name, status:'queued', err:null })),
    done:0,
    total:list.length,
    running:true,
    cancelRequested:false,   // set by the Stop button
    inFlight:0,              // how many requests are mid-air right now
    stoppedEarly:false
  };
  renderFanoutModal();

  const f=REPORTS.fanout;
  const CONCURRENCY=3;
  let cursor=0;

  async function worker(){
    while(true){
      // THE CANCELLATION CHECK. Between participants, never mid-request.
      if(f.cancelRequested) break;
      if(cursor >= f.items.length) break;

      const it=f.items[cursor++];
      it.status='generating'; f.inFlight++;
      updateFanoutRow(it); updateFanoutHead();

      try{
        // regenerate:true so a stale row is rebuilt rather than handed back
        // unchanged by the Edge Function's cheap re-read path.
        const { data, error } = await sb.functions.invoke('generate-report',{
          body:{ participant_id:it.id, type:'comprehensive', regenerate:true }
        });
        if(error || (data&&data.error)) throw new Error((data&&data.error)||error.message);
        it.status='done';
      }catch(e){
        it.status='error'; it.err=String(e.message||e);
      }

      f.inFlight--; f.done++;
      updateFanoutRow(it); updateFanoutHead();
    }
  }

  await Promise.all(Array.from({length:Math.min(CONCURRENCY,f.items.length)}, worker));

  // Anything still queued when we stopped was never attempted. Say that
  // rather than leaving it looking like it is still waiting its turn.
  if(f.cancelRequested){
    f.stoppedEarly=true;
    f.items.forEach(it=>{ if(it.status==='queued'){ it.status='skipped'; updateFanoutRow(it); } });
  }

  f.running=false;
  updateFanoutHead();

  const okCount   = f.items.filter(i=>i.status==='done').length;
  const failCount = f.items.filter(i=>i.status==='error').length;
  const skipCount = f.items.filter(i=>i.status==='skipped').length;

  let msg, kind;
  if(f.stoppedEarly){
    msg=`Stopped · ${okCount} generated, ${skipCount} not started` + (failCount?`, ${failCount} failed`:'');
    kind='err';
  } else if(failCount){
    msg=`Finished · ${okCount} generated, ${failCount} failed`;
    kind='err';
  } else {
    msg=`Cohort reports complete · ${okCount} generated`;
    kind='ok';
  }
  toast(msg, kind);

  reportsHydrateAdminList();
}

/* Step 3 — the Stop button. Sets a flag; the workers notice it on their
   next pass. Deliberately does not try to abort in-flight requests. */
function reportsFanoutStop(){
  const f=REPORTS.fanout;
  if(!f || !f.running || f.cancelRequested) return;
  f.cancelRequested=true;
  updateFanoutHead();
}

function fanoutPill(s){
  return s==='done'       ? '<span class="badge ok">✓ done</span>'
       : s==='generating' ? '<span class="badge info">generating…</span>'
       : s==='error'      ? '<span class="badge err">failed</span>'
       : s==='skipped'    ? '<span class="tag">not started</span>'
       : '<span class="tag">queued</span>';
}

function renderFanoutModal(){
  const f=REPORTS.fanout;
  if(!f) return;
  const host=document.getElementById('modalRoot');
  // The dialog is only a view onto the run. If the host is missing for any
  // reason, carry on generating silently rather than throwing and killing
  // the workers mid-cohort.
  if(!host) return;
  const rows=f.items.map(it=>`<div class="flex ac jb" id="fo_${it.id}" style="padding:8px 0;border-bottom:1px solid var(--g100)">
    <span>${rEsc(it.name)}</span>${fanoutPill(it.status)}</div>`).join('');
  host.innerHTML=`<div class="modal-bg">
    <div class="modal" style="max-width:560px">
      <div class="mh"><h2>Generating cohort reports</h2></div>
      <div class="mb">
        <div id="foHead" class="muted small" style="margin-bottom:6px"></div>
        <div class="bar" style="margin-bottom:10px"><i id="foBar" style="width:0%"></i></div>
        <div style="max-height:300px;overflow:auto">${rows}</div>
      </div>
      <div class="mf flex g8 ac">
        <button class="btn ghost" id="foStop" onclick="reportsFanoutStop()">■ Stop</button>
        <button class="btn ghost" id="foClose" onclick="closeModal()">Run in background</button>
      </div></div></div>`;
  updateFanoutHead();
}

function updateFanoutRow(it){
  const el=document.getElementById('fo_'+it.id);
  if(el){ const pill=el.querySelector('.badge,.tag'); if(pill) pill.outerHTML=fanoutPill(it.status); }
}

function updateFanoutHead(){
  const f=REPORTS.fanout;
  if(!f) return;
  const head=document.getElementById('foHead');
  const bar=document.getElementById('foBar');
  const close=document.getElementById('foClose');
  const stop=document.getElementById('foStop');

  let msg;
  if(f.running && f.cancelRequested){
    // Being explicit here matters. "Stopping" with a spinner and no
    // explanation looks broken; naming the in-flight count explains the wait.
    msg = f.inFlight
      ? `Stopping — finishing ${f.inFlight} already in progress…`
      : 'Stopping…';
  } else if(f.running){
    msg = `${f.done} of ${f.total} complete · generating…`;
  } else if(f.stoppedEarly){
    const skipped=f.items.filter(i=>i.status==='skipped').length;
    msg = `Stopped · ${f.done} of ${f.total} complete, ${skipped} not started`;
  } else {
    msg = `${f.done} of ${f.total} complete`;
  }

  if(head) head.textContent=msg;
  if(bar)  bar.style.width=Math.round(100*f.done/Math.max(1,f.total))+'%';

  if(stop){
    if(!f.running){ stop.style.display='none'; }
    else {
      stop.disabled = !!f.cancelRequested;
      stop.textContent = f.cancelRequested ? 'Stopping…' : '■ Stop';
    }
  }
  if(close && !f.running) close.textContent='Close';
}
