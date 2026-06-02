/* ============================================================
   SPAN — application controller
   ============================================================ */

const HUE_VAR = { star:'var(--sol)', planet:'var(--planet)', moon:'var(--moon)' };
const $ = s => document.querySelector(s);

// craft truth state
const state = { body:'TER', local:{ x:0, y:0, z:0 } };

let playing = false, timeScale = 1, simT = 0, lastTS = performance.now();
let launchAnim = { active:false }, launchPhase = null;

/* ---------- spherical <-> cartesian ---------- */
function sph2cart(r, azDeg, elDeg){
  const az = azDeg*Math.PI/180, el = elDeg*Math.PI/180;
  return { x:r*Math.cos(el)*Math.cos(az), y:r*Math.cos(el)*Math.sin(az), z:r*Math.sin(el) };
}
function ecl2helio(lonDeg, latDeg, rAU){
  const lo = lonDeg*Math.PI/180, la = latDeg*Math.PI/180;
  return { x:rAU*Math.cos(la)*Math.cos(lo), y:rAU*Math.cos(la)*Math.sin(lo), z:rAU*Math.sin(la) };
}

/* ---------- transfer craft to a body ---------- */
function transfer(code){
  const b = BODIES[code];
  if (b.kind === 'star'){
    const h = ecl2helio(210, 3, 1.7);
    state.body = 'SOL'; state.local = vscale(h, AU_KM);
  } else if (b.kind === 'planet'){
    state.body = code; state.local = sph2cart(0.32*b.soiKm, 40, 14);
  } else {
    state.body = code; state.local = sph2cart(0.42*b.soiKm, 40, 18);
  }
  resolveSOI(state);
  enterActiveFrame();
}

/* ---------- (re)build the view + console for the active frame ---------- */
function enterActiveFrame(){
  if (isSurfaceRegime(state)) Scene.buildSurface(state.body);
  else Scene.buildFrame(state.body);
  Scene.setState(state);
  buildControls();
  updateHUD();
}

/* ===========================================================
   HUD: address bar + readout + SOI meter
   =========================================================== */
function updateHUD(){
  const chain = chainOf(state.body);
  const surf = isSurfaceRegime(state);

  // address bar
  const bar = $('#addr-path');
  bar.innerHTML = '';
  chain.forEach((c, i) => {
    if (i) { const d=document.createElement('span'); d.className='dot'; d.textContent='.'; bar.appendChild(d); }
    const span = document.createElement('span');
    const kind = BODIES[c].kind;
    span.className = 'crumb ' + frameClass(kind) + (i < chain.length-1 ? ' inactive' : '');
    span.textContent = c;
    span.title = 'Transfer to ' + BODIES[c].name;
    span.onclick = () => transfer(c);
    bar.appendChild(span);
  });
  const leaf = surf ? resolveSurface(state) : resolveInFrame(state, state.body);
  $('#addr-leaf').innerHTML = (surf ? '⌖ <b>' : '⟨ <b>') + leaf.compact + (surf ? '</b>' : '</b> ⟩');

  // readout rows
  const wrap = $('#frame-rows'); wrap.innerHTML = '';
  chain.forEach((c, i) => {
    const b = BODIES[c]; const active = i === chain.length-1;
    const useSurf = active && surf;
    const res = useSurf ? resolveSurface(state) : resolveInFrame(state, c);
    const tag = useSurf ? 'Geodetic · surface' : SCHEME[b.kind].tag;
    const row = document.createElement('div');
    row.className = 'frame-row ' + frameClass(b.kind) + (active ? ' active' : '');
    row.innerHTML = `
      <div class="bar"></div>
      <div class="fr-head">
        <div class="fr-id"><span class="code">${b.code}</span><span class="nm">${b.name}</span></div>
        <div class="fr-tag">${tag}</div>
      </div>
      <div class="coords">${res.fields.map(f=>`
        <div class="coord"><span class="lbl">${f.lbl}</span><span class="val">${f.val}${f.u?`<span class="u">${f.u}</span>`:''}</span></div>
      `).join('')}</div>`;
    wrap.appendChild(row);
  });

  // status panel — SOI occupancy, or altitude when on a surface
  const kindCls = frameClass(BODIES[state.body].kind);
  const fill = $('#soi-fill');
  $('#soi-status').className = 'panel ' + kindCls;
  $('#soi-status').style.setProperty('--accent', HUE_VAR[BODIES[state.body].kind]);
  if (surf){
    const alt = altitudeKm(state), band = surfaceBand(state.body);
    $('#soi-title').textContent = 'Altitude';
    fill.style.width = Math.max(2, Math.min(100, alt/band*100)).toFixed(1) + '%';
    $('#soi-val').textContent = Math.round(alt).toLocaleString('en-US') + ' km above surface';
    $('#soi-note').innerHTML = alt/band > 0.82
      ? `<b>Approaching orbital altitude.</b> Climb past <b>${Math.round(band).toLocaleString('en-US')} km</b> and SPAN reverts to orbital coordinates.`
      : `Geodetic regime active — <b>lat / long / altitude</b> for ascent &amp; landing within ${BODIES[state.body].code}.`;
    if (launchAnim.active){
      $('#soi-note').innerHTML = `<b style="color:var(--planet)">▲ ASCENT — ${launchPhase}</b> · lifting off from ${BODIES[state.body].code}.`;
    }
  } else {
    const st = soiStatus(state);
    $('#soi-title').textContent = 'Sphere of Influence';
    if (!isFinite(st.boundary)){
      fill.style.width = '6%';
      $('#soi-val').textContent = 'heliocentric';
      $('#soi-note').innerHTML = 'The Sun frame is the root — no bounding sphere of influence.';
    } else {
      fill.style.width = (st.pct*100).toFixed(1) + '%';
      $('#soi-val').textContent = Math.round(st.dist).toLocaleString('en-US') + ' / ' + st.boundary.toLocaleString('en-US') + ' km';
      const pct = (st.pct*100).toFixed(0);
      $('#soi-note').innerHTML = st.pct > 0.92
        ? `<b>Near SOI boundary.</b> Cross it and SPAN hands off to <b>${BODIES[BODIES[state.body].parent].code}</b>.`
        : `Craft occupies <b>${pct}%</b> of ${BODIES[state.body].code}'s sphere of influence.`;
    }
  }
  fill.style.background = HUE_VAR[BODIES[state.body].kind];

  // surface/orbit toggle button
  const surfBtn = document.getElementById('surf');
  const launchBtn = document.getElementById('launch');
  if (surfBtn){
    const isStar = BODIES[state.body].kind === 'star';
    document.getElementById('regime-row').style.display = isStar ? 'none' : 'flex';
    surfBtn.querySelector('.lbl').textContent = surf ? 'Return to orbit' : 'Descend to surface';
    surfBtn.classList.toggle('active', surf);
    if (launchBtn) launchBtn.style.display = surf ? '' : 'none';
  }

  const sel = document.getElementById('transfer');
  if (sel && sel.value !== state.body) sel.value = state.body;
}

