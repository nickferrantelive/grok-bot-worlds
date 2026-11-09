// Boots the engine: config, renderer, island, store, UI, camera, source, then the frame loop.

import * as THREE from 'three';
import './ui/ui.css';
import islandRegistry from 'virtual:island-registry';
import { loadConfig, ConfigError, teamSize } from './config.js';
import { checkIsland, checkRoutes, checkTeamSize, islandTeamSizes } from './contract.js';
import { doneFields } from './route.js';
import { EventStore } from './events.js';
import { chooseSourceSpec, createSource } from './sources/index.js';
import { createCameraRig } from './camera.js';
import { createUi, showFatal, showLoading } from './ui/ui.js';
import { pickQuality, createFrameMeter } from './quality.js';
import { dayFraction } from './time.js';
import { loadMascots } from './mascots.js';
import example3 from './examples/config.3.json';
import example4 from './examples/config.4.json';

const EXAMPLES = { 'example-3': example3, 'example-4': example4 };
const ISLAND_NAME = /^[a-z0-9_-]+$/;
const PREFERRED_ISLANDS = ['hover-isles', 'arctic-grid', 'orbit-port', 'chrome-citadel', '_placeholder'];
const CAMERA_FOV = 32;

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
const debug = params.get('debug') === '1';
const uiRoot = document.getElementById('gi-ui');
const canvas = document.getElementById('gi-canvas');

function availableIslands() {
  return Object.keys(islandRegistry);
}

async function importIsland(name) {
  if (!ISLAND_NAME.test(name)) throw new ConfigError(`"${name}" is not a valid island name`, ['Use lowercase letters, digits and dashes, like orbit-port.']);
  const loader = islandRegistry[name];
  try {
    if (loader) return await loader();
    if (import.meta.env.DEV) return await import(/* @vite-ignore */ `/islands/${name}/scene.js`);
  } catch (err) {
    if (loader) throw new ConfigError(`The island "${name}" failed to load`, [err.message]);
    // Fall through: in dev a missing file is an unknown island, not a crash.
  }
  const known = availableIslands().filter((n) => !n.startsWith('_'));
  throw new ConfigError(`There is no island called "${name}"`, [`Available: ${known.length ? known.join(', ') : 'none built yet'}.`]);
}

