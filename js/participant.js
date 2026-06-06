// participant.js — all participant views: tasks, 360, assessment player, report, charts (verbatim from prototype)

/* ---------------- PARTICIPANT ---------------- */
function renderParticipant(){
  const tabs=[['tasks','My Tasks'],['t360','My 360 Tasks'],['reports','My Reports'],['profile','Profile']];
  let tb='<div class="ptabs">'; tabs.forEach(([k,l])=>tb+=`<button class="${state.ptab===k?'active':''}" onclick="pgo('${k}')">${l}</button>`); tb+='</div>';
  const views={tasks:pTasks,player:pPlayer,t360:p360,reports:pReport,profile:pProfile};
  const showTabs=state.ptab!=='player';
  layout.innerHTML=`<div style="flex:1;display:flex;flex-direction:column;min-height:0">${showTabs?tb:''}<div class="main">${(views[state.ptab]||pTasks)()}</div></div>`;
  if(state.ptab==='reports') initReportScroll();
}
function pgo(k){state.ptab=k;if(k!=='player')state.inReview=false;renderParticipant();const m=document.querySelector('.main');if(m)m.scrollTo(0,0);}

function pTasks(){
  const first=ME().n.split(/\s+/)[0];
  return `<div class="page-head"><h1>Welcome back, ${first}</h1></div>
  <h3 style="margin-bottom:12px">Do now</h3>
  <div class="task ${state.submitted?'done':''}"><div class="ic2">${state.submitted?'✓':'✎'}</div>
    <div style="flex:1"><b>End-of-Course Assessment 2</b><div class="muted small">8 questions · no time limit · ${state.submitted?'submitted':'auto-saves as you go'}</div></div>
    ${state.submitted?'<span class="pill closed">Completed</span>'
      :'<div style="text-align:right"><div class="due">Due in 2 days</div><button class="btn" onclick="startPlayer()">Begin →</button></div>'}</div>
  <div class="task"><div class="ic2" style="background:var(--teal);color:#fff">◎</div>
    <div style="flex:1"><b>360 reviews to complete</b><div class="muted small">WPCA Week 2 · ~5 min each</div></div>
    <button class="btn ghost" onclick="pgo('t360')">Open →</button></div>
  <hr><h3 style="margin-bottom:12px">Completed</h3>
  <div class="task done"><div class="ic2">✓</div><div style="flex:1"><b>Baseline assessment</b><div class="muted small">Submitted 14 May · score released</div></div>
    <button class="btn ghost sm" onclick="pgo('reports')">View report</button></div>`;
}
function p360(){
  const me=ME();
  const others=ROSTER.filter(r=>r.id!==me.id).slice(0,3);
  const rowFor=r=>{
    let role='As Peer', fl=[];
    if(me.mgr===r.id) role='As Reportee';
    else if(r.mgr===me.id) role='As Manager';
    if(r.loc&&r.loc===me.loc) fl.push('📍 same location');
    if(r.ws&&r.ws!==me.ws) fl.push('⇄ cross-workstream');
    return `<div class="flex ac jb" style="padding:12px 0;border-bottom:1px solid var(--g100)">
      <div class="flex ac g12"><div class="avatar" style="background:var(--teal)">${initials(r.n)}</div>
      <div><b>${r.n}</b> <span class="tag">${role}</span><div class="muted small">${fl.join(' · ')||meta(r)}</div></div></div>
      <button class="btn ghost sm" onclick="toast('Opening 360 questionnaire…','ok')">Start review →</button></div>`;
  };
  return `<div class="page-head"><h1>My 360 Tasks</h1></div>
    <div class="card pad"><h3 style="margin-bottom:10px">Reviews I owe — WPCA Week 2</h3>${others.map(rowFor).join('')||'<p class="muted">No reviews assigned to you yet.</p>'}</div>`;
}
function pProfile(){
  const me=ME();
  const fields=[['Name',me.n],['ID',me.id],['Designation',me.des||'—'],['Workstream',me.ws||'—'],['Location',me.loc||'—'],['Reporting manager',me.mgr?nameOf(me.mgr):'—']];
  return `<div class="page-head"><h1>Profile</h1></div><div class="card pad" style="max-width:480px">
    ${fields.map(([k,v])=>`<div class="kv"><span class="muted">${k}</span><b>${v}</b></div>`).join('')}
    <p class="muted small" style="margin-top:12px">Profile details are managed by your program admin.</p></div>`;
}

