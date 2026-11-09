// Dev-only island. It exists to test the engine and to show the contract in working code. It never ships
// once a real island exists. It is deliberately plain: real islands are where the look lives.

import { pointAlongRoute } from '../../engine/route.js';

const TYPES = ['tower', 'drum', 'dome', 'stack', 'dish', 'twin'];
const RESULT_SECONDS = 2.5; // The contract asks for under 3, when the next bot's working arrives.

// A line of work with uneven gaps, for a team of 3 or 4. The last station is the main building, at the far end.
function stationsFor(workers) {
  const steps = workers === 2 ? [0, 15, 32] : [0, 13, 24, 39];
  const middle = steps[steps.length - 1] / 2;
  return steps.map((x, i) => ({ x: x - middle, z: i % 2 ? -3.5 : 3.5 }));
}

// This island's own overview: grows until every point fits, keeping them centred up and down.
function fitHome(THREE, points, aspect, fov, polar, theta, top) {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 2000);
  const base = new THREE.Vector3();
  points.forEach((p) => base.add(p));
  base.multiplyScalar(1 / points.length).setY(0);
  const back = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
  const target = new THREE.Vector3();
  const v = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const place = (radius, slide) => {
    target.copy(base).addScaledVector(back, slide);
    cam.position.copy(target).addScaledVector(back, radius * Math.sin(polar));
    cam.position.y += radius * Math.cos(polar);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
  };
  const measure = () => {
    cam.getWorldDirection(forward);
    const m = { maxX: 0, minY: Infinity, maxY: -Infinity, behind: false };
    for (const p of points) {
      if (v.copy(p).sub(cam.position).dot(forward) < 0.2) m.behind = true;
      v.copy(p).project(cam);
      m.maxX = Math.max(m.maxX, Math.abs(v.x));
      m.minY = Math.min(m.minY, v.y);
      m.maxY = Math.max(m.maxY, v.y);
    }
    return m;
  };
  for (let radius = 8; radius < 900; radius *= 1.03) {
    let lo = -radius;
    let hi = radius;
    for (let i = 0; i < 18; i += 1) {
      const mid = (lo + hi) / 2;
      place(radius, mid);
      const m = measure();
      if (m.behind || (m.maxY + m.minY) / 2 < 0) lo = mid;
      else hi = mid;
    }
    place(radius, (lo + hi) / 2);
    const m = measure();
    if (!m.behind && m.maxX <= 0.92 && m.maxY <= top && m.minY >= -top) break;
  }
  return { position: cam.position.clone(), target: target.clone() };
}

