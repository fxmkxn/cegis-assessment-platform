// admin.js — all admin views: dashboard, assessments wizard, WPCA configurator, reports, roster, settings (verbatim from prototype)

/* ---------------- ADMIN ---------------- */
const ADMIN_NAV = [
  {grp:'Overview'},{k:'dashboard',ic:'▦',label:'Dashboard'},
  {grp:'Manage'},
  {k:'roster',ic:'☷',label:'Cohorts'},
  {k:'assessments',ic:'⤴',label:'Assessments',badge:'3'},
  {k:'wpca',ic:'◎',label:'WPCA · 360'},
  {k:'reports',ic:'✦',label:'Reports'},
  {grp:'Program'},{k:'settings',ic:'⚙',label:'Settings'},
];
function renderAdmin(){
  let rail='<div class="rail">';
  ADMIN_NAV.forEach(item=>{
    if(item.grp){rail+=`<div class="grp">${item.grp}</div>`;return;}
    rail+=`<button class="nav-item ${state.view===item.k?'active':''}" onclick="go('${item.k}')">
      ${item.label}${item.badge?`<span class="nav-badge">${item.badge}</span>`:''}</button>`;
  });
  rail+='</div>';
  const views={dashboard:vDashboard,assessments:vAssessments,wpca:vWPCA,reports:vReports,roster:vRoster,settings:vSettings};
  layout.innerHTML = rail + `<div class="main">${(views[state.view]||vDashboard)()}</div>`;
  if(state.view==='wpca') drawWorkload();
}
function go(k){state.view=k;render();const m=document.querySelector('.main');if(m)m.scrollTo(0,0);}

/* === Screen 1: Admin Dashboard === */
function vDashboard(){
  const N = ROSTER.length;
  const labels={live:'Live',sched:'Scheduled',closed:'Closed',idle:'Not started'};
  const subFor = i => [`${N}/${N} completed`,`${Math.round(N*0.74)}/${N} · 3 tests`,'Opens 12 Jul','Week 2 / Week 4','Per-stage + final'][i];
  let pipe='<div class="pipeline">';
  STAGES.forEach((s,i)=>{
    pipe+=`<div class="stage"><div class="stage-card" onclick="${i===3?"go('wpca')":i===4?"go('reports')":"go('assessments')"}">
      <div class="flex jb ac"><div class="stage-num">${s.n}</div><span class="pill ${s.status}">${labels[s.status]}</span></div>
      <h3>${s.name}</h3><div class="muted small">${subFor(i)}</div>
      <div class="bar"><i style="width:${s.pct}%"></i></div>
      <div class="flex jb ac small"><span class="muted">${s.pct}% complete</span><span style="color:var(--indigo-d);font-weight:600">${s.action} →</span></div>
    </div></div>`;
  });
  pipe+='</div>';
  return `<div class="crumb">Cohort 2026·A · Personnel Management</div>
  <div class="page-head"><h1>Program Dashboard</h1><button class="btn" onclick="go('reports')">＋ Generate cohort report</button></div>
  <div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:20px">
    ${tile(N,'Participants')}${tile('EoCA','Active stage')}${tile('64%','Overall completion')}${tile(Math.min(9,N),'Reports generated')}</div>
  <h3 style="margin:6px 0 12px">Five-stage lifecycle</h3>${pipe}
  <div class="grid" style="grid-template-columns:1.3fr 1fr;margin-top:22px">
    <div class="card pad"><div class="flex jb ac" style="margin-bottom:12px"><h3>Action queue</h3><span class="muted small">3 items</span></div>
      ${aq('err','3 Baseline CSV rows have errors','Open validation',"go('assessments')")}
      ${aq('warn','WPCA Week-2 panel incomplete for some subjects','Review raters',"go('wpca')")}
      ${aq('info','EoCA 2 closes in 2 days — '+Math.round(N*0.26)+' not started','Send reminder',"toast('Reminder sent','ok')")}</div>
    <div class="card pad"><h3 style="margin-bottom:12px">Recent activity</h3>
      ${act(ROSTER[0].n+' submitted EoCA 2','12m ago')}
      ${act('Comprehensive report ready · '+(ROSTER[1]||ROSTER[0]).n,'1h ago')}
      ${act('Baseline closed for cohort','Yesterday')}
      ${act((ROSTER[2]||ROSTER[0]).n+' submitted EoCA 2','Yesterday')}</div>
  </div>`;
}
const tile=(v,l)=>`<div class="card pad"><div style="font-size:26px;font-weight:700" class="tnum">${v}</div><div class="muted small">${l}</div></div>`;
const aq=(t,txt,btn,fn)=>`<div class="flex ac jb" style="padding:11px 0;border-bottom:1px solid var(--g100)">
  <div class="flex ac g12"><span class="badge ${t}">${t==='err'?'!':t==='warn'?'⚠':'i'}</span><span>${txt}</span></div>
  <button class="btn ghost sm" onclick="${fn}">${btn}</button></div>`;
