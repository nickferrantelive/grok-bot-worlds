// Loads and validates the team config. Nothing here knows about any one team.

import { isValidTimeZone } from './time.js';

// A team is 3 or 4 bots counting the lead. The lead is held apart, so config.bots has one fewer.
export const TEAM_SIZES = [3, 4];
export const MIN_BOTS = TEAM_SIZES[0] - 1;
export const MAX_BOTS = TEAM_SIZES[TEAM_SIZES.length - 1] - 1;
export const teamSize = (config) => config.bots.length + 1;

const TOP_KEYS = new Set(['workspace', 'island', 'timezone', 'bots', 'lead', 'source']);
const BOT_KEYS = new Set(['id', 'name', 'role', 'color', 'colour', 'schedule', 'lead']);
const SOURCE_KEYS = new Set(['mode', 'url', 'anon_key', 'replay', 'speed']);
const SOURCE_MODES = new Set(['demo', 'replay', 'live']);
const ISLAND_NAME = /^[a-z0-9_-]+$/;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// Used only when a bot has no colour. Spread around the wheel so that a team never reads as one hue.
const PALETTE = ['#3fd18b', '#ff7a2f', '#ff4d8d', '#4d8dff', '#b48cff', '#f5c518', '#2ec4c4', '#ff5d5d', '#8bd13f', '#d9a066', '#6a7bff', '#e06cff'];

export function normalizeColor(value) {
  if (typeof value !== 'string' || !HEX.test(value.trim())) return null;
  const v = value.trim().toLowerCase();
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return v;
}

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const text = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The page only ever reads. A key that can write must never reach it, so this refuses to run with one.
export function secretKeyProblem(key) {
  if (key === undefined || key === null || key === '') return null;
  if (typeof key !== 'string') return 'must be text';
  if (/^sb_secret_/i.test(key)) {
    return 'this is a Supabase secret key. It can write, so it must never be in a page. Use the publishable (anon) key here and keep the secret key in the grok bot.';
  }
  if (/^sb_publishable_/i.test(key)) return null;
  const payload = decodeJwtPayload(key);
  if (payload) {
    if (payload.role === 'anon') return null;
    return `this key has the role "${payload.role ?? 'unknown'}". Only the public anon key belongs in a page. Keep anything that can write in the grok bot.`;
  }
  return 'this is not a Supabase anon key. Only the public, read-only anon key belongs in a page.';
}

function checkBot(raw, where, errors, warnings, usedIds) {
  if (!isPlainObject(raw)) {
    errors.push(`${where}: expected an object like {"id":"research","name":"research","color":"#3fd18b"}, got ${JSON.stringify(raw)}`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!BOT_KEYS.has(key)) warnings.push(`${where}.${key}: unknown field, ignored`);
  }
  let id = raw.id;
  if (id === undefined || id === null || id === '') {
    if (typeof raw.name === 'string' && slug(raw.name)) {
      id = slug(raw.name);
    } else {
      errors.push(`${where}.id: every bot needs an id or a name`);
      return null;
    }
  }
  if (typeof id !== 'string' && typeof id !== 'number') {
    errors.push(`${where}.id: expected text, got ${JSON.stringify(id)}`);
    return null;
  }
  id = String(id).trim();
  if (!id || id.length > 64) {
    errors.push(`${where}.id: must be 1 to 64 characters`);
    return null;
  }
  if (usedIds.has(id)) {
    errors.push(`${where}.id: "${id}" is used by more than one bot. Events find their bot by id, so each must be unique.`);
    return null;
  }
  usedIds.add(id);

  let name = raw.name ?? id;
  if (typeof name !== 'string' && typeof name !== 'number') {
    errors.push(`${where}.name: expected text, got ${JSON.stringify(name)}`);
    return null;
  }
  name = String(name).trim() || id;
  if (name.length > 40) {
    warnings.push(`${where}.name: longer than 40 characters, shortened`);
    name = name.slice(0, 40);
  }

  for (const field of ['role', 'schedule']) {
    if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== 'string') {
      errors.push(`${where}.${field}: expected text, got ${JSON.stringify(raw[field])}`);
    }
  }

  const rawColor = raw.color ?? raw.colour;
  let color = null;
  if (rawColor !== undefined && rawColor !== null) {
    color = normalizeColor(rawColor);
    if (!color) errors.push(`${where}.color: ${JSON.stringify(rawColor)} is not a hex colour like #3fd18b`);
  }
  return {
    id,
    name,
    role: typeof raw.role === 'string' ? raw.role : '',
    schedule: typeof raw.schedule === 'string' ? raw.schedule : '',
    color,
    lead: raw.lead === true,
  };
}

