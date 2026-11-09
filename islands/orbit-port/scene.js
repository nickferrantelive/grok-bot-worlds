// Orbit Port, a freight line in orbit. A ship is waved into the arrivals bay, its crates roll along the spine through the
// scan gate, cleared crates are stacked in the rack, a yard tug takes them to the cradle and the lead fires them out on the rail.
// The station and the planet are the Cycles plate. Everything that moves is live.

import * as THREE from 'three';
import { createStage } from '../../engine/plate/stage.js';
import { pointAlongRoute, routeLength } from '../../engine/route.js';

export const teamSizes = [4];

// Colours are the render's bot colours, written as display hex.
export const exampleTeam = {
  workspace: 'Orbit Freight Co',
  timezone: 'America/New_York',
  lead: { id: 'launch', name: 'launch', role: 'signs off and ships it', color: '#f4f5f7', schedule: 'daily' },
  bots: [
    { id: 'marshal', name: 'marshal', role: 'brings in new requests', color: '#ffa23f', schedule: 'daily' },
    { id: 'scanner', name: 'scanner', role: 'checks each one against the rules', color: '#50dda2', schedule: 'daily' },
    { id: 'stacker', name: 'stacker', role: 'queues what passed', color: '#ff59ad', schedule: 'daily' },
  ],
};

const AMBER = '#ff9a4a';
const THRUST = new THREE.Color(0.14, 0.44, 1.0);
const smooth = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// The render's station lights are the bot colour pushed harder than its body, so the lit strips hold their hue.
function ledHex(hex) {
  const c = new THREE.Color(hex);
  const m = Math.max(c.r, c.g, c.b) || 1;
  return `#${new THREE.Color(Math.pow(c.r / m, 1.7), Math.pow(c.g / m, 1.7), Math.pow(c.b / m, 1.7)).getHexString()}`;
}

