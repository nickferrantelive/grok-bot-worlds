// End to end on the placeholder island, in a real browser. Runs all five events through each source mode.
//   node engine/test/e2e.mjs            on its own dev server, with no file watching, so edits elsewhere cannot reload a page mid test
//   E2E_BUILD=1 node engine/test/e2e.mjs   on a production build served statically
// Screenshots land in .work/engine/shots, to be looked at by a person.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const server = await startServer();
const BASE = server.url;
const SHOTS = join(ROOT, '.work/engine/shots/');
mkdirSync(SHOTS, { recursive: true });
const TYPES = ['idle', 'working', 'found', 'done', 'needs_approval'];
const DESKTOP = { width: 1600, height: 900 };
const PHONE = { width: 390, height: 844 };

async function startServer() {
  const { createServer, build, preview } = await import('vite');
  if (process.env.E2E_BUILD === '1') {
    process.env.ISLANDS_INCLUDE_PLACEHOLDER = '1';
    const outDir = '.work/engine/e2e-dist';
    await build({ root: ROOT, logLevel: 'error', build: { outDir } });
    const p = await preview({ root: ROOT, logLevel: 'error', build: { outDir }, preview: { port: 0, strictPort: false, host: '127.0.0.1' } });
    const a = p.httpServer.address();
    console.log('Testing the production build');
    return { url: `http://127.0.0.1:${a.port}`, close: () => p.httpServer.close() };
  }
  const s = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
  await s.listen();
  const a = s.httpServer.address();
  return { url: `http://127.0.0.1:${a.port}`, close: () => s.close() };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  [${detail}]` : ''}`);
}

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'] });