function checkSource(raw, errors, warnings) {
  if (raw === undefined || raw === null) return { mode: 'demo' };
  if (!isPlainObject(raw)) {
    errors.push(`source: expected an object like {"mode":"demo"}, got ${JSON.stringify(raw)}`);
    return { mode: 'demo' };
  }
  for (const key of Object.keys(raw)) {
    if (!SOURCE_KEYS.has(key)) {
      if (/key|secret|token|password/i.test(key)) {
        errors.push(`source.${key}: only source.anon_key may hold a key. A key that can write must stay in the grok bot, never in this file.`);
      } else {
        warnings.push(`source.${key}: unknown field, ignored`);
      }
    }
  }
  const mode = raw.mode ?? 'demo';
  if (!SOURCE_MODES.has(mode)) errors.push(`source.mode: ${JSON.stringify(mode)} is not one of demo, replay, live`);
  if (raw.url !== undefined && typeof raw.url !== 'string') errors.push('source.url: expected a URL as text');
  if (raw.replay !== undefined && typeof raw.replay !== 'string') errors.push('source.replay: expected a URL as text');
  if (raw.speed !== undefined && (typeof raw.speed !== 'number' || raw.speed < 1 || raw.speed > 20)) {
    errors.push(`source.speed: ${JSON.stringify(raw.speed)} must be a number from 1 to 20`);
  }
  const problem = secretKeyProblem(raw.anon_key);
  if (problem) errors.push(`source.anon_key: ${problem}`);
  if (mode === 'live' && !raw.url) errors.push('source.url: live mode needs the URL of a JSON feed or a Supabase events table');
  return { mode, url: raw.url, anon_key: problem ? undefined : raw.anon_key, replay: raw.replay, speed: raw.speed };
}

// Returns { config, source, errors, warnings }. config is null when there are errors.
export function validateConfig(raw, { defaultTimeZone = 'UTC' } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { config: null, source: null, errors: ['The config must be one JSON object with workspace, island, timezone and bots.'], warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) {
      if (/secret|service|write|password/i.test(key)) {
        errors.push(`${key}: this looks like a secret. A key that can write must stay in the grok bot, never in this file.`);
      } else {
        warnings.push(`${key}: unknown field, ignored`);
      }
    }
  }

  let workspace = raw.workspace;
  if (workspace === undefined || workspace === null || workspace === '') {
    workspace = 'My workspace';
    warnings.push('workspace: missing, showing "My workspace"');
  } else if (typeof workspace !== 'string') {
    errors.push(`workspace: expected text, got ${JSON.stringify(workspace)}`);
  } else if (workspace.length > 60) {
    warnings.push('workspace: longer than 60 characters, shortened');
    workspace = workspace.slice(0, 60);
  }

  let island = raw.island;
  if (island !== undefined && island !== null) {
    if (typeof island !== 'string' || !ISLAND_NAME.test(island)) {
      errors.push(`island: ${JSON.stringify(island)} is not a valid island name. Use lowercase letters, digits and dashes, like orbit-port.`);
      island = null;
    }
  } else {
    island = null;
  }

  let timezone = raw.timezone;
  if (timezone === undefined || timezone === null || timezone === '') {
    timezone = defaultTimeZone;
    warnings.push(`timezone: missing, using ${defaultTimeZone}`);
  } else if (!isValidTimeZone(timezone)) {
    errors.push(`timezone: ${JSON.stringify(timezone)} is not a time zone name. Use one like America/New_York or Europe/London.`);
  }

  const usedIds = new Set();
  let leadRaw = null;
  const workers = [];

  if (raw.lead !== undefined && raw.lead !== null) {
    const lead = checkBot(raw.lead, 'lead', errors, warnings, usedIds);
    if (lead) leadRaw = lead;
  }

  if (!Array.isArray(raw.bots)) {
    errors.push(`bots: expected a list of ${MIN_BOTS} or ${MAX_BOTS} bots in the order the work moves, got ${raw.bots === undefined ? 'nothing' : JSON.stringify(raw.bots)}`);
  } else {
    raw.bots.forEach((b, i) => {
      const bot = checkBot(b, `bots[${i}]`, errors, warnings, usedIds);
      if (!bot) return;
      if (bot.lead) {
        if (leadRaw) errors.push(`bots[${i}]: more than one lead. Only one bot can own the main building.`);
        else leadRaw = bot;
      } else {
        workers.push(bot);
      }
    });
    const hadBadRows = errors.some((e) => e.startsWith('bots['));
    if (!hadBadRows && (workers.length < MIN_BOTS || workers.length > MAX_BOTS)) {
      errors.push(`bots: found ${workers.length} besides the lead. A team is ${TEAM_SIZES.join(' or ')} counting the lead, so list ${MIN_BOTS} or ${MAX_BOTS}.`);
    }
  }

  const source = checkSource(raw.source, errors, warnings);

  if (errors.length) return { config: null, source: null, errors, warnings };

  let fallbackId = 'lead';
  while (usedIds.has(fallbackId)) fallbackId += '-main';
  const lead = {
    id: leadRaw?.id ?? fallbackId,
    name: leadRaw?.name ?? 'lead',
    role: leadRaw?.role ?? '',
    schedule: leadRaw?.schedule ?? '',
    color: leadRaw?.color ?? '#ffffff',
    lead: true,
    index: -1,
  };
  const bots = workers.map((b, i) => ({
    id: b.id,
    name: b.name,
    role: b.role,
    schedule: b.schedule,
    color: b.color ?? PALETTE[i % PALETTE.length],
    index: i,
  }));

  return { config: { workspace, island, timezone, lead, bots }, source, errors, warnings };
}