const act=(txt,t)=>`<div class="flex ac g12" style="padding:9px 0;border-bottom:1px solid var(--g100)">
  <div style="width:8px;height:8px;border-radius:50%;background:var(--indigo)"></div>
  <div style="flex:1"><div>${txt}</div><div class="muted small">${t}</div></div></div>`;

/* === Flow A: upload → validate → preview → deploy === */
function vAssessments(){
  const steps=['Upload CSV','Validate & fix','Preview','Deploy'];
  let stepper='<div class="stepper">';
  steps.forEach((s,i)=>{stepper+=`<div class="step ${state.uploadStep===i?'active':state.uploadStep>i?'done':''}">
    <span class="n">${state.uploadStep>i?'✓':i+1}</span>${s}</div>${i<3?'<span class="arrow">→</span>':''}`;});
  stepper+='</div>';
  let body;
  if(state.uploadStep===0){
    body=`<div class="card pad"><div class="flex jb ac wrap" style="margin-bottom:14px"><h3>Upload Baseline / EoCA instrument</h3>
      <span class="tag">Expected: QuestionNo · QuestionType · QuestionText · Options · Correct flags</span></div>
      <div class="dz" id="dz" onclick="parseCSV()"><div style="font-size:34px">⤓</div>
      <div style="font-weight:600;margin-top:6px">Drop your CSV here or click to use the sample file</div>
      <div class="muted small">assessment_baseline.csv · 8 questions · 2 KB</div></div>
      <div class="muted small" style="margin-top:10px">↓ Download CSV template · Need help formatting Likert scales?</div></div>`;
  } else if(state.uploadStep===1){ body=validationView(); }
  else if(state.uploadStep===2){ body=previewView(); }
  else { body=deployView(); }
  return `<div class="crumb">Assessments / Create</div><div class="page-head"><h1>New Assessment — Baseline</h1></div>${stepper}${body}`;
}
function parseCSV(){
  // show the octopus loader while the workbook is "parsed", then advance
  mountOctopus(document.querySelector('.main'),'Parsing your question bank…');
  setTimeout(()=>{state.parsed=true;state.uploadStep=1;toast('Parsed 8 questions — 1 needs attention','ok');renderAdmin();},900);
}
function validationView(){
  const rows=QUESTIONS.map(q=>{const warn=q.no===5;return `<tr><td class="tnum">${q.no}</td>
    <td><span class="tag">${q.type}</span></td><td style="max-width:340px">${q.text}</td>
    <td>${q.opts?q.opts.length:'—'}</td>
    <td>${warn?'<span class="badge warn">⚠ Verify scale</span>':'<span class="badge ok">✓ Valid</span>'}</td></tr>`;}).join('');
  return `<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12"><span class="badge warn" style="font-size:13px;padding:6px 12px">⚠</span>
    <div><b>7 of 8 questions parsed cleanly.</b> <span class="muted">1 question needs your attention before deploying.</span></div>
    <div class="spacer"></div><button class="btn ghost sm">Show issues only</button></div></div>
  <div class="card"><table><thead><tr><th>#</th><th>Type</th><th>Question text</th><th>Options</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
  <div class="flex g12" style="margin-top:16px;justify-content:flex-end">
    <button class="btn ghost" onclick="state.uploadStep=0;renderAdmin()">← Re-upload</button>
    <button class="btn" onclick="state.uploadStep=2;renderAdmin()">Continue to preview →</button></div>`;
}
function previewView(){
  const cards=QUESTIONS.slice(0,3).map(q=>`<div class="card pad" style="margin-bottom:14px">
    <div class="flex jb"><span class="tag">${q.type}</span><span class="muted small">Q${q.no}</span></div>
    <p style="font-weight:600;margin:10px 0 12px">${q.text}</p>${renderQuestionControls(q,null,true)}</div>`).join('');
  return `<div class="card pad" style="margin-bottom:14px"><div class="flex ac g12"><span class="badge info">i</span>
    <div>This is exactly how participants will see each question. Optionally tag questions to competencies for richer LLM reports.</div></div></div>
    ${cards}<div class="muted small" style="text-align:center;margin:6px 0">…5 more questions</div>
    <div class="flex g12" style="margin-top:16px;justify-content:flex-end">
    <button class="btn ghost" onclick="state.uploadStep=1;renderAdmin()">← Back</button>
    <button class="btn" onclick="state.uploadStep=3;renderAdmin()">Continue to deploy →</button></div>`;
}
function deployView(){
  const N=ROSTER.length;
  return `<div class="card pad" style="max-width:560px"><h3 style="margin-bottom:14px">Deploy to cohort</h3>
    <div class="kv"><span class="muted">Instrument</span><b>Baseline — Data Capacity</b></div>
    <div class="kv"><span class="muted">Questions</span><b>8</b></div>
    <div class="kv"><span class="muted">Target cohort</span><b>Cohort 2026·A (${N} participants)</b></div>
    <div class="kv"><span class="muted">Availability</span><b>10 Jun → 24 Jun · no time limit</b></div>
    <div class="kv"><span class="muted">Reminders</span><b>Day 3, Day 6, Day 10</b></div>
    <div class="flex g12" style="margin-top:18px"><button class="btn ghost" onclick="state.uploadStep=2;renderAdmin()">← Back</button>
      <button class="btn" onclick="confirmDeploy()">Deploy to cohort</button></div>
    <p class="muted small" style="margin-top:12px">⚠ Deployment is participant-visible and cannot be undone once questions are released.</p></div>`;
}
function confirmDeploy(){
  const N=ROSTER.length;
  showModal({title:'Deploy this assessment?',
    body:`This will make <b>Baseline (8 questions)</b> live for <b>${N} participants</b> in Cohort 2026·A, opening 10 Jun. This action cannot be undone.`,
    confirm:'Deploy now',onConfirm:()=>{closeModal();toast('Baseline deployed to '+N+' participants','ok');state.uploadStep=0;go('dashboard');}});
}