async function boot() {
  const stopLoading = showLoading(uiRoot, 'Loading');

  const load = (param) => loadConfig({
    param,
    examples: EXAMPLES,
    defaultExample: 'example-3',
    defaultTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const configResult = await load(params.get('config'));
  let { config, source: configSource, warnings } = configResult;

  // ?island= beats the config. A bundled example with no island built yet takes the first one that exists.
  let islandName = params.get('island') ?? config.island;
  if (!islandName || (configResult.isExample && !params.get('island') && !availableIslands().includes(islandName))) {
    islandName = PREFERRED_ISLANDS.find((n) => availableIslands().includes(n)) ?? availableIslands()[0];
  }
  if (!islandName) throw new ConfigError('No island to show', ['Set "island" in the config, or add ?island=orbit-port to the address.']);
  const module = await importIsland(islandName);
  if (typeof module.createIsland !== 'function') throw new ConfigError(`The island "${islandName}" has no createIsland export`, []);
  // Nobody asked for a team, so bring the one this island was dressed for, or the bundled one that fits its layout.
  if (configResult.isExample && !params.get('config') && module.exampleTeam) {
    EXAMPLES['island-team'] = { ...module.exampleTeam, island: islandName };
    ({ config, source: configSource, warnings } = await load('island-team'));
  } else if (configResult.isExample && !params.get('config') && !islandTeamSizes(module).includes(teamSize(config))) {
    ({ config, source: configSource, warnings } = await load(`example-${islandTeamSizes(module)[0]}`));
  }
  checkTeamSize(module, islandName, config);
  config.island = islandName;
  const sourceSpec = chooseSourceSpec(params, configSource);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: capture,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  // Count every pass of a frame, not only the last one, so the debug numbers hold up with post.
  renderer.info.autoReset = false;

  const { quality, source: qualitySource } = pickQuality({ params, renderer, capture });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const size = () => [window.innerWidth, window.innerHeight];
  const [w0, h0] = size();
  renderer.setSize(w0, h0, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, w0 / h0, 0.05, 2000);

  const baseUrl = new URL('./', document.baseURI).href;
  const assetsBase = `${baseUrl}islands/${islandName}/assets/`;
  const mascots = await loadMascots({ params, assetsRoot: baseUrl, camera, quality });

  const island = await module.createIsland({ THREE, scene, camera, renderer, config, quality, assetsBase, mascots });
  checkIsland(island, islandName, config);
  scene.updateMatrixWorld(true);
  const routeProblems = checkRoutes(island, config);
  for (const problem of routeProblems) console.warn(`The island "${islandName}": ${problem}`);

  // The clock: real frames normally, window.__step only in capture mode.
  let time = 0;
  const clockNow = () => time;

  // Source and store close over each other's clock, so the store asks through this.
  let source = null;
  const store = new EventStore({ config, now: () => (source ? source.now() : Date.now()) });

  const rig = createCameraRig({
    camera,
    dom: canvas,
    island,
    config,
    params,
    clockNow,
    reducedMotion: !capture && matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
  rig.update(0.016);

  source = await createSource({ spec: sourceSpec, config, store });

  const worldFor = (botId) => (botId === config.lead.id ? island.main : island.worlds.get(botId));

  const applied = [];
  store.on((evt) => {
    const world = worldFor(evt.bot_id);
    const sent = evt.type === 'done' ? { ...evt, ...doneFields(config, evt.bot_id, world) } : evt;
    try {
      island.applyEvent(sent, world);
    } catch (err) {
      console.error(`applyEvent threw for ${evt.type} on ${evt.bot_id}:`, err);
    }
    if (debug || capture) {
      applied.push({ bot_id: evt.bot_id, type: evt.type, warm: !!evt.warm, update: !!evt.update, pending: evt.pending, activity: evt.activity, catchup: evt.catchup, next: sent.next ?? null, leg: sent.route?.length ?? 0 });
      if (applied.length > 800) applied.shift();
    }
    rig.attend(evt, world);
  });
  store.onReset(() => {
    // A new day: everyone goes back to rest, no effects.
    const nowIso = new Date(source.now()).toISOString();
    for (const bot of [config.lead, ...config.bots]) {
      try {
        island.applyEvent({ bot_id: bot.id, type: 'idle', text: '', timestamp: nowIso, ms: source.now(), intensity: 0.5, activity: 'idle', pending: false, catchup: true }, worldFor(bot.id));
      } catch (err) {
        console.error(err);
      }
    }
  });

  let meter = null;
  const ui = createUi({
    root: uiRoot,
    config,
    store,
    island,
    camera,
    source,
    rig,
    params,
    nowMs: () => source.now(),
    debugHud: debug
      ? () => `${(meter?.fps ?? 0).toFixed(0)} fps\n${quality.name} (${qualitySource})\n${islandName}\n${renderer.info.render.calls} calls\n${Math.round(renderer.info.render.triangles / 1000)}k tris\n${mascots.kind} mascots`
      : null,
  });
  stopLoading();
  if (warnings.length) {
    console.warn('Config warnings:', warnings);
    if (!capture) ui.showToast(`Config: ${warnings[0]}${warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ''}`);
  }

  meter = createFrameMeter({
    renderer,
    quality,
    canAdapt: qualitySource === 'auto' && !params.get('dpr'),
    onResolutionChange: () => island.resize?.(window.innerWidth, window.innerHeight),
  });

  // Daylight.
  const pinnedDaylight = params.has('daylight') ? Number(params.get('daylight')) : null;
  let lastDaylight = -1;
  function updateDaylight() {
    const t = pinnedDaylight !== null && Number.isFinite(pinnedDaylight)
      ? THREE.MathUtils.euclideanModulo(pinnedDaylight, 1)
      : dayFraction(source.now(), config.timezone);
    const moved = Math.abs(t - lastDaylight);
    if (lastDaylight < 0 || Math.min(moved, 1 - moved) >= 1 / 1440) {
      lastDaylight = t;
      island.setDaylight(t);
    }
  }
  updateDaylight();

  function onResize() {
    const [w, h] = size();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    island.resize?.(w, h);
    rig.onResize();
    ui.onLayoutChange();
  }
  window.addEventListener('resize', onResize);

  let frames = 0;
  let halted = false;

  function frame(rawDt) {
    if (halted) return;
    const dt = Math.min(rawDt, 0.1);
    time += dt;
    frames += 1;
    // After a hidden tab, demo and replay carry on from where they were rather than dumping a backlog.
    source.update(source.mode === 'live' ? rawDt : Math.min(rawDt, 1));
    updateDaylight();
    rig.update(dt);
    renderer.info.reset();
    try {
      island.update(dt, time);
      if (island.render) island.render(dt, time);
      else renderer.render(scene, camera);
    } catch (err) {
      halted = true;
      console.error(err);
      showFatal(uiRoot, `The island "${islandName}" stopped with an error`, [err.message]);
      return;
    }
    ui.update(dt, time);
    meter.tick(rawDt);
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    halted = true;
    showFatal(uiRoot, 'The graphics context was lost', ['Reload the page to continue.']);
  });

  // Debug keys fire local events only. Nothing leaves the page.
  if (debug) {
    const TYPES = ['idle', 'working', 'found', 'done', 'needs_approval'];
    let cursor = 0;
    let fired = 0;
    window.addEventListener('keydown', (e) => {
      const n = Number(e.key);
      if (e.key === 'Tab') {
        cursor = (cursor + 1) % config.bots.length;
        return;
      }
      if (n >= 1 && n <= 5) {
        fired += 1;
        store.ingest({
          id: `debug-${fired}`,
          bot_id: config.bots[cursor].id,
          type: TYPES[n - 1],
          text: `debug ${TYPES[n - 1]}`,
          timestamp: new Date(source.now()).toISOString(),
          value: TYPES[n - 1] === 'found' ? 10 ** (fired % 4) : undefined,
        });
      }
    });
  }

  // Read-only peek for tests and the record tool.
  window.__engine = {
    island,
    islandName,
    config,
    store,
    source,
    rig,
    camera,
    quality,
    renderer,
    mascotsKind: mascots.kind,
    applied,
    routeProblems,
    doneFields: (botId) => doneFields(config, botId, worldFor(botId)),
    clock: clockNow,
    frames: () => frames,
  };

  if (params.get('tour') === '1') rig.startTour();

  if (capture) {
    // Every frame comes from here. The first call with dt 0 settles state without moving time.
    window.__step = (dt) => {
      window.__capture.advance(dt * 1000);
      frame(dt);
      return { frames, time };
    };
    window.__step(0);
    await document.fonts?.ready;
    window.__ready = true;
  } else {
    let last = performance.now();
    const loop = (nowValue) => {
      requestAnimationFrame(loop);
      const rawDt = Math.max(0, (nowValue - last) / 1000);
      last = nowValue;
      frame(rawDt);
    };
    requestAnimationFrame(loop);
    window.__ready = true;
  }
}

boot().catch((err) => {
  console.error(err);
  const title = err instanceof ConfigError ? err.title : 'Something stopped the island from loading';
  const details = err instanceof ConfigError ? err.details : [err.message];
  showFatal(uiRoot, title, details);
  window.__fatal = { title, details };
  window.__ready = true;
});