/* ===========================================================
   Pilot console — controls match the active frame's scheme
   =========================================================== */
let controls = [];   // {key, get, set}
function buildControls(){
  const b = BODIES[state.body];
  const surf = isSurfaceRegime(state);
  const sch = SCHEME[b.kind];
  const host = $('#controls'); host.innerHTML = ''; controls = [];
  $('#console').style.setProperty('--accent', HUE_VAR[b.kind]);
  $('#pilot-mode').textContent = surf ? 'Geodetic · surface' : sch.tag;

  const specs = surf ? controlSpecsSurface(b) : controlSpecs(b, sch);
  specs.forEach(sp => {
    const c = document.createElement('div'); c.className = 'ctrl';
    c.innerHTML = `
      <div class="ctrl-head"><span class="nm">${sp.name}</span>
        <span class="rd" id="rd-${sp.key}"></span></div>
      <input type="range" min="${sp.min}" max="${sp.max}" step="${sp.step}" id="in-${sp.key}">`;
    host.appendChild(c);
    const input = c.querySelector('input');
    const rd = c.querySelector('.rd');
    const refresh = () => {
      const v = parseFloat(input.value);
      rd.innerHTML = sp.fmt(v);
      input.style.setProperty('--pct', ((v-sp.min)/(sp.max-sp.min)*100)+'%');
    };
    input.addEventListener('input', () => { sp.apply(specs); refresh(); afterEdit(); });
    controls.push({ sp, input, rd, refresh });
  });
  syncControls();
}

function controlSpecsSurface(b){
  const altMax = surfaceBand(b.code) * 1.4;   // allow climbing past the band → orbital
  return [
    { key:'lat', name:'Latitude',  min:-90,  max:90,  step:0.5, fmt:v=>fmtLat(v) },
    { key:'lon', name:'Longitude', min:-180, max:180, step:0.5, fmt:v=>fmtLon(v) },
    { key:'alt', name:'Altitude above surface', min:0, max:altMax, step:Math.max(1,Math.round(altMax/600)),
      fmt:v=>Math.round(v).toLocaleString('en-US')+'<span class="u">km</span>' },
  ].map(s => ({ ...s, apply:applyGeodetic }));
}