/* === Screen 2 / Flow B: WPCA Smart Configurator === */
function vWPCA(){
  const rows=SUBJECTS.map(s=>{
    const p=PANELS[s.id];
    const peerChips=p.peers.map((pid,idx)=>raterChip(pid,s,'peer',s.id,idx)).join('') || '<span class="muted small">—</span>';
    const reChip=p.reportee?raterChip(p.reportee,s,'reportee',s.id):'<span class="muted small">— none</span>';
    const mgrChip=p.mgr?raterChip(p.mgr,s,'mgr',s.id)
      :(HAS_HIERARCHY?'<span class="badge warn">⚠ no manager</span>':'<span class="tag">n/a</span>');
    const incomplete=(p.peers.length<3)||(HAS_HIERARCHY&&!p.mgr);
    return `<tr><td><b>${s.n}</b><div class="muted small">${meta(s)}</div>
      ${incomplete?'<span class="badge warn" style="margin-top:4px">⚠ incomplete panel</span>':''}</td>
      <td><span class="chip"><span class="av">Self</span></span></td>
      <td>${mgrChip}</td><td>${reChip}</td><td>${peerChips}</td></tr>`;
  }).join('');
  return `<div class="crumb">Lifecycle / WPCA · 360</div>
  <div class="page-head"><h1>WPCA Smart Configurator</h1>
    <div class="flex g12 ac">
      <select class="btn ghost sm" style="appearance:auto"><option>Round: Week 2</option><option>Round: Week 4</option></select>
      <button class="btn ghost" onclick="reassign()">↻ Re-run assignment</button>
      <button class="btn" id="approveBtn" onclick="approveWPCA()">Approve & roll out</button></div></div>
  <div class="grid" style="grid-template-columns:300px 1fr">
    <div>
      <div class="card pad" style="margin-bottom:14px"><h3 style="margin-bottom:4px">Workload health</h3>
        <div class="muted small" style="margin-bottom:14px">Reviews assigned per rater · target band 2–4</div>
        <div id="workload"></div><hr style="margin:14px 0"><div id="wlstats" class="small"></div></div>
      <div class="card pad"><h3 style="margin-bottom:8px;font-size:13px">Constraint priorities</h3>
        ${slider('Location diversity',75)}${slider('Equitable load',85)}${slider('Workstream relevance',55)}</div>
    </div>
    <div class="card">
      <div class="pad" style="border-bottom:1px solid var(--g200)"><div class="flex jb ac wrap">
        <h3>Peer matrix · ${SUBJECTS.length} subjects</h3>
        <span class="muted small">Click any peer chip to swap · 📍 same location · ⇄ cross-workstream</span></div></div>
      <div style="overflow:auto"><table><thead><tr><th>Subject</th><th>Self</th><th>Manager</th><th>Reportee</th><th>Peers (×3)</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    </div></div>`;
}
function slider(l,v){return `<div style="margin-bottom:12px"><div class="flex jb small"><span class="muted">${l}</span><b>${v}%</b></div>
  <div class="bar" style="margin:5px 0 0"><i style="width:${v}%"></i></div></div>`;}