export class ConfigError extends Error {
  constructor(title, details = []) {
    super(`${title}${details.length ? `: ${details.join('; ')}` : ''}`);
    this.title = title;
    this.details = details;
  }
}

async function fetchJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { cache: 'no-store' });
  } catch (err) {
    throw new ConfigError(`Could not load the config from ${url}`, [`Network error: ${err.message}. Check the address, and that the host allows cross site reads (CORS).`]);
  }
  if (!res.ok) throw new ConfigError(`Could not load the config from ${url}`, [`The server answered HTTP ${res.status}.`]);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`The config at ${url} is not valid JSON`, [err.message]);
  }
}

// Order: ?config=<bundled example or URL>, then ./config.json next to the page, then the bundled example.
export async function loadConfig({ param, examples, defaultExample, fetchImpl = fetch, defaultTimeZone }) {
  let raw;
  let origin;
  if (param && Object.prototype.hasOwnProperty.call(examples, param)) {
    raw = examples[param];
    origin = `bundled ${param}`;
  } else if (param) {
    if (/^example-/.test(param)) {
      throw new ConfigError(`There is no bundled config called ${param}`, [`Bundled configs: ${Object.keys(examples).join(', ')}`]);
    }
    raw = await fetchJson(param, fetchImpl);
    origin = param;
  } else {
    let res = null;
    try {
      res = await fetchImpl('./config.json', { cache: 'no-store' });
    } catch {
      res = null;
    }
    const text = res && res.ok ? await res.text() : null;
    // Some static hosts answer every path with index.html. That means no config, not a broken one.
    if (text !== null && !/^\s*</.test(text)) {
      try {
        raw = JSON.parse(text);
      } catch (err) {
        throw new ConfigError('config.json is not valid JSON', [err.message]);
      }
      origin = 'config.json';
    } else {
      raw = examples[defaultExample];
      origin = `bundled ${defaultExample}`;
    }
  }
  const out = validateConfig(raw, { defaultTimeZone });
  if (out.errors.length) throw new ConfigError(`The config from ${origin} has ${out.errors.length} problem${out.errors.length > 1 ? 's' : ''}`, out.errors);
  return { ...out, origin, isExample: origin.startsWith('bundled') };
}
