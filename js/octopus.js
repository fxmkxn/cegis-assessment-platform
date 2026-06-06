// octopus.js — the single loading indicator used across the app (verbatim from prototype)

/* ============================================================
   OCTOPUS LOADER LOGIC
   Plain HTML version of the component from the brief. One single
   requestAnimationFrame loop, cancelled when the SVG leaves the DOM
   so it never wastes memory in the background.
   ============================================================ */
let _octRAF = null;
function octopusMarkup(message){
  return `<div class="oct-scene">
    <div style="position:relative">
      <div class="oct-bubbles">
        <div class="oct-bubble" style="width:8px;height:8px;left:10px;bottom:0;animation-duration:4s;animation-delay:0s"></div>
        <div class="oct-bubble" style="width:5px;height:5px;left:170px;bottom:0;animation-duration:5.5s;animation-delay:1s"></div>
        <div class="oct-bubble" style="width:10px;height:10px;left:95px;bottom:0;animation-duration:3.8s;animation-delay:2s"></div>
        <div class="oct-bubble" style="width:6px;height:6px;left:40px;bottom:0;animation-duration:6s;animation-delay:.5s"></div>
      </div>
      <div class="oct-wrap">
        <div class="oct-head">
          <div class="oct-eye-l"><div class="oct-pupil"></div></div>
          <div class="oct-eye-r"><div class="oct-pupil"></div></div>
          <div class="oct-smile"></div>
        </div>
        <svg class="oct-svg" width="200" height="95" viewBox="0 0 200 95" id="octSvg"></svg>
      </div>
    </div>
    ${message ? `<div class="oct-msg">${message}</div>` : `<div class="oct-dots"><span></span><span></span><span></span></div>`}
  </div>`;
}
function startOctopus(){
  const svg = document.getElementById('octSvg');
  if(!svg) return;
  // x positions where each tentacle starts at the bottom of the head
  const xBases = [60,72,84,96,108,120,132,144];
  // each tentacle starts its wave at a slightly different point so they ripple
  const phaseOffsets = [0,.12,.24,.36,.48,.60,.72,.84];
  // outer tentacles are slightly thicker than inner ones
  const strokeWidths = [14,13,13,12,12,13,13,14];
  // one path per tentacle
  const paths = xBases.map((xb,i)=>{
    const p = document.createElementNS('http://www.w3.org/2000/svg','path');
    p.setAttribute('fill','none');
    p.setAttribute('stroke','#016796');
    p.setAttribute('stroke-width',strokeWidths[i]);
    p.setAttribute('stroke-linecap','round');
    svg.appendChild(p);
    return p;
  });
  // 3 sucker dots per tentacle
  const suckerGroups = xBases.map(()=>{
    const g = document.createElementNS('http://www.w3.org/2000/svg','g');
    for(let s=0;s<3;s++){
      const c = document.createElementNS('http://www.w3.org/2000/svg','circle');
      c.setAttribute('r',3.5);
      c.setAttribute('fill','#9ec6d8');
      g.appendChild(c);
    }
    svg.appendChild(g);
    return g;
  });
  // find a point on a cubic bezier curve, used to place sucker dots
  function cubicBezier(x0,y0,cx1,cy1,cx2,cy2,x1,y1,t){
    const mt=1-t;
    const x=mt*mt*mt*x0+3*mt*mt*t*cx1+3*mt*t*t*cx2+t*t*t*x1;
    const y=mt*mt*mt*y0+3*mt*mt*t*cy1+3*mt*t*t*cy2+t*t*t*y1;
    return {x,y};
  }
  function animate(timestamp){
    // stop the loop if the octopus has been removed from the page
    if(!document.body.contains(svg)){ _octRAF=null; return; }
    const t = timestamp/1000;
    xBases.forEach((xb,i)=>{
      const phase = t*1.8 + phaseOffsets[i]*Math.PI*2;
      const side = i<4 ? -1 : 1;
      const amp = 28 + Math.abs(i-3.5)*6;
      const cp1x = xb + side*amp*Math.sin(phase)*0.8, cp1y = 30;
      const cp2x = xb + side*amp*Math.sin(phase+1.2)*-0.9, cp2y = 62;
      const tipX = xb + side*(12+Math.abs(i-3.5)*4) + side*amp*0.4*Math.sin(phase+2.0), tipY = 90;
      paths[i].setAttribute('d',`M ${xb} 0 C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${tipX} ${tipY}`);
      const suckers = suckerGroups[i].children;
      [0.30,0.58,0.82].forEach((st,si)=>{
        const pt = cubicBezier(xb,0,cp1x,cp1y,cp2x,cp2y,tipX,tipY,st);
        suckers[si].setAttribute('cx',pt.x);
        suckers[si].setAttribute('cy',pt.y);
      });
    });
    _octRAF = requestAnimationFrame(animate);
  }
  _octRAF = requestAnimationFrame(animate);
}
// drop the octopus into a container and start the animation
function mountOctopus(el,message){
  if(_octRAF){ cancelAnimationFrame(_octRAF); _octRAF=null; }
  el.innerHTML = '<div class="oct-loading">'+octopusMarkup(message)+'</div>';
  startOctopus();
}
