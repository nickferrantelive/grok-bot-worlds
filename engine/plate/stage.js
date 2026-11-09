// The stage every island stands on. The world is the Cycles frame: a plate on a mesh shaped by its own depth map.
// Everything that moves is a live object rendered into its own layer, tested against the plate's depth per pixel,
// taken through the same AgX curve as the render, then laid over the plate. Cost is near zero and the look is the render.
//
// const stage = await createStage(ctx);
// stage.info.spots, stage.info.paths, stage.info.bots   world places written by blender/shared/plate_tools.py
// stage.actor('sails')                                  a live node, placed where Blender had it
// stage.copy('basket', spot)                            a new copy at a spot { p, s, yaw }
// stage.machine(node, axis, { idle, working })          a part that turns, ramps up and down with stage.setRate
// stage.pile('rack', 'jar', stage.info.spots.rack, 8)   output that grows
// stage.runner('carrier_jar', path, opts)               something travelling along a path
// stage.glow(pos, color, size)                          an additive glow
// stage.sparks(pos, color, count, opts)                 a little burst
// stage.bindGroup('press', '#ff4d8d')                   the plate's lights for a station take this colour
// stage.setLevel('press', 1)                            and this brightness, eased
// stage.tag(id, pos, text), stage.chip(pos, text, color) small live text, drawn by the engine UI
// stage.life({ wind, sky, cloud, run, shadow, fog, sea, glint, sweep, stars })  the plate itself comes alive, in the shader
// stage.setLift(group, dy, at)                          a whole body in plate_lift.webp rises and falls
// stage.particles(o), stage.flock(o), stage.blink(p, c, o), stage.chase(pts, c, o)  weather, steam, birds and lights: see ambient.js
// return stage.island({ worlds, main, applyEvent, update, dispose })   adds home, render, resize, setDaylight, cameraLimits

import * as THREE from 'three';
import { createAmbient } from './ambient.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { pointAlongRoute, routeLength } from '../route.js';

const TAU = Math.PI * 2;
const HERO_ASPECT = 16 / 9;
const WARM_LIGHT = '#ffb46e';
// An upright phone looks closer, so bots and bubbles stay readable and less of the screen is empty sky or cloud.
const PORTRAIT_ZOOM = 1.04;

const VS_PLATE = /* glsl */ `
varying vec2 vNdc;
void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// The eye moves a little, so every pixel looks up where it came from in the hero frame: a march through the depth map
// from near to far along the direction of the shift. Silhouettes stay sharp at any resolution, with no mesh to tear.
const WARP = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 uCrop;
uniform vec2 uShift;
uniform float uInvNear, uInvFar, uFocus, uSteps;
varying vec2 vNdc;
float invAt(vec2 uv) {
  vec4 d = texture(tDepth, vec2(uv.x, 1.0 - uv.y));
  return (d.r * 65280.0 + d.g * 255.0) / 65535.0;
}
vec2 uvAtLayer(vec2 base, float layer) {
  float p = uFocus * (layer * (uInvNear - uInvFar) + uInvFar) - 1.0;
  return clamp((base + uShift * p) * 0.5 + 0.5, 0.0, 1.0);
}
vec2 baseNdc() { return vNdc * uCrop.zw + uCrop.xy; }
vec2 warped(out float inv) {
  vec2 base = baseNdc();
  if (uSteps < 1.0) {
    vec2 flat_uv = clamp(base * 0.5 + 0.5, 0.0, 1.0);
    inv = invAt(flat_uv);
    return flat_uv;
  }
  float stepSize = 1.0 / uSteps;
  float layer = 1.0, prev = 1.0;
  vec2 uv = uvAtLayer(base, layer);
  float s = invAt(uv);
  for (float i = 0.0; i < uSteps && s < layer; i += 1.0) {
    prev = layer;
    layer = max(0.0, layer - stepSize);
    uv = uvAtLayer(base, layer);
    s = invAt(uv);
  }
  float lo = layer, hi = prev;
  for (int i = 0; i < 3; i++) {
    float mid = 0.5 * (lo + hi);
    if (invAt(uvAtLayer(base, mid)) >= mid) lo = mid; else hi = mid;
  }
  uv = uvAtLayer(base, lo);
  inv = invAt(uv);
  return uv;
}`;

const FS_DEPTH = /* glsl */ `
precision highp float;
${WARP}
uniform float uTanH, uTanV;
uniform vec3 uH, uR, uU, uF;
uniform mat4 uVP;
void main() {
  float inv;
  vec2 uv = warped(inv);
  float z = 1.0 / (inv * (uInvNear - uInvFar) + uInvFar);
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 P = uH + uF * z + uR * ndc.x * uTanH * z + uU * ndc.y * uTanV * z;
  vec4 c = uVP * vec4(P, 1.0);
  gl_FragDepth = clamp(c.z / c.w * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(0.0);
}`;

