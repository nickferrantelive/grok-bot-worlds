// Chrome Citadel, the mirror ring. Hot metal becomes panels at the foundry, pods carry them up the spiral ramp, the
// terrace polishes them, and at the summit a crane and an erector arm fit each one into the unfinished ring.
// The citadel, the pool and the sky are the Cycles plate. Everything that moves is live.

import * as THREE from 'three';
import { createStage } from '../../engine/plate/stage.js';
import { pointAlongRoute } from '../../engine/route.js';

export const teamSizes = [3];

export const exampleTeam = {
  workspace: 'Mirror Works',
  timezone: 'America/Los_Angeles',
  lead: { id: 'lead', name: 'lead', role: 'signs off and ships', color: '#f6f7f9', schedule: 'daily' },
  bots: [
    { id: 'caster', name: 'caster', role: 'research: pulls in the raw material', color: '#ff7c1d', schedule: 'daily' },
    { id: 'polisher', name: 'polisher', role: 'checks it and polishes it', color: '#ff2c86', schedule: 'daily' },
  ],
};

const V3 = THREE.Vector3;
const rad = THREE.MathUtils.degToRad;
const ease = (x) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const mix = (a, b, k) => a + (b - a) * k;
const fract = (x) => x - Math.floor(x);

// The rail is sampled every three degrees of the spiral.
const WAY_FROM = 196;
const WAY_STEP = 3;
const DEG_BAY = 236;
const DEG_TERRACE = 662;
const DEG_DOCK = 1062;
const DEG_END = 1102;

const SLOT = rad(15);        // One fitted section of the ring.
const SLOTS = 8;             // The open third of the ring.
const FINISHED = 16;         // Sections already on the ring in the plate.

// Neutral on purpose: a warm band over a mirror reads as its reflection swapping colour.
const SUNLIT = new THREE.Color(2.5, 2.48, 2.4);

const FS_MELT = /* glsl */ `
varying vec2 vUv;
uniform float uT, uHeat;
void main() {
  float flow = sin(vUv.x * 24.0 - uT * 2.8 + sin(vUv.y * 8.0 + uT * 0.9) * 1.6) * 0.5 + 0.5;
  vec3 hot = mix(vec3(1.9, 0.34, 0.03), vec3(0.55, 0.05, 0.004), smoothstep(0.0, 1.0, vUv.x));
  gl_FragColor = vec4(hot * (0.6 + 0.4 * flow) * uHeat, 1.0);
}`;
const VS_UV = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// A skin just outside the ring. A soft band of sun runs round the finished part now and then, and a found moment
// floods it in the bot's colour. The open part of the ring stays dark, so the skin grows as the ring does.
const VS_SHELL = /* glsl */ `
varying vec3 vP;
void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS_SHELL = /* glsl */ `
varying vec3 vP;
uniform vec3 uColor, uE1, uE2;
uniform float uAmt, uBand, uSweep, uWidth, uGapA, uGapB;
const float PI = 3.14159265;
void main() {
  float ph = atan(dot(vP, uE2), dot(vP, uE1));
  float open = step(uGapA, ph) * step(ph, uGapB);
  float d = abs(mod(ph - uSweep + PI, 2.0 * PI) - PI);
  float a = (1.0 - open) * (uAmt + uBand * exp(-d * d / (uWidth * uWidth)));
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}`;

// The boat's reflection: mirrored below the water, then slid along the eye's ray back up onto the surface. It lands on the
// same pixels a true mirror image would, and it still passes behind the citadel because it stands on the water.
const VS_MIRROR = /* glsl */ `
varying float vDrop;
uniform float uT;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vDrop = -w.y;
  w.x += sin(w.y * 7.0 + uT * 2.6) * 0.045 * vDrop;
  float k = (cameraPosition.y - 0.03) / (cameraPosition.y - w.y);
  vec3 q = cameraPosition + (w.xyz - cameraPosition) * k;
  gl_Position = projectionMatrix * viewMatrix * vec4(q, 1.0);
}`;
const FS_MIRROR = /* glsl */ `
varying float vDrop;
uniform float uT;
uniform vec3 uColor;
void main() {
  float a = 0.5 * (0.84 + 0.16 * sin(vDrop * 17.0 + uT * 2.2)) * (1.0 - smoothstep(0.3, 2.6, vDrop));
  gl_FragColor = vec4(uColor * a, a);
}`;

const VS_WORLD = /* glsl */ `
varying vec3 vW;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const NOISE = /* glsl */ `
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }`;
// A few soft cloud cards that truly travel one way, about 2 px a second, wrapping well out of frame. Same two-tone as the
// sky in the render. The noise rides with each card, so outlines hold their shape instead of boiling.
const CLOUDS = /* glsl */ `
float cloudFbm(vec2 p) { return 0.56 * vn(p) + 0.29 * vn(p * 2.07 + 5.3) + 0.15 * vn(p * 4.3 + 9.1); }
vec4 cloudCards(vec2 uv, float t) {
  float best = 0.0, lit = 0.0;
  for (int i = 0; i < 4; i++) {
    float f = float(i);
    float speed = 0.00105 + 0.00022 * f;
    float run = fract(0.13 + f * 0.29 + t * speed / 1.7);
    vec2 c = vec2(run * 1.7 - 0.35, 0.7 + 0.075 * sin(f * 2.4 + 0.6) + 0.035 * f);
    vec2 d = (uv - c) * vec2(6.4 + f * 0.8, 19.0 - f);
    float body = exp(-dot(d, d));
    vec2 q = (uv - c) * vec2(7.5, 15.0) + f * 17.0;
    float n = cloudFbm(q);
    float k = smoothstep(0.34, 0.6, body * (0.42 + 1.05 * n));
    if (k > best) { best = k; lit = smoothstep(-0.05, 0.09, n - cloudFbm(q + vec2(0.3, -0.5))); }
  }
  return vec4(mix(vec3(0.62, 0.68, 0.86), vec3(2.6, 2.34, 2.0), lit), best * 0.6);
}`;

const FS_CARDS = /* glsl */ `
precision highp float;
varying vec3 vW;
uniform sampler2D tP;
uniform vec3 uH, uR, uU, uF;
uniform float uTanH, uTanV, uT;
${NOISE}
${CLOUDS}
void main() {
  vec3 d = vW - uH;
  float zz = dot(d, uF);
  vec2 uv = vec2(dot(d, uR) / (zz * uTanH), dot(d, uU) / (zz * uTanV)) * 0.5 + 0.5;
  vec4 c = cloudCards(uv, uT);
  if (c.a < 0.004) discard;
  // Wires and lattice are finer than the depth map. They stand out from the blurred plate, and the cloud goes behind them.
  vec3 near = texture2D(tP, uv).rgb;
  vec3 wide = textureLod(tP, uv, 4.0).rgb;
  float a = c.a * (1.0 - smoothstep(0.03, 0.07, max(abs(near.r - wide.r), max(abs(near.g - wide.g), abs(near.b - wide.b)))));
  if (a < 0.004) discard;
  gl_FragColor = vec4(c.rgb * a, a);
}`;

