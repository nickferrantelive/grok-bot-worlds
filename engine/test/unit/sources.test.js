import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore, EVENT_TYPES } from '../../events.js';
import { buildDayScript, createDemoSource, DEMO_LOOP_SECONDS } from '../../sources/demo.js';
import { parseReplayFile, createReplaySource, buildScriptedReplay, clampSpeed } from '../../sources/replay.js';
import { createLiveSource, buildPollUrl, extractRows, isSupabaseUrl, readHeaders, nextBackoff } from '../../sources/live.js';
import { chooseSourceSpec, createSource } from '../../sources/index.js';
import { validateConfig } from '../../config.js';
import { HANDOFF_SECONDS } from '../../route.js';

const team = (n) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, name: `b${i}`, color: '#3fd18b' }));
const conf = (n = 3) => validateConfig({ timezone: 'UTC', bots: team(n) }).config;
const NOW = Date.parse('2026-11-09T18:00:00Z');

for (const n of [2, 3]) {
  test(`demo script for ${n} bots: all five types early, every bot works, believable pace`, () => {
    const rows = buildDayScript(conf(n));
    const early = rows.filter((r) => r.at < 90);
    for (const type of EVENT_TYPES) assert.ok(early.some((r) => r.type === type), `${type} within 90 s`);
    for (const b of conf(n).bots) assert.ok(rows.some((r) => r.bot_id === b.id && r.type === 'working'), `${b.id} works`);
    assert.ok(rows.some((r) => r.bot_id === 'lead'), 'the lead works too');
    // Progress updates to a running job are not a pace of new things happening.
    const perMinute = rows.filter((r) => !r.update).length / (DEMO_LOOP_SECONDS / 60);
    assert.ok(perMinute > 5 && perMinute < 60, `pace ${perMinute}`);
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i].at >= rows[i - 1].at, 'sorted');
    const biggestGap = rows.reduce((gap, r, i) => (i ? Math.max(gap, r.at - rows[i - 1].at) : gap), 0);
    assert.ok(biggestGap < 25, `quiet gap ${biggestGap}`);
  });

  test(`demo script for ${n} bots is a line: each done feeds the next station's working`, () => {
    const config = conf(n);
    // The warm up is the batch each station already had open when the page loaded. Updates belong to a running job.
    const rows = buildDayScript(config).filter((r) => !r.warm && !r.update);
    const line = [...config.bots, config.lead];
    const times = (id, type) => rows.filter((r) => r.bot_id === id && r.type === type).map((r) => r.at);
    assert.ok(times(line[0].id, 'working').length >= 3, 'several items walk the line');
    for (let k = 1; k < line.length; k += 1) {
      const fed = times(line[k - 1].id, 'done');
      const started = times(line[k].id, 'working');
      assert.ok(started.length >= 3, `${line[k].id} gets work`);
      started.forEach((at, i) => {
        assert.ok(fed[i] !== undefined, `${line[k].id} job ${i} has nothing feeding it`);
        assert.ok(at >= fed[i] + HANDOFF_SECONDS - 1e-9, `${line[k].id} job ${i} starts ${at - fed[i]} s after its feed`);
      });
    }
    // The hand off is immediate unless the next station is still busy. The world shows the handover, so its text does not.
    const firstDone = rows.find((r) => r.bot_id === line[0].id && r.type === 'done');
    const firstNext = rows.find((r) => r.bot_id === line[1].id && r.type === 'working');
    assert.ok(firstNext.at - firstDone.at - HANDOFF_SECONDS > -1e-9);
    for (const row of rows.filter((r) => r.text)) assert.ok(row.text.split(' ').length <= 5 && row.text.length <= 26, `short line: ${row.text}`);
    // A bot starts only what it has finished before: working, then done, then working.
    for (const bot of line) {
      let open = false;
      for (const r of rows.filter((x) => x.bot_id === bot.id)) {
        if (r.type === 'working') {
          assert.ok(!open, `${bot.id} started a job at ${r.at} before finishing the last`);
          open = true;
        }
        if (r.type === 'done') open = false;
      }
    }
    assert.ok(times(config.lead.id, 'done').length >= 3, 'the line ends with the lead');
  });
}

