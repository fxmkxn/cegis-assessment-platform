// CEGIS octopus loader
// This is the only loading indicator used across the platform.
// The animation maths is kept exactly as in the original build prompt.
// Colours are mapped to the CEGIS palette (blue body, green suckers).
// Usage: showLoader("Submitting your answers...")  and  hideLoader()
(function () {
  var OCTO_BLUE = "#016796";
  var OCTO_BLUE_D = "#014f73";
  var OCTO_GREEN = "#8fc6a3";

  // inject the stylesheet once
  var css = ""
    + ".octo-overlay{position:fixed;inset:0;background:rgba(255,255,255,.92);z-index:900;"
    + "display:none;align-items:center;justify-content:center}"
    + ".octo-overlay.show{display:flex}"
    + ".octo-scene{display:flex;flex-direction:column;align-items:center;gap:22px}"
    + ".octo-wrap{animation:octo-bob 2.2s ease-in-out infinite;display:flex;flex-direction:column;align-items:center}"
    + ".octo-head{width:90px;height:100px;background:" + OCTO_BLUE + ";border-radius:45px 45px 38px 38px;"
    + "position:relative;box-shadow:inset 0 -8px 0 rgba(0,0,0,.12),inset 0 18px 0 rgba(255,255,255,.12);z-index:2}"
    + ".octo-eye{width:22px;height:22px;background:#fff;border-radius:50%;position:absolute;top:26px}"
    + ".octo-eye.l{left:14px}.octo-eye.r{right:14px}"
    + ".octo-pupil{width:12px;height:12px;background:#161817;border-radius:50%;position:absolute;top:5px;left:5px;animation:octo-blink 3.5s ease-in-out infinite}"
    + ".octo-pupil::after{content:'';width:4px;height:4px;background:#fff;border-radius:50%;position:absolute;top:2px;left:2px}"
    + ".octo-smile{width:28px;height:11px;border:3px solid " + OCTO_BLUE_D + ";border-top:none;border-radius:0 0 16px 16px;position:absolute;left:31px;top:68px}"
    + ".octo-svg{display:block;margin-top:-10px;z-index:1}"
    + ".octo-msg{font-size:13px;color:#535856;font-weight:600;max-width:280px;text-align:center}"
    + ".octo-dots span{display:inline-block;width:5px;height:5px;background:" + OCTO_BLUE + ";border-radius:50%;margin:0 3px;animation:octo-dotpop 1.2s ease-in-out infinite}"
    + ".octo-dots span:nth-child(2){animation-delay:.2s}.octo-dots span:nth-child(3){animation-delay:.4s}"
    + "@keyframes octo-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-16px)}}"
    + "@keyframes octo-blink{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(.08)}}"
    + "@keyframes octo-dotpop{0%,60%,100%{transform:scale(.6);opacity:.3}30%{transform:scale(1.3);opacity:1}}";
  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // build the overlay DOM
  var overlay = document.createElement("div");
  overlay.className = "octo-overlay";
  overlay.innerHTML =
    '<div class="octo-scene">'
    + '<div class="octo-wrap">'
    + '<div class="octo-head"><div class="octo-eye l"><div class="octo-pupil"></div></div>'
    + '<div class="octo-eye r"><div class="octo-pupil"></div></div><div class="octo-smile"></div></div>'
    + '<svg class="octo-svg" width="200" height="95" viewBox="0 0 200 95"></svg>'
    + '</div>'
    + '<div class="octo-msg" style="display:none"></div>'
    + '<div class="octo-dots"><span></span><span></span><span></span></div>'
    + '</div>';
  document.body.appendChild(overlay);

  var svg = overlay.querySelector(".octo-svg");
  var msgEl = overlay.querySelector(".octo-msg");
  var dotsEl = overlay.querySelector(".octo-dots");

  // tentacle setup - same numbers as the original
  var xBases = [60, 72, 84, 96, 108, 120, 132, 144];
  var phaseOffsets = [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84];
  var strokeWidths = [14, 13, 13, 12, 12, 13, 13, 14];

  var paths = xBases.map(function (xb, i) {
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", OCTO_BLUE);
    p.setAttribute("stroke-width", strokeWidths[i]);
    p.setAttribute("stroke-linecap", "round");
    svg.appendChild(p);
    return p;
  });
  var suckerGroups = xBases.map(function () {
    var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    for (var s = 0; s < 3; s++) {
      var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("r", 3.5);
      c.setAttribute("fill", OCTO_GREEN);
      g.appendChild(c);
    }
    svg.appendChild(g);
    return g;
  });

  // point on a cubic bezier, used to place the suckers along each tentacle
  function cubicBezier(x0, y0, cx1, cy1, cx2, cy2, x1, y1, t) {
    var mt = 1 - t;
    var x = mt * mt * mt * x0 + 3 * mt * mt * t * cx1 + 3 * mt * t * t * cx2 + t * t * t * x1;
    var y = mt * mt * mt * y0 + 3 * mt * mt * t * cy1 + 3 * mt * t * t * cy2 + t * t * t * y1;
    return { x: x, y: y };
  }

  var frameId = null;

  function animate(timestamp) {
    var t = timestamp / 1000;
    xBases.forEach(function (xb, i) {
      var phase = t * 1.8 + phaseOffsets[i] * Math.PI * 2;
      var side = i < 4 ? -1 : 1;
      var amp = 28 + Math.abs(i - 3.5) * 6;
      var cp1x = xb + side * amp * Math.sin(phase) * 0.8;
      var cp1y = 30;
      var cp2x = xb + side * amp * Math.sin(phase + 1.2) * -0.9;
      var cp2y = 62;
      var tipX = xb + side * (12 + Math.abs(i - 3.5) * 4) + side * amp * 0.4 * Math.sin(phase + 2.0);
      var tipY = 90;
      paths[i].setAttribute("d", "M " + xb + " 0 C " + cp1x + " " + cp1y + " " + cp2x + " " + cp2y + " " + tipX + " " + tipY);
      var suckers = suckerGroups[i].children;
      [0.3, 0.58, 0.82].forEach(function (st, si) {
        var pt = cubicBezier(xb, 0, cp1x, cp1y, cp2x, cp2y, tipX, tipY, st);
        suckers[si].setAttribute("cx", pt.x);
        suckers[si].setAttribute("cy", pt.y);
      });
    });
    frameId = requestAnimationFrame(animate);
  }

  // public controls
  var depth = 0;
  window.showLoader = function (message) {
    depth++;
    if (message) { msgEl.textContent = message; msgEl.style.display = "block"; dotsEl.style.display = "none"; }
    else { msgEl.style.display = "none"; dotsEl.style.display = "block"; }
    overlay.classList.add("show");
    if (frameId === null) frameId = requestAnimationFrame(animate);
  };
  window.hideLoader = function (force) {
    depth = force ? 0 : Math.max(0, depth - 1);
    if (depth > 0) return;
    overlay.classList.remove("show");
    // stop the animation loop so it does not run in the background
    if (frameId !== null) { cancelAnimationFrame(frameId); frameId = null; }
  };

  // safety: stop the loop if the page is being torn down
  window.addEventListener("beforeunload", function () {
    if (frameId !== null) cancelAnimationFrame(frameId);
  });
})();
