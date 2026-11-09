import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore, intensityFromValue, normalizeEvent, EVENT_TYPES } from '../../events.js';
import { dayKey, dayFraction, isValidTimeZone } from '../../time.js';

const NOW = Date.parse('2026-11-09T18:00:00Z');
const config = (timezone = 'UTC') => ({
  timezone,
  lead: { id: 'lead', name: 'lead', color: '#ffffff' },
  bots: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }],
});
const iso = (minutes) => new Date(NOW + minutes * 60000).toISOString();
const ev = (bot_id, type, minutes = 0, extra = {}) => ({ bot_id, type, text: `${type} ${minutes}`, timestamp: iso(minutes), ...extra });
const make = (tz) => new EventStore({ config: config(tz), now: () => NOW + 3600000 });

test('there are exactly five types', () => {
  assert.deepEqual(EVENT_TYPES, ['idle', 'working', 'found', 'done', 'needs_approval']);
});

test('needs_approval stays through later events until a later done from that bot', () => {
  const s = make();
  s.ingest(ev('a', 'needs_approval', 0));
  assert.equal(s.pendingApprovals().length, 1);
  assert.equal(s.ingest(ev('a', 'working', 1)).pending, true);
  assert.equal(s.ingest(ev('a', 'found', 2)).pending, true);
  assert.equal(s.ingest(ev('a', 'idle', 3)).pending, true);
  s.ingest(ev('b', 'done', 4));
  assert.equal(s.pendingApprovals().length, 1, 'a done from another bot does not clear it');
  const cleared = s.ingest(ev('a', 'done', 5));
  assert.equal(cleared.pending, false);
  assert.equal(s.pendingApprovals().length, 0);
});

test('a done from before the ask does not clear it, even if it arrives after', () => {
  const s = make();
  s.ingest(ev('a', 'needs_approval', 10));
  s.ingest(ev('a', 'done', 5));
  assert.equal(s.pendingApprovals().length, 1);
});

test('an ask that arrives late, older than a done, is already answered', () => {
  const s = make();
  s.ingest(ev('a', 'done', 10));
  s.ingest(ev('a', 'needs_approval', 5));
  assert.equal(s.pendingApprovals().length, 0);
});

test('a batch is applied in time order, whatever order the rows come in', () => {
  const s = make();
  s.ingestBatch([ev('a', 'done', 5), ev('a', 'needs_approval', 1)]);
  assert.equal(s.pendingApprovals().length, 0);
});

test('one row per waiting bot, a second ask updates the text', () => {
  const s = make();
  s.ingest({ ...ev('a', 'needs_approval', 0), text: 'first' });
  s.ingest({ ...ev('a', 'needs_approval', 1), text: 'second' });
  s.ingest(ev('b', 'needs_approval', 2));
  const list = s.pendingApprovals();
  assert.equal(list.length, 2);
  assert.equal(list[1].text, 'second');
  assert.equal(list[0].bot_id, 'b');
});

test('found carries an optional value and it scales intensity', () => {
  const s = make();
  const none = s.ingest(ev('a', 'found', 0));
  assert.equal(none.value, undefined);
  assert.equal(none.intensity, 0.5);
  const small = s.ingest(ev('a', 'found', 1, { value: 3 }));
  const big = s.ingest(ev('a', 'found', 2, { value: 900 }));
  assert.equal(small.value, 3);
  assert.ok(big.intensity > small.intensity);
  assert.ok(big.intensity <= 1);
  assert.equal(s.ingest(ev('a', 'found', 3, { value: '12' })).value, 12);
  assert.equal(s.ingest(ev('a', 'found', 4, { value: 'lots' })).value, undefined);
  assert.equal(intensityFromValue(0), 0.25);
  assert.equal(intensityFromValue(-5), 0.25);
  assert.equal(intensityFromValue(1e9), 1);
});

test('keeps the last 6, newest first, and a late row lands in its place', () => {
  const s = make();
  for (let i = 0; i < 9; i += 1) s.ingest(ev('a', 'working', i));
  assert.equal(s.lastEvents().length, 6);
  assert.equal(s.lastEvents(3).length, 3);
  assert.equal(s.lastEvents()[0].text, 'working 8');
  s.ingest(ev('b', 'found', 7.5));
  assert.deepEqual(s.lastEvents(2).map((e) => e.text), ['working 8', 'found 7.5']);
  assert.equal(s.lastEvents().length, 6);
});

test('today counts follow the config time zone', () => {
  // 03:30 UTC on the 10th is still the 9th in New York, and already the 10th in Tokyo.
  const late = Date.parse('2026-11-10T03:30:00Z');
  const earlier = Date.parse('2026-11-09T14:00:00Z'); // 09:00 on the 9th in New York, 23:00 on the 9th in Tokyo.
  const ny = new EventStore({ config: config('America/New_York'), now: () => late });
  ny.ingest({ bot_id: 'a', type: 'done', text: '', timestamp: new Date(earlier).toISOString() });
  ny.ingest({ bot_id: 'a', type: 'done', text: 'x', timestamp: new Date(late).toISOString() });
  assert.equal(ny.todayCounts(late).done, 2);
  const tokyo = new EventStore({ config: config('Asia/Tokyo'), now: () => late });
  tokyo.ingest({ bot_id: 'a', type: 'done', text: '', timestamp: new Date(earlier).toISOString() });
  tokyo.ingest({ bot_id: 'a', type: 'done', text: 'x', timestamp: new Date(late).toISOString() });
  assert.equal(tokyo.todayCounts(late).done, 1);
});