function raterChip(pid,sub,role,subId,peerIdx){
  const r=ROSTER.find(x=>x.id===pid); if(!r) return '';
  const over=workloadCount(pid)>4, sameLoc=r.loc&&r.loc===sub.loc, crossWs=r.ws&&r.ws!==sub.ws;
  const flags=(sameLoc?'📍':'')+(crossWs?'⇄':'');
  const clickable=role==='peer';
  return `<span class="chip ${over?'over':''}" ${clickable?`onclick="openSwap('${subId}',${peerIdx})"`:''} title="${meta(r)} · load ${workloadCount(pid)}">
    <span class="av">${initials(r.n)}</span>${r.n.split(/\s+/)[0]} <span class="fl">${flags}</span></span>`;
}
function workloadCount(pid){let c=0;SUBJECTS.forEach(s=>{const p=PANELS[s.id];if(p.mgr===pid)c++;if(p.reportee===pid)c++;if(p.peers.includes(pid))c++;});return c;}
function reassign(){
  mountOctopus(document.querySelector('.main'),'Running the load-balancing assignment…');
  setTimeout(()=>{PANELS=buildPanels();toast('Re-ran smart assignment','ok');renderAdmin();},900);
}
function openSwap(subId,peerIdx){
  const sub=ROSTER.find(r=>r.id===subId), current=PANELS[subId].peers[peerIdx];
  const used=new Set([subId,PANELS[subId].mgr,PANELS[subId].reportee,...PANELS[subId].peers].filter(Boolean));
  const cands=eligiblePeers(sub).filter(r=>!used.has(r.id)||r.id===current).sort((a,b)=>workloadCount(a.id)-workloadCount(b.id));
  const opts=cands.slice(0,8).map(r=>{const load=workloadCount(r.id);
    return `<div class="flex ac jb" style="padding:9px 10px;border:1px solid var(--g200);border-radius:9px;margin-bottom:7px;cursor:pointer${r.id===current?';background:var(--indigo-l)':''}" onclick="doSwap('${subId}',${peerIdx},'${r.id}')">
      <div class="flex ac g8"><span class="av" style="width:28px;height:28px;border-radius:50%;background:var(--teal);color:#fff;display:grid;place-items:center;font-size:10px;font-weight:700">${initials(r.n)}</span>
      <div><b>${r.n}</b><div class="muted small">${meta(r)}</div></div></div>
      <span class="badge ${load>4?'err':load<2?'info':'ok'}">load ${load}</span></div>`;}).join('') || '<div class="muted small">No other eligible raters available.</div>';
  showModal({title:`Swap a peer for ${sub.n.split(/\s+/)[0]}`,
    body:`<div class="muted small" style="margin-bottom:10px">Candidates ranked by current review load. Swapping recomputes the workload graph live.</div>${opts}`,
    confirm:null,onConfirm:null});
}
function doSwap(subId,peerIdx,newId){PANELS[subId].peers[peerIdx]=newId;closeModal();renderAdmin();toast('Rater swapped — workload updated','ok');}
function approveWPCA(){
  let total=0;SUBJECTS.forEach(s=>{const p=PANELS[s.id];total+=1+(p.mgr?1:0)+(p.reportee?1:0)+p.peers.length;});
  showModal({title:'Approve & roll out Week 2 360?',
    body:`This sends <b>${total} review invitations</b> across <b>${SUBJECTS.length} subjects</b> to their assigned raters. Target completion: 14 days. This cannot be undone.`,
    confirm:'Approve & roll out',onConfirm:()=>{closeModal();toast('WPCA Week-2 rolled out · '+total+' invitations sent','ok');go('dashboard');}});
}
function drawWorkload(){
  const el=document.getElementById('workload'); if(!el)return;
  const raters=[...new Set(SUBJECTS.flatMap(s=>{const p=PANELS[s.id];return [p.mgr,p.reportee,...p.peers].filter(Boolean);}))];
  const data=raters.map(id=>({id,n:nameOf(id),c:workloadCount(id)})).sort((a,b)=>b.c-a.c);
  const max=Math.max(5,...data.map(d=>d.c));
  el.innerHTML=data.map(d=>{const cls=d.c>4?'over':d.c<2?'under':'';
    return `<div class="wl-row"><span class="wl-name" title="${d.n}">${d.n}</span>
      <div class="wl-track"><div class="wl-band" style="left:${2/max*100}%;width:${2/max*100}%"></div>
      <div class="wl-fill ${cls}" style="width:${d.c/max*100}%"></div></div><span class="wl-val">${d.c}</span></div>`;}).join('') || '<div class="muted small">No raters assigned.</div>';
  const counts=data.map(d=>d.c), mean=counts.length?(counts.reduce((a,b)=>a+b,0)/counts.length).toFixed(1):'0';
  const over=counts.filter(c=>c>4).length;
  const incomplete=SUBJECTS.filter(s=>PANELS[s.id].peers.length<3||(HAS_HIERARCHY&&!PANELS[s.id].mgr)).length;
  document.getElementById('wlstats').innerHTML=
    `<div class="kv"><span class="muted">Mean reviews / rater</span><b>${mean}</b></div>
     <div class="kv"><span class="muted">Raters over cap (&gt;4)</span><b style="color:${over?'var(--err)':'var(--ok)'}">${over}</b></div>
     <div class="kv"><span class="muted">Incomplete panels</span><b style="color:${incomplete?'var(--warn)':'var(--ok)'}">${incomplete}</b></div>`;
  const ab=document.getElementById('approveBtn'); if(ab){ab.disabled=incomplete>0; ab.title=incomplete>0?'Resolve incomplete panels first':'';}
}

