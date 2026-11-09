// The whole loop without a browser: a bot writes through post_event, the page's live source reads it back as the
// anon role, and the store sees it. A small stand-in plays the part of PostgREST for the exact query the page sends.
// It is not PostgREST. It shows that the table, the function and the live source agree with each other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { EventStore } from '../../engine/events.js';
import { createLiveSource } from '../../engine/sources/live.js';
import { validateConfig } from '../../engine/config.js';

const KEY = 'loop-test-key-not-a-real-secret';
const SQL = readFileSync(new URL('../setup.sql', import.meta.url), 'utf8').replace('REPLACE_WITH_SHA256_OF_WRITE_KEY', createHash('sha256').update(KEY).digest('hex'));

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 2));
}

test('bot writes, page reads, the store applies it, approval rules hold', async () => {
  const db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin; create role app_owner nologin; grant create on schema public to app_owner; grant anon, authenticated to app_owner;');
  await db.exec('set role app_owner');
  await db.exec(SQL);
  await db.exec('reset role');

  const bot = async (bot_id, type, text, value = null) => {
    await db.exec('set role anon');
    await db.query('select public.post_event($1, $2, $3, $4, $5)', [KEY, bot_id, type, text, value]);
    await db.exec('reset role');
  };

  // Reads what the page asks for, under the anon role, and answers the way PostgREST does: JSON with ISO times.
  const seenUrls = [];
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.method, 'GET');
    seenUrls.push(url);
    const q = new URL(url).searchParams;
    const columns = q.get('select').split(',').map((c) => `"${c}"`).join(', ');
    const [column, direction] = q.get('order').split('.');
    const since = q.get('timestamp').replace(/^gte\./, '');
    await db.exec('set role anon');
    const r = await db.query(`select ${columns} from public.events where "timestamp" >= $1 order by "${column}" ${direction === 'desc' ? 'desc' : 'asc'} limit ${Number(q.get('limit'))}`, [since]);
    await db.exec('reset role');
    const rows = r.rows.map((row) => ({ ...row, timestamp: new Date(row.timestamp).toISOString() }));
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(rows)) };
  };

  const { config } = validateConfig({ timezone: 'UTC', bots: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  const store = new EventStore({ config });
  const src = createLiveSource({ store, url: 'https://x.supabase.co/rest/v1/events', anonKey: 'sb_publishable_x', now: () => Date.now(), fetchImpl });
  const seen = [];
  store.on((e) => seen.push(e));

  await bot('a', 'needs_approval', 'asked before the page opened');
  src.update(0.01);
  await settle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].catchup, true);
  assert.equal(store.pendingApprovals().length, 1);
  assert.equal(src.status().label, 'live');

  await bot('b', 'found', 'three new threads', 3);
  src.update(3.1);
  await settle();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].catchup, false);
  assert.equal(seen[1].value, 3);

  await bot('a', 'working', 'on something else');
  src.update(3.1);
  await settle();
  assert.equal(store.pendingApprovals().length, 1, 'a later working leaves the ask up');

  await bot('a', 'done', 'answered and finished');
  src.update(3.1);
  await settle();
  assert.equal(store.pendingApprovals().length, 0);
  assert.equal(seen.length, 4, 'no repeats across polls, though the cursor uses gte');
  assert.equal(store.todayCounts().done, 1);
  assert.equal(store.rejected, 0);
  assert.ok(seenUrls[1].includes('timestamp=gte.'), 'the cursor moved');
  assert.notEqual(seenUrls[0], seenUrls[seenUrls.length - 1]);

  src.dispose();
  await db.close();
});
