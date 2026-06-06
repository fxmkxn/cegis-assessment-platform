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

  return `<div class="report-wrap"><div class="grid" style="grid-template-columns:180px 1fr;align-items:start">
    <div class="section-nav" id="secNav">
      <a href="#summary" class="on">Summary</a><a href="#technical">Technical progression</a>
      <a href="#behavioral">Behavioral 360</a><a href="#themes">Strengths &amp; gaps</a><a href="#recs">Recommendations</a></div>
    <div id="reportRoot">
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
        <p class="muted small" style="margin-bottom:12px">Overall and per-competency scores across completed checkpoints.</p>
        <div class="card pad">${lineChart(c.technical)}</div>
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
        <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:14px">
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
  if(REPORTS.selfPid) return REPORTS.selfPid;
  let uid = (window.AUTH && window.AUTH.uid) || null;
  if(!uid){ try{ const g=await sb.auth.getUser(); uid=g.data&&g.data.user?g.data.user.id:null; }catch(e){} }
  if(!uid) return null;
  const { data } = await sb.from('participants')
    .select('id,name,designation,workstream,location,cohort_id')
    .eq('user_id', uid).is('deleted_at', null).maybeSingle();
  if(data){ REPORTS.selfPid=data.id; REPORTS.selfSubject=data; }
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
   Rasterizes the already-rendered #reportRoot — no LLM, no octopus
   (octopus would unmount the node html2canvas needs).
   ============================================================ */
async function exportReport(){
  if(!reportsLive()) return REPORTS_PROTO.exportReport ? REPORTS_PROTO.exportReport() : null;
  const node=document.getElementById('reportRoot');
  if(!node){ toast('Nothing to export','err'); return; }
  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if(!window.html2canvas || !jsPDFCtor){ toast('PDF libraries not loaded','err'); return; }
  const btn=document.getElementById('exportPdfBtn'); if(btn){ btn.disabled=true; btn.textContent='Preparing…'; }
  try{
    const canvas=await window.html2canvas(node,{scale:2,backgroundColor:'#ffffff',useCORS:true,logging:false});
    const img=canvas.toDataURL('image/png');
    const pdf=new jsPDFCtor({orientation:'portrait',unit:'mm',format:'a4'});
    const pageW=pdf.internal.pageSize.getWidth(), pageH=pdf.internal.pageSize.getHeight();
    const imgW=pageW, imgH=canvas.height*imgW/canvas.width;
    let left=imgH, pos=0;
    pdf.addImage(img,'PNG',0,pos,imgW,imgH);
    left-=pageH;
    while(left>0){ pos-=pageH; pdf.addPage(); pdf.addImage(img,'PNG',0,pos,imgW,imgH); left-=pageH; }
    const who=(REPORTS.adminView && REPORTS.adminView.name) || (REPORTS.selfContent&&REPORTS.selfContent.subject&&REPORTS.selfContent.subject.name) || 'report';
    pdf.save(who.replace(/[^a-z0-9]+/gi,'_')+'_report.pdf');
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