async function open(query, { viewport = DESKTOP, routes = {}, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: touch, isMobile: false });
  const page = await ctx.newPage();
  const errors = [];
  const writes = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.method() !== 'OPTIONS' && !r.url().startsWith('data:')) writes.push(`${r.method()} ${r.url()}`);
  });
  for (const [pattern, handler] of Object.entries(routes)) await page.route(pattern, handler);
  // Most checks here are about the corner panels, which are opt in. A query that names ui= decides for itself.
  await page.goto(`${BASE}/?${/(^|&)ui=/.test(query) ? query : `ui=1&${query}`}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000, polling: 100 });
  return { page, ctx, errors, writes, close: () => ctx.close() };
}

const step = (page, seconds, dt = 1 / 30) => page.evaluate(({ seconds, dt }) => {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i += 1) window.__step(dt);
}, { seconds, dt });
const appliedTypes = (page) => page.evaluate(() => [...new Set(window.__engine.applied.map((e) => e.type))]);
const text = (page, id) => page.locator(`[data-testid="${id}"]`).innerText();
const visible = (page, id) => page.locator(`[data-testid="${id}"]`).isVisible();
const taskCount = (page) => page.evaluate(() => [...document.querySelectorAll('.gi-label-task')].filter((n) => !n.hidden).length);

// --- Replay: every event, from the bundled example file, at the file's own speed.
{
  const { page, errors, writes, close } = await open('capture=1&island=_placeholder&config=example-4&source=replay&replay=examples/replay.example.json&loop=0');
  check('replay: loads with no fatal', !(await page.evaluate(() => window.__fatal)));
  check('replay: status says replay 6x', (await text(page, 'status')).includes('replay 6x'), await text(page, 'status'));

  let maxTasks = 0;
  const shot = {};
  for (let s = 0; s < 40; s += 1) {
    await step(page, 0.5);
    maxTasks = Math.max(maxTasks, await taskCount(page));
    const state = await page.evaluate(() => window.__engine.island.debugState());
    const anyBeam = Object.values(state).some((w) => w.beam);
    const anyRipple = Object.values(state).some((w) => w.ripple);
    const anyBeacon = Object.values(state).some((w) => w.beacon);
    const anyWorking = Object.values(state).some((w) => w.activity === 'working');
    if (anyBeam && !shot.found) shot.found = await page.screenshot({ path: `${SHOTS}replay-found.jpg`, quality: 88, type: 'jpeg' });
    if (anyRipple && !shot.done) shot.done = await page.screenshot({ path: `${SHOTS}replay-done.jpg`, quality: 88, type: 'jpeg' });
    if (anyBeacon && !shot.needs_approval) shot.needs_approval = await page.screenshot({ path: `${SHOTS}replay-needs-approval.jpg`, quality: 88, type: 'jpeg' });
    if (anyWorking && !shot.working) shot.working = await page.screenshot({ path: `${SHOTS}replay-working.jpg`, quality: 88, type: 'jpeg' });
  }
  const types = await appliedTypes(page);
  for (const t of TYPES) check(`replay: ${t} reached the island`, types.includes(t));
  check('replay: found, done, approval and working were each visible in a frame', shot.found && shot.done && shot.needs_approval && shot.working);
  check('replay: at most three task lines at once', maxTasks <= 3 && maxTasks > 0, `max ${maxTasks}`);
  const c = await text(page, 'counts');
  check('replay: counts moved', /[1-9]\d* *\n?found/i.test(c) || /[1-9]/.test(c), c.replace(/\n/g, ' '));

  const applied = await page.evaluate(() => window.__engine.applied);
  const seenFound = await page.evaluate(() => {
    const all = window.__engine.applied.filter((e) => e.type === 'found');
    return all.length;
  });
  check('replay: found events applied', seenFound >= 3, `${seenFound}`);
  check('replay: page made no write request', writes.length === 0, writes.join());
  check('replay: no page errors', errors.length === 0, errors.join());
  await close();
}

// --- Replay at the top speed still plays everything, once and in order.
{
  const { page, close } = await open('capture=1&island=_placeholder&config=example-4&source=replay&speed=20&loop=0');
  check('replay 20x: status', (await text(page, 'status')).includes('replay 20x'));
  await step(page, 8);
  const types = await appliedTypes(page);
  check('replay 20x: all five in 8 s', TYPES.every((t) => types.includes(t)), types.join());
  await step(page, 5);
  const n = await page.evaluate(() => window.__engine.applied.length);
  // The script has progress lines now. Compare with the script itself rather than a number that goes stale.
  const wanted = await page.evaluate(async () => {
    const { buildDayScript } = await import('/engine/sources/demo.js');
    return buildDayScript(window.__engine.config, 120).filter((r) => r.at <= 120).length;
  });
  check('replay 20x: nothing dropped or repeated', n === wanted, `${n} events, script has ${wanted}`);
  await close();
  const slow = await open('capture=1&island=_placeholder&config=example-4&source=replay&speed=1&loop=0');
  await step(slow.page, 8);
  const nSlow = await slow.page.evaluate(() => window.__engine.applied.length);
  check('replay 1x: only the first events after 8 s', nSlow >= 1 && nSlow < n / 4, `${nSlow} events, ${n} at 20x`);
  await slow.close();
}

// --- Value scales the found effect.
{
  const rows = { speed: 1, lead_in: 0, events: [
    { id: 1, bot_id: 'research', type: 'found', text: 'small', value: 2, timestamp: '2026-03-16T15:00:00Z' },
    { id: 2, bot_id: 'inbox', type: 'found', text: 'big', value: 900, timestamp: '2026-03-16T15:00:00Z' },
    { id: 3, bot_id: 'writer', type: 'found', text: 'no value', timestamp: '2026-03-16T15:00:00Z' },
  ] };
  const { page, close } = await open('capture=1&island=_placeholder&config=example-4&source=replay&replay=/x/rows.json&loop=0', {
    routes: { '**/x/rows.json': (r) => r.fulfill({ json: rows }) },
  });
  await step(page, 0.3);
  const s = await page.evaluate(() => window.__engine.island.debugState());
  check('found: value scales the effect', s.inbox.beamPower > s.writer.beamPower && s.writer.beamPower > s.research.beamPower, `${s.research.beamPower.toFixed(2)} < ${s.writer.beamPower.toFixed(2)} < ${s.inbox.beamPower.toFixed(2)}`);
  await close();
}

// --- Demo: every event from the built-in day, for both team sizes.
for (const n of [3, 4]) {
  const { page, errors, writes, close } = await open(`capture=1&island=_placeholder&config=example-${n}&source=demo`);
  check(`demo ${n}: status says demo`, (await text(page, 'status')).includes('demo'));
  await step(page, 100);
  const types = await appliedTypes(page);
  check(`demo ${n}: all five events in 100 s`, TYPES.every((t) => types.includes(t)), types.join());
  const fired = await page.evaluate(() => {
    const bots = new Set(window.__engine.applied.map((e) => e.bot_id));
    return { bots: bots.size, want: window.__engine.config.bots.length + 1, rejected: window.__engine.store.rejected };
  });
  check(`demo ${n}: all bots and the lead took part, or all within the log window`, fired.bots >= Math.min(fired.want, 3), `${fired.bots}/${fired.want}`);
  check(`demo ${n}: no rejected rows`, fired.rejected === 0);
  check(`demo ${n}: no write requests, no errors`, writes.length === 0 && errors.length === 0, [...writes, ...errors].join());
  await page.screenshot({ path: `${SHOTS}demo-${n}.jpg`, quality: 88, type: 'jpeg' });
  await close();
}

// --- Live: a feed that changes, through all five events, then failure and recovery.
{
  let rows = [{ id: 1, bot_id: 'research', type: 'needs_approval', text: 'old ask from before the page opened', timestamp: '2026-03-16T14:30:00Z' }];
  let mode = 'ok';
  const methods = [];
  const headers = [];
  const { page, errors, writes, close } = await open('capture=1&capture_now=2026-03-16T15:00:00Z&island=_placeholder&config=example-4&source=live&live=https://fake-project.supabase.co/rest/v1/events&anon_key=sb_publishable_test', {
    routes: {
      'https://fake-project.supabase.co/**': (route) => {
        const req = route.request();
        methods.push(req.method());
        headers.push(req.headers());
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (mode === 'fail') return route.fulfill({ status: 503, headers: cors, body: 'down' });
        if (mode === 'abort') return route.abort();
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(rows) });
      },
    },
  });
  const tick = async (seconds = 3.1) => {
    await page.evaluate((s) => window.__step(s), seconds);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__step(1 / 60));
  };
  await tick(0.1);
  check('live: connects and says live', (await text(page, 'status')).includes('live'), await text(page, 'status'));
  check('live: an old approval shows on load, with no effect fired', await visible(page, 'marker'));
  const first = await page.evaluate(() => window.__engine.applied[0]);
  check('live: first batch is catch-up', first?.catchup === true);

  const nowIso = () => page.evaluate(() => new Date().toISOString());
  const add = async (row) => {
    rows = [...rows, { id: rows.length + 1, ...row, timestamp: await nowIso() }];
    await tick();
  };
  await add({ bot_id: 'inbox', type: 'working', text: 'sorting the inbox' });
  let s = await page.evaluate(() => window.__engine.island.debugState());
  check('live: working', s.inbox.activity === 'working');
  check('live: working shows a task line', (await page.locator('[data-testid="label-inbox"] .gi-label-task').innerText()).includes('sorting'));
  await add({ bot_id: 'inbox', type: 'found', text: '12 messages need an answer', value: 12 });
  s = await page.evaluate(() => window.__engine.island.debugState());
  check('live: found fires', s.inbox.beam && s.inbox.found === 1);
  await add({ bot_id: 'inbox', type: 'needs_approval', text: 'a draft reply is ready to send' });
  s = await page.evaluate(() => window.__engine.island.debugState());
  check('live: needs_approval lights the beacon', s.inbox.pending && s.inbox.beacon);
  check('live: corner counter shows 2', (await text(page, 'approvals')).includes('2'), await text(page, 'approvals'));
  check('live: marker shows the newest ask', (await text(page, 'marker')).includes('draft reply'), await text(page, 'marker'));
  await add({ bot_id: 'inbox', type: 'working', text: 'working on something else' });
  s = await page.evaluate(() => window.__engine.island.debugState());
  check('live: approval survives a later working', s.inbox.pending && s.inbox.beacon);
  await add({ bot_id: 'writer', type: 'done', text: 'a different bot finished' });
  s = await page.evaluate(() => window.__engine.island.debugState());
  check('live: a done from another bot does not clear it', s.inbox.pending);
  await add({ bot_id: 'inbox', type: 'done', text: 'reply sent' });
  s = await page.evaluate(() => window.__engine.island.debugState());
  check('live: its own done clears it', !s.inbox.pending && !s.inbox.beacon && s.inbox.done === 1);
  check('live: counter drops to 1', (await text(page, 'approvals')).includes('1'));
  await add({ bot_id: 'inbox', type: 'idle', text: 'waiting' });
  s = await page.evaluate(() => window.__engine.island.debugState());
  check('live: idle', s.inbox.activity === 'idle');
  await add({ bot_id: 'research', type: 'done', text: 'old ask answered' });
  check('live: marker and counter clear when nothing waits', !(await visible(page, 'marker')) && !(await visible(page, 'approvals')));

  await add({ bot_id: 'research', type: 'done', text: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>' });
  await page.waitForTimeout(100);
  check('live: text is inert, markup does nothing', !(await page.evaluate(() => window.__pwned)) && (await page.locator('#gi-ui img, #gi-ui script').count()) === 0);
  check('live: the markup shows as plain text', (await text(page, 'feed')).includes('<img'));

  await add({ bot_id: 'nobody', type: 'done', text: 'unknown bot' });
  check('live: an unknown bot is reported, not fatal', (await text(page, 'status-detail')).includes('nobody'), await text(page, 'status-detail'));

  mode = 'fail';
  await tick();
  check('live: failure shows in the status', (await text(page, 'status')).includes('offline') && (await text(page, 'status-detail')).includes('HTTP 503'), await text(page, 'status-detail'));
  await page.screenshot({ path: `${SHOTS}live-offline.jpg`, quality: 88, type: 'jpeg' });
  const b1 = await page.evaluate(() => window.__engine.source.backoffSeconds);
  await tick(b1 + 0.1);
  const b2 = await page.evaluate(() => window.__engine.source.backoffSeconds);
  check('live: backs off', b2 === b1 * 2, `${b1} then ${b2}`);
  mode = 'abort';
  await tick(b2 + 0.1);
  check('live: a dead network is also shown', (await text(page, 'status-detail')).includes('cannot reach'), await text(page, 'status-detail'));
  mode = 'ok';
  await tick(61);
  check('live: recovers on its own', (await text(page, 'status')).includes('live') && (await page.evaluate(() => window.__engine.source.backoffSeconds)) === 3);
  check('live: every request was a GET', methods.every((m) => m === 'GET' || m === 'OPTIONS') && writes.length === 0, [...new Set(methods)].join());
  check('live: sends the anon key as apikey only', headers.some((h) => h.apikey === 'sb_publishable_test') && !headers.some((h) => h.authorization));
  check('live: no page errors', errors.length === 0, errors.join());
  await close();
}

// --- Live on the real clock: the plain JSON shape, polled in real time.
{
  const seen = [];
  const { page, close } = await open('island=_placeholder&config=example-3&source=live&live=/x/feed.json&quality=desktop', {
    routes: { '**/x/feed.json': (route) => { seen.push(Date.now()); return route.fulfill({ json: { events: [] } }); } },
  });
  await page.waitForTimeout(7000);
  const gaps = seen.slice(1).map((t, i) => t - seen[i]);
  check('live real clock: polls about every 3 s', seen.length >= 3 && gaps.every((g) => g > 2500 && g < 3800), gaps.join(','));
  const fps = await page.evaluate(() => window.__fps);
  check('frame rate is measured', fps > 0, `${fps?.toFixed(1)} fps`);
  await close();
}

// --- Config and island errors say what is wrong.
{
  const bad = { workspace: 'x', island: '_placeholder', timezone: 'Nope/Nope', bots: [{ id: 'a', color: 'blue' }, { id: 'a' }] };
  const cases = [
    ['bad values', 'config=/x/bad.json&z=1', ['time zone', 'hex colour', 'more than one bot'], { '**/x/bad.json': (r) => r.fulfill({ json: bad }) }],
    ['missing file', 'config=/x/missing.json&z=1', ['HTTP 404'], { '**/x/missing.json': (r) => r.fulfill({ status: 404, body: '' }) }],
    ['not JSON', 'config=/x/notjson.json&z=1', ['not valid JSON'], { '**/x/notjson.json': (r) => r.fulfill({ body: '{oops' }) }],
    ['unknown bundled', 'config=example-99', ['no bundled config'], {}],
    ['unknown island', 'island=atlantis&config=example-3', ['no island called'], {}],
    ['path in island name', 'island=..%2F..%2Fengine&config=example-3', ['not a valid island name'], {}],
    ['bad source', 'island=_placeholder&config=example-3&source=magic', ['Unknown source'], {}],
    ['secret key in the address', 'island=_placeholder&config=example-3&source=live&live=https://a.supabase.co/rest/v1/events&anon_key=sb_secret_abcdef', ['Refusing'], {}],
    ['live with no url', 'island=_placeholder&config=example-3&source=live', ['needs a URL'], {}],
  ];
  for (const [name, query, wants, routes] of cases) {
    const { page, close } = await open(query, { routes });
    const onScreen = await page.locator('[data-testid="fatal"]').innerText().catch(() => '');
    check(`error: ${name}`, wants.every((w) => onScreen.includes(w)), onScreen.replace(/\n/g, ' ').slice(0, 120));
    if (name === 'bad values') await page.screenshot({ path: `${SHOTS}error-card.jpg`, quality: 88, type: 'jpeg' });
    await close();
  }
  const manyTz = { island: '_placeholder', timezone: 'Asia/Tokyo', workspace: 'Tokyo team', bots: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] };
  const { page, close } = await open('capture=1&config=/x/ok.json&source=replay&loop=0', { routes: { '**/x/ok.json': (r) => r.fulfill({ json: manyTz }) } });
  const info = await page.evaluate(() => ({ w: window.__engine.config.workspace, n: window.__engine.island.worlds.size, island: window.__engine.islandName }));
  check('config: any team, island from the file', info.w === 'Tokyo team' && info.n === 3 && info.island === '_placeholder', JSON.stringify(info));
  await close();
}

// --- The config file a bot writes, next to the page.
{
  const team = { workspace: 'Written by a bot', island: '_placeholder', timezone: 'Europe/London', bots: [{ id: 'x', color: '#123456' }, { id: 'y', color: '#abcdef' }, { id: 'z' }] };
  const { page, close } = await open('capture=1&source=replay&loop=0', { routes: { '**/config.json': (r) => r.fulfill({ json: team }) } });
  const info = await page.evaluate(() => ({ w: window.__engine.config.workspace, n: window.__engine.island.worlds.size, src: window.__engine.source.mode }));
  check('config: config.json next to the page is picked up', info.w === 'Written by a bot' && info.n === 3, JSON.stringify(info));
  await close();
  const warned = await open('capture=0&island=_placeholder&quality=desktop', { routes: { '**/config.json': (r) => r.fulfill({ json: { ...team, mystery: 1 } }) } });
  await warned.page.waitForTimeout(400);
  check('config: an unknown field shows a short notice, and the island still runs', (await text(warned.page, 'toast')).includes('mystery') && (await warned.page.evaluate(() => window.__engine.frames() > 0)));
  await warned.close();
}

// --- A phone by its user agent gets the phone preset with no override.
{
  const ctx = await browser.newContext({ viewport: PHONE, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', deviceScaleFactor: 3, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?ui=1&island=_placeholder&config=example-4`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000, polling: 100 });
  const q = await page.evaluate(() => window.__engine.quality);
  check('quality: auto pick gives a phone the phone preset, pixel ratio capped', q.name === 'phone' && !q.shadows && !q.post && q.pixelRatio === 1.5, JSON.stringify(q));
  await ctx.close();
}

