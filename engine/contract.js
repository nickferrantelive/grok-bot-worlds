// Catches a scene that breaks the contract with a clear line, rather than a stack trace ten frames later.

import * as THREE from 'three';
import { ConfigError, TEAM_SIZES, teamSize } from './config.js';

// Stops the page: without these the engine has nothing to draw or nowhere to put the camera.
export function checkIsland(island, name, config) {
  const problems = [];
  if (!island || typeof island !== 'object') {
    throw new ConfigError(`The island "${name}" returned nothing from createIsland`, []);
  }
  for (const fn of ['setDaylight', 'applyEvent', 'update', 'home', 'dispose']) {
    if (typeof island[fn] !== 'function') problems.push(`${fn} is missing or not a function`);
  }
  if (!(island.worlds instanceof Map)) problems.push('worlds must be a Map of bot id to world');
  else {
    for (const bot of config.bots) {
      const world = island.worlds.get(bot.id);
      if (!world) problems.push(`worlds has no entry for bot "${bot.id}"`);
      else if (!world.anchor || !world.focus?.position || !world.focus?.target) problems.push(`world "${bot.id}" needs anchor and focus {position, target}`);
    }
  }
  if (!island.main?.anchor || !island.main?.focus?.position) problems.push('main needs anchor and focus {position, target}');
  if (!problems.length) {
    const framing = island.home(16 / 9);
    if (!framing?.position?.isVector3 || !framing?.target?.isVector3) problems.push('home(aspect) must return {position, target} as Vector3');
  }
  if (problems.length) throw new ConfigError(`The island "${name}" breaks the contract`, problems);
}

const anchorPoint = (a) => (a.isVector3 ? a.clone() : a.getWorldPosition(new THREE.Vector3()));
const across = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const isPoint = (p) => [p?.x, p?.y, p?.z].every(Number.isFinite) && typeof p?.distanceTo === 'function';

// Does not stop the page: a viewer would rather see an island whose result does not fly than an error.
// check-island turns each line into a failure. Returns a list of plain sentences.
export function checkRoutes(island, config) {
  const problems = [];
  const stations = [...config.bots.map((b) => [b.id, island.worlds.get(b.id)?.anchor]), [config.lead.id, island.main?.anchor]]
    .filter(([, a]) => a)
    .map(([id, a]) => [id, anchorPoint(a)]);
  const nearest = (p) => stations.reduce((best, s) => (across(p, s[1]) < across(p, best[1]) ? s : best), stations[0])[0];

  config.bots.forEach((bot, i) => {
    const world = island.worlds.get(bot.id);
    const route = world?.route;
    const next = (config.bots[i + 1] ?? config.lead).id;
    if (!Array.isArray(route)) return problems.push(`world "${bot.id}" has no route`);
    if (route.length < 2) return problems.push(`route of "${bot.id}" needs at least 2 points, has ${route.length}`);
    if (!route.every(isPoint)) return problems.push(`route of "${bot.id}" must be a list of Vector3 with finite numbers`);
    const end = route.length - 1;
    const handoff = world.handoff ?? end;
    if (!Number.isInteger(handoff) || handoff < 1 || handoff > end) return problems.push(`handoff of "${bot.id}" must be a point index from 1 to ${end}, got ${JSON.stringify(handoff)}`);
    const first = nearest(route[0]);
    if (first !== bot.id) problems.push(`route of "${bot.id}" starts nearer "${first}" than its own bot`);
    const reached = nearest(route[handoff]);
    if (reached !== next) problems.push(`route of "${bot.id}" hands off nearer "${reached}" than the next station "${next}"`);
    const last = nearest(route[end]);
    if (last !== config.lead.id) problems.push(`route of "${bot.id}" ends nearer "${last}" than the main building`);
    return undefined;
  });
  return problems;
}

// The sizes this island's layout has placements for.
export function islandTeamSizes(module) {
  const sizes = module?.teamSizes;
  return Array.isArray(sizes) && sizes.length ? sizes : TEAM_SIZES;
}

export function checkTeamSize(module, name, config) {
  const sizes = islandTeamSizes(module);
  if (!sizes.includes(teamSize(config))) {
    throw new ConfigError(`The island "${name}" is laid out for a team of ${sizes.join(' or ')}`, [
      `This config has a team of ${teamSize(config)} counting the lead. Use one that fits, or pick another island.`,
    ]);
  }
}