export async function createIsland({ THREE, scene, camera, renderer, config, quality, mascots }) {
  camera.near = 0.1;
  camera.far = 400;
  camera.updateProjectionMatrix();
  const root = new THREE.Group();
  scene.add(root);
  const disposables = [];
  const track = (x) => {
    disposables.push(x);
    return x;
  };

  const skyDay = new THREE.Color('#9fc4e8');
  const skyDusk = new THREE.Color('#3b4a78');
  const skyNight = new THREE.Color('#0b1020');
  scene.background = skyDusk.clone();

  const hemi = new THREE.HemisphereLight('#dfe9ff', '#39435c', 1);
  root.add(hemi);
  const sun = new THREE.DirectionalLight('#ffe2b8', 2);
  sun.position.set(14, 22, 10);
  if (quality.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 90 });
    sun.shadow.bias = -0.0005;
  }
  root.add(sun);

  const groundMat = track(new THREE.MeshStandardMaterial({ color: '#566680', roughness: 0.92 }));
  const ground = new THREE.Mesh(track(new THREE.CircleGeometry(120, 64)), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  const box = track(new THREE.BoxGeometry(1, 1, 1));
  const cyl = track(new THREE.CylinderGeometry(1, 1, 1, 32));
  const sphere = track(new THREE.SphereGeometry(1, 32, 20));
  const ringGeo = track(new THREE.TorusGeometry(1, 0.05, 10, 72));
  const shellMat = track(new THREE.MeshStandardMaterial({ color: '#d7dbe4', roughness: 0.55, metalness: 0.1 }));
  const darkMat = track(new THREE.MeshStandardMaterial({ color: '#2a2f3a', roughness: 0.6, metalness: 0.2 }));

  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = quality.shadows;
    m.receiveShadow = quality.shadows;
    parent.add(m);
    return m;
  };

  function buildingFor(kind, group, lit, colliders, wx, wz) {
    const add = (r, h) => colliders.push({ center: new THREE.Vector3(wx - 1.3, h / 2, wz - 0.7), radius: Math.max(r, h / 2) + 0.2 });
    const b = new THREE.Group();
    b.position.set(-1.3, 0, -0.7);
    group.add(b);
    if (kind === 'tower') {
      mesh(box, darkMat, b, 0, 1.6, 0, 1.1, 3.2, 1.1);
      mesh(box, lit, b, 0, 1.6, 0.56, 0.8, 2.7, 0.02);
      add(0.9, 3.2);
    } else if (kind === 'drum') {
      mesh(cyl, lit, b, 0, 1.3, 0, 0.62, 2.6, 0.62);
      mesh(cyl, shellMat, b, 0, 2.7, 0, 0.68, 0.18, 0.68);
      add(0.8, 2.8);
    } else if (kind === 'dome') {
      mesh(sphere, lit, b, 0, 0, 0, 1.15);
      mesh(cyl, darkMat, b, 0, 1.4, 0, 0.08, 1, 0.08);
      add(1.2, 2);
    } else if (kind === 'stack') {
      mesh(box, darkMat, b, 0, 0.5, 0, 1.7, 1, 1.2);
      mesh(box, lit, b, 0, 1.3, 0, 1.3, 0.6, 1);
      mesh(box, darkMat, b, 0, 1.9, 0, 0.9, 0.6, 0.8);
      add(1, 2.2);
    } else if (kind === 'dish') {
      mesh(cyl, darkMat, b, 0, 0.8, 0, 0.3, 1.6, 0.3);
      const dish = mesh(sphere, lit, b, 0, 2.05, 0, 0.9, 0.3, 0.9);
      dish.rotation.x = 0.8;
      add(1, 2.6);
    } else {
      mesh(box, darkMat, b, -0.45, 1.3, 0, 0.7, 2.6, 0.9);
      mesh(box, darkMat, b, 0.45, 1, 0, 0.7, 2, 0.9);
      mesh(box, lit, b, -0.45, 1.3, 0.46, 0.5, 2.2, 0.02);
      mesh(box, lit, b, 0.45, 1, 0.46, 0.5, 1.6, 0.02);
      add(1.1, 2.6);
    }
    return b;
  }

  const colliders = [];
  const worlds = new Map();
  const worldState = new Map();

  async function makeWorld(bot, position, kind, isMain) {
    const color = new THREE.Color(bot.color);
    const group = new THREE.Group();
    group.position.set(position.x, 0, position.z);
    root.add(group);

    const scale = isMain ? 1.55 : 1;
    mesh(cyl, shellMat, group, 0, 0.1, 0, 2.9 * scale, 0.2, 2.9 * scale);

    const lit = track(new THREE.MeshStandardMaterial({ color: '#1b1e26', emissive: color, emissiveIntensity: 0.5, roughness: 0.4 }));
    if (isMain) {
      mesh(box, darkMat, group, -1.2, 4, -1, 2.6, 8, 2.6);
      mesh(box, lit, group, -1.2, 4, 0.32, 2, 7.2, 0.04);
      mesh(box, darkMat, group, -1.2, 9, -1, 1.6, 2, 1.6);
      colliders.push({ center: new THREE.Vector3(position.x - 1.2, 5, position.z - 1), radius: 5.4 });
    } else {
      buildingFor(kind, group, lit, colliders, position.x, position.z);
    }

    // The bot on its pad, out in the open.
    const padMat = track(new THREE.MeshStandardMaterial({ color: '#23262e', roughness: 0.5 }));
    mesh(cyl, padMat, group, 1, 0.26, 0.9, 0.95, 0.12, 0.95);
    const ringMat = track(new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    const ring = mesh(ringGeo, ringMat, group, 1, 0.34, 0.9, 1);
    ring.rotation.x = Math.PI / 2;
    ring.castShadow = false;

    const bot3d = await mascots.create({ color: bot.color, index: bot.index, lead: !!bot.lead, size: isMain ? 1.05 : 0.85 });
    bot3d.object.position.set(1, 0.32, 0.9);
    group.add(bot3d.object);

    const anchor = new THREE.Object3D();
    anchor.position.set(1, 1.35, 0.9);
    group.add(anchor);

    // Found: a beam up. Height from intensity.
    const beamMat = track(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    const beam = new THREE.Mesh(cyl, beamMat);
    beam.position.set(1, 0, 0.9);
    beam.visible = false;
    group.add(beam);

    // Done: a white ripple across the ground.
    const rippleMat = track(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    const ripple = new THREE.Mesh(ringGeo, rippleMat);
    ripple.rotation.x = Math.PI / 2;
    ripple.position.set(1, 0.3, 0.9);
    ripple.visible = false;
    group.add(ripple);

    // Needs approval: an amber beacon hanging over the world, until cleared.
    const beaconMat = track(new THREE.MeshBasicMaterial({ color: '#ffb547', toneMapped: false }));
    const beacon = new THREE.Mesh(sphere, beaconMat);
    beacon.scale.setScalar(0.22);
    beacon.position.set(1, 2.1, 0.9);
    beacon.visible = false;
    group.add(beacon);

    // Done: the result leaves for the next station along the route.
    const resultMat = track(new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    const result = new THREE.Mesh(sphere, resultMat);
    result.scale.setScalar(0.34);
    result.visible = false;
    root.add(result);

    worldState.set(bot.id, {
      bot,
      result,
      resultLeg: null,
      resultLeft: 0,
      sent: 0,
      landed: 0,
      activity: 'idle',
      pending: false,
      beamLeft: 0,
      beamPower: 0,
      rippleLeft: 0,
      lit,
      ring,
      ringMat,
      beam,
      beamMat,
      ripple,
      rippleMat,
      beacon,
      bot3d,
      baseColor: color,
      phase: bot.index * 1.3,
      found: 0,
      done: 0,
    });

    // Close in from the near side of the line, a little to the right.
    const focusDist = isMain ? 18 : 9;
    const focusTarget = new THREE.Vector3(position.x + 0.2, isMain ? 3 : 1, position.z);
    const focusPos = focusTarget.clone().add(new THREE.Vector3(focusDist * 0.3, focusDist * 0.5, focusDist * 0.8));

    return { anchor, stage: group, focus: { position: focusPos, target: focusTarget } };
  }

  const stations = stationsFor(config.bots.length);
  // Where a result sits on each station: over the pad, in world space.
  const dockAt = (i) => new THREE.Vector3(stations[i].x + 1, 0.8, stations[i].z + 0.9);
  // A bend between two stations, so a route is more than its stations.
  const bendAfter = (i) => dockAt(i).lerp(dockAt(i + 1), 0.5).add(new THREE.Vector3(0, 0.5, i % 2 ? 1.6 : -1.6));

  for (const bot of config.bots) {
    const i = bot.index;
    const world = await makeWorld(bot, stations[i], TYPES[i % TYPES.length], false);
    // From this bot, past the next station, to the main building.
    world.route = [];
    for (let j = i; j < config.bots.length; j += 1) world.route.push(dockAt(j), bendAfter(j));
    world.route.push(dockAt(config.bots.length));
    world.handoff = 2; // route[0] is this bot, route[1] the bend, route[2] the next station.
    worlds.set(bot.id, world);
  }
  const mainPlace = stations[stations.length - 1];
  const main = await makeWorld(config.lead, mainPlace, 'main', true);
  main.anchor.position.set(-1.2, 10.6, -1);

  // The line itself, on the ground, from the first bot to the main building.
  const firstRoute = worlds.get(config.bots[0].id).route;
  const lineCurve = new THREE.CatmullRomCurve3(firstRoute.map((p) => p.clone().setY(0.16)));
  root.add(new THREE.Mesh(track(new THREE.TubeGeometry(lineCurve, 160, 0.05, 6)), track(new THREE.MeshBasicMaterial({ color: '#c9d1de', toneMapped: false }))));

  // What the overview has to hold: each anchor, and the ground around each station.
  const framePoints = [];
  for (const world of [...worlds.values(), main]) {
    framePoints.push(world.anchor.getWorldPosition(new THREE.Vector3()));
    const at = world.stage.position;
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) framePoints.push(new THREE.Vector3(at.x + dx, 0, at.z + dz));
  }

  function fireFound(s, intensity) {
    s.beamLeft = 1.4 + intensity * 1.6;
    s.beamPower = intensity;
    s.beam.visible = true;
  }

  function fireDone(s) {
    s.rippleLeft = 1.2;
    s.ripple.visible = true;
  }

  return {
    worlds,
    main,
    // A wide screen sees the line side on. A tall one looks along it, so the line climbs the screen, and it
    // leaves more room at the top and bottom for the page's own text.
    home(aspect) {
      return aspect >= 1
        ? fitHome(THREE, framePoints, aspect, camera.fov, 1.05, 0.12, 0.8)
        : fitHome(THREE, framePoints, aspect, camera.fov, 0.72, -Math.PI / 2 + 0.28, 0.7);
    },
    cameraLimits: {
      groundY: 0.25,
      clearance: 0.5,
      colliders,
      minDistance: 3,
    },
    setDaylight(t) {
      const height = Math.sin((t - 0.25) * Math.PI * 2); // 1 at noon, -1 at midnight.
      const day = THREE.MathUtils.smoothstep(height, -0.05, 0.55);
      const dusk = 1 - Math.min(1, Math.abs(height) / 0.45);
      const sky = skyNight.clone().lerp(skyDay, day).lerp(skyDusk, dusk * 0.8);
      scene.background.copy(sky);
      hemi.intensity = 0.9 + day * 0.7;
      sun.intensity = 0.7 + day * 2;
      const azimuth = (t - 0.5) * Math.PI * 2;
      sun.position.set(Math.sin(azimuth) * 26, 8 + Math.max(0, height) * 22, 12 + Math.cos(azimuth) * 8);
      sun.color.set(dusk > 0.4 ? '#ffb27a' : '#fff1dc');
    },
    applyEvent(evt) {
      const s = worldState.get(evt.bot_id);
      if (!s) return;
      s.activity = evt.activity;
      s.pending = evt.pending;
      s.beacon.visible = evt.pending;
      if (evt.catchup) {
        s.resultLeft = 0;
        s.result.visible = false;
        if (!evt.pending) s.bot3d.clearApproval();
        s.bot3d.setState(evt.pending ? 'needs_approval' : evt.activity);
        return;
      }
      s.settleIn = 0;
      if (evt.type === 'found') {
        s.found += 1;
        fireFound(s, evt.intensity);
      } else if (evt.type === 'done') {
        s.done += 1;
        fireDone(s);
        s.settleIn = 2.5;
        if (evt.route) {
          s.resultLeg = evt.route;
          s.resultLeft = RESULT_SECONDS;
          s.result.visible = true;
          s.resultNext = evt.next;
          s.sent += 1;
        }
      }
      s.bot3d.setState(evt.type, { value: evt.intensity });
    },
    update(dt, t) {
      for (const s of worldState.values()) {
        const working = s.activity === 'working';
        const flicker = working ? 0.75 + 0.25 * Math.sin(t * 17 + s.phase) * Math.sin(t * 6.1 + s.phase) : 0;
        s.lit.emissiveIntensity = working ? 1.4 + flicker : 0.32 + 0.1 * Math.sin(t * 1.1 + s.phase);
        s.ring.rotation.z += dt * (working ? 3 : 0.3);
        const ringPulse = working ? 1.04 + Math.sin(t * 8 + s.phase) * 0.04 : 1;
        s.ring.scale.setScalar(ringPulse);
        if (s.pending) {
          const beat = 0.5 + 0.5 * Math.sin(t * 5);
          s.beacon.scale.setScalar(0.18 + beat * 0.12);
          s.beacon.position.y = 2.1 + Math.sin(t * 1.6 + s.phase) * 0.08;
        }
        if (s.beamLeft > 0) {
          s.beamLeft -= dt;
          const fade = Math.min(1, s.beamLeft / 0.8);
          const height = 10 + s.beamPower * 34;
          s.beam.scale.set(0.1 + s.beamPower * 0.4, height, 0.1 + s.beamPower * 0.4);
          s.beam.position.y = height / 2;
          s.beamMat.opacity = 0.6 * fade;
          if (s.beamLeft <= 0) s.beam.visible = false;
        }
        if (s.rippleLeft > 0) {
          s.rippleLeft -= dt;
          const k = 1 - s.rippleLeft / 1.2;
          s.ripple.scale.setScalar(1 + k * 3.6);
          s.rippleMat.opacity = 1 - k;
          if (s.rippleLeft <= 0) s.ripple.visible = false;
        }
        if (s.resultLeft > 0) {
          s.resultLeft -= dt;
          pointAlongRoute(s.resultLeg, 1 - Math.max(0, s.resultLeft) / RESULT_SECONDS, s.result.position);
          if (s.resultLeft <= 0) {
            s.result.visible = false;
            s.landed += 1;
          }
        }
        if (s.settleIn > 0) {
          s.settleIn -= dt;
          if (s.settleIn <= 0) s.bot3d.setState(s.activity);
        }
        s.bot3d.update(dt);
      }
    },
    debugState() {
      const out = {};
      for (const [id, s] of worldState) {
        out[id] = { activity: s.activity, pending: s.pending, beacon: s.beacon.visible, beam: s.beam.visible, ripple: s.ripple.visible, beamPower: s.beamPower, found: s.found, done: s.done, sent: s.sent, landed: s.landed, travelling: s.result.visible, next: s.resultNext ?? null, at: s.result.position.toArray() };
      }
      return out;
    },
    dispose() {
      for (const s of worldState.values()) s.bot3d.dispose();
      for (const d of disposables) d.dispose();
      scene.remove(root);
    },
  };
}