/* === Reports (admin list) === */
function vReports(){
  const r=i=>ROSTER[i]||ROSTER[0];
  return `<div class="crumb">Reports</div><div class="page-head"><h1>Reports</h1>
    <button class="btn" onclick="toast('Cohort report queued — LLM job started','ok')">＋ Generate cohort report</button></div>
  <div class="grid" style="grid-template-columns:1fr 1fr">
    <div class="card pad"><h3 style="margin-bottom:12px">Individual reports</h3>
      ${repRow(r(0).n,'Comprehensive lifecycle')}${repRow(r(1).n,'Comprehensive lifecycle')}
      ${repRow(r(2).n,'EoCA 2 stage report')}${repRow(r(3).n,'EoCA 2 stage report')}</div>
    <div class="card pad"><h3 style="margin-bottom:12px">LLM generation queue</h3>
      ${qRow('Cohort 2026·A — EoCA 2 summary','Generating · analyzing submissions',70)}
      ${qRow('Individual · '+r(0).n,'Complete',100)}${qRow('Cohort comprehensive','Queued',0)}
      <div class="ai-block" style="margin-top:14px"><span class="ai-label">✦ AI</span>
      <p style="margin:8px 0 0">Reports analyze scores against the question blueprint and synthesize 360 feedback into themes. Switch to the Participant view to open a finished report.</p></div></div>
  </div>`;
}
const repRow=(n,t)=>`<div class="flex ac jb" style="padding:11px 0;border-bottom:1px solid var(--g100)">
  <div class="flex ac g12"><div class="avatar" style="background:var(--teal)">${initials(n)}</div>
  <div><b>${n}</b><div class="muted small">${t}</div></div></div>
  <button class="btn ghost sm" onclick="state.role='participant';state.ptab='reports';render()">Open →</button></div>`;
