/* ============================================================
   SPAN — coordinate math, address resolution, SOI handoff
   Truth state of the craft = { body: <code>, local:{x,y,z} km }
   in that body's local frame. Everything else is derived.
   ============================================================ */

const DEG = 180 / Math.PI;

/* ---- small vector helpers (plain objects, km or AU) ---- */
function vadd(a, b){ return { x:a.x+b.x, y:a.y+b.y, z:a.z+b.z }; }
function vsub(a, b){ return { x:a.x-b.x, y:a.y-b.y, z:a.z-b.z }; }
function vscale(a, s){ return { x:a.x*s, y:a.y*s, z:a.z*s }; }
function vlen(a){ return Math.hypot(a.x, a.y, a.z); }

/* ---- ancestor chain SOL → … → body ---- */
function chainOf(code){
  const out = [];
  let c = code;
  while (c){ out.unshift(c); c = BODIES[c].parent; }
  return out; // ['SOL', 'TER', 'LUN']
}

/* ---- heliocentric position (AU, ecliptic) of a body's centre ---- */
function helioAU(code){
  const b = BODIES[code];
  if (b.kind === 'star') return { x:0, y:0, z:0 };
  const th = (b.theta != null ? b.theta : b.theta0 * Math.PI/180);
  if (b.kind === 'planet'){
    return { x:b.aAU*Math.cos(th), y:b.aAU*Math.sin(th), z:0 };
  }
  // moon: parent helio + orbital offset (km → AU)
  const p = helioAU(b.parent);
  const rAU = b.aKm / AU_KM;
  return { x:p.x + rAU*Math.cos(th), y:p.y + rAU*Math.sin(th), z:p.z };
}

/* ---- craft's true heliocentric position (AU) ---- */
function craftHelioAU(state){
  const base = helioAU(state.body);
  return vadd(base, vscale(state.local, 1/AU_KM));
}

/* ---- formatting helpers ---- */
function fmt(n, dec){
  const s = Math.abs(n) >= 1000
    ? Math.round(n).toLocaleString('en-US')
    : n.toFixed(dec);
  return (n >= 0 ? '+' : '−') + (s[0] === '-' ? s.slice(1) : s);
}
function fmtDeg(n){ return n.toFixed(1) + '°'; }

/* ---- resolve craft coordinates within a given frame ---- */
// returns { fields:[{lbl,val,u}], compact:'…' } per the frame's scheme
function resolveInFrame(state, frameCode){
  const sch = SCHEME[BODIES[frameCode].kind];
  const helio = craftHelioAU(state);

  if (sch.type === 'ecliptic'){
    const r = vlen(helio);
    const lon = ((Math.atan2(helio.y, helio.x) * DEG) + 360) % 360;
    const lat = r > 1e-9 ? Math.asin(helio.z / r) * DEG : 0;
    return {
      fields: [
        { lbl:'λ lon', val: lon.toFixed(1)+'°' },
        { lbl:'β lat', val: (lat>=0?'+':'−')+Math.abs(lat).toFixed(2)+'°' },
        { lbl:'range', val: r.toFixed(3), u:'AU' },
      ],
      compact: `λ${lon.toFixed(1)}° β${(lat>=0?'+':'−')+Math.abs(lat).toFixed(1)}° r${r.toFixed(3)}AU`,
    };
  }

  // position relative to this frame's body centre, in km
  const rel = vscale(vsub(helio, helioAU(frameCode)), AU_KM);

  if (sch.type === 'spherical'){
    const r = vlen(rel);
    const az = ((Math.atan2(rel.y, rel.x) * DEG) + 360) % 360;
    const el = r > 1e-9 ? Math.asin(rel.z / r) * DEG : 0;
    return {
      fields: [
        { lbl:'range', val: Math.round(r).toLocaleString('en-US'), u:'km' },
        { lbl:'azim', val: az.toFixed(1)+'°' },
        { lbl:'elev', val: (el>=0?'+':'−')+Math.abs(el).toFixed(1)+'°' },
      ],
      compact: `r${Math.round(r).toLocaleString('en-US')}km Az${az.toFixed(1)}° El${(el>=0?'+':'−')+Math.abs(el).toFixed(1)}°`,
    };
  }

  // cartesian (moon)
  return {
    fields: [
      { lbl:'X', val: fmt(rel.x,1), u:'km' },
      { lbl:'Y', val: fmt(rel.y,1), u:'km' },
      { lbl:'Z', val: fmt(rel.z,1), u:'km' },
    ],
    compact: `${fmt(rel.x,1)} ${fmt(rel.y,1)} ${fmt(rel.z,1)} km`,
  };
}

/* ---- SOI handoff: resolve which body owns the craft ---- */
// Mutates state.body / state.local so the craft is expressed in the
// deepest body whose SOI contains it. Returns true if frame changed.
function resolveSOI(state){
  let changed = false;
  for (let guard = 0; guard < 12; guard++){
    const b = BODIES[state.body];
    const dist = vlen(state.local);

    // (1) escaped current SOI → climb to parent
    if (b.parent && dist > b.soiKm){
      const helio = craftHelioAU(state);
      state.body = b.parent;
      state.local = vscale(vsub(helio, helioAU(b.parent)), AU_KM);
      changed = true;
      continue;
    }

    // (2) entered a child's SOI → descend (pick deepest / closest)
    let best = null, bestD = Infinity;
    for (const childCode of (b.children || [])){
      const c = BODIES[childCode];
      const d = vlen(vscale(vsub(craftHelioAU(state), helioAU(childCode)), AU_KM));
      if (d < c.soiKm && d < bestD){ best = childCode; bestD = d; }
    }
    if (best){
      const helio = craftHelioAU(state);
      state.body = best;
      state.local = vscale(vsub(helio, helioAU(best)), AU_KM);
      changed = true;
      continue;
    }
    break;
  }
  return changed;
}

