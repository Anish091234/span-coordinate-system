/* ============================================================
   SPAN — application controller
   ============================================================ */

const HUE_VAR = { star:'var(--sol)', planet:'var(--planet)', moon:'var(--moon)' };
const $ = s => document.querySelector(s);

// craft truth state
const state = { body:'TER', local:{ x:0, y:0, z:0 } };

let playing = false, timeScale = 1, simT = 0, lastTS = performance.now();
let launchAnim = { active:false }, launchPhase = null;
let showElements = false;   // toggle Keplerian elements panel in readout

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

    // Position coordinates HTML
    const coordsHtml = `<div class="coords">${res.fields.map(f=>`
      <div class="coord"><span class="lbl">${f.lbl}</span><span class="val">${f.val}${f.u?`<span class="u">${f.u}</span>`:''}</span></div>
    `).join('')}</div>`;

    // Orbital elements HTML (shown when showElements is on)
    let elemsHtml = '';
    if (showElements) {
      const elems = fmtBodyElements(c);
      if (elems && b.kind !== 'star') {
        const srcLabel = ephemerisStatus === 'loaded' || ephemerisStatus === 'partial'
          ? '<span class="elems-src">Horizons · J2000 ICRF</span>'
          : '<span class="elems-src elems-src-approx">Approximate</span>';
        elemsHtml = `<div class="elems-block">
          <div class="elems-header">Keplerian elements${srcLabel}</div>
          <div class="coords elems-coords">${elems.map(f=>`
            <div class="coord" title="${f.title||''}">
              <span class="lbl">${f.lbl}</span>
              <span class="val elems-val">${f.val}${f.u?`<span class="u">${f.u}</span>`:''}</span>
            </div>`).join('')}
          </div></div>`;
      } else if (b.kind === 'star') {
        elemsHtml = `<div class="elems-block elems-root-note">Root frame: no bounding orbit. All nested addresses reference the ICRF ecliptic backbone.</div>`;
      } else if (!elems) {
        elemsHtml = `<div class="elems-block elems-loading">Fetching Horizons data…</div>`;
      }
    }

    // Craft orbital elements — only in active frame and elements mode
    let craftElemsHtml = '';
    if (showElements && active && !useSurf) {
      const ce = craftApproxElements(state);
      if (ce) {
        craftElemsHtml = `<div class="elems-block elems-craft">
          <div class="elems-header">Craft elements <span class="elems-src elems-src-approx">circular approx</span></div>
          <div class="coords elems-coords">
            ${[
              {lbl:'a', val:ce.a, title:'Semi-major axis'},
              {lbl:'e', val:ce.e, title:'Eccentricity'},
              {lbl:'i', val:ce.i, title:'Inclination'},
              {lbl:'Ω', val:ce.Omega, title:'RAAN'},
              {lbl:'ω', val:ce.omega, title:'Arg of periapsis'},
              {lbl:'ν', val:ce.nu, title:'True anomaly'},
            ].map(f=>`<div class="coord" title="${f.title}"><span class="lbl">${f.lbl}</span><span class="val elems-val">${f.val}</span></div>`).join('')}
          </div></div>`;
      }
    }

    row.innerHTML = `
      <div class="bar"></div>
      <div class="fr-head">
        <div class="fr-id"><span class="code">${b.code}</span><span class="nm">${b.name}</span></div>
        <div class="fr-tag">${tag}</div>
      </div>
      ${coordsHtml}${elemsHtml}${craftElemsHtml}`;
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
      : `Geodetic regime active: <b>lat / long / altitude</b> for ascent &amp; landing within ${BODIES[state.body].code}.`;
    if (launchAnim.active){
      $('#soi-note').innerHTML = `<b style="color:var(--planet)">▲ ASCENT · ${launchPhase}</b> · lifting off from ${BODIES[state.body].code}.`;
    }
  } else {
    const st = soiStatus(state);
    $('#soi-title').textContent = 'Sphere of Influence';
    if (!isFinite(st.boundary)){
      fill.style.width = '6%';
      $('#soi-val').textContent = 'heliocentric';
      $('#soi-note').innerHTML = 'The Sun frame is the root. No bounding sphere of influence.';
    } else {
      fill.style.width = (st.pct*100).toFixed(1) + '%';
      $('#soi-val').textContent = Math.round(st.dist).toLocaleString('en-US') + ' / ' + st.boundary.toLocaleString('en-US') + ' km';
      const pct = (st.pct*100).toFixed(0);
      $('#soi-note').innerHTML = st.pct > 0.92
        ? `<b>Near SOI boundary.</b> Cross it and SPAN hands off to <b>${BODIES[BODIES[state.body].parent].code}</b>.`
        : `Craft occupies <b>${pct}%</b> of ${BODIES[state.body].code}'s sphere of influence.`;
    }
  }
  // ICRF continuity footnote — always visible
  const icrf = document.getElementById('icrf-note');
  if (icrf) icrf.style.display = '';
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
let controls = [];
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
  const altMax = surfaceBand(b.code) * 1.4;
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