test('demo script is deterministic and uses no real business', () => {
  const a = buildDayScript(conf(3));
  const b = buildDayScript(conf(3));
  assert.deepEqual(a, b);
  assert.ok(!a.some((r) => /\{n\}/.test(r.text)), 'no unfilled templates');
});

test('a bot does work that fits its name and role, and any other name still gets jobs', () => {
  const { config } = validateConfig({
    timezone: 'UTC',
    bots: [{ id: 'inbox', role: 'answers the simple messages' }, { id: 'numbers' }, { id: 'zorblax', role: 'mystery' }],
  });
  const rows = buildDayScript(config);
  const started = (id) => rows.filter((r) => r.bot_id === id && r.type === 'working').map((r) => r.text);
  assert.equal(started('inbox')[0], 'sorting inbox');
  assert.equal(started('numbers')[0], 'checking numbers');
  assert.ok(new Set(started('inbox')).size >= 2, 'it does not repeat one job all day');
  assert.ok(started('zorblax').length >= 3);
  assert.ok(!started('inbox').includes('writing post ideas'));
});

test('every approval in the demo script is answered by a later done', () => {
  const rows = buildDayScript(conf(3));
  assert.ok(rows.some((r) => r.type === 'needs_approval'));
  rows.forEach((r, i) => {
    if (r.type !== 'needs_approval') return;
    assert.ok(rows.slice(i + 1).some((x) => x.bot_id === r.bot_id && x.type === 'done'));
  });
});

test('demo source plays in order, and a new day resets the store', () => {
  const config = conf(3);
  let clock = NOW;
  const store = new EventStore({ config, now: () => clock });
  const src = createDemoSource({ config, store, now: () => clock });
  let resets = 0;
  store.onReset(() => { resets += 1; });
  for (let i = 0; i < 299; i += 1) {
    clock += 1000;
    src.update(1);
  }
  assert.ok(store.todayCounts().working > 5);
  assert.equal(store.rejected, 0);
  assert.equal(src.status().label, 'demo');
  assert.equal(resets, 0);
  clock += 2000;
  src.update(2);
  assert.equal(resets, 1);
  assert.ok(store.todayCounts().working < 5, 'counts start over with the new day');
});

test('replay parse: list, object, empty, bad', () => {
  assert.equal(parseReplayFile([{ timestamp: '2026-01-01T00:00:00Z' }]).events.length, 1);
  assert.equal(parseReplayFile({ events: [{ timestamp: '2026-01-01T00:00:00Z' }], speed: 8 }).speed, 8);
  assert.match(parseReplayFile({ events: [] }).errors[0], /no events/);
  assert.match(parseReplayFile({ nope: 1 }).errors[0], /list of events/);
  assert.match(parseReplayFile(null).errors[0], /list of events/);
  assert.match(parseReplayFile([{ timestamp: 'x' }]).errors[0], /readable timestamp/);
  assert.equal(parseReplayFile({ events: [{ timestamp: '2026-01-01T00:00:00Z' }, { timestamp: 'x' }] }).bad, 1);
  assert.equal(clampSpeed(50), 20);
  assert.equal(clampSpeed(0), 1);
  assert.equal(clampSpeed('x', 3), 3);
});

for (const speed of [1, 6, 20]) {
  test(`replay at ${speed}x plays each event at the right wall time`, () => {
    const config = conf(3);
    const t0 = Date.parse('2026-03-16T15:00:00Z');
    const file = {
      lead_in: 1,
      events: [
        { id: 1, bot_id: 'b0', type: 'working', text: 'a', timestamp: new Date(t0).toISOString() },
        { id: 2, bot_id: 'b0', type: 'done', text: 'b', timestamp: new Date(t0 + 60000).toISOString() },
      ],
    };
    let src;
    const store = new EventStore({ config, now: () => src.now() });
    src = createReplaySource({ store, file, speed, loop: false });
    const seen = [];
    store.on((e) => seen.push(e.type));
    src.update(0.99);
    assert.deepEqual(seen, [], 'still in the lead in');
    src.update(0.02);
    assert.deepEqual(seen, ['working']);
    src.update(60 / speed - 0.05);
    assert.deepEqual(seen, ['working']);
    src.update(0.1);
    assert.deepEqual(seen, ['working', 'done']);
    assert.ok(Math.abs(src.now() - (t0 + 60000)) < 200 * speed);
    assert.equal(src.status().label, `replay ${speed}x`);
  });
}

