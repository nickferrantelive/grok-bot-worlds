// What keeps a place alive when nobody is working: weather, steam, birds, lights. All of it runs in the shader from one
// clock, so it costs no per-frame script, repeats the same way every run and is depth tested against the plate.
//
// stage.particles({ ... })     snow, dust, embers, spray, mist, steam. See the options below.
// stage.flock({ ... })         a few birds on a long slow loop.
// stage.blink(pos, color, o)   a navigation light.
// stage.chase(points, color, o) lights running along a path.

import * as THREE from 'three';

const PARTICLE_VS = /* glsl */ `
attribute vec4 aSeed;
attribute vec2 corner;
uniform float uTime, uLife, uWobble, uSizeA, uSizeB, uFadeIn, uFadeOut, uSpin, uFlicker, uStretch;
uniform vec3 uCenter, uBox, uVel, uAccel;
varying vec2 vC;
varying float vFade;
varying float vSeed;
void main() {
  vec3 p;
  float size, fade;
  float w = aSeed.w * 6.2831;
  vec3 vel = uVel;
  if (uLife > 0.0) {
    // Born at the source, carried away, grows and thins.
    float a = fract(uTime / uLife + aSeed.w);
    float t = a * uLife;
    p = uCenter + (aSeed.xyz - 0.5) * uBox * (0.25 + a * 1.6) + uVel * t * (0.75 + aSeed.x * 0.5) + uAccel * t * t * 0.5;
    p.x += uWobble * sin(t * 1.3 + w) * a;
    p.z += uWobble * cos(t * 1.1 + w * 1.7) * a;
    size = mix(uSizeA, uSizeB, a) * (0.75 + aSeed.y * 0.5);
    fade = smoothstep(0.0, uFadeIn, a) * (1.0 - smoothstep(uFadeOut, 1.0, a));
    vel = uVel + uAccel * t;
  } else {
    // Fills a box and wraps around it. Thins out near the walls, so nothing pops when it wraps.
    vec3 q = aSeed.xyz * uBox + uVel * uTime;
    q.x += uWobble * sin(uTime * 0.7 + w);
    q.z += uWobble * cos(uTime * 0.53 + w * 1.3);
    q.y += uWobble * 0.4 * sin(uTime * 0.41 + w * 0.7);
    q = mod(q, uBox);
    vec3 e = min(q, uBox - q) / max(uBox, vec3(0.001));
    fade = smoothstep(0.0, 0.08, e.x) * smoothstep(0.0, 0.08, e.y) * smoothstep(0.0, 0.08, e.z);
    p = uCenter + q - 0.5 * uBox;
    size = mix(uSizeA, uSizeB, aSeed.y);
  }
  if (uFlicker > 0.0) fade *= 1.0 - uFlicker * (0.5 + 0.5 * sin(uTime * (1.5 + 3.0 * aSeed.z) + w));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 c = corner;
  if (uStretch > 0.0) {
    // Long along the way it is travelling, as a shutter would see it.
    vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
    vec2 d = normalize(vv.xy + vec2(0.00001, 0.0));
    vec2 side = vec2(-d.y, d.x);
    mv.xy += (d * c.y * (1.0 + uStretch) + side * c.x) * size;
  } else {
    float a = uSpin * uTime * (aSeed.z - 0.5) + w;
    mv.xy += vec2(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a)) * size;
  }
  gl_Position = projectionMatrix * mv;
  vC = corner * 2.0;
  vFade = fade;
  vSeed = aSeed.w * 37.0;
}`;