// --- UI: feed tap, phone layout, nothing overlapping or overflowing.
for (const [name, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
  const quality = name === 'phone' ? '&quality=phone' : '';
  const { page, close } = await open(`capture=1&island=_placeholder&config=example-4&source=replay&loop=0${quality}`, { viewport });
  await step(page, 8.2);
  const feedRows = () => page.locator('[data-testid="feed"] .gi-feed-row').count();
  check(`${name}: feed shows 3`, (await feedRows()) === 3);
  await page.locator('[data-testid="feed"]').click();
  check(`${name}: tap expands to 6`, (await feedRows()) === 6 && (await page.locator('[data-testid="feed"]').getAttribute('aria-expanded')) === 'true');
  await step(page, 0.1);
  await page.screenshot({ path: `${SHOTS}${name}-feed-open.jpg`, quality: 88, type: 'jpeg' });
  await page.locator('[data-testid="feed"]').click();
  check(`${name}: tap again collapses`, (await feedRows()) === 3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth);
  check(`${name}: no sideways overflow`, !overflow);
  const boxes = await page.evaluate(() => {
    const out = {};
    for (const id of ['feed', 'counts', 'cinematic', 'status']) {
      const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
      out[id] = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    }
    return out;
  });
  const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const names = Object.keys(boxes);
  const clashes = [];
  names.forEach((a, i) => names.slice(i + 1).forEach((b) => { if (hit(boxes[a], boxes[b])) clashes.push(`${a}/${b}`); }));
  check(`${name}: corner UI does not overlap`, clashes.length === 0, clashes.join());
  const inside = Object.values(boxes).every((b) => b.l >= 0 && b.t >= 0 && b.r <= viewport.width && b.b <= viewport.height);
  check(`${name}: corner UI is on screen`, inside, JSON.stringify(boxes));
  await close();
}

// --- Every event on the placeholder, at both widths, for a person to read.
for (const [name, viewport, q] of [['desktop', DESKTOP, ''], ['phone', PHONE, '&quality=phone']]) {
  const events = (type, extra = {}) => ({ id: type, bot_id: 'research', type, text: `${type} line`, timestamp: '2026-03-16T15:00:00Z', ...extra });
  for (const type of TYPES) {
    const rows = { speed: 1, lead_in: 0.1, loop: false, events: [events(type, type === 'found' ? { value: 300 } : {})] };
    const { page, close } = await open(`capture=1&pull=0&island=_placeholder&config=example-4&source=replay&replay=/x/one.json&loop=0&daylight=0.45${q}`, {
      viewport,
      routes: { '**/x/one.json': (r) => r.fulfill({ json: rows }) },
    });
    await step(page, 1.4);
    await page.screenshot({ path: `${SHOTS}event-${name}-${type}.jpg`, quality: 88, type: 'jpeg' });
    const q2 = await page.evaluate(() => window.__engine.quality);
    if (type === 'idle') {
      check(`${name}: quality preset`, name === 'phone' ? q2.name === 'phone' && !q2.shadows && !q2.post : q2.name === 'desktop' && q2.shadows && q2.post, JSON.stringify(q2));
      check(`${name}: renderer shadows match`, (await page.evaluate(() => window.__engine.renderer.shadowMap.enabled)) === q2.shadows);
    }
    await close();
  }
}

// --- Framing: every anchor and route point is in frame, for teams of 3 and 4, at both widths.
for (const n of [3, 4]) {
  for (const [name, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    const { page, close } = await open(`capture=1&pull=0&island=_placeholder&config=example-${n}&source=replay&loop=0`, { viewport });
    await step(page, 0.2);
    const out = await page.evaluate(() => {
      const { island, camera } = window.__engine;
      const list = [island.main, ...island.worlds.values()];
      let inside = 0;
      for (const w of list) {
        const v = w.anchor.getWorldPosition(camera.position.clone()).project(camera);
        if (Math.abs(v.x) < 1 && Math.abs(v.y) < 1) inside += 1;
      }
      const routeOut = [...island.worlds.values()].flatMap((w) => w.route).filter((point) => {
        const v = point.clone().project(camera);
        return !(Math.abs(v.x) < 1 && Math.abs(v.y) < 1);
      }).length;
      return { inside, total: list.length, routeOut };
    });
    check(`framing ${n} on ${name}: all in frame`, out.inside === out.total, `${out.inside}/${out.total}`);
    check(`framing ${n} on ${name}: the whole route is in frame`, out.routeOut === 0, `${out.routeOut} out`);
    await page.screenshot({ path: `${SHOTS}frame-${n}-${name}.jpg`, quality: 88, type: 'jpeg' });
    await close();
  }
}

// --- Camera: drag, zoom, pinch, click, tour, the pull, the clamp.
{
  const { page, errors, close } = await open('capture=1&island=_placeholder&config=example-4&source=replay&replay=examples/replay.example.json');
  const limitCheck = () => page.evaluate(() => {
    const { camera, rig } = window.__engine;
    const l = rig.limits;
    const p = camera.position;
    const floor = (l.groundHeight ? l.groundHeight(p.x, p.z) : l.groundY) + l.clearance;
    let inside = false;
    for (const c of l.colliders ?? []) if (p.distanceTo(c.center) < c.radius - 1e-3) inside = true;
    return { above: p.y >= floor - 1e-6, inside, y: p.y };
  });
  const before = await page.evaluate(() => window.__engine.camera.position.toArray());
  await page.mouse.move(800, 450);
  await page.mouse.down();
  await page.mouse.move(1100, 500, { steps: 8 });
  await page.mouse.up();
  await step(page, 1);
  const after = await page.evaluate(() => window.__engine.camera.position.toArray());
  check('camera: drag orbits', Math.hypot(after[0] - before[0], after[2] - before[2]) > 1, `${after[0].toFixed(1)}`);
  const d0 = await page.evaluate(() => window.__engine.camera.position.length());
  await page.mouse.wheel(0, -480);
  await step(page, 1);
  const d1 = await page.evaluate(() => window.__engine.camera.position.length());
  check('camera: scroll zooms', d1 < d0, `${d0.toFixed(1)} to ${d1.toFixed(1)}`);

  // Abuse it: hard down drags and zooms in every direction, checking every step.
  let worst = { below: 0, inside: 0, samples: 0 };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 40; i += 1) {
    await page.mouse.move(400 + rnd() * 800, 200 + rnd() * 500);
    await page.mouse.down();
    await page.mouse.move(400 + rnd() * 800, 200 + rnd() * 600, { steps: 3 });
    await page.mouse.up();
    await page.mouse.wheel(0, rnd() < 0.7 ? -600 : 500);
    await step(page, 0.4, 1 / 15);
    const r = await limitCheck();
    worst.samples += 1;
    if (!r.above) worst.below += 1;
    if (r.inside) worst.inside += 1;
  }
  check('camera clamp: 40 rounds of abuse, never under ground', worst.below === 0, JSON.stringify(worst));
  check('camera clamp: 40 rounds of abuse, never inside a collider', worst.inside === 0, JSON.stringify(worst));

  await page.locator('[data-testid="overview"]').click();
  await step(page, 4);
  check('camera: overview goes home', await page.evaluate(() => window.__engine.rig.mode === 'home'));

  const world = await page.evaluate(() => {
    const { island, camera } = window.__engine;
    const w = island.worlds.get('inbox');
    const v = w.anchor.getWorldPosition(camera.position.clone()).project(camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight, target: w.focus.target.toArray() };
  });
  await page.mouse.click(world.x, world.y + 18);
  check('camera: click starts a flight', (await page.evaluate(() => window.__engine.rig.mode)) === 'flight');
  await step(page, 4);
  const end = await page.evaluate(() => {
    const { camera, island } = window.__engine;
    const w = island.worlds.get('inbox');
    return { d: camera.position.distanceTo(w.focus.position) };
  });
  check('camera: arrives at the world', end.d < 0.6, end.d.toFixed(2));

  await page.locator('[data-testid="cinematic"]').click();
  check('camera: cinematic starts', (await page.evaluate(() => window.__engine.rig.mode)) === 'tour');
  await step(page, 0.05);
  check('camera: button flips to stop', (await text(page, 'cinematic')) === 'stop');
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    await step(page, 6, 1 / 20);
    samples.push(await page.evaluate(() => window.__engine.camera.position.toArray()));
    const r = await limitCheck();
    if (!r.above || r.inside) worst.below += 1;
  }
  const spread = new Set(samples.map((s) => s.map((x) => Math.round(x)).join())).size;
  check('camera: the tour moves between worlds, inside the limits', spread >= 4 && worst.below === 0, `${spread} places`);
  await page.locator('[data-testid="cinematic"]').click();
  check('camera: stop ends it', (await page.evaluate(() => window.__engine.rig.mode)) === 'home');
  check('camera: no page errors', errors.length === 0, errors.join());
  await close();
}

