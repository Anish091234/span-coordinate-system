/* ============================================================
   SPAN — solar-system data model
   Distances/radii approximate; SOI radii ~ a(m/M)^(2/5).
   Values are illustrative (educational), not navigation-grade.
   ============================================================ */

const AU_KM = 149597870.7;

// kind: star | planet | moon
// planets: aAU (semi-major axis, AU), periodYr, theta0 (deg start longitude)
// moons:   aKm (orbit radius around parent), periodDay, theta0
// all:     radiusKm, soiKm (sphere of influence; star = Infinity), color
const BODIES = {
  SOL: { code:'SOL', name:'Sun',     kind:'star',   radiusKm:696340, soiKm:Infinity, color:0xffcf6b,
         children:['MER','VEN','TER','MAR','JUP','SAT','URA','NEP'] },

  MER: { code:'MER', name:'Mercury', kind:'planet', parent:'SOL', aAU:0.387, periodYr:0.241, theta0:25,  radiusKm:2440,  soiKm:112000,   color:0x9c9286, children:[] },
  VEN: { code:'VEN', name:'Venus',   kind:'planet', parent:'SOL', aAU:0.723, periodYr:0.615, theta0:140, radiusKm:6052,  soiKm:616000,   color:0xd9b97a, children:[] },
  TER: { code:'TER', name:'Terra',   kind:'planet', parent:'SOL', aAU:1.000, periodYr:1.000, theta0:255, radiusKm:6371,  soiKm:924000,   color:0x5b8fd1, children:['LUN'] },
  MAR: { code:'MAR', name:'Mars',    kind:'planet', parent:'SOL', aAU:1.524, periodYr:1.881, theta0:300, radiusKm:3390,  soiKm:576000,   color:0xc1654a, children:['PHO','DEI'] },
  JUP: { code:'JUP', name:'Jupiter', kind:'planet', parent:'SOL', aAU:5.203, periodYr:11.86, theta0:65,  radiusKm:69911, soiKm:48200000, color:0xd8a878, children:['IO_','EUR','GAN','CAL'] },
  SAT: { code:'SAT', name:'Saturn',  kind:'planet', parent:'SOL', aAU:9.537, periodYr:29.45, theta0:155, radiusKm:58232, soiKm:54800000, color:0xd8c89a, children:['TIT'], rings:true },
  URA: { code:'URA', name:'Uranus',  kind:'planet', parent:'SOL', aAU:19.19, periodYr:84.0,  theta0:210, radiusKm:25362, soiKm:51800000, color:0x9fd4d8, children:[] },
  NEP: { code:'NEP', name:'Neptune', kind:'planet', parent:'SOL', aAU:30.07, periodYr:164.8, theta0:340, radiusKm:24622, soiKm:86800000, color:0x5a78d8, children:['TRI'] },

  LUN: { code:'LUN', name:'Luna',     kind:'moon', parent:'TER', aKm:384400,  periodDay:27.3,  theta0:40,  radiusKm:1737, soiKm:66100,  color:0xc2c5cc },
  PHO: { code:'PHO', name:'Phobos',   kind:'moon', parent:'MAR', aKm:9376,    periodDay:0.319, theta0:80,  radiusKm:11,   soiKm:170,    color:0x8a7d70 },
  DEI: { code:'DEI', name:'Deimos',   kind:'moon', parent:'MAR', aKm:23463,   periodDay:1.263, theta0:230, radiusKm:6,    soiKm:120,    color:0x9a8d80 },
  IO_: { code:'IO',  name:'Io',       kind:'moon', parent:'JUP', aKm:421700,  periodDay:1.769, theta0:10,  radiusKm:1821, soiKm:7836,   color:0xe6d27a },
  EUR: { code:'EUR', name:'Europa',   kind:'moon', parent:'JUP', aKm:671034,  periodDay:3.551, theta0:110, radiusKm:1561, soiKm:9723,   color:0xcfc3a8 },
  GAN: { code:'GAN', name:'Ganymede', kind:'moon', parent:'JUP', aKm:1070412, periodDay:7.155, theta0:200, radiusKm:2634, soiKm:31900,  color:0xa89c8e },
  CAL: { code:'CAL', name:'Callisto', kind:'moon', parent:'JUP', aKm:1882709, periodDay:16.69, theta0:300, radiusKm:2410, soiKm:37700,  color:0x807468 },
  TIT: { code:'TIT', name:'Titan',    kind:'moon', parent:'SAT', aKm:1221870, periodDay:15.95, theta0:60,  radiusKm:2575, soiKm:161000, color:0xd6a85a },
  TRI: { code:'TRI', name:'Triton',   kind:'moon', parent:'NEP', aKm:354759,  periodDay:5.877, theta0:150, radiusKm:1353, soiKm:12000,  color:0xc7d2d6 },
};

// Coordinate scheme per frame kind
const SCHEME = {
  star:   { type:'ecliptic', tag:'Ecliptic spherical', unit:'AU',
            fields:['λ','β','r'], desc:'Heliocentric — angular position on the ecliptic plus range in AU.' },
  planet: { type:'spherical', tag:'Body-centred spherical', unit:'km',
            fields:['r','Az','El'], desc:'Range plus two bearing angles from the body centre. Display convention — operational rendezvous (Dragon, for example) uses LVLH (Local Vertical Local Horizontal), not Az/El.' },
  moon:   { type:'cartesian', tag:'Local Cartesian', unit:'km',
            fields:['X','Y','Z'], desc:'Right-handed metres-scale grid — precision for proximity & landing.' },
};

function frameClass(kind){ return kind === 'star' ? 'sol' : kind; }