test('counts roll over at local midnight', () => {
  let clock = Date.parse('2026-11-09T23:59:00Z');
  const s = new EventStore({ config: config('UTC'), now: () => clock });
  s.ingest({ bot_id: 'a', type: 'found', text: '', timestamp: new Date(clock).toISOString() });
  assert.equal(s.todayCounts().found, 1);
  clock = Date.parse('2026-11-10T00:00:30Z');
  assert.equal(s.todayCounts().found, 0);
});

test('activity: working and found mean working, the rest mean idle, late rows do not rewind', () => {
  const s = make();
  assert.equal(s.ingest(ev('a', 'working', 5)).activity, 'working');
  assert.equal(s.ingest(ev('a', 'found', 6)).activity, 'working');
  assert.equal(s.ingest(ev('a', 'idle', 1)).activity, 'working', 'an old idle arrives late');
  assert.equal(s.ingest(ev('a', 'done', 7)).activity, 'idle');
});

test('repeat rows are dropped, by id or by content', () => {
  const s = make();
  assert.ok(s.ingest(ev('a', 'working', 0, { id: 1 })));
  assert.equal(s.ingest(ev('a', 'working', 0, { id: 1 })), null);
  assert.ok(s.ingest(ev('a', 'working', 0, { id: 2 })), 'same content, new id');
  assert.ok(s.ingest(ev('b', 'found', 0)));
  assert.equal(s.ingest(ev('b', 'found', 0)), null);
  assert.equal(s.todayCounts().found, 1);
});

test('bad rows are counted and never throw', () => {
  const s = make();
  const bad = [null, 5, 'x', [], {}, { bot_id: 'nobody', type: 'done' }, { bot_id: 'a', type: 'exploded' }, { bot_id: 'a', type: 'done', timestamp: 'yesterday-ish' }, { bot_id: 'a', type: 'done', timestamp: {} }];
  for (const row of bad) assert.equal(s.ingest(row), null);
  assert.equal(s.rejected, bad.length);
  for (const row of bad) s.ingest(row);
  assert.equal(s.rejected, bad.length, 'the same bad row is counted once');
  assert.match(s.lastProblem, /timestamp/);
  assert.equal(s.lastEvents().length, 0);
});

test('text is coerced, squeezed and cut, and stays inert data', () => {
  const s = make();
  const e = s.ingest({ bot_id: 'a', type: 'done', timestamp: iso(0), text: 'a'.repeat(500) });
  assert.ok(e.text.length <= 200);
  assert.equal(s.ingest({ bot_id: 'a', type: 'done', timestamp: iso(1) }).text, '');
  assert.equal(s.ingest({ bot_id: 'a', type: 'done', timestamp: iso(2), text: 42 }).text, '42');
  assert.equal(s.ingest({ bot_id: 'a', type: 'done', timestamp: iso(3), text: ' two\n\nlines ' }).text, 'two lines');
});

test('a missing timestamp takes the clock, an epoch number works', () => {
  const s = make();
  const e = s.ingest({ bot_id: 'a', type: 'working', text: 'x' });
  assert.equal(e.ms, NOW + 3600000);
  assert.equal(normalizeEvent({ bot_id: 'a', type: 'done', timestamp: 1000 }, new Set(['a']), 0).evt.ms, 1000);
});

test('lead events are accepted, listeners fire, catchup passes through, reset clears', () => {
  const s = make();
  const seen = [];
  let resets = 0;
  s.on((e) => seen.push(e));
  s.onReset(() => { resets += 1; });
  s.ingest(ev('lead', 'working', 0));
  s.ingest(ev('a', 'needs_approval', 1), { catchup: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].catchup, false);
  assert.equal(seen[1].catchup, true);
  s.reset();
  assert.equal(resets, 1);
  assert.equal(s.pendingApprovals().length, 0);
  assert.equal(s.lastEvents().length, 0);
  assert.equal(s.todayCounts().working, 0);
  assert.ok(s.ingest(ev('lead', 'working', 0)), 'seen list was cleared too');
});

test('time helpers', () => {
  assert.equal(dayFraction(Date.parse('2026-11-09T12:00:00Z'), 'UTC'), 0.5);
  assert.equal(dayFraction(Date.parse('2026-11-09T17:00:00Z'), 'America/New_York'), 0.5);
  assert.equal(dayKey(Date.parse('2026-11-10T03:30:00Z'), 'America/New_York'), '2026-11-09');
  assert.equal(isValidTimeZone('Nope/Nope'), false);
  assert.equal(isValidTimeZone('Asia/Tokyo'), true);
});