/* === Screen 3 / Flow C: Assessment Player === */
function startPlayer(){
  // octopus loader on the readiness → player transition (per the brief)
  state.ptab='player';
  layout.innerHTML=`<div style="flex:1;display:flex;flex-direction:column;min-height:0"><div class="main"></div></div>`;
  mountOctopus(document.querySelector('.main'),'Loading your assessment…');
  setTimeout(()=>{state.pidx=0;state.inReview=false;state.submitted=false;renderParticipant();},850);
}
function pPlayer(){
  if(state.submitted) return playerDone();
  if(state.inReview) return playerReview();
  const q=QUESTIONS[state.pidx], total=QUESTIONS.length, flagged=state.flags[q.no];
  const ind={saved:['','Saved just now'],saving:['saving','Saving…'],err:['err','Couldn’t save — retrying']}[state.saveState];
  return `<div class="player-wrap">
    <div class="flex jb ac" style="margin-bottom:14px"><button class="btn ghost sm" onclick="exitPlayer()">✕ Save & exit</button>
      <span class="pill sched">${state.playerStage}</span></div>
    <div class="player-top"><span class="small tnum" style="font-weight:600;white-space:nowrap">Question ${state.pidx+1} of ${total}</span>
      <div class="qbar"><i style="width:${(state.pidx+1)/total*100}%"></i></div>
      <div class="save-ind ${ind[0]}"><span class="d"></span>${ind[1]}</div></div>
    <div class="card pad" style="margin-top:18px"><span class="tag">${q.type==='FIB'?'Fill in the blank':q.type==='TF'?'True / False':q.type}</span>
      <p style="font-size:17px;font-weight:600;margin:14px 0 18px;line-height:1.45">${q.text}</p>${renderQuestionControls(q,state.answers[q.no])}</div>
    <div class="flex jb ac" style="margin-top:18px">
      <button class="flagbtn ${flagged?'on':''}" onclick="toggleFlag(${q.no})">${flagged?'⚑ Flagged':'⚐ Flag for review'}</button>
      <div class="flex g12"><button class="btn ghost" onclick="nav(-1)" ${state.pidx===0?'disabled':''}>← Previous</button>
        ${state.pidx===total-1?'<button class="btn" onclick="enterReview()">Review answers →</button>':'<button class="btn" onclick="nav(1)">Next →</button>'}</div></div>
  </div>`;
}
function renderQuestionControls(q,val,preview){
  const dis=preview?'style="pointer-events:none;opacity:.85"':'';
  if(q.type==='MCQ')return `<div ${dis}>`+q.opts.map((o,i)=>`<div class="opt ${val===i?'sel':''}" onclick="${preview?'':`answer(${q.no},${i})`}"><span class="rd"></span>${o}</div>`).join('')+`</div>`;
  if(q.type==='TF')return `<div class="tf" ${dis}>`+q.opts.map((o,i)=>`<button class="${val===i?'sel':''}" onclick="${preview?'':`answer(${q.no},${i})`}">${o}</button>`).join('')+`</div>`;
  if(q.type==='FIB')return `<div class="fib" ${dis}><input placeholder="Type your answer…" value="${val||''}" oninput="${preview?'':`answer(${q.no},this.value)`}"><div class="muted small" style="margin-top:6px">One word answer</div></div>`;
  if(q.type==='Likert')return `<div class="likert" ${dis}>`+q.opts.map((o,i)=>`<button class="${val===i?'sel':''}" onclick="${preview?'':`answer(${q.no},${i})`}">${o}</button>`).join('')+`</div>`;
  return '';
}
function answer(no,v){state.answers[no]=v;simulateSave();renderParticipant();}
let saveTimer;
function simulateSave(){state.saveState='saving';clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{state.saveState='saved';if(state.ptab==='player'&&!state.inReview&&!state.submitted)renderParticipant();},700);}
function toggleFlag(no){state.flags[no]=!state.flags[no];renderParticipant();}
function nav(d){state.pidx=Math.max(0,Math.min(QUESTIONS.length-1,state.pidx+d));renderParticipant();const m=document.querySelector('.main');if(m)m.scrollTo(0,0);}
function enterReview(){state.inReview=true;renderParticipant();}
function exitPlayer(){pgo('tasks');toast('Progress saved','ok');}
function playerReview(){
  const total=QUESTIONS.length;
  const answered=QUESTIONS.filter(q=>state.answers[q.no]!==undefined&&state.answers[q.no]!=='').length;
  const cells=QUESTIONS.map((q,i)=>{const a=state.answers[q.no]!==undefined&&state.answers[q.no]!=='';const f=state.flags[q.no];
    return `<div class="rcell ${a?'ans':''} ${f?'flag':''}" onclick="state.inReview=false;state.pidx=${i};renderParticipant()">${q.no}</div>`;}).join('');
  return `<div class="player-wrap"><h1 style="margin-bottom:6px">Review your answers</h1>
    <p class="muted" style="margin-bottom:18px">${answered} of ${total} answered${answered<total?` · ${total-answered} unanswered`:''}. Tap any number to jump back.</p>
    <div class="card pad"><div class="review-grid">${cells}</div>
    <div class="legend" style="margin-top:16px">
      <span><i style="background:var(--indigo);width:12px;height:12px;border-radius:3px"></i>Answered</span>
      <span><i style="background:#fff;border:1.5px solid var(--g300);width:12px;height:12px;border-radius:3px"></i>Unanswered</span>
      <span><i style="background:var(--warn-l);border:1.5px solid var(--warn);width:12px;height:12px;border-radius:3px"></i>Flagged</span></div></div>
    <div class="flex jb" style="margin-top:18px"><button class="btn ghost" onclick="state.inReview=false;renderParticipant()">← Back to questions</button>
      <button class="btn" onclick="confirmSubmit(${answered},${total})">Submit assessment</button></div></div>`;
}
function confirmSubmit(answered,total){
  showModal({title:'Submit EoCA 2?',
    body:answered<total?`You have <b>${total-answered} unanswered question(s)</b>. You can still submit, but they will be marked blank. This cannot be undone.`
      :`All ${total} questions answered. Once submitted you cannot change your responses.`,
    confirm:'Submit now',onConfirm:()=>{
      closeModal();
      // octopus loader during submission + score calculation (per the brief)
      layout.innerHTML=`<div style="flex:1;display:flex;flex-direction:column;min-height:0"><div class="main"></div></div>`;
      mountOctopus(document.querySelector('.main'),'Submitting your answers…');
      setTimeout(()=>{state.submitted=true;renderParticipant();},1000);
    }});
}
function playerDone(){return `<div class="player-wrap" style="text-align:center;padding-top:40px"><div style="font-size:54px">✅</div>
  <h1 style="margin:14px 0 6px">EoCA 2 submitted</h1><p class="muted">Your responses are saved. Your report will be released once the stage closes.</p>
  <button class="btn" style="margin-top:18px" onclick="pgo('tasks')">Back to my tasks</button></div>`;}