// Cat's paws: a gust roughens a patch of a mirror calm and the patch runs downwind. Darker because a rough patch stops
// holding the bright sky. This is what says wind on open water from far away.
const FS_PAWS = /* glsl */ `
precision highp float;
varying vec3 vW;
uniform float uT, uAmount, uWave, uTanH, uTanV;
uniform vec3 uColor, uH, uR, uU, uF;
${NOISE}
${CLOUDS}
void main() {
  vec2 p = vW.xz;
  float g = 0.62 * vn(p * vec2(0.05, 0.09) + vec2(-uT * 0.055, uT * 0.013)) + 0.38 * vn(p * vec2(0.13, 0.24) + vec2(-uT * 0.1, -uT * 0.02));
  float patchy = smoothstep(0.5, 0.72, g);
  float ripple = vn(vec2(p.x * 0.8 - uT * 0.75, p.y * 3.2 + uT * 0.25));
  float far = 1.0 - smoothstep(60.0, 150.0, -p.y);
  float a = patchy * (0.42 + 0.58 * ripple) * uAmount * (0.45 + 0.55 * far);
  // Wavelets: each one tilts to catch paler sky on one face and deeper sky on the other. On a flat blue there is nothing for
  // the plate's warp to bend, so this is what shows open water moving. Fades out before it gets finer than a pixel.
  float s = 0.62 * vn(vec2(p.x * 0.3 - uT * 0.3, p.y * 1.25 + uT * 0.46)) + 0.38 * vn(vec2(p.x * 0.75 - uT * 0.5, p.y * 2.9 - uT * 0.62));
  s = (s - 0.5) * 2.4;
  float dist = length(vW - cameraPosition);
  float wave = uWave * (1.0 - smoothstep(55.0, 130.0, dist));
  float lift = max(s, 0.0) * wave;
  float deep = max(-s, 0.0) * wave;
  vec3 rgb = uColor * a + vec3(1.15, 1.4, 1.85) * lift + vec3(0.03, 0.09, 0.24) * deep;
  // The live cloud cards in the mirror, moving with the ones above and broken by the same wavelets.
  vec3 ray = normalize(vW - uH);
  ray.y = -ray.y;
  vec2 ruv = vec2(dot(ray, uR) / (dot(ray, uF) * uTanH), dot(ray, uU) / (dot(ray, uF) * uTanV)) * 0.5 + 0.5;
  ruv.y += s * 0.006 * (1.0 - smoothstep(55.0, 130.0, dist));
  vec4 cl = cloudCards(ruv, uT);
  float mir = cl.a * 0.42;
  rgb += cl.rgb * mir;
  gl_FragColor = vec4(rgb, min(1.0, a + lift + deep + mir));
}`;
// The wake: two arms opening behind the boat and a churned line down the middle, gone before the far end.
const FS_WAKE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uT;
${NOISE}
void main() {
  float along = vUv.y;
  float w = abs(vUv.x - 0.5) * 2.0;
  float arm = exp(-pow((w - along * 0.9) / (0.05 + along * 0.14), 2.0));
  float mid = exp(-pow(w / (0.05 + along * 0.1), 2.0)) * 0.7;
  float n = 0.55 + 0.45 * vn(vec2(vUv.x * 26.0, along * 22.0 - uT * 1.2));
  float a = (arm + mid) * n * smoothstep(0.0, 0.03, along) * (1.0 - smoothstep(0.25, 1.0, along)) * 0.8;
  gl_FragColor = vec4(vec3(2.0, 2.05, 2.2) * a, a);
}`;

// Light on the citadel itself, drawn over the plate at the plate's own depth, so bots and panels still pass in front of it.
// The shadow pattern is looked up along the sun's ray: on a wall its edge then runs on a long slant and melts into the
// masonry, where a pattern read straight down from above would stop in a hard vertical line.
const FS_DRUM = /* glsl */ `
precision highp float;
varying vec3 vW;
uniform sampler2D tD, tP;
uniform vec3 uH, uR, uU, uF;
uniform float uTanH, uTanV, uInvNear, uInvFar, uT;
uniform mat4 uPV;
${NOISE}
float invAt(vec2 uv) { vec4 d = texture2D(tD, vec2(uv.x, 1.0 - uv.y)); return (d.r * 65280.0 + d.g * 255.0) / 65535.0; }
float fbm(vec2 p) { return 0.55 * vn(p) + 0.3 * vn(p * 2.03 + 7.1) + 0.15 * vn(p * 4.1 + 3.7); }
void main() {
  vec3 d = vW - uH;
  float zz = dot(d, uF);
  vec2 ndc = vec2(dot(d, uR) / (zz * uTanH), dot(d, uU) / (zz * uTanV));
  vec2 uv = ndc * 0.5 + 0.5;
  float inv = invAt(uv);
  if (inv < 0.0002) discard;
  float z = 1.0 / (inv * (uInvNear - uInvFar) + uInvFar);
  if (z > 62.0) discard;
  vec3 P = uH + uF * z + uR * ndc.x * uTanH * z + uU * ndc.y * uTanV * z;
  if (P.y < 0.06) discard;
  // Soft at the silhouette: four neighbours vote, so the depth map's coarse edge never shows as stairs.
  vec2 e = vec2(1.0 / 1600.0, 1.0 / 900.0);
  float solid = 0.25 * (step(0.0002, invAt(uv + vec2(e.x, 0.0))) + step(0.0002, invAt(uv - vec2(e.x, 0.0))) + step(0.0002, invAt(uv + vec2(0.0, e.y))) + step(0.0002, invAt(uv - vec2(0.0, e.y))));
  solid *= smoothstep(0.06, 0.18, P.y);

  // Cloud shade, broad and always somewhere on its way across.
  vec2 q = vec2(P.x + 2.6 * P.y, P.z - 0.88 * P.y);
  float shade = smoothstep(0.26, 0.74, fbm(q * 0.07 + vec2(-uT * 0.05, uT * 0.012)));
  float aS = 0.26 * shade;

  vec3 add = vec3(0.0);
  float aL = 0.0;
  float rad = length(P.xz - vec2(2.6, 0.0));
  if (rad < 10.4 && P.y < 6.4) {
    vec3 c = texture2D(tP, uv).rgb;
    float lum = dot(c, vec3(0.3, 0.55, 0.15));
    float ang = atan(P.z, P.x - 2.6);
    float row = floor(P.y / 1.28);
    // Chrome lips hold the sky: blue or near white in the render. Two glints run round each tier at their own pace.
    float chrome = smoothstep(0.03, 0.12, c.b - c.r) * smoothstep(0.3, 0.45, lum);
    float g = pow(0.5 + 0.5 * sin(ang * 3.0 - uT * 0.3 + row * 2.1), 46.0) + 0.8 * pow(0.5 + 0.5 * sin(ang * 5.0 + uT * 0.19 + row * 4.3), 70.0);
    float rim = chrome * (0.9 * g + 0.12 * (0.5 + 0.5 * sin(ang * 26.0 - uT * 0.8 + row)));
    // Glass: dark and not green, in the three window bands. Runs of windows come on and go off on their own clocks.
    float band = smoothstep(1.36, 1.46, P.y) * (1.0 - smoothstep(2.02, 2.12, P.y)) * step(rad, 7.5)
      + smoothstep(3.42, 3.52, P.y) * (1.0 - smoothstep(4.1, 4.2, P.y)) * step(rad, 5.7)
      + smoothstep(4.98, 5.06, P.y) * (1.0 - smoothstep(5.44, 5.52, P.y)) * step(rad, 4.1);
    // From a blurred read of the plate, so a whole pane lights and not the broken bits of reflection inside it.
    vec3 cs = textureLod(tP, uv, 2.5).rgb;
    float glass = (1.0 - smoothstep(0.26, 0.58, lum)) * (1.0 - smoothstep(0.0, 0.04, cs.r - cs.b)) * (1.0 - smoothstep(0.02, 0.07, cs.g - cs.b)) * band;
    float across = fract(ang / 0.14 + row * 0.37);
    glass *= smoothstep(0.0, 0.12, across) * (1.0 - smoothstep(0.88, 1.0, across));
    vec2 id = vec2(floor(ang / 0.14 + row * 0.37), row);
    float h = h21(id + 3.3);
    float h2 = h21(id.yx + 11.7);
    float clock = fract(uT / (24.0 + h * 30.0) + h2 * 7.0);
    float lit = smoothstep(0.0, 0.1, clock) * (1.0 - smoothstep(0.55, 0.68, clock)) * step(0.3, h2);
    float sheen = pow(0.5 + 0.5 * sin(ang * 4.0 - uT * 0.24 + row * 1.7), 30.0);
    float aW = glass * (0.5 * lit + 0.2 * sheen);
    add = vec3(4.2, 4.1, 3.9) * rim + (vec3(2.1, 1.02, 0.28) * 0.5 * lit + vec3(1.6, 1.75, 2.0) * 0.2 * sheen * (1.0 - lit)) * glass;
    aL = rim + aW;
  }
  // The foundry's glass dome: a warm breathing fire behind the panes, and a thin veil of it over the ribs.
  vec2 de = (uv - vec2(0.138, 0.205)) / vec2(0.104, 0.098);
  float dome = 1.0 - smoothstep(0.55, 1.0, length(de));
  if (dome > 0.0 && P.y > 1.0) {
    vec3 ds = textureLod(tP, uv, 1.5).rgb;
    float pane = (1.0 - smoothstep(0.28, 0.62, dot(ds, vec3(0.3, 0.55, 0.15)))) * (1.0 - smoothstep(0.015, 0.07, ds.g - ds.b));
    float fire = 0.72 + 0.2 * sin(uT * 0.73 + uv.x * 9.0) + 0.08 * sin(uT * 2.1 + uv.y * 14.0);
    float aD = dome * fire * (0.035 + 0.36 * pane) * (1.0 - smoothstep(0.015, 0.07, ds.g - ds.b));
    add += vec3(2.3, 0.95, 0.22) * aD;
    aL += aD;
  }
  float a = min(1.0, aS + aL) * solid;
  if (a < 0.002) discard;
  vec4 clip = uPV * vec4(P, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5 - 0.00006, 0.0, 1.0);
  gl_FragColor = vec4((vec3(0.035, 0.05, 0.09) * aS + add) * solid, a);
}`;

const OVER = {
  transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, toneMapped: false,
};

export async function createIsland(ctx) {
  const { config, quality, mascots, scene } = ctx;
  const stage = await createStage(ctx, { motion: true, water: 1, flow: 0, pulse: 1, envIntensity: 1.05, sparkSize: 0.11 });
  const { info } = stage;
  const { spots: S } = info;
  const vec = (a) => new V3().fromArray(a);

  // ---------- the place itself: a bright windy day. The wind blows to screen right, so sky, shadows, steam and the sea all agree ----------
  stage.life({
    wind: { amount: 0.0017, x: 1, y: 0.1, speed: 1, scale: 0.28 },
    // Two copies crossfading cannot travel, they only swing, so the plate's clouds barely breathe. Real one-way travel comes from
    // the live cloud cards. The lattice is finer than the depth map, so it stays out of the flow.
    sky: { x: -0.004, y: 0, cycle: 60, warp: 0.00001, keep: [0.44, 0.515, 0.745, 0.975] },
    // The mirror image of those clouds, at the same speed on screen. plate_mask.webp carries a G field over open water only.
    cloud: { x: -0.004, y: 0, cycle: 60, warp: 0.00001 },
    sea: { amount: 0.002, height: 0, wavelength: 0.6, speed: 1.05 },
    glint: { amount: 0.045, color: '#fff0d4' },
    // A long period, or the band repeats out across the far shore as pale spokes.
    sweep: { amount: 0.11, width: 3, speed: 3.5, period: 120, dir: [-1, -0.14, 0] },
  });
  const living = await createLiving();
  async function createLiving() {
    const owned = [];
    const timeU = { value: 0 };
    const keep = (...things) => { owned.push(...things); return things[0]; };

    // Steam: one continuous plume from many small faint puffs. Thin at the lip, widening as it shears away, gone by mid sky.
    // A second, blue-grey body sits on the side away from the sun, so the plume has a form.
    // Two in five puffs leave in loose groups: density then rolls along the plume, and it reads as vapour and not as a hose.
    const lumpy = (pl, n) => {
      const a = pl.mesh.geometry.attributes.aSeed;
      for (let i = 0; i < a.count; i += 5) {
        for (const j of [i, i + 1]) {
          if (j >= a.count) continue;
          const c = j % n;
          a.setXYZW(j,
            0.5 + (fract(c * 0.618034 + 0.13) - 0.5) * 0.7 + (a.getX(j) - 0.5) * 0.35,
            a.getY(j),
            0.5 + (fract(c * 0.56984 + 0.77) - 0.5) * 0.7 + (a.getZ(j) - 0.5) * 0.35,
            fract(c / n + (a.getW(j) - 0.5) * 0.06));
        }
      }
      a.needsUpdate = true;
    };
    const plume = (p, k) => {
      const lit = stage.particles({
        count: Math.round(620 * k), center: p, box: [1.0, 0.62, 1.0], velocity: [0.14, 0.38, -0.02], accel: [0.17, 0.004, 0], life: 7.5,
        size: [0.1 * k, 0.5 * k], wobble: 0.42, color: [2.7, 2.56, 2.36], opacity: 0.1, breakup: 1, hard: 1, spin: 0.3, fadeIn: 0.015, fadeOut: 0.2,
      });
      const shade = stage.particles({
        count: Math.round(340 * k), center: [p.x + 0.1, p.y - 0.12, p.z - 0.2], box: [1.05, 0.66, 1.05], velocity: [0.14, 0.365, -0.02], accel: [0.172, 0.004, 0], life: 7.5,
        size: [0.11 * k, 0.54 * k], wobble: 0.45, color: [0.92, 1.04, 1.36], opacity: 0.085, breakup: 1, hard: 1, spin: 0.24, fadeIn: 0.015, fadeOut: 0.18, order: 17,
      });
      lumpy(lit, 17);
      lumpy(shade, 17);
      return [lit, shade];
    };
    const plumes = S.stack.flatMap((s, i) => plume(vec(s.p), i === 0 ? 1 : 0.84));

    // Haze on the far shore, in front of the hills and behind everything else.
    stage.particles({
      count: 42, center: [18, 2.6, -128], box: [210, 5, 30], velocity: [0.85, 0, 0], size: [10, 24], wobble: 2.5,
      color: [1.4, 1.42, 1.6], opacity: 0.17, breakup: 0.9, hard: 1.2,
    });

    // Gulls: a loose flock behind the ring, and a few nearer ones crossing the steam the other way.
    stage.flock({ center: [1, 10.2, -13], radius: [15, 1.4, 7], count: 9, size: 0.5, speed: 0.08, flap: 5.4, color: [2.1, 2.1, 2.05], opacity: 1, spread: 0.075 });
    stage.flock({ center: [-11, 8.2, 2], radius: [7, 0.8, 5], count: 4, size: 0.27, speed: -0.13, flap: 6.2, color: [2.0, 2.0, 1.95], opacity: 1, spread: 0.16 });

    // Aircraft lights on the two highest points.
    stage.blink(new V3(2.6, 12.92, 0), '#ff4a38', { period: 2.8, on: 0.16, size: 0.55 });
    stage.blink(vec(S.jib_root[0].p).add(new V3(0, 0.42, 0)), '#ff4a38', { period: 2.8, phase: 0.5, on: 0.16, size: 0.5 });

    // Light and shade on the citadel.
    const depthBuf = await (await fetch(`${ctx.assetsBase}depth.bin`)).arrayBuffer();
    const d16 = new Uint16Array(depthBuf);
    const rg = new Uint8Array(d16.length * 2);
    for (let i = 0; i < d16.length; i += 1) { rg[i * 2] = d16[i] >> 8; rg[i * 2 + 1] = d16[i] & 255; }
    const tD = keep(new THREE.DataTexture(rg, info.depth.w, info.depth.h, THREE.RGFormat, THREE.UnsignedByteType));
    tD.minFilter = tD.magFilter = THREE.NearestFilter;
    tD.needsUpdate = true;
    const tP = keep(await new THREE.TextureLoader().loadAsync(`${ctx.assetsBase}plate.webp`));
    tP.colorSpace = THREE.NoColorSpace;
    tP.generateMipmaps = true;
    tP.minFilter = THREE.LinearMipmapLinearFilter;
    const hero = info.camera;
    const heroDist = hero.focus > 0 ? hero.focus : 37.5;
    const tanH = Math.tan(rad(hero.hfov) / 2);
    const tanV = Math.tan(rad(hero.vfov) / 2);
    const drumU = {
      tD: { value: tD }, tP: { value: tP }, uT: timeU, uPV: { value: new THREE.Matrix4() },
      uH: { value: stage.H }, uR: { value: stage.R }, uU: { value: stage.U }, uF: { value: stage.F },
      uTanH: { value: tanH }, uTanV: { value: tanV }, uInvNear: { value: 1 / info.depth.near }, uInvFar: { value: 1 / info.depth.far },
    };
    const drumGeo = keep(new THREE.PlaneGeometry(heroDist * tanH * 2.3, heroDist * tanV * 2.3));
    const drumMat = keep(new THREE.ShaderMaterial({ vertexShader: VS_WORLD, fragmentShader: FS_DRUM, uniforms: drumU, ...OVER }));
    const drum = new THREE.Mesh(drumGeo, drumMat);
    drum.position.copy(stage.H).addScaledVector(stage.F, heroDist);
    drum.quaternion.fromArray(hero.quat);
    drum.frustumCulled = false;
    drum.renderOrder = 1;
    stage.live.add(drum);
    const cam = ctx.camera;

    // Cloud cards: past the far hills and in front of the sky, so only open sky shows them.
    const cardGeo = keep(new THREE.PlaneGeometry(600 * tanH * 2.3, 600 * tanV * 2.3));
    const cardMat = keep(new THREE.ShaderMaterial({
      vertexShader: VS_WORLD, fragmentShader: FS_CARDS, ...OVER,
      uniforms: { tP: { value: tP }, uT: timeU, uH: { value: stage.H }, uR: { value: stage.R }, uU: { value: stage.U }, uF: { value: stage.F }, uTanH: { value: tanH }, uTanV: { value: tanV } },
    }));
    const cards = new THREE.Mesh(cardGeo, cardMat);
    cards.position.copy(stage.H).addScaledVector(stage.F, 600);
    cards.quaternion.fromArray(hero.quat);
    cards.frustumCulled = false;
    cards.renderOrder = 0;
    stage.live.add(cards);

    // Two thin vents on the dome's crown.
    for (const [vx, vy, vz, vk] of [[-9.3, 2.66, 3.9, 1], [-8.2, 2.42, 4.5, 0.8]]) {
      stage.particles({
        count: Math.round(150 * vk), center: [vx, vy, vz], box: [0.34, 0.2, 0.34], velocity: [0.08, 0.3, 0], accel: [0.14, 0.004, 0], life: 4.2,
        size: [0.05 * vk, 0.26 * vk], wobble: 0.16, color: [2.5, 2.4, 2.25], opacity: 0.075, breakup: 1, hard: 1, spin: 0.3, fadeIn: 0.02, fadeOut: 0.2,
      });
    }

    // Gusts on the water.
    const pawGeo = keep(new THREE.PlaneGeometry(420, 178).rotateX(-Math.PI / 2));
    const pawU = {
      uH: { value: stage.H }, uR: { value: stage.R }, uU: { value: stage.U }, uF: { value: stage.F },
      uTanH: { value: Math.tan(rad(info.camera.hfov) / 2) }, uTanV: { value: Math.tan(rad(info.camera.vfov) / 2) },
      uT: timeU, uAmount: { value: 0.3 }, uWave: { value: 0.3 }, uColor: { value: new THREE.Vector3(0.1, 0.2, 0.42) },
    };
    const pawMat = keep(new THREE.ShaderMaterial({ vertexShader: VS_WORLD, fragmentShader: FS_PAWS, uniforms: pawU, ...OVER }));
    const paws = new THREE.Mesh(pawGeo, pawMat);
    paws.position.set(10, 0.02, -60);
    paws.renderOrder = 2;
    stage.live.add(paws);

    // A small white sail far out on the left of the water. It goes behind the citadel and comes round again out of frame.
    const boat = new THREE.Group();
    const white = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.92, 0.9, 0.86), roughness: 0.55, side: THREE.DoubleSide, envMapIntensity: 0.9 }));
    const hullGeo = keep(new THREE.SphereGeometry(1, 14, 8).scale(1.05, 0.2, 0.28));
    const hull = new THREE.Mesh(hullGeo, white);
    hull.position.y = 0.1;
    // Main and jib as thin triangles, a touch of belly in the middle so the sun shades them differently.
    const sailGeo = keep(new THREE.BufferGeometry());
    const sailV = [
      -0.62, 0.22, 0.02, 0.32, 0.22, 0.14, 0.2, 2.25, 0.0,
      -0.62, 0.22, 0.02, 0.2, 2.25, 0.0, -0.18, 1.2, 0.16,
      0.32, 0.22, -0.02, 0.98, 0.2, -0.06, 0.26, 1.95, -0.02,
    ];
    sailGeo.setAttribute('position', new THREE.Float32BufferAttribute(sailV, 3));
    sailGeo.computeVertexNormals();
    const sail = new THREE.Mesh(sailGeo, white);
    boat.add(hull, sail);
    stage.live.add(boat);
    const mirrorU = { uT: timeU, uColor: { value: new THREE.Vector3(1.85, 1.8, 1.72) } };
    const mirrorMat = keep(new THREE.ShaderMaterial({ vertexShader: VS_MIRROR, fragmentShader: FS_MIRROR, uniforms: mirrorU, side: THREE.DoubleSide, ...OVER }));
    const mirrored = new THREE.Mesh(sailGeo, mirrorMat);
    mirrored.scale.y = -1;
    mirrored.frustumCulled = false;
    mirrored.renderOrder = 3;
    stage.live.add(mirrored);
    const wakeGeo = keep(new THREE.PlaneGeometry(6, 9).rotateX(-Math.PI / 2).rotateY(Math.PI / 2));
    const wakeMat = keep(new THREE.ShaderMaterial({ vertexShader: VS_WORLD, fragmentShader: FS_WAKE, uniforms: { uT: timeU }, side: THREE.DoubleSide, ...OVER }));
    const wake = new THREE.Mesh(wakeGeo, wakeMat);
    wake.renderOrder = 4;
    stage.live.add(wake);
    const BOAT_Z = -92;
    const BOAT_FROM = -32;
    const BOAT_TO = 30;
    const BOAT_RUN = BOAT_TO - BOAT_FROM;
    let boatX = -3;

    return {
      update(dt, t) {
        timeU.value = t;
        drumU.uPV.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        // The wind leans on the plumes in slow gusts that never quite repeat.
        const gust = 1 + 0.3 * Math.sin(t * 0.31) + 0.18 * Math.sin(t * 0.83 + 1.3);
        for (const pl of plumes) pl.uniforms.uAccel.value.x = 0.17 * gust;
        // One way only, from the clock, about 2 px a second on a full frame. It wraps out of frame on the left and behind the citadel.
        boatX = BOAT_FROM + fract((t * 0.12 + 29) / BOAT_RUN) * BOAT_RUN;
        const heave = Math.sin(t * 0.9) * 0.025;
        boat.position.set(boatX, heave, BOAT_Z);
        boat.rotation.z = -0.07 + Math.sin(t * 0.7 + 0.6) * 0.035;
        boat.rotation.x = Math.sin(t * 0.53) * 0.03;
        mirrored.position.set(boatX, 0, BOAT_Z);
        mirrored.rotation.z = boat.rotation.z * -1;
        wake.position.set(boatX - 4.7, 0.03, BOAT_Z);
      },
      dispose() { for (const o of owned) o.dispose(); },
    };
  }
  const cFoundry = config.bots[0].color;
  const cPolish = config.bots[1].color;
  const cLead = config.lead.color;
  const WHITE = '#fff4e2';

  // The render's strips are a purer colour than the bot's body, the same curve as sat() in the look script.
  const ledHex = (hex) => {
    const c = new THREE.Color(hex);
    const m = Math.max(c.r, c.g, c.b, 1e-4);
    return `#${new THREE.Color((c.r / m) ** 1.45, (c.g / m) ** 1.45, (c.b / m) ** 1.45).getHexString()}`;
  };
  stage.bindGroup('foundry', ledHex(cFoundry));
  stage.bindGroup('polish', ledHex(cPolish));
  stage.bindGroup('lead', cLead);

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
  const caster = await makeBot(config.bots[0], 'foundry', { rhythm: 0.8, lean: 0.12 });
  const polisher = await makeBot(config.bots[1], 'polish', { rhythm: 0.62, lean: 0.09 });
  const lead = await makeBot(config.lead, 'lead', { rhythm: 0.3, lean: 0.07 });
  const bots = { foundry: caster, polish: polisher, lead };
  const state = { foundry: 'idle', polish: 'idle', lead: 'idle' };
  const busy = (k) => state[k] === 'working';
  const posOf = (k) => vec(info.bots[k].p);
  const fp = posOf('foundry');
  const pp = posOf('polish');
  const lp = posOf('lead');
  const toolPolish = stage.actor('tool_polish');
  const toolLead = stage.actor('tool_lead');
  const toolPolishY = toolPolish.position.y;
  const toolLeadY = toolLead.position.y;

  // ---------- materials: the live panels share the render's finish, and only the finish changes along the line ----------
  const findMat = (node, word) => {
    let m = null;
    node.traverse((o) => { if (o.isMesh && !m && o.material.name.includes(word)) m = o.material; });
    return m;
  };
  const setMat = (node, word, mat) => node.traverse((o) => { if (o.isMesh && o.material.name.includes(word)) o.material = mat; });
  // A racked panel sees the sky high up and the back of its neighbour low down. A live reflection cannot know that, so
  // the same falloff goes into the geometry: without it every panel in a rack is one flat tone and the rack looks pasted on.
  const shadeOccluded = (node, word, yLow, ySpan) => node.traverse((o) => {
    if (!o.isMesh || !o.material.name.includes(word)) return;
    const pos = o.geometry.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 1) {
      const k = (0.14 + 0.86 * ease((pos.getY(i) - yLow) / ySpan)) * (0.84 + 0.16 * Math.sin(pos.getX(i) * 11 + 1.2));
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
    }
    o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  });
  // glTF shares one material between every proto that names it, and sections have no vertex colours. So the rack protos
  // get their own copy, and piles clone from them. The proto itself stays hidden: copies set their own visibility.
  // A panel face: brushed frame, a dark rim, then blue glass split into cells. Built once, mipmapped, anisotropic.
  const panelTex = (() => {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#dfe3e8';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 256; i += 2) { g.fillStyle = i % 4 ? 'rgba(255,255,255,0.18)' : 'rgba(90,96,106,0.16)'; g.fillRect(0, i, 256, 1); }
    g.fillStyle = '#5c636d';
    g.fillRect(10, 10, 236, 236);
    g.fillStyle = '#a9bddc';
    g.fillRect(13, 13, 230, 230);
    const cols = 6;
    const rows = 10;
    const cw = 230 / cols;
    const ch = 230 / rows;
    for (let r = 0; r < rows; r += 1) {
      for (let q = 0; q < cols; q += 1) {
        const v = Math.round(10 * Math.sin(r * 3.7 + q * 5.3));
        const x = 13 + q * cw + 1.2;
        const y = 13 + r * ch + 1.2;
        const grd = g.createLinearGradient(x, y, x + cw, y + ch);
        grd.addColorStop(0, `rgb(${58 + v},${92 + v},${150 + v})`);
        grd.addColorStop(1, `rgb(${34 + v},${62 + v},${118 + v})`);
        g.fillStyle = grd;
        g.fillRect(x, y, cw - 2.4, ch - 2.4);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  })();
  // The glass face gets a flat projection across its two long sides, so the cell grid lies square on every panel.
  const planarUV = (node, word) => node.traverse((o) => {
    if (!o.isMesh || !o.material.name.includes(word) || o.geometry.userData.panelUV) return;
    const geo = o.geometry;
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    const sz = b.getSize(new V3());
    const ax = ['x', 'y', 'z'].sort((p, q) => sz[q] - sz[p]);
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    const get = (i, a) => (a === 'x' ? pos.getX(i) : a === 'y' ? pos.getY(i) : pos.getZ(i));
    for (let i = 0; i < pos.count; i += 1) {
      uv[i * 2] = (get(i, ax[1]) - b.min[ax[1]]) / Math.max(1e-5, sz[ax[1]]);
      uv[i * 2 + 1] = (get(i, ax[0]) - b.min[ax[0]]) / Math.max(1e-5, sz[ax[0]]);
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.userData.panelUV = true;
  });
  const dressPanel = (mat) => {
    if (!panelTex) return;
    mat.map = panelTex;
    mat.envMapIntensity = 1.35;
    mat.needsUpdate = true;
  };
  for (const n of ['pod_panel_a', 'pod_panel_b']) planarUV(stage.actor(n), 'chrome');
  const rackProto = (name, word, tweak) => {
    const proto = stage.actor(name);
    proto.visible = false;
    planarUV(proto, word);
    const base = findMat(proto, word);
    if (word === 'chrome') dressPanel(base);
    const mat = base.clone();
    mat.vertexColors = true;
    tweak?.(mat);
    shadeOccluded(proto, word, -0.3, 0.62);
    setMat(proto, word, mat);
    return base;
  };
  const mirrorMat = rackProto('panel', 'chrome');
  // A rough metal averages the whole bright sky, so it needs far less colour than a mirror to read as the render's mid grey.
  rackProto('panel_dull', 'dull', (m) => { m.color.multiplyScalar(0.36); });
  // A polished panel on a tram holds the sky, so the eye can follow it up the tower.
  const skyMat = mirrorMat.clone();
  skyMat.color.setRGB(0.36, 0.58, 0.98);
  const brightMat = mirrorMat.clone();
  brightMat.roughness = 0.2;
  brightMat.color.multiplyScalar(0.8);
  const COLD = { color: new THREE.Color(0.4, 0.41, 0.43), rough: 0.34 };
  const BRIGHT = { color: brightMat.color.clone(), rough: 0.2 };
  // AgX walks bright colour toward white, so hot metal stays low and very red to come out orange.
  const HOT = new THREE.Color(1.0, 0.11, 0.004);

  // Hot, then dull, then bright: 0 at the furnace mouth, 1 where the hood lets it go.
  const heatAt = (k) => 1 - ease((k - 0.12) / 0.4);
  const finish = (mat, k) => {
    // Heat holds, then falls fast. While any is left the metal stays dark, or the half cooled panel reads pale pink.
    const heat = heatAt(k);
    const cool = ease((k - 0.6) / 0.2);
    mat.color.copy(COLD.color).lerp(BRIGHT.color, cool).multiplyScalar(mix(1, 0.06, ease(heat * 2.2)));
    mat.roughness = mix(COLD.rough, BRIGHT.rough, cool);
    mat.metalness = mix(1, 0.4, heat);
    mat.emissive.copy(HOT);
    mat.emissiveIntensity = heat ** 1.3 * 1.5;
  };

  // ---------- foundry ----------
  const lineA = vec(info.paths.line[0]);
  const lineB = vec(info.paths.line[1]);
  const lineSpot = S.line_panel[0];
  const hoodP = vec(S.hood[0].p);
  const overHead = vec(S.over_head[0].p);
  const lineItems = [0, 1, 2, 3].map(() => {
    const node = stage.copy('panel', lineSpot);
    const mat = mirrorMat.clone();
    setMat(node, 'chrome', mat);
    node.visible = false;
    return { node, mat, k: 0, on: false, waited: 0, glow: stage.glow(new V3(), '#ff6a1a', 1.5, 0) };
  });
  // Three panels already on the rollers at load, at three stages of the change.
  [0.14, 0.44, 0.76].forEach((k, i) => {
    const it = lineItems[i];
    it.on = true;
    it.k = k;
    it.node.visible = true;
    it.node.position.lerpVectors(lineA, lineB, k);
    finish(it.mat, k);
  });
  let lineTimer = 0.6;
  let lineCursor = 3;
  let lineMade = 0;
  let hoodTimer = 0;
  let stackTimer = 0;
  const yard = stage.pile('yard', 'panel', S.yard, 11);
  const stacks = S.stack.map((s) => vec(s.p));

  // Molten sheet running out of the furnace mouth along the first rollers.
  const meltA = vec(S.melt_a[0].p);
  const meltB = vec(S.melt_b[0].p);
  const meltW = vec(S.melt_side[0].p).sub(meltA);
  const meltGeo = new THREE.BufferGeometry();
  const mv = [meltA.clone().sub(meltW), meltA.clone().add(meltW), meltB.clone().add(meltW), meltB.clone().sub(meltW)];
  meltGeo.setAttribute('position', new THREE.Float32BufferAttribute(mv.flatMap((p) => [p.x, p.y, p.z]), 3));
  meltGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 1, 0], 2));
  meltGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const meltU = { uT: { value: 0 }, uHeat: { value: 0.6 } };
  const meltMat = new THREE.ShaderMaterial({ vertexShader: VS_UV, fragmentShader: FS_MELT, uniforms: meltU, side: THREE.DoubleSide, toneMapped: false });
  const melt = new THREE.Mesh(meltGeo, meltMat);
  stage.live.add(melt);
  const mouthGlow = stage.glow(meltA.clone().lerp(meltB, 0.2).add(new V3(0, 0.25, 0)), '#ff7a24', 2.6, 0.2);
  // The bot and the furnace are over the pool, and neither is in the plate's reflection.
  const botRefl = stage.glow(new V3(fp.x, -fp.y - 0.5, fp.z), cFoundry, 1, 0.3);
  botRefl.sprite.scale.set(1.15, 2.1, 1);

  const loader = stage.runner('panel', [lineB, overHead], { speed: 2.3, scale: 0.9 });
  setMat(loader.node, 'chrome', brightMat);
  loader.node.rotation.y = lineSpot.yaw;
  let loaderPressed = false;
  const yardRunner = stage.runner('panel', [lineB, overHead], { speed: 2.6, scale: 0.9 });
  setMat(yardRunner.node, 'chrome', brightMat);
  yardRunner.node.rotation.y = lineSpot.yaw;
  let yardLoadTimer = 4;

  // ---------- the rail and the pods ----------
  const way = stage.path('podway');
  const cum = [0];
  for (let i = 1; i < way.length; i += 1) cum.push(cum[i - 1] + way[i].distanceTo(way[i - 1]));
  const sOf = (deg) => cum[Math.round((deg - WAY_FROM) / WAY_STEP)];
  const S_BAY = sOf(DEG_BAY);
  const S_TERRACE = sOf(DEG_TERRACE);
  const S_DOCK = sOf(DEG_DOCK);
  const S_END = sOf(DEG_END);
  const wayAt = (s, out, dir) => {
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const k = (s - cum[lo]) / Math.max(1e-5, cum[hi] - cum[lo]);
    out.lerpVectors(way[lo], way[hi], Math.min(1, Math.max(0, k)));
    if (dir) dir.subVectors(way[hi], way[lo]).normalize();
    return out;
  };
  const wayLine = (a, b, n) => Array.from({ length: n }, (_, i) => wayAt(mix(a, b, (i + 1) / n), new V3()));

  const sunDir = vec(info.suns[0].dir).normalize();
  const pods = Array.from({ length: 9 }, () => {
    const node = stage.copy('pod');
    node.rotation.order = 'YZX';
    node.visible = false;
    const a = stage.copy('pod_panel_a', null, node);
    const b = stage.copy('pod_panel_b', null, node);
    // Bigger than built, kept on the tram's deck: at this distance the panels are what the line is about.
    for (const panel of [a, b]) {
      panel.scale.setScalar(1.35);
      panel.position.y -= 0.17;
    }
    const led = findMat(node, 'led_on').clone();
    setMat(node, 'led_on', led);
    return {
      node, a, b, led, s: 0, v: 0, state: 'free', load: 0, wait: 0, hops: 0, hopTimer: 0,
      glint: stage.glow(new V3(), WHITE, 1, 0),
      refl: stage.glow(new V3(), '#e6eef6', 1, 0),
    };
  });
  const setLoad = (p, n, mat) => {
    p.load = n;
    p.a.visible = n > 0;
    p.b.visible = n > 1;
    if (mat) { setMat(p.a, 'chrome', mat); setMat(p.b, 'chrome', mat); }
  };
  const legColor = (p, hex) => { p.led.emissive.set(hex); };
  const seat = (p, st, s, n, mat, hex) => {
    p.state = st;
    p.s = s;
    p.v = 0;
    p.node.visible = true;
    setLoad(p, n, mat);
    legColor(p, hex);
  };
  // A line that is already running when the page opens.
  // The back of each turn is hidden from the camera, so the seeds sit on the turns' fronts.
  seat(pods[0], 'bay', S_BAY, 1, brightMat, cFoundry);
  seat(pods[1], 'climb1', sOf(286), 2, brightMat, cFoundry);
  seat(pods[2], 'climb1', sOf(334), 2, brightMat, cFoundry);
  seat(pods[3], 'climb1', sOf(586), 2, brightMat, cFoundry);
  seat(pods[4], 'climb1', sOf(628), 2, brightMat, cFoundry);
  seat(pods[5], 'climb2', sOf(922), 2, skyMat, cPolish);
  seat(pods[6], 'climb2', sOf(976), 2, skyMat, cPolish);
  seat(pods[7], 'climb2', sOf(1024), 2, skyMat, cPolish);
  let sinceDepart = 3;
  const podHops = [0, 1].map(() => {
    const r = stage.runner('panel', [overHead, lineB], { speed: 2.4, scale: 0.9 });
    setMat(r.node, 'chrome', mirrorMat);
    return r;
  });
  const bayPod = () => pods.find((p) => p.state === 'bay');

  const podP = new V3();
  const podD = new V3();
  const nrm = new V3();
  const half = new V3();
  const camDir = new V3();
  function updatePods(dt) {
    sinceDepart += dt;
    if (!pods.some((p) => p.state === 'arrive' || p.state === 'bay')) {
      const f = pods.find((p) => p.state === 'free');
      if (f) seat(f, 'arrive', 0, 0, brightMat, cFoundry);
    }
    for (const p of pods) {
      if (p.state === 'free') continue;
      let want = 0;
      let stopAt = null;
      if (p.state === 'arrive') { want = 1.8; stopAt = S_BAY; }
      else if (p.state === 'climb1') { want = busy('foundry') ? 2.1 : 0.8; stopAt = S_TERRACE; }
      else if (p.state === 'climb2') { want = busy('polish') ? 2.0 : 0.8; stopAt = S_DOCK; }
      else if (p.state === 'exit') { want = 1.3; stopAt = S_END; }
      if (stopAt !== null) want = Math.min(want, Math.sqrt(Math.max(0, 2 * 0.8 * (stopAt - p.s))) + 0.04);
      let gap = Infinity;
      for (const q of pods) if (q !== p && q.state !== 'free' && q.s > p.s) gap = Math.min(gap, q.s - p.s);
      if (gap < 3.4) want = Math.min(want, Math.max(0, (gap - 2.6) * 1.4));
      p.v += (want - p.v) * (1 - Math.exp(-dt * 2.4));
      p.s += p.v * dt;
      if (stopAt !== null && p.s >= stopAt - 0.015) {
        p.s = stopAt;
        p.v = 0;
        if (p.state === 'arrive') p.state = 'bay';
        else if (p.state === 'climb1') {
          p.state = 'terrace';
          p.wait = busy('polish') ? 2.6 : 1.6;
          // The pod swaps its bright panels for mirror ones at the terrace.
          if (waiting.count < waiting.capacity) waiting.add(1);
          if (finished.count > 2) finished.set(finished.count - 1);
          setLoad(p, p.load, skyMat);
          legColor(p, cPolish);
          stage.sparks(wayAt(p.s, podP).clone().add(new V3(0, 0.55, 0)), WHITE, 6, { speed: 0.7, spread: 0.7, up: 0.5, life: 0.6 });
          polisher.press(0.6);
        } else if (p.state === 'climb2') {
          p.state = 'dock';
          p.hops = p.load;
          p.hopTimer = 0.5;
          p.wait = 3.2;
        } else {
          p.state = 'free';
          p.node.visible = false;
          setLoad(p, 0);
        }
      }
      if (p.state === 'bay') {
        if (p.load >= 2 && sinceDepart >= (busy('foundry') ? 6 : 10)) { p.state = 'climb1'; sinceDepart = 0; }
      } else if (p.state === 'terrace') {
        p.wait -= dt;
        if (p.wait <= 0) p.state = 'climb2';
      } else if (p.state === 'dock') {
        p.hopTimer -= dt;
        if (p.hops > 0 && p.hopTimer <= 0) {
          const hop = podHops.find((r) => !r.active);
          if (hop) {
            p.hops -= 1;
            p.hopTimer = 0.7;
            setLoad(p, p.hops);
            const to = vec(summitRack.nextSpot().p);
            const from = p.node.position.clone().add(new V3(0, 0.49, 0));
            hop.node.rotation.y = summitRack.nextSpot().yaw;
            hop.node.scale.setScalar(0.9);
            hop.go(1, () => {
              hop.node.visible = false;
              if (summitRack.count < summitRack.capacity) summitRack.add(1);
            }, [from, from.clone().lerp(to, 0.5).add(new V3(0, 0.75, 0)), to]);
          }
        }
        p.wait -= dt;
        if (p.wait <= 0 && p.hops === 0) p.state = 'exit';
      }
      wayAt(p.s, podP, podD);
      p.node.position.copy(podP);
      // Same sign as the build: yaw is the heading, and the rail climbs a little.
      p.node.rotation.y = Math.atan2(-podD.z, podD.x);
      p.node.rotation.z = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(podD.y, -1, 1)), -0.09, 0.09);

      // A panel turning on the curve flashes when it lines up between the sun and the eye.
      let flare = 0;
      if (p.load > 0) {
        camDir.subVectors(stage.H, podP).normalize();
        half.addVectors(camDir, sunDir).normalize();
        for (const tilt of [-0.26, 0.26]) {
          nrm.set(0, Math.sin(tilt), -Math.cos(tilt)).applyEuler(p.node.rotation);
          flare = Math.max(flare, Math.abs(nrm.dot(half)) ** 180);
        }
      }
      p.glint.sprite.position.copy(podP).add(new V3(0, 0.5, 0));
      p.glint.sprite.scale.setScalar(0.9 + flare * 1.5);
      p.glint.set(flare * 0.95);
      // Only the lowest turn is near enough to the water to show in it.
      const low = podP.y < 2 ? 1 : 0;
      p.refl.sprite.position.set(podP.x, -podP.y - 0.1, podP.z);
      p.refl.sprite.scale.set(2.2, 1.1, 1);
      p.refl.set(low * 0.13);
    }
  }

  function updateFoundry(dt, t) {
    const b = busy('foundry');
    meltU.uT.value = t;
    meltU.uHeat.value += ((b ? 1 : 0.5) - meltU.uHeat.value) * (1 - Math.exp(-dt * 1.6));
    mouthGlow.set(meltU.uHeat.value * (0.24 + 0.05 * Math.sin(t * 3.1)));

    lineTimer -= dt;
    if (lineTimer <= 0) {
      const it = lineItems[lineCursor];
      const clear = lineItems.every((o) => !o.on || o.k > 0.3);
      if (!it.on && clear) {
        it.on = true;
        it.k = 0;
        it.waited = 0;
        it.node.visible = true;
        lineCursor = (lineCursor + 1) % lineItems.length;
        lineTimer = b ? 3 : 5;
      } else {
        lineTimer = 0.4;
      }
    }
    const rate = b ? 0.1 : 0.06;
    for (const it of lineItems) {
      if (!it.on) { it.glow.set(0); continue; }
      let limit = 1;
      for (const o of lineItems) if (o !== it && o.on && o.k > it.k) limit = Math.min(limit, o.k - 0.28);
      it.k = Math.min(limit, it.k + rate * dt);
      it.node.position.lerpVectors(lineA, lineB, it.k);
      finish(it.mat, it.k);
      const heat = heatAt(it.k);
      it.glow.sprite.position.copy(it.node.position);
      it.glow.sprite.scale.setScalar(1.1 + heat * 0.9);
      it.glow.set(heat * 0.34);
      if (it.k >= 1) {
        it.waited += dt;
        const pod = bayPod();
        // One panel in four goes to the yard, so stock piles up while the pods are being kept full.
        const toYard = lineMade % 4 === 3 && yard.count < yard.capacity;
        if (pod && pod.load < 2 && !loader.active && !toYard) {
          lineMade += 1;
          it.on = false;
          it.node.visible = false;
          loaderPressed = false;
          const slot = pod.node.position.clone().add(new V3(0, 0.49, 0));
          loader.go(1, () => { loader.node.visible = false; setLoad(pod, pod.load + 1); }, [lineB.clone(), overHead.clone(), slot]);
        } else if ((toYard || it.waited > 1.4) && !yardRunner.active && yard.count < yard.capacity) {
          lineMade += 1;
          it.on = false;
          it.node.visible = false;
          const spot = yard.nextSpot();
          const to = vec(spot.p);
          yardRunner.node.rotation.y = spot.yaw;
          yardRunner.go(1, () => {
            yardRunner.node.visible = false;
            yard.add(1);
          }, [lineB.clone(), lineB.clone().lerp(to, 0.5).add(new V3(0, 0.5, 0)), to]);
        }
      }
    }
    if (loader.active && !loaderPressed && loader.t > 0.42) { loaderPressed = true; caster.press(1); }

    // While nothing new is coming off the line, the pod is filled from the yard.
    const pod = bayPod();
    yardLoadTimer -= dt;
    if (pod && pod.load < 2 && !b && !loader.active && yard.count > 3 && yardLoadTimer <= 0) {
      yardLoadTimer = 4;
      const spot = S.yard[yard.count - 1];
      yard.set(yard.count - 1);
      loaderPressed = false;
      const slot = pod.node.position.clone().add(new V3(0, 0.49, 0));
      loader.go(1, () => { loader.node.visible = false; setLoad(pod, pod.load + 1); }, [vec(spot.p), overHead.clone(), slot]);
    }

    // The hood burnishes whatever is under it, and the stacks throw a few embers while the furnace is pushed.
    hoodTimer -= dt;
    if (hoodTimer <= 0) {
      hoodTimer = 0.22;
      if (lineItems.some((o) => o.on && o.k > 0.58 && o.k < 0.82)) stage.sparks(hoodP, '#ffe6b8', 2, { speed: 0.55, spread: 0.7, up: 0.3, life: 0.45 });
    }
    stackTimer -= dt;
    if (stackTimer <= 0) {
      stackTimer = b ? 0.9 : 2.6;
      stage.sparks(stacks[Math.floor(stage.rand() * stacks.length)], '#ff8a3a', b ? 3 : 1, { speed: 0.5, spread: 0.45, up: 1.0, life: 1.3, gravity: 0.2 });
    }
  }

  // ---------- terrace ----------
  const waiting = stage.pile('waiting', 'panel_dull', S.waiting, 2);
  const finished = stage.pile('finished', 'panel', S.finished, 2);
  const strips = S.strip.map((spot) => {
    const node = stage.copy('strip_panel', spot);
    const mat = findMat(node, 'dull').clone();
    setMat(node, 'dull', mat);
    return { node, mat, x: 0, m: 0, want: 0 };
  });
  shadeOccluded(strips[0].node, 'dull', -0.55, 1.0);
  strips.forEach((s) => { s.mat.vertexColors = true; });
  const scan = stage.actor('scan');
  const scanHome = scan.position.clone();
  const scanAxis = vec(S.scan_end[0].p).sub(scanHome).normalize();
  strips.forEach((s) => { s.x = vec(s.node.position.toArray()).sub(scanHome).dot(scanAxis); });
  const barMat = findMat(scan, 'led_hot');
  if (barMat) barMat.emissive.set(cPolish);
  const barGlow = stage.glow(scanHome.clone(), WHITE, 0.7, 0);
  const scanTravel = 0.66;
  let scanX = -1;
  let scanDir = 1;
  let polishSpark = 0;
  const finishedHop = stage.runner('panel', [scanHome, overHead], { speed: 2.6, scale: 0.8 });
  setMat(finishedHop.node, 'chrome', mirrorMat);

  function updateTerrace(dt, t) {
    const b = busy('polish');
    scanX += scanDir * (b ? 0.62 : 0.16) * dt;
    const pos = scanX * scanTravel;
    for (const s of strips) {
      if (scanDir > 0 && pos > s.x) s.want = 1;
      s.m += (s.want - s.m) * (1 - Math.exp(-dt * (s.want ? 7 : 3)));
      s.mat.color.copy(COLD.color).lerp(mirrorMat.color, s.m);
      s.mat.roughness = mix(COLD.rough, mirrorMat.roughness, s.m);
    }
    scan.position.copy(scanHome).addScaledVector(scanAxis, pos);
    barGlow.sprite.position.copy(scan.position).add(new V3(0, 0.12, 0));
    barGlow.set((b ? 0.26 : 0.1) + 0.06 * Math.sin(t * 9));
    polishSpark -= dt;
    if (polishSpark <= 0 && b) {
      polishSpark = 0.3;
      stage.sparks(scan.position.clone().add(new V3(0, (stage.rand() - 0.5) * 0.7, 0)), '#fff6e6', 2, { speed: 0.45, spread: 0.7, up: 0.3, life: 0.4, gravity: 0.6 });
    }
    if (scanX >= 1) {
      scanX = 1;
      scanDir = -1;
      polisher.press(0.7);
    } else if (scanX <= -1) {
      scanX = -1;
      scanDir = 1;
      // A clean pass both ways: the panel moves to the finished rack and the next dull one takes its place.
      polisher.press(1);
      for (const s of strips) s.want = 0;
      if (waiting.count > 0) waiting.set(waiting.count - 1);
      if (finished.count < finished.capacity && !finishedHop.active) {
        const spot = finished.nextSpot();
        const to = vec(spot.p);
        finishedHop.node.rotation.y = spot.yaw;
        finishedHop.go(1, () => {
          finishedHop.node.visible = false;
          finished.add(1);
        }, [scanHome.clone(), scanHome.clone().lerp(to, 0.5).add(new V3(0, 0.5, 0)), to]);
      }
    }
    toolPolish.position.y = toolPolishY + (0.5 + 0.5 * Math.sin(t * (b ? 3.9 : 1.3))) * 0.035;
  }

  // ---------- summit: rack, crane, arm, ring ----------
  const summitRack = stage.pile('summit', 'panel', S.summit_rack, 3);
  const C = vec(S.ring_center[0].p);
  const axis = vec(S.ring_axis[0].p).sub(C).normalize();
  const e1 = vec(S.ring_e1[0].p).sub(C);
  const e2 = vec(S.ring_e2[0].p).sub(C);
  const Cf = vec(S.ring_front[0].p);
  const front = Cf.clone().sub(C);
  const ARM_OFF = front.length();
  front.normalize();
  const PICK = S.ring_front[0].pick;
  const TIP_R = S.ring_front[0].tip_r;
  const PHI0 = TIP_R + SLOT / 2;
  const grip0 = vec(S.section_grip[0].p).sub(C);
  const q = new THREE.Quaternion();
  const qAt = (phi) => q.setFromAxisAngle(axis, phi).clone();
  const gripAt = (phi, off = 0) => grip0.clone().applyQuaternion(qAt(phi - PHI0)).add(C).addScaledVector(front, off);

  const sections = Array.from({ length: SLOTS }, (_, k) => {
    const n = stage.copy('section');
    n.quaternion.copy(qAt(k * SLOT));
    n.visible = false;
    return n;
  });
  const carried = stage.copy('section');
  carried.visible = false;
  let ringCount = 1;
  sections[0].visible = true;

  const arm = stage.actor('arm');
  let armPhi = PICK;
  const trolley = stage.actor('trolley');
  const hook = stage.actor('hook');
  const cable = stage.actor('cable');
  const jibRoot = vec(S.jib_root[0].p);
  const jibTip = vec(S.jib_tip[0].p);
  const pickPoint = gripAt(PICK, ARM_OFF);
  const jibDir = jibTip.clone().sub(jibRoot);
  const trPick = THREE.MathUtils.clamp((pickPoint.x - jibRoot.x) * jibDir.x / jibDir.lengthSq() + (pickPoint.z - jibRoot.z) * jibDir.z / jibDir.lengthSq(), 0, 1);
  const rackTop = vec(S.summit_rack[1].p).add(new V3(0, 0.55, 0));
  const HOOK_LIFT = 0.62;
  const yRest = pickPoint.y + 1.3;
  let hookTr = trPick;
  let hookY = yRest;
  const setHook = () => {
    trolley.position.lerpVectors(jibRoot, jibTip, hookTr);
    hook.position.set(trolley.position.x, hookY, trolley.position.z);
    cable.position.copy(trolley.position);
    cable.scale.set(1, Math.max(0.02, trolley.position.y - hookY - 0.05), 1);
  };
  const hookPoint = new V3();
  const qPick = qAt(PICK - PHI0);
  const carryOnHook = () => {
    carried.quaternion.copy(qPick);
    hookPoint.set(hook.position.x, hookY - HOOK_LIFT, hook.position.z);
    carried.position.copy(hookPoint).sub(grip0.clone().applyQuaternion(qPick));
  };
  const fit = { phase: 'wait', t: 0, dur: 5, slot: 1, from: 0, to: 0, boost: 1, y0: 0, tr0: 0 };
  const go = (phase, dur) => { fit.phase = phase; fit.t = 0; fit.dur = dur; };
  let closedTimer = -1;
  let reopenTimer = -1;

  // ---------- the ring's flash and its passing sun ----------
  const shell = stage.actor('ring_shell');
  const shellU = {
    uColor: { value: SUNLIT.clone() },
    uE1: { value: e1 }, uE2: { value: e2 },
    uAmt: { value: 0 }, uBand: { value: 0 }, uSweep: { value: 0 }, uWidth: { value: 0.085 },
    uGapA: { value: TIP_R + ringCount * SLOT }, uGapB: { value: TIP_R + SLOTS * SLOT },
  };
  const shellMat = new THREE.ShaderMaterial({
    vertexShader: VS_SHELL, fragmentShader: FS_SHELL, uniforms: shellU, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
  shell.traverse((o) => { if (o.isMesh) { o.material = shellMat; o.renderOrder = 6; } });
  const ringGlow = stage.glow(C.clone(), WHITE, 13, 0);
  const hillGlow = stage.glow(C.clone().add(new V3(0, -5.5, 0)), WHITE, 20, 0);
  const poolGlow = stage.glow(new V3(C.x, -3.2, C.z - 9), WHITE, 1, 0);
  poolGlow.sprite.scale.set(20, 4.5, 1);
  const flash = { a: 0, band: 0, life: 1 };
  const sweep = { on: false, k: 0, timer: 4 };
  const ARC_START = TIP_R + SLOTS * SLOT;
  const ringPoint = (phi, r) => C.clone().addScaledVector(e1, Math.cos(phi) * r).addScaledVector(e2, Math.sin(phi) * r);

  function ringFlash(hex, amount) {
    shellU.uColor.value.set(hex).multiplyScalar(1.5);
    ringGlow.mat.color.set(hex);
    hillGlow.mat.color.set(hex);
    poolGlow.mat.color.set(hex);
    flash.a = amount;
    flash.life = 1;
    shellU.uWidth.value = 0.1 + amount * 0.1;
    sweep.on = true;
    sweep.k = 0;
    const burst = 6 + Math.round(30 * amount);
    for (let i = 0; i < burst; i += 1) {
      const phi = ARC_START + stage.rand() * Math.PI * 4 / 3;
      stage.sparks(ringPoint(phi, 3.9).addScaledVector(front, 0.5), hex, 1, { speed: 1 + amount, spread: 1, up: 0.7, life: 1 + amount * 0.5, gravity: 0.7 });
    }
  }
  const ringLabel = () => `${FINISHED + ringCount}/${FINISHED + SLOTS}`;
  const tagPos = ringPoint(rad(112), 2.5);
  const updateTag = () => stage.tag('ring', tagPos, ringLabel());

  function updateRing(dt) {
    // Now and then the sun runs round the finished part of the ring.
    if (!sweep.on) {
      sweep.timer -= dt;
      if (sweep.timer <= 0) {
        sweep.on = true;
        sweep.k = 0;
        sweep.timer = 7 + stage.rand() * 5;
        shellU.uColor.value.copy(SUNLIT);
        shellU.uWidth.value = 0.085;
      }
    }
    let band = 0;
    if (sweep.on) {
      sweep.k += dt * (flash.a > 0.01 ? 0.16 : 0.04);
      if (sweep.k >= 1) sweep.on = false;
      band = Math.sin(Math.min(1, sweep.k) * Math.PI);
      shellU.uSweep.value = ARC_START + sweep.k * (Math.PI * 4 / 3 + ringCount * SLOT);
    }
    if (flash.a > 0.003) {
      flash.life = Math.max(0, flash.life - dt / (0.9 + flash.a * 1.3));
      const f = flash.a * flash.life ** 1.4;
      // The mirror keeps its reflection through a found moment. The sparks, the chip and the running band carry it.
      shellU.uAmt.value = f * 0.05;
      shellU.uBand.value = 0.3 * band + flash.a * 0.25 * flash.life;
      ringGlow.set(f * 0.08);
      hillGlow.set(f * 0.035);
      poolGlow.set(f * 0.06);
      if (flash.life <= 0) flash.a = 0;
    } else {
      shellU.uAmt.value = 0;
      shellU.uBand.value = (busy('lead') ? 0.38 : 0.3) * band;
    }
    shellU.uGapA.value = TIP_R + ringCount * SLOT;
    shell.visible = shellU.uAmt.value > 0.003 || shellU.uBand.value > 0.003;
  }

  function seatSection() {
    sections[fit.slot].visible = true;
    carried.visible = false;
    ringCount += 1;
    lead.press(1);
    updateTag();
    const at = gripAt(PHI0 + fit.slot * SLOT, 0.5);
    stage.sparks(at, WHITE, 14, { speed: 1.1, spread: 1, up: 0.6, life: 0.8 });
    ringFlash(cLead, 0.16);
    if (ringCount >= SLOTS) closedTimer = 6;
  }

  function updateSummit(dt, t) {
    const b = busy('lead');
    const s = dt * fit.boost;
    fit.t += s;
    const k = ease(fit.t / fit.dur);
    if (fit.phase === 'wait') {
      if (fit.t >= fit.dur && closedTimer < 0 && reopenTimer < 0 && ringCount < SLOTS && summitRack.count > 0) {
        fit.slot = ringCount;
        fit.tr0 = hookTr;
        fit.y0 = hookY;
        go('down', 2.2);
      }
    } else if (fit.phase === 'down') {
      hookTr = mix(fit.tr0, 1, k);
      hookY = mix(fit.y0, rackTop.y + HOOK_LIFT, k);
      if (fit.t >= fit.dur) {
        summitRack.set(summitRack.count - 1);
        carried.visible = true;
        stage.sparks(rackTop, WHITE, 4, { speed: 0.5, spread: 0.6, up: 0.4, life: 0.5 });
        go('up', 4.2);
      }
    } else if (fit.phase === 'up') {
      hookTr = mix(1, trPick, k);
      hookY = mix(rackTop.y, pickPoint.y, k) + HOOK_LIFT;
      carryOnHook();
      if (fit.t >= fit.dur) {
        carried.position.copy(C).addScaledVector(front, ARM_OFF);
        carried.quaternion.copy(qPick);
        fit.y0 = hookY;
        go('grip', 0.5);
      }
    } else if (fit.phase === 'grip') {
      hookY = mix(fit.y0, yRest, k);
      if (fit.t >= fit.dur) {
        fit.from = armPhi;
        fit.to = PHI0 + fit.slot * SLOT;
        go('swing', 3.2);
      }
    } else if (fit.phase === 'swing') {
      armPhi = mix(fit.from, fit.to, k);
      carried.quaternion.copy(qAt(armPhi - PHI0));
      if (fit.t >= fit.dur) go('seat', 0.75);
    } else if (fit.phase === 'seat') {
      carried.position.copy(C).addScaledVector(front, ARM_OFF * (1 - k));
      if (fit.t >= fit.dur) {
        seatSection();
        fit.from = armPhi;
        fit.to = PICK;
        go('back', 2.4);
      }
    } else if (fit.phase === 'back') {
      armPhi = mix(fit.from, fit.to, k);
      if (fit.t >= fit.dur) {
        fit.boost = 1;
        go('wait', b ? 12 + stage.rand() * 4 : 26 + stage.rand() * 8);
      }
    }
    arm.quaternion.copy(qAt(armPhi));
    setHook();
    hook.position.y += Math.sin(t * 1.1) * 0.012;

    // A closed ring holds for a moment, then the next one starts from the part that is still standing.
    if (closedTimer >= 0) {
      closedTimer -= dt;
      if (closedTimer < 0) reopenTimer = 0;
    }
    if (reopenTimer >= 0) {
      reopenTimer -= dt;
      if (reopenTimer <= 0) {
        if (ringCount > 2) {
          ringCount -= 1;
          sections[ringCount].visible = false;
          stage.sparks(gripAt(PHI0 + ringCount * SLOT, 0.5), WHITE, 4, { speed: 0.7, spread: 0.8, up: 0.5, life: 0.5 });
          updateTag();
          reopenTimer = 0.2;
        } else {
          reopenTimer = -1;
        }
      }
    }
    toolLead.position.y = toolLeadY + (0.5 + 0.5 * Math.sin(t * (b ? 2.1 : 0.9))) * 0.03;
  }

  // ---------- results racing up the rail on a done ----------
  const pulses = [0, 1, 2].map(() => {
    const g = stage.glow(new V3(), WHITE, 1.1, 0);
    g.mat.depthTest = true;
    return { g, k: 0, on: false, pts: null, cb: null };
  });
  const firePulse = (pts, hex, cb) => {
    const p = pulses.find((o) => !o.on) ?? pulses[0];
    p.on = true;
    p.k = 0;
    p.pts = pts;
    p.cb = cb;
    p.g.mat.color.set(hex);
    p.g.sprite.visible = true;
  };
  const pulseOut = new V3();
  function updatePulses(dt) {
    for (const p of pulses) {
      if (!p.on) continue;
      p.k = Math.min(1, p.k + dt / 2.2);
      pointAlongRoute(p.pts, p.k, pulseOut);
      p.g.sprite.position.copy(pulseOut);
      p.g.set(0.85);
      if (p.k >= 1) {
        p.on = false;
        p.g.set(0);
        const cb = p.cb;
        p.cb = null;
        cb?.();
      }
    }
  }

  // ---------- worlds ----------
  const up = (k, y) => posOf(k).add(new V3(0, y, 0));
  const bayP = wayAt(S_BAY, new V3());
  const leg1 = wayLine(S_BAY, S_TERRACE, 24);
  const leg2 = wayLine(S_TERRACE, S_DOCK, 20);
  const worlds = new Map();
  const foundryWorld = stage.worldRecord({
    anchorAt: up('foundry', info.bots.foundry.size * 1.12),
    center: fp.clone().add(new V3(-1.6, 0.8, 0)),
    zoom: 2,
    route: [fp, bayP, ...leg1, pp, ...leg2, lp],
  });
  foundryWorld.handoff = leg1.length + 2;
  worlds.set(config.bots[0].id, foundryWorld);
  const polishWorld = stage.worldRecord({
    anchorAt: up('polish', info.bots.polish.size * 1.12),
    center: pp.clone().add(new V3(0.6, 0.8, 0)),
    zoom: 2,
    route: [pp, ...leg2, lp],
  });
  worlds.set(config.bots[1].id, polishWorld);
  const main = stage.worldRecord({
    anchorAt: up('lead', info.bots.lead.size * 1.05),
    center: C.clone().add(new V3(1.2, -0.6, 0)),
    zoom: 1.7,
  });

  const keyOf = (world) => (world === foundryWorld ? 'foundry' : world === polishWorld ? 'polish' : 'lead');
  const colorOf = { foundry: cFoundry, polish: cPolish, lead: cLead };
  const LEVELS = { idle: 0.14, working: 0.55, found: 0.95, done: 0.45, needs_approval: 0.28 };

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
      ringFlash(colorOf[key], 0.42 + 0.58 * (evt.intensity ?? 0.5));
      if (Number.isFinite(evt.value) && evt.value > 0) stage.chip(world.anchor.position.clone(), `+${evt.value}`, colorOf[key]);
      return;
    }
    if (evt.type === 'done') {
      stage.setLevel(key, LEVELS.done);
      state[key] = 'done';
      if (key === 'foundry') {
        const pod = bayPod();
        if (pod && pod.load >= 1) { pod.state = 'climb1'; sinceDepart = 0; }
        firePulse(evt.route ?? [fp, pp], cFoundry, () => {
          if (waiting.count < waiting.capacity) waiting.add(1);
        });
      } else if (key === 'polish') {
        firePulse(evt.route ?? [pp, lp], cPolish, () => {
          if (summitRack.count < summitRack.capacity) summitRack.add(1);
        });
      } else {
        // The lead's sign off hurries whatever is on its way into the ring.
        fit.boost = 1.6;
        if (fit.phase === 'wait') fit.t = fit.dur;
        lead.press(1);
      }
      return;
    }
    state[key] = evt.type;
    stage.setLevel(key, LEVELS[evt.type] ?? 0.3);
  }

  updateTag();

  function update(dt, t) {
    for (const b of Object.values(bots)) b.update(dt);
    botRefl.set(0.3 + (busy('foundry') ? 0.1 : 0));
    updatePods(dt);
    updateFoundry(dt, t);
    updateTerrace(dt, t);
    updateSummit(dt, t);
    updateRing(dt);
    updatePulses(dt);
    living.update(dt, t);
  }

  return stage.island({
    worlds, main, applyEvent, update,
    // Carried things on the camera's side of the hill right now. Three z points toward the camera here.
    transitCount: () => pods.filter((p) => p.node.visible && p.load > 0 && p.state !== 'bay' && p.node.position.z > 0.5).length
      + lineItems.filter((o) => o.on).length
      + [loader, yardRunner, finishedHop, ...podHops].filter((o) => o.active).length
      + (carried.visible ? 1 : 0),
    dispose() {
      for (const b of Object.values(bots)) b.dispose();
      meltGeo.dispose();
      meltMat.dispose();
      shellMat.dispose();
      living.dispose();
    },
  });
}
