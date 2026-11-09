// Demo mode: a believable working day on a loop, built from generic jobs for whatever team the config holds.
// The team is a line: an item enters at the first bot, each done feeds the next bot's working, and the lead
// finishes it at the main building. Never names a real business. Timing is seeded from the team so every run
// looks the same.

import { HANDOFF_SECONDS } from '../route.js';

const JOBS = [
  { keys: ['social', 'mention', 'listen', 'brand', 'buyer', 'research'], start: 'reading mentions', found: ['{n} worth a reply', 'a thread to read'], done: '{n} flagged', ask: 'reply ready to post' },
  { keys: ['inbox', 'mail', 'message', 'reply'], start: 'sorting inbox', found: ['{n} need an answer', 'an urgent message'], done: 'inbox zero', ask: 'reply ready to send' },
  { keys: ['summary', 'report', 'digest', 'draft', 'writer'], start: 'drafting summary', found: ['a number to check'], done: 'summary written', ask: 'summary ready to share' },
  { keys: ['number', 'data', 'metric', 'analytic', 'figure', 'finance', 'billing', 'sales'], start: 'checking numbers', found: ['signups spiked', '{n} rows look wrong'], done: 'numbers checked', ask: 'a fix needs a yes' },
  { keys: ['writer', 'write', 'content', 'post', 'social', 'copy', 'email'], start: 'writing post ideas', found: ['{n} good angles'], done: '{n} ideas saved', ask: 'post ready to publish' },
  { keys: ['watch', 'competitor', 'pricing', 'price', 'market', 'research', 'scout'], start: 'scanning competitors', found: ['a new pricing page', '{n} changes'], done: 'changes logged', ask: 'a price call needed' },
  { keys: ['tidy', 'clean', 'list', 'crm', 'contact'], start: 'cleaning contacts', found: ['{n} duplicates'], done: '{n} merged', ask: 'merge needs a yes' },
  { keys: ['support', 'ticket', 'help', 'customer'], start: 'reviewing tickets', found: ['{n} overdue'], done: 'tickets triaged', ask: 'a refund needs a yes' },
  { keys: ['calendar', 'schedule', 'meeting', 'assistant'], start: 'updating calendar', found: ['a double booking'], done: 'calendar updated', ask: 'a move needs a yes' },
  { keys: ['research', 'notes', 'source', 'scout'], start: 'compiling notes', found: ['{n} sources'], done: 'notes filed', ask: 'report ready to send' },
  { keys: ['qa', 'test', 'monitor', 'dev', 'engineer', 'site'], start: 'testing signup', found: ['a broken link'], done: 'all steps pass', ask: 'fix ready to ship' },
  { keys: ['brief', 'morning', 'news', 'digest'], start: 'preparing brief', found: ['{n} items today'], done: 'brief delivered', ask: 'brief ready to send' },
];

// Every third job, so that a bot with one obvious job does not repeat it all day.
const GENERAL_JOBS = [
  { start: 'reviewing yesterday', found: ['{n} to look at'], done: 'review filed', ask: 'a change needs a yes' },
  { start: 'checking queue', found: ['{n} new items'], done: 'queue clear', ask: 'an item needs a yes' },
];

const LEAD_JOBS = [
  { start: 'reviewing', done: 'signed off' },
  { start: 'checking the batch', done: 'batch out' },
  { start: 'reading handoff', done: 'approved' },
];

export const DEMO_LOOP_SECONDS = 300;

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// The jobs that fit a bot's name and role. A short key matches whole words only, so "mail" is not inside "emails".
function jobsFor(bot) {
  const words = ` ${`${bot.name} ${bot.id} ${bot.role}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return JOBS.filter((job) => job.keys.some((key) => (key.length <= 4 ? words.includes(` ${key} `) || words.includes(` ${key}s `) : words.includes(key))));
}

// This bot's job for its nth turn on the line. It keeps to work that fits, with a general job every third turn so
// that a bot with one obvious job does not repeat it all day.
export function jobForTurn(bot, turn) {
  const fits = jobsFor(bot);
  if (!fits.length) return JOBS[(hashString(bot.id) + turn) % JOBS.length];
  if (turn % 3 === 2) return GENERAL_JOBS[Math.floor(turn / 3) % GENERAL_JOBS.length];
  return fits[turn % fits.length];
}

export const fillCount = (text, v) => text.replace('{n}', String(v));
// The text says who it came from and where it goes, so the feed reads as a line too. That part goes first because
// the feed and the labels cut long lines off at the end.
export const startLine = (job) => job.start;
export const doneLine = (job, v) => fillCount(job.done, v);
export const leadJob = (turn, prev) => {
  const job = LEAD_JOBS[turn % LEAD_JOBS.length];
  return { start: job.start.replace('{prev}', prev.name), done: job.done };
};


// While a bot works it keeps saying how far along it is: a few small updates to the same job.
function progressRows(rows, from, botId, between, rng, share = 1, warm = false) {
  const steps = Math.max(1, Math.round((2 + Math.floor(rng() * 3)) * share));
  let t = from;
  for (let i = 1; i <= steps; i += 1) {
    t += between(1.8, 3.2);
    // Still a beat for the machine, with nothing to say: a progress count is text nobody needs.
    rows.push({ at: t, bot_id: botId, type: 'working', update: true, warm });
  }
  return t + between(1.2, 2.4);
}