// --- The pull: goes to the event when nobody is touching it, stays put while they are.
{
  const rows = { speed: 1, lead_in: 8, loop: false, events: [{ id: 1, bot_id: 'inbox', type: 'found', text: 'x', value: 5, timestamp: '2026-03-16T15:00:00Z' }] };
  const route = { '**/x/p.json': (r) => r.fulfill({ json: rows }) };
  const a = await open('capture=1&island=_placeholder&config=example-4&source=replay&replay=/x/p.json&loop=0', { routes: route });
  await step(a.page, 7.5);
  check('pull: rests at home before the event', (await a.page.evaluate(() => window.__engine.rig.mode)) === 'home');
  await step(a.page, 3);
  const mode = await a.page.evaluate(() => {
    const { rig, camera, island } = window.__engine;
    return { mode: rig.mode, dist: camera.position.distanceTo(island.worlds.get('inbox').anchor.getWorldPosition(camera.position.clone())), length: camera.position.length() };
  });
  check('pull: moves to the world with the event', mode.mode === 'pull', JSON.stringify(mode));
  await a.page.screenshot({ path: `${SHOTS}pull.jpg`, quality: 88, type: 'jpeg' });
  await step(a.page, 12);
  check('pull: comes back home after', (await a.page.evaluate(() => window.__engine.rig.mode)) === 'home');
  await a.close();

  const b = await open('capture=1&island=_placeholder&config=example-4&source=replay&replay=/x/p.json&loop=0', { routes: route });
  await step(b.page, 7);
  await b.page.mouse.move(800, 450);
  await b.page.mouse.down();
  await b.page.mouse.move(900, 450, { steps: 4 });
  await b.page.mouse.up();
  await step(b.page, 3);
  check('pull: holds off while the person is using the camera', (await b.page.evaluate(() => window.__engine.rig.mode)) === 'free');
  await b.close();
}

