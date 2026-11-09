// The camera rig: one spring-damped pose that every mode steers. Drag, zoom, click flights, the tour and
// the pull toward events only change the wanted pose, so any move can interrupt any other without a jump.
// The final pose is clamped every frame in every mode.

import * as THREE from 'three';

const TAU = Math.PI * 2;

export const PULL_PRIORITY = { needs_approval: 3, found: 2, done: 1, working: 0.5, idle: 0 };
// Seconds the camera must have rested at home before an event of this type may pull it away.
const PULL_REST = { needs_approval: 2, found: 4, done: 10, working: 28 };
const PULL_HOLD = { needs_approval: 10, found: 7, done: 5, working: 5 };
const PULL_AMOUNT = 0.58;

function smoothDamp(s, key, target, smoothTime, dt, maxSpeed = Infinity) {
  // Critically damped spring. Starts and ends gently, keeps velocity across retargeting.
  const vKey = `v${key}`;
  const omega = 2 / Math.max(smoothTime, 0.0001);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const maxChange = maxSpeed * smoothTime;
  const change = Math.max(-maxChange, Math.min(maxChange, s[key] - target));
  const adjusted = s[key] - change;
  const temp = (s[vKey] + omega * change) * dt;
  s[vKey] = (s[vKey] - omega * temp) * exp;
  s[key] = adjusted + (change + temp) * exp;
}

export function poseToSpherical(position, target) {
  const dx = position.x - target.x;
  const dy = position.y - target.y;
  const dz = position.z - target.z;
  const radius = Math.max(0.001, Math.hypot(dx, dy, dz));
  return {
    tx: target.x,
    ty: target.y,
    tz: target.z,
    theta: Math.atan2(dx, dz),
    phi: Math.acos(Math.max(-1, Math.min(1, dy / radius))),
    logR: Math.log(radius),
  };
}

