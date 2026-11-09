// Mascots for every island. Wraps assets/mascots/mascots.js when it is there. Until then, or if it fails,
// a plain fallback bot with the same calls stands in, so an island does not change when the real set lands.

import * as THREE from 'three';
import loadMascotModule from 'virtual:mascots-module';

const TWO_PI = Math.PI * 2;
const BODIES = [
  [[0, 0], [0.42, 0], [0.5, 0.18], [0.46, 0.5], [0.3, 0.78], [0, 0.88]],
  [[0, 0], [0.5, 0], [0.5, 0.42], [0.42, 0.72], [0, 0.82]],
  [[0, 0], [0.34, 0], [0.54, 0.26], [0.44, 0.62], [0.22, 0.88], [0, 0.94]],
];

function fallbackFactory() {
  const geometries = BODIES.map((pts) => {
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)));
    const lathe = curve.getPoints(28).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
    return new THREE.LatheGeometry(lathe, 36);
  });
  const eyeGeometry = new THREE.SphereGeometry(0.1, 16, 12);
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#15171c', roughness: 0.18 });

  return {
    kind: 'fallback',
    async create({ color = '#ffffff', index = 0, size = 1 } = {}) {
      const object = new THREE.Group();
      object.name = 'mascot-fallback';
      object.scale.setScalar(size);
      const material = new THREE.MeshPhysicalMaterial({ color, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12 });
      const body = new THREE.Mesh(geometries[Math.abs(index) % geometries.length], material);
      body.castShadow = true;
      const pivot = new THREE.Group();
      pivot.add(body);
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
        eye.scale.set(0.8, 1.3, 0.45);
        eye.position.set(side * 0.17, 0.5, 0.41);
        pivot.add(eye);
      }
      object.add(pivot);

      let state = 'idle';
      let resume = 'idle';
      let stateT = 0;
      let time = 0;
      let approval = false;
      let found = null;
      const phaseOffset = (Math.abs(index) * 1.7) % TWO_PI;

      const api = {
        object,
        get state() {
          return state;
        },
        get pendingApproval() {
          return approval;
        },
        setState(type, opts = {}) {
          if (type === 'found') {
            if (state !== 'found') resume = state;
            found = { value: opts.value ?? 0.5, onPeak: opts.onPeak, onDone: opts.onDone, peaked: false };
          } else if (state === 'found') {
            resume = type;
            if (type === 'done') approval = false;
            if (type === 'needs_approval') approval = true;
            return api;
          }
          if (type === 'done') approval = false;
          if (type === 'needs_approval') approval = true;
          state = type;
          stateT = 0;
          return api;
        },
        clearApproval() {
          approval = false;
          return api;
        },
        press() {
          return api;
        },
        setColor(next) {
          material.color.set(next);
          return api;
        },
        setFacing(radians) {
          object.rotation.y = radians;
          return api;
        },
        faceTowards(point) {
          object.rotation.y = Math.atan2(point.x - object.position.x, point.z - object.position.z);
          return api;
        },
        hopTo(position, onArrive) {
          object.position.set(position.x, position.y ?? object.position.y, position.z);
          onArrive?.();
          return api;
        },
        head() {
          return pivot.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, size, 0));
        },
        update(dt) {
          stateT += dt;
          time += dt;
          let y = 0;
          let squash = 1;
          let spin = 0;
          let lean = 0;
          const phase = time + phaseOffset;
          if (state === 'idle') {
            squash = 1 + Math.sin(phase * 1.6) * 0.02;
          } else if (state === 'working') {
            y = Math.abs(Math.sin(phase * 5)) * 0.05;
            squash = 1 + Math.sin(phase * 10) * 0.02;
          } else if (state === 'found') {
            const span = 1.1;
            y = Math.max(0, Math.sin((Math.min(stateT, span) / span) * Math.PI)) * (0.45 + (found?.value ?? 0.5) * 0.9);
            spin = (Math.min(stateT, span) / span) * TWO_PI;
            if (found && !found.peaked && stateT > span / 2) {
              found.peaked = true;
              found.onPeak?.(found.value);
            }
            if (stateT >= span) {
              const done = found?.onDone;
              found = null;
              state = resume;
              stateT = 0;
              done?.();
            }
          } else if (state === 'done') {
            y = stateT < 0.8 ? Math.sin((stateT / 0.8) * Math.PI) * 0.28 : 0;
            spin = Math.min(1, stateT / 0.8) * TWO_PI;
          }
          if (approval && state !== 'found') lean = Math.sin(phase * 7) * 0.12;
          pivot.position.y = y;
          pivot.rotation.y = spin;
          pivot.rotation.z = lean;
          const across = 1 / Math.sqrt(squash);
          pivot.scale.set(across, squash, across);
          return api;
        },
        dispose() {
          material.dispose();
          object.parent?.remove(object);
        },
      };
      return api;
    },
    dispose() {
      geometries.forEach((g) => g.dispose());
      eyeGeometry.dispose();
      eyeMaterial.dispose();
    },
  };
}

async function realFactory(mod, { assetsRoot, camera, quality }) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(`${assetsRoot}assets/mascots/mascots.glb`);
  return {
    kind: 'real',
    gltf,
    module: mod,
    async create({ color, index = 0, lead = false, shape, size = 1, ...rest } = {}) {
      return mod.createMascot(THREE, gltf, {
        shape: shape ?? mod.mascotShapeFor(index, lead),
        color,
        size,
        camera,
        castShadow: quality.shadows,
        ...rest,
      });
    },
    dispose() {},
  };
}

export async function loadMascots({ params, assetsRoot, camera, quality }) {
  if (params.get('mascots') === 'fallback' || !loadMascotModule) return fallbackFactory();
  try {
    const mod = await loadMascotModule();
    if (typeof mod.createMascot === 'function') return await realFactory(mod, { assetsRoot, camera, quality });
    console.warn('assets/mascots/mascots.js has no createMascot export, using the fallback bots');
  } catch (err) {
    console.warn('Could not load the mascot set, using the fallback bots:', err);
  }
  return fallbackFactory();
}
