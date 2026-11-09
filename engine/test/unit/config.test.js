import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, secretKeyProblem, loadConfig, normalizeColor, ConfigError, teamSize } from '../../config.js';

const bot = (id, extra = {}) => ({ id, name: id, color: '#3fd18b', ...extra });
const team = (n) => Array.from({ length: n }, (_, i) => bot(`b${i}`));
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

test('a team is 3 or 4 counting the lead: accepts 2 and 3 bots, rejects 1 and 4', () => {
  assert.equal(validateConfig({ timezone: 'UTC', bots: team(2) }).errors.length, 0);
  assert.equal(validateConfig({ timezone: 'UTC', bots: team(3) }).errors.length, 0);
  assert.match(validateConfig({ timezone: 'UTC', bots: team(1) }).errors[0], /found 1 besides the lead/);
  const four = validateConfig({ timezone: 'UTC', bots: team(4) }).errors[0];
  assert.match(four, /found 4 besides the lead/);
  assert.match(four, /3 or 4 counting the lead/);
  assert.equal(teamSize(validateConfig({ timezone: 'UTC', bots: team(2) }).config), 3);
  assert.equal(teamSize(validateConfig({ timezone: 'UTC', bots: [...team(3), bot('boss', { lead: true })] }).config), 4);
});

test('the lead is not counted and is never in bots', () => {
  const { config, errors } = validateConfig({ timezone: 'UTC', bots: [...team(3), bot('boss', { lead: true, color: '#ffffff' })] });
  assert.deepEqual(errors, []);
  assert.equal(config.bots.length, 3);
  assert.equal(config.lead.id, 'boss');
  assert.ok(!config.bots.some((b) => b.id === 'boss'));
});

test('adds a white lead when there is none, and its id cannot clash', () => {
  const { config } = validateConfig({ timezone: 'UTC', bots: [bot('lead'), bot('a'), bot('b')] });
  assert.equal(config.lead.color, '#ffffff');
  assert.notEqual(config.lead.id, 'lead');
});

test('two leads is an error', () => {
  const r = validateConfig({ timezone: 'UTC', bots: [...team(3), bot('x', { lead: true }), bot('y', { lead: true })] });
  assert.match(r.errors.join(), /more than one lead/);
});

test('any names and colours pass, bad ones say what is wrong', () => {
  const ok = validateConfig({ timezone: 'UTC', bots: [bot('a', { name: 'Zoë 🤖 北京' }), bot('b', { color: '#ABC' }), bot('c', { color: undefined })] });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.bots[0].name, 'Zoë 🤖 北京');
  assert.equal(ok.config.bots[1].color, '#aabbcc');
  assert.match(ok.config.bots[2].color, /^#[0-9a-f]{6}$/);
  const bad = validateConfig({ timezone: 'UTC', bots: [bot('a', { color: 'blue' }), bot('b'), bot('c')] });
  assert.match(bad.errors[0], /bots\[0\]\.color: "blue" is not a hex colour/);
  assert.equal(bad.config, null);
});

test('bad timezone, island, duplicate ids, wrong types', () => {
  assert.match(validateConfig({ timezone: 'Mars/Olympus', bots: team(3) }).errors[0], /not a time zone name/);
  assert.match(validateConfig({ timezone: 'UTC', island: '../evil', bots: team(3) }).errors[0], /not a valid island name/);
  assert.match(validateConfig({ timezone: 'UTC', bots: [bot('a'), bot('a'), bot('c')] }).errors[0], /more than one bot/);
  assert.match(validateConfig({ timezone: 'UTC', bots: 'all of them' }).errors[0], /expected a list/);
  assert.match(validateConfig({ timezone: 'UTC', bots: [1, 2, 3] }).errors[0], /expected an object/);
  assert.match(validateConfig(null).errors[0], /one JSON object/);
  assert.match(validateConfig([]).errors[0], /one JSON object/);
});

test('unknown fields warn and do not reach the island', () => {
  const r = validateConfig({ timezone: 'UTC', timezon: 'x', bots: team(3).map((b) => ({ ...b, mood: 'great' })) });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.startsWith('timezon:')));
  assert.ok(r.warnings.some((w) => w.includes('mood')));
  assert.equal(r.config.timezon, undefined);
  assert.equal(r.config.bots[0].mood, undefined);
});

