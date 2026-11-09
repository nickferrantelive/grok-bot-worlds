// The one event store. Sources push events in, the island and the UI listen.

import { dayKey } from './time.js';

export const EVENT_TYPES = ['idle', 'working', 'found', 'done', 'needs_approval'];
const TYPES = new Set(EVENT_TYPES);
const MAX_RECENT = 6;
const MAX_TEXT = 200;
const MAX_SEEN = 5000;
const VALUE_CEILING = 1000;

// 0.25 to 1 on a log scale, so 3 leads and 300 leads both read, and a dollar figure does not blow the scale.
export function intensityFromValue(value) {
  if (value === undefined || value === null) return 0.5;
  if (!(value > 0)) return 0.25;
  const scaled = Math.log10(1 + value) / Math.log10(1 + VALUE_CEILING);
  return Math.min(1, 0.25 + 0.75 * scaled);
}

function parseTimestamp(raw, nowMs) {
  if (raw === undefined || raw === null || raw === '') return nowMs;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  return Date.parse(raw);
}

function parseValue(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// Returns { evt } or { error }. Never throws on bad input, since a live feed can hold anything.
export function normalizeEvent(raw, knownBots, nowMs) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object' };
  const botId = raw.bot_id === undefined || raw.bot_id === null ? '' : String(raw.bot_id);
  if (!knownBots.has(botId)) return { error: `unknown bot "${botId.slice(0, 40)}"` };
  if (!TYPES.has(raw.type)) return { error: `unknown type "${String(raw.type).slice(0, 40)}"` };
  const ms = parseTimestamp(raw.timestamp, nowMs);
  if (!Number.isFinite(ms)) return { error: `bad timestamp "${String(raw.timestamp).slice(0, 40)}"` };
  let text = raw.text === undefined || raw.text === null ? '' : String(raw.text);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 1)}…`;
  const value = parseValue(raw.value);
  const evt = {
    bot_id: botId,
    type: raw.type,
    text,
    timestamp: new Date(ms).toISOString(),
    ms,
    intensity: intensityFromValue(value),
  };
  if (value !== undefined) evt.value = value;
  if (raw.warm === true) evt.warm = true;
  if (raw.id !== undefined && raw.id !== null) evt.id = String(raw.id);
  return { evt };
}

function emptyCounts() {
  return { idle: 0, working: 0, found: 0, done: 0, needs_approval: 0, found_value: 0 };
}

export class EventStore {
  constructor({ config, now = () => Date.now() }) {
    this.config = config;
    this.timeZone = config.timezone;
    this.now = now;
    this.knownBots = new Map();
    for (const bot of [config.lead, ...config.bots]) this.knownBots.set(bot.id, bot);
    this.listeners = new Set();
    this.resetListeners = new Set();
    this.clear();
  }

  clear() {
    this.recent = [];
    this.counts = new Map();
    this.seen = new Set();
    this.seenOrder = [];
    this.rejected = 0;
    this.lastProblem = null;
    this.bots = new Map();
    for (const id of this.knownBots.keys()) {
      this.bots.set(id, {
        activity: 'idle',
        activityMs: -Infinity,
        pending: null,
        lastDoneMs: -Infinity,
        lastEvent: null,
      });
    }
  }

  // A new day in the demo loop, or the start of a replay loop.
  reset() {
    this.clear();
    for (const fn of this.resetListeners) fn();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onReset(fn) {
    this.resetListeners.add(fn);
    return () => this.resetListeners.delete(fn);
  }

  dedupeKey(evt) {
    return evt.id !== undefined ? `id:${evt.id}` : `${evt.bot_id}|${evt.type}|${evt.ms}|${evt.text}`;
  }

  // Returns the stored event, or null when it was bad or a repeat. Bad rows are counted, never thrown.
  ingest(raw, { catchup = false } = {}) {
    const { evt, error } = normalizeEvent(raw, this.knownBots, this.now());
    if (error) {
      // A plain JSON feed serves the same bad row on every poll. Count it once.
      let key;
      try {
        key = `bad:${JSON.stringify(raw)}`.slice(0, 300);
      } catch {
        key = 'bad:unreadable';
      }
      if (!this.seen.has(key)) {
        this.rememberKey(key);
        this.rejected += 1;
        this.lastProblem = error;
        console.warn(`Event skipped: ${error}`);
      }
      return null;
    }
    const key = this.dedupeKey(evt);
    if (this.seen.has(key)) return null;
    this.rememberKey(key);

    const bot = this.bots.get(evt.bot_id);
    // A second working from a bot already at work is an update to the same job: "scanning, 120 of 340".
    const isUpdate = evt.type === 'working' && bot.onJob === true;
    if (evt.type === 'working') bot.onJob = true;
    else if (evt.type === 'done' || evt.type === 'idle') bot.onJob = false;
    this.applyState(bot, evt);
    evt.activity = bot.activity;
    evt.pending = bot.pending !== null;
    evt.catchup = catchup;
    if (!bot.lastEvent || evt.ms >= bot.lastEvent.ms) bot.lastEvent = evt;

    evt.update = isUpdate;
    if (!isUpdate) this.count(evt);
    this.remember(evt);
    for (const fn of this.listeners) fn(evt);
    return evt;
  }

  rememberKey(key) {
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > MAX_SEEN) this.seen.delete(this.seenOrder.shift());
  }

  // Oldest first, so that a done which arrives in the same batch as its approval clears it.
  ingestBatch(rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const stamped = list.map((row, i) => ({ row, i, ms: row && parseTimestamp(row.timestamp, this.now()) }));
    stamped.sort((a, b) => (a.ms === b.ms || !Number.isFinite(a.ms) || !Number.isFinite(b.ms) ? a.i - b.i : a.ms - b.ms));
    const out = [];
    for (const { row } of stamped) {
      const opt = typeof opts === 'function' ? opts(row) : opts;
      const evt = this.ingest(row, opt);
      if (evt) out.push(evt);
    }
    return out;
  }

  applyState(bot, evt) {
    // Approval first. A done clears only an approval from before it, so late rows cannot clear a newer ask.
    if (evt.type === 'needs_approval') {
      if (evt.ms >= bot.lastDoneMs) {
        if (!bot.pending || evt.ms >= bot.pending.ms) {
          bot.pending = { ms: evt.ms, text: evt.text, bot_id: evt.bot_id, timestamp: evt.timestamp };
        }
      }
    } else if (evt.type === 'done') {
      if (evt.ms > bot.lastDoneMs) bot.lastDoneMs = evt.ms;
      if (bot.pending && evt.ms >= bot.pending.ms) bot.pending = null;
    }
    // A late row must not rewind what the bot is doing now.
    if (evt.ms >= bot.activityMs) {
      bot.activityMs = evt.ms;
      if (evt.type === 'working' || evt.type === 'found') bot.activity = 'working';
      else bot.activity = 'idle';
    }
  }

  count(evt) {
    const key = dayKey(evt.ms, this.timeZone);
    let row = this.counts.get(key);
    if (!row) {
      row = emptyCounts();
      this.counts.set(key, row);
      if (this.counts.size > 8) {
        const oldest = [...this.counts.keys()].sort()[0];
        this.counts.delete(oldest);
      }
    }
    row[evt.type] += 1;
    if (evt.type === 'found' && evt.value !== undefined) row.found_value += evt.value;
  }

  remember(evt) {
    let i = this.recent.length;
    while (i > 0 && this.recent[i - 1].ms > evt.ms) i -= 1;
    this.recent.splice(i, 0, evt);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
  }

  // Newest first.
  lastEvents(limit = MAX_RECENT) {
    return this.recent.slice(-limit).reverse();
  }

  todayCounts(nowMs = this.now()) {
    return { ...emptyCounts(), ...(this.counts.get(dayKey(nowMs, this.timeZone)) ?? {}) };
  }

  // Newest first. One row per waiting bot, however many times it asked.
  pendingApprovals() {
    const rows = [];
    for (const [id, bot] of this.bots) {
      if (bot.pending) rows.push({ ...bot.pending, bot: this.knownBots.get(id) });
    }
    return rows.sort((a, b) => b.ms - a.ms);
  }

  botState(id) {
    return this.bots.get(id) ?? null;
  }
}