// Returns rows of { at, bot_id, type, text, value? }, seconds from the start, oldest first.
// One item at a time walks the line. The next enters as the last one reaches the lead, so the first bot is busy
// again while the lead signs off. A bot waiting on an approval holds up the line behind it, as it would in life.
export function buildDayScript(config, duration = DEMO_LOOP_SECONDS) {
  const rows = [];
  const rng = seeded(hashString(config.bots.map((b) => b.id).join('|')));
  const between = (a, b) => a + (b - a) * rng();
  const count = () => 2 + Math.floor(rng() * 11);
  const turns = new Map();
  const freeAt = new Map();
  const lastBot = config.bots[config.bots.length - 1];
  const turnOf = (id) => {
    const turn = turns.get(id) ?? 0;
    turns.set(id, turn + 1);
    return turn;
  };

  // Everybody already has something on the go when the page opens. A line that starts cold looks like nobody is home.
  const warm = [...config.bots.slice(1), config.lead];
  let asked = false;
  warm.forEach((bot, k) => {
    const isLead = bot.id === config.lead.id;
    const index = config.bots.indexOf(bot);
    const until = 16 * (k + 1);
    let t = 0.5 + k * 0.7;
    do {
      const job = isLead ? leadJob(turnOf(bot.id), lastBot) : jobForTurn(bot, turnOf(bot.id));
      const next = isLead ? null : config.bots[index + 1] ?? config.lead;
      rows.push({ at: t, bot_id: bot.id, type: 'working', text: isLead ? job.start : startLine(job, config.bots[index - 1]), warm: true });
      t = progressRows(rows, t, bot.id, between, rng, 1, true);
      // One early ask, so a visitor or a 20 second film sees a bot waiting for a yes.
      if (k === 0 && !asked) {
        asked = true;
        rows.push({ at: t, bot_id: bot.id, type: 'needs_approval', text: fillCount(job.ask, count()), warm: true });
        t += between(5, 7);
      }
      rows.push({ at: t, bot_id: bot.id, type: 'done', text: isLead ? job.done : doneLine(job, count(), next), warm: true });
      rows.push({ at: t + between(1.5, 2.5), bot_id: bot.id, type: 'idle', text: 'waiting for the next job', warm: true });
      t += 3.4;
    } while (t < until);
    freeAt.set(bot.id, t);
  });

  let itemStart = 1.2;
  let visit = 0;
  for (let item = 0; itemStart < duration; item += 1) {
    let arrive = itemStart;
    let firstFree = itemStart;
    config.bots.forEach((bot, k) => {
      const prev = config.bots[k - 1];
      const next = config.bots[k + 1] ?? config.lead;
      const job = jobForTurn(bot, turnOf(bot.id));
      const v = count();
      let t = Math.max(arrive, freeAt.get(bot.id) ?? 0);
      const start = startLine(job, prev);
      rows.push({ at: t, bot_id: bot.id, type: 'working', text: start });
      t = progressRows(rows, t, bot.id, between, rng);
      if (item === 0 || rng() < 0.7) {
        const line = job.found[Math.floor(rng() * job.found.length)];
        const row = { at: t, bot_id: bot.id, type: 'found', text: fillCount(line, v) };
        if (line.includes('{n}')) row.value = v;
        rows.push(row);
        t += between(3, 6);
      }
      if (visit % 5 === 1) {
        rows.push({ at: t, bot_id: bot.id, type: 'needs_approval', text: fillCount(job.ask, v) });
        t += between(13, 20);
      }
      visit += 1;
      t = progressRows(rows, t, bot.id, between, rng, 0.45);
      rows.push({ at: t, bot_id: bot.id, type: 'done', text: doneLine(job, v, next) });
      rows.push({ at: t + between(1.5, 2.5), bot_id: bot.id, type: 'idle', text: 'waiting for the next job' });
      freeAt.set(bot.id, t + 2.6);
      arrive = t + HANDOFF_SECONDS;
      if (k === 0) firstFree = t + 2.6;
    });

    const job = leadJob(turnOf(config.lead.id), lastBot);
    let t = Math.max(arrive, freeAt.get(config.lead.id) ?? 0);
    rows.push({ at: t, bot_id: config.lead.id, type: 'working', text: job.start });
    // The next item goes in as soon as the first station is free, so the line stays full.
    itemStart = firstFree + between(0.8, 2.4);
    t = progressRows(rows, t, config.lead.id, between, rng, 1.8);
    rows.push({ at: t, bot_id: config.lead.id, type: 'done', text: job.done });
    rows.push({ at: t + between(1.5, 2.5), bot_id: config.lead.id, type: 'idle', text: 'waiting for the next batch' });
    freeAt.set(config.lead.id, t + 2.6);
  }

  // The day ends wherever the clock says. An approval whose answer falls past the end must not be left in.
  const kept = rows.filter((r) => r.at < duration).sort((a, b) => a.at - b.at);
  return kept.filter((r, i) => r.type !== 'needs_approval' || kept.slice(i + 1).some((x) => x.bot_id === r.bot_id && x.type === 'done'));
}

export function createDemoSource({ config, store, now }) {
  const rows = buildDayScript(config);
  let elapsed = 0;
  let cursor = 0;
  return {
    mode: 'demo',
    now,
    start() {},
    update(dt) {
      elapsed += dt;
      if (elapsed >= DEMO_LOOP_SECONDS) {
        elapsed -= DEMO_LOOP_SECONDS;
        cursor = 0;
        store.reset();
      }
      while (cursor < rows.length && rows[cursor].at <= elapsed) {
        const { at, ...row } = rows[cursor];
        store.ingest({ ...row, id: `demo-${cursor}`, timestamp: new Date(now()).toISOString() });
        cursor += 1;
      }
    },
    status() {
      return { state: 'ok', label: 'demo', detail: '' };
    },
    dispose() {},
  };
}