function controlSpecs(b, sch){
  if (sch.type === 'ecliptic'){
    return [
      { key:'lon', name:'Ecliptic longitude λ', min:0, max:360, step:0.5, fmt:v=>v.toFixed(1)+'°' },
      { key:'lat', name:'Ecliptic latitude β',  min:-30, max:30, step:0.5, fmt:v=>(v>=0?'+':'−')+Math.abs(v).toFixed(1)+'°' },
      { key:'r',   name:'Range from Sun',        min:0.3, max:31, step:0.01, fmt:v=>v.toFixed(2)+'<span class="u">AU</span>' },
    ].map(s => ({ ...s, apply:applyEcliptic }));
  }
  if (sch.type === 'spherical'){
    const rmax = b.soiKm*1.6;
    return [
      { key:'r',  name:'Range from '+b.code, min:b.radiusKm*1.05, max:rmax, step:Math.max(1,Math.round(rmax/600)), fmt:v=>Math.round(v).toLocaleString('en-US')+'<span class="u">km</span>' },
      { key:'az', name:'Azimuth',   min:0, max:360, step:0.5, fmt:v=>v.toFixed(1)+'°' },
      { key:'el', name:'Elevation', min:-90, max:90, step:0.5, fmt:v=>(v>=0?'+':'−')+Math.abs(v).toFixed(1)+'°' },
    ].map(s => ({ ...s, apply:applySpherical }));
  }
  // cartesian
  const m = b.soiKm*1.6, step = Math.max(1, Math.round(m/600));
  return ['X','Y','Z'].map(ax => ({
    key:ax.toLowerCase(), name:ax+' offset', min:-m, max:m, step,
    fmt:v=>(v>=0?'+':'−')+Math.abs(Math.round(v)).toLocaleString('en-US')+'<span class="u">km</span>',
    apply:applyCartesian,
  }));
}

function readControl(key){ const c = controls.find(c=>c.sp.key===key); return c?parseFloat(c.input.value):0; }

function applyEcliptic(){ const h = ecl2helio(readControl('lon'), readControl('lat'), readControl('r')); state.body='SOL'; state.local = vscale(h, AU_KM); }
function applySpherical(){ state.local = sph2cart(readControl('r'), readControl('az'), readControl('el')); }
function applyCartesian(){ state.local = { x:readControl('x'), y:readControl('y'), z:readControl('z') }; }
function applyGeodetic(){ state.local = geodeticFromLLA(state.body, readControl('lat'), readControl('lon'), readControl('alt')); }

// push current state values into the slider positions
function syncControls(){
  const b = BODIES[state.body]; const sch = SCHEME[b.kind];
  const surf = isSurfaceRegime(state);
  const set = (k,v)=>{ const c=controls.find(c=>c.sp.key===k); if(c){ c.input.value=v; c.refresh(); } };
  if (surf){
    const g = geodetic(state); set('lat', g.lat); set('lon', g.lon); set('alt', Math.max(0,g.alt));
  } else if (sch.type === 'ecliptic'){
    const h = craftHelioAU(state); const r = vlen(h);
    set('lon', ((Math.atan2(h.y,h.x)*DEG)+360)%360);
    set('lat', r>1e-9?Math.asin(h.z/r)*DEG:0); set('r', r);
  } else if (sch.type === 'spherical'){
    const p = state.local, r = vlen(p);
    set('r', r); set('az', ((Math.atan2(p.y,p.x)*DEG)+360)%360); set('el', r>1e-9?Math.asin(p.z/r)*DEG:0);
  } else {
    set('x', state.local.x); set('y', state.local.y); set('z', state.local.z);
  }
}

// after a manual edit: maybe hand off (SOI) or switch surface↔orbital; rebuild if so
function afterEdit(){
  if (launchAnim.active) return;
  const prevBody = state.body, prevMode = Scene.frameMode;
  resolveSOI(state);
  const wantMode = isSurfaceRegime(state) ? 'surface' : 'soi';
  if (state.body !== prevBody || wantMode !== prevMode){ enterActiveFrame(); }
  else { Scene.setState(state); updateHUD(); }
}

/* ===========================================================
   Launch / ascent animation — gravity-turn lift-off with contrail
   =========================================================== */
function setConsoleLock(on){
  document.querySelectorAll('#controls input').forEach(i => i.disabled = on);
  ['surf','launch','transfer','play','speed'].forEach(id => { const e=document.getElementById(id); if(e) e.disabled = on; });
  $('#console').style.opacity = on ? 0.62 : 1;
}

function beginLaunch(){
  const b = BODIES[state.body];
  if (launchAnim.active || b.kind === 'star') return;
  if (playing){ playing=false; const pb=$('#play'); pb.classList.remove('active'); pb.querySelector('.lbl').textContent='Orbits'; }

  const g = geodetic(state);
  const lat0 = g.lat, lon0 = g.lon;
  state.local = geodeticFromLLA(state.body, lat0, lon0, 0);    // on the pad
  Scene.buildSurface(state.body);                              // fresh surface view (clears old trail)
  Scene.setState(state); buildControls(); updateHUD();
  Scene.startLaunch(); Scene.focusLaunch();

  launchAnim = { active:true, t:0, dur:7.5, body:state.body, lat0, lon0,
    altTarget: surfaceBand(state.body)*0.42, downrange: 26 };
  launchPhase = 'powered ascent';
  setConsoleLock(true);
}