function syncControls(){
  const b = BODIES[state.body]; const sch = SCHEME[b.kind];
  const surf = isSurfaceRegime(state);
  const set = (k,v)=>{ const c=controls.find(c=>c.sp.key===k); if(c){ c.input.value=v; c.refresh(); } };
  if (surf){
    const g = geodetic(state); set('lat', g.lat); set('lon', g.lon); set('alt', Math.max(0,g.alt));
  } else if (sch.type === 'ecliptic'){
    const h = craftHelioAU(state); const r = vlen(h);
    set('lon', ((Math.atan2(h.y,h.x)*180/Math.PI)+360)%360);
    set('lat', r>1e-9?Math.asin(h.z/r)*180/Math.PI:0); set('r', r);
  } else if (sch.type === 'spherical'){
    const p = state.local, r = vlen(p);
    set('r', r); set('az', ((Math.atan2(p.y,p.x)*180/Math.PI)+360)%360); set('el', r>1e-9?Math.asin(p.z/r)*180/Math.PI:0);
  } else {
    set('x', state.local.x); set('y', state.local.y); set('z', state.local.z);
  }
}

function afterEdit(){
  if (launchAnim.active) return;
  const prevBody = state.body, prevMode = Scene.frameMode;
  resolveSOI(state);
  const wantMode = isSurfaceRegime(state) ? 'surface' : 'soi';
  if (state.body !== prevBody || wantMode !== prevMode){ enterActiveFrame(); }
  else { Scene.setState(state); updateHUD(); }
}

/* ===========================================================
   Launch / ascent animation
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
  state.local = geodeticFromLLA(state.body, lat0, lon0, 0);
  Scene.buildSurface(state.body);
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
  const alt = L.altTarget * (1 - Math.pow(1-t, 2.3));
  const lon = L.lon0 + L.downrange * Math.pow(t, 1.7);
  state.local = geodeticFromLLA(L.body, L.lat0, lon, alt);
  const thrust = Math.max(0, 1 - t*1.18);
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
   Mission scenarios — real SpaceX reference trajectories
   Walk through how SPAN represents each mission end-to-end.
   =========================================================== */
