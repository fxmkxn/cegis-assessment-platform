// data.js — data layer, roster parsing, panel building, and sample assessment content (verbatim from prototype)

/* ============================================================
   DATA LAYER
   The roster loads LIVE from the uploaded Excel file at runtime.
   If the file can't be read (e.g. running in a normal browser),
   we fall back to sample data so every screen still demonstrates.
   ============================================================ */
const SAMPLE_ROSTER = [
  {id:'a.rao@org.in',n:'Asha Rao',des:'Sr. Analyst',ws:'Health',loc:'Delhi',mgr:'p.menon@org.in'},
  {id:'k.iyer@org.in',n:'Karthik Iyer',des:'Analyst',ws:'Health',loc:'Chennai',mgr:'p.menon@org.in'},
  {id:'p.menon@org.in',n:'Priya Menon',des:'Lead',ws:'Health',loc:'Delhi',mgr:'d.shah@org.in'},
  {id:'r.das@org.in',n:'Rohan Das',des:'Analyst',ws:'Education',loc:'Kolkata',mgr:'s.nair@org.in'},
  {id:'s.nair@org.in',n:'Sneha Nair',des:'Lead',ws:'Education',loc:'Bengaluru',mgr:'d.shah@org.in'},
  {id:'m.khan@org.in',n:'Maaz Khan',des:'Sr. Analyst',ws:'Finance',loc:'Mumbai',mgr:'t.bose@org.in'},
  {id:'t.bose@org.in',n:'Tara Bose',des:'Lead',ws:'Finance',loc:'Mumbai',mgr:'d.shah@org.in'},
  {id:'d.shah@org.in',n:'Dev Shah',des:'Director',ws:'Strategy',loc:'Delhi',mgr:null},
  {id:'l.roy@org.in',n:'Leela Roy',des:'Analyst',ws:'Education',loc:'Chennai',mgr:'s.nair@org.in'},
  {id:'v.suri@org.in',n:'Vikram Suri',des:'Analyst',ws:'Finance',loc:'Delhi',mgr:'t.bose@org.in'},
];

let ROSTER = SAMPLE_ROSTER.slice();
let SUBJECTS = [];
let PANELS = {};
let HAS_HIERARCHY = true;
let DATA_SOURCE = 'sample';

const nameOf = id => (ROSTER.find(r=>r.id===id)||{}).n || id;
const initials = n => (n||'?').split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
const slug = n => (String(n).toLowerCase().replace(/[^a-z0-9]+/g,'.').replace(/^\.|\.$/g,'')) || ('m'+Math.random().toString(36).slice(2,7));
const ME = () => ROSTER[0] || {n:'Member',id:'',des:'',ws:'',loc:'',mgr:null};
const meta = p => [p.des,p.ws,p.loc].filter(Boolean).join(' · ') || 'Team member';

function ensureXLSX(){
  return new Promise(res=>{
    if(window.XLSX) return res(true);
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload=()=>res(true); s.onerror=()=>res(false);
    document.head.appendChild(s);
  });
}
// fuzzy-match the file's column headers onto our standard fields
function mapRows(rows){
  if(!rows.length) return [];
  const keys = Object.keys(rows[0]);
  const findKey = (...pats)=> keys.find(k=>{const l=String(k).toLowerCase();return pats.some(p=>l.includes(p));});
  const kName = keys.find(k=>{const l=String(k).toLowerCase();return l.includes('name')&&!l.includes('manager')&&!l.includes('report')&&!l.includes('supervis');})
              || findKey('employee','member','full name');
  const kId   = findKey('email','e-mail','mail') || findKey('emp id','employee id') || findKey('id');
  const kDes  = findKey('designation','role','title','position','grade','level');
  const kWs   = findKey('workstream','work stream','vertical','stream','function','department','dept','team','practice');
  const kLoc  = findKey('location','office','city','base','region','site');
  const kMgr  = keys.find(k=>{const l=String(k).toLowerCase();return l.includes('manager')||l.includes('reports to')||l.includes('reporting')||l.includes('supervis');});
  const val=(r,k)=> k? String(r[k]==null?'':r[k]).trim() : '';
  const people = rows
    .filter(r => val(r,kName) || val(r,kId))
    .map((r,i)=>{
      const name = val(r,kName) || ('Member '+(i+1));
      const email = val(r,kId);
      return {_mgrRaw:val(r,kMgr),n:name,id:email||slug(name),des:val(r,kDes),ws:val(r,kWs),loc:val(r,kLoc),mgr:null};
    });
  const byEmail={}, byName={};
  people.forEach(p=>{ byEmail[p.id.toLowerCase()]=p.id; byName[p.n.toLowerCase()]=p.id; });
  people.forEach(p=>{
    const m=p._mgrRaw;
    p.mgr = m ? (byEmail[m.toLowerCase()] || byName[m.toLowerCase()] || null) : null;
    delete p._mgrRaw;
  });
  return people;
}
async function loadRoster(){
  const ok = await ensureXLSX();
  if(ok && window.fs && window.fs.readFile){
    try{
      const buf = await window.fs.readFile('PM Team Details April 2026.xlsx');
      const wb  = XLSX.read(buf,{type:'array'});
      const ws  = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      if(!aoa.length) throw new Error('empty sheet');
      let hr=0;
      for(let i=0;i<Math.min(aoa.length,8);i++){
        const cells=aoa[i].map(c=>String(c).toLowerCase());
        if(cells.some(c=>c.includes('name'))){ hr=i; break; }
      }
      const headers=aoa[hr].map(c=>String(c).trim());
      const objRows=aoa.slice(hr+1).filter(r=>r.some(c=>String(c).trim()!=='')).map(r=>{const o={};headers.forEach((h,i)=>o[h]=r[i]);return o;});
      const mapped=mapRows(objRows);
      if(!mapped.length) throw new Error('no usable rows');
      ROSTER=mapped; DATA_SOURCE='file';
    }catch(e){
      console.warn('Falling back to sample roster:',e);
      ROSTER=SAMPLE_ROSTER.slice(); DATA_SOURCE='sample';
    }
  }else{
    ROSTER=SAMPLE_ROSTER.slice(); DATA_SOURCE='sample';
  }
  recomputeDerived();
}

