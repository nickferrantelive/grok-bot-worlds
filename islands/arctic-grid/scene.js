// Arctic Grid, the ice core survey. A rig drills on the river ice and lines up cores, a hauler winds sleds of them up the
// frozen river, and the lead slots them into a data vault on the bluff, which lights up cell by cell.
// The valley, the rig and the vault shell are the Cycles plate. Everything that moves is live.

import * as THREE from 'three';
import { createStage } from '../../engine/plate/stage.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pointAlongRoute, routeLength } from '../../engine/route.js';

export const teamSizes = [3];

// The colours are the bots in the reference frame, so the live team matches the render.
export const exampleTeam = {
  workspace: 'Polar Survey Co',
  timezone: 'America/Anchorage',
  lead: { id: 'lead', name: 'lead', role: 'signs off and archives', color: '#f4f5f7', schedule: 'daily' },
  bots: [
    { id: 'driller', name: 'driller', role: 'drills the ice and lines up cores', color: '#ef7b1d', schedule: 'daily' },
    { id: 'hauler', name: 'hauler', role: 'tows the cores up the river', color: '#ef358b', schedule: 'daily' },
  ],
};

// Light on the live layer. Colour and coverage both add, so the composite's divide by alpha gets back the colour it was given.
// Plain additive blending squares the alpha there, and the light all but vanishes.
const LIGHT_BLEND = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.SrcAlphaFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
};

const AMBER = '#ffa030';
const ICE_CHIP = '#d8ecff';
const TEAL = '#30ffc0';
const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const glide = (k) => smooth(k) * 0.35 + k * 0.65;

// A convoy on one loop, as shares of a round trip: a stop at the dock, the slow haul up, a stop at the rail, a quick run back.
// Six sleds at these shares keep at least three loaded on the river at any moment, from the first frame.
const SLEDS = 3;
const AT_DOCK = 0.06;
const HAUL = 0.62;
const AT_RAIL = 0.06;
const BACK = 1 - AT_DOCK - HAUL - AT_RAIL;
const SLED_LOAD = 5;
const TRAY_FLOOR = 8;
const CELLS_START = 20;
const CELLS_AFTER_UPLINK = 18;

// ---------- the place itself: dusk wind off the river, everything here only ever runs on the clock ----------
const WIND_SCALE = 0.17;
const WIND_SPEED = 1;
// Tree crowns the gust can shake, read off the plate's depth.
const CROWNS = [
  [-7.97, 4.98, -14.75], [-6.69, 2.26, -12.96], [-3.94, 3.92, -16.14], [12.73, 2.84, -2.99], [15.23, 3.74, -1.44], [18.23, 4.26, -0.8],
  [17.44, 5.1, -9.36], [21.27, 7.08, -10.36], [14.21, 2.5, 8.32], [-12.25, 6.52, -16.93], [-5.49, 7.12, -18.79],
  [1.69, 5.85, -22.23], [19.14, 5.99, -19.36], [24.97, 8.38, -13.68],
];
const PUFFS = 8;
const PUFF_BITS = 34;
const STACK = [14.1, 9.9, -12.9];
const STACK_H = 0.62;
const FLAGS = [[-0.98, 9.76], [1.35, 8.9]];
const PUFF_LIFE = 2.6;