/* ---- SOI occupancy: how deep into the active SOI is the craft ---- */
function soiStatus(state){
  const b = BODIES[state.body];
  const dist = vlen(state.local);
  if (!isFinite(b.soiKm)){
    return { pct: 0, dist, boundary: Infinity, label: 'Heliocentric — no bounding SOI' };
  }
  return { pct: Math.min(1, dist / b.soiKm), dist, boundary: b.soiKm };
}

/* ============================================================
   Surface (geodetic) regime — active near a planet/moon surface
   ============================================================ */
// Surface frame engages when altitude above the surface is within one body radius.
function surfaceBand(code){ return BODIES[code].radiusKm; }   // altitude ceiling
function altitudeKm(state){ return vlen(state.local) - BODIES[state.body].radiusKm; }

function isSurfaceRegime(state){
  const b = BODIES[state.body];
  if (b.kind === 'star') return false;
  return altitudeKm(state) < surfaceBand(state.body);
}

// local Cartesian → geodetic (planetocentric lat, east lon, altitude)
function geodetic(state){
  const b = BODIES[state.body], p = state.local, r = vlen(p);
  const lat = r > 1e-9 ? Math.asin(p.z / r) * DEG : 0;
  let lon = Math.atan2(p.y, p.x) * DEG;        // −180..180, east positive
  return { lat, lon, alt: r - b.radiusKm };
}
function geodeticFromLLA(code, latDeg, lonDeg, altKm){
  const b = BODIES[code], r = b.radiusKm + altKm;
  const la = latDeg*Math.PI/180, lo = lonDeg*Math.PI/180;
  return { x:r*Math.cos(la)*Math.cos(lo), y:r*Math.cos(la)*Math.sin(lo), z:r*Math.sin(la) };
}
function fmtLat(v){ return Math.abs(v).toFixed(1) + '°' + (v>=0?'N':'S'); }
function fmtLon(v){ return Math.abs(v).toFixed(1) + '°' + (v>=0?'E':'W'); }
function fmtAlt(v){
  const s = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1);
  return (v>=0?'↑':'↓') + s;
}
function geodeticCompact(state){
  const g = geodetic(state);
  return `${fmtLat(g.lat)} ${fmtLon(g.lon)} ${fmtAlt(g.alt)} km`;
}
function resolveSurface(state){
  const g = geodetic(state);
  return {
    fields: [
      { lbl:'latitude',  val: fmtLat(g.lat) },
      { lbl:'longitude', val: fmtLon(g.lon) },
      { lbl:'altitude',  val: fmtAlt(g.alt), u:'km' },
    ],
    compact: geodeticCompact(state),
  };
}

/* ============================================================
   Keplerian / orbital-elements display
   ============================================================ */

// Format real Horizons elements for a body (shown in elements panel)
function fmtBodyElements(code) {
  const e = REAL_ELEMENTS[code];
  if (!e) return null;
  // Moon's semi-major axis is stored in AU from Horizons geocentric fetch
  const aStr = code === 'LUN'
    ? Math.round(e.a * AU_KM).toLocaleString('en-US') + ' km'
    : e.a.toFixed(6) + ' AU';
  return [
    { lbl:'a',  val: aStr,                   title:'Semi-major axis' },
    { lbl:'e',  val: e.e.toFixed(5),          title:'Eccentricity' },
    { lbl:'i',  val: e.i.toFixed(3)+'°',      title:'Inclination' },
    { lbl:'Ω',  val: e.Omega.toFixed(2)+'°',  title:'Long. ascending node' },
    { lbl:'ω',  val: e.omega.toFixed(2)+'°',  title:'Argument of periapsis' },
    { lbl:'ν',  val: e.nu.toFixed(2)+'°',     title:'True anomaly (J2000 ICRF)' },
  ];
}

// Approximate circular-orbit elements for the craft in its current frame.
// Without tracking velocity, e=0 is assumed; Ω/ω are estimated from position.
function craftApproxElements(state) {
  const b = BODIES[state.body];
  if (b.kind === 'star') {
    const h = craftHelioAU(state), r = vlen(h);
    if (r < 1e-9) return null;
    const nu = ((Math.atan2(h.y, h.x) * DEG) + 360) % 360;
    return { a: r.toFixed(5)+' AU', e:'~0', i:'0.0°', Omega:'—', omega:'—', nu: nu.toFixed(1)+'°', approx:true };
  }
  const p = state.local, r = vlen(p);
  if (r < 1e-3) return null;
  const nu    = ((Math.atan2(p.y, p.x) * DEG) + 360) % 360;
  const incl  = Math.abs(Math.asin(Math.max(-1, Math.min(1, p.z / r))) * DEG);
  const Omega = ((Math.atan2(p.x, -p.y) * DEG) + 360) % 360;
  return {
    a: Math.round(r).toLocaleString('en-US') + ' km',
    e: '~0', i: incl.toFixed(1)+'°',
    Omega: Omega.toFixed(1)+'°', omega: '—', nu: nu.toFixed(1)+'°',
    approx: true,
  };
}