function stepLaunchAnim(dt){
  launchAnim.t += dt / launchAnim.dur;
  const t = Math.min(1, launchAnim.t), L = launchAnim;
  const alt = L.altTarget * (1 - Math.pow(1-t, 2.3));       // ease-out climb
  const lon = L.lon0 + L.downrange * Math.pow(t, 1.7);      // gravity-turn pitch-over
  state.local = geodeticFromLLA(L.body, L.lat0, lon, alt);
  const thrust = Math.max(0, 1 - t*1.18);                   // engine cut-off near apoapsis
  launchPhase = thrust > 0.02 ? 'powered ascent' : 'coast · MECO';
  Scene.setState(state);
  Scene.stepLaunch(thrust);
  updateHUD();
  if (launchAnim.t >= 1){
    launchAnim.active = false; launchPhase = null;
    Scene.stopLaunchVisual(); setConsoleLock(false);
    buildControls(); updateHUD();
  }
}

/* ===========================================================
   Time / playback
   =========================================================== */
function updateOrbits(){
  Object.values(BODIES).forEach(b => {
    if (b.kind === 'star'){ b.theta = 0; return; }
    const base = b.theta0 * Math.PI/180;
    const rate = b.kind === 'planet' ? (1/b.periodYr) : (1/(b.periodDay/365.25));
    b.theta = base + simT * rate * 0.35;   // 0.35 = pleasant pace
  });
}
function loop(now){
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now-lastTS)/1000); lastTS = now;
  if (launchAnim.active){ stepLaunchAnim(dt); }
  else if (playing){ simT += dt*timeScale; updateOrbits(); updateHUD(); }
}

/* ===========================================================
   Boot
   =========================================================== */
function boot(){
  // init bodies' theta
  Object.values(BODIES).forEach(b => { b.theta = (b.theta0||0)*Math.PI/180; });

  Scene.init($('#gl'), $('#labels'));
  Scene.onSelect(transfer);
  Scene.start();

  transfer('TER');         // open on the headline example
  // then nudge active down to show a moon? keep at Terra for clarity.

  // transfer dropdown
  const sel = $('#transfer');
  const order = ['SOL','MER','VEN','TER','LUN','MAR','PHO','DEI','JUP','IO_','EUR','GAN','CAL','SAT','TIT','URA','NEP','TRI'];
  sel.innerHTML = order.map(c => {
    const b = BODIES[c]; const ind = b.kind==='moon' ? '  ↳ ' : (b.kind==='planet'?' ':'');
    return `<option value="${c}">${ind}${b.code} — ${b.name}</option>`;
  }).join('');
  sel.value = state.body;
  sel.addEventListener('change', () => transfer(sel.value));
  window._syncSelect = () => { sel.value = state.body; };

  // playback
  const playBtn = $('#play');
  playBtn.addEventListener('click', () => {
    playing = !playing; playBtn.classList.toggle('active', playing);
    playBtn.querySelector('.lbl').textContent = playing ? 'Pause' : 'Orbits';
    lastTS = performance.now();
  });
  $('#speed').addEventListener('click', () => {
    timeScale = timeScale >= 8 ? 1 : timeScale*2;
    $('#speed .lbl').textContent = timeScale + '×';
  });

  // surface / orbit toggle
  $('#surf').addEventListener('click', () => {
    const b = BODIES[state.body]; if (b.kind === 'star') return;
    if (isSurfaceRegime(state)){
      state.local = sph2cart(0.22*b.soiKm, 40, 14);          // ascend to parking orbit
    } else {
      const g = geodetic(state);                              // descend beneath current point
      state.local = geodeticFromLLA(state.body, g.lat, g.lon, surfaceBand(state.body)*0.12);
    }
    resolveSOI(state); enterActiveFrame();
  });

  // animated launch / ascent
  $('#launch').addEventListener('click', beginLaunch);

  // about
  $('#about-btn').addEventListener('click', ()=> $('#overlay').classList.add('open'));
  $('#overlay').addEventListener('click', e => { if (e.target.id==='overlay') $('#overlay').classList.remove('open'); });
  $('#about-close').addEventListener('click', ()=> $('#overlay').classList.remove('open'));

  // keep dropdown synced when active frame changes via clicks/handoff
  window._syncSelect();

  requestAnimationFrame(loop);
}

// wrap enterActiveFrame to keep dropdown in sync
const _enter = enterActiveFrame;
enterActiveFrame = function(){ _enter(); if (window._syncSelect) window._syncSelect(); };

document.addEventListener('DOMContentLoaded', boot);
