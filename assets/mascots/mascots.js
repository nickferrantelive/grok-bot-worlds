// The grok bot mascots at runtime. No imports: pass your three.js module in.
//
//   import * as THREE from 'three';
//   import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
//   import { createMascot } from './assets/mascots/mascots.js';
//
//   const gltf = await new GLTFLoader().loadAsync('assets/mascots/mascots.glb');
//   const bot = createMascot(THREE, gltf, { shape: 'star', color: '#fb7f16', size: 0.8, camera });
//   scene.add(bot.object);                       // bot.object.position is the ground point
//   bot.setState('working');
//   bot.setState('found', { value: 0.8, onPeak() { island.flare(); } });
//   bot.setState('done');                        // carries a glowing orb until the next state
//   bot.setState('needs_approval');              // marker stays up until a later 'done'
//   bot.hopTo(new THREE.Vector3(3, 0, 1), () => bot.setState('idle'));
//   // in your frame loop:
//   bot.update(dt);
//
// Bots have no legs. Everything is a hop with squash and stretch on one small physics step, so
// states blend into each other instead of cutting. Same seed and same dt sequence, same motion.

export const MASCOT_SHAPES = ['sphere', 'cloud', 'triangle', 'star', 'star4', 'squircle', 'pentagon', 'drop', 'hexagon', 'capsule'];
export const MASCOT_STATES = ['idle', 'working', 'found', 'done', 'needs_approval'];
export const MASCOT_PALETTE = {
  lead: '#f2f3f7', sphere: '#f6a01e', cloud: '#f53a9e', triangle: '#43cf8f', star: '#fb7f16', star4: '#f46510',
  squircle: '#fba42a', pentagon: '#2f74ee', drop: '#8a56ea', hexagon: '#17b8a3', capsule: '#f4323f',
};

// A stable shape for the nth bot on a team of any size. The lead is always the sphere.
export function mascotShapeFor(index, isLead = false) {
  if (isLead) return 'sphere';
  const order = ['cloud', 'triangle', 'star', 'squircle', 'pentagon', 'drop', 'hexagon', 'capsule', 'star4', 'sphere'];
  return order[((index % order.length) + order.length) % order.length];
}

const STEP = 1 / 120;
const GRAVITY = 26;           // sizes per second squared
const SQUASH_K = 210;
const SQUASH_C = 13;
const TAU = Math.PI * 2;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const damp = (cur, target, rate, h) => cur + (target - cur) * (1 - Math.exp(-rate * h));

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `value` on an event can be 0 to 1 or any larger count or amount. Large numbers compress: 10 is
// about a quarter, 1000 is about three quarters, 10000 and up is the full effect.
export function normalizeFoundValue(value) {
  if (value === undefined || value === null || Number.isNaN(+value)) return 0.5;
  const v = Math.abs(+value);
  return v <= 1 ? v : clamp(Math.log10(v + 1) / 4, 0.1, 1);
}

// Shared textures and geometry per three.js module
const SHARED = new WeakMap();
function shared(THREE) {
  let s = SHARED.get(THREE);
  if (s) return s;
  const radial = (stops, size = 128) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [t, col] of stops) r.addColorStop(t, col);
    g.fillStyle = r;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  s = {
    shadowTex: radial([[0, 'rgba(0,0,0,.62)'], [0.42, 'rgba(0,0,0,.42)'], [0.72, 'rgba(0,0,0,.12)'], [1, 'rgba(0,0,0,0)']]),
    glowTex: radial([[0, 'rgba(255,255,255,1)'], [0.16, 'rgba(255,255,255,.72)'], [0.42, 'rgba(255,255,255,.2)'], [1, 'rgba(255,255,255,0)']]),
    shadowGeo: new THREE.PlaneGeometry(1, 1),
    orbGeo: new THREE.SphereGeometry(0.15, 24, 16),
    barGeo: new THREE.CapsuleGeometry(0.058, 0.17, 6, 14),
    dotGeo: new THREE.SphereGeometry(0.068, 16, 12),
  };
  SHARED.set(THREE, s);
  return s;
}

