// Time zone helpers. Everything takes epoch milliseconds so tests and capture mode stay deterministic.

const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(ms, timeZone) {
  const out = {};
  for (const part of formatter(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

// 0 at local midnight, 0.5 at local noon.
export function dayFraction(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return (p.hour * 3600 + p.minute * 60 + p.second) / 86400;
}

// A local calendar date such as 2026-11-09. Two events count on the same day when these match.
export function dayKey(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
