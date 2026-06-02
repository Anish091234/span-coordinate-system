/* ============================================================
   SPAN — Three.js scene (nested reference frames)
   The view always shows the craft's ACTIVE frame: the camera
   is the ship's situational display.
   ============================================================ */

const Scene = (() => {
  const VIEW_R = 110;          // scene units = bounding SOI radius (planet/moon)
  const K_SOL  = 23.7;         // heliocentric radial compression (sqrt scale)
  const SURF_R = 90;           // scene units = planet radius in surface frame
  const MIN_MARK = 1.5;

  let renderer, labelRenderer, scene, camera, controls, raycaster, pointer;
  let starfield, frameGroup;
  let frameCode = null, scale = 1, mapFn = null, frameMode = 'soi';
  let childObjs = [];          // {code, group, mesh}
  let craft = null;            // {group, mesh, line, tagObj}
  let camTarget = new THREE.Vector3();
  let camGoal = { pos: new THREE.Vector3(), tgt: new THREE.Vector3() };
  let firstFrame = true, transitioning = false;
  let onSelect = () => {};
  let glowTex = null;
  let keyLight, sunLight, ambient;
  const texCache = {};
  let launchTrail = null;

  /* ---------- glow sprite texture ---------- */
  function makeGlow(){
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64,64,0, 64,64,64);
    grd.addColorStop(0,   'rgba(255,255,255,1)');
    grd.addColorStop(0.2, 'rgba(255,255,255,0.6)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1,   'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0,0,128,128);
    return new THREE.CanvasTexture(c);
  }
  function glowSprite(colorHex, size){
    const m = new THREE.SpriteMaterial({ map:glowTex, color:colorHex, transparent:true,
      blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.9 });
    const s = new THREE.Sprite(m); s.scale.set(size,size,1); return s;
  }

  /* ---------- procedural surface textures (value-noise fBm) ---------- */
  function hashN(x,y){ const s=Math.sin(x*127.1+y*311.7)*43758.5453; return s-Math.floor(s); }
  function vnoise(x,y){
    const xi=Math.floor(x), yi=Math.floor(y), xf=x-xi, yf=y-yi;
    const tl=hashN(xi,yi), tr=hashN(xi+1,yi), bl=hashN(xi,yi+1), br=hashN(xi+1,yi+1);
    const u=xf*xf*(3-2*xf), v=yf*yf*(3-2*yf);
    return tl*(1-u)*(1-v)+tr*u*(1-v)+bl*(1-u)*v+br*u*v;
  }
  function fbm(x,y,oct){
    let a=0, amp=0.5, f=1; oct=oct||5;
    for(let i=0;i<oct;i++){ a+=amp*vnoise(x*f,y*f); f*=2; amp*=0.5; }
    return a;
  }
  const RGB = h => ({ r:(h>>16)&255, g:(h>>8)&255, b:h&255 });
  const mixC = (a,b,t) => ({ r:a.r+(b.r-a.r)*t, g:a.g+(b.g-a.g)*t, b:a.b+(b.b-a.b)*t });
  const sc8 = (c,f) => ({ r:Math.min(255,c.r*f), g:Math.min(255,c.g*f), b:Math.min(255,c.b*f) });

  function makeBodyTexture(code){
    if (texCache[code]) return texCache[code];
    const b = BODIES[code], W=512, H=256;
    const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
    const ctx = cv.getContext('2d'); const img = ctx.createImageData(W,H); const d = img.data;
    const base = RGB(b.color), dark = sc8(base,0.5), light = sc8(base,1.35);
    const gas = (b.kind==='planet' && ['JUP','SAT','URA','NEP'].includes(code));
    const nb = { JUP:13, SAT:10, URA:6, NEP:7 }[code] || 9;
    for (let j=0;j<H;j++){
      const lat = (0.5 - j/H) * Math.PI, latDeg = lat*180/Math.PI;
      for (let i=0;i<W;i++){
        const u = i/W, vv = j/H; let c;
        if (b.kind==='star'){
          const t = fbm(u*10, vv*10, 5);
          const gran = Math.pow(t,1.4);
          c = mixC({r:255,g:120,b:25}, {r:255,g:248,b:210}, Math.min(1,gran*1.3));
        } else if (gas){
          let band = Math.sin(lat*nb + (fbm(u*5, vv*nb*0.6, 4)-0.5)*3.0);
          let t = 0.5 + 0.5*band; t += (fbm(u*9+3, vv*9, 4)-0.5)*0.12;
          t = Math.max(0,Math.min(1,t));
          c = mixC(dark, light, t);
        } else if (code==='TER'){
          const n = fbm(u*5+1, vv*6, 5);
          if (Math.abs(latDeg) > 70 - fbm(u*8,vv*4,3)*12){ c = {r:236,g:242,b:248}; }
          else if (n < 0.48){ c = mixC({r:18,g:54,b:104},{r:36,g:92,b:140}, n*1.4); }
          else { const l=(n-0.48)*1.9; c = mixC({r:58,g:104,b:52},{r:120,g:104,b:64}, Math.min(1,l)); }
        } else if (code==='MAR'){
          const n = fbm(u*6, vv*6, 5);
          if (Math.abs(latDeg) > 80){ c = {r:228,g:228,b:230}; }
          else c = mixC({r:120,g:52,b:34},{r:188,g:112,b:78}, n);
        } else if (code==='VEN'){
          const n = fbm(u*4, vv*4, 4);
          c = mixC({r:196,g:166,b:104},{r:236,g:214,b:166}, 0.3+n*0.5);
        } else if (code==='MER'){
          const n = fbm(u*7, vv*7, 5), cr = fbm(u*18+9, vv*18, 3);
          c = mixC({r:64,g:60,b:56},{r:150,g:144,b:134}, n);
          if (cr>0.72) c = sc8(c,0.7);
        } else { // moons — grey, mottled maria
          const n = fbm(u*7, vv*7, 5), m = fbm(u*3+4, vv*3, 4);
          c = mixC(dark, light, n*0.7+0.15);
          if (m<0.4) c = sc8(c,0.78);
        }
        const k=(j*W+i)*4; d[k]=c.r; d[k+1]=c.g; d[k+2]=c.b; d[k+3]=255;
      }
    }
    ctx.putImageData(img,0,0);
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    texCache[code] = tex; return tex;
  }

  const ATMO = { TER:0x6fb7ff, VEN:0xf2e2b0, MAR:0xe0a684, JUP:0xe6c89a, SAT:0xe8dcb4, URA:0xbfeef0, NEP:0x8fa6ff };

  // Build a realistic body: lit textured sphere + atmosphere limb glow (+ rings/corona)
  function makeBodyMesh(code, R, isStar){
    const b = BODIES[code]; const grp = new THREE.Group();
    const tex = makeBodyTexture(code);
    const geo = new THREE.SphereGeometry(R, 56, 36);
    let mat;
    if (isStar){
      mat = new THREE.MeshBasicMaterial({ map:tex });
    } else {
      mat = new THREE.MeshStandardMaterial({ map:tex, roughness:0.94, metalness:0.0,
        emissive:b.color, emissiveIntensity:0.05 });
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.y = (hashN(R, b.radiusKm)*Math.PI*2);
    mesh.rotation.z = (b.kind==='planet' ? (hashN(code.length,R)-0.5)*0.5 : 0);
    grp.add(mesh);

    if (isStar){
      grp.add(new THREE.Mesh(new THREE.SphereGeometry(R*1.18, 32, 24),
        new THREE.MeshBasicMaterial({ color:0xffd27a, transparent:true, opacity:0.18,
          side:THREE.BackSide, blending:THREE.AdditiveBlending, depthWrite:false })));
      grp.add(glowSprite(0xffdf95, R*6));
      grp.add(glowSprite(0xffb347, R*9.5));
    } else {
      const atmo = ATMO[code] || sc8(RGB(b.color),1.5);
      grp.add(new THREE.Mesh(new THREE.SphereGeometry(R*1.035, 40, 28),
        new THREE.MeshBasicMaterial({ color:atmo, transparent:true, opacity:0.16,
          side:THREE.BackSide, blending:THREE.AdditiveBlending, depthWrite:false })));
      if (b.rings){
        const rt = ringTexture(b.color);
        for (let i=0;i<1;i++){
          const ring = new THREE.Mesh(new THREE.RingGeometry(R*1.35, R*2.25, 96, 1),
            new THREE.MeshBasicMaterial({ map:rt, color:0xffffff, transparent:true,
              opacity:0.9, side:THREE.DoubleSide, depthWrite:false }));
          // remap UVs so the texture runs radially
          const pos = ring.geometry.attributes.position, uv = ring.geometry.attributes.uv;
          for (let v=0; v<pos.count; v++){
            const x=pos.getX(v), y=pos.getY(v); const rr=Math.hypot(x,y);
            const t=(rr - R*1.35)/(R*2.25 - R*1.35);
            uv.setXY(v, t, 0.5);
          }
          uv.needsUpdate = true;
          ring.rotation.x = Math.PI/2 - 0.45; grp.add(ring);
        }
      }
    }
    return { grp, mesh };
  }

  function ringTexture(colorHex){
    const cv=document.createElement('canvas'); cv.width=256; cv.height=4; const g=cv.getContext('2d');
    const base=RGB(colorHex);
    for(let i=0;i<256;i++){
      const n=fbm(i*0.08,0,3); const a = (Math.sin(i*0.6)>-0.2? 0.85:0.25) * (0.5+n*0.6);
      const c=sc8(base, 0.7+n*0.6);
      g.fillStyle=`rgba(${c.r|0},${c.g|0},${c.b|0},${Math.min(1,a)})`; g.fillRect(i,0,1,4);
    }
    const t=new THREE.CanvasTexture(cv); return t;
  }

  // lat/long graticule shell for the surface frame
  function graticule(R, hue){
    const grp = new THREE.Group();
    const mat = (op) => new THREE.LineBasicMaterial({ color:hue, transparent:true, opacity:op });
    // parallels
    for (let lat=-60; lat<=60; lat+=30){
      const r = R*Math.cos(lat*Math.PI/180), y = R*Math.sin(lat*Math.PI/180);
      const pts=[]; for(let i=0;i<=96;i++){ const a=i/96*Math.PI*2; pts.push(new THREE.Vector3(Math.cos(a)*r, y, Math.sin(a)*r)); }
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat(lat===0?0.5:0.18)));
    }
    // meridians
    for (let lon=0; lon<360; lon+=30){
      const pts=[]; for(let i=0;i<=72;i++){ const a=(-90+i/72*180)*Math.PI/180;
        const r=R*Math.cos(a); pts.push(new THREE.Vector3(Math.cos(lon*Math.PI/180)*r, R*Math.sin(a), Math.sin(lon*Math.PI/180)*r)); }
      grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat(lon===0?0.42:0.13)));
    }
    return grp;
  }

  /* ---------- world (helio AU) → scene units ---------- */
  function makeMapLinear(code, sc){
    // recompute the focused body's helio position every call → frame stays
    // centred on it while the system orbits (no drift).
    return (helio) => {
      const o = helioAU(code);
      return new THREE.Vector3(
        (helio.x - o.x) * AU_KM * sc,
        (helio.z - o.z) * AU_KM * sc,
        (helio.y - o.y) * AU_KM * sc,
      );
    };
  }
  function makeMap(code){
    const b = BODIES[code];
    if (b.kind === 'star'){
      return (helio) => {
        const r = Math.hypot(helio.x, helio.y, helio.z);
        if (r < 1e-9) return new THREE.Vector3(0,0,0);
        const sr = K_SOL * Math.sqrt(r);
        const k = sr / r;
        return new THREE.Vector3(helio.x*k, helio.z*k, helio.y*k);
      };
    }
    return makeMapLinear(code, VIEW_R / b.soiKm);
  }

  // Aim the sun-light (directional) from the real solar direction for terminator
  // shading in a body/surface frame; or use the central point-light in the SOL view.
  function configureLights(isStar, code){
    if (isStar){
      keyLight.position.set(0,0,0); keyLight.intensity = 2.6; keyLight.color.set(0xfff1d6);
      sunLight.intensity = 0;
      ambient.intensity = 0.34; ambient.color.set(0x6b7390);
    } else {
      const sd = makeMap(code)(helioAU('SOL'));   // direction body → sun
      if (sd.lengthSq() < 1e-6) sd.set(1, 0.25, 0.4);
      sd.normalize();
      sunLight.position.copy(sd.multiplyScalar(800));
      sunLight.target.position.set(0,0,0);
      sunLight.intensity = 1.9; sunLight.color.set(0xfff2dd);
      keyLight.intensity = 0.0;
      ambient.intensity = 0.26; ambient.color.set(0x3f4d68);
    }
  }

  /* ---------- builders ---------- */
  function circlePlane(radius, segs, color, opacity){
    const pts = [];
    for (let i=0;i<=segs;i++){ const a=i/segs*Math.PI*2; pts.push(new THREE.Vector3(Math.cos(a)*radius,0,Math.sin(a)*radius)); }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent:true, opacity }));
  }

  function polarGrid(maxR, hue){
    const grp = new THREE.Group();
    const rings = 5;
    for (let i=1;i<=rings;i++){
      grp.add(circlePlane(maxR*i/rings, 96, hue, i===rings?0.22:0.10));
    }
    const spokes = 12;
    for (let i=0;i<spokes;i++){
      const a = i/spokes*Math.PI*2;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0,0,0), new THREE.Vector3(Math.cos(a)*maxR,0,Math.sin(a)*maxR)]);
      grp.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color:hue, transparent:true, opacity:0.06 })));
    }
    return grp;
  }

  function makeLabel(code, kind, interactive){
    const b = BODIES[code];
    const el = document.createElement('div');
    el.className = 'body-label ' + frameClass(kind);
    el.innerHTML = `<span class="code">${b.code}</span><span class="nm">${b.name}</span>`;
    if (interactive){ el.onclick = (e)=>{ e.stopPropagation(); onSelect(code); }; }
    else el.style.pointerEvents = 'none';
    const obj = new THREE.CSS2DObject(el);
    return obj;
  }

  function soiShell(radius, hue){
    const grp = new THREE.Group();
    const geo = new THREE.SphereGeometry(radius, 40, 24);
    grp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color:hue, transparent:true,
      opacity:0.025, side:THREE.BackSide, depthWrite:false })));
    const wire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(radius, 24, 14)),
      new THREE.LineBasicMaterial({ color:hue, transparent:true, opacity:0.07 }));
    grp.add(wire);
    grp.add(circlePlane(radius, 120, hue, 0.4));        // equatorial highlight
    return grp;
  }

  /* ---------- build a frame ---------- */
  function buildFrame(code){
    frameCode = code; frameMode = 'soi';
    const b = BODIES[code];
    const cls = frameClass(b.kind);
    const hue = ({ sol:0xe6b14d, planet:0x4fc4e6, moon:0xb78cf0 })[cls];

    if (frameGroup){ scene.remove(frameGroup); disposeGroup(frameGroup); }
    frameGroup = new THREE.Group(); scene.add(frameGroup);
    childObjs = []; launchTrail = null;
    mapFn = makeMap(code);

    const isStar = b.kind === 'star';
    configureLights(isStar, code);
    const maxGrid = isStar ? K_SOL*Math.sqrt(31) : VIEW_R*1.18;

    frameGroup.add(polarGrid(maxGrid, hue));

    // SOI shell (planet/moon)
    if (!isStar && isFinite(b.soiKm)) frameGroup.add(soiShell(VIEW_R, hue));

    // origin body — realistic textured sphere
    const oR = isStar ? 6 : Math.max(b.radiusKm * (VIEW_R/b.soiKm), 2.6);
    const body = makeBodyMesh(code, oR, isStar);
    frameGroup.add(body.grp);
    const oLabel = makeLabel(code, b.kind, false);
    oLabel.position.set(0, oR+3, 0); frameGroup.add(oLabel);

    // children
    layoutChildren(code, hue);

    // craft
    buildCraft();

    // camera goal
    const dist = isStar ? maxGrid*1.7 : VIEW_R*2.35;
    camGoal.tgt.set(0,0,0);
    camGoal.pos.set(dist*0.42, dist*0.5, dist*0.78);
    finishBuild();
  }

  function finishBuild(){
    if (firstFrame){                       // snap into place on first build
      camera.position.copy(camGoal.pos);
      camTarget.copy(camGoal.tgt); controls.target.copy(camTarget);
      firstFrame = false;
    } else {
      transitioning = true;                // animate once, then release to user
    }
    renderNow();
  }

  function renderNow(){
    if (renderer){ renderer.render(scene, camera); labelRenderer.render(scene, camera); }
  }

  function layoutChildren(code, parentHue){
    const b = BODIES[code];
    (b.children || []).forEach(childCode => {
      const c = BODIES[childCode];
      const pos = mapFn(helioAU(childCode));
      const orbitR = Math.hypot(pos.x, pos.z) || 0.001;

      // orbit ring
      frameGroup.add(circlePlane(orbitR, 128, parentHue, 0.16));

      const dispR = Math.max(c.radiusKm * (VIEW_R/b.soiKm || 1), 1.4);
      const r = code === 'SOL'
        ? 1.0 + 2.4*Math.sqrt(c.radiusKm/69911)         // log-ish in solar view
        : dispR;
      const body = makeBodyMesh(childCode, r, false);
      const grp = body.grp; grp.position.copy(pos);
      body.mesh.userData.code = childCode;
      grp.add(glowSprite(c.color, r*2.6));
      const lab = makeLabel(childCode, c.kind, true);
      lab.position.set(0, r+2.4, 0); grp.add(lab);

      frameGroup.add(grp);
      childObjs.push({ code:childCode, group:grp, mesh:body.mesh });
    });
  }

  let currentCraftType = 'generic';

  function makeCraftShape(type) {
    const grp = new THREE.Group();
    const blue = 0x9fe6ff;
    if (type === 'dragon') {
      // Crew Dragon: frustum capsule + cylindrical trunk + 2 solar panels
      const capsule = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.5, 2.6, 14),
        new THREE.MeshStandardMaterial({ color:0xdde8f0, metalness:0.55, roughness:0.3, emissive:0x9fe6ff, emissiveIntensity:0.08 }));
      capsule.position.y = 0.8;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 1.8, 14),
        new THREE.MeshStandardMaterial({ color:0x6a7d8e, metalness:0.65, roughness:0.3 }));
      trunk.position.y = -1.2;
      const panMat = new THREE.MeshStandardMaterial({ color:0x11213e, emissive:0x0a1428, emissiveIntensity:0.5, roughness:0.6 });
      for (const sx of [-1, 1]) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.07, 1.0), panMat);
        panel.position.set(sx * 3.1, -1.2, 0); grp.add(panel);
        // panel frame
        const frame = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.12, 1.1),
          new THREE.MeshStandardMaterial({ color:0x8090a0, metalness:0.7, roughness:0.3 }));
        frame.position.set(sx * 3.1, -1.2, 0); grp.add(frame);
      }
      grp.add(capsule); grp.add(trunk);
    } else if (type === 'starship') {
      // Starship: tall steel cylinder + nosecone + 4 flaps
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 7, 14),
        new THREE.MeshStandardMaterial({ color:0xcacad6, metalness:0.88, roughness:0.12, emissive:0x9fe6ff, emissiveIntensity:0.04 }));
      const nose = new THREE.Mesh(new THREE.ConeGeometry(1.1, 3.2, 14),
        new THREE.MeshStandardMaterial({ color:0xd4d4de, metalness:0.88, roughness:0.12 }));
      nose.position.y = 5.1;
      // aft flaps (2 per side at bottom)
      const flapMat = new THREE.MeshStandardMaterial({ color:0xb0b0bc, metalness:0.82, roughness:0.18 });
      for (let i = 0; i < 4; i++) {
        const flap = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.2, 0.9), flapMat);
        const ang = i * Math.PI / 2 + Math.PI / 4;
        flap.position.set(Math.cos(ang)*1.2, -2.8, Math.sin(ang)*1.2);
        grp.add(flap);
      }
      grp.add(body); grp.add(nose);
    } else if (type === 'iss') {
      // ISS: truss backbone + modules + 4 pairs of solar arrays
      const trussMat = new THREE.MeshStandardMaterial({ color:0xb0bbc6, metalness:0.65, roughness:0.35 });
      const truss = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 16, 8), trussMat);
      truss.rotation.z = Math.PI / 2;
      const habMat = new THREE.MeshStandardMaterial({ color:0xd0d8e0, metalness:0.4, roughness:0.5 });
      const hab = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 5.5, 12), habMat);
      hab.rotation.z = Math.PI / 2;
      const panMat = new THREE.MeshStandardMaterial({ color:0x0e1a36, emissive:0x06100e, emissiveIntensity:0.4 });
      const arrayPairs = [[-6, -1.8], [-6, 1.8], [6, -1.8], [6, 1.8]];
      for (const [ax, ay] of arrayPairs) {
        const arr = new THREE.Mesh(new THREE.BoxGeometry(0.07, 5.2, 1.9), panMat);
        arr.position.set(ax, ay, 0); grp.add(arr);
      }
      grp.add(truss); grp.add(hab);
    } else {
      // generic: original octahedron
      const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(2.0),
        new THREE.MeshStandardMaterial({ color:0xffffff, emissive:blue, emissiveIntensity:0.7, metalness:0.3, roughness:0.4 }));
      grp.add(mesh);
    }
    return grp;
  }

  function buildCraft(){
    const grp = new THREE.Group();
    const modelGrp = makeCraftShape(currentCraftType);
    grp.add(modelGrp);
    const mesh = modelGrp; // .rotation.y is applied to the group
    grp.add(glowSprite(0x9fe6ff, 11));
    // halo ring
    const halo = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.6, 40),
      new THREE.MeshBasicMaterial({ color:0x9fe6ff, transparent:true, opacity:0.7, side:THREE.DoubleSide }));
    halo.rotation.x = Math.PI/2; grp.add(halo);
    // leader line to plane
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,0)]);
    const line = new THREE.Line(lineGeo, new THREE.LineDashedMaterial({ color:0x9fe6ff, transparent:true, opacity:0.4, dashSize:2, gapSize:2 }));
    // tag
    const el = document.createElement('div'); el.className = 'craft-tag';
    const tagObj = new THREE.CSS2DObject(el); tagObj.position.set(0, 3.2, 0);
    grp.add(tagObj);

    // ground-track sub-point marker (used in surface frame)
    const sub = new THREE.Group();
    const subDot = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12),
      new THREE.MeshBasicMaterial({ color:0x9fe6ff }));
    const subRing = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.3, 32),
      new THREE.MeshBasicMaterial({ color:0x9fe6ff, transparent:true, opacity:0.7, side:THREE.DoubleSide }));
    sub.add(subDot); sub.add(subRing); sub.visible = false;

    frameGroup.add(grp); frameGroup.add(line); frameGroup.add(sub);
    craft = { group:grp, mesh, line, tagObj, halo, sub, subRing };
  }

  function setCraftModel(type) {
    currentCraftType = type;
    if (!craft) return;
    // remove old model group (first child of craft.group, before glow/halo/tag)
    const old = craft.mesh;
    craft.group.remove(old);
    const modelGrp = makeCraftShape(type);
    craft.group.add(modelGrp);
    craft.mesh = modelGrp;
  }

  /* ---------- build the SURFACE (geodetic) frame ---------- */
  function buildSurface(code){
    frameCode = code; frameMode = 'surface';
    const b = BODIES[code];
    const hue = ({ planet:0x4fc4e6, moon:0xb78cf0 })[b.kind] || 0x4fc4e6;

    if (frameGroup){ scene.remove(frameGroup); disposeGroup(frameGroup); }
    frameGroup = new THREE.Group(); scene.add(frameGroup);
    childObjs = []; launchTrail = null;
    mapFn = makeMapLinear(code, SURF_R / b.radiusKm);
    configureLights(false, code);

    // big textured planet + atmosphere
    const body = makeBodyMesh(code, SURF_R, false);
    frameGroup.add(body.grp);
    // graticule overlay
    frameGroup.add(graticule(SURF_R*1.002, hue));

    const oLabel = makeLabel(code, b.kind, false);
    oLabel.position.set(0, SURF_R*1.18, 0); frameGroup.add(oLabel);

    buildCraft();
    craft.halo.scale.set(0.5,0.5,0.5);

    // camera: pulled close to the surface, craft above the limb
    camGoal.tgt.set(0,0,0);
    camGoal.pos.set(SURF_R*1.5, SURF_R*1.15, SURF_R*1.9);
    finishBuild();
  }

  /* ---------- per-frame position refresh (orbit motion + craft) ---------- */
  function refresh(state){
    if (!mapFn) return;
    childObjs.forEach(o => { o.group.position.copy(mapFn(helioAU(o.code))); });
    if (!craft) return;
    const p = mapFn(craftHelioAU(state));
    craft.group.position.copy(p);

    if (frameMode === 'surface'){
      // sub-point on the surface directly beneath the craft
      const dir = p.clone().normalize();
      const surf = dir.multiplyScalar(SURF_R);
      craft.sub.visible = true; craft.sub.position.copy(surf);
      craft.sub.lookAt(0,0,0); craft.subRing.lookAt && null;
      craft.subRing.quaternion.copy(craft.sub.quaternion);
      const pos = craft.line.geometry.attributes.position;
      pos.setXYZ(0, p.x, p.y, p.z); pos.setXYZ(1, surf.x, surf.y, surf.z); pos.needsUpdate = true;
      craft.line.computeLineDistances();
      craft.tagObj.element.innerHTML = `<span class="ac">${state.body}</span> · ${geodeticCompact(state)}`;
    } else {
      craft.sub.visible = false;
      const pos = craft.line.geometry.attributes.position;
      pos.setXYZ(0, p.x, p.y, p.z); pos.setXYZ(1, p.x, 0, p.z); pos.needsUpdate = true;
      craft.line.computeLineDistances();
      const r = resolveInFrame(state, frameCode);
      craft.tagObj.element.innerHTML = `<span class="ac">${state.body}</span> · ${r.compact}`;
    }
  }

  /* ---------- launch / ascent trajectory FX ---------- */
  function startLaunch(){
    const group = new THREE.Group(); frameGroup.add(group);
    const plume = glowSprite(0xffb874, 8); plume.visible = false; group.add(plume);
    launchTrail = { pts:[], mesh:null, plume, group };
  }
  function stepLaunch(thrust){
    if (!launchTrail || !_state || !mapFn) return;
    const p = mapFn(craftHelioAU(_state));
    const pts = launchTrail.pts;
    const added = (!pts.length || pts[pts.length-1].distanceTo(p) > 0.3);
    if (added) pts.push(p.clone());
    if (added && pts.length > 2){
      if (launchTrail.mesh){ launchTrail.group.remove(launchTrail.mesh); launchTrail.mesh.geometry.dispose(); launchTrail.mesh.material.dispose(); }
      const curve = new THREE.CatmullRomCurve3(pts);
      const seg = Math.min(180, pts.length*3), rad = 8;
      const geo = new THREE.TubeGeometry(curve, seg, 0.75, rad, false);
      const cnt = geo.attributes.position.count, colors = new Float32Array(cnt*3);
      const c0 = new THREE.Color(0x1f4a8f), c1 = new THREE.Color(0xeafaff), tmp = new THREE.Color();
      for (let i=0;i<=seg;i++){ const f=i/seg; tmp.copy(c0).lerp(c1, f*f);
        for (let j=0;j<=rad;j++){ const idx=(i*(rad+1)+j)*3; colors[idx]=tmp.r; colors[idx+1]=tmp.g; colors[idx+2]=tmp.b; } }
      geo.setAttribute('color', new THREE.BufferAttribute(colors,3));
      const mat = new THREE.MeshBasicMaterial({ vertexColors:true, transparent:true, opacity:0.92,
        blending:THREE.AdditiveBlending, depthWrite:false });
      launchTrail.mesh = new THREE.Mesh(geo, mat); launchTrail.group.add(launchTrail.mesh);
    }
    if (pts.length >= 2){
      const v = p.clone().sub(pts[pts.length-2]);
      const size = 3 + thrust*17;
      launchTrail.plume.visible = thrust > 0.02;
      if (v.lengthSq()>1e-6){ v.normalize(); launchTrail.plume.position.copy(p).addScaledVector(v, -size*0.45); }
      else launchTrail.plume.position.copy(p);
      launchTrail.plume.scale.set(size,size,1);
      launchTrail.plume.material.opacity = 0.45 + 0.4*thrust;
    }
  }
  function stopLaunchVisual(){ if (launchTrail && launchTrail.plume) launchTrail.plume.visible = false; }

  function focusLaunch(){
    if (!_state || !mapFn) return;
    const p = mapFn(craftHelioAU(_state));
    const dir = p.clone().normalize();
    const up = new THREE.Vector3(0,1,0);
    let tang = new THREE.Vector3().crossVectors(dir, up); if (tang.lengthSq()<1e-4) tang.set(1,0,0); tang.normalize();
    camGoal.tgt.copy(dir.clone().multiplyScalar(SURF_R*0.9));
    camGoal.pos.copy(dir.clone().multiplyScalar(SURF_R*1.05)
      .addScaledVector(tang, SURF_R*1.7).addScaledVector(up, SURF_R*0.55));
    transitioning = true;
  }

  /* ---------- raycast click → transfer to body ---------- */
  function onClick(ev){
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX-rect.left)/rect.width)*2 - 1;
    pointer.y = -((ev.clientY-rect.top)/rect.height)*2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const meshes = childObjs.map(o=>o.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (hit && hit.object.userData.code) onSelect(hit.object.userData.code);
  }

  function disposeGroup(g){
    g.traverse(o => {
      if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
      if (o.geometry) o.geometry.dispose();
      if (o.material){ const m=o.material; (Array.isArray(m)?m:[m]).forEach(x=>x.dispose()); }
    });
  }

  /* ---------- public init ---------- */
  function init(canvasEl, labelEl){
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x05070d, 0.0008);
    glowTex = makeGlow();

    camera = new THREE.PerspectiveCamera(48, window.innerWidth/window.innerHeight, 0.1, 6000);
    camera.position.set(120,150,240);

    renderer = new THREE.WebGLRenderer({ canvas:canvasEl, antialias:true, alpha:true });
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    renderer.setSize(window.innerWidth, window.innerHeight);

    labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position='absolute';
    labelRenderer.domElement.style.top='0'; labelRenderer.domElement.style.left='0';
    labelRenderer.domElement.style.pointerEvents='none';
    labelEl.appendChild(labelRenderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.6; controls.minDistance = 12; controls.maxDistance = 1400;
    controls.enablePan = false;

    scene.add(ambient = new THREE.AmbientLight(0x5a6b8a, 0.34));
    keyLight = new THREE.PointLight(0xffffff, 2.4, 0, 1.2); keyLight.position.set(0,0,0); scene.add(keyLight);
    sunLight = new THREE.DirectionalLight(0xfff2dd, 0); sunLight.position.set(1,0.5,1); scene.add(sunLight); scene.add(sunLight.target);

    starfield = makeStars(); scene.add(starfield);

    raycaster = new THREE.Raycaster(); raycaster.params.Points = { threshold:2 };
    pointer = new THREE.Vector2();
    renderer.domElement.addEventListener('click', onClick);
    window.addEventListener('resize', onResize);
    camGoal.pos.copy(camera.position);
  }

  function makeStars(){
    const n = 2600, pos = new Float32Array(n*3);
    for (let i=0;i<n;i++){
      const r = 1800 + Math.random()*2200;
      const t = Math.random()*Math.PI*2, ph = Math.acos(2*Math.random()-1);
      pos[i*3]=r*Math.sin(ph)*Math.cos(t); pos[i*3+1]=r*Math.cos(ph); pos[i*3+2]=r*Math.sin(ph)*Math.sin(t);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos,3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color:0xaecbe6, size:1.6, sizeAttenuation:false, transparent:true, opacity:0.7 }));
  }

  function onResize(){
    camera.aspect = window.innerWidth/window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  }

  let _state = null;
  function tick(){
    requestAnimationFrame(tick);
    // ease camera toward goal ONLY during a frame transition; then let the user drive
    if (transitioning){
      camera.position.lerp(camGoal.pos, 0.08);
      camTarget.lerp(camGoal.tgt, 0.12); controls.target.copy(camTarget);
      if (camera.position.distanceTo(camGoal.pos) < 0.6 && camTarget.distanceTo(camGoal.tgt) < 0.6){
        camera.position.copy(camGoal.pos); controls.target.copy(camGoal.tgt);
        transitioning = false;
      }
    }
    if (craft){ craft.mesh.rotation.y += 0.01; craft.halo.lookAt(camera.position); }
    controls.update();
    if (_state) refresh(_state);
    renderNow();
  }

  return {
    init, buildFrame, buildSurface,
    setState(s){ _state = s; },
    refresh,
    startLaunch, stepLaunch, stopLaunchVisual, focusLaunch,
    onSelect(fn){ onSelect = fn; },
    start(){ tick(); },
    setCraftModel,
    get frameCode(){ return frameCode; },
    get frameMode(){ return frameMode; },
  };
})();