test('replay loops with a reset, or stops', () => {
  const config = conf(3);
  const file = buildScriptedReplay(config);
  let src;
  const store = new EventStore({ config, now: () => src.now() });
  src = createReplaySource({ store, file, speed: 20, loop: true, tail: 1 });
  let resets = 0;
  store.onReset(() => { resets += 1; });
  for (let i = 0; i < 600; i += 1) src.update(0.1);
  assert.ok(resets >= 1);

  let src2;
  const store2 = new EventStore({ config, now: () => src2.now() });
  src2 = createReplaySource({ store: store2, file, speed: 20, loop: false, tail: 1 });
  let count = 0;
  store2.on(() => { count += 1; });
  for (let i = 0; i < 600; i += 1) src2.update(0.1);
  assert.equal(count, file.events.length, 'no repeats and no drops');
});

test('scripted replay covers all five types inside 20 s at its own speed, for any team', () => {
  for (const n of [2, 3]) {
    const config = conf(n);
    const file = buildScriptedReplay(config);
    assert.equal(file.speed, 1);
    let src;
    const store = new EventStore({ config, now: () => src.now() });
    src = createReplaySource({ store, file, loop: false });
    const types = new Set();
    store.on((e) => types.add(e.type));
    for (let i = 0; i < 1200; i += 1) src.update(1 / 60);
    assert.deepEqual([...types].sort(), [...EVENT_TYPES].sort(), `team of ${n}`);
    assert.equal(store.rejected, 0);
  }
});

test('scripted replay runs at real speed with the whole team busy, and every state shows inside 20 s', () => {
  for (const n of [2, 3]) {
    const config = conf(n);
    const { events, speed } = buildScriptedReplay(config);
    assert.equal(speed, 1);
    const at = (e) => (Date.parse(e.timestamp) - Date.parse(events[0].timestamp)) / 1000;
    const early = events.filter((e) => at(e) < 20);
    for (const type of EVENT_TYPES) assert.ok(early.some((e) => e.type === type), `${type} within 20 s for ${n} bots`);
    for (const b of [...config.bots, config.lead]) {
      assert.ok(events.some((e) => e.bot_id === b.id && e.type === 'working' && at(e) < 8), `${b.id} is at work inside 8 s`);
    }
    events.forEach((e, i) => {
      if (e.type === 'needs_approval') assert.ok(events.slice(i + 1).some((x) => x.bot_id === e.bot_id && x.type === 'done'));
    });
    for (let i = 1; i < events.length; i += 1) assert.ok(at(events[i]) >= at(events[i - 1]), 'sorted');
  }
});

test('replay reports rows for bots that are not in this config', () => {
  const config = conf(3);
  let src;
  const store = new EventStore({ config, now: () => src.now() });
  src = createReplaySource({ store, file: { lead_in: 0, events: [{ bot_id: 'stranger', type: 'done', text: 'x', timestamp: '2026-01-01T00:00:00Z' }] }, loop: false });
  src.update(1);
  assert.equal(src.status().state, 'warn');
  assert.match(src.status().detail, /stranger/);
});

function jsonRes(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

test('live polls every 3 s, drops repeats, marks the first batch as catch-up', async () => {
  const config = conf(3);
  let clock = NOW;
  const store = new EventStore({ config, now: () => clock });
  const urls = [];
  let rows = [{ id: 1, bot_id: 'b0', type: 'needs_approval', text: 'old ask', timestamp: new Date(NOW - 7200000).toISOString() }];
  const src = createLiveSource({ store, url: 'https://x/feed.json', now: () => clock, fetchImpl: async (url) => { urls.push(url); return jsonRes(rows); } });
  assert.equal(src.status().label, 'connecting');
  const seen = [];
  store.on((e) => seen.push(e));
  src.update(0.016);
  await settle();
  assert.equal(urls.length, 1);
  assert.equal(seen[0].catchup, true);
  assert.equal(store.pendingApprovals().length, 1, 'an old ask still shows');
  assert.equal(src.status().label, 'live');

  src.update(2.9);
  await settle();
  assert.equal(urls.length, 1, 'not yet');
  src.update(0.2);
  await settle();
  assert.equal(urls.length, 2, 'polled at 3 s');
  assert.equal(seen.length, 1, 'the repeat row was dropped');

  clock += 3000;
  rows = [...rows, { id: 2, bot_id: 'b0', type: 'done', text: 'answered', timestamp: new Date(clock).toISOString() }];
  src.update(3.1);
  await settle();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].catchup, false);
  assert.equal(store.pendingApprovals().length, 0);
  src.dispose();
});