const qRow=(t,s,p)=>`<div style="padding:10px 0;border-bottom:1px solid var(--g100)">
  <div class="flex jb"><b style="font-size:13px">${t}</b><span class="muted small">${s}</span></div>
  <div class="bar" style="margin:7px 0 0"><i style="width:${p}%"></i></div></div>`;

/* === Roster (reads straight from the loaded file) === */
function vRoster(){
  const rows=ROSTER.map(r=>`<tr><td><b>${r.n}</b></td><td class="muted small">${r.id}</td>
    <td>${r.des||'—'}</td><td>${r.ws?`<span class="tag">${r.ws}</span>`:'—'}</td><td>${r.loc||'—'}</td><td>${r.mgr?nameOf(r.mgr):'—'}</td></tr>`).join('');
  return `<div class="crumb">Manage / Cohorts</div><div class="page-head"><h1>Cohorts &amp; Roster</h1>
    <span class="badge ${DATA_SOURCE==='file'?'ok':'warn'}">${DATA_SOURCE==='file'?'✓ '+ROSTER.length+' loaded from file':'sample data'}</span></div>
    <div class="card"><div style="overflow:auto"><table><thead><tr><th>Name</th><th>ID</th><th>Designation</th><th>Workstream</th><th>Location</th><th>Reporting manager</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>`;
}
function vSettings(){return `<div class="page-head"><h1>Settings</h1></div><div class="grid" style="grid-template-columns:1fr 1fr">
  ${['Users & admin roles','Competency framework / blueprints','Integrations · LLM API key','Audit log']
    .map(s=>`<div class="card pad"><h3>${s}</h3><p class="muted small" style="margin:6px 0 0">Configure ${s.toLowerCase()}.</p></div>`).join('')}</div>`;}
