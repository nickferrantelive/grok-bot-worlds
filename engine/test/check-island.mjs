// Checks one island against the contract in a real browser. For island builders.
//   node engine/test/check-island.mjs <name> [--sizes 3,4]
// Screenshots land in .work/engine/check/<name>/.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const name = process.argv[2];
if (!name) {
  console.error('Usage: node engine/test/check-island.mjs <island name> [--sizes 3,4]');
  process.exit(2);
}
const sizesArg = process.argv.indexOf('--sizes');
const SIZES = sizesArg > 0 ? process.argv[sizesArg + 1].split(',').map(Number) : [3, 4];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, '.work/engine/check', name);
mkdirSync(OUT, { recursive: true });

const { createServer } = await import('vite');
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
await server.listen();
const BASE = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'] });

let failures = 0;
let skipped = 0;
const tested = new Set();
const line = (ok, text) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
};

const TYPES = [['idle'], ['working'], ['found', 300], ['done'], ['needs_approval']];

for (const n of SIZES) {
  for (const [label, viewport, q] of [['desktop', { width: 1600, height: 900 }, 'desktop'], ['phone', { width: 390, height: 844 }, 'phone']]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const tag = `${n} bots, ${label}`;
    const t0 = Date.now();
    await page.goto(`${BASE}/?capture=1&island=${encodeURIComponent(name)}&config=example-${n}&source=replay&loop=0&pull=0&quality=${q}&capture_now=2026-03-16T15:00:00Z`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
    const fatal = await page.evaluate(() => window.__fatal ?? null);
    if (fatal && /is laid out for a team of/.test(fatal.title)) {
      console.log(`skip ${tag}: ${fatal.title}`);
      skipped += 1;
      await ctx.close();
      continue;
    }
    if (fatal) {
      line(false, `${tag}: ${fatal.title}: ${fatal.details.join('; ')}`);
      await ctx.close();
      continue;
    }
    tested.add(n);
    line(true, `${tag}: loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${await page.evaluate(() => window.__engine.mascotsKind)} mascots`);

    // Every event on every bot and the lead.
    const applyAll = await page.evaluate((types) => {
      const { island, config, camera, doneFields } = window.__engine;
      const problems = [];
      const fire = (bot, world) => {
        for (const [type, value] of types) {
          const evt = { bot_id: bot.id, type, text: `${type} line`, timestamp: new Date().toISOString(), ms: Date.now(), intensity: value ? 0.8 : 0.5, activity: type === 'working' || type === 'found' ? 'working' : 'idle', pending: type === 'needs_approval', catchup: false };
          if (value) evt.value = value;
          if (type === 'done') Object.assign(evt, doneFields(bot.id));
          try {
            island.applyEvent(evt, world);
            island.update(1 / 60, 1);
          } catch (err) {
            problems.push(`${type} on ${bot.id}: ${err.message}`);
          }
        }
        island.applyEvent({ bot_id: bot.id, type: 'done', text: 'x', timestamp: new Date().toISOString(), ms: Date.now(), intensity: 0.5, activity: 'idle', pending: false, catchup: true, ...doneFields(bot.id) }, world);
      };
      fire(config.lead, island.main);
      for (const bot of config.bots) fire(bot, island.worlds.get(bot.id));
      const list = [['main', island.main], ...island.worlds.entries()];
      const out = [];
      for (const [id, w] of list) {
        const a = w.anchor.isVector3 ? w.anchor.clone() : w.anchor.getWorldPosition(camera.position.clone());
        const p = a.project(camera);
        if (!(Math.abs(p.x) < 1 && Math.abs(p.y) < 1)) out.push(id);
      }
      const routeOut = [];
      let routePoints = 0;
      for (const [id, w] of island.worlds) {
        (Array.isArray(w.route) ? w.route : []).forEach((point, i) => {
          routePoints += 1;
          const p = point.clone().project(camera);
          if (!(Math.abs(p.x) < 1 && Math.abs(p.y) < 1)) routeOut.push(`${id}[${i}]`);
        });
      }
      return { problems, outOfFrame: out, routeOut, routePoints, total: list.length, routeProblems: window.__engine.routeProblems, plate: window.__engine.island?.cameraLimits?.plate === true };
    }, TYPES);
    line(applyAll.problems.length === 0, `${tag}: applyEvent and update take all five on every bot${applyAll.problems.length ? `: ${applyAll.problems[0]}` : ''}`);
    // A plate island is one landscape frame. An upright phone sees a crop of it that follows the working bot.
    const portraitPlate = applyAll.plate && q === 'phone';
    if (portraitPlate) console.log(`note ${tag}: portrait crop of a landscape plate, ${applyAll.outOfFrame.length} anchors outside it`);
    else line(applyAll.outOfFrame.length === 0, `${tag}: all ${applyAll.total} anchors in the default frame${applyAll.outOfFrame.length ? `, out: ${applyAll.outOfFrame.join()}` : ''}`);

    line(applyAll.routeProblems.length === 0, `${tag}: every bot has a sound route to the next station and the main building${applyAll.routeProblems.length ? `: ${applyAll.routeProblems.join('; ')}` : ''}`);
    if (applyAll.routePoints && !portraitPlate) line(applyAll.routeOut.length === 0, `${tag}: all ${applyAll.routePoints} route points are in the default frame${applyAll.routeOut.length ? `, out: ${applyAll.routeOut.join()}` : ''}`);

    // Focus poses against the limits.
    const focus = await page.evaluate(() => {
      const { island, rig } = window.__engine;
      const l = rig.limits;
      const bad = [];
      for (const [id, w] of [['main', island.main], ...island.worlds.entries()]) {
        const p = w.focus.position;
        const floor = (l.groundHeight ? l.groundHeight(p.x, p.z) : l.groundY) + l.clearance;
        if (p.y < floor) bad.push(`${id} under ground`);
        for (const c of l.colliders ?? []) if (p.distanceTo(c.center) < c.radius) bad.push(`${id} inside a collider`);
      }
      return { bad, hasLimits: !!(l.groundHeight || l.groundY !== undefined), colliders: (l.colliders ?? []).length };
    });
    line(focus.bad.length === 0, `${tag}: focus poses clear of ground and colliders (${focus.colliders} colliders)${focus.bad.length ? `: ${focus.bad.slice(0, 3).join(', ')}` : ''}`);
    if (!focus.colliders && !applyAll.plate) line(false, `${tag}: no colliders given, so the camera can enter buildings`);

    // A stretch of the scripted replay, and the real frame time of that work.
    const work = await page.evaluate(() => {
      for (let i = 0; i < 90; i += 1) {
        window.__step(1 / 15);
      }
      return { frames: window.__engine.frames(), calls: window.__engine.renderer.info.render.calls, tris: window.__engine.renderer.info.render.triangles };
    });
    line(errors.length === 0, `${tag}: no page errors${errors.length ? `: ${errors[0]}` : ''}`);
    await page.screenshot({ path: join(OUT, `${n}-${label}.jpg`), type: 'jpeg', quality: 88 });
    console.log(`     ${work.calls} draw calls, ${Math.round(work.tris / 1000)}k triangles`);
    await ctx.close();
  }
}

if (!tested.size) line(false, `no team size in ${SIZES.join()} fits this island`);

// The real frame rate, on the real clock, for the largest team it takes.
if (tested.size) {
  const n = Math.max(...tested);
  for (const q of ['desktop', 'phone']) {
    const ctx = await browser.newContext({ viewport: q === 'phone' ? { width: 390, height: 844 } : { width: 1600, height: 900 }, deviceScaleFactor: q === 'phone' ? 2 : 1 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?island=${encodeURIComponent(name)}&config=example-${n}&source=demo&quality=${q}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
    await page.waitForTimeout(6000);
    const fps = await page.evaluate(() => window.__fps ?? 0);
    console.log(`     real time on this Mac, ${n} bots, ${q} preset: ${fps.toFixed(0)} fps`);
    await ctx.close();
  }
}

await browser.close();
await server.close();
console.log(failures ? `\n${failures} problems. Screenshots in ${OUT}` : `\nNo problems found by this check. It does not judge the look. Screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