const MISSIONS = {
  dragon_iss: {
    name: 'Dragon · ISS Rendezvous',
    craft: 'DRAGON',
    phases: [
      {
        label: 'T−0 · KSC Launch Pad 39A',
        desc: 'Crew Dragon on Pad 39A at KSC. SPAN is in the geodetic surface frame: lat/long/altitude. Address is <b>SOL.TER</b>, one level below the Sun, locked to Earth\'s body frame.',
        body: 'TER', mode: 'surface', lat: 28.6, lon: -80.6, alt: 0,
      },
      {
        label: 'T+8:45 · MECO, Coast Arc',
        desc: 'Falcon 9 MECO at ~200 km. Dragon coasts up to parking orbit. The SPAN address stays <b>SOL.TER</b> throughout; only the leaf coordinate changes as it leaves the surface regime.',
        body: 'TER', mode: 'surface', lat: 28.6, lon: -65.0, alt: 200,
      },
      {
        label: 'T+6 h · Phasing Orbit',
        desc: 'Dragon in a 200x400 km phasing orbit below the ISS. SPAN is now in the body-centred spherical frame: <b>SOL.TER ⟨ r Az El ⟩</b>. Range from Earth centre ~6,771 km.',
        body: 'TER', mode: 'orbit', r: 6771, az: 100, el: 0,
      },
      {
        label: 'T+27 h · R-bar Approach',
        desc: 'Dragon within 1 km of ISS on the R-bar approach. Address is still <b>SOL.TER</b>. Az and El are barely ticking; the frame stays constant, only the numbers change.',
        body: 'TER', mode: 'orbit', r: 6786, az: 101.5, el: 51.6,
      },
    ],
  },
  starship_lunar: {
    name: 'Starship HLS · Lunar Landing',
    craft: 'STARSHIP-HLS',
    phases: [
      {
        label: 'Trans-Lunar Injection',
        desc: 'Starship HLS leaves Earth orbit on the way to the Moon. Still inside TER\'s SOI at 924,000 km. SPAN address is <b>SOL.TER</b>; Luna\'s SOI hasn\'t captured it yet.',
        body: 'TER', mode: 'orbit', r: 700000, az: 280, el: 2,
      },
      {
        label: 'SOI Handoff → NRHO',
        desc: 'Starship crosses Luna\'s sphere of influence (66,100 km). SPAN hands off automatically: <b>SOL.TER.LUN</b>. The address gains one node. NRHO periapsis is ~3,000 km over the south pole, a very elongated orbit that\'s cheap on delta-v.',
        body: 'LUN', mode: 'orbit', r: 65000, az: 350, el: -75,
      },
      {
        label: 'Low Lunar Orbit (LLO)',
        desc: 'Starship circularises into a 100 km Low Lunar Orbit. SPAN: <b>SOL.TER.LUN ⟨ r Az El ⟩</b>, ~1,837 km from Luna\'s centre. PDI burn starts from this altitude.',
        body: 'LUN', mode: 'orbit', r: 1837, az: 45, el: 3,
      },
      {
        label: 'Touchdown · South Pole',
        desc: 'Starship lands at the Artemis target site near the lunar south pole. SPAN switches to the geodetic surface frame: <b>SOL.TER.LUN ⌖</b>. Three bodies deep, surface-locked. The address is unambiguous anywhere in the solar system.',
        body: 'LUN', mode: 'surface', lat: -89.2, lon: 0, alt: 0,
      },
    ],
  },
};

let activeMission = null;
let missionPhaseIdx = 0;

function applyMissionPhase(mission, idx) {
  missionPhaseIdx = idx;
  const phase = mission.phases[idx];
  const cn = document.querySelector('#readout h2 .craftname');
  if (cn) cn.textContent = mission.craft;

  if (phase.mode === 'surface') {
    state.body = phase.body;
    state.local = geodeticFromLLA(phase.body, phase.lat, phase.lon, phase.alt);
  } else {
    state.body = phase.body;
    state.local = sph2cart(phase.r, phase.az, phase.el);
  }
  resolveSOI(state);
  enterActiveFrame();
  renderMissionPanel();
}

function renderMissionPanel() {
  const panel = document.getElementById('mission-panel');
  if (!panel || !activeMission) return;
  const m = activeMission, phases = m.phases, phase = phases[missionPhaseIdx];
  panel.innerHTML = `
    <div class="mp-header">
      <span class="mp-name">${m.name}</span>
      <span class="mp-step">${missionPhaseIdx+1}/${phases.length}</span>
    </div>
    <div class="mp-phase-label">${phase.label}</div>
    <div class="mp-desc">${phase.desc}</div>
    <div class="mp-nav">
      <button class="btn mp-btn" ${missionPhaseIdx===0?'disabled':''} onclick="missionStep(-1)"><span class="lbl">◀ Prev</span></button>
      <div class="mp-dots">${phases.map((_,i)=>`<span class="mp-dot${i===missionPhaseIdx?' active':''}"></span>`).join('')}</div>
      <button class="btn mp-btn" ${missionPhaseIdx>=phases.length-1?'disabled':''} onclick="missionStep(1)"><span class="lbl">Next ▶</span></button>
    </div>`;
}

function missionStep(delta) {
  if (!activeMission) return;
  const next = missionPhaseIdx + delta;
  if (next < 0 || next >= activeMission.phases.length) return;
  applyMissionPhase(activeMission, next);
}

function setMission(key) {
  activeMission = key ? MISSIONS[key] : null;
  const panel = document.getElementById('mission-panel');
  if (!panel) return;
  if (activeMission) {
    panel.style.display = 'block';
    applyMissionPhase(activeMission, 0);
  } else {
    panel.style.display = 'none';
    const cn = document.querySelector('#readout h2 .craftname');
    if (cn) cn.textContent = 'SC-VOYAGER';
  }
}

/* ===========================================================
   Ephemeris status badge
   =========================================================== */