// --- Touch pinch, on the phone preset.
{
  const { page, ctx, close } = await open('capture=1&quality=phone&island=_placeholder&config=example-4&source=replay&loop=0', { viewport: PHONE, touch: true });
  const cdp = await ctx.newCDPSession(page);
  const d0 = await page.evaluate(() => window.__engine.rig.mode);
  const pinch = async (spread0, spread1) => {
    const pts = (s) => [{ x: 195 - s, y: 420 }, { x: 195 + s, y: 420 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(spread0) });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(spread0 + ((spread1 - spread0) * i) / 6) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const before = await page.evaluate(() => { const { camera, island } = window.__engine; return camera.position.distanceTo(island.main.focus.target); });
  await pinch(40, 160);
  await step(page, 1);
  const after = await page.evaluate(() => { const { camera, island } = window.__engine; return camera.position.distanceTo(island.main.focus.target); });
  check('touch: pinch zooms in', after < before - 1, `${before.toFixed(1)} to ${after.toFixed(1)} from ${d0}`);
  await close();
}

// --- Daylight comes from the config time zone and the source clock.
{
  // Daylight moves once the clock has moved a minute, so this runs fast enough to see a move.
  const { page, close } = await open('capture=1&island=_placeholder&config=example-4&source=replay&speed=20&loop=0');
  const hook = await page.evaluate(() => {
    const { island } = window.__engine;
    const calls = [];
    const real = island.setDaylight.bind(island);
    island.setDaylight = (t) => { calls.push(t); real(t); };
    window.__day = calls;
    return true;
  });
  await step(page, 25, 1 / 10);
  const calls = await page.evaluate(() => window.__day);
  // The script starts 15:00 UTC, which is 11:00 in New York on that date (daylight saving is on, 16 March).
  const noonish = (11 + 1 / 60) / 24;
  check('daylight: follows the replay clock in the config time zone', hook && calls.length > 0 && Math.abs(calls[0] - noonish) < 0.02, `first ${calls[0]?.toFixed(4)}, wanted about ${noonish.toFixed(4)}, ${calls.length} calls`);
  await close();
  const pinned = await open('capture=1&island=_placeholder&config=example-4&source=replay&loop=0&daylight=0.8');
  await pinned.page.evaluate(() => {
    const { island } = window.__engine;
    window.__calls = [];
    const real = island.setDaylight.bind(island);
    island.setDaylight = (t) => { window.__calls.push(t); real(t); };
  });
  await step(pinned.page, 5, 1 / 10);
  check('daylight: can be pinned', (await pinned.page.evaluate(() => window.__calls.length)) === 0);
  await pinned.close();
}

// --- Determinism: two fresh loads, same steps, same pixels.
{
  const hashes = [];
  for (let i = 0; i < 2; i += 1) {
    const { page, close } = await open('capture=1&island=_placeholder&config=example-4&source=replay&loop=0');
    await step(page, 6, 1 / 60);
    const shot = await page.screenshot({ type: 'png' });
    hashes.push(createHash('md5').update(shot).digest('hex'));
    await close();
  }
  check('determinism: two runs, frame 360 is pixel identical', hashes[0] === hashes[1], hashes.join(' '));
}

// --- Mascots: the real set when it is there, and the fallback with the same calls.
{
  const real = await open('capture=1&island=_placeholder&config=example-4&source=replay&loop=0');
  const kind = await real.page.evaluate(() => window.__engine.mascotsKind);
  await step(real.page, 20, 1 / 15);
  check('mascots: runs all events with whichever set loaded, no errors', real.errors.length === 0, `${kind}: ${real.errors.join()}`);
  await real.close();
  const fb = await open('capture=1&mascots=fallback&island=_placeholder&config=example-4&source=replay&loop=0');
  check('mascots: fallback can be forced', (await fb.page.evaluate(() => window.__engine.mascotsKind)) === 'fallback');
  await step(fb.page, 20, 1 / 15);
  check('mascots: fallback runs all events, no errors', fb.errors.length === 0, fb.errors.join());
  await fb.page.screenshot({ path: `${SHOTS}fallback.jpg`, quality: 88, type: 'jpeg' });
  await fb.close();
}

// --- Debug keys: local only, for testing an island by hand.
{
  const { page, writes, close } = await open('capture=1&debug=1&island=_placeholder&config=example-4&source=replay&replay=examples/replay.example.json&loop=0');
  await page.keyboard.press('Tab');
  await page.keyboard.press('3');
  const s = await page.evaluate(() => window.__engine.island.debugState());
  check('debug keys: 3 fires found on the second bot, with no request', s.writer.found === 1 && writes.length === 0);
  await step(page, 0.1);
  check('debug: shows the frame counter box', (await text(page, 'debug')).includes('placeholder'));
  await close();
}

// --- Labels: never on the corner UI, and fewer names on a narrow screen.
{
  const { page, close } = await open('capture=1&quality=phone&pull=0&island=_placeholder&config=example-4&source=replay&loop=0', { viewport: PHONE });
  await step(page, 3);
  const out = await page.evaluate(() => {
    const seen = [...document.querySelectorAll('.gi-label')].filter((n) => Number(n.style.opacity) > 0.3);
    const panels = [...document.querySelectorAll('.gi-corner > *')].filter((n) => !n.hidden && n.getBoundingClientRect().width > 0).map((n) => n.getBoundingClientRect());
    let clashes = 0;
    for (const l of seen) {
      const a = l.getBoundingClientRect();
      for (const b of panels) if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) clashes += 1;
    }
    return { shown: seen.length, clashes };
  });
  check('phone, team of 4: names show', out.shown >= 1 && out.shown <= 4, `${out.shown} shown`);
  check('phone, team of 4: labels stay off the corner UI', out.clashes === 0, `${out.clashes}`);
  await close();
}

