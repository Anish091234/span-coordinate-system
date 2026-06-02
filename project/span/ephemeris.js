/* ============================================================
   SPAN — NASA JPL Horizons API real ephemeris integration
   Pulls heliocentric Keplerian elements for planets + Moon.
   Endpoint: https://ssd.jpl.nasa.gov/api/horizons.api
   (free, public REST API with CORS support)
   ============================================================ */

const HORIZONS_CONFIG = {
  MER: { id: '199', center: '500@10' },
  VEN: { id: '299', center: '500@10' },
  TER: { id: '399', center: '500@10' },
  MAR: { id: '499', center: '500@10' },
  JUP: { id: '599', center: '500@10' },
  SAT: { id: '699', center: '500@10' },
  URA: { id: '799', center: '500@10' },
  NEP: { id: '899', center: '500@10' },
  LUN: { id: '301', center: '500@399' },  // geocentric — relative to Earth
};

// Real Keplerian elements keyed by body code, populated on load
const REAL_ELEMENTS = {};

// 'pending' | 'loading' | 'loaded' | 'partial' | 'failed'
let ephemerisStatus = 'pending';

function toJD(date) {
  return date.getTime() / 86400000.0 + 2440587.5;
}

// Parse Keplerian elements from Horizons plain-text ELEMENTS output
// Expected keys between $$SOE..$$EOE: EC, IN, OM, W, TA, A
function parseHorizonsElements(text) {
  const soe = text.indexOf('$$SOE');
  const eoe = text.indexOf('$$EOE');
  if (soe < 0 || eoe < 0) return null;
  const block = text.slice(soe + 5, eoe);

  // \b word-boundary guards prevent 'A' matching 'AD', 'W' matching 'Tp', etc.
  const get = key => {
    const m = block.match(new RegExp('\\b' + key + '\\b\\s*=\\s*([+-]?[\\d.]+(?:[Ee][+-]?\\d+)?)'));
    return m ? parseFloat(m[1]) : null;
  };

  const a = get('A'), e = get('EC'), i = get('IN');
  const Omega = get('OM'), omega = get('W'), nu = get('TA');
  if (a == null || e == null) return null;

  return { a, e, i: i ?? 0, Omega: Omega ?? 0, omega: omega ?? 0, nu: nu ?? 0 };
}

// Keplerian elements (angles in degrees) → ecliptic Cartesian position (AU)
// Rotation sequence: R_z(Ω) · R_x(i) · R_z(ω) — standard J2000 ICRF convention
function elementsToXYZ({ a, e, i, Omega, omega, nu }) {
  const D = Math.PI / 180;
  const r = a * (1 - e * e) / (1 + e * Math.cos(nu * D));
  const xO = r * Math.cos(nu * D);
  const yO = r * Math.sin(nu * D);

  const cO = Math.cos(Omega * D), sO = Math.sin(Omega * D);
  const cw = Math.cos(omega * D), sw = Math.sin(omega * D);
  const cI = Math.cos(i * D),     sI = Math.sin(i * D);

  return {
    x: (cO*cw - sO*sw*cI)*xO + (-cO*sw - sO*cw*cI)*yO,
    y: (sO*cw + cO*sw*cI)*xO + (-sO*sw + cO*cw*cI)*yO,
    z: (sw*sI)*xO             + (cw*sI)*yO,
  };
}

async function fetchBodyElements(id, center, jd) {
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: id,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'ELEMENTS',
    CENTER: center,
    TLIST: jd.toFixed(5),
    OUT_UNITS: 'AU-D',
  });
  const opts = AbortSignal.timeout
    ? { signal: AbortSignal.timeout(15000) }
    : {};
  const resp = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${params}`, opts);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return parseHorizonsElements(json.result || '');
}

// Fetch ephemeris for all bodies in parallel.
// Updates BODIES[code].theta with real ecliptic angles; populates REAL_ELEMENTS.
// onProgress(loaded, total) called incrementally.
async function fetchAllEphemeris(onProgress) {
  ephemerisStatus = 'loading';
  const jd = toJD(new Date());
  const entries = Object.entries(HORIZONS_CONFIG);
  let loaded = 0;

  await Promise.all(entries.map(async ([code, { id, center }]) => {
    try {
      const elems = await fetchBodyElements(id, center, jd);
      if (!elems) return;

      REAL_ELEMENTS[code] = elems;
      const b = BODIES[code];
      if (!b) return;

      if (code === 'LUN') {
        // Geocentric Moon: argument of latitude = ω + ν gives orbit angle
        const angleDeg = ((elems.omega + elems.nu) % 360 + 360) % 360;
        b.theta = angleDeg * Math.PI / 180;
      } else {
        // Planet: convert elements → ecliptic XYZ, extract heliocentric longitude
        const pos = elementsToXYZ(elems);
        b.theta = Math.atan2(pos.y, pos.x);
        if (b.theta < 0) b.theta += 2 * Math.PI;
        b.aAU = elems.a;  // update semi-major axis to real value
      }
      b.theta0_real = b.theta;
      loaded++;
      if (onProgress) onProgress(loaded, entries.length);
    } catch (err) {
      console.warn(`Horizons [${code}]: ${err.message}`);
    }
  }));

  ephemerisStatus = loaded >= 5 ? 'loaded' : loaded > 0 ? 'partial' : 'failed';
  return loaded;
}
