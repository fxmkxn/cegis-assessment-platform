/* ============================================================
   CEGIS — js/reports.js  (Phase 10, front end)

   Wires the report screens to real, persisted data:

   • Participant "My Reports" (pReport): reads the latest persisted
     report from reports.content and renders it. The octopus loader
     shows ONLY on first generation or an explicit Regenerate — a
     report that already exists is re-read silently.
   • Admin Reports (vReports): per-participant generate/open + a
     "Generate cohort report" FAN-OUT (one Edge Function request per
     participant, bounded parallelism, per-row progress — no queue).
   • Data-driven lineChart()/radarChart(): the prototype's exact SVG,
     fed the persisted numeric series instead of hard-coded arrays.
   • exportReport(): real client-side PDF via jsPDF + html2canvas,
     kept OFF the generation path (it rasterizes the already-rendered
     report; it never calls the LLM).

   All numbers come from the server (deterministic, scored in Postgres);
   the LLM only wrote the prose. This module never recomputes a score.

   Globals from earlier phases: sb (Supabase client), SUPABASE_CONFIGURED,
   AUTH, mountOctopus, showModal/closeModal, toast, initials, meta, ME,
   nameOf, initReportScroll, render, renderParticipant, state.

   Load order: AFTER participant.js (which defines the prototype stubs)
   and wpca.js, BEFORE app.js:
     <script src="js/reports.js"></script>
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
  _selfPidCohort: undefined, // #13 which cohort selfPid was resolved for
  selfContent: null,    // cached persisted content for self
  selfState:   'idle',  // idle | loading | none | ready | generating
  adminView:   null,    // { pid, name, content } when an admin opens one
  fanout:      null      // cohort fan-out progress model
};

function reportsLive(){ return !!(window.SUPABASE_CONFIGURED && window.sb); }
function rEsc(s){ return String(s==null?'':s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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
   DATA-DRIVEN CHARTS  (prototype SVG, persisted numbers)
   ============================================================ */