// --- Through a whole replay with the camera moving: bubbles never hang off the screen or sit on each other.
for (const [name, viewport, q, cap] of [['desktop', DESKTOP, 'desktop', 4], ['phone', PHONE, 'phone', 4]]) {
  const { page, close } = await open(`capture=1&island=_placeholder&config=example-4&source=replay&loop=0&quality=${q}`, { viewport });
  let cut = 0;
  let maxTasks = 0;
  let stacked = 0;
  for (let i = 0; i < 40; i += 1) {
    await step(page, 0.5);
    const r = await page.evaluate(() => {
      const seen = [...document.querySelectorAll('.gi-label')].filter((n) => Number(n.style.opacity) > 0.5);
      let out = 0;
      for (const n of seen) {
        const a = n.getBoundingClientRect();
        if (a.left < 0 || a.right > innerWidth || a.top < 0 || a.bottom > innerHeight) out += 1;
      }
      const boxes = seen.map((n) => n.getBoundingClientRect());
      let over = 0;
      boxes.forEach((a, k) => boxes.slice(k + 1).forEach((b) => {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 4 && h > 4) over += 1;
      }));
      return { out, over, tasks: [...document.querySelectorAll('.gi-label-task')].filter((n) => !n.hidden).length };
    });
    cut += r.out;
    maxTasks = Math.max(maxTasks, r.tasks);
    stacked += r.over;
  }
  check(`${name}: no label hangs off the screen in 20 s of replay`, cut === 0, `${cut}`);
  check(`${name}: bubbles do not sit on each other in 20 s of replay`, stacked === 0, `${stacked}`);
  check(`${name}: task lines stay at ${cap} or fewer`, maxTasks <= cap && maxTasks > 0, `max ${maxTasks}`);
  await close();
}