// The plate holds still in Cycles and comes alive here. Everything below is off until an island asks for it with stage.life().
const FS_COLOR = /* glsl */ `
precision highp float;
${WARP}
uniform sampler2D tPlate, tAccent, tMask, tMotion, tLift;
uniform vec3 uA, uB, uC, uLevel, uGrade, uH, uR, uU, uF, uLift, uFogColor, uSweepDir, uGlintColor;
uniform float uT, uFlowRate, uWater, uFlow, uPulse, uHasAccent, uHasMask, uHasMotion, uHasLift, uTanH, uTanV, uWindAmount, uStars, uGlint;
uniform vec4 uWind, uSky, uSkyKeep, uCloud, uRun, uShadow, uFog, uSea, uSweep;
uniform vec2 uFogVel;
float n2(vec2 p) { return sin(p.x) * sin(p.y); }
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < FBM; i++) { s += a * vn(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / (1.0 - a * 2.0);
}
vec3 worldAt(vec2 uv, float inv) {
  float z = 1.0 / (inv * (uInvNear - uInvFar) + uInvFar);
  vec2 ndc = uv * 2.0 - 1.0;
  return uH + uF * z + uR * ndc.x * uTanH * z + uU * ndc.y * uTanV * z;
}
// Two copies slide across each other and trade places as each one reaches the end of its run: a still reads as flowing forever.
vec3 flowing(vec2 uv, vec2 gx, vec2 gy, vec4 f, float warp) {
  float ph = uT / f.z;
  float p1 = fract(ph), p2 = fract(ph + 0.5);
  float a1 = 1.0 - abs(2.0 * p1 - 1.0);
  vec2 n = vec2(vn(uv * vec2(5.0, 9.0) + vec2(uT * 0.02, 3.1)), vn(uv * vec2(6.0, 10.0) + vec2(7.7, uT * 0.017))) - 0.5;
  vec3 c1 = textureGrad(tPlate, uv + (f.xy + n * warp) * (p1 - 0.5), gx, gy).rgb;
  vec3 c2 = textureGrad(tPlate, uv + (f.xy + n.yx * warp) * (p2 - 0.5), gx, gy).rgb;
  return c1 * a1 + c2 * (1.0 - a1);
}
// Open sky around here, in every direction: nothing solid gets dragged along with the clouds.
float openSky(vec2 uv) {
  vec2 d = vec2(0.0035, 0.006);
  float s = 0.0;
  s += step(invAt(uv + vec2(d.x, 0.0)), 0.0002);
  s += step(invAt(uv - vec2(d.x, 0.0)), 0.0002);
  s += step(invAt(uv + vec2(0.0, d.y)), 0.0002);
  s += step(invAt(uv - vec2(0.0, d.y)), 0.0002);
  return s * 0.25;
}
void main() {
  float inv;
  vec2 uv = warped(inv);
  // The warped uv jumps at silhouettes. Mip level comes from the smooth one, or edges would pick a blurry mip.
  vec2 smoothUv = baseNdc() * 0.5 + 0.5;
  vec2 gx = dFdx(smoothUv), gy = dFdy(smoothUv);
  vec3 m = uHasMask > 0.5 ? textureGrad(tMask, uv, gx, gy).rgb : vec3(0.0);
  bool sky = inv < 0.0002;
  vec3 P = worldAt(uv, inv);
  float glintNow = 0.0;

  if (uHasLift > 0.5) {
    // Whole bodies rise and fall. A soft field, so what is right behind them gives way instead of tearing.
    uv.y -= dot(textureLod(tLift, uv, 2.5).rgb, uLift);
  }
  float run = 0.0;
  if (uHasMotion > 0.5) {
    vec3 sharp = texture(tMotion, uv).rgb;
    run = sharp.b;
    if (uWindAmount > 0.0) {
      // A blurred field, so a plant's outline moves too and not only what is inside it.
      vec4 soft = textureLod(tMotion, uv, 2.2);
      float bend = max(sharp.r, soft.r * 1.35);
      if (bend > 0.004 && sharp.r < 0.01) {
        // Not a plant, only near one. It gives way if it is behind the plant, like sky or snow. If it stands in front, like a roof, it holds.
        vec2 d = vec2(0.0042, 0.0075);
        float nearest = max(max(invAt(uv + vec2(d.x, 0.0)), invAt(uv - vec2(d.x, 0.0))), max(invAt(uv + vec2(0.0, d.y)), invAt(uv - vec2(0.0, d.y))));
        if (inv >= nearest - 0.002) bend = 0.0;
      }
      if (bend > 0.004) {
        // Each plant's own beat where it can be read, so a stand of trees never leans as one block.
        float phase = mix(soft.g, sharp.g, sharp.r > 0.01 ? 0.7 : 0.0) * 6.2831;
        float gust = 0.5 + 0.5 * sin(P.x * uWind.w - uT * 0.62 * uWind.z + 1.7 * sin(P.z * uWind.w * 0.7 + uT * 0.11));
        gust = 0.3 + 0.7 * gust * gust;
        // Rates with no common period, so the eye never catches a loop: a slow lean, the main rock, a quick shiver.
        float rock = 0.5 * sin(uT * 0.61 * uWind.z + phase * 3.0) + 0.75 * sin(uT * 1.47 * uWind.z + phase) + 0.3 * sin(uT * 3.31 * uWind.z + phase * 2.0);
        float flutter = 0.3 * (vn(vec2(uv.x * 420.0, uv.y * 260.0) + vec2(uT * 2.3, -uT * 1.7) + phase) - 0.5) * sharp.r;
        // Square of the bend: the base holds and the tip travels, the way a real plant pivots.
        bend = min(1.0, bend);
        uv += uWind.xy * uWindAmount * bend * bend * (gust * rock + flutter) * 0.8;
      }
    }
  }
  if (m.r > 0.02) {
    if (uSea.x > 0.0) {
      // Real waves on the water's own plane, so they get finer towards the horizon the way water does.
      vec2 ndc = uv * 2.0 - 1.0;
      vec3 ray = uF + uR * ndc.x * uTanH + uU * ndc.y * uTanV;
      float tw = (uSea.y - uH.y) / min(ray.y, -0.0005);
      vec2 q = (uH + ray * tw).xz * uSea.z;
      float t = uT * uSea.w;
      vec2 wn = vec2(0.0);
      wn += vec2(0.8, 0.6) * cos(dot(q, vec2(0.8, 0.6)) + t);
      wn += vec2(-0.5, 0.86) * 0.7 * cos(dot(q, vec2(-0.5, 0.86)) * 1.7 + t * 1.3 + 1.1);
      wn += vec2(0.25, -0.97) * 0.5 * cos(dot(q, vec2(0.25, -0.97)) * 2.9 + t * 1.9 + 2.3);
      wn += vec2(-0.9, -0.4) * 0.35 * cos(dot(q, vec2(-0.9, -0.4)) * 4.7 + t * 2.6 + 0.6);
      wn += (vec2(vn(q * 1.3 + t * 0.2), vn(q * 1.3 - t * 0.17 + 9.0)) - 0.5) * 1.1;
      uv += m.r * uSea.x * wn * vec2(0.35, 1.0) * min(3.0, uFocus / tw);
      if (uGlint > 0.0) {
        float crest = wn.x * 0.6 + wn.y * 0.8;
        float sparkle = smoothstep(0.82, 1.0, vn(q * 7.0 + t * 0.9) * vn(q * 11.0 - t * 0.7) * 2.2 + crest * 0.12);
        glintNow = sparkle * m.r * uGlint * min(1.0, uFocus / tw * 1.4);
      }
    } else {
      uv += m.r * uWater * vec2(
        0.00012 * sin(uv.y * 340.0 + uT * 2.1) + 0.0001 * sin(uv.y * 130.0 - uT * 1.3 + uv.x * 60.0),
        0.0016 * sin(uv.x * 210.0 + uv.y * 420.0 + uT * 1.6));
    }
  }
  if (m.g > 0.02 && uCloud.w < 0.5) {
    vec2 q = uv * vec2(9.0, 16.0);
    float tf = uT * uFlowRate;
    vec2 warp = vec2(n2(q + vec2(tf * 0.05, 0.0)) + 0.5 * n2(q * 2.1 - vec2(0.0, tf * 0.07)),
                     n2(q.yx + vec2(0.0, tf * 0.04)) + 0.5 * n2(q.yx * 2.3 + vec2(tf * 0.06, 0.0)));
    uv += m.g * uFlow * 0.0035 * warp;
  }
  vec3 c = textureGrad(tPlate, uv, gx, gy).rgb;
  if (sky && uSky.w > 0.0) {
    float open = openSky(uv) * openSky(uv + uSky.xy * 0.5) * openSky(uv - uSky.xy * 0.5);
    // Fine structure the depth map is too coarse to see, like a scaffold against the sky, is kept out by hand.
    if (uSkyKeep.z > uSkyKeep.x) {
      vec2 k = min(uv - uSkyKeep.xy, uSkyKeep.zw - uv);
      open *= 1.0 - smoothstep(-0.02, 0.0, min(k.x, k.y));
    }
    if (open > 0.0) c = mix(c, flowing(uv, gx, gy, uSky, uSky.w), open);
  }
  if (m.g > 0.02 && uCloud.w > 0.0) {
    c = mix(c, flowing(uv, gx, gy, uCloud, uCloud.w), smoothstep(0.1, 0.9, m.g));
  }
  if (run > 0.02 && uRun.w > 0.0) {
    // Falling water: the streaks in the render stream, and fresh ones stream over them.
    vec3 f = flowing(uv, gx, gy, uRun, 0.002);
    float streak = vn(vec2(uv.x * 900.0, uv.y * 42.0 - uT * 7.0 / uRun.z));
    streak = streak * 0.6 + 0.4 * vn(vec2(uv.x * 2100.0, uv.y * 90.0 - uT * 11.0 / uRun.z));
    c = mix(c, f * (1.0 + uRun.w * (streak - 0.42)), smoothstep(0.02, 0.5, run));
  }
  if (m.b > 0.02) c *= 1.0 + m.b * uPulse * (0.09 * sin(uT * 1.5 + uv.x * 9.0) + 0.05 * sin(uT * 3.7 + uv.y * 7.0));
  if (uHasAccent > 0.5) {
    vec3 a = textureGrad(tAccent, uv, gx, gy).rgb;
    vec3 add = clamp(a.r * uA * uLevel.x + a.g * uB * uLevel.y + a.b * uC * uLevel.z, 0.0, 1.0);
    c = 1.0 - (1.0 - c) * (1.0 - add);
  }
  c += uGlintColor * glintNow;
  if (!sky) {
    if (uShadow.x > 0.0) {
      // Clouds passing over, on the ground and not on the screen.
      float s = smoothstep(0.42, 0.66, fbm(P.xz * uShadow.y + uShadow.zw * uT));
      c *= 1.0 - uShadow.x * s * (1.0 - 0.7 * m.b);
    }
    if (uSweep.x > 0.0) {
      // Light travelling along the structure as the sun or the station turns. Bright things catch it most.
      float along = dot(P, uSweepDir) + uT * uSweep.z;
      float band = exp(-pow((fract(along / uSweep.w) - 0.5) * uSweep.w / uSweep.y, 2.0));
      c *= 1.0 + uSweep.x * band * smoothstep(0.08, 0.7, dot(c, vec3(0.33)));
    }
    if (uFog.x > 0.0) {
      // Low mist that moves through the place, thick near its floor.
      float h = 1.0 - smoothstep(uFog.y, uFog.z, P.y);
      if (h > 0.001) {
        float f = fbm(P.xz * uFog.w + uFogVel * uT);
        c = mix(c, uFogColor, uFog.x * h * smoothstep(0.35, 0.8, f));
      }
    }
  } else if (uStars > 0.0) {
    // Only what is already a star twinkles. Dark space stays dark.
    float l = dot(c, vec3(0.33));
    if (l > 0.05) {
      vec2 cell = floor(uv * vec2(960.0, 540.0));
      float h = h21(cell);
      c *= 1.0 + uStars * smoothstep(0.05, 0.3, l) * sin(uT * (0.7 + h * 3.2) + h * 40.0);
    }
  }
  gl_FragColor = vec4(c * uGrade, 1.0);
}`;