/* === Screen 4 / Flow D: Comprehensive Report === */
function pReport(){
  const me=ME(), first=me.n.split(/\s+/)[0];
  return `<div class="report-wrap"><div class="grid" style="grid-template-columns:180px 1fr;align-items:start">
    <div class="section-nav" id="secNav">
      <a href="#summary" class="on">Summary</a><a href="#technical">Technical progression</a>
      <a href="#behavioral">Behavioral 360</a><a href="#themes">Strengths & gaps</a><a href="#recs">Recommendations</a></div>
    <div>
      <div class="flex jb ac" style="margin-bottom:16px"><div class="crumb">My Reports / Comprehensive</div>
        <button class="btn ghost sm" onclick="exportReport()">⤓ Export PDF</button></div>
      <section id="summary"><div class="summary-band"><div>
        <div class="ai-label" style="background:rgba(255,255,255,.18);color:#fff">✦ AI-generated</div>
        <h1 style="color:#fff;margin:10px 0 4px">${me.n} — Lifecycle report</h1>
        <div style="opacity:.85;font-size:13px">${meta(me)} · Baseline → Endline + WPCA</div></div>
        <p style="margin:14px 0 0;opacity:.95;max-width:600px">${first} shows strong, consistent technical growth across the program, with the sharpest gains in data interpretation. The 360 feedback highlights collaboration as a standout strength, while pointing to opportunities in proactively communicating analytical findings to non-technical stakeholders.</p>
        <div class="metric-tiles">
          <div class="mt"><div class="v tnum">+34%</div><div class="l">Technical gain (Baseline→Endline)</div></div>
          <div class="mt"><div class="v tnum">4.2</div><div class="l">Behavioral score (of 5)</div></div>
          <div class="mt"><div class="v tnum">100%</div><div class="l">Stages completed</div></div>
          <div class="mt"><div class="v tnum">7</div><div class="l">Raters · Week 2</div></div></div></div></section>

      <section id="technical" style="margin-top:26px"><h2 style="margin-bottom:4px">Technical progression</h2>
        <p class="muted small" style="margin-bottom:12px">Scores across the five technical checkpoints, by competency.</p>
        <div class="card pad">${lineChart()}</div>
        <div class="ai-block"><span class="ai-label">✦ AI interpretation</span>
        <p style="margin:8px 0 0">${first}'s overall score rose steadily from 52% at baseline to 86% at endline. The steepest improvement came in <b>Data Interpretation</b> (+41 points), which plateaued only after EoCA 2 — suggesting mastery was reached mid-program. <b>Statistical Reasoning</b> grew more gradually and remains the relative growth area, consistent with the blueprint tags on the most-missed questions.</p></div></section>

      <section id="behavioral" style="margin-top:26px"><h2 style="margin-bottom:4px">Behavioral 360</h2>
        <p class="muted small" style="margin-bottom:12px">Self-rating vs. aggregated other-raters (Manager, Peers, Reportee).</p>
        <div class="card pad" style="display:flex;justify-content:center">${radarChart()}</div>
        <div class="legend" style="justify-content:center"><span><i style="background:var(--indigo)"></i>Self</span><span><i style="background:var(--teal)"></i>Others (aggregated)</span></div>
        <div class="ai-block"><span class="ai-label">✦ AI synthesis</span>
        <p style="margin:8px 0 0">Other raters score ${first} notably higher than the self-rating on <b>Collaboration</b> and <b>Reliability</b>, indicating modest self-assessment and a well-regarded team presence. The clearest self-vs-other gap is on <b>Communication</b>, rated higher in the self-assessment than by raters — a constructive blind spot to explore. Individual rater identities are kept confidential; the themes below are synthesized across all responses.</p></div></section>

      <section id="themes" style="margin-top:26px"><h2 style="margin-bottom:12px">Strengths & development areas</h2>
        <div class="grid" style="grid-template-columns:1fr 1fr">
          <div class="card pad"><div class="badge ok" style="margin-bottom:8px">Strengths</div>
            <p style="margin:0">Dependable delivery under deadlines; generous in supporting peers; rigorous, well-documented analysis that colleagues trust and reuse.</p></div>
          <div class="card pad"><div class="badge warn" style="margin-bottom:8px">Development areas</div>
            <p style="margin:0">Translating findings for non-technical audiences; speaking up earlier in reviews; strengthening statistical reasoning on inference questions.</p></div></div></section>

      <section id="recs" style="margin-top:26px"><h2 style="margin-bottom:12px">Recommendations</h2>
        <div class="ai-block" style="border-color:var(--teal);background:#eef6f0"><span class="ai-label" style="background:#dcf0e3;color:#1f5b34">✦ AI-generated</span>
        <p style="margin:8px 0 0">Pair ${first} with a stakeholder-facing project to practice communicating insights; offer a short module on inferential statistics to close the reasoning gap; and, given the trusted-reviewer reputation, consider a peer-mentoring role to extend impact across the cohort.</p></div>
        <p class="muted small" style="margin-top:16px">All narrative sections on this report are generated by an LLM from assessment scores, the question blueprint, and anonymized 360 feedback.</p></section>
    </div></div></div>`;
}
function exportReport(){
  // octopus loader during PDF generation (per the brief)
  const m=document.querySelector('.main'); if(!m)return;
  const prev=m.innerHTML;
  mountOctopus(m,'Generating your report…');
  setTimeout(()=>{m.innerHTML=prev;initReportScroll();toast('Report exported to PDF','ok');},1100);
}
function lineChart(){
  const labels=['Baseline','EoCA 1','EoCA 2','EoCA 3','Endline'];
  const overall=[52,64,73,79,86], interp=[48,66,82,84,89], stats=[55,60,66,72,80];
  const W=560,H=240,pl=36,pb=28,pt=12,pr=12;
  const x=i=>pl+i*((W-pl-pr)/(labels.length-1)), y=v=>pt+(100-v)/100*(H-pt-pb);
  const path=a=>a.map((v,i)=>(i?'L':'M')+x(i)+' '+y(v)).join(' ');
  const dots=(a,c)=>a.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${c}"/>`).join('');
  const grid=[0,25,50,75,100].map(v=>`<line x1="${pl}" y1="${y(v)}" x2="${W-pr}" y2="${y(v)}" stroke="#e2e8f0"/><text x="6" y="${y(v)+4}" font-size="10" fill="#94a3b8">${v}</text>`).join('');
  const xl=labels.map((l,i)=>`<text x="${x(i)}" y="${H-8}" font-size="10" fill="#64748b" text-anchor="middle">${l}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${grid}
    <path d="${path(interp)}" fill="none" stroke="#3c9052" stroke-width="2"/>${dots(interp,'#3c9052')}
    <path d="${path(stats)}" fill="none" stroke="#c98a00" stroke-width="2"/>${dots(stats,'#c98a00')}
    <path d="${path(overall)}" fill="none" stroke="#016796" stroke-width="2.5"/>${dots(overall,'#016796')}${xl}</svg>
    <div class="legend"><span><i style="background:#016796"></i>Overall</span><span><i style="background:#3c9052"></i>Data interpretation</span><span><i style="background:#c98a00"></i>Statistical reasoning</span></div>`;
}
function radarChart(){
  const axes=['Collaboration','Communication','Reliability','Problem-solving','Initiative'];
  const self=[4.0,4.4,4.1,4.2,3.6], other=[4.7,3.8,4.6,4.3,3.9], cx=170,cy=160,R=120,N=axes.length,max=5;
  const pt=(i,v)=>{const a=-Math.PI/2+i*2*Math.PI/N,r=v/max*R;return [cx+r*Math.cos(a),cy+r*Math.sin(a)];};
  const ring=l=>{let p='';for(let i=0;i<N;i++){const[x,y]=pt(i,l);p+=(i?'L':'M')+x+' '+y;}return p+'Z';};
  const poly=(a,c,f)=>{let p='';a.forEach((v,i)=>{const[x,y]=pt(i,v);p+=(i?'L':'M')+x+' '+y;});return `<path d="${p}Z" fill="${f}" stroke="${c}" stroke-width="2"/>`;};
  const spokes=axes.map((_,i)=>{const[x,y]=pt(i,max);return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e2e8f0"/>`;}).join('');
  const labs=axes.map((a,i)=>{const[x,y]=pt(i,max+0.6);return `<text x="${x}" y="${y}" font-size="10.5" fill="#475569" text-anchor="middle">${a}</text>`;}).join('');
  const rings=[1,2,3,4,5].map(l=>`<path d="${ring(l)}" fill="none" stroke="#e6f1f7"/>`).join('');
  return `<svg viewBox="0 0 340 320" width="340" height="300">${rings}${spokes}${poly(other,'#3c9052','rgba(60,144,82,.15)')}${poly(self,'#016796','rgba(1,103,150,.18)')}${labs}</svg>`;
}
function initReportScroll(){
  setTimeout(()=>{
    const main=document.querySelector('.main'),nav=document.getElementById('secNav'); if(!main||!nav)return;
    const secs=['summary','technical','behavioral','themes','recs'].map(id=>document.getElementById(id));
    main.onscroll=()=>{let cur=secs[0].id;secs.forEach(s=>{if(s&&s.getBoundingClientRect().top<200)cur=s.id;});
      nav.querySelectorAll('a').forEach(a=>a.classList.toggle('on',a.getAttribute('href')==='#'+cur));};
    nav.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();document.getElementById(a.getAttribute('href').slice(1)).scrollIntoView({behavior:'smooth',block:'start'});});
  },50);
}