function updateEphemerisBadge(loaded, total) {
  const badge = document.getElementById('ephem-badge');
  if (!badge) return;
  if (ephemerisStatus === 'loading') {
    badge.textContent = `HORIZONS ${loaded}/${total}`;
    badge.className = 'ephem-badge loading';
  } else if (ephemerisStatus === 'loaded') {
    badge.textContent = 'HORIZONS ●';
    badge.className = 'ephem-badge ok';
    badge.title = `Real ephemeris loaded for ${loaded} bodies (NASA JPL Horizons API)`;
  } else if (ephemerisStatus === 'partial') {
    badge.textContent = `HORIZONS ${loaded}/${total}`;
    badge.className = 'ephem-badge partial';
    badge.title = 'Partial ephemeris: some bodies fell back to illustrative positions';
  } else {
    badge.textContent = 'HORIZONS ○';
    badge.className = 'ephem-badge failed';
    badge.title = 'Could not reach NASA Horizons API, using illustrative positions';
  }
}

/* ===========================================================
   Time / playback
   =========================================================== */
function updateOrbits(){
  Object.values(BODIES).forEach(b => {
    if (b.kind === 'star'){ b.theta = 0; return; }
    const base = b.theta0_real != null ? b.theta0_real : b.theta0 * Math.PI/180;
    const rate = b.kind === 'planet' ? (1/b.periodYr) : (1/(b.periodDay/365.25));
    b.theta = base + simT * rate * 0.35;
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
  Object.values(BODIES).forEach(b => { b.theta = (b.theta0||0)*Math.PI/180; });

  Scene.init($('#gl'), $('#labels'));
  Scene.onSelect(transfer);
  Scene.start();

  transfer('TER');

  // transfer dropdown
  const sel = $('#transfer');
  const order = ['SOL','MER','VEN','TER','LUN','MAR','PHO','DEI','JUP','IO_','EUR','GAN','CAL','SAT','TIT','URA','NEP','TRI'];
  sel.innerHTML = order.map(c => {
    const b = BODIES[c]; const ind = b.kind==='moon' ? '  ↳ ' : (b.kind==='planet'?' ':'');
    return `<option value="${c}">${ind}${b.code}  ${b.name}</option>`;
  }).join('');
  sel.value = state.body;
  sel.addEventListener('change', () => transfer(sel.value));
  window._syncSelect = () => { sel.value = state.body; };

  // mission dropdown
  const msel = document.getElementById('mission-select');
  if (msel) {
    msel.addEventListener('change', () => setMission(msel.value || null));
  }

  // orbital elements toggle
  const elemsBtn = document.getElementById('elems-btn');
  if (elemsBtn) {
    elemsBtn.addEventListener('click', () => {
      showElements = !showElements;
      elemsBtn.classList.toggle('active', showElements);
      elemsBtn.querySelector('.lbl').textContent = showElements ? 'Position' : 'Elements';
      updateHUD();
    });
  }

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
      state.local = sph2cart(0.22*b.soiKm, 40, 14);
    } else {
      const g = geodetic(state);
      state.local = geodeticFromLLA(state.body, g.lat, g.lon, surfaceBand(state.body)*0.12);
    }
    resolveSOI(state); enterActiveFrame();
  });

  $('#launch').addEventListener('click', beginLaunch);

  $('#about-btn').addEventListener('click', ()=> $('#overlay').classList.add('open'));
  $('#overlay').addEventListener('click', e => { if (e.target.id==='overlay') $('#overlay').classList.remove('open'); });
  $('#about-close').addEventListener('click', ()=> $('#overlay').classList.remove('open'));

  window._syncSelect();

  // Fetch real ephemeris from NASA Horizons in the background
  updateEphemerisBadge(0, Object.keys(HORIZONS_CONFIG).length);
  fetchAllEphemeris((loaded, total) => {
    updateEphemerisBadge(loaded, total);
  }).then(loaded => {
    updateEphemerisBadge(loaded, Object.keys(HORIZONS_CONFIG).length);
    if (loaded > 0) {
      // Refresh scene with real planet positions
      Scene.setState(state);
      updateHUD();
    }
  });

  requestAnimationFrame(loop);
}

const _enter = enterActiveFrame;
enterActiveFrame = function(){ _enter(); if (window._syncSelect) window._syncSelect(); };

document.addEventListener('DOMContentLoaded', boot);