const VS_FS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Live layer: blur matching the render's lens, then Blender's AgX Punchy, then over the plate.
const FS_COMPOSITE = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D tCol, tDep;
uniform sampler3D tLut;
uniform float uExposure, uCocK, uFocus, uNear, uFar, uMaxCoc, uUseBlur;
uniform vec2 uPx;
varying vec2 vUv;
float viewZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
float coc(vec2 uv) {
  float d = texture2D(tDep, uv).r;
  if (d >= 0.99999) return 0.0;
  float z = viewZ(d);
  return min(uMaxCoc, uCocK * abs(z - uFocus) / z);
}
vec3 agx(vec3 hdr) {
  hdr *= uExposure;
  vec3 lg = (log2(max(hdr, vec3(1e-6))) + 12.47393) / 16.5;
  return texture(tLut, clamp(lg, 0.0, 1.0) * (32.0 / 33.0) + 0.5 / 33.0).rgb;
}
const float GA = 2.39996;
void main() {
  vec4 col;
  float r = 0.0;
  if (uUseBlur > 0.5) {
    // Only live things blur. The plate's depth is in this buffer too, but its blur is already in its pixels.
    for (int i = 0; i < 10; i++) {
      float k = sqrt((float(i) + 0.5) / 10.0) * uMaxCoc;
      float a = float(i) * GA;
      vec2 tap = vUv + vec2(cos(a), sin(a)) * k * uPx;
      if (texture2D(tCol, tap).a > 0.02) r = max(r, coc(tap));
    }
    if (texture2D(tCol, vUv).a > 0.02) r = max(r, coc(vUv));
  }
  if (r < 0.6) {
    col = texture2D(tCol, vUv);
  } else {
    col = vec4(0.0);
    for (int i = 0; i < 18; i++) {
      float k = sqrt((float(i) + 0.5) / 18.0) * r;
      float a = float(i) * GA;
      col += texture2D(tCol, vUv + vec2(cos(a), sin(a)) * k * uPx);
    }
    col /= 18.0;
  }
  if (col.a < 0.002) discard;
  gl_FragColor = vec4(agx(col.rgb / col.a) * col.a, col.a);
}`;

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function seeded(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function displayColor(hex) {
  const c = new THREE.Color();
  c.setStyle(hex, THREE.SRGBColorSpace);
  const out = {};
  c.getRGB(out, THREE.SRGBColorSpace);
  return new THREE.Vector3(out.r, out.g, out.b);
}

const easeOutBack = (x) => { const c = 1.4; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

let glowTexture = null;
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.42)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

export async function createStage({ scene, camera, renderer, config, quality, assetsBase }, options = {}) {
  const phone = quality.name === 'phone';
  const base = assetsBase;
  const info = await (await fetch(`${base}plate.json`)).json();
  const rng = seeded(hashSeed(config.island || 'island'));

  // ---------- hero camera ----------
  const hero = info.camera;
  const H = new THREE.Vector3().fromArray(hero.pos);
  const Q = new THREE.Quaternion().fromArray(hero.quat);
  const R = new THREE.Vector3(1, 0, 0).applyQuaternion(Q);
  const U = new THREE.Vector3(0, 1, 0).applyQuaternion(Q);
  const F = new THREE.Vector3(0, 0, -1).applyQuaternion(Q);
  const tanH = Math.tan(THREE.MathUtils.degToRad(hero.hfov) / 2);
  const tanV = Math.tan(THREE.MathUtils.degToRad(hero.vfov) / 2);
  const focusD = hero.focus > 0 ? hero.focus : 20;
  const zNear = Math.max(0.1, (info.depth?.near ?? 1) * 0.4);
  const zFar = (info.depth?.far ?? 500) * 1.3;
  camera.near = zNear;
  camera.far = zFar;
  const capturing = new URLSearchParams(location.search).get('capture') === '1';
  const OVERSCAN = options.overscan ?? 1.035;
  const ZOOM_MAX = options.zoomMax ?? 2.6;
  const PARALLAX = options.parallax ?? 0.006;     // Camera travel as a share of the focus distance, at the end of a drag.
  const homeTarget = H.clone().addScaledVector(F, focusD);

  // ---------- plate ----------
  const texLoader = new THREE.TextureLoader();
  const loadTex = async (name, required = true) => {
    try {
      const t = await texLoader.loadAsync(base + name);
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    } catch (err) {
      if (required) throw new Error(`Could not load ${name}`);
      return null;
    }
  };
  const [tPlate, tAccent, tMask, depthBuf] = await Promise.all([
    loadTex('plate.webp'),
    loadTex('plate_accent.webp', false),
    loadTex('plate_mask.webp', false),
    fetch(`${base}depth.bin`).then((r) => r.arrayBuffer()),
  ]);
  // Named by the island, so one without them asks for nothing that is not there.
  const [tMotion, tLift] = await Promise.all([
    options.motion ? loadTex('plate_motion.webp', false) : null,
    options.lift ? loadTex('plate_lift.webp', false) : null,
  ]);
  const dw = info.depth.w;
  const dh = info.depth.h;
  const depth16 = new Uint16Array(depthBuf);
  const rgba = new Uint8Array(dw * dh * 4);
  for (let i = 0; i < depth16.length; i += 1) {
    rgba[i * 4] = depth16[i] >> 8;
    rgba[i * 4 + 1] = depth16[i] & 255;
  }
  const tDepth = new THREE.DataTexture(rgba, dw, dh, THREE.RGBAFormat, THREE.UnsignedByteType);
  tDepth.minFilter = tDepth.magFilter = THREE.NearestFilter;
  tDepth.needsUpdate = true;
  const invNear = 1 / info.depth.near;
  const invFar = 1 / info.depth.far;

  const groups = info.groups ?? [];
  const uLevel = new THREE.Vector3(0.2, 0.2, 0.2);
  const levelWanted = [0.2, 0.2, 0.2];
  const colorU = [
    { value: new THREE.Vector3(1, 1, 1) },
    { value: new THREE.Vector3(1, 1, 1) },
    { value: new THREE.Vector3(1, 1, 1) },
  ];
  const uGrade = { value: new THREE.Vector3(1, 1, 1) };
  const warpU = {
    tDepth: { value: tDepth }, uCrop: { value: new THREE.Vector4(0, 0, 1, 1) }, uShift: { value: new THREE.Vector2() },
    uInvNear: { value: invNear }, uInvFar: { value: invFar }, uFocus: { value: focusD }, uSteps: { value: 0 },
  };
  const colorUniforms = {
    ...warpU,
    tPlate: { value: tPlate }, tAccent: { value: tAccent }, tMask: { value: tMask },
    uA: colorU[0], uB: colorU[1], uC: colorU[2], uLevel: { value: uLevel }, uGrade,
    uT: { value: 0 }, uWater: { value: options.water ?? 1 }, uFlow: { value: options.flow ?? 1 }, uPulse: { value: options.pulse ?? 1 },
    uHasAccent: { value: tAccent ? 1 : 0 }, uHasMask: { value: tMask ? 1 : 0 },
    tMotion: { value: tMotion }, tLift: { value: tLift }, uHasMotion: { value: tMotion ? 1 : 0 }, uHasLift: { value: tLift ? 1 : 0 },
    uH: { value: H }, uR: { value: R }, uU: { value: U }, uF: { value: F }, uTanH: { value: tanH }, uTanV: { value: tanV },
    uLift: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector4(1, 0.12, 1, 0.25) }, uWindAmount: { value: 0 },
    uSky: { value: new THREE.Vector4(0.02, 0, 40, 0) }, uSkyKeep: { value: new THREE.Vector4(0, 0, 0, 0) }, uCloud: { value: new THREE.Vector4(0.01, 0, 30, 0) },
    uRun: { value: new THREE.Vector4(0, -0.02, 1.4, 0) },
    uShadow: { value: new THREE.Vector4(0, 0.05, 0.02, 0.01) },
    uFog: { value: new THREE.Vector4(0, 0, 1, 0.1) }, uFogColor: { value: new THREE.Vector3(1, 1, 1) }, uFogVel: { value: new THREE.Vector2(0.02, 0.01) },
    uSea: { value: new THREE.Vector4(0, 0, 1, 1) }, uGlint: { value: 0 }, uGlintColor: { value: new THREE.Vector3(1, 0.95, 0.85) },
    uSweep: { value: new THREE.Vector4(0, 2, 1, 30) }, uSweepDir: { value: new THREE.Vector3(1, 0, 0) },
    uStars: { value: 0 }, uFlowRate: { value: 1 },
  };
  const plateColorMat = new THREE.ShaderMaterial({ vertexShader: VS_PLATE, fragmentShader: FS_COLOR, uniforms: colorUniforms, defines: { FBM: phone ? 2 : 3 }, depthTest: false, depthWrite: false, toneMapped: false });
  const cssLinear = (hex, out) => {
    const k = new THREE.Color();
    k.setStyle(hex, THREE.SRGBColorSpace);
    return out.set(k.r, k.g, k.b);
  };
  // Asks the plate to come alive. Every part is optional and can be changed at any time. All amounts are small.
  function life(cfg = {}) {
    const u = colorUniforms;
    if (cfg.wind) {
      const w = cfg.wind;
      u.uWindAmount.value = w.amount ?? 0.0012;
      u.uWind.value.set(w.x ?? 1, w.y ?? 0.12, w.speed ?? 1, w.scale ?? 0.25);
    }
    if (cfg.sky) {
      u.uSky.value.set(cfg.sky.x ?? 0.02, cfg.sky.y ?? 0, cfg.sky.cycle ?? 40, cfg.sky.warp ?? 0.006);
      // [left, bottom, right, top] in 0 to 1 of the frame, kept out of the drift.
      if (cfg.sky.keep) u.uSkyKeep.value.fromArray(cfg.sky.keep);
    }
    if (cfg.cloud) u.uCloud.value.set(cfg.cloud.x ?? 0.01, cfg.cloud.y ?? 0, cfg.cloud.cycle ?? 30, cfg.cloud.warp ?? 0.008);
    if (cfg.run) u.uRun.value.set(cfg.run.x ?? 0, cfg.run.y ?? -0.02, cfg.run.cycle ?? 1.4, cfg.run.streak ?? 0.35);
    if (cfg.shadow) u.uShadow.value.set(cfg.shadow.amount ?? 0.15, 1 / (cfg.shadow.size ?? 20), cfg.shadow.vx ?? 0.02, cfg.shadow.vz ?? 0.01);
    if (cfg.fog) {
      const f = cfg.fog;
      u.uFog.value.set(f.amount ?? 0.3, f.bottom ?? 0, f.top ?? 1, 1 / (f.size ?? 8));
      u.uFogVel.value.set(f.vx ?? 0.02, f.vz ?? 0.01);
      if (f.color) cssLinear(f.color, u.uFogColor.value);
    }
    if (cfg.sea) u.uSea.value.set(cfg.sea.amount ?? 0.0014, cfg.sea.height ?? 0, 1 / (cfg.sea.wavelength ?? 1), cfg.sea.speed ?? 1);
    if (cfg.glint) {
      u.uGlint.value = cfg.glint.amount ?? 0.5;
      if (cfg.glint.color) cssLinear(cfg.glint.color, u.uGlintColor.value);
    }
    if (cfg.sweep) {
      const k = cfg.sweep;
      u.uSweep.value.set(k.amount ?? 0.1, k.width ?? 2, k.speed ?? 1, k.period ?? 30);
      if (k.dir) u.uSweepDir.value.fromArray(k.dir).normalize();
    }
    if (cfg.stars !== undefined) u.uStars.value = cfg.stars;
    // How fast the flow mask's slow large swell turns over. Above about 4 it stops reading as cloud growing.
    if (cfg.flowRate !== undefined) u.uFlowRate.value = cfg.flowRate;
    if (cfg.flow !== undefined) u.uFlow.value = cfg.flow;
  }
  // Lifts one of the three bodies in plate_lift.webp by a distance in world units. Live things standing on it are the island's to move.
  function setLift(group, dy, at) {
    const z = Math.max(0.1, tmpLift.copy(at.isVector3 ? at : tmpLift.fromArray(at)).sub(H).dot(F));
    colorUniforms.uLift.value.setComponent(group, dy / (2 * z * tanV));
  }
  const uVP = { value: new THREE.Matrix4() };
  const plateDepthMat = new THREE.ShaderMaterial({
    vertexShader: VS_PLATE,
    fragmentShader: FS_DEPTH,
    uniforms: {
      ...warpU, uTanH: { value: tanH }, uTanV: { value: tanV },
      uH: { value: H }, uR: { value: R }, uU: { value: U }, uF: { value: F }, uVP,
    },
    colorWrite: false,
    depthFunc: THREE.AlwaysDepth,
  });
  const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), plateColorMat);
  plateMesh.frustumCulled = false;
  const plateScene = new THREE.Scene();
  plateScene.add(plateMesh);

  // ---------- live light: what Cycles saw from the middle of the line, and the same suns ----------
  renderer.toneMapping = THREE.NoToneMapping;
  const envTex = await new EXRLoader().setDataType(THREE.HalfFloatType).loadAsync(`${base}env.exr`);
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  envTex.colorSpace = THREE.LinearSRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromEquirectangular(envTex);
  envTex.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = options.envIntensity ?? 1;
  const suns = [];
  for (const s of (info.suns ?? []).slice().sort((a, b) => b.energy - a.energy).slice(0, 3)) {
    const light = new THREE.DirectionalLight(new THREE.Color(s.color[0], s.color[1], s.color[2]), s.energy);
    light.position.fromArray(s.dir).multiplyScalar(100);
    scene.add(light);
    suns.push({ light, energy: s.energy });
  }

  // ---------- live layer and how it reaches the screen ----------
  const lutBuf = await (await fetch(new URL('plate/agx_lut.bin', document.baseURI).href)).arrayBuffer();
  const lut16 = new Uint16Array(lutBuf);
  const lutHalf = new Uint16Array(33 * 33 * 33 * 4);
  for (let i = 0; i < 33 * 33 * 33; i += 1) {
    lutHalf[i * 4] = THREE.DataUtils.toHalfFloat(lut16[i * 3] / 65535);
    lutHalf[i * 4 + 1] = THREE.DataUtils.toHalfFloat(lut16[i * 3 + 1] / 65535);
    lutHalf[i * 4 + 2] = THREE.DataUtils.toHalfFloat(lut16[i * 3 + 2] / 65535);
    lutHalf[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const lut = new THREE.Data3DTexture(lutHalf, 33, 33, 33);
  lut.format = THREE.RGBAFormat;
  lut.type = THREE.HalfFloatType;
  lut.magFilter = lut.minFilter = THREE.LinearFilter;
  lut.needsUpdate = true;

  const layerSize = new THREE.Vector2();
  renderer.getDrawingBufferSize(layerSize);
  const layerDepth = new THREE.DepthTexture(layerSize.x, layerSize.y, THREE.UnsignedIntType);
  const layer = new THREE.WebGLRenderTarget(layerSize.x, layerSize.y, {
    type: THREE.HalfFloatType,
    samples: phone ? 2 : 4,
    depthTexture: layerDepth,
    depthBuffer: true,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  const lensAperture = (hero.lens / 1000) / Math.max(hero.fstop, 0.01);
  const compositeU = {
    tCol: { value: layer.texture }, tDep: { value: layerDepth }, tLut: { value: lut },
    uExposure: { value: 2 ** (info.exposure ?? 0) },
    uCocK: { value: 0 }, uFocus: { value: focusD }, uNear: { value: zNear }, uFar: { value: zFar }, uMaxCoc: { value: 10 },
    uPx: { value: new THREE.Vector2(1 / layerSize.x, 1 / layerSize.y) },
    uUseBlur: { value: hero.dof && quality.post ? 1 : 0 },
  };
  const compositeMat = new THREE.ShaderMaterial({ vertexShader: VS_FS, fragmentShader: FS_COMPOSITE, uniforms: compositeU, depthTest: false, depthWrite: false, transparent: true, premultipliedAlpha: true, toneMapped: false });
  const fsMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMat);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---------- camera: the rig's pose becomes a crop of the plate and a small shift of the eye ----------
  const rigHome = { theta: 0, phi: 1 };
  {
    const d = H.clone().sub(homeTarget);
    rigHome.theta = Math.atan2(d.x, d.z);
    rigHome.phi = Math.acos(d.y / d.length());
  }
  const vp = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  let viewAspect = camera.aspect || HERO_ASPECT;
  // A phone has no pointer to follow, and no warp means clean edges and fewer texture reads.
  // ?still=1 locks the camera, so tools/motion_map.mjs measures the world moving and not the lens drifting.
  const swayAmount = phone || new URLSearchParams(location.search).get('still') === '1' ? 0 : options.sway ?? 0.0022;
  let clock = 0;
  // Where an upright phone is looking along the line, in the same units as cx.
  let followCx = 0;
  let followCy = 0;
  let followWorld = null;
  let followNext = null;
  let followAt = -100;
  function noteFollow(evt, world) {
    if (!world || evt.catchup || evt.update || evt.type === 'idle') return;
    if (evt.type === 'needs_approval') followAt = -100;
    followNext = world;
  }
  function updateFollow(dt) {
    if (viewAspect >= 1) return;
    // Long enough on each bot to read its bubble.
    if (followNext && clock - followAt > 5) {
      followWorld = followNext;
      followNext = null;
      followAt = clock;
    }
    const anchor = followWorld?.anchor;
    if (!anchor) return;
    if (anchor.isVector3) tmpV.copy(anchor);
    else anchor.getWorldPosition(tmpV);
    tmpV2.copy(tmpV).sub(H);
    const along = Math.max(0.001, tmpV2.dot(F));
    const ease = 1 - Math.exp(-dt * 1.3);
    followCx += (tmpV2.dot(R) / along / tanH - followCx) * ease;
    followCy += (tmpV2.dot(U) / along / tanV - followCy) * ease;
  }
  function applyCamera() {
    const rig = camera.userData.rig;
    const tx = rig ? rig.tx : homeTarget.x;
    const ty = rig ? rig.ty : homeTarget.y;
    const tz = rig ? rig.tz : homeTarget.z;
    tmpV.set(tx, ty, tz);
    tmpV2.copy(tmpV).sub(H);
    const along = Math.max(0.001, tmpV2.dot(F));
    let cx = tmpV2.dot(R) / along / tanH;
    let cy = tmpV2.dot(U) / along / tanV;
    const baseDist = tmpV2.length();
    // A recording gets a slow push in over its 20 seconds. A locked shot reads as a still with things moving on it.
    const push = capturing ? 1 + (options.filmPush ?? 0.05) * smooth(clock / 20) : 1;
    const zoom = (rig ? THREE.MathUtils.clamp(baseDist / Math.max(0.001, rig.r), 1, ZOOM_MAX) : 1) * push;
    const fitX = viewAspect >= HERO_ASPECT ? 1 / OVERSCAN : (viewAspect / HERO_ASPECT) / OVERSCAN;
    const fitY = viewAspect >= HERO_ASPECT ? (HERO_ASPECT / viewAspect) / OVERSCAN : 1 / OVERSCAN;
    const portrait = viewAspect < 1 ? PORTRAIT_ZOOM : 1;
    const hx = fitX / zoom / portrait;
    const hy = fitY / zoom / portrait;
    const limX = 1 - hx - (1 - 1 / OVERSCAN) * 0.5;
    const limY = 1 - hy - (1 - 1 / OVERSCAN) * 0.5;
    if (viewAspect < 1 && zoom < 1.02) {
      const moved = rig ? Math.hypot(tx - homeTarget.x, ty - homeTarget.y, tz - homeTarget.z) : 0;
      if (moved < 0.05) {
        cx = followCx;
        cy = followCy;
      }
    }
    cx = THREE.MathUtils.clamp(cx, -Math.max(0, limX), Math.max(0, limX));
    cy = THREE.MathUtils.clamp(cy, -Math.max(0, limY), Math.max(0, limY));
    let dTheta = 0;
    let dPhi = 0;
    if (rig) {
      tmpV2.copy(H).sub(tmpV);
      const th0 = Math.atan2(tmpV2.x, tmpV2.z);
      const ph0 = Math.acos(THREE.MathUtils.clamp(tmpV2.y / tmpV2.length(), -1, 1));
      dTheta = THREE.MathUtils.euclideanModulo(rig.theta - th0 + Math.PI, TAU) - Math.PI;
      dPhi = rig.phi - ph0;
    }
    // The same few pixels of depth on screen at any zoom.
    const parallaxNow = phone ? 0 : PARALLAX;
    const sx = (parallaxNow * Math.tanh(dTheta / 0.35) + swayAmount * Math.sin(clock * 0.21)) / zoom;
    const sy = (-parallaxNow * 0.6 * Math.tanh(dPhi / 0.25) + swayAmount * 0.6 * Math.sin(clock * 0.17 + 1.3)) / zoom;
    camera.position.copy(H).addScaledVector(R, sx * focusD).addScaledVector(U, sy * focusD);
    camera.quaternion.copy(Q);
    camera.updateMatrixWorld();
    const n = camera.near;
    const left = ((cx - hx) * tanH - sx) * n;
    const right = ((cx + hx) * tanH - sx) * n;
    const top = ((cy + hy) * tanV - sy) * n;
    const bottom = ((cy - hy) * tanV - sy) * n;
    camera.projectionMatrix.makePerspective(left, right, top, bottom, n, camera.far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uVP.value.copy(vp);
    warpU.uCrop.value.set(cx, cy, hx, hy);
    warpU.uShift.value.set(sx / tanH, sy / tanV);
    const span = focusD * (invNear - invFar);
    const reach = Math.max(Math.abs(sx / tanH) * layerSize.x * 0.5 / hx, Math.abs(sy / tanV) * layerSize.y * 0.5 / hy) * span;
    warpU.uSteps.value = reach < 0.25 ? 0 : Math.min(phone ? 10 : 20, Math.ceil(reach / 1.5) + 3);
    // A circle of confusion at this crop: pixels per metre of aperture blur on the sensor.
    compositeU.uCocK.value = 0.5 * lensAperture * (hero.lens / 1000) / Math.max(0.01, focusD - hero.lens / 1000)
      / (hero.sensor / 1000) * (layerSize.x / hx);
  }

  function render() {
    const gl = renderer;
    const prevAuto = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(layer);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, true, true);
    plateMesh.material = plateDepthMat;
    gl.render(plateScene, fsCam);
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    gl.clear(true, true, true);
    plateMesh.material = plateColorMat;
    gl.render(plateScene, fsCam);
    gl.render(fsScene, fsCam);
    gl.autoClear = prevAuto;
  }

  // ---------- actors ----------
  let gltf = null;
  try {
    gltf = await new GLTFLoader().loadAsync(`${base}actors.glb`);
  } catch (err) {
    console.warn('No live actors:', err.message);
  }
  const protos = new Map();
  if (gltf) {
    for (const child of [...gltf.scene.children]) {
      if (child.name.startsWith('ACT_')) protos.set(child.name.slice(4), child);
    }
    gltf.scene.updateMatrixWorld(true);
  }
  const live = new THREE.Group();
  scene.add(live);
  function actor(name) {
    const p = protos.get(name);
    if (!p) throw new Error(`plate: no actor called "${name}"`);
    if (!p.parent || p.parent === gltf.scene) live.add(p);
    return p;
  }
  function place(obj, spot) {
    obj.position.fromArray(spot.p);
    obj.scale.setScalar(spot.s ?? 1);
    obj.rotation.set(0, spot.yaw ?? 0, 0);
    return obj;
  }
  function copy(name, spot, parent = live) {
    const p = protos.get(name);
    if (!p) throw new Error(`plate: no actor called "${name}"`);
    const c = p.clone(true);
    if (spot) place(c, spot);
    parent.add(c);
    return c;
  }
  const worldUp = new THREE.Vector3(0, 1, 0);

  // ---------- small machines ----------
  const machines = [];
  function machine(node, axis, { idle = 0, working = 1, ease = 1.2 } = {}) {
    const m = { node, axis: axis.clone().normalize(), rate: idle, idle, working, want: idle, ease, angle: 0, base: node.quaternion.clone(), q: new THREE.Quaternion() };
    machines.push(m);
    return m;
  }
  function setMachines(list, busy) { for (const m of list) m.want = busy ? m.working : m.idle; }

  const updaters = [];
  const onUpdate = (fn) => updaters.push(fn);

  // Output that grows. Each new item arrives with a small settling pop.
  function pile(id, protoName, spots, initial = 0) {
    const items = spots.map((spot) => {
      const node = copy(protoName, spot);
      node.visible = false;
      return { node, born: -10, scale: spot.s ?? 1 };
    });
    let count = 0;
    const api = {
      id,
      get count() { return count; },
      get capacity() { return items.length; },
      set(n, animate = false) {
        const next = Math.max(0, Math.min(items.length, Math.round(n)));
        items.forEach((it, i) => {
          const on = i < next;
          if (on && !it.node.visible && animate) it.born = clock;
          if (on && !it.node.visible && !animate) it.born = -10;
          it.node.visible = on;
        });
        count = next;
        return api;
      },
      add(n = 1) { api.set(count + n >= items.length + 1 ? n : count + n, true); return api; },
      topOf(out = new THREE.Vector3()) { const it = items[Math.max(0, count - 1)]; return it ? it.node.getWorldPosition(out) : out; },
      nextSpot() { return spots[Math.min(count, spots.length - 1)]; },
    };
    onUpdate(() => {
      for (const it of items) {
        if (!it.node.visible) continue;
        const age = clock - it.born;
        it.node.scale.setScalar(it.scale * (age < 0.45 ? Math.max(0.01, easeOutBack(age / 0.45)) : 1));
      }
    });
    api.set(initial);
    return api;
  }

  // Something travelling along a path. Starts and ends softly, keeps its own speed however uneven the points are.
  function runner(protoName, path, { speed = 1, scale = 1, node = null, onArrive = null, face = false, bob = 0 } = {}) {
    const obj = node ?? copy(protoName);
    obj.scale.setScalar(scale);
    obj.visible = false;
    const pts = path.map((p) => (p.isVector3 ? p : new THREE.Vector3().fromArray(p)));
    const length = routeLength(pts);
    const r = { node: obj, pts, t: 0, active: false, run: null, length };
    const out = new THREE.Vector3();
    const ahead = new THREE.Vector3();
    r.go = (speedMul = 1, cb = null, points = null) => {
      r.active = true;
      r.t = 0;
      r.speedMul = speedMul;
      r.cb = cb ?? onArrive;
      r.use = points ?? pts;
      r.len = routeLength(r.use);
      obj.visible = true;
      return r;
    };
    r.stop = () => { r.active = false; obj.visible = false; };
    onUpdate((dt) => {
      if (!r.active) return;
      r.t = Math.min(1, r.t + dt * speed * r.speedMul / Math.max(0.01, r.len));
      const k = smooth(r.t) * 0.35 + r.t * 0.65;
      pointAlongRoute(r.use, k, out);
      obj.position.copy(out);
      if (bob) obj.position.y += Math.sin(clock * 2.4 + r.t * 9) * bob;
      if (face) {
        pointAlongRoute(r.use, Math.min(1, k + 0.02), ahead);
        const dx = ahead.x - out.x;
        const dz = ahead.z - out.z;
        if (Math.abs(dx) + Math.abs(dz) > 1e-4) obj.rotation.y += (THREE.MathUtils.euclideanModulo(Math.atan2(dx, dz) - obj.rotation.y + Math.PI, TAU) - Math.PI) * Math.min(1, dt * 4);
      }
      if (r.t >= 1) {
        r.active = false;
        const cb = r.cb;
        r.cb = null;
        if (cb) cb(r);
      }
    });
    return r;
  }

  function glow(position, color = '#ffffff', size = 1, opacity = 0.8) {
    const mat = new THREE.SpriteMaterial({ map: getGlowTexture(), color: new THREE.Color(color), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, opacity });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(position.isVector3 ? position : tmpV.fromArray(position));
    sprite.scale.setScalar(size);
    sprite.renderOrder = 20;
    live.add(sprite);
    return { sprite, mat, base: opacity, set(v) { mat.opacity = v; sprite.visible = v > 0.003; } };
  }

  // A pool of small sparks with real ballistics. Deterministic: seeded, driven only from dt.
  const sparkMax = phone ? 60 : 160;
  const sparkPos = new Float32Array(sparkMax * 3);
  const sparkCol = new Float32Array(sparkMax * 3);
  const sparkState = Array.from({ length: sparkMax }, () => ({ life: 0, max: 1, v: new THREE.Vector3(), c: new THREE.Color() }));
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
  const sparkMat = new THREE.PointsMaterial({ size: options.sparkSize ?? 0.09, map: getGlowTexture(), vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, sizeAttenuation: true });
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  sparkPoints.renderOrder = 19;
  live.add(sparkPoints);
  let sparkCursor = 0;
  function sparks(position, color = '#ffffff', count = 12, { speed = 1, spread = 1, up = 1, life = 1.1, gravity = 1.4 } = {}) {
    const c = new THREE.Color(color);
    const p = position.isVector3 ? position : tmpV.fromArray(position);
    const n = phone ? Math.ceil(count * 0.5) : count;
    for (let i = 0; i < n; i += 1) {
      const k = sparkCursor;
      sparkCursor = (sparkCursor + 1) % sparkMax;
      const s = sparkState[k];
      s.life = s.max = life * (0.6 + rng() * 0.6);
      s.gravity = gravity;
      s.c.copy(c);
      sparkPos[k * 3] = p.x; sparkPos[k * 3 + 1] = p.y; sparkPos[k * 3 + 2] = p.z;
      const a = rng() * TAU;
      const h = rng() * spread;
      s.v.set(Math.cos(a) * h * speed, (0.4 + rng()) * up * speed, Math.sin(a) * h * speed);
    }
  }
  onUpdate((dt) => {
    let any = false;
    for (let k = 0; k < sparkMax; k += 1) {
      const s = sparkState[k];
      if (s.life <= 0) { sparkCol[k * 3] = sparkCol[k * 3 + 1] = sparkCol[k * 3 + 2] = 0; continue; }
      any = true;
      s.life -= dt;
      s.v.y -= s.gravity * dt;
      sparkPos[k * 3] += s.v.x * dt; sparkPos[k * 3 + 1] += s.v.y * dt; sparkPos[k * 3 + 2] += s.v.z * dt;
      const f = Math.max(0, s.life / s.max);
      sparkCol[k * 3] = s.c.r * f; sparkCol[k * 3 + 1] = s.c.g * f; sparkCol[k * 3 + 2] = s.c.b * f;
    }
    sparkPoints.visible = any;
    sparkGeo.attributes.position.needsUpdate = true;
    sparkGeo.attributes.color.needsUpdate = true;
  });

  // ---------- small live text: drawn by the engine UI, asked for here ----------
  const tags = new Map();
  const chipQueue = [];
  function tag(id, position, text, opts = {}) {
    const t = tags.get(id) ?? { id, pos: new THREE.Vector3() };
    t.pos.copy(position.isVector3 ? position : tmpV.fromArray(position));
    if (t.text !== text) { t.text = text; t.changed = clock; }
    t.opts = opts;
    tags.set(id, t);
    return t;
  }
  function chip(position, text, color) {
    chipQueue.push({ pos: (position.isVector3 ? position : tmpV.fromArray(position)).clone(), text, color });
  }

  // ---------- the bot's own world record ----------
  function worldRecord({ anchorAt, center, zoom = 1.9, stageNode = null, route = null, handoff = null, pickRadius = null }) {
    const anchor = new THREE.Object3D();
    anchor.position.copy(anchorAt);
    live.add(anchor);
    const target = (center ?? anchorAt).clone();
    const dist = H.distanceTo(target);
    const dir = H.clone().sub(target).normalize();
    const rec = {
      anchor,
      stage: stageNode ?? anchor,
      focus: { target, position: target.clone().addScaledVector(dir, dist / zoom) },
    };
    if (route) rec.route = route;
    if (handoff !== null) rec.handoff = handoff;
    if (pickRadius) rec.pickRadius = pickRadius;
    return rec;
  }

  // ---------- day ----------
  function setDaylight(t) {
    // Each island keeps its own light. The clock only leans it a little warmer or cooler.
    const k = options.daylightAmount ?? 0.05;
    const s = Math.sin((t - 0.25) * TAU);
    uGrade.value.set(1 + k * 0.6 * s, 1 + k * 0.25 * s, 1 - k * 0.4 * s);
  }

  // ---------- public ----------
  const levelGain = [1, 1, 1];
  function bindGroup(name, hex) {
    const i = groups.indexOf(name);
    if (i < 0) return;
    const c = new THREE.Color(hex);
    const hsl = c.getHSL({ h: 0, s: 0, l: 0 });
    colorU[i].value.copy(displayColor(hsl.s < 0.15 ? WARM_LIGHT : hex));
    // A white lead's lights are already in the plate. The live pass only lifts them a little.
    levelGain[i] = hsl.s < 0.15 ? 0.22 : 1;
  }
  function setLevel(name, value) {
    const i = groups.indexOf(name);
    if (i >= 0) levelWanted[i] = value * levelGain[i];
  }

  function update(dt, t) {
    clock = t;
    colorUniforms.uT.value = t;
    const ease = 1 - Math.exp(-dt * 2.4);
    uLevel.x += (levelWanted[0] - uLevel.x) * ease;
    uLevel.y += (levelWanted[1] - uLevel.y) * ease;
    uLevel.z += (levelWanted[2] - uLevel.z) * ease;
    for (const m of machines) {
      m.rate += (m.want - m.rate) * (1 - Math.exp(-dt * m.ease));
      m.angle += m.rate * dt;
      m.q.setFromAxisAngle(m.axis, m.angle);
      m.node.quaternion.copy(m.q).multiply(m.base);
    }
    for (const fn of updaters) fn(dt, t);
    updateFollow(dt);
    applyCamera();
  }

  function home(aspect) {
    viewAspect = aspect || viewAspect;
    return { position: H.clone(), target: homeTarget.clone() };
  }

  function resize() {
    renderer.getDrawingBufferSize(layerSize);
    layer.setSize(layerSize.x, layerSize.y);
    compositeU.uPx.value.set(1 / layerSize.x, 1 / layerSize.y);
    viewAspect = camera.aspect;
  }

  const tmpLift = new THREE.Vector3();
  const ambient = createAmbient({ live, phone, rng, onUpdate, glow });
  const stage = {
    life, setLift, particles: ambient.particles, flock: ambient.flock, blink: ambient.blink, chase: ambient.chase,
    info,
    H,
    F,
    R,
    U,
    worldUp,
    actor,
    copy,
    place,
    hasActor: (n) => protos.has(n),
    machine,
    setMachines,
    pile,
    runner,
    glow,
    sparks,
    tag,
    chip,
    onUpdate,
    worldRecord,
    bindGroup,
    setLevel,
    rand: rng,
    live,
    get clock() { return clock; },
    vec: (a) => new THREE.Vector3().fromArray(a),
    path: (name) => info.paths[name].map((p) => new THREE.Vector3().fromArray(p)),
    island({ worlds, main, applyEvent, update: userUpdate, dispose: userDispose, ...rest }) {
      return {
        worlds,
        main,
        applyEvent(evt, world) {
          noteFollow(evt, world);
          return applyEvent(evt, world);
        },
        setDaylight,
        home,
        render,
        resize,
        drainChips: () => chipQueue.splice(0, chipQueue.length),
        tags,
        update(dt, tt) {
          update(dt, tt);
          userUpdate?.(dt, tt);
          camera.updateMatrixWorld();
        },
        cameraLimits: {
          groundY: -1e6, clearance: 0, colliders: [], maxPolar: Math.PI - 0.01, noPull: true, plate: true, plateTan: [tanH, tanV],
          minDistance: H.distanceTo(homeTarget) / ZOOM_MAX, maxDistance: H.distanceTo(homeTarget) * 1.02,
        },
        dispose() {
          userDispose?.();
          plateMesh.geometry.dispose();
          plateColorMat.dispose();
          plateDepthMat.dispose();
          compositeMat.dispose();
          layer.dispose();
          layerDepth.dispose();
          envRT.dispose();
          lut.dispose();
          tPlate.dispose();
          tAccent?.dispose();
          tMask?.dispose();
          tMotion?.dispose();
          tLift?.dispose();
          ambient.dispose();
          tDepth.dispose();
          for (const s of suns) scene.remove(s.light);
          scene.remove(live);
          scene.environment = null;
        },
        ...rest,
      };
    },
  };
  return stage;
}
