// Runs supabase/setup.sql in PGlite (real Postgres compiled to WASM) and checks the access rules as each role.
// Not tested here: Supabase's own API gateway, its real JWT handling, or PostgREST. See the report in README.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const WRITE_KEY = 'test-write-key-not-a-real-secret';
const HASH = createHash('sha256').update(WRITE_KEY).digest('hex');
const SQL = readFileSync(new URL('../setup.sql', import.meta.url), 'utf8');
const POST = 'select public.post_event($1, $2, $3, $4, $5, $6) as id';

let db;

async function asRole(role, fn) {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}

async function refused(promise, pattern = /permission denied|row-level security|wrong write key|writes are off/) {
  await assert.rejects(promise, pattern);
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role app_owner nologin;
    grant create on schema public to app_owner;
    grant anon, authenticated to app_owner;
  `);
  // Supabase runs the file as a non superuser that owns the objects, so do the same. Superusers skip RLS.
  await db.exec('set role app_owner');
  await db.exec(SQL.replace('REPLACE_WITH_SHA256_OF_WRITE_KEY', HASH));
  await db.exec('reset role');
});

after(async () => {
  await db.close();
});

test('the file runs a second time without error, and keeps rows', async () => {
  await asRole('anon', () => db.query(POST, [WRITE_KEY, 'a', 'idle', 'before rerun', null, null]));
  await db.exec('set role app_owner');
  await db.exec(SQL.replace('REPLACE_WITH_SHA256_OF_WRITE_KEY', HASH));
  await db.exec('reset role');
  const r = await asRole('anon', () => db.query(`select count(*)::int as n from public.events where text = 'before rerun'`));
  assert.equal(r.rows[0].n, 1);
});

test('running the file with a new hash replaces the key, and the events stay', async () => {
  const before = (await db.query('select count(*)::int as n from public.events')).rows[0].n;
  const newKey = 'a-brand-new-test-key';
  const newHash = createHash('sha256').update(newKey).digest('hex');
  await db.exec('set role app_owner');
  await db.exec(SQL.replace('REPLACE_WITH_SHA256_OF_WRITE_KEY', newHash));
  await db.exec('reset role');
  await refused(asRole('anon', () => db.query(POST, [WRITE_KEY, 'a', 'done', 'old key', null, null])), /wrong write key/);
  await asRole('anon', () => db.query(POST, [newKey, 'a', 'done', 'new key', null, null]));
  const after = (await db.query('select count(*)::int as n from public.events')).rows[0].n;
  assert.equal(after, before + 1);
  await db.exec('set role app_owner');
  await db.exec(SQL.replace('REPLACE_WITH_SHA256_OF_WRITE_KEY', HASH));
  await db.exec('reset role');
});

test('the hash placeholder appears exactly once, so a plain find and replace cannot miss', () => {
  assert.equal(SQL.split('REPLACE_WITH_SHA256_OF_WRITE_KEY').length - 1, 1);
});

test('a key hashed by another tool matches: sha256 of the UTF-8 bytes, lowercase hex', async () => {
  const r = await db.query(`select encode(sha256(convert_to($1, 'UTF8')), 'hex') as h`, [WRITE_KEY]);
  assert.equal(r.rows[0].h, HASH);
});

test('row level security is on, with one policy, and it is select only', async () => {
  const r = await db.query(`select relrowsecurity from pg_class where oid = 'public.events'::regclass`);
  assert.equal(r.rows[0].relrowsecurity, true);
  const policies = (await db.query(`select cmd, roles::text[] as roles from pg_policies where tablename = 'events'`)).rows;
  assert.deepEqual(policies, [{ cmd: 'SELECT', roles: ['anon', 'authenticated'] }]);
});

test('without the select policy anon would see nothing, so RLS really is what opens the read', async () => {
  await db.exec('set role app_owner');
  await db.exec('drop policy events_public_read on public.events');
  await db.exec('reset role');
  const r = await asRole('anon', () => db.query('select count(*)::int as n from public.events'));
  assert.equal(r.rows[0].n, 0);
  await db.exec('set role app_owner');
  await db.exec('create policy events_public_read on public.events for select to anon, authenticated using (true)');
  await db.exec('reset role');
});

test('anon can read', async () => {
  await asRole('anon', () => db.query(POST, [WRITE_KEY, 'research', 'working', 'reading', null, null]));
  const r = await asRole('anon', () => db.query('select bot_id, type, text, "timestamp", value from public.events'));
  assert.ok(r.rows.length >= 1);
});

for (const role of ['anon', 'authenticated']) {
  test(`${role} cannot insert, update, delete or truncate directly`, async () => {
    await refused(asRole(role, () => db.query(`insert into public.events (bot_id, type) values ('x', 'done')`)));
    await refused(asRole(role, () => db.query(`update public.events set text = 'hacked'`)));
    await refused(asRole(role, () => db.query('delete from public.events')));
    await refused(asRole(role, () => db.query('truncate public.events')));
    const r = await asRole(role, () => db.query(`select count(*)::int as n from public.events where text = 'hacked'`));
    assert.equal(r.rows[0].n, 0);
  });

  test(`${role} cannot prune`, async () => {
    await refused(asRole(role, () => db.query('select public.prune_events(1)')));
  });
}

test('post_event refuses a wrong, empty or missing key', async () => {
  await refused(asRole('anon', () => db.query(POST, ['wrong', 'a', 'done', 'x', null, null])));
  await refused(asRole('anon', () => db.query(POST, ['', 'a', 'done', 'x', null, null])));
  await refused(asRole('anon', () => db.query(POST, [null, 'a', 'done', 'x', null, null])));
  await refused(asRole('anon', () => db.query(POST, [HASH, 'a', 'done', 'x', null, null])), /wrong write key/);
});

test('post_event with the right key inserts one row, with defaults', async () => {
  const before = (await db.query('select count(*)::int as n from public.events')).rows[0].n;
  const r = await asRole('anon', () => db.query(POST, [WRITE_KEY, 'a', 'found', '3 leads', 3, '2026-01-01T00:00:00Z']));
  assert.ok(Number(r.rows[0].id) > 0);
  const row = (await db.query('select * from public.events where id = $1', [r.rows[0].id])).rows[0];
  assert.equal(row.bot_id, 'a');
  assert.equal(row.value, 3);
  assert.equal(new Date(row.timestamp).toISOString(), '2026-01-01T00:00:00.000Z');
  const after = (await db.query('select count(*)::int as n from public.events')).rows[0].n;
  assert.equal(after, before + 1);
});

test('the table rejects a bad type and an overlong text, even with the key', async () => {
  await assert.rejects(asRole('anon', () => db.query(POST, [WRITE_KEY, 'a', 'exploded', 'x', null, null])), /check constraint/);
  await assert.rejects(asRole('anon', () => db.query(POST, [WRITE_KEY, 'a', 'done', 'x'.repeat(201), null, null])), /check constraint/);
  await assert.rejects(asRole('anon', () => db.query(POST, [WRITE_KEY, '', 'done', 'x', null, null])), /check constraint/);
});

test('all five types are accepted', async () => {
  for (const type of ['idle', 'working', 'found', 'done', 'needs_approval']) {
    await asRole('anon', () => db.query(POST, [WRITE_KEY, 'a', type, type, null, null]));
  }
});

test('a service role can still write, as the owner of the project expects', async () => {
  await db.exec(`grant all on public.events to service_role; grant usage on schema public to service_role;`);
  await asRole('service_role', () => db.query(`insert into public.events (bot_id, type) values ('svc', 'done')`));
});

test('the placeholder hash fails closed: an unedited file refuses every write', async () => {
  const fresh = new PGlite();
  await fresh.exec('create role anon nologin; create role authenticated nologin; create role app_owner nologin; grant create on schema public to app_owner; grant anon, authenticated to app_owner;');
  await fresh.exec('set role app_owner');
  await fresh.exec(SQL);
  await fresh.exec('reset role');
  await fresh.exec('set role anon');
  await assert.rejects(fresh.query(POST, ['REPLACE_WITH_SHA256_OF_WRITE_KEY', 'a', 'done', 'x', null, null]), /writes are off/);
  await assert.rejects(fresh.query(POST, ['anything', 'a', 'done', 'x', null, null]), /writes are off/);
  await fresh.close();
});

test('prune_events removes only old rows, for the owner', async () => {
  await db.exec('set role app_owner');
  await db.query(POST, [WRITE_KEY, 'old', 'done', 'very old', null, new Date(Date.now() - 40 * 86400000).toISOString()]);
  await db.query(POST, [WRITE_KEY, 'old', 'done', 'recent', null, new Date(Date.now() - 2 * 86400000).toISOString()]);
  const removed = (await db.query('select public.prune_events(30) as n')).rows[0].n;
  assert.ok(Number(removed) >= 1);
  await assert.rejects(db.query('select public.prune_events(0)'), /at least 1/);
  await db.exec('reset role');
  const left = (await db.query(`select text from public.events where bot_id = 'old'`)).rows.map((r) => r.text);
  assert.deepEqual(left, ['recent']);
});

test('the indexes the page relies on exist', async () => {
  const names = (await db.query(`select indexname from pg_indexes where tablename = 'events'`)).rows.map((r) => r.indexname);
  assert.ok(names.includes('events_timestamp_idx'));
  assert.ok(names.includes('events_bot_timestamp_idx'));
});