function recomputeDerived(){
  HAS_HIERARCHY = ROSTER.some(r=>r.mgr && ROSTER.some(x=>x.id===r.mgr));
  SUBJECTS = HAS_HIERARCHY
    ? ROSTER.filter(r => r.mgr && ROSTER.some(x=>x.id===r.mgr))
    : ROSTER.slice();
  if(SUBJECTS.length===0) SUBJECTS = ROSTER.slice();
  PANELS = buildPanels();
}
function eligiblePeers(sub){ return ROSTER.filter(r => r.id!==sub.id && r.id!==sub.mgr); }
function buildPanels(){
  const panels={};
  SUBJECTS.forEach(s=>{
    const reportee = ROSTER.find(r=>r.mgr===s.id) || null;
    const exclude = new Set([s.id,s.mgr,reportee?reportee.id:null].filter(Boolean));
    const pool = ROSTER.filter(r=>!exclude.has(r.id));
    // smart-assignment ranking: prefer DIFFERENT location (diversity), then SAME workstream (relevance)
    const score = r => (r.loc && r.loc!==s.loc ? -1 : 0) + (r.ws && r.ws===s.ws ? -0.5 : 0);
    const ranked = [...pool].sort((a,b)=>score(a)-score(b));
    panels[s.id] = {
      mgr: (s.mgr && ROSTER.some(x=>x.id===s.mgr)) ? s.mgr : null,
      reportee: reportee ? reportee.id : null,
      peers: ranked.slice(0,3).map(r=>r.id)
    };
  });
  return panels;
}

/* ============================================================
   ASSESSMENT CONTENT (sample EoCA — covers every question type)
   ============================================================ */
const QUESTIONS = [
  {no:1,type:'MCQ',text:'Which measure of central tendency is most robust to outliers?',opts:['Mean','Median','Mode','Range'],correct:1},
  {no:2,type:'TF',text:'A p-value of 0.04 means there is a 96% chance the alternative hypothesis is true.',opts:['True','False'],correct:1},
  {no:3,type:'FIB',text:'A join that returns only rows with matching keys in both tables is called an ____ join.',answer:'inner'},
  {no:4,type:'MCQ',text:'In a normal distribution, roughly what percentage of values fall within one standard deviation of the mean?',opts:['50%','68%','95%','99.7%'],correct:1},
  {no:5,type:'Likert',text:'I feel confident designing a sampling strategy for a new field survey.',opts:['Strongly disagree','Disagree','Neutral','Agree','Strongly agree']},
  {no:6,type:'MCQ',text:'Which chart best shows the relationship between two continuous variables?',opts:['Pie chart','Scatter plot','Stacked bar','Treemap'],correct:1},
  {no:7,type:'TF',text:'Correlation between two variables always implies a causal relationship.',opts:['True','False'],correct:1},
  {no:8,type:'FIB',text:'The process of cleaning and structuring raw data for analysis is called data ____.',answer:'wrangling'},
];
const STAGES = [
  {n:1,name:'Baseline',status:'closed',pct:100,action:'View results'},
  {n:2,name:'EoCA',status:'live',pct:74,action:'Monitor'},
  {n:3,name:'Endline',status:'sched',pct:0,action:'Configure'},
  {n:4,name:'WPCA · 360',status:'sched',pct:0,action:'Set up raters'},
  {n:5,name:'Reporting',status:'idle',pct:18,action:'Generate'},
];