test('live backs off on failure, shows it, and recovers', async () => {
  const config = conf(3);
  const store = new EventStore({ config, now: () => NOW });
  let mode = 'fail';
  let calls = 0;
  const src = createLiveSource({
    store,
    url: 'https://x/feed.json',
    now: () => NOW,
    fetchImpl: async () => {
      calls += 1;
      if (mode === 'fail') throw new TypeError('network');
      if (mode === '401') return jsonRes({}, 401);
      if (mode === 'notjson') return { ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } };
      if (mode === 'shape') return jsonRes({ hello: 1 });
      return jsonRes([]);
    },
  });
  src.update(0.01);
  await settle();
  assert.equal(src.status().state, 'retrying');
  assert.match(src.status().detail, /cannot reach the server/);
  assert.equal(src.backoffSeconds, 6);
  src.update(5.9);
  await settle();
  assert.equal(calls, 1, 'waiting out the backoff');
  src.update(0.2);
  await settle();
  assert.equal(calls, 2);
  assert.equal(src.backoffSeconds, 12);

  mode = '401';
  src.update(12.1);
  await settle();
  assert.match(src.status().detail, /HTTP 401.*anon key/);
  assert.equal(src.backoffSeconds, 24);

  mode = 'notjson';
  src.update(24.1);
  await settle();
  assert.match(src.status().detail, /not JSON/);
  assert.equal(src.backoffSeconds, 48);

  mode = 'shape';
  src.update(48.1);
  await settle();
  assert.match(src.status().detail, /not a list/);
  assert.equal(src.backoffSeconds, 60, 'capped at 60');

  mode = 'ok';
  src.update(60.1);
  await settle();
  assert.equal(src.status().state, 'ok');
  assert.equal(src.status().label, 'live');
  assert.equal(src.backoffSeconds, 3, 'back to normal');
  src.dispose();
});

test('live counts a bad row once, however many polls serve it, and the notice fades', async () => {
  const config = conf(3);
  const store = new EventStore({ config, now: () => NOW });
  const rows = [{ bot_id: 'stranger', type: 'done', text: 'x', timestamp: new Date(NOW).toISOString() }];
  const src = createLiveSource({ store, url: 'https://x/feed.json', now: () => NOW, fetchImpl: async () => jsonRes(rows) });
  src.update(0.01);
  await settle();
  src.update(3.1);
  await settle();
  src.update(3.1);
  await settle();
  assert.equal(store.rejected, 1);
  assert.equal(src.status().state, 'warn');
  assert.match(src.status().detail, /1 row skipped: unknown bot "stranger"/);
  for (let i = 0; i < 8; i += 1) {
    src.update(3.1);
    await settle();
  }
  assert.equal(src.status().state, 'ok', 'the notice has faded');
  assert.equal(src.status().detail, '');
  assert.equal(store.rejected, 1);
  src.dispose();
});

test('live never overlaps requests', async () => {
  const config = conf(3);
  const store = new EventStore({ config, now: () => NOW });
  let release;
  let calls = 0;
  const src = createLiveSource({ store, url: 'https://x/feed.json', now: () => NOW, fetchImpl: () => { calls += 1; return new Promise((r) => { release = () => r(jsonRes([])); }); } });
  src.update(0.01);
  src.update(10);
  src.update(10);
  assert.equal(calls, 1);
  release();
  await settle();
  src.dispose();
});