test('nothing is hardcoded: ids drive everything, names come from the file', () => {
  const r = validateConfig({ workspace: 'Anything at all', timezone: 'Asia/Tokyo', bots: [{ name: 'Web Search' }, { name: 'B' }, { name: 'C' }] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.bots[0].id, 'web-search');
  assert.equal(r.config.workspace, 'Anything at all');
});

test('secret keys are refused, anon keys pass', () => {
  assert.equal(secretKeyProblem(jwt({ role: 'anon' })), null);
  assert.equal(secretKeyProblem('sb_publishable_abc123'), null);
  assert.equal(secretKeyProblem(undefined), null);
  assert.match(secretKeyProblem(jwt({ role: 'service_role' })), /service_role/);
  assert.match(secretKeyProblem('sb_secret_abc123'), /secret key/);
  assert.match(secretKeyProblem('random-string'), /not a Supabase anon key/);
  const r = validateConfig({ timezone: 'UTC', bots: team(3), source: { mode: 'live', url: 'https://x.supabase.co/rest/v1/events', anon_key: jwt({ role: 'service_role' }) } });
  assert.match(r.errors.join(), /source.anon_key/);
  assert.equal(r.config, null);
});

test('a key under any other name in the file is refused', () => {
  const a = validateConfig({ timezone: 'UTC', bots: team(3), service_role_key: 'abc' });
  assert.match(a.errors.join(), /looks like a secret/);
  const b = validateConfig({ timezone: 'UTC', bots: team(3), source: { mode: 'demo', write_key: 'abc' } });
  assert.match(b.errors.join(), /must stay in the grok bot/);
});

test('source validation', () => {
  assert.match(validateConfig({ timezone: 'UTC', bots: team(3), source: { mode: 'nope' } }).errors[0], /not one of/);
  assert.match(validateConfig({ timezone: 'UTC', bots: team(3), source: { mode: 'live' } }).errors[0], /needs the URL/);
  assert.match(validateConfig({ timezone: 'UTC', bots: team(3), source: { mode: 'replay', speed: 50 } }).errors[0], /1 to 20/);
});

test('normalizeColor', () => {
  assert.equal(normalizeColor('#FFF'), '#ffffff');
  assert.equal(normalizeColor(' #3FD18B '), '#3fd18b');
  assert.equal(normalizeColor('red'), null);
  assert.equal(normalizeColor(12), null);
  assert.equal(normalizeColor('#12345'), null);
});

test('loadConfig: bundled, URL, missing file falls back, html fallback is no config, bad JSON is an error', async () => {
  const examples = { 'example-3': { timezone: 'UTC', bots: team(3) } };
  const res = (status, text) => ({ ok: status < 400, status, text: async () => text });
  const a = await loadConfig({ param: 'example-3', examples, defaultExample: 'example-3', fetchImpl: async () => { throw new Error('no fetch'); } });
  assert.equal(a.isExample, true);
  const b = await loadConfig({ param: null, examples, defaultExample: 'example-3', fetchImpl: async () => res(404, '') });
  assert.equal(b.isExample, true);
  const c = await loadConfig({ param: null, examples, defaultExample: 'example-3', fetchImpl: async () => res(200, '<!doctype html><html>') });
  assert.equal(c.isExample, true);
  const d = await loadConfig({ param: null, examples, defaultExample: 'example-3', fetchImpl: async () => res(200, JSON.stringify({ timezone: 'UTC', bots: team(2) })) });
  assert.equal(d.config.bots.length, 2);
  await assert.rejects(loadConfig({ param: null, examples, defaultExample: 'example-3', fetchImpl: async () => res(200, '{oops') }), ConfigError);
  await assert.rejects(loadConfig({ param: 'https://x/c.json', examples, defaultExample: 'example-3', fetchImpl: async () => res(500, '') }), /Could not load/);
  await assert.rejects(loadConfig({ param: 'https://x/c.json', examples, defaultExample: 'example-3', fetchImpl: async () => { throw new Error('down'); } }), /Could not load/);
  await assert.rejects(loadConfig({ param: 'example-99', examples, defaultExample: 'example-3' }), /no bundled config/);
  await assert.rejects(loadConfig({ param: 'https://x/c.json', examples, defaultExample: 'example-3', fetchImpl: async () => res(200, JSON.stringify({ bots: [] })) }), /problem/);
});
