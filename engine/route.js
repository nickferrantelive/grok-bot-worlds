// The line of work: config.bots in order, then the lead at the main building. Each world's route is the path a
// done result travels. Pure and free of the page, so tests and islands can both use it.

// Demo and the scripted replay send the next bot's working this long after a done. Islands land the result first.
export const HANDOFF_SECONDS = 3;

// The station after this bot: the next bot, or the lead for the last bot. null for the lead, where the line ends.
export function nextStationId(config, botId) {
  const i = config.bots.findIndex((b) => b.id === botId);
  if (i < 0) return null;
  return (config.bots[i + 1] ?? config.lead).id;
}

// The part of a route played by one done: up to and including the next station.
export function routeLeg(world) {
  if (!Array.isArray(world?.route) || !world.route.length) return null;
  const end = Number.isInteger(world.handoff) ? world.handoff : world.route.length - 1;
  return world.route.slice(0, end + 1);
}

// What the engine adds to a done event. An island with no route yet gets route null and must cope.
export function doneFields(config, botId, world) {
  return { next: nextStationId(config, botId), route: botId === config.lead.id ? null : routeLeg(world) };
}

export function routeLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += points[i].distanceTo(points[i - 1]);
  return total;
}

// k from 0 to 1 along the route, by distance. Writes into out and returns it.
export function pointAlongRoute(points, k, out) {
  const last = points.length - 1;
  if (k <= 0 || last < 1) return out.copy(points[0]);
  if (k >= 1) return out.copy(points[last]);
  let left = routeLength(points) * k;
  for (let i = 1; i <= last; i += 1) {
    const step = points[i].distanceTo(points[i - 1]);
    if (left <= step) return out.copy(points[i - 1]).lerp(points[i], step > 0 ? left / step : 0);
    left -= step;
  }
  return out.copy(points[last]);
}