const PARTICLE_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity, uBreak, uHard, uAdd;
varying vec2 vC;
varying float vFade;
varying float vSeed;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float r = dot(vC, vC);
  if (r > 1.0) discard;
  float a = pow(1.0 - r, uHard);
  if (uBreak > 0.0) {
    vec2 q = vC * 2.2 + vSeed;
    float n = 0.6 * vn(q) + 0.3 * vn(q * 2.1) + 0.1 * vn(q * 4.3);
    a *= mix(1.0, smoothstep(0.25, 0.75, n + (1.0 - r) * 0.28), uBreak);
  }
  a *= uOpacity * vFade;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor * a, uAdd > 0.5 ? a * 0.35 : a);
}`;

const BIRD_VS = /* glsl */ `
attribute float aWing;
attribute vec4 aOff;
uniform float uTime, uSpeed, uFlap;
uniform vec3 uCenter, uRadius;
uniform float uSize, uSpread;
void main() {
  float a = uTime * uSpeed + aOff.w * uSpread;
  vec3 c = uCenter + vec3(cos(a) * uRadius.x, sin(a * 2.3) * uRadius.y, sin(a) * uRadius.z) + aOff.xyz * uSize * 14.0;
  vec3 forward = normalize(vec3(-sin(a) * uRadius.x, 0.001, cos(a) * uRadius.z) * sign(uSpeed));
  vec3 side = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  // Wing beats in short runs, then a glide, as big birds fly.
  float run = smoothstep(-0.2, 0.25, sin(uTime * 0.6 + aOff.w * 11.0));
  float beat = sin(uTime * uFlap + aOff.w * 17.0) * run + 0.12 * (1.0 - run);
  float reach = position.x;
  vec3 p = c + side * reach * uSize + forward * position.z * uSize + vec3(0.0, 1.0, 0.0) * abs(reach) * beat * uSize * 0.55;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const BIRD_FS = /* glsl */ `
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
void main() { gl_FragColor = vec4(uColor * uOpacity, uOpacity); }`;

const arr = (v) => (v?.isVector3 ? [v.x, v.y, v.z] : v);
const vec3 = (v) => new THREE.Vector3().fromArray(arr(v));

function linear(color) {
  if (Array.isArray(color)) return new THREE.Vector3().fromArray(color);
  const c = new THREE.Color();
  c.setStyle(color, THREE.SRGBColorSpace);
  return new THREE.Vector3(c.r, c.g, c.b);
}

const premultiplied = {
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  toneMapped: false,
  // A streak can face either way once it is stretched along its travel.
  side: THREE.DoubleSide,
};

export function createAmbient({ live, phone, rng, onUpdate, glow, renderOrder = 18 }) {
  const clockU = { value: 0 };
  const owned = [];
  onUpdate((dt) => { clockU.value += dt; });

  /**
   * count     how many. Halved on a phone.
   * center    middle of the box, or the source.
   * box       [x, y, z] world size of the box the particles fill, or the spread at the source.
   * velocity  [x, y, z] world units a second.
   * accel     [x, y, z] only with life: wind that picks up, gravity on spray.
   * life      seconds. Leave out for particles that fill the box forever, like snow.
   * size      [smallest, largest] half width in world units. With life: from birth to death.
   * wobble    sideways wander in world units.
   * color     css or linear [r, g, b]. Scene light, so before the look.
   * opacity, additive (for light), breakup (0 to 1, cloudy edges), hard (edge falloff power),
   * stretch   long along the direction of travel, for spray and streaks.
   * flicker, spin, fadeIn, fadeOut, order.
   */
  function particles({
    count = 200, center = [0, 0, 0], box = [10, 10, 10], velocity = [0, -1, 0], accel = [0, 0, 0], life = 0, size = [0.03, 0.06],
    wobble = 0, color = '#ffffff', opacity = 1, additive = false, breakup = 0, hard = 1.5, stretch = 0, flicker = 0, spin = 0,
    fadeIn = 0.12, fadeOut = 0.5, order = renderOrder,
  } = {}) {
    const n = Math.max(1, Math.round(phone ? count * 0.5 : count));
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i += 1) seeds[i] = rng();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = n;
    const uniforms = {
      uTime: clockU, uLife: { value: life }, uWobble: { value: wobble }, uSizeA: { value: size[0] * 2 }, uSizeB: { value: size[1] * 2 },
      uFadeIn: { value: fadeIn }, uFadeOut: { value: fadeOut }, uSpin: { value: spin }, uFlicker: { value: flicker }, uStretch: { value: stretch },
      uCenter: { value: vec3(center) }, uBox: { value: vec3(box) }, uVel: { value: vec3(velocity) }, uAccel: { value: vec3(accel) },
      uColor: { value: linear(color) }, uOpacity: { value: opacity }, uBreak: { value: breakup }, uHard: { value: hard }, uAdd: { value: additive ? 1 : 0 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, uniforms, ...premultiplied,
      ...(additive ? { blendDst: THREE.OneFactor, blendDstAlpha: THREE.OneFactor } : {}),
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    live.add(mesh);
    owned.push(geo, mat);
    return { mesh, uniforms, setOpacity(v) { uniforms.uOpacity.value = v; mesh.visible = v > 0.002; } };
  }

  /**
   * center, radius [x, y, z]  the loop they fly. y is how far it rises and falls.
   * count, size (world half wingspan), speed (radians a second, negative goes the other way), flap, color (dark for a silhouette), opacity.
   */
  function flock({ center = [0, 0, 0], radius = [20, 1, 20], count = 7, size = 0.2, speed = 0.05, flap = 6.5, color = '#14161c', opacity = 0.9, spread = 0.03, order = renderOrder } = {}) {
    const geo = new THREE.InstancedBufferGeometry();
    // A body and two swept wings, seen far away: enough to read as a bird.
    const tris = [
      [0, 0, 0.32], [1, 0, -0.18], [0, 0, -0.12],
      [0, 0, 0.32], [0, 0, -0.12], [-1, 0, -0.18],
    ];
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.flat()), 3));
    const off = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      off[i * 4] = (rng() - 0.5);
      off[i * 4 + 1] = (rng() - 0.5) * 0.35;
      off[i * 4 + 2] = (rng() - 0.5);
      off[i * 4 + 3] = i;
    }
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    geo.instanceCount = count;
    const uniforms = {
      uTime: clockU, uSpeed: { value: speed }, uFlap: { value: flap }, uCenter: { value: vec3(center) }, uRadius: { value: vec3(radius) },
      uSize: { value: size }, uSpread: { value: spread }, uColor: { value: linear(color) }, uOpacity: { value: opacity },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: BIRD_VS, fragmentShader: BIRD_FS, uniforms, side: THREE.DoubleSide, ...premultiplied });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    live.add(mesh);
    owned.push(geo, mat);
    return { mesh, uniforms };
  }

  /** A navigation light: mostly off, a short clean flash. period seconds, phase 0 to 1, on is the share of the period it is lit. */
  function blink(position, color = '#ff3b30', { period = 2.4, phase = 0, on = 0.12, size = 0.5, opacity = 0.95, dim = 0 } = {}) {
    const g = glow(vec3(position), color, size, opacity);
    let t = phase * period;
    onUpdate((dt) => {
      t = (t + dt) % period;
      const k = t / period;
      const lit = k < on ? 1 - k / on : 0;
      g.set(Math.max(dim, lit * lit) * opacity);
    });
    return g;
  }

  /** Lights running along a path, like signal lights on a rail. points in world space. */
  function chase(points, color = '#ffb36b', { count = 4, speed = 4, size = 0.22, opacity = 0.9, loop = false } = {}) {
    const pts = points.map(vec3);
    if (loop) pts.push(pts[0].clone());
    const lengths = [0];
    for (let i = 1; i < pts.length; i += 1) lengths.push(lengths[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = lengths[lengths.length - 1] || 1;
    const lights = Array.from({ length: count }, () => glow(pts[0], color, size, opacity));
    let s = 0;
    onUpdate((dt) => {
      s = (s + dt * speed) % total;
      lights.forEach((g, n) => {
        const at = (s + (total * n) / count) % total;
        let i = 1;
        while (i < lengths.length - 1 && lengths[i] < at) i += 1;
        const k = (at - lengths[i - 1]) / Math.max(1e-5, lengths[i] - lengths[i - 1]);
        g.sprite.position.lerpVectors(pts[i - 1], pts[i], k);
        // Each light fades in and out at the ends of a line that does not loop.
        const edge = loop ? 1 : Math.min(1, Math.min(at, total - at) / (total * 0.04));
        g.set(opacity * edge);
      });
    });
    return lights;
  }

  return { particles, flock, blink, chase, dispose() { for (const o of owned) o.dispose(); } };
}
