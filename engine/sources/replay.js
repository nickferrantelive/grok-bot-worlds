// Replay mode: saved events at 1x to 20x, driven by the engine clock. Used for videos.

import { buildDayScript } from './demo.js';

export const MIN_SPEED = 1;
export const MAX_SPEED = 20;

export function clampSpeed(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, n));
}

// Accepts a plain list of events, or { speed, loop, lead_in, events }. Returns { events, speed, loop, leadIn, errors }.
export function parseReplayFile(data) {
  const body = Array.isArray(data) ? { events: data } : data;
  if (body === null || typeof body !== 'object' || !Array.isArray(body.events)) {
    return { errors: ['A replay file is a list of events, or an object with an "events" list.'] };
  }
  if (!body.events.length) return { errors: ['This replay file has no events.'] };
  const events = [];
  let bad = 0;
  for (const row of body.events) {
    const ms = row && Date.parse(row.timestamp);
    if (Number.isFinite(ms)) events.push({ row, ms });
    else bad += 1;
  }
  if (!events.length) return { errors: ['No event in this replay file has a readable timestamp.'] };
  events.sort((a, b) => a.ms - b.ms);
  return {
    events,
    bad,
    speed: body.speed === undefined ? undefined : clampSpeed(body.speed),
    loop: body.loop,
    leadIn: typeof body.lead_in === 'number' ? Math.max(0, body.lead_in) : 1.5,
    errors: [],
  };
}

export function createReplaySource({ store, file, speed, loop = true, tail = 6 }) {
  const parsed = parseReplayFile(file);
  if (parsed.errors.length) throw new Error(parsed.errors[0]);
  const rate = clampSpeed(speed ?? parsed.speed ?? 1);
  const shouldLoop = parsed.loop === undefined ? loop : parsed.loop && loop;
  const firstMs = parsed.events[0].ms;
  const lastMs = parsed.events[parsed.events.length - 1].ms;
  const startMs = firstMs - parsed.leadIn * 1000 * rate;
  let replayMs = startMs;
  let cursor = 0;
  let waitedTail = 0;
  let finished = false;

  return {
    mode: 'replay',
    speed: rate,
    // The clock the store, the today counts and the daylight all read in replay mode.
    now: () => replayMs,
    start() {},
    update(dt) {
      if (finished) return;
      replayMs += dt * 1000 * rate;
      while (cursor < parsed.events.length && parsed.events[cursor].ms <= replayMs) {
        store.ingest(parsed.events[cursor].row);
        cursor += 1;
      }
      if (cursor >= parsed.events.length) {
        waitedTail += dt;
        if (waitedTail >= tail) {
          if (shouldLoop) {
            replayMs = startMs;
            cursor = 0;
            waitedTail = 0;
            store.reset();
          } else {
            replayMs = Math.max(replayMs, lastMs);
            finished = true;
          }
        }
      }
    },
    status() {
      const matched = store.rejected;
      let detail = '';
      if (matched) detail = `${matched} event${matched > 1 ? 's' : ''} skipped: ${store.lastProblem}`;
      return { state: matched ? 'warn' : 'ok', label: `replay ${rate}x`, detail };
    },
    dispose() {},
  };
}

// A short, self contained script for whatever team the config holds. All five events inside 20 s at 6x.
// Two items walking the line. Everything fits inside a 20 second video at its own speed of 6x, including the
// first item reaching the lead. Gaps are in replay seconds: 18 is the 3 second handoff at 6x.
export function buildScriptedReplay(config, startIso = '2026-03-16T15:00:00Z') {
  const start = Date.parse(startIso);
  // Real speed, and the same busy line as the demo, so a film shows what the live board shows.
  const rows = buildDayScript(config, 120);
  return {
    speed: 1,
    lead_in: 0,
    events: rows.map(({ at, bot_id, type, text, value, warm }, i) => {
      const row = { id: `scripted-${i}`, bot_id, type, text, timestamp: new Date(start + at * 1000).toISOString() };
      if (value !== undefined) row.value = value;
      if (warm) row.warm = true;
      return row;
    }),
  };
}