// A small procedural studio: a sky to ground gradient and four soft lamps, in HDR, with no hard
// edge for the coat to mirror. Every bot uses it by default, so the gloss holds on an island with
// no environment. Pass `envMap: null` to createMascot to use scene.environment instead.
export function createMascotEnvironment(THREE) {
  const s = shared(THREE);
  if (s.env) return s.env;
  const W = 256, H = 128;
  const data = new Uint16Array(W * H * 4);
  const lamps = [
    // azimuth, elevation (degrees, three.js equirect), width, height, strength
    [138, 39, 26, 18, 3.6],    // broad top left key
    [164, 6, 6, 36, 3.6],      // long left strip, the bright line down the edge
    [7, 23, 8, 28, 1.8],       // right rim
    [-79, 74, 70, 10, 1.6],    // top bar
    [90, -12, 70, 26, 0.55],   // low front fill, so the underside keeps its colour
  ];
  const half = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < H; j++) {
    const el = ((j + 0.5) / H - 0.5) * 180;
    const t = (el + 90) / 180;
    const sky = 0.07 + 0.18 * t * t;
    for (let i = 0; i < W; i++) {
      const az = ((i + 0.5) / W - 0.5) * 360;
      let v = sky;
      for (const [a0, e0, wa, he, k] of lamps) {
        const da = ((az - a0 + 540) % 360) - 180;
        const de = el - e0;
        v += k * Math.exp(-(da * da) / (2 * wa * wa) - (de * de) / (2 * he * he));
      }
      const q = (j * W + i) * 4;
      const warm = half(v * 1.0), cool = half(v * 0.985);
      data[q] = warm;
      data[q + 1] = warm;
      data[q + 2] = cool;
      data[q + 3] = half(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  s.env = tex;
  return tex;
}

export function createMascot(THREE, gltf, options = {}) {
  let shape = options.shape || 'sphere';
  const root = gltf.scene || gltf;
  let source = root.getObjectByName('shape_' + shape);
  if (!source) {
    console.warn(`mascots: unknown shape "${shape}", using sphere`);
    shape = 'sphere';
    source = root.getObjectByName('shape_sphere');
  }
  const S = shared(THREE);
  const info = source.userData || {};
  const H = info.height || 1;
  const CENTER = info.centerUp || H / 2;
  const EYE_BIAS = -clamp(((info.eyeCenter && info.eyeCenter[0]) || 0) * 0.6, -0.18, 0.18);
  const rand = rng(options.seed !== undefined ? options.seed : hashSeed(shape + (options.color || '')));

  // ---------- rig ----------
  const object = new THREE.Group();
  object.name = 'mascot_' + shape;
  const size = options.size === undefined ? 1 : options.size;
  object.scale.setScalar(size);
  const yawGroup = new THREE.Group();
  const hopGroup = new THREE.Group();
  const squashGroup = new THREE.Group();
  const tiltGroup = new THREE.Group();
  object.add(yawGroup);
  yawGroup.add(hopGroup);
  hopGroup.add(squashGroup);
  squashGroup.add(tiltGroup);
  tiltGroup.position.y = CENTER;      // tilt and roll turn about the middle of the body

  const bodyMesh = new THREE.Mesh(source.geometry, source.material.clone());
  bodyMesh.scale.copy(source.scale);
  bodyMesh.position.y = -CENTER;
  bodyMesh.castShadow = options.castShadow !== false;
  bodyMesh.receiveShadow = false;
  tiltGroup.add(bodyMesh);
  const material = bodyMesh.material;
  const eyeSource = source.children.find((c) => c.isMesh) || source.children[0];
  // A dark soft sheen only. A mirror finish reflects the sky and punches white holes in the eyes at small sizes.
  const eyeMaterial = eyeSource.material.clone();
  eyeMaterial.envMapIntensity = 0.3;
  const eyes = new THREE.Mesh(eyeSource.geometry, eyeMaterial);
  eyes.position.copy(eyeSource.position);
  eyes.quaternion.copy(eyeSource.quaternion);
  bodyMesh.add(eyes);
  const eyeHome = eyes.position.clone();

  // Calm bots work in place: a steady rhythm of leaning into the job, never a hop. Islands drive this one.
  // They also stand inside a Cycles frame, so they take the render's own bot material: saturation 1.35, roughness 0.3,
  // a sharp coat, and a little glow standing in for the light that subsurface scattering carries into the shadow side.
  const calm = options.calm === true;
  const color = new THREE.Color(options.color || MASCOT_PALETTE[shape] || '#ffffff');
  const glowAmount = options.glow === undefined ? (calm ? 0.07 : 0.1) : options.glow;
  // Filmic tone mapping pulls strong colour towards pastel, so push it a little past the config value.
  const vivid = options.vivid === undefined ? (calm ? 1.35 : 1.22) : options.vivid;
  if (calm) {
    material.roughness = 0.3;
    if (material.isMeshPhysicalMaterial) {
      material.clearcoat = 1;
      material.clearcoatRoughness = 0.07;
    }
  }
  function applyColor() {
    const top = Math.max(color.r, color.g, color.b, 1e-4);
    material.color.setRGB(top * (color.r / top) ** vivid, top * (color.g / top) ** vivid, top * (color.b / top) ** vivid);
    if (material.emissive) {
      material.emissive.copy(material.color);
      material.emissiveIntensity = glowAmount;
    }
  }
  applyColor();
  const envMap = options.envMap === undefined ? createMascotEnvironment(THREE) : options.envMap;
  if (envMap) { material.envMap = envMap; eyeMaterial.envMap = envMap; }
  material.envMapIntensity = options.envMapIntensity === undefined ? 0.85 : options.envMapIntensity;

  // Contact shadow: stays on the ground and softens as the bot leaves it. Sells a hop at 50 px.
  let shadow = null;
  let shadowAimed = false;
  const shadowLean = new THREE.Vector3();
  if (options.contactShadow !== false) {
    shadow = new THREE.Mesh(S.shadowGeo, new THREE.MeshBasicMaterial({ map: S.shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.008;
    // On a plate the ground is a depth map, a little bumpy, and it would swallow a shadow lying flat on it.
    if (calm) shadow.material.depthTest = false;
    shadow.renderOrder = 1;
    object.add(shadow);
  }

  // The orb and the marker ride above the head on their own spring, built when first needed.
  const carry = new THREE.Group();
  carry.position.y = H;
  carry.visible = !calm;      // A calm bot speaks through its bubble, so nothing floats over its head.
  hopGroup.add(carry);
  let orb = null, orbGlow = null, orbMat = null, orbGlowMat = null;
  let marker = null, markerGlow = null, markerMat = null, markerGlowMat = null;
  const glowColor = new THREE.Color();
  const WHITE = new THREE.Color(1, 1, 1);
  function refreshOrbColor() {
    if (!orbMat) return;
    glowColor.copy(color).lerp(WHITE, 0.14);
    orbMat.color.copy(glowColor).multiplyScalar(options.orbBoost === undefined ? 1.25 : options.orbBoost);
    orbGlowMat.color.copy(color).lerp(WHITE, 0.3);
  }
  function ensureOrb() {
    if (orb) return;
    orbMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    orb = new THREE.Mesh(S.orbGeo, orbMat);
    orbGlowMat = new THREE.SpriteMaterial({ map: S.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.85 });
    orbGlow = new THREE.Sprite(orbGlowMat);
    orbGlow.scale.setScalar(0.92);
    orb.add(orbGlow);
    orb.scale.setScalar(0.001);
    carry.add(orb);
    refreshOrbColor();
  }
  function ensureMarker() {
    if (marker) return;
    const tint = new THREE.Color(options.markerColor || '#ffae00');
    markerMat = new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 0.8, roughness: 0.35 });
    marker = new THREE.Group();
    const bar = new THREE.Mesh(S.barGeo, markerMat);
    bar.position.y = 0.31;
    const dot = new THREE.Mesh(S.dotGeo, markerMat);
    dot.position.y = 0.03;
    marker.add(bar, dot);
    markerGlowMat = new THREE.SpriteMaterial({ map: S.glowTex, color: tint, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.5 });
    markerGlow = new THREE.Sprite(markerGlowMat);
    markerGlow.position.y = 0.18;
    markerGlow.scale.setScalar(0.92);
    marker.add(markerGlow);
    marker.scale.setScalar(0.001);
    carry.add(marker);
  }

  // ---------- physics ----------
  let accumulator = 0;
  let time = rand() * 10;            // so a team does not breathe in step
  const rhythm = options.rhythm === undefined ? 0.8 : options.rhythm;
  const leanAmount = options.lean === undefined ? 0.1 : options.lean;
  let lift = 0, liftT = 0, foundTimer = 0, foundPeakAt = 0;
  let y = 0, vy = 0, grounded = true;
  let sq = 1, sqV = 0, sqTarget = 1;
  let wind = 0, windDepth = 0.72;
  let pendingJump = null;            // { height, onPeak, onLand, spin, forward }
  let flight = null;                 // the jump in the air
  let spinAngle = 0, spinRate = 0;

  // ---------- pose targets ----------
  let baseYaw = options.facing || 0;
  let lookYawTarget = 0;
  let pitch = 0, pitchTarget = 0;
  let roll = 0, rollTarget = 0;
  let eyeWide = 1, eyeWideT = 1;
  let blink = 0, blinkTimer = 0, nextBlink = 1 + rand() * 3;
  let carryY = H + 0.08, carryV = 0, carryX = 0, carryXV = 0;
  let orbScale = 0, orbScaleT = 0, markerScale = 0, markerScaleT = 0;

  // ---------- behaviour ----------
  let state = 'idle';
  let stateTime = 0;
  let nextAct = 0.6 + rand() * 1.5;
  let nextLook = 0.4 + rand() * 1.5;
  let side = rand() < 0.5 ? -1 : 1;
  let approval = false;              // set by needs_approval, cleared only by done
  let resumeState = 'idle';
  let queuedFound = null;
  let foundSeq = null;
  let travel = null;
  const tmp = new THREE.Vector3();

  function jump(height, opts = {}) {
    pendingJump = { height, ...opts };
    wind = opts.wind === undefined ? 0.06 : opts.wind;
    windDepth = opts.depth === undefined ? 0.76 : opts.depth;
  }

  function launch() {
    const j = pendingJump;
    pendingJump = null;
    vy = Math.sqrt(2 * GRAVITY * j.height);
    grounded = false;
    flight = { ...j, peaked: false, duration: (2 * vy) / GRAVITY, t: 0 };
    sqV += Math.min(5.5, vy * 0.5);
    if (j.spin) spinRate = j.spin / flight.duration;
  }

  function land() {
    const speed = -vy;
    y = 0;
    vy = 0;
    grounded = true;
    sqV -= Math.min(7.5, speed * 0.8);
    spinRate = 0;
    spinAngle = 0;
    carryV -= Math.min(2.2, speed * 0.2);
    const f = flight;
    flight = null;
    if (f && f.onLand) f.onLand();
  }

  function thinkIdle() {
    sqTarget = 1 + 0.03 * Math.sin(time * TAU * 0.55);
    pitchTarget = -0.02;
    rollTarget = 0.035 * Math.sin(time * TAU * 0.27);
    if (time > nextLook) {
      nextLook = time + 1.3 + rand() * 2.4;
      const pick = rand();
      if (pick < 0.3) { lookYawTarget = 0; }
      else {
        side = rand() < 0.5 ? -1 : 1;
        lookYawTarget = side * (0.16 + rand() * 0.2);
      }
    }
    if (!calm && grounded && !pendingJump && time > nextAct) {
      nextAct = time + 4.5 + rand() * 6;
      jump(0.16 + rand() * 0.08, { wind: 0.09 });
    }
  }

  function thinkWorking() {
    if (calm) {
      const beat = Math.sin(time * TAU * rhythm);
      sqTarget = 1 - 0.028 * beat;
      pitchTarget = 0.05 + leanAmount * 0.6 * beat;
      rollTarget = leanAmount * 0.32 * Math.sin(time * TAU * rhythm * 0.5);
      lookYawTarget = 0.08 * Math.sin(time * TAU * rhythm * 0.25);
      return;
    }
    sqTarget = 1;
    pitchTarget = 0.03;             // head a little down, busy
    if (grounded && !pendingJump && time > nextAct) {
      side = -side;
      lookYawTarget = side * 0.24;
      rollTarget = -side * 0.11;
      jump(0.23 + rand() * 0.06, { wind: 0.04, depth: 0.74, onLand() { nextAct = time + 0.035; } });
    }
  }

  function thinkDone() {
    sqTarget = 1 + 0.024 * Math.sin(time * TAU * 0.9);
    rollTarget = 0.1 * Math.sin(time * TAU * 0.62);
    lookYawTarget = 0.14 * Math.sin(time * TAU * 0.31);
    pitchTarget = -0.1;
    if (calm) { rollTarget *= 0.5; lookYawTarget *= 0.5; return; }
    if (grounded && !pendingJump && time > nextAct) {
      nextAct = time + 1.5;
      jump(0.12, { wind: 0.07, onLand() { nextAct = time + 1.2 + rand() * 0.5; } });
    }
  }

  function thinkApproval() {
    sqTarget = 1 + 0.02 * Math.sin(time * TAU * 1.1);
    pitchTarget = -0.4;             // looks up and waits
    lookYawTarget = 0;
    rollTarget = 0.06 * Math.sin(time * TAU * 0.5);
    if (calm) return;
    if (grounded && !pendingJump && time > nextAct) {
      nextAct = time + 2.3;
      jump(0.09, { wind: 0.05, onLand() { jump(0.06, { wind: 0.03 }); } });
    }
  }

  function startFound(value, cbs) {
    const v = normalizeFoundValue(value);
    foundSeq = { v, cbs: cbs || {} };
    const height = 0.95 + 2.5 * v;
    pitchTarget = -0.16;
    rollTarget = 0;
    lookYawTarget = 0;
    eyeWideT = 1.1;
    if (calm) {
      // A small lift and wide eyes. The island's own found moment is the big thing, not the bot.
      liftT = 0.1 + 0.16 * v;
      foundTimer = 1.1 + 0.4 * v;
      foundPeakAt = foundTimer - 0.3;
      sqV += 1.6;
      return;
    }
    jump(height, {
      wind: 0.13 + 0.14 * v,
      depth: 0.76 - 0.08 * v,
      spin: TAU * (v > 0.66 ? 2 : 1),
      onPeak() { if (foundSeq && foundSeq.cbs.onPeak) foundSeq.cbs.onPeak(v); },
      onLand() {
        blink = 1;
        blinkTimer = 0.2;
        jump(0.3 + 0.4 * v, {
          wind: 0.05,
          onLand() {
            jump(0.12 + 0.05 * v, { wind: 0.04, onLand: finishFound });
          },
        });
      },
    });
  }

  function finishFound() {
    const cbs = foundSeq ? foundSeq.cbs : {};
    foundSeq = null;
    eyeWideT = 1;
    if (cbs.onDone) cbs.onDone();
    if (queuedFound) {
      const q = queuedFound;
      queuedFound = null;
      startFound(q.value, q.cbs);
      return;
    }
    enter(resumeState);
  }

  function enter(next) {
    state = next;
    stateTime = 0;
    if (next === 'done') {
      approval = false;
      ensureOrb();
      refreshOrbColor();
    }
    if (next === 'needs_approval') {
      approval = true;
      ensureMarker();
    }
    orbScaleT = next === 'done' ? 1 : 0;
    markerScaleT = approval ? 1 : 0;
    if (next === 'working' || next === 'done' || next === 'needs_approval') nextAct = time + 0.05;
    if (next === 'idle') { nextAct = time + 1 + rand() * 3; nextLook = time + 0.4; rollTarget = 0; lookYawTarget = 0; }
  }

  function setState(next, opts = {}) {
    if (!MASCOT_STATES.includes(next)) {
      console.warn(`mascots: unknown state "${next}"`);
      return api;
    }
    if (next === 'found') {
      if (foundSeq) { queuedFound = { value: opts.value, cbs: opts }; return api; }
      resumeState = state === 'found' ? resumeState : state;
      state = 'found';
      stateTime = 0;
      startFound(opts.value, opts);
      return api;
    }
    if (foundSeq) {
      // Let a big jump finish, then go to the new state.
      resumeState = next;
      if (next === 'done') approval = false;
      if (next === 'needs_approval') { approval = true; ensureMarker(); markerScaleT = 1; }
      return api;
    }
    enter(next);
    return api;
  }

  function hopTo(position, onArrive, opts = {}) {
    tmp.set(position.x, position.y === undefined ? object.position.y : position.y, position.z);
    const from = object.position.clone();
    const to = tmp.clone();
    const dx = to.x - from.x, dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    const scale = object.scale.x || 1;
    const stepLength = (opts.stepLength === undefined ? 1.05 : opts.stepLength) * scale;
    const hops = Math.max(1, Math.round(dist / stepLength));
    travel = {
      from, to, hops, index: 0, dx, dz,
      height: opts.height === undefined ? 0.46 : opts.height,
      yaw: dist > 1e-5 ? Math.atan2(dx, dz) : baseYaw,
      restore: opts.keepFacing ? null : baseYaw,
      onArrive: onArrive || null,
      ground: opts.groundAt || null,
      started: false,
    };
    return api;
  }

  function stepTravel() {
    if (!travel || !grounded || pendingJump) return;
    if (travel.index >= travel.hops) {
      const t = travel;
      travel = null;
      object.position.copy(t.to);
      if (t.restore !== null) baseYaw = t.restore;
      else baseYaw = t.yaw;
      if (t.onArrive) t.onArrive(api);
      return;
    }
    if (!travel.started && Math.abs(angleDelta(yawGroup.rotation.y, travel.yaw)) > 0.5) {
      return;  // turn first, the damped yaw will get there
    }
    travel.started = true;
    const t = travel;
    jump(t.height, {
      wind: 0.05,
      forward: true,
      onLand() {
        t.index += 1;
      },
    });
  }

  function angleDelta(a, b) {
    return ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  }

  let currentYaw = baseYaw;

  function physics(h) {
    time += h;
    stateTime += h;

    if (foundSeq && calm && foundTimer > 0) {
      foundTimer -= h;
      if (foundPeakAt > 0 && foundTimer < foundPeakAt) {
        foundPeakAt = 0;
        if (foundSeq.cbs.onPeak) foundSeq.cbs.onPeak(foundSeq.v);
      }
      if (foundTimer <= 0) { liftT = 0; finishFound(); }
    }
    lift = damp(lift, liftT, 5, h);

    // who decides the pose this step
    if (travel) {
      sqTarget = 1;
      pitchTarget = 0.06;
      lookYawTarget = 0;
      rollTarget = 0;
      stepTravel();
    } else if (foundSeq) {
      sqTarget = 1;
    } else if (state === 'idle') thinkIdle();
    else if (state === 'working') thinkWorking();
    else if (state === 'done') thinkDone();
    else if (state === 'needs_approval') thinkApproval();

    // wind up, launch
    if (pendingJump) {
      wind -= h;
      sqTarget = windDepth;
      if (wind <= 0 && grounded) launch();
    }

    // flight
    if (!grounded) {
      vy -= GRAVITY * h;
      y += vy * h;
      flight.t += h;
      if (spinRate) spinAngle += spinRate * h;
      if (flight.forward && travel) {
        const t = travel;
        const a = (t.index + clamp(flight.t / flight.duration, 0, 1)) / t.hops;
        object.position.x = t.from.x + t.dx * a;
        object.position.z = t.from.z + t.dz * a;
        object.position.y = t.ground ? t.ground(object.position.x, object.position.z) : t.from.y + (t.to.y - t.from.y) * a;
      }
      if (!flight.peaked && vy <= 0) {
        flight.peaked = true;
        if (flight.onPeak) flight.onPeak();
      }
      sqTarget = 1 + clamp(Math.abs(vy) * 0.042, 0, 0.3);
      if (y <= 0) land();
    }

    // squash spring
    sqV += (-SQUASH_K * (sq - sqTarget) - SQUASH_C * sqV) * h;
    sq = clamp(sq + sqV * h, 0.62, 1.42);

    // the head load lags behind the body
    const headY = H * sq + 0.1;
    carryV += (-150 * (carryY - headY) - 13 * carryV) * h;
    carryY += carryV * h;
    const rollPush = roll * 0.75;
    carryXV += (-90 * (carryX + rollPush) - 10 * carryXV) * h;
    carryX += carryXV * h;

    // pose blends
    const yawTarget = travel ? travel.yaw : baseYaw + lookYawTarget;
    currentYaw += angleDelta(currentYaw, yawTarget) * (1 - Math.exp(-(travel ? 14 : 7) * h));
    pitch = damp(pitch, pitchTarget, 7, h);
    roll = damp(roll, rollTarget, state === 'working' ? 16 : 6, h);
    eyeWide = damp(eyeWide, eyeWideT, 10, h);
    orbScale = damp(orbScale, orbScaleT, 11, h);
    markerScale = damp(markerScale, approval ? 1 : markerScaleT, 11, h);

    // blink
    blinkTimer -= h;
    if (blinkTimer <= 0) {
      blink = 0;
      if (time > nextBlink && !foundSeq) {
        blink = 1;
        blinkTimer = 0.09;
        nextBlink = time + (rand() < 0.2 ? 0.25 : 2 + rand() * 3.4);
      }
    }
  }

  function faceCamera() {
    if (!options.camera || travel) return;
    options.camera.getWorldPosition(tmp);
    object.getWorldPosition(camScratch);
    baseYaw = Math.atan2(tmp.x - camScratch.x, tmp.z - camScratch.z);
    if (object.parent) {
      object.parent.getWorldQuaternion(quatScratch);
      eulerScratch.setFromQuaternion(quatScratch, 'YXZ');
      baseYaw -= eulerScratch.y;
    }
    const horizontal = Math.hypot(tmp.x - camScratch.x, tmp.z - camScratch.z);
    faceUp = clamp(Math.atan2(tmp.y - camScratch.y, horizontal), 0, 1.2) * 0.6;
  }
  const camScratch = new THREE.Vector3();
  const quatScratch = new THREE.Quaternion();
  const eulerScratch = new THREE.Euler();
  let faceUp = options.camera ? 0.15 : 0;

  function apply() {
    yawGroup.rotation.y = currentYaw + spinAngle + EYE_BIAS;
    hopGroup.position.y = y + lift;
    const across = 1 / Math.sqrt(sq);
    squashGroup.scale.set(across, sq, across);
    tiltGroup.rotation.set(pitch - faceUp, 0, roll);
    // The eyes never slide: they are built to follow this surface, and sliding sinks them on a curve.
    const b = blink > 0 ? 0.12 : 1;
    eyes.scale.set(eyeWide, eyeWide * b, 1);
    eyes.position.z = eyeHome.z + (eyeWide - 1) * 0.04;
    carry.position.set(carryX, carryY, 0);
    if (orb) {
      orb.visible = orbScale > 0.01;
      const pulse = 1 + 0.05 * Math.sin(time * TAU * 1.3);
      orb.position.y = 0.16 + 0.02 * Math.sin(time * TAU * 0.8);
      orb.scale.setScalar(Math.max(0.001, orbScale * pulse));
      orbGlowMat.opacity = 0.62 + 0.2 * Math.sin(time * TAU * 1.3);
    }
    if (marker) {
      marker.visible = markerScale > 0.01;
      const rise = markerScale * (0.1 + 0.035 * Math.sin(time * TAU * 0.9));
      marker.position.y = rise + 0.04;
      const pulse = 1 + 0.09 * Math.max(0, Math.sin(time * TAU * 0.9));
      marker.scale.setScalar(Math.max(0.001, markerScale * pulse));
      markerGlowMat.opacity = 0.34 + 0.2 * Math.max(0, Math.sin(time * TAU * 0.9));
    }
    if (shadow) {
      const lift = clamp(y / 2.4, 0, 1);
      const w = (info.width || 1) * 1.3 * (1 + lift * 0.4) * Math.max(across, 0.9);
      const d = 0.86 * (info.width || 1) * 1.15 * (1 + lift * 0.4);
      if (calm && !shadowAimed && object.parent) {
        // The plate's key light: the brightest directional light in the scene this bot was added to.
        shadowAimed = true;
        let root = object;
        while (root.parent) root = root.parent;
        let key = null;
        root.traverse((n) => { if (n.isDirectionalLight && (!key || n.intensity > key.intensity)) key = n; });
        if (key) {
          const len = Math.hypot(key.position.x, key.position.z) || 1;
          shadowLean.set(-key.position.x / len, 0, -key.position.z / len);
          shadow.rotation.z = Math.atan2(-shadowLean.z, shadowLean.x);
        }
      }
      if (calm) {
        const reach = (info.width || 1) * 0.1;
        shadow.position.x = shadowLean.x * reach;
        shadow.position.z = shadowLean.z * reach;
      }
      shadow.scale.set(calm ? w * 1.15 : w, calm ? d * 1.05 : d, 1);
      shadow.material.opacity = (options.shadowStrength === undefined ? (calm ? 1 : 0.8) : options.shadowStrength) * (1 - lift) * (1 - lift);
    }
  }

  function update(dt) {
    faceCamera();
    accumulator += Math.min(dt, 0.1);
    while (accumulator >= STEP) {
      physics(STEP);
      accumulator -= STEP;
    }
    apply();
    return api;
  }

  const api = {
    object,
    shape,
    setState,
    update,
    hopTo,
    get state() { return state; },
    get traveling() { return !!travel; },
    get pendingApproval() { return approval; },
    get height() { return y * object.scale.y; },
    get metrics() { return { y, sq, roll, pitch, yaw: currentYaw + spinAngle, orbScale, markerScale, approval, grounded, state, time }; },
    setColor(next) {
      color.set(next);
      applyColor();
      refreshOrbColor();
      return api;
    },
    setFacing(radians) {
      baseYaw = radians;
      return api;
    },
    faceTowards(point) {
      baseYaw = Math.atan2(point.x - object.position.x, point.z - object.position.z);
      return api;
    },
    clearApproval() {
      approval = false;
      markerScaleT = 0;
      return api;
    },
    // A squeeze, for when the job needs the bot's weight: a press coming down, a crate set in place.
    press(amount = 1) {
      sqV -= 2.4 * amount;
      return api;
    },
    head() {
      return carry.getWorldPosition(new THREE.Vector3());
    },
    dispose() {
      material.dispose();
      eyeMaterial.dispose();
      if (shadow) shadow.material.dispose();
      if (orbMat) { orbMat.dispose(); orbGlowMat.dispose(); }
      if (markerMat) { markerMat.dispose(); markerGlowMat.dispose(); }
      if (object.parent) object.parent.remove(object);
    },
  };
  enter('idle');
  apply();
  return api;
}