async function bringWorldAlive({ assetsBase }, stage) {
  const hero = stage.info.camera;
  const nearStage = (d) => stage.H.clone().addScaledVector(stage.F, d);

  // The plate: gusts through the pines, cloud shadow and light over the snow, a low mist breathing on the river.
  const wind = { wind: { amount: 0.0016, x: 1, y: 0.07, speed: WIND_SPEED, scale: WIND_SCALE } };
  const mist = { fog: { amount: 0.2, bottom: 0.02, top: 0.5, size: 6.5, vx: 0.05, vz: 0.016, color: '#b8d8f6' } };
  stage.life({
    ...wind,
    ...mist,
    shadow: { amount: 0.2, size: 15, vx: 0.05, vz: 0.02 },
    sweep: { amount: 0.1, width: 7, speed: 1.5, period: 40, dir: [0.92, 0, 0.38] },
  });

  // Snow in depth, no two layers alike: tiny far specks, soft mid flakes, a few large and faint. Short, soft, and each on its own angle.
  stage.particles({ count: 620, center: [2, 6, -7], box: [72, 17, 56], velocity: [1.15, -0.9, 0.2], size: [0.014, 0.03], stretch: 0.5, wobble: 0.7, color: [1.5, 1.58, 1.72], opacity: 1, hard: 1.7 });
  stage.particles({ count: 340, center: [3, 5, -3], box: [60, 15, 40], velocity: [1.4, -1.0, 0.3], size: [0.024, 0.05], stretch: 0.7, wobble: 0.9, color: [1.45, 1.52, 1.66], opacity: 0.9, hard: 2.4 });
  stage.particles({ count: 150, center: nearStage(34), box: [32, 15, 18], velocity: [1.7, -1.05, 0.35], size: [0.04, 0.08], stretch: 0.45, wobble: 1.1, color: [1.2, 1.28, 1.4], opacity: 0.42, hard: 3.2 });

  // One stack on the vault's roof, so its plume has somewhere to come from.
  const stackMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.035, 0.038, 0.046), metalness: 0.8, roughness: 0.45 });
  const pipeGeo = new THREE.CylinderGeometry(0.11, 0.13, STACK_H, 14);
  const collarGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.07, 14);
  const pipe = new THREE.Mesh(pipeGeo, stackMat);
  const collar = new THREE.Mesh(collarGeo, stackMat);
  pipe.position.set(STACK[0], STACK[1] + STACK_H * 0.5, STACK[2]);
  collar.position.set(STACK[0], STACK[1] + STACK_H, STACK[2]);
  stage.live.add(pipe, collar);
  // A long unbroken plume: thin at the mouth, thickening and leaning over as the wind takes it.
  stage.particles({ count: 120, center: [STACK[0], STACK[1] + STACK_H + 0.05, STACK[2]], box: [0.7, 0.3, 0.7], velocity: [1.05, 0.14, 0.42], accel: [0.12, -0.012, 0.09], life: 7, size: [0.16, 1.2], wobble: 0.4, breakup: 0.7, color: [0.98, 1.02, 1.1], opacity: 0.38, hard: 1.2, fadeIn: 0.03, fadeOut: 0.4, spin: 0.2 });

  // Steam off the rig, from the hole and the compressor. The wind leans it the same way.
  const steam = (center, count, up, size, life, opacity) => stage.particles({
    count, center, box: [1.0, 0.75, 1.0], velocity: [1.0, up, 0.15], accel: [0.3, 0.02, 0.05], life, size, wobble: 0.45, breakup: 0.85, color: [0.92, 0.96, 1.05], opacity, hard: 1.2, fadeIn: 0.14, fadeOut: 0.3, spin: 0.25,
  });
  steam([5.3, 0.3, 6.5], 72, 0.85, [0.22, 1.25], 4.4, 0.46);
  steam([3.63, 0.85, 6.1], 18, 0.8, [0.08, 0.42], 2.8, 0.34);

  // A little snow lifting off what stands in the wind: the vault's roof edge, the cliff's corner, the crests of the banks.
  const crest = (center, box, count) => stage.particles({
    count, center, box, velocity: [2.0, 0.24, 0.2], accel: [0.5, -0.14, 0.05], life: 1.9, size: [0.06, 0.2], stretch: 1.1, wobble: 0.14, breakup: 0.5, color: [1.25, 1.32, 1.45], opacity: 0.52, hard: 1.8, fadeIn: 0.18, fadeOut: 0.35,
  });
  crest([14.9, 10.02, -13.2], [0.35, 0.06, 1.8], 22);
  crest([13.42, 4.5, -5.94], [0.4, 0.08, 1.2], 16);
  crest([0.3, 0.52, 4.95], [0.7, 0.08, 0.9], 16);
  crest([-11.51, 0.92, -6.46], [0.6, 0.08, 0.9], 14);
  // Long thin soft ribbons off the crests of the banks in the middle and lower left.
  const ribbon = (center) => stage.particles({
    count: 18, center, box: [0.5, 0.05, 0.42], velocity: [2.6, 0.1, 0.34], accel: [0.3, -0.1, 0.04], life: 2.6, size: [0.05, 0.19], stretch: 1.2, wobble: 0.1, breakup: 0.45, color: [1.3, 1.38, 1.52], opacity: 0.56, hard: 1.9, fadeIn: 0.16, fadeOut: 0.3,
  });
  for (const c of [[-1.57, 0.56, 4.66], [-3.27, 0.56, 3.94], [-6, 0.54, 2.6], [-8.63, 0.62, 1.14], [-12.64, 0.65, 0.66], [-15.61, 1.45, -3.45]]) ribbon(c);

  // A rig lamp is the one warm light down on the ice: snow falling through it picks the colour up.
  stage.particles({ count: 36, center: [3.88, 1.35, 7.14], box: [2.6, 2.4, 2.6], velocity: [0.7, -0.75, 0.2], size: [0.018, 0.04], stretch: 0.6, wobble: 0.45, color: [2.4, 1.5, 0.75], opacity: 0.55, hard: 2.6 });

  // Birds crossing high over the forest and out over the white banks, where they read.
  stage.flock({ center: [-24, 9, -6], radius: [28, 0.8, 6], count: 3, size: 0.3, speed: 0.082, spread: 0.035, flap: 7.5, color: '#0b0d12', opacity: 0.95 });
  stage.flock({ center: [6, 6.6, -1], radius: [34, 0.5, 4], count: 2, size: 0.26, speed: -0.06, spread: 0.05, flap: 8.5, color: '#0b0d12', opacity: 0.95 });

  // The beacon on the mast, the one on the rig tower, and the warm slits in the vault's dark side, which breathe unevenly.
  stage.blink(stage.info.spots.vault_mast[0].p, '#ff2616', { period: 2.1, on: 0.3, size: 2.4, opacity: 0.95, dim: 0.05 });
  stage.blink([5.19, 4.5, 6.48], '#ff3a22', { period: 1.55, phase: 0.4, on: 0.34, size: 1.5, opacity: 0.9, dim: 0.06 });
  const WARM = '#ff9a40';
  // Slow and partial: these windows breathe, they never switch.
  const warm = [
    { g: stage.glow([14.43, 4.97, -13.2], WARM, 3.4, 0.2), a: 0.83, b: 2.1, p: 0.2 },
    { g: stage.glow([10.26, 10.45, -13.65], WARM, 5.6, 0.1), a: 0.61, b: 1.7, p: 1.7 },
    { g: stage.glow([3.88, 2.36, 7.14], '#ffb060', 2.2, 0.26), a: 1.3, b: 3.1, p: 3.1 },
  ];

  // ---- the ice: a slow sheen travels over it, and the cracks catch it. A live sheet, cut to the ice by the mask in the motion pass. ----
  const loader = new THREE.TextureLoader();
  // The ice is the one surface at height zero, so the plate's depth says exactly where it is. A mask in the motion field would
  // leak into the bend channel through the webp and warp the cracks.
  const { w: dw, h: dh, near: dNear, far: dFar } = stage.info.depth;
  const depth16 = new Uint16Array(await (await fetch(`${assetsBase}depth.bin`)).arrayBuffer());
  const iceBytes = new Uint8Array(dw * dh);
  {
    const iN = 1 / dNear;
    const iF = 1 / dFar;
    const tanH = Math.tan(THREE.MathUtils.degToRad(hero.hfov) / 2);
    const tanV = Math.tan(THREE.MathUtils.degToRad(hero.vfov) / 2);
    for (let r = 0; r < dh; r += 1) {
      const ny = 1 - ((r + 0.5) / dh) * 2;
      for (let c = 0; c < dw; c += 1) {
        const nx = ((c + 0.5) / dw) * 2 - 1;
        const z = 1 / ((depth16[r * dw + c] / 65535) * (iN - iF) + iF);
        const y = stage.H.y + stage.F.y * z + stage.R.y * nx * tanH * z + stage.U.y * ny * tanV * z;
        iceBytes[r * dw + c] = y < 0.03 ? 255 : 0;
      }
    }
  }
  const maskTex = new THREE.DataTexture(iceBytes, dw, dh, THREE.RedFormat, THREE.UnsignedByteType);
  maskTex.magFilter = THREE.LinearFilter;
  maskTex.minFilter = THREE.LinearMipmapLinearFilter;
  maskTex.generateMipmaps = true;
  maskTex.needsUpdate = true;
  const plateImg = await loader.loadAsync(`${assetsBase}plate.webp`).then((t) => t.image);
  // Half size: the cracks only need finding, and this keeps a second full plate out of memory.
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.getContext('2d').drawImage(plateImg, 0, 0, 1920, 1080);
  const crackTex = new THREE.CanvasTexture(canvas);
  crackTex.colorSpace = THREE.NoColorSpace;
  crackTex.generateMipmaps = true;
  crackTex.minFilter = THREE.LinearMipmapLinearFilter;
  const iceT = { value: 0 };
  const iceGain = { value: 1 };
  const driftGain = { value: 1 };
  const sheetMat = new THREE.ShaderMaterial({
    uniforms: {
      uT: iceT, uGain: iceGain, uDrift: driftGain, tMask: { value: maskTex }, tPlate: { value: crackTex }, uH: { value: stage.H }, uR: { value: stage.R }, uU: { value: stage.U }, uF: { value: stage.F },
      uTanH: { value: Math.tan(THREE.MathUtils.degToRad(hero.hfov) / 2) }, uTanV: { value: Math.tan(THREE.MathUtils.degToRad(hero.vfov) / 2) },
    },
    transparent: true,
    depthWrite: false,
    ...LIGHT_BLEND,
    vertexShader: /* glsl */ `
      varying vec3 vP;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tMask, tPlate;
      uniform vec3 uH, uR, uU, uF;
      uniform float uT, uGain, uDrift, uTanH, uTanV;
      varying vec3 vP;
      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      float lum(vec3 c) { return dot(c, vec3(0.3, 0.5, 0.2)); }
      void main() {
        vec3 d = vP - uH;
        float z = dot(d, uF);
        vec2 uv = vec2(dot(d, uR) / (z * uTanH), dot(d, uU) / (z * uTanV)) * 0.5 + 0.5;
        vec2 iuv = vec2(uv.x, 1.0 - uv.y);
        float ice = smoothstep(0.25, 0.8, texture2D(tMask, iuv).r);
        if (ice < 0.01) discard;
        // A slow soft glint of sky. Only light is added: the ice and its cracks stay exactly where the render put them.
        float s = dot(vP.xz, vec2(0.91, 0.42));
        float b1 = (fract((s - uT * 0.4) / 38.0) - 0.5) * 38.0 / 8.0;
        float band = exp(-b1 * b1);
        float breath = vn(vP.xz * 0.1 + vec2(uT * 0.02, -uT * 0.012));
        float sheen = 0.7 * band + 0.5 * smoothstep(0.3, 0.8, breath);
        // Cracks are what stands brighter than the ice around them.
        float crack = smoothstep(0.03, 0.14, lum(texture2D(tPlate, uv).rgb) - lum(texture2D(tPlate, uv, 3.5).rgb));
        float sparkle = pow(vn(vP.xz * 3.4 + vec2(uT * 0.22, -uT * 0.14)) * vn(vP.xz * 7.1 - vec2(uT * 0.16, uT * 0.27)) * 2.6, 3.0);
        float a = (0.055 * sheen + crack * (0.05 * band + 0.24 * sparkle)) * ice * uGain;
        // Thin threads of snow snaking across the ice on the wind: the level lines of a noise stretched along it, each with a head and a tail.
        float along = dot(vP.xz, vec2(0.985, 0.17));
        float across = dot(vP.xz, vec2(-0.17, 0.985));
        across += 0.7 * sin(along * 0.19 + uT * 0.21) + 0.3 * sin(along * 0.47 - uT * 0.37);
        float r1 = 1.0 - abs(2.0 * vn(vec2(along * 0.13 - uT * 1.0, across * 1.7)) - 1.0);
        float r2 = 1.0 - abs(2.0 * vn(vec2(along * 0.2 - uT * 1.45 + 5.0, across * 2.9 + 7.0)) - 1.0);
        float threads = pow(r1, 5.0) + 0.5 * pow(r2, 8.0);
        float head = smoothstep(0.42, 0.68, vn(vec2(along * 0.22 - uT * 1.6, across * 0.5 + 3.0)));
        float reach = smoothstep(0.24, 0.54, vn(vec2(along * 0.05 - uT * 0.17, across * 0.2 + 2.0)));
        float open = smoothstep(0.6, 1.0, texture2D(tMask, iuv, 3.0).r);
        float drift = 0.52 * threads * head * reach * open * uDrift;
        float all_ = a + drift;
        if (all_ < 0.002) discard;
        gl_FragColor = vec4((vec3(0.62, 0.86, 1.25) * 1.5 * a + vec3(1.15, 1.3, 1.6) * drift) / all_, all_);
      }`,
  });
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(70, 60).rotateX(-Math.PI / 2), sheetMat);
  sheet.position.set(0, 0.11, 5);
  sheet.renderOrder = 2;
  sheet.frustumCulled = false;
  stage.live.add(sheet);

  // ---- the survey flags: cloth in the wind, drawn over the plate's still one and a little larger, so it is covered ----
  const flagGeo = new THREE.BufferGeometry();
  {
    const SEG = 10;
    const pos = [];
    const idx = [];
    for (let i = 0; i <= SEG; i += 1) {
      const k = i / SEG;
      pos.push(k, 0.5 * (1 - k), 0, k, -0.5 * (1 - k), 0);
      if (i < SEG) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    flagGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    flagGeo.setIndex(idx);
  }
  const flagT = { value: 0 };
  const flagGust = { value: 1 };
  const flagMat = new THREE.ShaderMaterial({
    uniforms: { uT: flagT, uGust: flagGust },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uT, uGust;
      varying float vShade;
      void main() {
        float k = position.x;
        float w = k * 6.5 - uT * 10.5 + modelMatrix[3].x * 3.0;
        float w2 = k * 12.0 - uT * 16.0 + modelMatrix[3].z * 2.0;
        float reach = k * (0.35 + 0.65 * k) * uGust;
        vec3 p = position;
        p.y += reach * (0.26 * sin(w) + 0.09 * sin(w2));
        p.z += reach * 0.34 * cos(w * 0.9);
        p.x *= 1.0 - 0.05 * uGust * (0.5 + 0.5 * sin(w * 0.5));
        vShade = 0.86 + 0.26 * cos(w) * k;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vShade;
      void main() { gl_FragColor = vec4(vec3(1.5, 0.2, 0.025) * vShade, 1.0); }`,
  });
  for (const [x, z] of FLAGS) {
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(x, 0.905, z + 0.03);
    flag.scale.set(0.38, 0.26, 0.38);
    flag.frustumCulled = false;
    stage.live.add(flag);
  }

  // ---- a gust shakes a tree: a small cloud of snow comes off the branches and falls away downwind ----
  const puffGeo = new THREE.InstancedBufferGeometry();
  puffGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  puffGeo.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
  puffGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const puffN = PUFFS * PUFF_BITS;
  const puffSeed = new Float32Array(puffN * 4);
  const puffIdx = new Float32Array(puffN);
  for (let i = 0; i < puffN; i += 1) {
    for (let k = 0; k < 4; k += 1) puffSeed[i * 4 + k] = stage.rand();
    puffIdx[i] = Math.floor(i / PUFF_BITS);
  }
  puffGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(puffSeed, 4));
  puffGeo.setAttribute('aIdx', new THREE.InstancedBufferAttribute(puffIdx, 1));
  puffGeo.instanceCount = puffN;
  const puffState = Array.from({ length: PUFFS }, () => new THREE.Vector4(0, 0, 0, 99));
  const puffMat = new THREE.ShaderMaterial({
    uniforms: { uPuff: { value: puffState } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed; attribute float aIdx; attribute vec2 corner;
      uniform vec4 uPuff[${PUFFS}];
      varying vec2 vC; varying float vA;
      void main() {
        vec4 f = uPuff[int(aIdx)];
        float t = f.w - aSeed.w * 0.5;
        if (t < 0.0 || t > ${PUFF_LIFE.toFixed(1)}) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; vC = vec2(0.0); return; }
        float k = t / ${PUFF_LIFE.toFixed(1)};
        vec3 o = (aSeed.xyz - 0.5) * vec3(1.1, 1.3, 1.1);
        vec3 p = f.xyz + o * (0.45 + 0.7 * k) + vec3(1.15, -0.1, 0.25) * t - vec3(0.0, 0.34 * t * t, 0.0);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float size = mix(0.16, 0.3, k) * (0.45 + 1.2 * aSeed.y * aSeed.y);
        mv.xy += corner * size;
        gl_Position = projectionMatrix * mv;
        vC = corner * 2.0;
        vA = smoothstep(0.0, 0.1, k) * pow(1.0 - k, 1.5);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vC; varying float vA;
      void main() {
        float r = dot(vC, vC);
        if (r > 1.0) discard;
        float a = pow(1.0 - r, 2.6) * vA * 0.42;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vec3(1.05, 1.12, 1.25) * a, a);
      }`,
  });
  const puffs = new THREE.Mesh(puffGeo, puffMat);
  puffs.frustumCulled = false;
  puffs.renderOrder = 17;
  stage.live.add(puffs);

  const swellNow = (t) => 0.5 + 0.32 * Math.sin(t * 0.23 + 0.6) + 0.18 * Math.sin(t * 0.53 + 2.1);
  // The same gust the shader runs, so the snow comes off as its front reaches each tree.
  const gustAt = (x, z, t) => Math.sin(x * WIND_SCALE - t * 0.62 * WIND_SPEED + 1.7 * Math.sin(z * WIND_SCALE * 0.7 + t * 0.11));
  const crownWas = new Float32Array(CROWNS.length).fill(-1);
  let nextPuff = 0;
  let puffGap = 0;
  let dice = 48271;
  const roll = () => { dice = (dice * 48271) % 2147483647; return dice / 2147483647; };

  stage.onUpdate((dt, t) => {
    iceT.value = t;
    flagT.value = t;
    flagGust.value = 0.65 + 0.5 * swellNow(t);
    // A slow swell under the travelling gusts: some minutes the valley is almost calm, then the whole forest leans.
    const swell = swellNow(t);
    wind.wind.amount = 0.00105 + 0.00095 * swell;
    stage.life(wind);
    driftGain.value = 0.55 + 0.6 * swell;
    // The mist breathes.
    mist.fog.amount = 0.2 + 0.05 * Math.sin(t * 0.37) + 0.02 * Math.sin(t * 0.91 + 1.2);
    stage.life(mist);
    iceGain.value = 0.85 + 0.25 * Math.sin(t * 0.29 + 1.0);
    for (const w of warm) w.g.set(w.g.base * (0.85 + 0.1 * Math.sin(t * w.a + w.p) + 0.05 * Math.sin(t * w.b + w.p * 2.0)));

    for (const f of puffState) f.w += dt;
    puffGap -= dt;
    for (let i = 0; i < CROWNS.length; i += 1) {
      const c = CROWNS[i];
      const g = gustAt(c[0], c[2], t);
      // Only as the front arrives, only some trees, and not all at once.
      if (crownWas[i] < 0.86 && g >= 0.86 && puffGap <= 0 && roll() < 0.42 + 0.4 * swell) {
        const f = puffState[nextPuff];
        f.set(c[0], c[1], c[2], 0);
        nextPuff = (nextPuff + 1) % PUFFS;
        puffGap = 2.3;
      }
      crownWas[i] = g;
    }
  });

  return () => {
    sheet.geometry.dispose();
    sheetMat.dispose();
    maskTex.dispose();
    crackTex.dispose();
    flagGeo.dispose();
    flagMat.dispose();
    puffGeo.dispose();
    puffMat.dispose();
    pipeGeo.dispose();
    collarGeo.dispose();
    stackMat.dispose();
  };
}

export async function createIsland(ctx) {
  const { config, quality, mascots, scene } = ctx;
  const stage = await createStage(ctx, { motion: true, flow: 0.55, water: 0, pulse: 0.55, envIntensity: 1.05, sparkSize: 0.1 });
  const disposeWorld = await bringWorldAlive(ctx, stage);
  const { info } = stage;
  const { spots } = info;
  const vec = (a) => new THREE.Vector3().fromArray(a);
  const Y = new THREE.Vector3(0, 1, 0);
  const uT = { value: 0 };

  // Station lights use the same deepened colour the render gave its LEDs, or they wash out next to the plate.
  const ledOf = (hex) => {
    const c = new THREE.Color(hex);
    const m = Math.max(c.r, c.g, c.b) || 1;
    c.setRGB((c.r / m) ** 1.7, (c.g / m) ** 1.7, (c.b / m) ** 1.7);
    return `#${c.getHexString()}`;
  };
  stage.bindGroup('drill', ledOf(config.bots[0].color));
  stage.bindGroup('tow', ledOf(config.bots[1].color));

  // Soft shadows for what the plate does not show. The sun is low on the left, so they run long to the right.
  const shadowTex = (() => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, size * 0.12, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.62)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  })();
  const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, color: 0x000000, transparent: true, depthWrite: false, opacity: 0.6 });
  const SUN_RUN = Math.atan2(-0.36, 0.84);
  const shadowCard = (parent, x, y, z, lx, lz, rotY = 0, opacity = 1) => {
    const m = new THREE.Mesh(shadowGeo, opacity === 1 ? shadowMat : Object.assign(shadowMat.clone(), { opacity: 0.6 * opacity }));
    m.position.set(x, y, z);
    m.scale.set(lx, 1, lz);
    m.rotation.y = rotY;
    m.renderOrder = 1;
    parent.add(m);
    return m;
  };

  // Parts painted in the bot's colour are live, so they can follow whatever colour the team has.
  const paint = (node, hex) => {
    node.traverse((o) => {
      if (!o.isMesh || !o.material?.name) return;
      if (o.material.name.startsWith('flat_bot')) o.material.color.set(hex);
      if (o.material.name.startsWith('flat_led')) o.material.emissive.set(hex);
    });
  };

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
  const driller = await makeBot(config.bots[0], 'drill', { rhythm: 0.8, lean: 0.12 });
  const hauler = await makeBot(config.bots[1], 'tow', { rhythm: 0.5, lean: 0.15 });
  const lead = await makeBot(config.lead, 'lead', { rhythm: 0.3, lean: 0.07 });
  const bots = { drill: driller, tow: hauler, lead };
  const state = { drill: 'idle', tow: 'idle', lead: 'idle' };
  const activity = { drill: 'idle', tow: 'idle', lead: 'idle' };
  const pending = { drill: false, tow: false, lead: false };
  const settle = { drill: 0, tow: 0, lead: 0 };
  const busy = (k) => activity[k] === 'working';

  const posOf = (k) => vec(info.bots[k].p);
  const dp = posOf('drill');
  const tp = posOf('tow');
  const lp = posOf('lead');

  // The bots are not in the plate, so they cast no reflection there. A soft smear under each stands in for it on the gloss.
  const smear = (key, hex) => {
    const b = info.bots[key];
    const g = stage.glow(vec(b.p).add(new THREE.Vector3(0, -b.size * 0.62, 0.05)), hex, 1, 0.16);
    g.sprite.scale.set(b.size * 0.92, b.size * 1.5, 1);
    return g;
  };
  smear('drill', config.bots[0].color);
  smear('tow', config.bots[1].color);
  // Their long shadows on the ice, which went out of the plate along with them.
  for (const k of ['drill', 'tow']) {
    const b = info.bots[k];
    const len = b.size * 2.5;
    shadowCard(stage.live, b.p[0] + Math.cos(SUN_RUN) * len * 0.46, 0.13, b.p[2] - Math.sin(SUN_RUN) * len * 0.46, len, b.size * 0.92, SUN_RUN, 0.85);
  }

  // The wrench is live and goes with the bot. It rocks as if it were working the brake on the rig.
  const tool = stage.copy('tool_drill');
  driller.object.add(tool);
  tool.position.set(0.62, 0.5, 0.2);
  tool.scale.setScalar(0.92);
  tool.rotation.set(0.1, -0.3, -0.42);

  // ---------- core: there are dozens on screen, so one mesh each, with its colours kept per vertex ----------
  {
    const proto = stage.actor('core');
    stage.live.remove(proto);
    const parts = [];
    proto.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) { col[i * 3] = o.material.color.r; col[i * 3 + 1] = o.material.color.g; col[i * 3 + 2] = o.material.color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(a)) g.deleteAttribute(a);
      parts.push(g);
    });
    while (proto.children.length) proto.remove(proto.children[0]);
    proto.add(new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.24, metalness: 0 })));
  }

  // ---------- core flights: short hops from one place to the next ----------
  const flights = Array.from({ length: 8 }, () => {
    const node = stage.copy('core');
    node.visible = false;
    return { node, active: false, t: 0, dur: 1, a: new THREE.Vector3(), b: new THREE.Vector3(), h: 1, y0: 0, y1: 0, s: 1, cb: null };
  });
  const fly = (from, to, { y0 = 0, y1 = 0, s = 1.8, h = 1, dur = 0.9, cb = null } = {}) => {
    const f = flights.find((x) => !x.active);
    if (!f) { cb?.(); return; }
    f.active = true; f.t = 0; f.dur = dur; f.h = h; f.y0 = y0; f.y1 = y1; f.s = s; f.cb = cb;
    f.a.copy(from); f.b.copy(to);
    f.node.position.copy(from);
    f.node.rotation.set(0, y0, 0);
    f.node.scale.setScalar(s);
    f.node.visible = true;
  };
  stage.onUpdate((dt) => {
    for (const f of flights) {
      if (!f.active) continue;
      f.t += dt / f.dur;
      const k = smooth(f.t);
      f.node.position.lerpVectors(f.a, f.b, k);
      f.node.position.y += 4 * f.h * k * (1 - k);
      f.node.rotation.y = f.y0 + (f.y1 - f.y0) * k;
      if (f.t >= 1) {
        f.active = false;
        f.node.visible = false;
        const cb = f.cb;
        f.cb = null;
        cb?.();
      }
    }
  });

  // ---------- the rig ----------
  const string = stage.actor('drill_string');
  const head = stage.actor('drill_head');
  paint(head, config.bots[0].color);
  const stringY = string.position.y;
  const headY = head.position.y;
  const spinner = stage.machine(string, Y, { idle: 0.9, working: 7.5, ease: 1.4 });
  const winch = stage.actor('winch_drum');
  paint(winch, config.bots[0].color);
  const winchAxis = vec(spots.winch_axis[0].p).sub(winch.position).normalize();
  const winchMachine = stage.machine(winch, winchAxis, { idle: 0.25, working: 1.7, ease: 1 });
  const lever = stage.actor('lever');
  const leverAxis = vec(spots.lever_axis[0].p).sub(lever.position).normalize();
  const leverHome = lever.quaternion.clone();
  const holePos = vec(spots.hole[0].p);
  const tray = stage.pile('tray', 'core', spots.tray, 11);
  const cradleSpot = spots.cradle[0];
  const cradle = stage.copy('core', cradleSpot);
  cradle.visible = false;
  let drillPhase = 0.2;
  let drillRate = 0.14;
  let drillCycles = 0;
  let cradleBorn = -10;

  // ---------- the capstan, the sleds and the tow rope ----------
  const capstan = stage.actor('capstan');
  paint(capstan, config.bots[1].color);
  // Taller than it was built, not wider: the bars have to clear both the bot and the lane.
  capstan.scale.set(1.1, 1.5, 1.1);
  const capstanMachine = stage.machine(capstan, Y, { idle: 0.3, working: 2.3, ease: 1 });
  const ropeCap = vec(spots.capstan_rope[0].p);
  const ropePost = vec(spots.post_rope[0].p);
  const lift = (pts, y) => pts.map((p) => new THREE.Vector3(p.x, y, p.z));
  // A little above the ice, or the runners would flicker against the plate's depth steps.
  const upLane = lift(stage.path('sled_up'), 0.07);
  const downLane = lift(stage.path('sled_down'), 0.07);
  const dock = downLane[downLane.length - 1];
  const foot = upLane[upLane.length - 1];
  const turn = (a, b, ahead) => {
    const m = a.clone().lerp(b, 0.5);
    const along = ahead.clone().setY(0).normalize().multiplyScalar(1.1);
    return m.add(along);
  };
  const upPath = [dock, turn(dock, upLane[0], dock.clone().sub(downLane[downLane.length - 3])), ...upLane];
  const downPath = [foot, turn(foot, downLane[0], foot.clone().sub(upLane[upLane.length - 3])), ...downLane];
  const ropeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.05, 0.055, 0.065), metalness: 0.7, roughness: 0.5 });
  const ropeGeo = new THREE.CylinderGeometry(1, 1, 1, 6).rotateX(Math.PI / 2);
  const SLED_SCALE = 1.1;
  const coreSpots = spots.sled_core;
  const makeSled = (offset) => {
    const node = stage.copy('sled');
    node.scale.setScalar(SLED_SCALE);
    const straps = stage.copy('sled_straps', null, node);
    straps.position.set(0, 0, 0);
    const cores = coreSpots.map((s) => stage.copy('core', s, node));
    const rope = new THREE.Mesh(ropeGeo, ropeMat);
    rope.visible = false;
    stage.live.add(rope);
    // One close under the runners that turns with the sled, one thrown out towards the right that does not.
    shadowCard(node, 0, 0.05, 0.1, 1.75, 3.5);
    // Short and soft. A long one ran off the ice and stained the snow edge.
    const cast = shadowCard(stage.live, 0, 0.13, 0, 2.5, 1.5, SUN_RUN, 0.45);
    return { node, straps, cores, rope, offset, cast, n: 0, yaw: null };
  };
  const sleds = Array.from({ length: SLEDS }, (_, i) => makeSled(i / SLEDS));
  let loop = 0.03;
  let loopRate = 1 / 70;
  const wantedLoad = (p) => {
    if (p < AT_DOCK) return Math.min(SLED_LOAD, Math.floor(SLED_LOAD * p / (AT_DOCK * 0.85)));
    if (p < AT_DOCK + HAUL) return SLED_LOAD;
    if (p < AT_DOCK + HAUL + AT_RAIL) return Math.max(0, SLED_LOAD - Math.floor(SLED_LOAD * (p - AT_DOCK - HAUL) / (AT_RAIL * 0.85)));
    return 0;
  };
  const sledYaw = (s) => (s.yaw ?? 0);
  const a0 = new THREE.Vector3();
  const a1 = new THREE.Vector3();
  const place = (s, p, dt) => {
    let path = null;
    let k = 0;
    const stopped = p < AT_DOCK || (p >= AT_DOCK + HAUL && p < AT_DOCK + HAUL + AT_RAIL);
    if (p < AT_DOCK) { path = downPath; k = 0.995; } else if (p < AT_DOCK + HAUL) {
      path = upPath; k = (p - AT_DOCK) / HAUL;
    } else if (p < AT_DOCK + HAUL + AT_RAIL) { path = upPath; k = 0.995; } else {
      path = downPath; k = (p - AT_DOCK - HAUL - AT_RAIL) / BACK;
    }
    {
      const g = glide(k);
      pointAlongRoute(path, g, a0);
      pointAlongRoute(path, Math.min(1, g + 0.012), a1);
      if (stopped) s.node.position.copy(p < AT_DOCK ? dock : foot); else s.node.position.copy(a0);
      const dx = a1.x - a0.x;
      const dz = a1.z - a0.z;
      if (Math.abs(dx) + Math.abs(dz) > 1e-4) {
        const want = Math.atan2(-dx, -dz);
        if (s.yaw === null) s.yaw = want;
        const d = THREE.MathUtils.euclideanModulo(want - s.yaw + Math.PI, Math.PI * 2) - Math.PI;
        s.yaw += d * Math.min(1, dt * 3.2);
      }
    }
    s.node.rotation.y = sledYaw(s);
    s.cast.position.set(s.node.position.x + Math.cos(SUN_RUN) * 0.55, 0.13, s.node.position.z - Math.sin(SUN_RUN) * 0.55);
  };
  const sledFront = new THREE.Vector3();
  const ropeA = new THREE.Vector3();
  const ropeTo = new THREE.Vector3();
  const hauledShare = (s) => {
    const p = (loop + s.offset) % 1;
    return p >= AT_DOCK && p < AT_DOCK + HAUL ? (p - AT_DOCK) / HAUL : -1;
  };
  const CAPSTAN_SHARE = 0.5;
  // The sleds are a convoy on one line: each rope runs to the tail of the sled ahead, and the first of each reach to its anchor.
  const updateRope = (s) => {
    const k = hauledShare(s);
    s.rope.visible = k >= 0;
    if (k < 0) return;
    const anchor = k < CAPSTAN_SHARE ? ropeCap : ropePost;
    let ahead = null;
    let best = Infinity;
    for (const o of sleds) {
      const ko = hauledShare(o);
      if (o === s || ko < 0 || ko <= k || (k < CAPSTAN_SHARE) !== (ko < CAPSTAN_SHARE)) continue;
      if (ko < best) { best = ko; ahead = o; }
    }
    sledFront.set(-Math.sin(s.node.rotation.y), 0, -Math.cos(s.node.rotation.y)).multiplyScalar(1.75 * SLED_SCALE);
    ropeA.copy(s.node.position).add(sledFront);
    ropeA.y = 0.42;
    if (ahead) {
      ropeTo.set(Math.sin(ahead.node.rotation.y), 0, Math.cos(ahead.node.rotation.y)).multiplyScalar(1.3 * SLED_SCALE).add(ahead.node.position);
      ropeTo.y = 0.42;
    } else {
      ropeTo.copy(anchor);
    }
    const len = ropeA.distanceTo(ropeTo);
    s.rope.position.lerpVectors(ropeA, ropeTo, 0.5);
    s.rope.scale.set(0.014, 0.014, Math.max(0.01, len));
    s.rope.lookAt(ropeTo);
  };

  // Set the first frame directly: a sled on the way up already has its load, one on the way back is empty.
  for (const s of sleds) {
    const p = (loop + s.offset) % 1;
    s.n = wantedLoad(p);
    s.cores.forEach((c, i) => { c.visible = i < s.n; });
    s.straps.visible = s.n >= SLED_LOAD;
    place(s, p, 1);
  }

  // ---------- the rail up the bluff ----------
  // Two skips ride it, always going up. Each comes out of the sleds' stop at the foot and goes into the hoist house at the top.
  const ramp = stage.path('ramp');
  const carts = [0, 0.5].map((offset) => {
    const node = new THREE.Group();
    stage.live.add(node);
    const body = stage.copy('cart', null, node);
    const load = stage.copy('cart_load', null, node);
    body.position.set(0, 0, 0);
    load.position.set(0, 0, 0);
    return { node, offset, last: 0 };
  });
  let railPhase = 0.2;
  let railRate = 0.05;
  const stock = stage.pile('stock', 'core', spots.stock, 9);
  const setCarts = () => {
    for (const c of carts) {
      const k = (railPhase + c.offset) % 1;
      c.node.position.lerpVectors(ramp[0], ramp[1], k);
      c.node.scale.setScalar(Math.max(0.01, smooth(k / 0.07) * (1 - smooth((k - 0.93) / 0.07))));
      c.k = k;
    }
  };
  setCarts();
  for (const c of carts) c.last = c.k;

  // ---------- the vault: one draw for all the cells, and one for the light they spill ----------
  const cellSpots = spots.cell;
  const CELLS = cellSpots.length;
  const aLit = new THREE.InstancedBufferAttribute(new Float32Array(CELLS), 1);
  aLit.setUsage(THREE.DynamicDrawUsage);
  const aSeed = new THREE.InstancedBufferAttribute(new Float32Array(CELLS), 1);
  for (let i = 0; i < CELLS; i += 1) aSeed.setX(i, stage.rand());
  const hexGeo = new THREE.CircleGeometry(1, 6, Math.PI / 2);
  hexGeo.setAttribute('aLit', aLit);
  hexGeo.setAttribute('aSeed', aSeed);
  const cellMat = new THREE.ShaderMaterial({
    uniforms: { uT },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute float aLit; attribute float aSeed;
      varying float vLit; varying float vSeed; varying vec2 vP;
      void main() {
        vLit = aLit; vSeed = aSeed; vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }`,
    // A cell is lit from inside: a hot heart, deep amber out to the edge, each one a little different. These are scene
    // values, so they go through the same AgX curve as the render, and deep colour keeps them from washing out to peach.
    fragmentShader: /* glsl */ `
      uniform float uT;
      varying float vLit; varying float vSeed; varying vec2 vP;
      void main() {
        if (vLit < 0.004) discard;
        float r = length(vP);
        vec3 deep = vec3(1.0, 0.13, 0.004);
        vec3 mid = vec3(1.0, 0.25, 0.012);
        vec3 hot = vec3(1.0, 0.46, 0.07);
        vec3 c = mix(mid * 1.55, deep * 0.6, smoothstep(0.2, 0.95, r));
        c += hot * 2.1 * smoothstep(0.62, 0.0, r);
        c *= (0.62 + 0.62 * vSeed) * (0.9 + 0.1 * sin(uT * (0.5 + vSeed * 0.9) + vSeed * 40.0));
        // Not fully opaque, so the plate's own shading stays in the socket under the light.
        gl_FragColor = vec4(c * vLit, min(1.0, vLit) * mix(0.9, 0.72, smoothstep(0.2, 1.0, r)));
      }`,
  });
  const cells = new THREE.InstancedMesh(hexGeo, cellMat, CELLS);
  const haloGeo = new THREE.PlaneGeometry(2, 2);
  haloGeo.setAttribute('aLit', aLit);
  const haloMat = new THREE.ShaderMaterial({
    uniforms: {},
    transparent: true,
    depthWrite: false,
    ...LIGHT_BLEND,
    vertexShader: /* glsl */ `
      attribute float aLit;
      varying float vLit; varying vec2 vP;
      void main() {
        vLit = aLit; vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position.xy * 1.9, 0.12, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vLit; varying vec2 vP;
      void main() {
        float r = length(vP);
        float a = pow(max(0.0, 1.0 - r), 2.4) * 0.2 * min(vLit, 2.4);
        if (a < 0.002) discard;
        gl_FragColor = vec4(vec3(1.0, 0.3, 0.03) * 2.2, a);
      }`,
  });
  const halos = new THREE.InstancedMesh(haloGeo, haloMat, CELLS);
  const m4 = new THREE.Matrix4();
  const q4 = new THREE.Quaternion();
  const s4 = new THREE.Vector3();
  cellSpots.forEach((c, i) => {
    q4.setFromAxisAngle(Y, c.yaw);
    s4.setScalar(c.s);
    m4.compose(vec(c.p), q4, s4);
    cells.setMatrixAt(i, m4);
    halos.setMatrixAt(i, m4);
  });
  cells.frustumCulled = false;
  halos.frustumCulled = false;
  cells.renderOrder = 5;
  halos.renderOrder = 6;
  stage.live.add(cells, halos);
  const litValue = new Float32Array(CELLS);
  const litFlash = new Float32Array(CELLS);
  let litCount = 0;
  const setLit = (n) => {
    litCount = Math.max(0, Math.min(CELLS, n));
    for (let i = 0; i < CELLS; i += 1) litValue[i] = i < litCount ? 1 : 0;
  };
  setLit(CELLS_START);
  const vaultCentre = vec(spots.vault_centre[0].p);
  const vaultGlow = stage.glow(vaultCentre, AMBER, 11, 0.1);
  const mast = vec(spots.vault_mast[0].p);
  const mastGlow = stage.glow(mast, AMBER, 3, 0);
  let mastFlare = 0;
  let draining = 0;
  const vaultTag = vaultCentre.clone().add(new THREE.Vector3(-3.1, 0.4, 2.2));
  const showCount = () => stage.tag('vault', vaultTag, `${litCount}/${CELLS}`);
  showCount();

  const lightCell = () => {
    if (litCount >= CELLS) return;
    const i = litCount;
    litCount += 1;
    litValue[i] = 1;
    litFlash[i] = 1;
    const c = vec(cellSpots[i].p);
    stage.sparks(c, AMBER, 9, { speed: 0.9, spread: 0.8, up: 0.5, life: 0.9 });
    lead.press(0.7);
    showCount();
    if (litCount >= CELLS) { mastFlare = 1; draining = -2.5; }
  };

  // ---------- the lead's slot: a core comes off the dock, floats across the face, turns and goes in ----------
  const slotNode = stage.copy('core');
  slotNode.visible = false;
  const slotRing = stage.copy('slot_ring');
  slotRing.visible = false;
  const slot = { s: 'wait', t: 0, wait: 2.2, from: new THREE.Vector3(), hover: new THREE.Vector3(), into: new THREE.Vector3(), yaw: cellSpots[0].yaw };
  const normalAt = (yaw) => new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const updateSlot = (dt) => {
    if (slot.s === 'wait') {
      slot.wait -= dt;
      if (slot.wait > 0 || litCount >= CELLS || stock.count === 0 || draining !== 0) return;
      const spot = spots.stock[Math.max(0, stock.count - 1)];
      slot.from.fromArray(spot.p);
      stock.set(stock.count - 1);
      const c = cellSpots[litCount];
      const n = normalAt(c.yaw);
      slot.into.fromArray(c.p).addScaledVector(n, 0.3);
      slot.hover.fromArray(c.p).addScaledVector(n, 2.1);
      slot.yaw = c.yaw;
      slot.s = 'rise';
      slot.t = 0;
      slotNode.visible = true;
      slotRing.visible = true;
      slotNode.scale.set(4.2, 4.2, 2.2);
    }
    const speed = busy('lead') ? 1 : 0.5;
    slot.t += dt * speed;
    if (slot.s === 'rise') {
      const k = smooth(slot.t / 1.5);
      slotNode.position.lerpVectors(slot.from, slot.hover, k);
      slotNode.position.y += 0.9 * Math.sin(Math.PI * k);
      // Side on while it crosses, so its length and layers show, then nose first towards the cell.
      slotNode.rotation.set(0, slot.yaw + (Math.PI / 2) * (1 - smooth((k - 0.55) / 0.45)), 0);
      if (slot.t >= 1.5) { slot.s = 'push'; slot.t = 0; }
    } else if (slot.s === 'push') {
      const k = smooth(slot.t / 0.8);
      slotNode.position.lerpVectors(slot.hover, slot.into, k);
      slotNode.scale.set(4.2, 4.2, 2.2 * (1 - 0.55 * k));
      slotNode.rotation.set(0, slot.yaw, 0);
      if (slot.t >= 0.8) {
        slotNode.visible = false;
        slotRing.visible = false;
        lightCell();
        slot.s = 'wait';
        slot.wait = busy('lead') ? 2.6 : 11 + stage.rand() * 3;
      }
    }
    if (slotNode.visible) {
      slotRing.position.copy(slotNode.position);
      slotRing.rotation.set(0, slotNode.rotation.y, 0);
      slotRing.scale.setScalar(1 + 0.05 * Math.sin(stage.clock * 6));
    }
  };

  // ---------- express: what a done sends down the line, inside its 2.5 seconds ----------
  const makeExpress = () => {
    const group = new THREE.Group();
    stage.live.add(group);
    const body = stage.copy('sled', null, group);
    body.rotation.y = Math.PI;
    const load = stage.copy('sled_straps', null, body);
    load.position.set(0, 0, 0);
    shadowCard(body, 0, 0.05, 0.1, 1.75, 3.5);
    coreSpots.forEach((s) => stage.copy('core', s, body));
    return stage.runner('sled', [new THREE.Vector3(), new THREE.Vector3(0, 0, 1)], { speed: 1, scale: SLED_SCALE, node: group, face: true });
  };
  const express = [makeExpress(), makeExpress()];
  const playLeg = (route, onDone) => {
    const r = express.find((e) => !e.active) ?? express[0];
    const pts = route.length > 3 ? route.slice(1, -1) : route;
    const len = Math.max(0.01, routeLength(pts));
    r.go(len / 2.2, (run) => { run.node.visible = false; onDone?.(); }, pts);
  };

  // ---------- the aurora: the plate's curtain drifts on its mask, this one flares over it in the bot's colour ----------
  const curtain = stage.actor('aurora_live');
  const flare = { level: 0, want: 0, color: new THREE.Color(TEAL), base: new THREE.Color(TEAL) };
  const curtainU = { uT, uColor: { value: flare.color }, uBase: { value: flare.base }, uLevel: { value: 0 }, uZ0: { value: 8.7 } };
  const curtainMat = new THREE.ShaderMaterial({
    uniforms: curtainU,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    ...LIGHT_BLEND,
    vertexShader: /* glsl */ `
      varying vec3 vP;
      void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uLevel, uZ0;
      uniform vec3 uColor, uBase;
      varying vec3 vP;
      void main() {
        float s = vP.x * 0.8 + vP.z * 0.6;
        float ray = 0.5 + 0.5 * sin(s * 1.5 + uT * 0.32 + 2.2 * sin(s * 0.27 - uT * 0.11));
        ray *= 0.62 + 0.38 * sin(s * 4.7 - uT * 0.55 + sin(s * 0.8 + uT * 0.2));
        ray = pow(max(ray, 0.0), 1.5);
        float env = smoothstep(uZ0 - 0.4, uZ0 + 4.6, vP.y);
        float idle = 0.05 * ray * env;
        // A flare reaches further down the curtain than its resting light does, and fades out before the sheet's lower edge.
        float reach = smoothstep(uZ0 - 0.1, uZ0 + 3.0, vP.y);
        float flare = min(0.92, uLevel * (0.3 + 0.7 * ray) * reach * 1.3);
        float a = idle + flare;
        if (a < 0.002) discard;
        vec3 c = (uBase * idle * 1.4 + uColor * flare * 2.2) / max(a, 0.001);
        gl_FragColor = vec4(c, a);
      }`,
  });
  curtain.traverse((o) => { if (o.isMesh) o.material = curtainMat; });
  // The frame has no sky for an aurora to live in. Over the trees it read as a light leak.
  curtain.visible = false;
  // Just nearer than the plate's own sheet, which is in the depth map.
  curtain.position.z += 1.2;
  curtain.position.y += 0.1;
  // The same light on the ice. It sits just over the ice, so the plate's banks and trees hide it where they should.
  const iceU = { uT, uColor: { value: flare.color }, uLevel: { value: 0 } };
  const iceMat = new THREE.ShaderMaterial({
    uniforms: iceU,
    transparent: true,
    depthWrite: false,
    ...LIGHT_BLEND,
    vertexShader: /* glsl */ `
      varying vec3 vP;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float uT, uLevel;
      uniform vec3 uColor;
      varying vec3 vP;
      void main() {
        float s = vP.x * 0.8 + vP.z * 0.25;
        float ray = 0.5 + 0.5 * sin(s * 1.5 + uT * 0.32 + 2.2 * sin(s * 0.27 - uT * 0.11));
        float a = uLevel * (0.25 + 0.75 * ray * ray) * 0.2;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor * 2.0, a);
      }`,
  });
  const iceFlare = new THREE.Mesh(new THREE.PlaneGeometry(70, 60).rotateX(-Math.PI / 2), iceMat);
  iceFlare.position.set(0, 0.12, 5);
  iceFlare.renderOrder = 2;
  iceFlare.frustumCulled = false;
  iceFlare.visible = false;
  stage.live.add(iceFlare);

  // ---------- worlds ----------
  const up = (k, y) => posOf(k).add(new THREE.Vector3(0, y, 0));
  const nearestTo = (list, p) => {
    let best = 0;
    let d = Infinity;
    list.forEach((q, i) => {
      const e = Math.hypot(q.x - p.x, q.z - p.z);
      if (e < d) { d = e; best = i; }
    });
    return best;
  };
  const split = nearestTo(upLane, tp);
  const lowerReach = upLane.slice(0, Math.max(1, split - 2));
  const upperReach = upLane.slice(split + 3);
  const rampPts = [ramp[0], ramp[1]];
  const drillWorld = stage.worldRecord({
    anchorAt: up('drill', info.bots.drill.size * 1.2),
    center: dp.clone().add(new THREE.Vector3(-1.6, 1.0, -0.8)),
    zoom: 2,
    route: [dp, ...lowerReach, tp, ...upperReach, ...rampPts, lp],
  });
  drillWorld.handoff = lowerReach.length + 1;
  const towWorld = stage.worldRecord({
    anchorAt: up('tow', info.bots.tow.size * 1.2),
    center: tp.clone().add(new THREE.Vector3(1.4, 1.0, 0)),
    zoom: 2,
    route: [tp, ...upperReach, ...rampPts, lp],
  });
  const main = stage.worldRecord({
    anchorAt: up('lead', info.bots.lead.size * 1.08),
    center: lp.clone().add(new THREE.Vector3(-1.8, 0.2, 0)),
    zoom: 2,
  });
  const worlds = new Map();
  worlds.set(config.bots[0].id, drillWorld);
  worlds.set(config.bots[1].id, towWorld);

  const keyOf = (world) => (world === drillWorld ? 'drill' : world === towWorld ? 'tow' : 'lead');
  const LEVELS = { idle: 0.28, working: 1, found: 1.5, done: 0.8, needs_approval: 0.45 };
  const botHex = { drill: config.bots[0].color, tow: config.bots[1].color, lead: config.lead.color };

  function applyEvent(evt, world) {
    const key = keyOf(world);
    const bot = bots[key];
    pending[key] = !!evt.pending;
    activity[key] = evt.activity ?? activity[key];
    if (evt.catchup) {
      if (!evt.pending) bot.clearApproval();
      state[key] = evt.pending ? 'needs_approval' : evt.activity;
      bot.setState(state[key]);
      stage.setLevel(key, LEVELS[state[key]] ?? 0.28);
      settle[key] = 0;
      return;
    }
    bot.setState(evt.type, { value: evt.intensity });
    if (evt.type === 'found') {
      stage.setLevel(key, LEVELS.found);
      flare.color.set(botHex[key]);
      flare.want = 0.3 + 0.7 * (evt.intensity ?? 0.5);
      flare.level = Math.max(flare.level, flare.want * 0.35);
      settle[key] = 3.5;
      if (typeof evt.value === 'number' && Number.isFinite(evt.value)) {
        stage.chip(world.anchor.position.clone(), `+${Math.round(evt.value)}`, botHex[key]);
      }
      return;
    }
    if (evt.type === 'done') {
      stage.setLevel(key, LEVELS.done);
      settle[key] = 3;
      if (key === 'drill') {
        if (tray.count < tray.capacity) tray.add(1);
        if (evt.route?.length) playLeg(evt.route);
      } else if (key === 'tow') {
        if (evt.route?.length) {
          playLeg(evt.route, () => {
            if (stock.count < stock.capacity) stock.add(1);
          });
        }
      } else {
        lightCell();
        mastFlare = Math.max(mastFlare, 0.6);
      }
      return;
    }
    state[key] = evt.type;
    settle[key] = 0;
    stage.setLevel(key, LEVELS[evt.type] ?? 0.28);
  }

  function update(dt, t) {
    uT.value = t;
    for (const b of Object.values(bots)) b.update(dt);

    // A found or done plays over the job, then the bot goes back to what it was doing.
    for (const k of Object.keys(settle)) {
      if (settle[k] <= 0) continue;
      settle[k] -= dt;
      if (settle[k] <= 0) {
        const next = pending[k] ? 'needs_approval' : activity[k];
        state[k] = next;
        bots[k].setState(next);
        stage.setLevel(k, LEVELS[next] ?? 0.28);
      }
    }

    // ---- the rig: the string spins and plunges, each full stroke brings up a core ----
    const drilling = busy('drill');
    stage.setMachines([spinner, winchMachine], drilling);
    drillRate += ((drilling ? 0.42 : 0.1) - drillRate) * (1 - Math.exp(-dt * 1.2));
    drillPhase += dt * drillRate;
    const cyc = drillPhase - Math.floor(drillPhase);
    // Slow on the way down, quick on the way up.
    const depth = cyc < 0.68 ? smooth(cyc / 0.68) : 1 - smooth((cyc - 0.68) / 0.32);
    // The rest position is the bottom of the stroke. Everything lifts from there and comes back.
    string.position.y = stringY + 1.1 * (1 - depth);
    head.position.y = headY + 1.1 * (1 - depth);
    lever.quaternion.setFromAxisAngle(leverAxis, 0.16 * (1 - depth)).multiply(leverHome);
    tool.rotation.z = -0.42 + (drilling ? 0.22 : 0.06) * Math.sin(drillPhase * Math.PI * 2);
    if (drilling && cyc < 0.68 && stage.rand() < dt * 12) {
      stage.sparks(holePos, ICE_CHIP, 2, { speed: 0.9, spread: 0.9, up: 0.5, life: 0.55, gravity: 2.2 });
    }
    const whole = Math.floor(drillPhase);
    if (whole > drillCycles) {
      drillCycles = whole;
      driller.press(0.8);
      // A fresh core rises onto the cradle.
      if (!cradle.visible) {
        cradle.visible = true;
        cradleBorn = t;
      } else if (tray.count < tray.capacity) {
        // The one on the cradle goes to the next free slot, and the new one takes its place.
        const to = tray.nextSpot();
        fly(vec(cradleSpot.p), vec(to.p), { y0: cradleSpot.yaw, y1: to.yaw, s: to.s, h: 0.7, dur: 0.85, cb: () => {
          tray.add(1);
        } });
        cradleBorn = t;
      }
    }
    if (cradle.visible) {
      const age = t - cradleBorn;
      const k = Math.min(1, age / 0.5);
      cradle.scale.setScalar(cradleSpot.s * Math.max(0.01, k));
    }

    // ---- the river: two sleds on one loop, one always hauling up, the other coming back empty ----
    const hauling = busy('tow');
    stage.setMachines([capstanMachine], hauling);
    loopRate += ((hauling ? 1 / 30 : 1 / 70) - loopRate) * (1 - Math.exp(-dt * 0.8));
    loop = (loop + dt * loopRate) % 1;
    if (hauling && Math.floor(t * 0.62) !== Math.floor((t - dt) * 0.62)) hauler.press(0.6);
    for (const s of sleds) {
      const p = (loop + s.offset) % 1;
      place(s, p, dt);
      const want = wantedLoad(p);
      while (s.n < want) {
        const i = s.n;
        s.n += 1;
        // Three of the five make the hop from the boxes, or the dock turns into a shower of cores.
        if (i % 2 === 1) continue;
        const fromSpot = tray.count > 0 ? spots.tray[tray.count - 1] : cradleSpot;
        if (i !== 2 && tray.count > TRAY_FLOOR) tray.set(tray.count - 1);
        const to = s.node.position.clone().add(new THREE.Vector3(coreSpots[i].p[0], coreSpots[i].p[1] * SLED_SCALE, 0));
        fly(vec(fromSpot.p), to, { y0: fromSpot.yaw, y1: s.node.rotation.y, s: coreSpots[i].s * SLED_SCALE, h: 1.3, dur: 0.8, cb: () => {
          for (let j = 0; j <= Math.min(i + 1, SLED_LOAD - 1); j += 1) s.cores[j].visible = true;
          s.straps.visible = s.cores.every((c) => c.visible);
        } });
      }
      while (s.n > want) {
        s.n -= 1;
        const i = s.n;
        s.cores[i].visible = false;
        s.straps.visible = false;
        if (i % 2 === 0) fly(s.node.position.clone().setY(0.6), ramp[0], { y0: s.node.rotation.y, y1: s.node.rotation.y, s: coreSpots[i].s * SLED_SCALE, h: 0.9, dur: 0.7 });
      }
    }
    for (const s of sleds) updateRope(s);

    // ---- the rail: a skip reaching the top adds to the stock on the dock ----
    railRate += (((busy('lead') || hauling) ? 0.115 : 0.05) - railRate) * (1 - Math.exp(-dt * 0.8));
    railPhase = (railPhase + dt * railRate) % 1;
    setCarts();
    for (const c of carts) {
      if (c.k < c.last && stock.count < stock.capacity) stock.add(1);
      c.last = c.k;
    }

    // ---- the vault ----
    updateSlot(dt);
    if (draining < 0) {
      // Full: the uplink fires, then the cells empty row by row from the top, and the vault starts filling again.
      draining = Math.min(0.0001, draining + dt);
      if (draining >= 0) draining = 1;
    } else if (draining > 0) {
      draining -= dt * 9;
      if (draining <= 0) {
        if (litCount > CELLS_AFTER_UPLINK) { litCount -= 1; litValue[litCount] = 0; draining = 1; showCount(); } else draining = 0;
      }
    }
    for (let i = 0; i < CELLS; i += 1) {
      litFlash[i] = Math.max(0, litFlash[i] - dt * 1.1);
      const want = litValue[i] + 2.6 * litFlash[i] * litFlash[i];
      const cur = aLit.getX(i);
      aLit.setX(i, cur + (want - cur) * (1 - Math.exp(-dt * (want > cur ? 26 : 4))));
    }
    aLit.needsUpdate = true;
    vaultGlow.set(0.05 + 0.2 * (litCount / CELLS) + 0.015 * Math.sin(t * 1.4));
    mastFlare = Math.max(0, mastFlare - dt * 0.5);
    mastGlow.set(mastFlare * 0.85);
    mastGlow.sprite.scale.setScalar(2.5 + mastFlare * 7);

    // ---- the aurora ----
    flare.level += (flare.want - flare.level) * (1 - Math.exp(-dt * 2.6));
    flare.want = Math.max(0, flare.want - dt * 0.13);
    curtainU.uLevel.value = flare.level;
    iceU.uLevel.value = flare.level;
    iceFlare.visible = false;
  }

  return stage.island({
    worlds, main, applyEvent, update,
    dispose() {
      disposeWorld();
      for (const b of Object.values(bots)) b.dispose();
      hexGeo.dispose();
      haloGeo.dispose();
      cellMat.dispose();
      haloMat.dispose();
      curtainMat.dispose();
      iceMat.dispose();
      iceFlare.geometry.dispose();
      ropeGeo.dispose();
      shadowGeo.dispose();
      shadowTex.dispose();
      shadowMat.dispose();
      ropeMat.dispose();
    },
  });
}