// --- The marker stays clear of the corner UI, on a short phone screen too.
for (const viewport of [PHONE, { width: 390, height: 664 }, { width: 360, height: 640 }, DESKTOP]) {
  const rows = { speed: 1, lead_in: 0.1, loop: false, events: [
    { id: 1, bot_id: 'research', type: 'needs_approval', text: 'a much longer approval line that has to be cut off somewhere on a small screen', timestamp: '2026-03-16T15:00:00Z' },
    { id: 2, bot_id: 'inbox', type: 'found', text: 'x', value: 3, timestamp: '2026-03-16T15:00:00Z' },
  ] };
  const { page, close } = await open(`capture=1&island=_placeholder&config=example-4&source=replay&replay=/x/m.json&loop=0&quality=${viewport.width < 500 ? 'phone' : 'desktop'}`, { viewport, routes: { '**/x/m.json': (r) => r.fulfill({ json: rows }) } });
  // In the home frame, and again after the pull moves the main building away.
  for (const seconds of [0.6, 4]) {
    await step(page, seconds);
    const out = await page.evaluate(() => {
      const m = document.querySelector('[data-testid="marker"]').getBoundingClientRect();
      const panels = [...document.querySelectorAll('.gi-corner > *')].filter((n) => !n.hidden && n.getBoundingClientRect().width > 0).map((n) => n.getBoundingClientRect());
      const hits = panels.filter((b) => m.left < b.right && m.right > b.left && m.top < b.bottom && m.bottom > b.top).length;
      const onScreen = m.left >= 0 && m.right <= innerWidth && m.top >= 0 && m.bottom <= innerHeight;
      const labels = [...document.querySelectorAll('.gi-label')].filter((n) => Number(n.style.opacity) > 0.5).filter((n) => {
        const a = n.getBoundingClientRect();
        return a.left < m.right && a.right > m.left && a.top < m.bottom && a.bottom > m.top;
      }).length;
      return { hits, onScreen, labels, h: Math.round(m.height) };
    });
    check(`marker at ${viewport.width}x${viewport.height}, ${seconds} s: on screen, clear of panels and labels`, out.hits === 0 && out.onScreen && out.labels === 0 && out.h < 50, JSON.stringify(out));
  }
  if (viewport.height === 664) await page.screenshot({ path: `${SHOTS}short-phone-marker.jpg`, quality: 88, type: 'jpeg' });
  await close();
}

// --- The line: a done carries the next station and a route, the result travels, then the next bot starts.
{
  const { page, errors, close } = await open('capture=1&pull=0&island=_placeholder&config=example-4&source=replay&loop=0');
  const line = ['research', 'writer', 'inbox', 'lead'];
  const start = await page.evaluate(() => {
    const { island, camera, rig, routeProblems, config } = window.__engine;
    const home = island.home(camera.aspect);
    const pos = (w) => w.anchor.getWorldPosition(camera.position.clone());
    const xs = [...island.worlds.values()].map((w) => pos(w).x);
    return {
      routeProblems,
      order: config.bots.map((b) => b.id),
      offHome: camera.position.distanceTo(home.position),
      mainX: pos(island.main).x,
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
    };
  });
  check('line: the placeholder routes pass the contract check', start.routeProblems.length === 0, start.routeProblems.join());
  check('line: the camera rests where the island said', start.offHome < 0.05, start.offHome.toFixed(3));
  check('line: the main building is at the end, not in the middle', start.mainX > start.maxX, `main ${start.mainX.toFixed(1)}, bots to ${start.maxX.toFixed(1)}`);

  // Walk until each station's first done, then follow the result.
  const firstDone = async (id) => {
    for (let i = 0; i < 4000; i += 1) {
      const hit = await page.evaluate((who) => window.__engine.applied.find((e) => e.bot_id === who && e.type === 'done' && !e.warm) ?? null, id);
      if (hit) return hit;
      await step(page, 0.05, 0.05);
    }
    return null;
  };
  // Each station warms up on its own job first. "Started" here means started on the item coming down the line.
  const started = (id) => page.evaluate((who) => window.__engine.applied.some((e) => e.bot_id === who && e.type === 'working' && !e.warm && !e.update), id);

  const d0 = await firstDone('research');
  check('line: a done names the next station and carries one leg', d0?.next === 'writer' && d0?.leg === 3, JSON.stringify(d0));
  check('line: the next bot has not started yet', !(await started('writer')));
  const p0 = await page.evaluate(() => window.__engine.island.debugState().research);
  await step(page, 1, 0.05);
  const p1 = await page.evaluate(() => window.__engine.island.debugState().research);
  const moved = Math.hypot(p1.at[0] - p0.at[0], p1.at[2] - p0.at[2]);
  check('line: the result is travelling along the route', p1.travelling && moved > 1, `moved ${moved.toFixed(2)}`);
  await page.screenshot({ path: `${SHOTS}line-result-travelling.jpg`, quality: 88, type: 'jpeg' });
  await step(page, 1.6, 0.05);
  const p2 = await page.evaluate(() => {
    const { island } = window.__engine;
    return { state: island.debugState().research, handoff: island.worlds.get('research').route[2].toArray() };
  });
  const arrived = Math.hypot(p2.state.at[0] - p2.handoff[0], p2.state.at[2] - p2.handoff[2]);
  check('line: the result lands on the next station before that bot starts', p2.state.landed === 1 && !p2.state.travelling && arrived < 0.01 && !(await started('writer')), `${arrived.toFixed(3)} off`);
  // It finishes what it was warming up on first, so allow for that.
  for (let i = 0; i < 1200 && !(await started('writer')); i += 1) await step(page, 0.05, 0.05);
  check('line: then the next bot starts', await started('writer'));

  const d1 = await firstDone('writer');
  check('line: the middle bot feeds the last bot', d1?.next === 'inbox' && d1?.leg === 3, JSON.stringify(d1));
  const d2 = await firstDone('inbox');
  check('line: the last bot feeds the lead, at the main building', d2?.next === 'lead' && d2?.leg >= 2, JSON.stringify(d2));
  const end = await page.evaluate(() => {
    const { island, config } = window.__engine;
    const r = island.worlds.get('inbox').route;
    const main = island.main.stage.position;
    return { dx: r[r.length - 1].x - main.x, dz: r[r.length - 1].z - main.z, lead: config.lead.id };
  });
  check('line: every route ends at the main building', Math.hypot(end.dx, end.dz) < 3, `${Math.hypot(end.dx, end.dz).toFixed(2)} away`);
  const dl = await firstDone('lead');
  check('line: the lead is the end, with no next station and no route', dl?.next === null && dl?.leg === 0, JSON.stringify(dl));
  const order = await page.evaluate((ids) => ids.map((id) => window.__engine.applied.findIndex((e) => e.bot_id === id && e.type === 'working' && !e.warm && !e.update)), line);
  check('line: the replay starts each station in line order', order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), order.join());
  check('line: no page errors', errors.length === 0, errors.join());

  // Tour: along the line, ending at the main building.
  const seen = [];
  await page.evaluate(() => window.__engine.rig.startTour());
  for (let i = 0; i < 4; i += 1) {
    seen.push(await page.evaluate(() => {
      const { rig, island, config } = window.__engine;
      if (rig.tourWorld === island.main) return config.lead.id;
      return config.bots.find((b) => island.worlds.get(b.id) === rig.tourWorld)?.id;
    }));
    await step(page, 9.05, 1 / 20);
  }
  check('line: the tour walks the line and ends at the main building', seen.join() === line.join(), seen.join());
  await close();
}