function lineChart(chart){
  if(!chart) return REPORTS_PROTO.lineChart ? REPORTS_PROTO.lineChart() : '';
  const labels=chart.labels||[], series=chart.series||[];
  if(labels.length<2){
    return `<div class="muted small" style="padding:18px;text-align:center">
      Technical progression needs at least two completed checkpoints to chart.
      ${labels.length===1?`<div style="margin-top:6px"><b>${rEsc(labels[0])}</b>: ${series[0]&&series[0].points[0]!=null?series[0].points[0]+'%':'—'}</div>`:''}</div>`;
  }
  const W=560,H=240,pl=36,pb=28,pt=12,pr=12;
  const x=i=>pl+i*((W-pl-pr)/(labels.length-1)), y=v=>pt+(100-v)/100*(H-pt-pb);
  // path over consecutive non-null points only (gaps tolerated)
  const path=a=>{let d='',started=false;a.forEach((v,i)=>{if(v==null){return;}d+=(started?'L':'M')+x(i)+' '+y(v);started=true;});return d;};
  const dots=(a,c)=>a.map((v,i)=>v==null?'':`<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${c}"/>`).join('');
  const grid=[0,25,50,75,100].map(v=>`<line x1="${pl}" y1="${y(v)}" x2="${W-pr}" y2="${y(v)}" stroke="#e2e8f0"/><text x="6" y="${y(v)+4}" font-size="10" fill="#94a3b8">${v}</text>`).join('');
  const xl=labels.map((l,i)=>`<text x="${x(i)}" y="${H-8}" font-size="10" fill="#64748b" text-anchor="middle">${rEsc(l)}</text>`).join('');
  // draw extra series first, overall (series[0]) last so it sits on top
  const drawn=series.map((s,si)=>`<path d="${path(s.points)}" fill="none" stroke="${s.color}" stroke-width="${si===0?2.5:2}"/>${dots(s.points,s.color)}`);
  const ordered=[...drawn.slice(1),drawn[0]].join('');
  const legend=series.map(s=>`<span><i style="background:${s.color}"></i>${rEsc(s.name)}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${grid}${ordered}${xl}</svg>
    <div class="legend">${legend}</div>`;
}
function radarChart(radar){
  if(!radar) return `<div class="muted small" style="padding:20px;text-align:center">No 360 data available yet.</div>`;
  if(radar.axes===undefined && REPORTS_PROTO.radarChart) return REPORTS_PROTO.radarChart(); // demo signature
  const axes=radar.axes||[], self=radar.self||[], other=radar.others;
  if(!axes.length) return `<div class="muted small" style="padding:20px;text-align:center">No 360 data available yet.</div>`;
  const cx=170,cy=160,R=120,N=axes.length,max=5;
  const pt=(i,v)=>{const a=-Math.PI/2+i*2*Math.PI/N,r=v/max*R;return [cx+r*Math.cos(a),cy+r*Math.sin(a)];};
  const ring=l=>{let p='';for(let i=0;i<N;i++){const[x,y]=pt(i,l);p+=(i?'L':'M')+x+' '+y;}return p+'Z';};
  const poly=(a,c,f)=>{let p='';a.forEach((v,i)=>{const[x,y]=pt(i,v);p+=(i?'L':'M')+x+' '+y;});return `<path d="${p}Z" fill="${f}" stroke="${c}" stroke-width="2"/>`;};
  const spokes=axes.map((_,i)=>{const[x,y]=pt(i,max);return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e2e8f0"/>`;}).join('');
  const labs=axes.map((a,i)=>{const[x,y]=pt(i,max+0.6);return `<text x="${x}" y="${y}" font-size="10.5" fill="#475569" text-anchor="middle">${rEsc(a)}</text>`;}).join('');
  const rings=[1,2,3,4,5].map(l=>`<path d="${ring(l)}" fill="none" stroke="#e6f1f7"/>`).join('');
  const otherPoly=(other&&other.length===N)?poly(other,'#3c9052','rgba(60,144,82,.15)'):'';
  return `<svg viewBox="0 0 340 320" width="340" height="300">${rings}${spokes}${otherPoly}${poly(self,'#016796','rgba(1,103,150,.18)')}${labs}</svg>`;
}

/* ---- technical competency radar: one axis per competency, Baseline vs Latest (0-100) ---- */
function _trFirst(a){ for(const v of a){ if(v!=null) return Number(v); } return null; }
function _trLast(a){ for(let i=a.length-1;i>=0;i--){ if(a[i]!=null) return Number(a[i]); } return null; }
function techRadarData(chart){
  if(!chart || !Array.isArray(chart.series)) return null;
  const comp=chart.series.filter(s=>s && s.name!=='Overall' && Array.isArray(s.points));
  if(comp.length<3) return null;                        // a radar needs >=3 axes to read well
  const axes=comp.map(s=>s.name);
  const latest=comp.map(s=>_trLast(s.points));
  const multi=(chart.labels||[]).length>=2;
  let baseline=multi?comp.map(s=>_trFirst(s.points)):null;
  if(baseline && baseline.every((v,i)=>v===latest[i])) baseline=null;   // single distinct checkpoint
  return { axes, latest, baseline };
}
function techRadarSVG(d){
  const axes=d.axes, N=axes.length, cx=190,cy=175,R=125,max=100;
  const pt=(i,v)=>{const a=-Math.PI/2+i*2*Math.PI/N,r=(v==null?0:v)/max*R;return [cx+r*Math.cos(a),cy+r*Math.sin(a)];};
  const ringPath=l=>{let p='';for(let i=0;i<N;i++){const[x,y]=pt(i,l);p+=(i?'L':'M')+x+' '+y;}return p+'Z';};
  const poly=(arr,stroke,fill)=>{let p='';arr.forEach((v,i)=>{const[x,y]=pt(i,v);p+=(i?'L':'M')+x+' '+y;});return `<path d="${p}Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;};
  const rings=[25,50,75,100].map(l=>`<path d="${ringPath(l)}" fill="none" stroke="#e6f1f7"/>`).join('');
  const spokes=axes.map((_,i)=>{const[x,y]=pt(i,max);return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e2e8f0"/>`;}).join('');
  const labs=axes.map((a,i)=>{const[x,y]=pt(i,max*1.12);const anchor=Math.abs(x-cx)<8?'middle':(x<cx?'end':'start');return `<text x="${x}" y="${y}" font-size="10.5" fill="#475569" text-anchor="${anchor}">${rEsc(a)}</text>`;}).join('');
  const base=d.baseline?poly(d.baseline,'#3c9052','rgba(60,144,82,.14)'):'';
  const latest=poly(d.latest,'#016796','rgba(1,103,150,.18)');
  return `<svg viewBox="0 0 380 350" width="380" height="330" xmlns="http://www.w3.org/2000/svg">${rings}${spokes}${base}${latest}${labs}</svg>`;
}
function techRadarChart(chart){
  const d=techRadarData(chart);
  if(!d) return lineChart(chart);                        // <3 competencies → keep the trend line
  const legend=d.baseline
    ? `<div class="legend" style="justify-content:center"><span><i style="background:#3c9052"></i>Baseline</span><span><i style="background:#016796"></i>Latest</span></div>`
    : `<div class="legend" style="justify-content:center"><span><i style="background:#016796"></i>Score</span></div>`;
  return `<div style="display:flex;justify-content:center">${techRadarSVG(d)}</div>${legend}`;
}
function firstSvg(html){ if(!html) return null; const a=html.indexOf('<svg'); const b=html.indexOf('</svg>'); return (a>=0&&b>=0)?html.slice(a,b+6):null; }

/* ============================================================
   RENDER A PERSISTED REPORT  (shared by participant + admin views)
   ============================================================ */
function reportMetricTiles(m){
  const gain = m.technical_gain_pct==null ? '—' : (m.technical_gain_pct>=0?'+':'')+m.technical_gain_pct+'%';
  const beh  = m.behavioral_score==null ? '—' : m.behavioral_score;
  const stg  = m.stages_completed_pct==null ? '—' : m.stages_completed_pct+'%';
  const rat  = m.raters || 0;
  return `<div class="metric-tiles">
    <div class="mt"><div class="v tnum">${gain}</div><div class="l">Technical gain (first→last)</div></div>
    <div class="mt"><div class="v tnum">${beh}</div><div class="l">Behavioral score (of 5)</div></div>
    <div class="mt"><div class="v tnum">${stg}</div><div class="l">Stages completed</div></div>
    <div class="mt"><div class="v tnum">${rat}</div><div class="l">Raters · 360</div></div></div>`;
}
function renderReportFrom(content, opts){
  opts=opts||{};
  const n=content.narrative||{}, s=content.subject||{}, c=content.charts||{};
  const first=(s.name||'').split(/\s+/)[0]||'This participant';
  const perComp=(n.per_competency||[]).map(pc=>`<div class="ai-block" style="margin-top:10px">
    <span class="ai-label">✦ ${rEsc(pc.competency)}</span>
    <p style="margin:8px 0 0">${rEsc(pc.commentary)}</p></div>`).join('') ||
    `<p class="muted small">No competency tags on this assessment blueprint.</p>`;
  const strengths=(n.strengths||[]).map(x=>`<li>${rEsc(x)}</li>`).join('');
  const devs=(n.development_areas||[]).map(x=>`<li>${rEsc(x)}</li>`).join('');
  const suppNote=(content.notes&&content.notes.behavioral_suppressed)
    ? `<p class="muted small" style="margin-top:8px">Pooled-other ratings are withheld because fewer than ${content.notes.anonymity_floor||3} raters responded — protecting rater confidentiality. Only the self-assessment is charted.</p>`
    : '';
  const regenBtn = opts.canRegenerate
    ? `<button class="btn ghost sm" onclick="reportsRegenerate('${opts.pid}',${opts.admin?true:false})">↻ Regenerate</button>` : '';
  const backBtn = opts.admin
    ? `<button class="btn ghost sm" onclick="REPORTS.adminView=null;renderAdmin()">← All reports</button>` : '';
  const genAt = content.generated_at ? new Date(content.generated_at).toLocaleString() : '';
  // #8 branding: always resolve the CURRENT org/cohort branding (Ministry/
  // Department/Organisation) and patch it in after paint, so the report header
  // and the banner stay consistent. Cache context for the PDF export.
  REPORTS.exportCtx = { content, opts };
  setTimeout(() => reportsBrandPatch(content, opts), 0);

  return `<div class="report-wrap"><div class="report-grid">
    <div class="section-nav" id="secNav">
      <a href="#summary" class="on">Summary</a><a href="#technical">Technical progression</a>
      <a href="#behavioral">Behavioral 360</a><a href="#themes">Strengths &amp; gaps</a><a href="#recs">Recommendations</a></div>
    <div id="reportRoot">
      <div id="reportBrand">${reportsBrandBarHtml(content.branding||null)}</div>
      <div class="flex jb ac" style="margin-bottom:16px">
        <div class="crumb">${opts.admin?'Reports / '+rEsc(s.name||''):'My Reports / Comprehensive'}</div>
        <div class="flex g8 ac">${backBtn}${regenBtn}
          <button class="btn ghost sm" id="exportPdfBtn" onclick="exportReport()">⤓ Export PDF</button></div></div>

      <section id="summary"><div class="summary-band"><div>
        <div class="ai-label" style="background:rgba(255,255,255,.18);color:#fff">✦ AI-generated</div>
        <h1 style="color:#fff;margin:10px 0 4px">${rEsc(s.name||'')} — ${content.type==='stage'?'Stage report':'Lifecycle report'}</h1>
        <div style="opacity:.85;font-size:13px">${rEsc(s.meta||'')}${s.cohort_name?' · '+rEsc(s.cohort_name):''}</div></div>
        <p style="margin:14px 0 0;opacity:.95;max-width:600px">${rEsc(n.summary||'')}</p>
        ${reportMetricTiles(content.metrics||{})}</div></section>

      <section id="technical" style="margin-top:26px"><h2 style="margin-bottom:4px">Technical progression</h2>
        <p class="muted small" style="margin-bottom:12px">Per-competency scores — baseline vs latest checkpoint (a trend line is shown when fewer than three competencies are tagged).</p>
        <div class="card pad">${techRadarChart(c.technical)}</div>
        <div class="ai-block"><span class="ai-label">✦ AI interpretation</span>
        <p style="margin:8px 0 0">${rEsc(n.technical_interpretation||'')}</p></div></section>

      <section id="behavioral" style="margin-top:26px"><h2 style="margin-bottom:4px">Behavioral 360</h2>
        <p class="muted small" style="margin-bottom:12px">Self-rating vs. aggregated other-raters (anonymized).</p>
        <div class="card pad" style="display:flex;justify-content:center">${radarChart(c.radar)}</div>
        ${c.radar?`<div class="legend" style="justify-content:center"><span><i style="background:var(--indigo)"></i>Self</span>${(c.radar.others)?'<span><i style="background:var(--teal)"></i>Others (aggregated)</span>':''}</div>`:''}
        ${suppNote}
        <div class="ai-block"><span class="ai-label">✦ AI synthesis</span>
        <p style="margin:8px 0 0">${rEsc(n.behavioral_synthesis||'')}</p></div></section>

      <section id="themes" style="margin-top:26px"><h2 style="margin-bottom:12px">Per-competency &amp; development</h2>
        ${perComp}
        <div class="rep-2col" style="margin-top:14px">
          <div class="card pad"><div class="badge ok" style="margin-bottom:8px">Strengths</div>
            <ul style="margin:0;padding-left:18px">${strengths||'<li class="muted">—</li>'}</ul></div>
          <div class="card pad"><div class="badge warn" style="margin-bottom:8px">Development areas</div>
            <ul style="margin:0;padding-left:18px">${devs||'<li class="muted">—</li>'}</ul></div></div></section>

      <section id="recs" style="margin-top:26px"><h2 style="margin-bottom:12px">Recommendations</h2>
        <div class="ai-block" style="border-color:var(--teal);background:#eef6f0"><span class="ai-label" style="background:#dcf0e3;color:#1f5b34">✦ AI-generated</span>
        <p style="margin:8px 0 0">${rEsc(n.recommendations||'')}</p></div>
        <p class="muted small" style="margin-top:16px">All narrative sections are LLM-generated from server-scored results, the question blueprint, and anonymized 360 aggregates${genAt?' · generated '+rEsc(genAt):''}.</p></section>
    </div></div></div>`;
}

/* ============================================================
   #8 REPORT BRANDING HEADER
   Ministry/department logo + label at the top of the report (inside
   #reportRoot, so it is captured by the PDF export). New reports carry
   content.branding; older ones are resolved live from current org/cohort
   branding and patched into #reportBrand after paint.
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
  // Baked branding travels with the report; the CURRENT org/cohort brand
  // (Ministry/Department/Organisation) wins so the header + PDF reflect the
  // latest values set in the assessment wizard.
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
   ============================================================ */
function pReport(){
  if(!reportsLive()) return REPORTS_PROTO.pReport ? REPORTS_PROTO.pReport() : '';

  if(REPORTS.selfState==='ready' && REPORTS.selfContent){
    return renderReportFrom(REPORTS.selfContent, { canRegenerate:true, pid:REPORTS.selfPid });
  }
  if(REPORTS.selfState==='none'){
    return `<div class="page-head"><h1>My Reports</h1></div>
      <div class="card pad" style="max-width:620px;text-align:center">
        <div style="font-size:40px">✦</div>
        <h3 style="margin:8px 0">Your report isn't generated yet</h3>
        <p class="muted" style="margin:0 auto 16px;max-width:440px">We'll analyze your assessment scores against the question blueprint and synthesize your anonymized 360 feedback into a development report.</p>
        <button class="btn" onclick="reportsGenerateSelf()">Generate my report</button></div>`;
  }
  // idle/loading → kick the async load, show a light placeholder
  if(REPORTS.selfState==='idle'){ REPORTS.selfState='loading'; setTimeout(reportsHydrateSelf,0); }
  return `<div class="page-head"><h1>My Reports</h1></div>
    <div class="card pad" style="text-align:center"><div class="muted small">Loading your report…</div></div>`;
}

async function reportsResolveSelfPid(){
  // #13 a person may have a participant row in several cohorts. Pick the row for
  // the switcher's selected cohort; fall back to the most-recent row when none is
  // selected yet. Cache is keyed by cohort so switching re-resolves cleanly.
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
  if(!pick) pick = rows[0];   // most-recent enrollment
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
    if(data && data.content){ REPORTS.selfContent=data.content; REPORTS.selfState='ready'; }
    else { REPORTS.selfState='none'; }
  }catch(e){ console.warn('report hydrate failed',e); REPORTS.selfState='none'; }
  renderParticipant();
}
async function reportsGenerateSelf(){
  const pid = await reportsResolveSelfPid();
  if(!pid){ toast('Could not find your participant record','err'); return; }
  const main=document.querySelector('.main'); if(main) mountOctopus(main,'Analyzing your results and writing your report…');
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
    body:'This re-runs the LLM over the latest scores and 360 aggregates and replaces the current report. This cannot be undone.',
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
   PDF EXPORT  (client-side, OFF the generation path)
   Builds a VECTOR document with pdfmake from the persisted report
   object — sharp text, real page breaks, no DOM rasterization.
   Charts (SVG) are embedded directly; the branding logo (if any) is
   fetched and embedded as a dataURL so the PDF is self-contained.
   ============================================================ */
function _pdfH2(t, margin){ return { text:t, fontSize:13, bold:true, color:'#0f172a', margin: margin || [0,0,0,2] }; }
function _pdfAI(text, stroke, fill){
  return { table:{ widths:['*'], body:[[{ text:text, fontSize:10, lineHeight:1.3, color:'#1e293b', margin:[8,6,8,6], fillColor: fill || '#e6f1f7' }]] },
    layout:{ hLineWidth:()=>0, vLineWidth:(i)=> i===0 ? 3 : 0, vLineColor:()=> stroke || '#016796' }, margin:[0,4,0,0] };
}
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
async function exportReport(){
  if(!reportsLive()) return REPORTS_PROTO.exportReport ? REPORTS_PROTO.exportReport() : null;
  const ctx = REPORTS.exportCtx;
  const content = ctx && ctx.content;
  if(!content){ toast('Nothing to export','err'); return; }
  if(!window.pdfMake){ toast('PDF library not loaded','err'); return; }
  const btn=document.getElementById('exportPdfBtn'); if(btn){ btn.disabled=true; btn.textContent='Preparing…'; }
  try{
    const n=content.narrative||{}, s=content.subject||{}, c=content.charts||{}, m=content.metrics||{};
    const brand = REPORTS.effectiveBrand || content.branding || null;
    const stack=[];

    // branding header (Ministry / Department / Organisation + optional logo)
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

    // title band
    stack.push({ text:'✦ AI-GENERATED', fontSize:8, bold:true, color:'#016796', margin:[0,0,0,3] });
    stack.push({ text:`${s.name||''} — ${content.type==='stage'?'Stage report':'Lifecycle report'}`, fontSize:18, bold:true, color:'#013d57' });
    const metaLine=[s.meta,s.cohort_name].filter(Boolean).join(' · ');
    if(metaLine) stack.push({ text:metaLine, fontSize:10, color:'#64748b', margin:[0,2,0,8] });
    if(n.summary) stack.push({ text:n.summary, fontSize:10.5, lineHeight:1.3, margin:[0,0,0,10] });

    // metric tiles
    const tiles=[
      [m.technical_gain_pct==null?'—':((m.technical_gain_pct>=0?'+':'')+m.technical_gain_pct+'%'),'Technical gain (first→last)'],
      [m.behavioral_score==null?'—':String(m.behavioral_score),'Behavioral score (of 5)'],
      [m.stages_completed_pct==null?'—':(m.stages_completed_pct+'%'),'Stages completed'],
      [String(m.raters||0),'Raters · 360'],
    ];
    stack.push({ columns:tiles.map(t=>({ width:'*', stack:[{ text:t[0], fontSize:16, bold:true, color:'#013d57' },{ text:t[1], fontSize:8, color:'#64748b' }] })), columnGap:10, margin:[0,0,0,14] });

    // technical
    stack.push(_pdfH2('Technical progression'));
    const techSvg=firstSvg(techRadarChart(c.technical));
    if(techSvg) stack.push({ svg:_pdfCleanSvg(techSvg), width:360, alignment:'center', margin:[0,4,0,4] });
    if(n.technical_interpretation) stack.push(_pdfAI(n.technical_interpretation));

    // behavioral 360
    stack.push(_pdfH2('Behavioral 360',[0,16,0,0]));
    const radSvg=c.radar?firstSvg(radarChart(c.radar)):null;
    if(radSvg) stack.push({ svg:_pdfCleanSvg(radSvg), width:300, alignment:'center', margin:[0,4,0,4] });
    else stack.push({ text:'No 360 data available yet.', italics:true, color:'#64748b', fontSize:9, margin:[0,4,0,4] });
    if(n.behavioral_synthesis) stack.push(_pdfAI(n.behavioral_synthesis));

    // per-competency + strengths/development
    stack.push(_pdfH2('Per-competency & development',[0,16,0,0]));
    (n.per_competency||[]).forEach(pc=>{
      stack.push({ text:pc.competency||'', bold:true, fontSize:10, color:'#01536f', margin:[0,6,0,1] });
      stack.push({ text:pc.commentary||'', fontSize:10, lineHeight:1.3, margin:[0,0,0,2] });
    });
    const strengths=(n.strengths||[]), devs=(n.development_areas||[]);
    stack.push({ columns:[
      { width:'*', stack:[{ text:'Strengths', bold:true, fontSize:9, color:'#2a7040', margin:[0,8,0,3] }, strengths.length?{ ul:strengths, fontSize:10 }:{ text:'—', color:'#94a3b8' }] },
      { width:'*', stack:[{ text:'Development areas', bold:true, fontSize:9, color:'#8a6406', margin:[0,8,0,3] }, devs.length?{ ul:devs, fontSize:10 }:{ text:'—', color:'#94a3b8' }] },
    ], columnGap:16 });

    // recommendations
    stack.push(_pdfH2('Recommendations',[0,16,0,0]));
    if(n.recommendations) stack.push(_pdfAI(n.recommendations,'#3c9052','#eef6f0'));
    const genAt=content.generated_at?new Date(content.generated_at).toLocaleString():'';
    stack.push({ text:`All narrative sections are LLM-generated from server-scored results, the question blueprint, and anonymized 360 aggregates${genAt?' · generated '+genAt:''}.`, fontSize:8, color:'#94a3b8', margin:[0,12,0,0] });

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
  // list shell; async fill
  setTimeout(reportsHydrateAdminList,0);
  return `<div class="crumb">Reports</div><div class="page-head"><h1>Reports</h1>
    <button class="btn" onclick="reportsCohortFanout()">＋ Generate cohort report</button></div>
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
      sb.from('reports').select('participant_id,generated_at,type').eq('cohort_id',coh).eq('scope','participant').is('deleted_at',null)
    ]);
    const repBy={}; (reps||[]).forEach(r=>{ repBy[r.participant_id]=r; });
    if(!parts || !parts.length){ host.innerHTML='<div class="muted small">No participants in this cohort yet.</div>'; return; }
    host.innerHTML=parts.map(p=>{
      const has=repBy[p.id];
      const right = has
        ? `<div class="flex g8 ac"><span class="badge ok">✓ ready</span>
            <button class="btn ghost sm" onclick="reportsAdminOpen('${p.id}','${rEsc(p.name).replace(/'/g,"\\'")}')">Open →</button></div>`
        : `<button class="btn ghost sm" onclick="reportsAdminGenerate('${p.id}',this)">Generate</button>`;
      return `<div class="flex ac jb" style="padding:11px 0;border-bottom:1px solid var(--g100)">
        <div class="flex ac g12"><div class="avatar" style="background:var(--teal)">${initials(p.n||p.name)}</div>
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
    const { data, error } = await sb.functions.invoke('generate-report',{ body:{ participant_id:pid, type:'comprehensive' } });
    if(error || (data&&data.error)){ throw new Error((data&&data.error)||error.message); }
    toast('Report generated','ok'); reportsHydrateAdminList();
  }catch(e){ toast(String(e.message||e),'err'); if(btn){ btn.disabled=false; btn.textContent='Generate'; } }
}

/* ---- cohort fan-out: one request per participant, bounded parallelism ---- */
async function reportsCohortFanout(){
  const coh=reportsCohortId();
  if(!coh){ toast('Select a cohort first','err'); return; }
  const { data:parts } = await sb.from('participants').select('id,name').eq('cohort_id',coh).is('deleted_at',null).order('name');
  if(!parts || !parts.length){ toast('No participants in this cohort','err'); return; }
  REPORTS.fanout = { items: parts.map(p=>({ id:p.id, name:p.name, status:'queued', err:null })), done:0, total:parts.length, running:true };
  renderFanoutModal();

  const CONCURRENCY=3;
  let cursor=0;
  async function worker(){
    while(cursor < REPORTS.fanout.items.length){
      const it=REPORTS.fanout.items[cursor++];
      it.status='generating'; updateFanoutRow(it);
      try{
        const { data, error } = await sb.functions.invoke('generate-report',{ body:{ participant_id:it.id, type:'comprehensive' } });
        if(error || (data&&data.error)) throw new Error((data&&data.error)||error.message);
        it.status='done';
      }catch(e){ it.status='error'; it.err=String(e.message||e); }
      REPORTS.fanout.done++; updateFanoutRow(it); updateFanoutHead();
    }
  }
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,parts.length)}, worker));
  REPORTS.fanout.running=false; updateFanoutHead();
  const failed=REPORTS.fanout.items.filter(i=>i.status==='error').length;
  toast(failed? `Cohort done · ${failed} failed`:'Cohort report complete', failed?'err':'ok');
}
function fanoutPill(s){ return s==='done'?'<span class="badge ok">✓ done</span>'
  : s==='generating'?'<span class="badge info">generating…</span>'
  : s==='error'?'<span class="badge err">failed</span>'
  : '<span class="tag">queued</span>'; }
function renderFanoutModal(){
  const f=REPORTS.fanout;
  const rows=f.items.map(it=>`<div class="flex ac jb" id="fo_${it.id}" style="padding:8px 0;border-bottom:1px solid var(--g100)">
    <span>${rEsc(it.name)}</span>${fanoutPill(it.status)}</div>`).join('');
  document.getElementById('modalRoot').innerHTML=`<div class="modal-bg">
    <div class="modal" style="max-width:520px"><div class="mh"><h2>Generating cohort reports</h2></div>
    <div class="mb"><div id="foHead" class="muted small" style="margin-bottom:6px"></div>
      <div class="bar" style="margin-bottom:10px"><i id="foBar" style="width:0%"></i></div>
      <div style="max-height:300px;overflow:auto">${rows}</div></div>
    <div class="mf"><button class="btn ghost" id="foClose" onclick="closeModal()">Run in background</button></div></div></div>`;
  updateFanoutHead();
}
function updateFanoutRow(it){ const el=document.getElementById('fo_'+it.id); if(el){ const pill=el.querySelector('.badge,.tag'); if(pill) pill.outerHTML=fanoutPill(it.status); } }
function updateFanoutHead(){
  const f=REPORTS.fanout; const head=document.getElementById('foHead'), bar=document.getElementById('foBar'), close=document.getElementById('foClose');
  if(head) head.textContent=`${f.done} of ${f.total} complete${f.running?' · generating…':''}`;
  if(bar) bar.style.width=Math.round(100*f.done/f.total)+'%';
  if(close && !f.running) close.textContent='Close';
}
