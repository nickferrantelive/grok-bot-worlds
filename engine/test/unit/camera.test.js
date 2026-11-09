import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clampPosition, poseToSpherical } from '../../camera.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

test('clamp keeps the camera above ground and clearance', () => {
  const p = clampPosition(v(1, -5, 1), { groundY: 0, clearance: 0.4 });
  assert.ok(Math.abs(p.y - 0.4) < 1e-9);
  const q = clampPosition(v(2, 0, 0), { groundHeight: (x) => x * 3, clearance: 0.5 });
  assert.ok(Math.abs(q.y - 6.5) < 1e-9);
});

test('clamp pushes the camera out of colliders, even from the exact centre', () => {
  const limits = { groundY: 0, colliders: [{ center: v(0, 3, 0), radius: 2 }] };
  const p = clampPosition(v(0.5, 3, 0), limits);
  assert.ok(p.distanceTo(limits.colliders[0].center) >= 2 - 1e-6);
  const q = clampPosition(v(0, 3, 0), limits);
  assert.ok(q.distanceTo(limits.colliders[0].center) >= 2 - 1e-6);
});

test('clamp respects ground and collider together when they fight', () => {
  const limits = { groundY: 0, clearance: 0.4, colliders: [{ center: v(0, 0, 0), radius: 3 }] };
  const p = clampPosition(v(0, -2, 0.1), limits);
  assert.ok(p.y >= 0.4 - 1e-6);
  assert.ok(p.distanceTo(limits.colliders[0].center) >= 3 - 1e-5);
});

test('a thousand random poses never break the limits', () => {
  const limits = {
    groundHeight: (x, z) => Math.sin(x * 0.3) + Math.cos(z * 0.2),
    clearance: 0.4,
    colliders: [{ center: v(3, 2, 3), radius: 2 }, { center: v(-4, 1, 2), radius: 3 }],
  };
  let seed = 1;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 1000; i += 1) {
    const p = clampPosition(v(rnd() * 20 - 10, rnd() * 10 - 5, rnd() * 20 - 10), limits);
    assert.ok(p.y >= limits.groundHeight(p.x, p.z) + limits.clearance - 1e-6, `ground at ${i}`);
    for (const c of limits.colliders) assert.ok(p.distanceTo(c.center) >= c.radius - 1e-5, `collider at ${i}`);
  }
});

test('poseToSpherical round trip', () => {
  const s = poseToSpherical(v(3, 4, 5), v(1, 1, 1));
  const r = Math.exp(s.logR);
  const x = 1 + r * Math.sin(s.phi) * Math.sin(s.theta);
  const y = 1 + r * Math.cos(s.phi);
  const z = 1 + r * Math.sin(s.phi) * Math.cos(s.theta);
  assert.ok(Math.abs(x - 3) < 1e-9 && Math.abs(y - 4) < 1e-9 && Math.abs(z - 5) < 1e-9);
});