// Pure, so tests can throw bad poses at it.
export function clampPosition(pos, limits) {
  const clearance = limits.clearance ?? 0.4;
  const ground = (x, z) => (limits.groundHeight ? limits.groundHeight(x, z) : (limits.groundY ?? 0));
  for (let pass = 0; pass < 3; pass += 1) {
    for (const c of limits.colliders ?? []) {
      const dx = pos.x - c.center.x;
      const dy = pos.y - c.center.y;
      const dz = pos.z - c.center.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < c.radius) {
        const safe = d > 1e-4 ? c.radius / d : 1;
        pos.x = c.center.x + (d > 1e-4 ? dx * safe : 0);
        pos.y = c.center.y + (d > 1e-4 ? dy * safe : c.radius);
        pos.z = c.center.z + (d > 1e-4 ? dz * safe : 0);
      }
    }
    const floor = ground(pos.x, pos.z) + clearance;
    if (pos.y < floor) pos.y = floor;
  }
  // Ground and colliders can fight on a slope. Moving straight up settles both, since x and z stay put.
  for (let pass = 0; pass <= (limits.colliders?.length ?? 0); pass += 1) {
    let moved = false;
    for (const c of limits.colliders ?? []) {
      const dx = pos.x - c.center.x;
      const dz = pos.z - c.center.z;
      const dy = pos.y - c.center.y;
      if (dx * dx + dy * dy + dz * dz < c.radius * c.radius) {
        pos.y = c.center.y + Math.sqrt(Math.max(0, c.radius * c.radius - dx * dx - dz * dz)) + 1e-6;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pos;
}

export function createCameraRig({ camera, dom, island, config, params, clockNow, onSelect, reducedMotion = false }) {
  const limits = {
    clearance: 0.4,
    minDistance: 1.5,
    maxPolar: 1.45,
    groundY: 0,
    ...(island.cameraLimits ?? {}),
  };
  // In line order, whatever order the island filled its Map in.
  const worldList = config.bots.map((bot) => island.worlds.get(bot.id));
  const anchorPoint = (a) => (a.isVector3 ? a : a.getWorldPosition(new THREE.Vector3()));
  const pullsEnabled = params.get('pull') !== '0' && !reducedMotion;

  const defaultPick = (() => {
    const pts = worldList.map((w) => anchorPoint(w.anchor));
    let nearest = Infinity;
    pts.forEach((a, i) => pts.forEach((b, j) => {
      if (i !== j) nearest = Math.min(nearest, a.distanceTo(b));
    }));
    return Number.isFinite(nearest) ? nearest * 0.42 : 2;
  })();

  // Both are overwritten from island.home before the first frame.
  const pose = { tx: 0, ty: 0, tz: 0, theta: 0, phi: 1, logR: 3, vtx: 0, vty: 0, vtz: 0, vtheta: 0, vphi: 0, vlogR: 0 };
  const want = { tx: 0, ty: 0, tz: 0, theta: 0, phi: 1, logR: 3 };
  let smoothTime = 0.16;
  let mode = 'home'; // home, free, flight, pull, tour, director
  let homePose = null;
  let maxDistance = limits.maxDistance ?? 60;
  let lastInput = -Infinity;
  let dragging = false;
  const pointers = new Map();
  let pinchStart = null;
  let dragMoved = 0;
  let downAt = 0;
  let downXY = null;
  let pullUntil = 0;
  let pullPriority = 0;
  let pullWorld = null;
  let tour = null;
  let lastPullEnd = 0; // Engine time. Also gives the opening a few quiet seconds.

  const IDLE_BEFORE_PULL = 12;
  const clockT = () => clockNow();

  function setWant(s, st) {
    want.tx = s.tx;
    want.ty = s.ty;
    want.tz = s.tz;
    // Take the short way round.
    want.theta = pose.theta + THREE.MathUtils.euclideanModulo(s.theta - pose.theta + Math.PI, TAU) - Math.PI;
    want.phi = s.phi;
    want.logR = s.logR;
    smoothTime = st;
  }

  function computeHomePose() {
    const framing = island.home(camera.aspect || 1);
    homePose = poseToSpherical(framing.position, framing.target);
    if (limits.maxDistance === undefined) maxDistance = Math.exp(homePose.logR) * 1.6;
  }

  function focusPose(world, amount = 1) {
    const f = poseToSpherical(world.focus.position, world.focus.target);
    if (amount >= 1) return f;
    const lerp = THREE.MathUtils.lerp;
    const dTheta = THREE.MathUtils.euclideanModulo(f.theta - homePose.theta + Math.PI, TAU) - Math.PI;
    // The world goes to the middle of the frame. Distance and angle only go part of the way.
    return {
      tx: f.tx,
      ty: f.ty,
      tz: f.tz,
      theta: homePose.theta + dTheta * amount * 0.7,
      phi: lerp(homePose.phi, f.phi, amount * 0.7),
      logR: lerp(homePose.logR, f.logR, amount),
    };
  }

  function goHome(st = 1.2) {
    if (mode === 'pull') lastPullEnd = clockT();
    mode = 'home';
    tour = null;
    setWant(homePose, st);
    pullWorld = null;
    pullPriority = 0;
  }

  function flyTo(world) {
    tour = null;
    mode = 'flight';
    lastInput = clockT();
    pullWorld = null;
    pullPriority = 0;
    setWant(focusPose(world), 0.7);
  }

  function startTour() {
    // Along the line, then the main building where it ends.
    const stops = [...worldList.map((world) => ({ world })), { world: island.main }];
    tour = { stops, index: -1, left: 0, drift: 0.018 };
    mode = 'tour';
    nextTourStop();
  }

  function nextTourStop() {
    tour.index = (tour.index + 1) % (tour.stops.length + 1);
    if (tour.index === tour.stops.length) {
      // Back to the whole line between rounds.
      setWant(homePose, 2.6);
      tour.left = 9;
      return;
    }
    const stop = tour.stops[tour.index];
    setWant(focusPose(stop.world), 2.6);
    tour.left = 9;
  }

  function stopTour() {
    if (mode === 'tour') {
      tour = null;
      mode = 'free';
    }
  }

  // ---------- live view ----------
  // Nobody is at the controls, so an unseen operator holds the shot: a slow pan across the whole place, back and forth,
  // with random timing and height. Every pane rolls its own, so no two runs and no two panes ever match. Hands on the camera always win, and it picks up again once they let go.
  const directed = Boolean(limits.plate) && !reducedMotion && params.get('director') !== '0'
    && params.get('still') !== '1' && params.get('capture') !== '1' && params.get('quality') !== 'phone';
  const director = { left: 0, shots: 0, side: 1, endY: 0, v: new THREE.Vector3(), vTheta: 0, vPhi: 0, vLogR: 0 };
  const rand = (a, b) => a + Math.random() * (b - a);
  const shotTarget = new THREE.Vector3();
  const axisF = new THREE.Vector3();
  const axisR = new THREE.Vector3();
  const axisU = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);

  function nextShot() {
    const framing = island.home(camera.aspect || 1);
    const eye = framing.position;
    axisF.copy(framing.target).sub(eye).normalize();
    axisR.crossVectors(axisF, worldUp).normalize();
    axisU.crossVectors(axisR, axisF);
    const homeDist = eye.distanceTo(framing.target);
    const halfH = homeDist * (limits.plateTan?.[1] ?? 0.3);
    const halfW = homeDist * (limits.plateTan?.[0] ?? 0.5);
    // Pan, never zoom: the whole place stays in frame, cropped just enough to have somewhere to travel.
    // Each pan starts where the last one ended and crosses to the other side, so the move never jumps or reverses.
    const zoom = 1.08;
    const seconds = rand(18, 28);
    const room = (1 - 1 / zoom) * 0.92;
    director.side = director.shots === 0 ? (Math.random() < 0.5 ? -1 : 1) : -director.side;
    const fromY = director.shots === 0 ? rand(-0.6, 0.6) : director.endY;
    director.endY = rand(-0.6, 0.6);
    const fx = director.side * room;
    shotTarget.copy(framing.target).addScaledVector(axisR, fx * halfW).addScaledVector(axisU, fromY * room * halfH);
    director.v.copy(axisR).multiplyScalar(-2 * fx * halfW).addScaledVector(axisU, (director.endY - fromY) * room * halfH).multiplyScalar(1 / seconds);
    director.shots += 1;
    director.left = seconds;
    // A small turn of the eye along the way shows the depth without showing what the frame never saw.
    const theta = homePose.theta + rand(-0.06, 0.06);
    const phi = homePose.phi + rand(-0.03, 0.03);
    director.vTheta = rand(-0.08, 0.08) / seconds;
    director.vPhi = 0;
    director.vLogR = 0;
    setWant({
      tx: shotTarget.x, ty: shotTarget.y, tz: shotTarget.z, theta, phi, logR: Math.log(eye.distanceTo(shotTarget) / zoom),
    }, director.shots === 1 ? 3 : 2.4);
    mode = 'director';
  }

  // Called for every live event. Goes to the world in question unless the person is using the camera.
  function attend(evt, world) {
    if (!pullsEnabled || limits.noPull || !world || evt.catchup) return;
    if (mode === 'tour' || mode === 'flight' || dragging) return;
    if (clockT() - lastInput < IDLE_BEFORE_PULL) return;
    const priority = PULL_PRIORITY[evt.type] ?? 0;
    if (priority <= 0) return;
    const busy = mode === 'pull' && clockT() < pullUntil;
    if (busy) {
      // Only something more urgent cuts a pull short, and never in its first seconds.
      if (priority <= pullPriority) return;
      if (clockT() > pullUntil - 2) return;
    } else if (clockT() - lastPullEnd < PULL_REST[evt.type]) {
      return;
    }
    if (mode === 'free') return;
    pullWorld = world;
    pullPriority = priority;
    pullUntil = clockT() + PULL_HOLD[evt.type];
    mode = 'pull';
    setWant(focusPose(world, PULL_AMOUNT), 1.6);
  }

  function noteInput() {
    lastInput = clockT();
    if (mode === 'tour') stopTour();
    if (mode === 'pull' || mode === 'home' || mode === 'flight' || mode === 'director') mode = 'free';
    smoothTime = 0.12;
  }

  function hitTestWorld(clientX, clientY) {
    const rect = dom.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best = null;
    let bestDist = Infinity;
    const check = (world) => {
      const a = anchorPoint(world.anchor);
      v.copy(a).project(camera);
      if (v.z > 1) return;
      const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
      // Pixel reach from the world's size at this distance.
      const dist = camera.position.distanceTo(a);
      const pxPerUnit = rect.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist);
      const reach = Math.max(36, (world.pickRadius ?? defaultPick) * pxPerUnit);
      const d = Math.hypot(clientX - sx, clientY - (sy + reach * 0.35));
      if (d < reach && d < bestDist) {
        best = world;
        bestDist = d;
      }
    };
    worldList.forEach(check);
    check(island.main);
    return best;
  }

  function onPointerDown(e) {
    dom.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragging = true;
      dragMoved = 0;
      downAt = performance.now();
      downXY = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), logR: want.logR };
      dragMoved = 999;
    }
  }

  function onPointerMove(e) {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      noteInput();
      want.logR = pinchStart.logR - Math.log(Math.max(d, 1) / Math.max(pinchStart.d, 1));
      return;
    }
    if (pointers.size === 1) {
      dragMoved += Math.abs(dx) + Math.abs(dy);
      if (dragMoved < 6) return;
      noteInput();
      const speed = 3.2 / Math.max(dom.clientHeight, 1);
      want.theta -= dx * speed;
      want.phi -= dy * speed;
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size > 0) return;
    dragging = false;
    if (dragMoved < 6 && performance.now() - downAt < 600 && downXY) {
      const world = hitTestWorld(downXY.x, downXY.y);
      if (world) {
        flyTo(world);
        onSelect?.(world);
      }
    }
  }

  function onWheel(e) {
    e.preventDefault();
    noteInput();
    const scale = e.ctrlKey ? 0.012 : 0.0016;
    want.logR += THREE.MathUtils.clamp(e.deltaY, -240, 240) * scale;
  }

  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  dom.addEventListener('wheel', onWheel, { passive: false });

  computeHomePose();
  Object.assign(pose, { tx: homePose.tx, ty: homePose.ty, tz: homePose.tz, theta: homePose.theta, phi: homePose.phi, logR: homePose.logR });
  setWant(homePose, 0.6);

  const startPull = params.get('focus');
  if (startPull) {
    const target = startPull === 'main' ? island.main : island.worlds.get(startPull);
    if (target) {
      const f = focusPose(target);
      Object.assign(pose, { tx: f.tx, ty: f.ty, tz: f.tz, theta: f.theta, phi: f.phi, logR: f.logR });
      setWant(f, 0.6);
      mode = 'free';
      lastInput = Infinity;
    }
  }

  const tmp = new THREE.Vector3();

  function applyPose() {
    const r = Math.exp(pose.logR);
    const sinP = Math.sin(pose.phi);
    camera.position.set(
      pose.tx + r * sinP * Math.sin(pose.theta),
      pose.ty + r * Math.cos(pose.phi),
      pose.tz + r * sinP * Math.cos(pose.theta),
    );
    clampPosition(camera.position, limits);
    camera.userData.rig = { tx: pose.tx, ty: pose.ty, tz: pose.tz, r: Math.exp(pose.logR), theta: pose.theta, phi: pose.phi };
    tmp.set(pose.tx, pose.ty, pose.tz);
    camera.lookAt(tmp);
    camera.updateMatrixWorld();
  }

  return {
    get mode() {
      return mode;
    },
    get isHome() {
      return mode === 'home';
    },
    get limits() {
      return limits;
    },
    get maxDistance() {
      return maxDistance;
    },
    get tourWorld() {
      return tour?.stops[tour.index]?.world ?? null;
    },
    goHome,
    flyTo,
    startTour,
    stopTour,
    attend,
    noteInput,
    hitTestWorld,
    onResize() {
      const wasHome = mode === 'home';
      computeHomePose();
      if (wasHome) setWant(homePose, 0.3);
    },
    update(dt) {
      if (directed && (camera.aspect || 1) >= 1) {
        // A short look at the whole place first. Then whenever the person lets go.
        const free = mode === 'free' || mode === 'flight';
        if (mode === 'home' ? clockT() - lastInput > 1.5 && clockT() > 1.5 : free && !dragging && clockT() - lastInput > 12) nextShot();
        if (mode === 'director') {
          director.left -= dt;
          want.tx += director.v.x * dt;
          want.ty += director.v.y * dt;
          want.tz += director.v.z * dt;
          want.theta += director.vTheta * dt;
          want.phi += director.vPhi * dt;
          want.logR += director.vLogR * dt;
          if (director.left <= 0) nextShot();
        }
      }
      if (mode === 'tour') {
        tour.left -= dt;
        want.theta += tour.drift * dt;
        if (tour.left <= 0) nextTourStop();
      }
      if (mode === 'pull' && clockT() > pullUntil) goHome(2.2);
      if (mode === 'free' && clockT() - lastInput > 45) goHome(2.4);
      if (mode === 'flight' && clockT() - lastInput > 45) goHome(2.4);

      want.phi = Math.min(limits.maxPolar, Math.max(0.12, want.phi));
      want.logR = Math.min(Math.log(maxDistance), Math.max(Math.log(limits.minDistance), want.logR));

      for (const key of ['tx', 'ty', 'tz', 'theta', 'phi', 'logR']) smoothDamp(pose, key, want[key], smoothTime, dt);
      pose.phi = Math.min(limits.maxPolar, Math.max(0.05, pose.phi));

      applyPose();
    },
    dispose() {
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerUp);
      dom.removeEventListener('wheel', onWheel);
    },
  };
}