test('Supabase shape: url, query, headers, GET only', async () => {
  const url = 'https://abc.supabase.co/rest/v1/events';
  assert.equal(isSupabaseUrl(url), true);
  assert.equal(isSupabaseUrl('https://x/feed.json'), false);
  const built = new URL(buildPollUrl(url, NOW));
  assert.equal(built.searchParams.get('order'), 'timestamp.desc');
  assert.equal(built.searchParams.get('limit'), '1000');
  assert.equal(built.searchParams.get('timestamp'), `gte.${new Date(NOW).toISOString()}`);
  assert.match(built.searchParams.get('select'), /bot_id/);
  assert.equal(buildPollUrl('https://x/feed.json', NOW), 'https://x/feed.json');
  assert.deepEqual(extractRows([1]), [1]);
  assert.deepEqual(extractRows({ events: [1] }), [1]);
  assert.deepEqual(extractRows({ data: [1] }), [1]);
  assert.equal(extractRows({ nope: 1 }), null);
  const jwtHeaders = readHeaders(url, 'a.b.c');
  assert.equal(jwtHeaders.apikey, 'a.b.c');
  assert.equal(jwtHeaders.Authorization, 'Bearer a.b.c');
  const newHeaders = readHeaders(url, 'sb_publishable_x');
  assert.equal(newHeaders.apikey, 'sb_publishable_x');
  assert.equal(newHeaders.Authorization, undefined);
  assert.equal(readHeaders('https://x/feed.json', 'k').apikey, undefined, 'a key is never sent to a host that is not Supabase REST');

  const config = conf(3);
  const store = new EventStore({ config, now: () => NOW });
  let captured = null;
  const src = createLiveSource({
    store,
    url,
    anonKey: 'sb_publishable_x',
    now: () => NOW,
    fetchImpl: async (u, opts) => {
      captured = { u, opts };
      return jsonRes([{ id: 9, bot_id: 'b1', type: 'found', text: 'x', timestamp: new Date(NOW).toISOString(), value: '12.5' }]);
    },
  });
  src.update(0.01);
  await settle();
  assert.equal(captured.opts.method, 'GET');
  assert.equal(captured.opts.body, undefined);
  assert.equal(store.lastEvents()[0].value, 12.5, 'Postgres numeric arrives as text');
  src.dispose();
});

test('live cursor moves forward and a far future row cannot wedge it', async () => {
  const config = conf(3);
  const store = new EventStore({ config, now: () => NOW });
  const seen = [];
  let rows = [
    { id: 1, bot_id: 'b0', type: 'done', text: 'a', timestamp: new Date(NOW - 1000).toISOString() },
    { id: 2, bot_id: 'b0', type: 'done', text: 'b', timestamp: new Date(NOW + 86400000 * 300).toISOString() },
  ];
  const src = createLiveSource({ store, url: 'https://a.supabase.co/rest/v1/events', now: () => NOW, fetchImpl: async (u) => { seen.push(new URL(u).searchParams.get('timestamp')); return jsonRes(rows); } });
  src.update(0.01);
  await settle();
  rows = [];
  src.update(3.1);
  await settle();
  assert.equal(seen[1], `gte.${new Date(NOW - 1000).toISOString()}`);
  src.dispose();
});

test('source choice: URL beats config beats demo', () => {
  const p = (q) => new URLSearchParams(q);
  assert.equal(chooseSourceSpec(p(''), null).mode, 'demo');
  assert.equal(chooseSourceSpec(p(''), { mode: 'live', url: 'u' }).mode, 'live');
  assert.equal(chooseSourceSpec(p('source=replay'), { mode: 'live', url: 'u' }).mode, 'replay');
  assert.equal(chooseSourceSpec(p('source=replay&speed=99'), null).speed, 20);
  assert.equal(chooseSourceSpec(p('source=replay&speed=0'), null).speed, 1);
  assert.equal(chooseSourceSpec(p('loop=0'), null).loop, false);
  assert.throws(() => chooseSourceSpec(p('source=magic'), null), /Unknown source/);
});

test('createSource refuses a write key given in the address', async () => {
  const config = conf(3);
  const store = new EventStore({ config, now: () => NOW });
  await assert.rejects(createSource({ spec: { mode: 'live', url: 'https://a.supabase.co/rest/v1/events', anonKey: 'sb_secret_x' }, config, store }), /Refusing/);
  await assert.rejects(createSource({ spec: { mode: 'live' }, config, store }), /needs a URL/);
  await assert.rejects(createSource({ spec: { mode: 'replay', replay: 'x.json' }, config, store, fetchImpl: async () => ({ ok: false, status: 404 }) }), /Could not load the replay/);
  await assert.rejects(createSource({ spec: { mode: 'replay', replay: 'x.json' }, config, store, fetchImpl: async () => ({ ok: true, json: async () => ({ events: [] }) }) }), /cannot be played/);
});