// --- The day as a line, on the real demo script for both team sizes.
for (const n of [3, 4]) {
  const { page, close } = await open(`capture=1&pull=0&island=_placeholder&config=example-${n}&source=demo`);
  // Each station warms up first, so the first item takes a while to reach the lead.
  await step(page, 160, 1 / 10);
  const out = await page.evaluate(() => {
    const { applied, config, island } = window.__engine;
    const line = [...config.bots.map((b) => b.id), config.lead.id];
    const idx = (id, type) => applied.map((e, i) => (e.bot_id === id && e.type === type && !e.warm && !e.update ? i : -1)).filter((i) => i >= 0);
    let broken = 0;
    for (let k = 1; k < line.length; k += 1) {
      const feed = idx(line[k - 1], 'done');
      idx(line[k], 'working').forEach((at, i) => {
        if (feed[i] === undefined || feed[i] > at) broken += 1;
      });
    }
    const state = island.debugState();
    return { broken, landed: config.bots.map((b) => state[b.id].landed), jobs: idx(line[line.length - 1], 'done').length };
  });
  check(`demo ${n}: each working follows the done before it in the line`, out.broken === 0, `${out.broken} out of order`);
  check(`demo ${n}: results landed at every station, and the lead finished work`, out.landed.every((x) => x >= 1) && out.jobs >= 1, `${out.landed.join()} lead ${out.jobs}`);
  await close();
}

// --- Team sizes and contract breaks, on the page. Scene files are only rewritable in dev.
{
  const fourWorkers = { timezone: 'UTC', bots: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })) };
  const big = await open('island=_placeholder&config=/x/big.json&capture=1', { routes: { '**/x/big.json': (r) => r.fulfill({ json: fourWorkers }) } });
  const bigFatal = await big.page.evaluate(() => window.__fatal);
  check('team: a team of 5 gets a clear error', bigFatal && bigFatal.details.join().includes('3 or 4 counting the lead'), JSON.stringify(bigFatal));
  await big.close();
  check('team: the old example-7 is gone', (await (async () => {
    const o = await open('island=_placeholder&config=example-7&capture=1');
    const f = await o.page.evaluate(() => window.__fatal);
    await o.close();
    return f && /no bundled config/i.test(`${f.title} ${f.details.join()}`);
  })()));

  if (process.env.E2E_BUILD !== '1') {
    const rewrite = (edit) => ({
      '**/islands/_placeholder/scene.js*': async (r) => {
        const res = await r.fetch();
        r.fulfill({ response: res, body: edit(await res.text()) });
      },
    });
    const fits = await open('capture=1&island=_placeholder&source=demo', { routes: rewrite((t) => `${t}\nexport const teamSizes = [4];\n`) });
    check('team: with no config asked for, the bundled team fits the island', (await fits.page.evaluate(() => window.__engine?.config.bots.length)) === 3);
    await fits.close();
    const wrong = await open('capture=1&island=_placeholder&config=example-3&source=demo', { routes: rewrite((t) => `${t}\nexport const teamSizes = [4];\n`) });
    const wrongFatal = await wrong.page.evaluate(() => window.__fatal);
    check('team: a config the island has no placements for gets a clear error', wrongFatal && /laid out for a team of 4/.test(wrongFatal.title), JSON.stringify(wrongFatal));
    await wrong.close();

    const noHome = await open('capture=1&island=_placeholder&config=example-3&source=demo', { routes: rewrite((t) => t.replace('home(aspect) {', 'notHome(aspect) {')) });
    const noHomeFatal = await noHome.page.evaluate(() => window.__fatal);
    check('contract: an island with no home stops with a clear line', noHomeFatal && noHomeFatal.details.join().includes('home is missing'), JSON.stringify(noHomeFatal));
    await noHome.close();

    const noRoute = await open('capture=1&pull=0&island=_placeholder&config=example-3&source=replay&speed=20&loop=0', { routes: rewrite((t) => t.replace('world.handoff = 2;', 'delete world.handoff;').replace('worlds.set(bot.id, world);', 'worlds.set(bot.id, Object.assign(world, { route: undefined }));').replace("const firstRoute = worlds.get(config.bots[0].id).route;", "const firstRoute = [new THREE.Vector3(), new THREE.Vector3(1, 0, 0)];")) });
    const before = await noRoute.page.evaluate(() => ({ fatal: window.__fatal ?? null, problems: window.__engine?.routeProblems ?? null }));
    check('contract: an island with no route still runs, and says so', !before.fatal && before.problems?.length === 2 && before.problems[0].includes('has no route'), JSON.stringify(before));
    await step(noRoute.page, 8, 1 / 20);
    const after = await noRoute.page.evaluate(() => window.__engine.applied.filter((e) => e.type === 'done'));
    check('contract: a done with no route arrives with route null, and nothing throws', after.length >= 2 && after.every((e) => e.leg === 0) && noRoute.errors.length === 0, `${after.length} ${noRoute.errors.join()}`);
    await noRoute.close();
  }
}

// --- Capture mode runs only when stepped.
{
  const { page, close } = await open('capture=1&island=_placeholder&config=example-4&source=replay&loop=0');
  const f0 = await page.evaluate(() => window.__engine.frames());
  await page.waitForTimeout(500);
  const f1 = await page.evaluate(() => window.__engine.frames());
  check('capture: no frames without __step', f0 === f1, `${f0} then ${f1}`);
  await close();
}

// --- Safari's engine on a phone, on the real clock. Skipped if that browser is not installed.
try {
  const { webkit, devices } = await import('playwright');
  const wk = await webkit.launch();
  const ctx = await wk.newContext({ ...devices['iPhone 14'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?ui=1&island=_placeholder&config=example-4&source=replay&speed=6`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000, polling: 200 });
  await page.waitForTimeout(6000);
  const info = await page.evaluate(() => ({ q: window.__engine?.quality?.name, frames: window.__engine?.frames?.(), fps: window.__fps, overflow: document.documentElement.scrollWidth > innerWidth, applied: window.__engine?.store?.lastEvents().length }));
  check('webkit phone: runs, phone preset, events flow, no overflow, no errors', info.q === 'phone' && info.frames > 30 && !info.overflow && info.applied > 0 && errors.length === 0, `${JSON.stringify(info)} ${errors.join()}`);
  await page.screenshot({ path: `${SHOTS}webkit-phone.jpg`, type: 'jpeg', quality: 85 });
  await wk.close();
} catch (err) {
  if (/Executable doesn't exist/.test(err.message)) console.log('skip webkit phone: browser not installed');
  else check('webkit phone', false, err.message.slice(0, 200));
}

await browser.close();
await server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
if (failed.length) {
  console.log('Failed:');
  for (const f of failed) console.log(`  ${f.name}  [${f.detail}]`);
  process.exit(1);
}
process.exit(0);