// Cycles gives glossy rays a lit world that camera rays never see, so the plate's env pano has none of it and live metal
// goes black. This is that same world, built from the look script's lobes, for everything live but the bots.
const WORLD_VS = /* glsl */ `
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const WORLD_FS = /* glsl */ `
varying vec3 vDir;
float lobe(vec3 d, vec3 l, float p) { return pow(max(dot(d, normalize(l)), 0.0), p); }
void main() {
  vec3 d = normalize(vDir);
  vec3 c = vec3(0.0016, 0.005, 0.018);
  c += vec3(0.42, 0.5, 0.86) * 0.32 * lobe(d, vec3(0.0, -1.0, 0.0), 1.4);
  c += vec3(1.0, 0.96, 0.9) * 0.2 * lobe(d, vec3(0.0, 1.0, 0.0), 1.8);
  c += vec3(1.0, 0.9, 0.78) * 2.6 * lobe(d, vec3(0.72, 0.55, 0.42), 16.0);
  c += vec3(0.72, 0.84, 1.0) * 0.9 * lobe(d, vec3(-0.85, 0.42, 0.3), 7.0);
  gl_FragColor = vec4(c, 1.0);
}`;
function glossyWorld(renderer) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), new THREE.ShaderMaterial({ vertexShader: WORLD_VS, fragmentShader: WORLD_FS, side: THREE.BackSide, depthWrite: false })));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0, 0.1, 100);
  pm.dispose();
  return rt.texture;
}

const TRAIL_VS = /* glsl */ `
attribute float aS;
varying float vS;
varying vec3 vN, vV;
void main() {
  vS = aS;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const TRAIL_FS = /* glsl */ `
uniform float uHead, uLen, uFade, uEdge;
uniform vec3 uColor;
varying float vS;
varying vec3 vN, vV;
void main() {
  float d = uHead - vS;
  if (d < 0.0) discard;
  float along = pow(max(0.0, 1.0 - d / uLen), 2.2);
  float edge = pow(abs(dot(normalize(vN), normalize(vV))), uEdge);
  gl_FragColor = vec4(uColor, along * edge * uFade);
}`;

// A tube along a polyline that knows how far along each ring is, so a shader can run light down it.
function tubeAlong(points, radius, radial = 10) {
  const total = routeLength(points);
  const pos = [];
  const nor = [];
  const s = [];
  const idx = [];
  let walked = 0;
  const up = new THREE.Vector3(0, 1, 0);
  const d = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  points.forEach((p, i) => {
    const q = points[Math.min(i + 1, points.length - 1)];
    const o = points[Math.max(i - 1, 0)];
    d.copy(q).sub(o).normalize();
    a.crossVectors(d, up).normalize();
    b.crossVectors(a, d).normalize();
    if (i > 0) walked += p.distanceTo(points[i - 1]);
    for (let j = 0; j < radial; j += 1) {
      const t = (j / radial) * Math.PI * 2;
      const nx = a.x * Math.cos(t) + b.x * Math.sin(t);
      const ny = a.y * Math.cos(t) + b.y * Math.sin(t);
      const nz = a.z * Math.cos(t) + b.z * Math.sin(t);
      pos.push(p.x + nx * radius, p.y + ny * radius, p.z + nz * radius);
      nor.push(nx, ny, nz);
      s.push(walked / total);
    }
  });
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const n = (j + 1) % radial;
      idx.push(i * radial + j, i * radial + n, (i + 1) * radial + n, i * radial + j, (i + 1) * radial + n, (i + 1) * radial + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(s, 1));
  g.setIndex(idx);
  return g;
}

// ---------- the place itself, alive ----------
// The live layer is laid over the plate through AgX with premultiplied alpha, so a colour far above 1 lerps the plate towards
// white (a screen) and a colour near 1 lerps it towards that colour. These shaders write straight into that layer.
const OVER_LAYER = {
  transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};
const WORLD_POS_VS = /* glsl */ `
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
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.9375;
}`;

// The same sphere the render's planet is, traced per pixel: weather sliding round it, thin airglow over its limb. Behind the
// station and in front of the plate's own planet, so the station cuts it off by itself.
const PLANET_FS = /* glsl */ `
precision highp float;
uniform vec3 uC, uAxis, uE1, uE2;
uniform float uR, uT;
varying vec3 vW;
${NOISE}
void main() {
  vec3 rd = normalize(vW - cameraPosition);
  vec3 oc = cameraPosition - uC;
  float b = dot(oc, rd);
  float closest = sqrt(max(0.0, dot(oc, oc) - b * b));
  float h = (closest - uR) / uR;
  if (h > 0.05) discard;
  vec3 n = h < 0.0 ? normalize(oc + rd * (-b - sqrt(uR * uR - closest * closest))) : normalize(oc + rd * -b);
  float lon = atan(dot(n, uE2), dot(n, uE1));
  float lat = asin(clamp(dot(n, uAxis), -1.0, 1.0));
  float a = 0.0;
  vec3 col = vec3(0.0);
  if (h < 0.0) {
    float mu = max(0.0, dot(n, -rd));
    // Three decks of weather, each on its own wind: the low deck crawls, the middle one drifts, high cirrus runs over both.
    vec2 q1 = vec2((lon - uT * 0.003) * 20.0, lat * 40.0);
    q1 += 0.8 * vec2(vn(q1 * 0.6 + uT * 0.004), vn(q1 * 0.6 + 7.3 - uT * 0.003));
    float deck = smoothstep(0.46, 0.66, fbm(q1));
    vec2 q2 = vec2((lon - uT * 0.0075) * 36.0, lat * 80.0 + 3.1);
    float mid = smoothstep(0.5, 0.7, fbm(q2 + 0.5 * vn(q2 * 0.4)));
    float shade = smoothstep(0.5, 0.7, fbm(q2 + vec2(-0.25, -0.9) + 0.5 * vn((q2 + vec2(-0.25, -0.9)) * 0.4)));
    vec2 q3 = vec2((lon - uT * 0.015) * 16.0, lat * 110.0 + 7.7);
    float high = smoothstep(0.55, 0.72, fbm(q3));
    // Sunlit near the limb and going into the dark below it. The very edge is thick air, where the render's glow takes over.
    float lit = smoothstep(0.2, 0.05, mu) * smoothstep(0.0, 0.025, mu);
    float cover = 1.0 - (1.0 - deck * 0.82) * (1.0 - mid * 0.6) * (1.0 - high * 0.42);
    a = cover * lit * 0.6;
    col = mix(vec3(0.55, 0.78, 1.3), vec3(1.7, 1.8, 2.0), max(deck, high) * lit) * a;
    // The middle deck's shadow on what is under it, or the band stays a soft gradient with white on top.
    float dark = shade * (1.0 - mid) * 0.3 * lit;
    a = a + dark * (1.0 - a);
    float night = smoothstep(0.09, 0.2, mu);
    // The planet goes into its own night towards the bottom of the frame.
    a += (1.0 - a) * 0.62 * night;
  }
  // The thin air at the limb: its brightness wanders along the edge, and a faint veil lifts off it.
  float along = fbm(vec2(lon * 16.0 - uT * 0.11, uT * 0.05));
  float edge = exp(-abs(h) / 0.0042);
  float veil = exp(-max(h, 0.0) / 0.012) * step(0.0, h) * smoothstep(0.42, 0.74, fbm(vec2(lon * 24.0 - uT * 0.16, h * 150.0 - uT * 0.12)));
  float glowA = edge * max(0.0, along - 0.34) * 0.42 + veil * 0.13;
  col += vec3(0.62, 0.84, 1.6) * glowA * 1.6;
  a = a + glowA;
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, min(1.0, a));
}`;

// Far dust lit from far away: only ever a few levels above the dark, drifting and folding very slowly.
const NEBULA_FS = /* glsl */ `
precision highp float;
uniform float uT, uR;
uniform vec3 uC;
varying vec3 vW;
${NOISE}
void main() {
  vec3 rd = normalize(vW - cameraPosition);
  // The plate's atmosphere shell is in its depth map. Fading out above it keeps that silhouette from showing as an edge.
  vec3 oc = cameraPosition - uC;
  float b = dot(oc, rd);
  float above = (sqrt(max(0.0, dot(oc, oc) - b * b)) - uR) / uR;
  float clear = smoothstep(0.034, 0.1, above);
  if (clear <= 0.0) discard;
  vec2 q = vec2(rd.x / max(0.2, -rd.z), rd.y / max(0.2, -rd.z)) * 7.0;
  vec2 w = vec2(vn(q * 0.7 + uT * 0.012), vn(q * 0.7 + 5.2 - uT * 0.01));
  float n = fbm(q + w * 1.8 + vec2(uT * 0.016, -uT * 0.004));
  float m = fbm(q * 0.55 - w * 0.9 + vec2(-uT * 0.009, uT * 0.006) + 11.0);
  float a = 0.1 * clear * smoothstep(0.42, 0.78, n) * smoothstep(0.34, 0.68, m);
  if (a < 0.002) discard;
  gl_FragColor = vec4(mix(vec3(0.16, 0.36, 1.0), vec3(0.44, 0.3, 1.0), m) * 1.7 * a, a);
}`;

// A soft glint that travels round the great ring. The ring is in the plate, so light is what turns.
const RING_BAND_VS = /* glsl */ `
varying vec3 vP, vN, vV;
void main() {
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const RING_BAND_FS = /* glsl */ `
precision highp float;
uniform float uAngle;
varying vec3 vP, vN, vV;
void main() {
  float th = atan(vP.y, vP.x) + uAngle;
  float band = pow(0.5 + 0.5 * cos(th * 3.0), 10.0) + 0.55 * pow(0.5 + 0.5 * cos(th * 3.0 + 2.2), 26.0);
  float facing = smoothstep(0.1, 0.6, abs(dot(normalize(vN), normalize(vV))));
  float a = 0.2 * band * facing;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vec3(1.0, 0.94, 0.84) * 3.4 * a, a);
}`;

// Sun catching a flat solar wing as the station turns: a pale sheen crosses each panel and is gone.
const SHEEN_FS = /* glsl */ `
precision highp float;
uniform float uT, uPhase;
varying vec2 vUv;
void main() {
  float s = fract(uT / 17.0 + uPhase);
  float d = (vUv.x * 0.62 + vUv.y * 0.38) * 1.5 - 0.25 - s * 2.0 + 0.5;
  float band = exp(-d * d / 0.018) + 0.35 * exp(-(d + 0.2) * (d + 0.2) / 0.004);
  float edge = smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.97, vUv.x) * smoothstep(0.0, 0.03, vUv.y) * smoothstep(1.0, 0.97, vUv.y);
  float a = 0.34 * band * edge;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vec3(0.72, 0.86, 1.3) * 2.2 * a, a);
}`;

function livingPort(stage, ships, { rackCount, bayAt }) {
  const { info } = stage;
  const { H, R, U, F } = stage;
  const tanH = Math.tan(THREE.MathUtils.degToRad(info.camera.hfov) / 2);
  const tanV = Math.tan(THREE.MathUtils.degToRad(info.camera.vfov) / 2);
  const OS = 1.035;
  const uT = { value: 0 };
  // Places are picked on the 1920 x 1080 home frame, each with its distance from the plate's depth map.
  const atNdc = (nx, ny, d) => H.clone().addScaledVector(F, d).addScaledVector(R, nx * tanH * d).addScaledVector(U, ny * tanV * d);
  const atPx = (px, py, d) => atNdc((px / 960 - 1) / OS, (1 - py / 540) / OS, d);
  const screenQuad = (d, nx0, nx1, ny0, ny1, material, order) => {
    const g = new THREE.BufferGeometry().setFromPoints([atNdc(nx0, ny0, d), atNdc(nx1, ny0, d), atNdc(nx1, ny1, d), atNdc(nx0, ny1, d)]);
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const m = new THREE.Mesh(g, material);
    m.frustumCulled = false;
    m.renderOrder = order;
    stage.live.add(m);
    return m;
  };
  const depthTested = (g) => { g.mat.depthTest = true; return g; };

  // ---------- deep space: the far dust and the stars. Both sit behind the plate's planet and station ----------
  const starAt = atNdc(0, 0.1, 300);
  // The field creeps as the station goes round the planet. Most are specks, a few are bright enough to carry at half size.
  stage.particles({ count: 620, center: starAt, box: [240, 150, 34], velocity: [-0.09, 0.014, 0], size: [0.09, 0.2], color: '#d6e4ff', additive: true, opacity: 1, hard: 1.1, flicker: 0.6, order: 2 });
  stage.particles({ count: 30, center: starAt, box: [240, 150, 34], velocity: [-0.09, 0.014, 0], size: [0.16, 0.22], color: '#fff2dc', additive: true, opacity: 1, hard: 1.0, flicker: 0.85, order: 2 });

  // ---------- the planet ----------
  // Where the look script put it, from the camera: the same numbers, in three.js axes.
  const beta = THREE.MathUtils.degToRad(66.3);
  const tilt = THREE.MathUtils.degToRad(-6);
  const pd = F.clone().multiplyScalar(Math.cos(beta)).addScaledVector(U, -Math.cos(tilt) * Math.sin(beta)).addScaledVector(R, Math.sin(tilt) * Math.sin(beta)).normalize();
  const planetR = 600 * Math.sin(THREE.MathUtils.degToRad(58));
  const planetC = H.clone().addScaledVector(pd, 600);
  screenQuad(320, -1.25, 1.25, -1.25, 1.25, new THREE.ShaderMaterial({ vertexShader: WORLD_POS_VS, fragmentShader: NEBULA_FS, uniforms: { uT, uC: { value: planetC }, uR: { value: planetR } }, ...OVER_LAYER }), 1);
  const axis = F.clone().multiplyScalar(-0.86).addScaledVector(R, 0.36).addScaledVector(U, 0.2).normalize();
  const e1 = R.clone().addScaledVector(axis, -R.dot(axis)).normalize();
  const e2 = axis.clone().cross(e1);
  screenQuad(145, -1.25, 1.25, -1.25, -0.2, new THREE.ShaderMaterial({
    vertexShader: WORLD_POS_VS,
    fragmentShader: PLANET_FS,
    uniforms: { uT, uC: { value: planetC }, uR: { value: planetR }, uAxis: { value: axis }, uE1: { value: e1 }, uE2: { value: e2 } },
    ...OVER_LAYER,
  }), 3);

  // ---------- the great ring: a glint and a line of ports turning round it ----------
  const ringC = stage.vec(info.spots.ring[0].p);
  const ringN = stage.vec(info.spots.ring_axis[0].p).sub(ringC).normalize();
  const ringMat = new THREE.ShaderMaterial({ vertexShader: RING_BAND_VS, fragmentShader: RING_BAND_FS, uniforms: { uAngle: { value: 0 } }, ...OVER_LAYER });
  const ringBand = new THREE.Mesh(new THREE.TorusGeometry(4.7, 0.79, 16, 128), ringMat);
  ringBand.position.copy(ringC);
  ringBand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ringN);
  ringBand.renderOrder = 7;
  stage.live.add(ringBand);
  const ringE1 = new THREE.Vector3(1, 0, 0).applyQuaternion(ringBand.quaternion);
  const ringE2 = new THREE.Vector3(0, 1, 0).applyQuaternion(ringBand.quaternion);
  // The collar: a real part, in the white and gold of the hull, seated on the ring's outer shoulder and running in a dark track.
  // The section follows the ring's own surface, which the look script stretches along its axis by 1.12.
  const RING_R = 4.7;
  const RING_r = 0.72;
  const onSurface = (a, phi, lift, out) => {
    const rho = RING_R + (RING_r + lift) * Math.sin(phi);
    out.push(rho * Math.cos(a), rho * Math.sin(a), -(RING_r * 1.12 + lift) * Math.cos(phi));
  };
  // One curved panel: up from the surface, across its top, down the other side, and closed at both ends.
  const panel = (out, a0, a1, phi0, phi1, lift, steps = 6) => {
    const section = [[phi0, 0], [phi0, lift], [(phi0 + phi1) / 2, lift], [phi1, lift], [phi1, 0]];
    const vert = (ia, is) => { onSurface(a0 + ((a1 - a0) * ia) / steps, section[is][0], section[is][1], out); };
    for (let i = 0; i < steps; i += 1) {
      for (let j = 0; j < section.length - 1; j += 1) {
        vert(i, j); vert(i + 1, j); vert(i + 1, j + 1);
        vert(i, j); vert(i + 1, j + 1); vert(i, j + 1);
      }
    }
    for (const ia of [0, steps]) {
      vert(ia, 0); vert(ia, 1); vert(ia, 3);
      vert(ia, 0); vert(ia, 3); vert(ia, 4);
    }
  };
  const meshOf = (verts, name, fallback, parent) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.computeVertexNormals();
    let source = null;
    stage.live.traverse((o) => { if (!source && o.isMesh && o.material?.name === name) source = o.material; });
    const m = source ? source.clone() : new THREE.MeshStandardMaterial(fallback);
    m.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    parent.add(mesh);
    return mesh;
  };
  const deg = Math.PI / 180;
  const PHI0 = 15 * deg;
  const PHI1 = 47 * deg;
  const track = new THREE.Group();
  track.position.copy(ringC);
  track.quaternion.copy(ringBand.quaternion);
  stage.live.add(track);
  const trackV = [];
  panel(trackV, 0, Math.PI * 2, PHI0 - 3 * deg, PHI1 + 3 * deg, 0.02, 120);
  meshOf(trackV, 'flat_hulld', { color: 0x0c0d10, roughness: 0.4, metalness: 1 }, track);
  const collar = new THREE.Group();
  collar.position.copy(ringC);
  stage.live.add(collar);
  const PANELS = 16;
  const whiteV = [];
  const goldV = [];
  const darkV = [];
  for (let i = 0; i < PANELS; i += 1) {
    const a0 = (i / PANELS) * Math.PI * 2 + 0.8 * deg;
    const a1 = ((i + 1) / PANELS) * Math.PI * 2 - 0.8 * deg;
    const gold = i === 0 || i === 1 || i === 9;
    panel(gold ? goldV : whiteV, a0, a1, PHI0, PHI1, 0.07);
    // A dark hatch on every other white panel: on a white ring it is the contrast that shows the turning.
    if (!gold && i % 2 === 0) {
      const mid = (a0 + a1) / 2;
      panel(darkV, mid - 4.5 * deg, mid + 4.5 * deg, 24 * deg, 38 * deg, 0.085, 3);
    }
  }
  meshOf(whiteV, 'flat_hull', { color: 0xeeeeee, roughness: 0.42 }, collar);
  meshOf(goldV, 'flat_gold', { color: 0xc89a3c, roughness: 0.33, metalness: 1 }, collar);
  meshOf(darkV, 'flat_hulld', { color: 0x0c0d10, roughness: 0.4, metalness: 1 }, collar);
  // Small lamps on a few of the joints, real beads with a little light round them, carried by the collar.
  const beadGeo = new THREE.SphereGeometry(0.05, 10, 8);
  const beadMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 4.6, 1.8), toneMapped: false });
  const lampAt = [];
  for (const i of [2, 6, 9, 13]) {
    const a = (i / PANELS) * Math.PI * 2;
    onSurface(a, 31 * deg, 0.1, lampAt);
    const n = lampAt.length - 3;
    const bead = new THREE.Mesh(beadGeo, beadMat);
    bead.position.set(lampAt[n], lampAt[n + 1], lampAt[n + 2]);
    collar.add(bead);
    const g = depthTested(stage.glow(bead.position, '#ffb36b', 0.62, 0.8));
    collar.add(g.sprite);
  }
  let collarAngle = 0;
  const collarTurn = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const updateCollar = (dt) => {
    // One turn in 40 seconds, steady, whatever the line is doing.
    collarAngle += (dt * Math.PI * 2) / 40;
    collar.quaternion.copy(ringBand.quaternion).multiply(collarTurn.setFromAxisAngle(zAxis, collarAngle));
  };
  // Running out along the launch rail, past the small rings. Only a few.
  for (const l of stage.chase(stage.path('rail').slice(8), '#ffb36b', { count: 3, speed: 6.5, size: 0.4, opacity: 0.85 })) depthTested(l);

  // ---------- solar wings ----------
  const sheenQuad = (corners, phase) => {
    const pts = corners.map(([x, y, d]) => atPx(x, y, d));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: WORLD_POS_VS, fragmentShader: SHEEN_FS, uniforms: { uT, uPhase: { value: phase } }, side: THREE.DoubleSide, ...OVER_LAYER }));
    m.frustumCulled = false;
    m.renderOrder = 7;
    stage.live.add(m);
  };
  sheenQuad([[797, 40, 64], [873, 118, 63], [768, 177, 63], [693, 93, 64]], 0);
  sheenQuad([[930, 183, 61], [1014, 264, 60], [908, 331, 60], [825, 240, 61]], 0.12);

  // ---------- docking lights ----------
  const flash = (px, py, d, color, o) => depthTested(stage.blink(atPx(px, py, d), color, o));
  flash(827, 306, 48, '#ff4a3a', { period: 2.4, on: 0.14, size: 0.62 });
  flash(166, 172, 56, '#ffc27a', { period: 3.2, on: 0.1, size: 0.72 });
  flash(456, 165, 58, '#ffc27a', { period: 3.2, on: 0.1, phase: 0.5, size: 0.72 });
  flash(213, 500, 32, '#f4f8ff', { period: 4.6, on: 0.06, phase: 0.2, size: 0.62 });
  flash(1226, 92, 60, '#f4f8ff', { period: 3.8, on: 0.07, phase: 0.65, size: 0.8 });

  // ---------- cold gas: thin, fast blow-offs that open and shut, because gas in vacuum does not hang about ----------
  const jet = (center, velocity, life, width, on, off, phase, opacity) => ({
    on, off, opacity, t: phase,
    sys: stage.particles({ count: 34, center, box: [0.03, 0.03, 0.03], velocity, life, size: width, color: '#e6f0ff', additive: true, opacity: 0, hard: 1.4, stretch: 5, fadeIn: 0.03, fadeOut: 0.2 }),
  });
  const jets = [
    jet(atPx(214, 500, 33), [-0.3, 2.3, 0.25], 0.55, [0.008, 0.035], 2.2, 3.6, 0.5, 0.8),
    jet(atPx(1262, 500, 56), [1.7, -0.85, 0.3], 0.7, [0.012, 0.05], 1.6, 4.4, 3.2, 0.85),
  ];
  const updateJets = (dt) => {
    for (const j of jets) {
      j.t = (j.t + dt) % (j.on + j.off);
      const up = Math.min(1, j.t / 0.12);
      const down = Math.min(1, Math.max(0, (j.on - j.t) / 0.35));
      j.sys.setOpacity(j.opacity * up * down);
    }
  };

  // ---------- trim puffs from the ships while they wait ----------
  const puffs = ships.map((ship, i) => ({
    ship,
    wait: 1.5 + i * 2.2,
    e: 0,
    at: new THREE.Vector3(i % 2 ? -1.55 : 1.0, 0.75, 0.75),
    sys: stage.particles({ count: 18, center: [0, 0, 0], box: [0.04, 0.04, 0.04], velocity: [0.3, 0.5, 1.7], life: 0.45, size: [0.012, 0.05], color: '#e8f1ff', additive: true, opacity: 0, hard: 1.4, stretch: 4, fadeIn: 0.03, fadeOut: 0.2 }),
  }));
  const puffAt = new THREE.Vector3();
  const updatePuffs = (dt) => {
    for (const p of puffs) {
      const turning = p.ship.phase === 'leave' && p.ship.u < 0.72;
      const idle = p.ship.node.visible && (p.ship.phase === 'hold' || p.ship.phase === 'down' || p.ship.stalled || turning);
      p.wait -= dt;
      if (p.wait <= 0) {
        if (idle) p.e = 1;
        p.wait = turning ? 1 + stage.rand() * 1.1 : 2.6 + stage.rand() * 3.4;
        // Each burst comes from a different corner of the ship, as attitude jets do.
        p.at.x = stage.rand() > 0.5 ? -1.55 : 1.0;
        p.at.y = 0.3 + stage.rand() * 0.7;
      }
      p.e = Math.max(0, p.e - dt * 2.4);
      p.sys.setOpacity(idle ? 0.8 * p.e : 0);
      if (idle && p.e > 0) {
        p.ship.node.updateWorldMatrix(true, false);
        p.sys.uniforms.uCenter.value.copy(puffAt.copy(p.at).applyMatrix4(p.ship.node.matrixWorld));
      }
    }
  };

  // ---------- status lights on the racked crates, one on each slot that holds one ----------
  const rackSpots = info.spots.rack;
  const rackFront = stage.vec(info.spots.rack_front[0].p).normalize();
  const rackSide = new THREE.Vector3(0, 1, 0).cross(rackFront).normalize();
  const STATUS_PERIOD = [1.3, 2.1, 1.7, 2.9, 1.1, 2.4, 3.3, 1.5, 2.7, 1.9, 3.1, 1.2];
  rackSpots.forEach((slot, i) => {
    const at = stage.vec(slot.p).addScaledVector(rackFront, 0.72).addScaledVector(rackSide, 0.3).add(new THREE.Vector3(0, -0.12, 0));
    const color = i % 5 === 3 ? '#ffb040' : '#5cff9c';
    const g = depthTested(stage.blink(at, color, { period: STATUS_PERIOD[i], phase: (i * 0.37) % 1, on: 0.5, size: 0.5, opacity: 1, dim: 0.12 }));
    g.mat.color.multiplyScalar(2.2);
    const set = g.set;
    g.set = (v) => set(i < rackCount() ? v : 0);
  });

  // The band on every cleared crate breathes a little, so a full rack is never a still picture of crates.
  const bands = [];
  stage.live.traverse((o) => {
    const m = o.material;
    if (o.isMesh && m?.emissive && /_green$/.test(m.name || '') && !bands.some((b) => b.m === m)) bands.push({ m, base: m.emissiveIntensity });
  });

  // ---------- a tired work light in the hangar: mostly steady, buzzing, with a stutter now and then. It really lights the crates ----------
  const lampPos = bayAt.clone().add(new THREE.Vector3(0.5, 1.15, 0.9));
  const workLight = new THREE.PointLight(new THREE.Color(1, 0.86, 0.66), 5, 7, 2);
  workLight.position.copy(lampPos);
  stage.live.add(workLight);
  const lampCore = depthTested(stage.glow(lampPos, '#ffdcae', 0.5, 0.9));
  const lampWash = depthTested(stage.glow(lampPos, '#ff9d58', 4.4, 0.1));
  // The big crate at the back is in the plate, so the same light reaches it as a wash laid just in front of it.
  const crateWash = depthTested(stage.glow(atPx(255, 738, 33.5), '#ffc48a', 3.4, 0));
  // A yard hand's inspection lamp working along the rack, slowly, row by row. It really lights the crates, which are live.
  const rackLamp = new THREE.PointLight(new THREE.Color(0.85, 0.92, 1), 3.2, 5, 2);
  stage.live.add(rackLamp);
  const rackBase = stage.vec(rackSpots[5].p).addScaledVector(rackFront, 1.5);
  let lampClock = 0;
  const updateLamp = (dt) => {
    lampClock += dt;
    const c = lampClock % 6.7;
    const stutter = c < 0.55 ? (Math.sin(c * 70) > 0.1 ? 0.3 : 1) : 1;
    // A slow sag under the fast buzz, so it is never quite the same brightness twice.
    const f = stutter * (0.74 + 0.26 * Math.sin(lampClock * 1.3) * Math.sin(lampClock * 0.47 + 1)) * (0.94 + 0.06 * Math.sin(lampClock * 53) * Math.sin(lampClock * 17));
    workLight.intensity = 5 * f;
    lampCore.set(0.9 * f);
    lampWash.set(0.06 * f);
    crateWash.set(0.16 * f);
    rackLamp.position.copy(rackBase);
    rackLamp.position.x += 3.1 * Math.sin(lampClock * 0.23);
    rackLamp.position.y += 1.2 * Math.sin(lampClock * 0.61 + 0.8);
    for (const b of bands) b.m.emissiveIntensity = b.base * (1 + 0.32 * Math.sin(lampClock * 1.7));
  };

  // ---------- far traffic ----------
  const SHIP_SCALE = 0.34;
  const traffic = [
    { pts: [[1.2, 0.6, 185], [0.45, 0.8, 205], [-0.3, 0.86, 225], [-1.2, 0.68, 245]], dur: 96, u: 0.34, yaw: 0, side: 1, phase: 0 },
    { pts: [[-0.06, -0.08, 250], [0.42, -0.06, 228], [0.86, 0.06, 205], [1.3, 0.22, 182]], dur: 64, u: 0.16, yaw: Math.PI, side: -1, phase: 2.1 },
  ].map((c) => {
    const curve = new THREE.CatmullRomCurve3(c.pts.map(([x, y, d]) => atNdc(x, y, d)), false, 'centripetal');
    const node = stage.copy('ship');
    node.scale.setScalar(SHIP_SCALE);
    node.rotation.set(0, c.yaw, 0);
    const burn = depthTested(stage.glow(H, '#a8c8ff', 2.4, 0.8));
    burn.mat.color.multiplyScalar(3.5);
    const nav = depthTested(stage.glow(H, '#ffe2c2', 0.7, 0));
    return { ...c, curve, node, burn, nav, rest: 0, clock: 0 };
  });
  const updateTraffic = (dt) => {
    for (const c of traffic) {
      c.clock += dt;
      if (c.rest > 0) {
        c.rest -= dt;
        if (c.rest <= 0) c.u = 0;
        continue;
      }
      c.u += dt / c.dur;
      if (c.u >= 1) {
        c.rest = 6 + stage.rand() * 10;
        c.u = 1;
      }
      c.curve.getPoint(c.u, c.node.position);
      c.burn.sprite.position.copy(c.node.position);
      c.burn.sprite.position.x += c.side * 2.2 * SHIP_SCALE;
      c.burn.set(0.62 + 0.14 * Math.sin(c.clock * 23 + c.phase) * Math.sin(c.clock * 7.3));
      c.nav.sprite.position.copy(c.node.position);
      c.nav.sprite.position.y += 0.7 * SHIP_SCALE;
      const blink = (c.clock * 0.7 + c.phase) % 1;
      c.nav.set(blink < 0.08 ? 0.9 : 0);
    }
  };

  // ---------- a welder on the rack's top rail: short runs of hard blue light with a few sparks off it ----------
  const weldAt = atPx(386, 178, 56);
  const weld = depthTested(stage.glow(weldAt, '#b6d4ff', 1.5, 0));
  let weldClock = 0;
  let sparkWait = 0;
  const updateWeld = (dt) => {
    weldClock += dt;
    const c = weldClock % 8.5;
    const on = c < 2.6 && (c < 0.9 || c > 1.2);
    if (!on) { weld.set(0); return; }
    const arc = 0.5 + 0.5 * Math.sin(weldClock * 61) * Math.sin(weldClock * 37 + 1.3);
    weld.set(0.28 + 0.72 * arc * arc);
    sparkWait -= dt;
    if (sparkWait <= 0) {
      stage.sparks(weldAt, '#ffd9a8', 2, { speed: 0.8, spread: 1.1, up: 0.25, life: 0.8, gravity: 0.35 });
      sparkWait = 0.1;
    }
  };

  // ---------- the plate's own light ----------
  stage.life({
    // Sun travelling along the hull as the station turns. This direction leaves the whole planet limb in one phase, so the
    // limb never breaks into stripes. Only bright surfaces catch it.
    sweep: { amount: 0.2, width: 4.2, speed: 1.15, period: 22, dir: [0.37, 0.0, 0.93] },
  });

  return (dt) => {
    uT.value += dt;
    ringMat.uniforms.uAngle.value += dt * 0.12;
    updateCollar(dt);
    updateJets(dt);
    updatePuffs(dt);
    updateTraffic(dt);
    updateWeld(dt);
    updateLamp(dt);
  };
}

export async function createIsland(ctx) {
  const { config, mascots, scene } = ctx;
  const stage = await createStage(ctx, { lift: true, flow: 0.7, pulse: 1.25, water: 0, envIntensity: 1.05, sparkSize: 0.1, daylightAmount: 0.02 });
  const { info } = stage;
  const { spots } = info;
  const vec = (a) => new THREE.Vector3().fromArray(a);
  const [cArr, cGate, cRack] = config.bots;
  const cLead = config.lead;

  const led = { arrivals: ledHex(cArr.color), gate: ledHex(cGate.color), rack: ledHex(cRack.color) };
  stage.bindGroup('arrivals', led.arrivals);
  stage.bindGroup('gate', led.gate);
  stage.bindGroup('rack', led.rack);

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
  const marshal = await makeBot(cArr, 'arrivals', { rhythm: 0.9, lean: 0.11 });
  const scanner = await makeBot(cGate, 'gate', { rhythm: 0.7, lean: 0.08 });
  const stacker = await makeBot(cRack, 'rack', { rhythm: 0.48, lean: 0.11 });
  const leadBot = await makeBot(cLead, 'lead', { rhythm: 0.3, lean: 0.07 });
  const bots = { arrivals: marshal, gate: scanner, rack: stacker, lead: leadBot };
  scene.environment = glossyWorld(ctx.renderer);
  // Cycles balanced the blue planet fill with warm bounce off the station. Live faces get no bounce, so the fill is cut back.
  scene.traverse((o) => { if (o.isDirectionalLight && o.color.b > o.color.r) o.intensity *= 0.35; });
  const state = { arrivals: 'idle', gate: 'idle', rack: 'idle', lead: 'idle' };
  const busy = (k) => state[k] === 'working';
  const lineBusy = () => busy('arrivals') || busy('gate') || busy('rack') || busy('lead');

  const posOf = (k) => vec(info.bots[k].p);
  const ap = posOf('arrivals');
  const gp = posOf('gate');
  const rp = posOf('rack');
  const lp = posOf('lead');
  const up = (k, y) => posOf(k).add(new THREE.Vector3(0, y, 0));

  // ---------- paths and places ----------
  const aPts = stage.path('spine_a');
  const gatePts = stage.path('gate_in');
  const bPts = stage.path('spine_b');
  const railPts = stage.path('rail');
  const tugPts = stage.path('tug');
  // A tug waiting its turn hangs high enough that its crate clears the one already in the cage.
  tugPts[tugPts.length - 2].y += 1.1;
  // Yard tugs cross high and in front of the lift, with their crate well clear of the stacker.
  tugPts[1].y = 7.3;
  tugPts[1].z = -22.4;
  const footPos = vec(spots.lift_foot[0].p);
  // Raised off the render's spot, so what the stacker holds never touches the bot.
  const headPos = vec(spots.lift_head[0].p).add(new THREE.Vector3(0, 0.45, 0));
  const mouthPos = vec(spots.bay_mouth[0].p);
  const tugHome = vec(spots.tug_home[0].p);
  const cradlePos = vec(spots.cradle[0].p);
  const rackFront = vec(spots.rack_front[0].p).normalize();
  const worldY = new THREE.Vector3(0, 1, 0);

  const kindOf = (k) => (k === 'crate3' ? 'o' : 'g');
  const plain = (k) => `crate_${k}`;
  const cleared = (k) => `crate_${k}_ok`;

  // Cycles lights a crate's steel frame from the sun and the lit station round it. Live it has only the sky to reflect,
  // so the same frame goes black beside the rendered crates in the rack. It looks at more of that sky instead.
  const liftedFrames = new Set();
  for (const name of [plain('o'), plain('g'), cleared('o'), cleared('g')]) {
    const probe = stage.copy(name);
    probe.traverse((o) => {
      if (!o.isMesh || liftedFrames.has(o.material)) return;
      const m = o.material;
      if (m.name !== 'flat_rail' && m.name !== 'flat_hull2') return;
      liftedFrames.add(m);
      if (m.name === 'flat_rail') m.color.setRGB(0.15, 0.155, 0.165);
      m.envMap = scene.environment;
      m.envMapIntensity = 2.4;
    });
    probe.removeFromParent();
  }

  // ---------- the rack: two kinds of crate on one list of slots, filled in order ----------
  const rackSpots = spots.rack;
  const rackParts = {
    o: stage.pile('rack_o', cleared('o'), rackSpots.filter((s) => kindOf(s.kind) === 'o'), 0),
    g: stage.pile('rack_g', cleared('g'), rackSpots.filter((s) => kindOf(s.kind) === 'g'), 0),
  };
  let rackCount = 0;
  // Over the far end of the rack, clear of where the tugs come and go.
  const rackTagAt = vec(rackSpots[rackSpots.length - 1].p).add(new THREE.Vector3(0, 1.15, 0));
  rackTagAt.x = Math.min(...rackSpots.map((s) => s.p[0]));
  const setRack = (n, animate = true) => {
    rackCount = Math.max(0, Math.min(rackSpots.length, n));
    const first = rackSpots.slice(0, rackCount);
    for (const k of ['o', 'g']) rackParts[k].set(first.filter((s) => kindOf(s.kind) === k).length, animate);
    stage.tag('rack', rackTagAt, `${rackCount} crates`);
  };
  setRack(9, false);
  const nextRackKind = (offset = 0) => kindOf(rackSpots[(rackCount + offset) % rackSpots.length].kind);

  // ---------- the bay: a small stock in the half dark of the shed. Its copies get their own darker materials ----------
  const dim = (node, k) => node.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.material.color.multiplyScalar(k);
    o.material.envMap = scene.environment;
    o.material.envMapIntensity = k;
    o.material.emissive.set(led.arrivals);
    o.material.emissiveIntensity = o.material.metalness > 0.5 ? 0.03 : 0.1;
  });
  // The spots the render kept for the stock are behind the shed's own shell from this camera, so the stock stands
  // on the open floor between the door line and the apron, at the heights the render gave it.
  const bayAlong = aPts[1].clone().sub(aPts[0]).setY(0).normalize();
  const bayOut = new THREE.Vector3(-bayAlong.z, 0, bayAlong.x);
  const stockAt = [[0.35, 1.3], [1.3, 1.3], [0.82, 1.3]];
  const bayStack = spots.bay_stack.map((s, i) => {
    const p = aPts[0].clone().addScaledVector(bayAlong, stockAt[i][0]).addScaledVector(bayOut, stockAt[i][1]);
    p.y = s.p[1];
    const n = stage.copy(plain(kindOf(s.kind)), { ...s, p: p.toArray() });
    dim(n, 0.5);
    return n;
  });
  let bayCount = 2;
  let feeds = 0;
  const setBay = (n) => {
    bayCount = Math.max(0, Math.min(bayStack.length, n));
    bayStack.forEach((node, i) => { node.visible = i < bayCount; });
  };
  setBay(2);

  // ---------- ships ----------
  const coneGeo = (() => {
    const g = new THREE.ConeGeometry(1, 1, 18, 10, true);
    g.translate(0, 0.5, 0);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i += 1) {
      const y = pos.getY(i);
      col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;
      col[i * 4 + 3] = (1 - y) ** 2.2;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    return g;
  })();
  const burnMat = new THREE.MeshBasicMaterial({ color: THRUST.clone().multiplyScalar(3.4), vertexColors: true, transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const burnHalo = new THREE.MeshBasicMaterial({ color: THRUST.clone().multiplyScalar(1.1), vertexColors: true, transparent: true, opacity: 0.22, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const tail = vec(spots.ship_tail[0].p).normalize();
  const coneTurn = new THREE.Quaternion().setFromUnitVectors(worldY, tail);
  const makeShip = () => {
    const node = stage.copy('ship');
    const cargo = spots.ship_cargo.map((s) => stage.copy(plain(kindOf(s.kind)), s, node));
    const burns = [];
    for (const s of spots.ship_nozzle) {
      for (const [mat, w] of [[burnMat, 1], [burnHalo, 1.8]]) {
        const cone = new THREE.Mesh(coneGeo, mat);
        cone.position.fromArray(s.p);
        cone.quaternion.copy(coneTurn);
        cone.userData.w = w * s.s;
        node.add(cone);
        burns.push(cone);
      }
    }
    return { node, cargo, burns, phase: 'away', u: 0, dur: 1, curve: null, throttle: 0, yaw: 0, yawFrom: 0, yawTo: 0, unload: 0, unloadT: 0 };
  };
  // Further from the lens along the same line of sight: same spot on screen, smaller, so it does not outweigh the bots.
  const shipHold = vec(spots.ship_hold[0].p).sub(ctx.camera.position).multiplyScalar(1.3).add(ctx.camera.position);
  const shipLand = vec(spots.ship_land[0].p);
  const shipFlare = vec(spots.ship_flare[0].p);
  const landYaw = spots.ship_land[0].yaw;
  // In from low on the right over the limb, tiny at first, growing all the way to where the render has it.
  const curveIn = new THREE.CatmullRomCurve3([new THREE.Vector3(39, -36, -94), new THREE.Vector3(21, -11, -30), new THREE.Vector3(11.8, 0.4, 6), shipHold], false, 'centripetal');
  const curveLand = new THREE.CatmullRomCurve3([shipHold, shipFlare, shipLand], false, 'centripetal');
  // Out towards the lens and away to the right, below the spine, so a leaving ship never crosses the line.
  const curveLeave = new THREE.CatmullRomCurve3([shipLand, new THREE.Vector3(4.5, 1.2, 3.5), new THREE.Vector3(10, 0.4, 3.5), new THREE.Vector3(20, 0, 3.5), new THREE.Vector3(38, -1, 3)], false, 'centripetal');
  const leaveYaw = -3.05;
  const ships = [makeShip(), makeShip()];
  const unloadRunners = spots.ship_cargo.map((s) => stage.runner(plain(kindOf(s.kind)), [mouthPos, mouthPos.clone().add(worldY)], { speed: 1, scale: s.s }));
  // Live objects get no shadow, so whatever is under the shed roof is a separate copy in the shed's own dim light.
  const unloadInside = spots.ship_cargo.map((s) => {
    const r = stage.runner(plain(kindOf(s.kind)), [mouthPos, mouthPos.clone().add(worldY)], { speed: 1, scale: s.s });
    dim(r.node, 0.5);
    return r;
  });
  let apronFree = true;

  const setPhase = (ship, phase, dur = 1, curve = null) => {
    ship.phase = phase;
    ship.u = 0;
    ship.dur = dur;
    ship.curve = curve;
  };
  // The first ship starts where the render has it, holding off the apron. The second has just appeared far out.
  setPhase(ships[0], 'hold', 3.5);
  ships[0].node.position.copy(shipHold);
  ships[0].throttle = 0.5;
  setPhase(ships[1], 'approach', 30, curveIn);
  ships[1].u = 0.1;
  ships[1].throttle = 1;

  const updateShip = (ship, dt) => {
    const eager = busy('arrivals');
    ship.u = Math.min(1, ship.u + dt / ship.dur);
    let want = 0.2;
    switch (ship.phase) {
      case 'away':
        ship.node.visible = false;
        if (ship.u >= 1) {
          ship.node.visible = true;
          ship.cargo.forEach((c) => { c.visible = true; });
          ship.stalled = false;
          ship.yaw = 0;
          setPhase(ship, 'approach', eager ? 15 : 24, curveIn);
        }
        break;
      case 'approach': {
        // One ship at a time on the near side: the next one eases to a stop out in the distance until the apron and the
        // way out are clear, so nothing ever sits in a leaving ship's path.
        const other = ships[0] === ship ? ships[1] : ships[0];
        const blocked = other.phase === 'hold' || other.phase === 'land' || other.phase === 'down' || (other.phase === 'leave' && other.u < 0.97) || (other.phase === 'approach' && other.u > ship.u);
        if (blocked) ship.u -= (dt / ship.dur) * clamp01((ship.u - 0.24) / 0.12);
        ship.curve.getPoint(1 - (1 - ship.u) ** 1.8, ship.node.position);
        ship.node.scale.setScalar(Math.max(0.001, smooth(clamp01(ship.u / 0.05))));
        // Waiting its turn it coasts on a trickle of thrust. Full burn is only for when it is actually flying.
        const stop = blocked ? clamp01((ship.u - 0.24) / 0.12) : 0;
        ship.stalled = stop > 0.5;
        if (ship.stalled) ship.node.position.y += Math.sin(stage.clock * 0.7) * 0.05;
        want = (1 - ship.u * 0.45) * (1 - stop) + 0.07 * stop;
        if (ship.u >= 1) setPhase(ship, 'hold', eager ? 1.6 : 4);
        break;
      }
      case 'hold':
        ship.node.position.copy(shipHold);
        ship.node.position.y += Math.sin(stage.clock * 0.8) * 0.03;
        want = 0.12;
        if (ship.u >= 1 && apronFree) {
          apronFree = false;
          ship.yawFrom = ship.yaw;
          ship.yawTo = landYaw;
          setPhase(ship, 'land', eager ? 3.4 : 5, curveLand);
        }
        break;
      case 'land': {
        const k = smooth(ship.u);
        ship.curve.getPoint(k, ship.node.position);
        ship.yaw = ship.yawFrom + (ship.yawTo - ship.yawFrom) * k;
        // The tail swings towards the hangar on the way in, so the burn stays low and never washes over the crates.
        want = 0.22 - 0.2 * ship.u;
        if (ship.u >= 1) {
          marshal.press(0.7);
          stage.sparks(shipLand.clone().add(new THREE.Vector3(0, -0.7, 0)), '#cfe4ff', 6, { speed: 0.7, spread: 1.2, up: 0.2, life: 0.7 });
          setPhase(ship, 'down', 1.4);
          ship.unload = 0;
          ship.unloadT = 0.5;
        }
        break;
      }
      case 'down':
        ship.u = 0;
        want = 0;
        ship.unloadT -= dt;
        if (ship.unloadT <= 0) {
          if (ship.unload < ship.cargo.length) {
            const i = ship.unload;
            const c = ship.cargo[i];
            const from = c.getWorldPosition(new THREE.Vector3());
            c.visible = false;
            const r = unloadRunners[i];
            const slot = bayStack[Math.min(bayCount, bayStack.length - 1)].position.clone();
            r.node.rotation.copy(ship.node.rotation);
            r.go(2.6, () => {
              r.node.visible = false;
              const inside = unloadInside[i];
              inside.node.rotation.copy(r.node.rotation);
              inside.go(2.2, () => {
                inside.node.visible = false;
                setBay(bayCount + 1);
              }, [mouthPos, slot]);
            }, [from, from.clone().add(new THREE.Vector3(0, 0.5, 0)), mouthPos]);
            ship.unload += 1;
            ship.unloadT = eager ? 1.1 : 2;
          } else {
            ship.yawFrom = ship.yaw;
            ship.yawTo = leaveYaw;
            setPhase(ship, 'leave', eager ? 13 : 16, curveLeave);
          }
        }
        break;
      case 'leave':
        ship.curve.getPoint(ship.u ** 2.2, ship.node.position);
        // A long forward arc, nine seconds or more: a ship this size does not spin on the spot.
        ship.yaw = ship.yawFrom + (ship.yawTo - ship.yawFrom) * smooth(clamp01(ship.u / 0.72));
        want = 0.08 + 0.92 * smooth(clamp01((ship.u - 0.3) / 0.4));
        if (ship.u > 0.45) apronFree = true;
        if (ship.u >= 1) setPhase(ship, 'away', 2 + stage.rand() * 3);
        break;
      default:
    }
    ship.node.rotation.set(0, ship.yaw, 0);
    ship.throttle += (want - ship.throttle) * (1 - Math.exp(-dt * 2.2));
    const flick = 1 + 0.06 * Math.sin(stage.clock * 37 + ship.u * 11);
    for (const c of ship.burns) {
      c.visible = ship.throttle > 0.02 && ship.node.visible;
      c.scale.set(c.userData.w, ship.throttle * 2.9 * flick, c.userData.w);
    }
  };

  // ---------- the wands lift from where the render has them and come back ----------
  const wands = [['wand_l', -1], ['wand_r', 1]].map(([name, sign], i) => {
    const node = stage.actor(name);
    const axis = vec(spots[`${name}_axis`][0].p).sub(node.position).normalize();
    return { node, axis, sign, home: node.quaternion.clone(), phase: i * 1.4 };
  });
  let wandAmp = 0.15;
  const wandQ = new THREE.Quaternion();

  // ---------- crates on the spine ----------
  // A plain crate rolls from the bay to the gate, is read there, and a cleared one rolls on to the lift.
  // All crates of a leg share one speed, so the even spacing along the line holds when the pace changes.
  const aFull = [...aPts.slice(1), gatePts[1]];
  const pool = (pts, name, n) => ({
    o: Array.from({ length: n }, () => stage.runner(name('o'), pts, { speed: 1, scale: 0.98 })),
    g: Array.from({ length: n }, () => stage.runner(name('g'), pts, { speed: 1, scale: 0.98 })),
  });
  const aRun = pool(aFull, plain, 4);
  const bayRun = pool([aPts[0], aPts[1]], plain, 2);
  for (const r of [...bayRun.o, ...bayRun.g]) dim(r.node, 0.5);
  const bRun = pool(bPts, cleared, 7);
  const freeOf = (runs, k) => runs[k].find((r) => !r.active && !r.held);
  const aRunAll = [...aRun.o, ...aRun.g];
  const bRunAll = [...bRun.o, ...bRun.g];
  const lineRuns = [...aRunAll, ...bRunAll, ...bayRun.o, ...bayRun.g];
  // Crates out on the line right now: rolling, waiting at the gate, or waiting at the foot of the lift.
  const onLine = () => {
    let n = gateQueue.length + footQueue.length;
    for (const r of lineRuns) if (r.active) n += 1;
    return n;
  };
  const LEG_TIME = 2.2;
  let speedA = 1.25;
  let speedB = 1.5;
  let inFlightRack = 0;
  const gateQueue = [];
  const footQueue = [];
  let feedTimer = 2.4;

  const sendB = (kind, seedT = 0) => {
    const r = freeOf(bRun, kind);
    if (!r) return;
    inFlightRack += 1;
    r.go(speedB, () => {
      r.held = true;
      inFlightRack = Math.max(0, inFlightRack - 1);
      footQueue.push({ r, kind });
    });
    r.t = seedT;
  };
  const onSpine = (kind, seedT = 0) => {
    const r = freeOf(aRun, kind);
    if (!r) return;
    r.go(speedA, () => {
      r.held = true;
      gateQueue.push({ kind, r, t: 0 });
    });
    r.t = seedT;
  };
  const feed = () => {
    const kind = nextRackKind(inFlightRack + gateQueue.length);
    const r = freeOf(bayRun, kind);
    if (!r) return;
    r.go(speedA, () => {
      r.node.visible = false;
      onSpine(kind);
    });
    feeds += 1;
    if (feeds % 3 === 0 && bayCount > 0) setBay(bayCount - 1);
  };

  // ---------- the gate: a thin sheet of light that stays, a bright one that sweeps ----------
  const sheet = stage.path('gate_sheet');
  const sheetGeo = new THREE.BufferGeometry().setFromPoints([sheet[0], sheet[1], sheet[2], sheet[0], sheet[2], sheet[3]]);
  const gateColor = new THREE.Color(led.gate);
  const curtainMat = new THREE.MeshBasicMaterial({ color: gateColor.clone().multiplyScalar(1.1), transparent: true, opacity: 0.13, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beamMat = new THREE.MeshBasicMaterial({ color: gateColor.clone().multiplyScalar(1.5), transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const curtain = new THREE.Mesh(sheetGeo, curtainMat);
  const beam = new THREE.Mesh(sheetGeo, beamMat);
  curtain.frustumCulled = beam.frustumCulled = false;
  curtain.renderOrder = beam.renderOrder = 6;
  stage.live.add(curtain, beam);
  const gateAt = vec(spots.gate_glow[0].p);
  const along = vec(spots.gate_along[0].p).sub(gateAt).normalize();
  // The sheet stands just behind the crate, so it lights the inside of the gate and the crate keeps its own colour.
  curtain.position.copy(along).multiplyScalar(0.66);
  // What reads a crate is a thin lit frame that travels along it, the one the render has round its crate.
  const sideAxis = sheet[1].clone().sub(sheet[0]).normalize();
  const upAxis = sheet[3].clone().sub(sheet[0]).normalize();
  const scanFrame = new THREE.Group();
  scanFrame.matrixAutoUpdate = false;
  const frameMat = new THREE.MeshBasicMaterial({ color: gateColor.clone().multiplyScalar(5) });
  const FR = 0.56;
  for (const [x, y, w, h] of [[0, FR, 2 * FR + 0.05, 0.05], [0, -FR, 2 * FR + 0.05, 0.05], [FR, 0, 0.05, 2 * FR + 0.05], [-FR, 0, 0.05, 2 * FR + 0.05]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), frameMat);
    bar.position.set(x, y, 0);
    scanFrame.add(bar);
  }
  scanFrame.visible = false;
  stage.live.add(scanFrame);
  const frameBasis = new THREE.Matrix4().makeBasis(sideAxis, upAxis, along);
  const framePos = new THREE.Vector3();
  const gateGlow = stage.glow(gateAt.clone().addScaledVector(along, 1.5), led.gate, 4.6, 0.1);
  gateGlow.mat.depthTest = true;
  const tool = stage.actor('tool_gate');
  const dish = stage.actor('dish');
  const dishMachine = stage.machine(dish, vec(spots.dish_axis[0].p).sub(dish.position).normalize(), { idle: 0.4, working: 1.1, ease: 0.8 });
  let sweep = 0;
  let scanFlash = 0;

  // ---------- the lift ----------
  const headCrates = { o: stage.copy(cleared('o'), spots.lift_head[0]), g: stage.copy(cleared('g'), spots.lift_head[0]) };
  headCrates.o.position.copy(headPos);
  headCrates.g.position.copy(headPos);
  headCrates.g.visible = false;
  let headKind = 'o';
  const upRun = { o: stage.runner(cleared('o'), [footPos, headPos], { speed: 1 }), g: stage.runner(cleared('g'), [footPos, headPos], { speed: 1 }) };
  const toSlot = { o: stage.runner(cleared('o'), [headPos, footPos], { speed: 1, scale: 1.05 }), g: stage.runner(cleared('g'), [headPos, footPos], { speed: 1, scale: 1.05 }) };
  let liftBusy = true;
  let holdTimer = 1.6;      // the crate the render shows on the bot's head goes in first
  const slotFront = (slot) => vec(slot.p).addScaledVector(rackFront, 1.25);
  const stowHead = () => {
    const slot = rackSpots[Math.min(rackCount, rackSpots.length - 1)];
    const kind = kindOf(slot.kind);
    headCrates[headKind].visible = false;
    stacker.press(1);
    const r = toSlot[kind];
    r.node.rotation.y = slot.yaw;
    r.go(busy('rack') ? 6.4 : 5.2, () => {
      r.node.visible = false;
      setRack(rackCount + 1);
      liftBusy = false;
    }, [headPos, slotFront(slot).setY(headPos.y), slotFront(slot), vec(slot.p)]);
  };
  const riseToHead = (kind) => {
    liftBusy = true;
    const r = upRun[kind];
    r.go(4.6, () => {
      r.node.visible = false;
      headKind = kind;
      headCrates[kind].visible = true;
      stacker.press(0.6);
      holdTimer = busy('rack') ? 0.5 : 0.9;
    }, [footPos, footPos.clone().setY(headPos.y + 0.2), headPos]);
  };

  // ---------- the lift tug: a crate never floats, this one carries it up the lift and into its slot ----------
  const liftTug = stage.copy('tug');
  liftTug.scale.setScalar(1.7);
  liftTug.visible = true;
  liftTug.position.copy(footPos).add(new THREE.Vector3(0, 1.3, 0));
  const liftCarried = [upRun.o, upRun.g, toSlot.o, toSlot.g];
  const liftTugWant = new THREE.Vector3();
  const updateLiftTug = (dt) => {
    const moving = liftCarried.find((r) => r.node.visible);
    if (moving) liftTugWant.copy(moving.node.position).add(new THREE.Vector3(0, 0.78, 0));
    else if (headCrates[headKind].visible) liftTugWant.copy(headPos).add(new THREE.Vector3(0, 0.82, 0));
    else liftTugWant.copy(footPos).add(new THREE.Vector3(0, 1.3, 0));
    liftTug.position.lerp(liftTugWant, 1 - Math.exp(-dt * (moving ? 14 : 3)));
    liftTug.position.y += Math.sin(stage.clock * 1.3) * 0.0006;
  };

  // ---------- the yard tugs: two of them, taking the top of the rack to the cradle ----------
  const makeTug = (home, wait) => {
    const node = stage.copy('tug');
    const run = stage.runner('tug', tugPts, { speed: 1, node, bob: 0.015 });
    // Big enough to read as the thing carrying the crate, or the crate looks like it floats by itself.
    const TUG_SCALE = 1.7;
    node.scale.setScalar(TUG_SCALE);
    node.position.copy(home);
    node.visible = true;
    const crate = {
      o: stage.copy(cleared('o'), { p: [0, -0.78 / TUG_SCALE, 0], s: 1 / TUG_SCALE, yaw: 0 }, node),
      g: stage.copy(cleared('g'), { p: [0, -0.78 / TUG_SCALE, 0], s: 1 / TUG_SCALE, yaw: 0 }, node),
    };
    crate.o.visible = crate.g.visible = false;
    return { node, run, crate, home, state: 'home', kind: 'o', wait };
  };
  // One yard tug, parked clear of the lift tug's column. A single carrier keeps the rack calm: one crate in the air at a time.
  const tugs = [makeTug(tugHome.clone().add(new THREE.Vector3(-0.9, 0.6, 0)), 1.5)];
  const cradle = { o: stage.copy('pod_o', spots.cradle[0]), g: stage.copy('pod_g', spots.cradle[0]) };
  cradle.g.visible = false;
  let cradleKind = 'o';
  let dropBusy = false;
  let fireT = 1.2;
  const tugBack = (tug) => {
    tug.state = 'back';
    const rate = busy('rack') ? 4.2 : 3.6;
    tug.run.go(rate, () => {
      tug.node.visible = true;
      tug.state = 'home';
      tug.wait = busy('rack') ? 1.6 : 2.6;
    }, [tug.node.position.clone(), ...tugPts.slice(1, -1).reverse().map((q) => { const up2 = q.clone(); up2.y = Math.min(8, q.y + 1.2); return up2; }), tug.home]);
  };
  const tugCarry = (tug, seedT = 0) => {
    tug.state = 'carry';
    tug.rate = busy('rack') || rackCount >= 10 ? 3.2 : 2.6;
    tug.run.go(tug.rate, () => {
      tug.node.visible = true;
      tug.state = 'hover';
    }, [tug.node.position.clone(), tug.node.position.clone().add(new THREE.Vector3(0, 1.5, 0.7)), ...tugPts.slice(1, -1)]);
    tug.run.t = seedT;
  };
  const tugPick = (tug) => {
    const slot = rackSpots[rackCount - 1];
    tug.state = 'pick';
    tug.run.go(2.6, () => {
      tug.node.visible = true;
      tug.kind = kindOf(slot.kind);
      setRack(rackCount - 1, false);
      tug.crate[tug.kind].visible = true;
      tugCarry(tug);
    }, [tug.node.position.clone(), slotFront(slot).add(new THREE.Vector3(0, 0.78, 0))]);
  };
  const tugDrop = (tug) => {
    tug.state = 'drop';
    dropBusy = true;
    tug.run.go(1.3, () => {
      tug.node.visible = true;
      tug.crate[tug.kind].visible = false;
      cradleKind = tug.kind;
      cradle[tug.kind].visible = true;
      fireT = busy('lead') ? 0.6 : 0.9;
      dropBusy = false;
      stage.sparks(cradlePos, '#ffd9b0', 5, { speed: 0.6, spread: 1, up: 0.3, life: 0.6 });
      tugBack(tug);
    }, [tugPts[tugPts.length - 2], tugPts[tugPts.length - 1]]);
  };

  // ---------- the launch ----------
  const railLen = routeLength(railPts);
  const lever = stage.actor('lever');
  const leverAxis = vec(spots.lever_axis[0].p).sub(lever.position).normalize();
  const leverHome = lever.quaternion.clone();
  let leverKick = 0;
  const ringAt = vec(spots.ring[0].p);
  const ringAxis = vec(spots.ring_axis[0].p).sub(ringAt).normalize();
  const sweepNode = stage.actor('ring_sweep');
  const sweepMachine = stage.machine(sweepNode, ringAxis, { idle: 0.28, working: 1.5, ease: 0.8 });
  const ringFlash = stage.glow(ringAt.clone().addScaledVector(ringAxis, 2.5), AMBER, 7, 0.0);
  ringFlash.mat.depthTest = true;
  let ringFlashV = 0;

  // A thin lit frame standing in the ring on the rail: a crate flying through it has a band of light cross it.
  const ringScanAt = railPts.reduce((best, q) => (q.distanceTo(ringAt) < best.distanceTo(ringAt) ? q : best), railPts[0]).clone();
  const ringSide = new THREE.Vector3().crossVectors(ringAxis, worldY).normalize();
  const ringUp = new THREE.Vector3().crossVectors(ringSide, ringAxis).normalize();
  const ringScan = new THREE.Group();
  ringScan.matrixAutoUpdate = false;
  ringScan.matrix.makeBasis(ringSide, ringUp, ringAxis).setPosition(ringScanAt);
  const ringBarMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(AMBER).multiplyScalar(5) });
  for (const [x, y, w, h] of [[0, 0.72, 1.49, 0.045], [0, -0.72, 1.49, 0.045], [0.72, 0, 0.045, 1.49], [-0.72, 0, 0.045, 1.49]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.03), ringBarMat);
    bar.position.set(x, y, 0);
    ringScan.add(bar);
  }
  ringScan.visible = false;
  stage.live.add(ringScan);
  let ringScanOn = false;
  const behind = new THREE.Vector3();

  const makeShot = (protoName, emissive = false) => {
    const node = stage.copy(protoName);
    node.visible = false;
    const body = [];
    if (emissive) {
      node.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        body.push(o.material);
      });
    }
    const layers = [[0.05, 1.1, 1.0, 7], [0.2, 1.6, 0.55, 2.2], [0.62, 2.2, 0.26, 1]].map(([rad, edge, fade, boost]) => {
      const u = { uHead: { value: 0 }, uLen: { value: 0.55 }, uFade: { value: 0 }, uEdge: { value: edge }, uColor: { value: new THREE.Color(AMBER) } };
      const mat = new THREE.ShaderMaterial({ vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS, uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const m = new THREE.Mesh(tubeAlong(railPts, rad), mat);
      m.frustumCulled = false;
      m.renderOrder = 5;
      m.visible = false;
      stage.live.add(m);
      return { m, u, fade, boost };
    });
    const halo = stage.glow(railPts[0], AMBER, 3, 0);
    halo.mat.depthTest = true;
    return { node, body, layers, halo, s: 0, v: 0, on: false, fade: 0, power: 0, size: 1, tmp: new THREE.Vector3() };
  };
  const shots = { o: [makeShot('pod_o')], g: [makeShot('pod_g')], flare: makeShot('pod_o', true) };
  const allShots = [...shots.o, ...shots.g, shots.flare];
  // Only one crate is ever on the rail or in the ring.
  const isOn = (s) => s.on;
  const shotOut = () => allShots.some(isOn);

  const fire = (shot, color, { power = 0.5, size = 1.15, start = 0, speed = 3.6 } = {}) => {
    shot.on = true;
    shot.s = start;
    shot.v = speed;
    shot.fade = 1;
    shot.power = power;
    shot.size = size;
    shot.node.visible = true;
    shot.halo.mat.color.set(color);
    const c = new THREE.Color(color);
    for (const l of shot.layers) {
      l.m.visible = true;
      l.u.uColor.value.copy(c).multiplyScalar(l.boost * (0.7 + power));
    }
    for (const m of shot.body) {
      // A touch of the bot's colour on top of the crate's own material, which stays readable.
      m.emissive.copy(c);
      m.emissiveIntensity = 0.08 + 0.12 * power;
    }
  };
  const launch = (boost = 1) => {
    if (!cradle[cradleKind].visible || shotOut()) return false;
    const shot = shots[cradleKind].find((x) => !x.on);
    if (!shot) return false;
    cradle[cradleKind].visible = false;
    fire(shot, AMBER, { speed: 2.6 * boost, power: 0.8, size: 1.15 });
    leverKick = 1;
    leadBot.press(1);
    ringFlashV = Math.max(ringFlashV, 0.6);
    return true;
  };
  const updateShot = (shot, dt) => {
    if (!shot.on && shot.fade <= 0) return;
    if (shot.on) {
      shot.v += dt * 4.5;
      shot.s += dt * shot.v;
      const k = shot.s / railLen;
      pointAlongRoute(railPts, Math.min(k, 1), shot.tmp);
      shot.node.position.copy(shot.tmp);
      const out = smooth(clamp01((k - 0.9) / 0.1));
      shot.node.scale.setScalar(shot.size * (1 - out * 0.95));
      // The light is behind the crate, so the crate cuts it off and keeps its own material.
      shot.halo.sprite.position.copy(shot.tmp).add(behind.copy(shot.tmp).sub(ctx.camera.position).normalize().multiplyScalar(1.4 * shot.size));
      shot.halo.sprite.scale.setScalar(shot.size * (2.6 + 4 * shot.power));
      shot.halo.set((0.1 + 0.14 * shot.power) * (1 - out));
      if (shot.tmp.distanceTo(ringScanAt) < 0.95 * shot.size) ringScanOn = true;
      if (shot.tmp.distanceTo(ringAt) < 2.2) ringFlashV = Math.max(ringFlashV, 0.25 + shot.power * 0.5);
      // The trail stops at the crate's tail. Run through the crate it would wash it flat.
      for (const l of shot.layers) l.u.uHead.value = Math.max(0, Math.min(k, 1) - (0.85 * shot.size) / railLen);
      if (k >= 1) {
        shot.on = false;
        shot.node.visible = false;
        shot.halo.set(0);
      }
    } else {
      shot.fade = Math.max(0, shot.fade - dt * 0.9);
      if (shot.fade <= 0) for (const l of shot.layers) l.m.visible = false;
    }
    for (const l of shot.layers) l.u.uFade.value = shot.fade * l.fade;
  };

  // ---------- a finished result: a small lit crate flying the bot's leg, over the top of the rolling cargo ----------
  const express = Object.fromEntries(['arrivals', 'gate', 'rack'].map((k) => {
    // Nothing is cleared until it has been through the gate, so the marshal's result has no green band yet.
    const r = stage.runner(k === 'arrivals' ? plain('o') : cleared('o'), [aPts[0], aPts[1]], { speed: 1, scale: 0.72 });
    return [k, { r, glow: stage.glow(aPts[0], led[k], 2.6, 0) }];
  }));
  const expressAll = Object.values(express);
  const sendResult = (key, route) => {
    if (!route || route.length < 3) return;
    const pts = route.slice(0, -1).map((p) => p.clone().add(new THREE.Vector3(0, 0.95, 0)));
    const e = express[key];
    e.r.go(routeLength(pts) / LEG_TIME, () => { e.r.node.visible = false; }, pts);
  };

  // ---------- the line is already running on the first frame ----------
  onSpine(nextRackKind(inFlightRack), 0.55);
  sendB(nextRackKind(inFlightRack), 0.5);
  tugs[0].kind = kindOf(rackSpots[rackCount - 1].kind);
  setRack(rackCount - 1, false);
  tugs[0].crate[tugs[0].kind].visible = true;
  tugCarry(tugs[0], 0.45);

  // ---------- worlds ----------
  const worlds = new Map();
  const arrWorld = stage.worldRecord({
    anchorAt: up('arrivals', info.bots.arrivals.size * 1.25),
    center: ap.clone().add(new THREE.Vector3(1.5, 0.8, -3)),
    zoom: 1.9,
    route: [ap, ...aPts, gp, ...bPts.slice(1), rp, ...tugPts.slice(1), lp],
  });
  arrWorld.handoff = aPts.length + 1;
  worlds.set(cArr.id, arrWorld);
  const gateWorld = stage.worldRecord({
    anchorAt: up('gate', info.bots.gate.size * 1.3),
    center: gp.clone().add(new THREE.Vector3(-1.2, 1, 0)),
    zoom: 2,
    route: [gp, ...bPts.slice(1), rp, ...tugPts.slice(1), lp],
  });
  gateWorld.handoff = bPts.length;
  worlds.set(cGate.id, gateWorld);
  const rackWorld = stage.worldRecord({
    anchorAt: up('rack', info.bots.rack.size * 1.9),
    center: rp.clone().add(new THREE.Vector3(-2, 0.4, 0)),
    zoom: 2,
    route: [rp, ...tugPts, lp],
  });
  worlds.set(cRack.id, rackWorld);
  const main = stage.worldRecord({
    anchorAt: up('lead', info.bots.lead.size * 1.25),
    center: lp.clone().add(new THREE.Vector3(-2.2, 1.4, 0)),
    zoom: 1.9,
  });

  const keyOf = (world) => (world === arrWorld ? 'arrivals' : world === gateWorld ? 'gate' : world === rackWorld ? 'rack' : 'lead');
  const LEVELS = { idle: 0.42, working: 1, found: 1.5, done: 0.8, needs_approval: 0.55 };
  const level = (key, name) => { if (key !== 'lead') stage.setLevel(key, LEVELS[name] ?? 0.42); };
  for (const k of ['arrivals', 'gate', 'rack']) level(k, 'idle');

  function applyEvent(evt, world) {
    const key = keyOf(world);
    const bot = bots[key];
    if (evt.catchup) {
      if (!evt.pending) bot.clearApproval();
      state[key] = evt.pending ? 'needs_approval' : evt.activity;
      bot.setState(state[key]);
      level(key, state[key]);
      return;
    }
    bot.setState(evt.type, { value: evt.intensity });
    if (evt.type === 'found') {
      // The found moment: one glowing crate goes out on the rail in this bot's colour, bigger and brighter the better the find.
      level(key, 'found');
      const color = key === 'lead' ? cLead.color : led[key];
      const i = clamp01(evt.intensity ?? 0.5);
      if (!shotOut() && !cradle[cradleKind].visible) fire(shots.flare, color, { power: 0.35 + 0.65 * i, size: 1.05 + 0.55 * i, speed: 3 });
      ringFlashV = Math.max(ringFlashV, 0.4 + 0.5 * i);
      ringFlash.mat.color.set(color);
      stage.sparks(ringAt.clone().add(new THREE.Vector3(0, 0.4, 0)), color, 4 + Math.round(8 * i), { speed: 1.2, spread: 1.2, up: 0.4, life: 1.1 });
      if (evt.value) stage.chip(world.anchor.position.clone(), `+${evt.value}`, color);
      return;
    }
    if (evt.type === 'done') {
      level(key, 'done');
      state[key] = 'done';
      if (key === 'lead') {
        if (!launch(1.2) && !shotOut()) fire(shots.flare, AMBER, { power: 0.3, size: 1.1, speed: 3.6 });
        leverKick = 1;
      } else {
        sendResult(key, evt.route);
        if (key === 'gate') scanFlash = 1;
      }
      return;
    }
    state[key] = evt.type;
    level(key, evt.type);
  }

  const alive = livingPort(stage, ships, { rackCount: () => rackCount, bayAt: bayStack[0].position.clone() });

  // The hover pads ride slowly on their thrusters, each at its own rate. The plate's pad is lifted in the shader and everything
  // live standing on it comes along, so nothing slides.
  const pads = [
    { group: 0, at: ap, amp: 0.05, rate: 0.83, phase: 0, riders: [marshal.object, wands[0].node, wands[1].node] },
    { group: 1, at: gp, amp: 0.05, rate: 0.67, phase: 1.9, riders: [scanner.object, tool] },
    { group: 2, at: lp, amp: 0.065, rate: 0.54, phase: 3.7, riders: [leadBot.object, lever] },
  ];
  for (const p of pads) p.base = p.riders.map((n) => n.position.y);
  const bobPads = (t) => {
    for (const p of pads) {
      const dy = p.amp * (Math.sin(t * p.rate + p.phase) + 0.3 * Math.sin(t * p.rate * 2.3 + p.phase * 1.7));
      stage.setLift(p.group, dy, p.at);
      p.riders.forEach((n, i) => { n.position.y = p.base[i] + dy; });
    }
  };

  function update(dt, t) {
    alive(dt);
    bobPads(t);
    for (const b of Object.values(bots)) b.update(dt);
    tool.rotation.y = 0.07 * Math.sin(t * 1.3);

    // Ships.
    for (const s of ships) updateShip(s, dt);
    const landing = ships.some((s) => s.phase === 'land' || s.phase === 'hold');
    wandAmp += ((busy('arrivals') ? 0.5 : landing ? 0.32 : 0.14) - wandAmp) * (1 - Math.exp(-dt * 2));
    const wandRate = busy('arrivals') ? 3.4 : 1.7;
    for (const w of wands) {
      wandQ.setFromAxisAngle(w.axis, w.sign * wandAmp * (0.5 + 0.5 * Math.sin(t * wandRate + w.phase)));
      w.node.quaternion.copy(wandQ).multiply(w.home);
    }

    // The bay sends a crate down the spine every few seconds. Every crate on a leg rolls at that leg's pace.
    const hurry = lineBusy();
    const easeK = 1 - Math.exp(-dt * 1.5);
    speedA += ((hurry ? 1.25 : 1.0) - speedA) * easeK;
    speedB += ((hurry ? 1.45 : 1.15) - speedB) * easeK;
    for (const r of aRunAll) if (r.active) r.speedMul = speedA;
    for (const r of bRunAll) if (r.active) r.speedMul = speedB;
    // A fresh crate leaves the bay on a steady beat, and only while fewer than two are out on the line.
    feedTimer -= dt;
    if (feedTimer <= 0 && onLine() < 2) {
      feed();
      feedTimer = hurry ? 5.5 : 7;
    }

    // The gate reads each crate as it reaches the sheet, and lets it on with its band lit.
    const reading = gateQueue.length > 0;
    if (reading) {
      const g = gateQueue[0];
      g.t += dt;
      if (g.t > (busy('gate') ? 0.8 : 1.2)) {
        g.r.held = false;
        g.r.node.visible = false;
        gateQueue.shift();
        sendB(g.kind);
        scanner.press(0.5);
        scanFlash = 1;
      }
    }
    sweep += dt * (reading ? 6.5 : 0.9);
    beam.visible = !reading;
    beam.position.copy(along).multiplyScalar(0.5 * Math.sin(sweep));
    scanFrame.visible = reading;
    if (reading) {
      framePos.copy(gatePts[1]).addScaledVector(along, 0.5 * Math.sin(sweep));
      scanFrame.matrix.copy(frameBasis).setPosition(framePos);
      scanFrame.matrixWorldNeedsUpdate = true;
    }
    scanFlash = Math.max(0, scanFlash - dt * 1.6);
    // Only a trace of a sheet: a crate behind it keeps its material. What reads the crate is the thin frame.
    curtainMat.opacity = 0.05 + scanFlash * 0.04;
    beamMat.opacity = 0.03;
    gateGlow.set((reading ? 0.05 : 0.035) + scanFlash * 0.06);
    stage.setMachines([dishMachine], busy('gate'));

    // The stacker takes each crate off the foot of the lift, holds it a moment, and sets it in the next slot.
    // The lift tug and the yard tug take turns, so only one carrier moves over the rack at a time.
    const yardStill = tugs[0].state === 'home';
    if (headCrates[headKind].visible) {
      holdTimer -= dt;
      if (holdTimer <= 0) stowHead();
    }
    if (footQueue.length && !liftBusy && yardStill) {
      const f = footQueue.shift();
      f.r.held = false;
      f.r.node.visible = false;
      riseToHead(f.kind);
    } else if (footQueue.length > 1) {
      const f = footQueue.shift();
      f.r.held = false;
      f.r.node.visible = false;
      setRack(rackCount + 1);
    }

    updateLiftTug(dt);

    // The one yard tug leaves for the rack only while the lift tug is still, so a single carrier is ever moving over the rack,
    // and it waits over the cradle until the last crate has gone out through the ring.
    const tug = tugs[0];
    if (tug.state === 'home') {
      tug.wait -= dt;
      tug.node.position.copy(tug.home);
      tug.node.position.y += Math.sin(t * 0.7) * 0.02;
      const liftMoving = upRun.o.active || upRun.g.active || toSlot.o.active || toSlot.g.active;
      // It only sets off once the cradle is empty and the rail is clear, so it never hangs in the ring with a crate.
      if (tug.wait <= 0 && !liftMoving && !liftBusy && !headCrates[headKind].visible && !cradle[cradleKind].visible && !shotOut() && rackCount > 2) tugPick(tug);
    } else if (tug.state === 'hover') {
      if (!cradle[cradleKind].visible && !dropBusy) tugDrop(tug);
    }

    // What lands in the cradle goes out on the rail soon after.
    if (cradle[cradleKind].visible) {
      fireT -= dt;
      if (fireT <= 0 && !launch()) fireT = 0.3;
    }
    leverKick = Math.max(0, leverKick - dt * 1.1);
    // The lever lifts from where the render has it and settles back.
    lever.quaternion.setFromAxisAngle(leverAxis, 0.34 * smooth(leverKick)).multiply(leverHome);
    stage.setMachines([sweepMachine], hurry);

    for (const shot of allShots) updateShot(shot, dt);
    ringFlashV = Math.max(0, ringFlashV - dt * 0.8);
    ringFlash.set(ringFlashV * 0.2);
    ringScan.visible = ringScanOn;
    ringScanOn = false;
    if (ringFlashV <= 0) ringFlash.mat.color.set(AMBER);

    // A finished result travels the bot's leg as a soft light only: no loose crate floating over the line.
    for (const e of expressAll) {
      e.r.node.visible = false;
      if (e.r.active) e.glow.sprite.position.copy(e.r.node.position);
      e.glow.mat.depthTest = true;
      e.glow.set(e.r.active ? 0.22 : 0);
    }
  }

  // Bot coloured lights on the live parts, the same ones the plate's accent pass recolours. Copies share these materials.
  const groupColour = [[/_orange$/, led.arrivals], [/_green$/, led.gate], [/_pink$/, led.rack]];
  const seen = new Set();
  stage.live.traverse((o) => {
    if (!o.isMesh || !o.material?.name || seen.has(o.material)) return;
    seen.add(o.material);
    for (const [re, hex] of groupColour) if (re.test(o.material.name)) o.material.emissive?.set(hex);
  });

  return stage.island({
    worlds, main, applyEvent, update,
    dispose() { for (const b of Object.values(bots)) b.dispose(); },
  });
}
