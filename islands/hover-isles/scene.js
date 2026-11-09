// Hover Isles, the sun harvest. Crop is cut on the lowest isle, drones hop the baskets up, a wind driven press turns
// them into jars on the middle isle, and the lead pours the jars into the beacon on the highest isle.
// The isles, clouds and field are the Cycles plate. Everything that moves is live.

import * as THREE from 'three';
import { createStage } from '../../engine/plate/stage.js';

export const teamSizes = [3];

export const exampleTeam = {
  workspace: 'Sun Harvest Co',
  timezone: 'America/New_York',
  lead: { id: 'lead', name: 'lead', role: 'signs off and publishes', color: '#f4f5f7', schedule: 'daily' },
  bots: [
    { id: 'scout', name: 'scout', role: 'research: finds what buyers talk about', color: '#2fa8f5', schedule: 'daily' },
    { id: 'writer', name: 'writer', role: 'turns it into drafts', color: '#ff4d8f', schedule: 'daily' },
  ],
};

const GOLD = '#ffb347';

// The same wind the plate's wheat bends in, so the light on the heads rides the bend.
const WIND = { amount: 0.0024, x: 1, y: 0.16, speed: 1.55, scale: 1.7 };

const LIVE_VS = /* glsl */ `
varying vec3 vP;
void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Wheat in a gust: the heads bow and show their bright sides, so a band of light rolls over the field and a dull trough follows it.
// Only the heads take it (motion red at full), and it comes before the bots in the draw order, so they stay in front.
const GUST_FS = /* glsl */ `
precision highp float;
uniform sampler2D tMotion, tNoise;
uniform float uT, uLift, uTanH, uTanV, uW, uSpeed;
uniform vec3 uH, uR, uU, uF, uN, uP0;
varying vec3 vP;
void main() {
  vec3 ray = vP - uH;
  float z = dot(ray, uF);
  vec2 uv = vec2(dot(ray, uR) / (z * uTanH), dot(ray, uU) / (z * uTanV)) * 0.5 + 0.5;
  uv.y -= uLift;
  float head = smoothstep(0.9, 0.99, max(texture(tMotion, uv).r, textureLod(tMotion, uv, 1.0).r * 1.05));
  if (head < 0.01) discard;
  vec3 P = uH + ray * (dot(uN, uP0 - uH) / dot(uN, ray));
  float g = 0.5 + 0.5 * sin(P.x * uW - uT * 0.62 * uSpeed + 1.7 * sin(P.z * uW * 0.7 + uT * 0.11));
  float broad = texture(tNoise, P.xz * 0.075 + vec2(-uT * 0.01, uT * 0.006)).r;
  float fine = texture(tNoise, P.xz * 0.42 + vec2(-uT * 0.05, uT * 0.02)).r;
  float lit = g * g * g * (0.5 + 0.75 * broad) * (0.55 + 0.9 * fine) * 0.3;
  float dull = (1.0 - g) * (1.0 - g) * 0.17;
  float a = head * (lit + dull);
  vec3 c = (vec3(2.3, 1.22, 0.2) * lit + vec3(0.2, 0.085, 0.015) * dull) / max(lit + dull, 0.001);
  gl_FragColor = vec4(c * a, a);
}`;

// High thin streaks over the open sky. The plate's sky is a clean gradient, so there is nothing in it to drift until these are.
const CIRRUS_FS = /* glsl */ `
precision highp float;
uniform sampler2D tNoise;
uniform float uT, uTanV;
uniform vec2 uSun;
uniform vec3 uH, uR, uU, uF;
varying vec3 vP;
void main() {
  vec3 ray = vP - uH;
  float z = dot(ray, uF);
  vec2 p = vec2(dot(ray, uR), dot(ray, uU));
  float horizon = smoothstep(0.02, 0.3, p.y / (z * uTanV));
  if (horizon < 0.01) discard;
  float warp = texture(tNoise, p * vec2(0.0035, 0.012) + vec2(uT * 0.0009, 0.3)).r;
  float a = texture(tNoise, vec2(p.x * 0.003, p.y * 0.017 - p.x * 0.0022) + vec2(uT * 0.0042, warp * 0.16)).r;
  float b = texture(tNoise, vec2(p.x * 0.009, p.y * 0.05 - p.x * 0.0066) + vec2(uT * 0.0185, warp * 0.24)).r;
  float veil = texture(tNoise, p * vec2(0.0018, 0.005) + vec2(uT * 0.0011, 0.7)).r;
  float d = smoothstep(0.42, 0.74, a * 0.62 + b * 0.38) * smoothstep(0.3, 0.6, veil);
  // Streaks near the low sun catch it. Pale cream on the warm side, or they vanish into the peach.
  vec2 s = (p - uSun) * vec2(0.011, 0.017);
  float sun = exp(-dot(s, s));
  float warm = smoothstep(-40.0, 90.0, p.x);
  float alpha = d * horizon * mix(0.36, 0.56, warm) * (1.0 + 0.5 * sun);
  if (alpha < 0.004) discard;
  vec3 c = mix(vec3(1.5, 1.14, 0.9), vec3(3.6, 2.7, 1.9), warm) + vec3(5.0, 3.4, 1.8) * sun;
  gl_FragColor = vec4(c * alpha, alpha);
}`;

const premult = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, depthWrite: false, toneMapped: false };

// Tiling value noise, made once from the island's own seed. Sampling this is far cheaper than noise in the shader.
function noiseTexture(rand, size = 128) {
  const data = new Uint8Array(size * size);
  const octaves = [[8, 0.56], [16, 0.28], [32, 0.16]].map(([n, w]) => ({ n, w, g: Float32Array.from({ length: n * n }, () => rand()) }));
  const sm = (x) => x * x * (3 - 2 * x);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let v = 0;
      for (const { n, w, g } of octaves) {
        const fx = (x / size) * n, fy = (y / size) * n;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = sm(fx - ix), ty = sm(fy - iy);
        const at = (i, j) => g[((j + n) % n) * n + ((i + n) % n)];
        v += w * (at(ix, iy) * (1 - tx) * (1 - ty) + at(ix + 1, iy) * tx * (1 - ty) + at(ix, iy + 1) * (1 - tx) * ty + at(ix + 1, iy + 1) * tx * ty);
      }
      data[y * size + x] = Math.round(v * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export async function createIsland(ctx) {
  const { config, quality, mascots, scene } = ctx;
  const stage = await createStage(ctx, { motion: true, lift: true, flow: 0, water: 0.5, pulse: 0.55, envIntensity: 1.05, sparkSize: 0.12 });
  const { info } = stage;
  const { spots } = info;
  const vec = (a) => new THREE.Vector3().fromArray(a);

  stage.bindGroup('harvest', config.bots[0].color);
  stage.bindGroup('press', config.bots[1].color);
  stage.bindGroup('lead', config.lead.color);

  // ---------- bots ----------
  const makeBot = async (cfg, key, opts) => {
    const b = info.bots[key];
    const bot = await mascots.create({
      color: cfg.color, index: cfg.index, lead: !!cfg.lead, shape: b.shape, size: b.size, calm: true,
      envMap: scene.environment, envMapIntensity: 1, seed: key.length * 7, ...opts,
    });
    bot.object.position.fromArray(b.p);
    bot.setFacing(b.yaw);
    stage.live.add(bot.object);
    return bot;
  };
  const harvester = await makeBot(config.bots[0], 'harvest', { rhythm: 0.85, lean: 0.14 });
  const presser = await makeBot(config.bots[1], 'press', { rhythm: 0.46, lean: 0.1 });
  const lead = await makeBot(config.lead, 'lead', { rhythm: 0.3, lean: 0.07 });
  const bots = { harvest: harvester, press: presser, lead };
  const state = { harvest: 'idle', press: 'idle', lead: 'idle' };
  const busy = (k) => state[k] === 'working';

  // ---------- the field: grain arcs from the cut row into the cart, baskets stack up ----------
  const headBasket = stage.copy('basket', spots.harvest_head[0]);
  const stack = stage.pile('stack', 'basket', spots.stack, 7);
  const padBasket = stage.copy('basket', spots.pad_out_harvest[0]);
  const grainPts = stage.path('grain');
  const grainPool = [];
  for (let i = 0; i < (quality.name === 'phone' ? 6 : 12); i += 1) {
    grainPool.push(stage.runner('grainfly', grainPts, { speed: 2.6, scale: 0.032 }));
  }
  let grainCursor = 0;
  let grainTimer = 0;
  let stackTimer = 0;

  // ---------- the press ----------
  const sails = stage.actor('sails');
  const windAxis = vec(spots.sails_axis[0].p).sub(sails.position).normalize();
  const sailsMachine = stage.machine(sails, windAxis, { idle: 0.28, working: 1.15, ease: 0.7 });
  const gearBig = stage.actor('gear_big');
  const gearSmall = stage.actor('gear_small');
  const gearAxis = vec(spots.gear_axis[0].p).sub(gearBig.position).normalize();
  const bigMachine = stage.machine(gearBig, gearAxis, { idle: -0.18, working: -0.77, ease: 0.7 });
  const smallMachine = stage.machine(gearSmall, gearAxis, { idle: 0.28, working: 1.15, ease: 0.7 });
  const screw = stage.actor('screw');
  const screwHome = screw.position.y;
  const lever = stage.actor('lever');
  const leverAxis = vec(spots.lever_axis[0].p).sub(lever.position).normalize();
  const leverHome = lever.quaternion.clone();
  const bench = stage.pile('bench', 'jar', spots.bench, 3);
  const rack = stage.pile('rack', 'jar', spots.rack, 13);
  const padJar = stage.copy('jar', spots.pad_out_press[0]);
  const beltPts = stage.path('belt');
  const beltScale = spots.belt_scale[0].s;
  const beltRunners = [0, 1, 2].map(() => stage.runner('basket', beltPts, { speed: 0.55, scale: beltScale }));
  let beltCursor = 0;
  let pressPhase = 0;
  let pressCycles = 0;
  let waitingBatches = 1;
  const sendBelt = () => {
    const r = beltRunners[beltCursor];
    beltCursor = (beltCursor + 1) % beltRunners.length;
    r.go(1, (run) => { run.node.visible = false; });
  };

  // ---------- the beacon ----------
  const column = stage.actor('column');
  column.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      o.material.depthTest = false;
      o.material.transparent = true;
      o.material.opacity = 0.5;
      o.material.depthWrite = false;
      o.renderOrder = 4;
    }
  });
  column.scale.x = 0.93;
  column.scale.z = 0.93;
  const pour = stage.actor('pour');
  pour.visible = false;
  const pourHome = pour.quaternion.clone();
  const delivered = stage.pile('delivered', 'jar', spots.delivered, 5);
  const lampPos = vec(spots.beacon_lamp[0].p);
  const lamp = stage.glow(lampPos, GOLD, 3.4, 0.2);
  let level = 0.72;
  let lampFlare = 0;

  // ---------- drones on the legs ----------
  const leg = (name) => stage.path(name);
  const lower = leg('leg0').concat(leg('leg1').slice(1));
  const upper = leg('leg2').concat(leg('leg3').slice(1));
  const makeCarrier = (name, points) => {
    const node = stage.copy(name);
    const depth = Math.abs(points[0].z);
    const r = stage.runner(name, points, { speed: 2.05, scale: depth, node, bob: 0.03 });
    r.baseScale = depth;
    return r;
  };
  const lowerCarriers = [0, 1, 2, 3, 4].map(() => makeCarrier('carrier_basket', lower));
  const upperCarriers = [0, 1, 2].map(() => makeCarrier('carrier_jar', upper));
  // The scale of a carrier follows how far off it is, as it did in the render.
  stage.onUpdate(() => {
    for (const r of [...lowerCarriers, ...upperCarriers]) {
      if (r.node.visible) r.node.scale.setScalar(Math.abs(r.node.position.z) * 1.22);
    }
  });
  let lowerTimer = 1.5;
  let upperTimer = 4.5;
  let lowerCursor = 0;
  let upperCursor = 0;
  let baskets = 0;

  const launchLower = (speedMul = 1) => {
    const r = lowerCarriers[lowerCursor];
    if (r.active) return false;
    lowerCursor = (lowerCursor + 1) % lowerCarriers.length;
    if (stack.count > 4) stack.set(stack.count - 1);
    padBasket.visible = false;
    r.go(speedMul, () => {
      r.node.visible = false;
      waitingBatches += 1;
      baskets += 1;
      sendBelt();
    });
    return true;
  };
  const launchUpper = (speedMul = 1) => {
    const r = upperCarriers[upperCursor];
    if (r.active) return false;
    upperCursor = (upperCursor + 1) % upperCarriers.length;
    padJar.visible = false;
    r.go(speedMul, () => {
      r.node.visible = false;
      if (delivered.count >= delivered.capacity) delivered.set(6);
      delivered.add(1);
      level = Math.min(1, level + 0.018);
      lampFlare = Math.max(lampFlare, 0.5);
      stage.sparks(lampPos, GOLD, 8, { speed: 0.9, spread: 0.8, up: 0.5, life: 0.9 });
    });
    return true;
  };
  // The line was already running when the shot began: drones are spread along both legs from the first frame.
  for (const [launch, list, count] of [[launchLower, lowerCarriers, 3], [launchUpper, upperCarriers, 3]]) {
    for (let k = 0; k < count; k += 1) {
      const r = list[k];
      if (launch(1)) r.t = (k + 0.5) / count * 0.9;
    }
  }

  // ---------- the place itself ----------
  // Cloud shadows and the light sweep are left out: both read the plate's depth, so on a rock face they follow every ledge and the strata seem to crawl.
  // The cloud floor drifts with almost no warp, because a warp ripples puff edges like jelly. The slide is short because the crossfade doubles every edge by half of it; real travel comes from the live veils.
  stage.life({
    wind: WIND,
    // The flow mask's slow swell is low frequency, so it reads as cloud growing.
    flowRate: 3,
    flow: 1.5,
    cloud: { x: 0.0038, y: 0, cycle: 20, warp: 0.0003 },
    run: { x: 0, y: -0.052, cycle: 1.05, streak: 0.36 },
  });

  // Screen pixels of the 1920 x 1080 shot, at a distance, to the world. The shot is a little inside the plate (overscan).
  const tanH = Math.tan(THREE.MathUtils.degToRad(info.camera.hfov) / 2);
  const tanV = Math.tan(THREE.MathUtils.degToRad(info.camera.vfov) / 2);
  const OVER = 1.035;
  const at = (sx, sy, z) => stage.H.clone().addScaledVector(stage.F, z)
    .addScaledVector(stage.R, ((sx / 960 - 1) / OVER) * tanH * z)
    .addScaledVector(stage.U, ((1 - sy / 540) / OVER) * tanV * z);
  const rect = (x0, y0, x1, y1, z) => {
    const c = [at(x0, y1, z), at(x1, y1, z), at(x1, y0, z), at(x0, y0, z)];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(c.flatMap((v) => [v.x, v.y, v.z])), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    return geo;
  };
  const noise = noiseTexture(stage.rand);
  const motionTex = await new THREE.TextureLoader().loadAsync(`${ctx.assetsBase}plate_motion.webp`);
  motionTex.colorSpace = THREE.NoColorSpace;

  const camU = { uH: { value: stage.H }, uR: { value: stage.R }, uU: { value: stage.U }, uF: { value: stage.F }, uTanH: { value: tanH }, uTanV: { value: tanV } };
  const clockU = { value: 0 };
  const gustLift = { value: 0 };
  // The plane the wheat heads make: the harvest isle is tilted, so a flat floor would bend the bands.
  const gustMat = new THREE.ShaderMaterial({
    vertexShader: LIVE_VS, fragmentShader: GUST_FS, ...premult, transparent: false, depthTest: false,
    uniforms: {
      ...camU, tMotion: { value: motionTex }, tNoise: { value: noise }, uT: clockU, uLift: gustLift,
      uW: { value: WIND.scale }, uSpeed: { value: WIND.speed },
      uN: { value: new THREE.Vector3(0.0625, 0.985, 0.162) }, uP0: { value: new THREE.Vector3(-5.77, -0.98, -14.91) },
    },
  });
  const gustMesh = new THREE.Mesh(rect(-140, 600, 660, 960, 14), gustMat);
  gustMesh.frustumCulled = false;
  gustMesh.renderOrder = -50;
  stage.live.add(gustMesh);

  const sunWorld = at(1802, 135, 285).sub(stage.H);
  const sunPlane = new THREE.Vector2(sunWorld.dot(stage.R), sunWorld.dot(stage.U));
  const cirrusMat = new THREE.ShaderMaterial({
    vertexShader: LIVE_VS, fragmentShader: CIRRUS_FS, ...premult, transparent: true, depthTest: true,
    uniforms: { ...camU, tNoise: { value: noise }, uT: clockU, uSun: { value: sunPlane } },
  });
  const cirrusMesh = new THREE.Mesh(rect(-500, -500, 2420, 760, 285), cirrusMat);
  cirrusMesh.frustumCulled = false;
  cirrusMesh.renderOrder = 1;
  stage.live.add(cirrusMesh);

  // The low sun's bloom breathes as thin cloud crosses it.
  const sunGlow = stage.glow(at(1802, 135, 250), '#ffc98f', 150, 0.12);
  const sunHalo = stage.glow(at(1802, 135, 250), '#ffe3bd', 46, 0.16);

  // Pollen over the wheat, and warm dust hanging in the low sun across the whole shot.
  stage.particles({ count: 340, center: at(250, 700, 14), box: [9, 2.2, 6], velocity: [0.2, 0.05, 0.03], wobble: 0.4, size: [0.012, 0.028], color: '#ffae4a', additive: true, opacity: 0.5, flicker: 0.6, hard: 1.4 });
  // The warm dust stays low over the cloud sea: over open sky the motes read as specks on the lens.
  stage.particles({ count: 240, center: [4, -3.2, -23], box: [34, 5.2, 13], velocity: [0.13, 0.03, -0.02], wobble: 0.5, size: [0.024, 0.05], color: '#ffb670', additive: true, opacity: 0.36, flicker: 0.7, hard: 1.4 });

  // Each fall: droplets leaving the lip, spray where the sheet breaks up, and a soft plume rising continuously from its foot.
  const fallSpray = [];
  const fallAt = (sx, lipY, breakY, z, bodyIndex, foot) => {
    const k = z / 19;
    const px = z / 1494;
    // Scene light, so brighter than 1: at 1 the look maps white to a mid tone, and droplets read as dark scratches against the bright sky.
    const drop = (breakY - lipY) * px;
    const lip = stage.particles({ count: 56, center: at(sx, lipY + 10, z - 0.2), box: [0.2 * k, 0.1 * k, 0.1 * k], velocity: [0, (-0.35 * drop) / 1.2, 0], accel: [0, (-1.3 * drop) / (1.2 * 1.2), 0], life: 1.2, size: [0.012 * k, 0.018 * k], stretch: 3, color: [3.2, 2.9, 2.55], opacity: 0.42, fadeOut: 0.35 });
    fallSpray.push({ mesh: lip.mesh, body: bodyIndex });
    // Where the sheet meets the cloud the water turns to soft spray. Small hard drops here read as dirt on the cloud.
    stage.particles({ count: 34, center: at(sx, breakY, z - 2.2), box: [0.6 * k, 0.3 * k, 0.4 * k], velocity: [0.012 * z, -0.018 * z, 0], accel: [0.006 * z, 0.004 * z, 0], life: 3.4, size: [0.05 * k, 0.34 * k], color: [3.2, 2.8, 2.4], opacity: 0.1, hard: 2.2, breakup: 0.6, fadeIn: 0.15, fadeOut: 0.35 });
    const life = 10;
    // Well in front of the fall: its see-through mesh is solid in the plate's depth and would cut a dark stripe through the plume.
    stage.particles({
      count: 30, center: at(sx + foot.dx, foot.y, z - 3.2), box: [foot.w0 * 2 * px, 40 * px, 0.3], velocity: [2.8 * px, (foot.rise / life) * px, 0], life,
      size: [foot.w0 * px, foot.w1 * px], wobble: 18 * px, color: [2.05, 1.6, 1.22], opacity: foot.o ?? 0.1, breakup: 0.75, hard: 2.2, spin: 0.03, fadeIn: 0.22, fadeOut: 0.5,
    });
  };
  fallAt(82, 925, 1045, 11.5, 0, { y: 1120, dx: 6, rise: 190, w0: 60, w1: 170 });
  fallAt(622, 585, 690, 18.6, 0, { y: 770, dx: 6, rise: 130, w0: 28, w1: 80 });
  fallAt(1088, 545, 790, 18.7, 1, { y: 890, dx: 10, rise: 170, w0: 48, w1: 135 });
  fallAt(1668, 305, 540, 30, 2, { y: 730, dx: 22, rise: 230, w0: 46, w1: 125, o: 0.13 });

  // Thin cloud crossing in front of the isles' undersides.
  stage.particles({ count: 3, center: at(330, 1000, 10.4), box: [15, 1.5, 1.2], velocity: [0.17, 0, 0], size: [0.9, 1.5], wobble: 0.2, color: [2.3, 1.85, 1.55], opacity: 0.17, breakup: 0.9, hard: 2, spin: 0.015 });
  stage.particles({ count: 4, center: at(1000, 700, 17.4), box: [20, 1.7, 1.2], velocity: [0.21, 0, 0], size: [1.2, 2.2], wobble: 0.25, color: [2.3, 1.85, 1.55], opacity: 0.19, breakup: 0.9, hard: 2, spin: 0.012 });
  stage.particles({ count: 4, center: at(1510, 470, 28.8), box: [28, 2.4, 1.4], velocity: [0.27, 0, 0], size: [1.8, 3.3], wobble: 0.3, color: [2.4, 1.85, 1.45], opacity: 0.19, breakup: 0.9, hard: 2, spin: 0.01 });

  // Big soft cloud travelling over the sea in three layers: the further away, the slower across the screen. This is what makes the floor really travel.
  const veil = (count, sy, z, wide, high, pxPerSec, w0, w1, opacity, color) => stage.particles({
    count, center: at(960, sy, z), box: [wide, high, 3], velocity: [(pxPerSec * z) / 1494, 0, 0],
    size: [(w0 * z) / 1494, (w1 * z) / 1494], wobble: (22 * z) / 1494, color, opacity, breakup: 0.85, hard: 2, spin: 0.006,
  });
  veil(7, 665, 78, 150, 5, 7, 190, 320, 0.2, [2.5, 1.95, 1.5]);
  veil(7, 800, 40, 62, 3.4, 12, 170, 300, 0.17, [2.4, 1.95, 1.62]);
  veil(6, 985, 15, 30, 2, 19, 150, 250, 0.1, [2.0, 1.62, 1.36]);
  // Mist at the height of the puffs' shoulders: nearer puffs hide it by depth, so it slides between them instead of over them.
  veil(10, 760, 62, 110, 1.2, 7, 90, 170, 0.24, [2.4, 1.85, 1.45]);
  veil(12, 880, 36, 64, 0.9, 10, 90, 170, 0.24, [2.3, 1.85, 1.5]);
  veil(9, 990, 22, 38, 0.7, 15, 90, 170, 0.2, [2.2, 1.8, 1.5]);
  // Slow cloud shadow on the sea. Live, and behind the isles by depth, because the plate's own shadow crawls over the rock strata.
  veil(8, 725, 66, 130, 3.5, 5, 180, 300, 0.2, [0.17, 0.13, 0.2]);
  veil(8, 850, 38, 74, 2.6, 9, 190, 320, 0.22, [0.15, 0.12, 0.2]);
  veil(6, 995, 21, 42, 1.6, 13, 190, 300, 0.2, [0.14, 0.11, 0.2]);

  // A few birds a long way off, against the sky and the far cloud.
  stage.flock({ center: at(560, 250, 92), radius: [30, 1.4, 9], count: 6, size: 0.27, speed: 0.03, flap: 6.2, color: '#2a211c', opacity: 0.72, spread: 0.022 });
  stage.flock({ center: at(1290, 450, 135), radius: [34, 1.6, 12], count: 4, size: 0.34, speed: -0.024, flap: 5.4, color: '#40302a', opacity: 0.6, spread: 0.02 });

  // The three big isles rise and fall, each on its own beat, a few pixels at most. Everything standing on one lives in its group, so it stays planted.
  const bodies = [
    { c: new THREE.Vector3(-5.8, -2.2, -15), r: 4.3, at: new THREE.Vector3(-5.8, -1.5, -14), a: 0.019, f: 0.38, p: 0.6, a2: 0.004, f2: 0.83 },
    { c: new THREE.Vector3(0.4, 3, -22), r: 5.1, at: new THREE.Vector3(0.4, 1.7, -21), a: 0.027, f: 0.31, p: 2.1, a2: 0.005, f2: 0.71 },
    { c: new THREE.Vector3(11.7, 7.2, -33), r: 6.2, at: new THREE.Vector3(11.7, 6.6, -32), a: 0.044, f: 0.25, p: 4.0, a2: 0.008, f2: 0.59 },
  ];
  const flying = new Set([...lowerCarriers, ...upperCarriers, ...grainPool].map((r) => r.node));
  const tmpHome = new THREE.Vector3();
  for (const b of bodies) {
    b.group = new THREE.Group();
    stage.live.add(b.group);
  }
  for (const o of [...stage.live.children]) {
    if (flying.has(o) || !o.parent || bodies.some((b) => b.group === o)) continue;
    if (o === sunGlow.sprite || o === sunHalo.sprite) continue;
    tmpHome.copy(o.position);
    const b = bodies.find((body) => tmpHome.distanceTo(body.c) < body.r);
    if (b) b.group.add(o);
  }
  // Named by hand as well: an actor's own origin may not sit near its isle.
  bodies[0].group.add(harvester.object, headBasket, padBasket);
  bodies[1].group.add(presser.object, sails, gearBig, gearSmall, screw, lever, padJar);
  bodies[2].group.add(lead.object, column, pour, lamp.sprite);
  for (const r of beltRunners) bodies[1].group.add(r.node);
  for (const s of fallSpray) if (s.body >= 0) bodies[s.body].group.add(s.mesh);

  // ---------- worlds ----------
  const posOf = (k) => vec(info.bots[k].p);
  const hp = posOf('harvest');
  const pp = posOf('press');
  const lp = posOf('lead');
  const up = (k, y) => posOf(k).add(new THREE.Vector3(0, y, 0));
  const worlds = new Map();
  const harvestWorld = stage.worldRecord({
    anchorAt: up('harvest', info.bots.harvest.size * 1.72),
    center: hp.clone().add(new THREE.Vector3(0.6, 1.1, 0)),
    zoom: 2,
    route: [hp, vec(spots.pad_out_harvest[0].p), ...lower, pp, ...upper, lp],
  });
  harvestWorld.handoff = lower.length + 2;
  worlds.set(config.bots[0].id, harvestWorld);
  const pressWorld = stage.worldRecord({
    anchorAt: up('press', info.bots.press.size * 1.1),
    center: pp.clone().add(new THREE.Vector3(-1.2, 1.6, 0)),
    zoom: 2,
    route: [pp, vec(spots.pad_out_press[0].p), ...upper, lp],
  });
  worlds.set(config.bots[1].id, pressWorld);
  const main = stage.worldRecord({ anchorAt: up('lead', info.bots.lead.size * 1.05), center: lp.clone().add(new THREE.Vector3(1, 1.6, 0)), zoom: 2 });

  const keyOf = (world) => (world === harvestWorld ? 'harvest' : world === pressWorld ? 'press' : 'lead');
  const LEVELS = { idle: 0.22, working: 1, found: 1.5, done: 0.8, needs_approval: 0.45 };

  function applyEvent(evt, world) {
    const key = keyOf(world);
    const bot = bots[key];
    if (evt.catchup) {
      if (!evt.pending) bot.clearApproval();
      state[key] = evt.pending ? 'needs_approval' : evt.activity;
      bot.setState(state[key]);
      stage.setLevel(key, LEVELS[state[key]]);
      return;
    }
    bot.setState(evt.type, { value: evt.intensity });
    if (evt.type === 'found') {
      stage.setLevel(key, LEVELS.found);
      const f = 6 + Math.round(26 * evt.intensity);
      if (key === 'harvest') {
        stage.sparks(hp.clone().add(new THREE.Vector3(-1.4, 0.7, 0.1)), GOLD, f, { speed: 2.6, spread: 1.3, up: 1.1, life: 1.5 });
        if (evt.value) stage.chip(harvestWorld.anchor.position.clone(), `+${evt.value}`, GOLD);
      } else if (key === 'press') {
        stage.sparks(vec(spots.gear_axis[0].p), GOLD, f, { speed: 1.8, spread: 1.1, up: 1, life: 1.1 });
      } else {
        lampFlare = 1;
        stage.sparks(lampPos, GOLD, f, { speed: 1.6, spread: 1.2, up: 0.9, life: 1.3 });
      }
      return;
    }
    if (evt.type === 'done') {
      stage.setLevel(key, LEVELS.done);
      state[key] = 'done';
      if (key === 'harvest') { stack.add(1); launchLower(1.5); }
      if (key === 'press') { rack.add(1); launchUpper(1.5); }
      if (key === 'lead') { lampFlare = 1; level = Math.min(1, level + 0.03); stage.sparks(lampPos, GOLD, 18, { speed: 1.4, spread: 1, up: 0.9 }); }
      return;
    }
    state[key] = evt.type;
    stage.setLevel(key, LEVELS[evt.type] ?? 0.3);
  }

  function update(dt, t) {
    for (const b of Object.values(bots)) b.update(dt);

    // The plate's clock, so the light on the wheat and the bend in the plate stay on one gust.
    clockU.value = t;
    bodies.forEach((body, i) => {
      const dy = body.a * Math.sin(t * body.f + body.p) + body.a2 * Math.sin(t * body.f2 + body.p * 1.7);
      body.group.position.y = dy;
      stage.setLift(i, dy, body.at);
      if (i === 0) gustLift.value = dy / (2 * Math.abs(body.at.z) * tanV);
    });
    sunGlow.set(0.13 + 0.04 * Math.sin(t * 0.33) + 0.016 * Math.sin(t * 0.87 + 1.1));
    sunHalo.set(0.19 + 0.07 * Math.sin(t * 0.41 + 0.8) + 0.025 * Math.sin(t * 1.13));
    sunHalo.sprite.scale.setScalar(46 + 5 * Math.sin(t * 0.41 + 0.8));

    // The field.
    headBasket.position.set(spots.harvest_head[0].p[0], spots.harvest_head[0].p[1] + harvester.height + Math.sin(t * 5.3) * (busy('harvest') ? 0.012 : 0), spots.harvest_head[0].p[2]);
    if (busy('harvest')) {
      grainTimer -= dt;
      if (grainTimer <= 0) {
        grainTimer = 0.17;
        const g = grainPool[grainCursor];
        grainCursor = (grainCursor + 1) % grainPool.length;
        g.go(0.85 + stage.rand() * 0.3, (run) => { run.node.visible = false; });
      }
      stackTimer += dt;
      if (stackTimer > 4.2) {
        stackTimer = 0;
        if (stack.count < stack.capacity) {
          stack.add(1);
        }
      }
    }
    padBasket.visible = stack.count > 2 && !lowerCarriers.some((r) => r.active && r.t < 0.05);

    // The press only comes down while somebody is working it.
    stage.setMachines([sailsMachine, smallMachine, bigMachine], busy('press'));
    const pressing = busy('press') && waitingBatches > 0;
    pressPhase += dt * (pressing ? 0.46 : 0.0);
    const stroke = 0.5 - 0.5 * Math.cos(pressPhase * Math.PI * 2);
    const wanted = screwHome + 0.14 * (1 - stroke);
    screw.position.y += (wanted - screw.position.y) * (1 - Math.exp(-dt * 6));
    lever.quaternion.setFromAxisAngle(leverAxis, 0.09 * (stroke - 0.5)).multiply(leverHome);
    const cycle = Math.floor(pressPhase);
    if (cycle > pressCycles) {
      pressCycles = cycle;
      presser.press(1);
      stage.sparks(screw.position.clone().add(new THREE.Vector3(0, -0.9, -0.2)), GOLD, 7, { speed: 0.9, spread: 1, up: 0.5, life: 0.8 });
      waitingBatches = Math.max(0, waitingBatches - 0.34);
      if (bench.count >= bench.capacity) {
        bench.set(0);
        if (rack.count >= rack.capacity) rack.set(9);
        rack.add(1);
      } else {
        bench.add(1);
      }
    }
    padJar.visible = rack.count > 2 && !upperCarriers.some((r) => r.active && r.t < 0.05);

    // Something is always in the air: quicker while the line is busy.
    lowerTimer -= dt;
    if (lowerTimer <= 0) {
      launchLower();
      lowerTimer = busy('harvest') ? 1.9 + stage.rand() * 0.6 : 3 + stage.rand();
    }
    upperTimer -= dt;
    if (upperTimer <= 0) {
      launchUpper();
      upperTimer = busy('press') ? 2.1 + stage.rand() * 0.6 : 3.2 + stage.rand();
    }

    // The beacon.
    const pouring = busy('lead');
    pour.visible = pouring;
    if (pouring) {
      pour.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.05 * Math.sin(t * 1.6)).multiply(pourHome);
      level = Math.min(1, level + dt * 0.002);
    }
    column.scale.y = THREE.MathUtils.clamp(level / 0.74, 0.15, 1.3);
    lampFlare = Math.max(0, lampFlare - dt * 0.55);
    lamp.set((pouring ? 0.32 : 0.16) + 0.04 * Math.sin(t * 2.1) + lampFlare * 0.65);
    lamp.sprite.scale.setScalar(3.2 + lampFlare * 4 + (pouring ? 0.5 : 0));

  }

  return stage.island({
    worlds, main, applyEvent, update,
    dispose() {
      for (const b of Object.values(bots)) b.dispose();
      noise.dispose();
      motionTex.dispose();
      for (const m of [gustMesh, cirrusMesh]) { m.geometry.dispose(); m.material.dispose(); }
    },
  });
}
