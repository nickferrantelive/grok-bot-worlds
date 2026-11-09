import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { nextStationId, routeLeg, routeLength, pointAlongRoute, doneFields } from '../../route.js';
import { checkIsland, checkRoutes, checkTeamSize, islandTeamSizes } from '../../contract.js';
import { validateConfig } from '../../config.js';

const v = (x, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const config = validateConfig({ timezone: 'UTC', bots: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }] }).config;
const place = { a: 0, b: 10, c: 25, lead: 50 };
const anchorAt = (x) => {
  const o = new THREE.Object3D();
  o.position.set(x, 2, 0);
  return o;
};
const focus = { position: v(0, 5, 5), target: v(0) };

// A sound island of three stations and a main building off at one end, nothing in the middle.
function island() {
  const worlds = new Map();
  worlds.set('a', { anchor: anchorAt(place.a), focus, route: [v(0), v(5, 1), v(10), v(25), v(50)], handoff: 2 });
  worlds.set('b', { anchor: anchorAt(place.b), focus, route: [v(10), v(25), v(50)], handoff: 1 });
  worlds.set('c', { anchor: anchorAt(place.c), focus, route: [v(25), v(40, 2), v(50)] });
  return {
    worlds,
    main: { anchor: anchorAt(place.lead), focus },
    setDaylight() {},
    applyEvent() {},
    update() {},
    dispose() {},
    home: () => ({ position: v(0, 10, 20), target: v(0) }),
  };
}

test('the line runs through the bots in order and ends at the lead', () => {
  assert.equal(nextStationId(config, 'a'), 'b');
  assert.equal(nextStationId(config, 'c'), config.lead.id);
  assert.equal(nextStationId(config, config.lead.id), null);
  assert.equal(nextStationId(config, 'stranger'), null);
});

test('a done plays one leg: up to the next station, or all of it with no handoff', () => {
  const i = island();
  assert.equal(routeLeg(i.worlds.get('a')).length, 3);
  assert.equal(routeLeg(i.worlds.get('c')).length, 3);
  assert.equal(routeLeg({}), null);
  assert.equal(routeLeg(undefined), null);
  const fromLead = doneFields(config, config.lead.id, i.main);
  assert.deepEqual(fromLead, { next: null, route: null });
  const fromA = doneFields(config, 'a', i.worlds.get('a'));
  assert.equal(fromA.next, 'b');
  assert.ok(fromA.route[fromA.route.length - 1].equals(v(10)));
  assert.equal(doneFields(config, 'a', {}).route, null, 'an island with no route yet does not throw');
});

test('pointAlongRoute goes by distance, however uneven the points', () => {
  const route = [v(0), v(1), v(10)];
  const out = v(0);
  assert.equal(routeLength(route), 10);
  assert.ok(pointAlongRoute(route, 0.5, out).equals(v(5)));
  assert.ok(pointAlongRoute(route, 0.05, out).equals(v(0.5)));
  assert.ok(pointAlongRoute(route, -1, out).equals(v(0)));
  assert.ok(pointAlongRoute(route, 2, out).equals(v(10)));
  assert.ok(pointAlongRoute([v(3), v(3)], 0.5, out).equals(v(3)), 'a zero length leg does not divide by zero');
  assert.ok(pointAlongRoute([v(3)], 0.5, out).equals(v(3)));
});

test('a sound line passes, with the main building at one end rather than the middle', () => {
  assert.deepEqual(checkRoutes(island(), config), []);
});

test('route checks name what is wrong', () => {
  const problem = (edit) => {
    const i = island();
    edit(i);
    return checkRoutes(i, config).join('; ');
  };
  assert.match(problem((i) => { delete i.worlds.get('a').route; }), /"a" has no route/);
  assert.match(problem((i) => { i.worlds.get('a').route = [v(0)]; }), /at least 2 points/);
  assert.match(problem((i) => { i.worlds.get('b').route = [v(10), { x: 1, y: NaN, z: 0 }]; }), /finite/);
  assert.match(problem((i) => { i.worlds.get('a').handoff = 9; }), /handoff of "a"/);
  assert.match(problem((i) => { i.worlds.get('a').handoff = 0; }), /handoff of "a"/);
  assert.match(problem((i) => { i.worlds.get('a').route[0] = v(25); }), /starts nearer "c"/);
  assert.match(problem((i) => { i.worlds.get('a').handoff = 3; }), /hands off nearer "c" than the next station "b"/);
  assert.match(problem((i) => { i.worlds.get('c').route = [v(25), v(26)]; }), /hands off nearer "c" than the next station "lead"/);
  assert.match(problem((i) => { i.worlds.get('b').route = [v(10), v(25)]; i.worlds.get('b').handoff = 1; }), /ends nearer "c" than the main building/);
});

test('a tall main building does not fool the route check: nearest is across the ground', () => {
  const i = island();
  i.main.anchor.position.y = 400;
  assert.deepEqual(checkRoutes(i, config), []);
});

test('the island must bring its own overview camera', () => {
  assert.doesNotThrow(() => checkIsland(island(), 'x', config));
  const noHome = island();
  delete noHome.home;
  assert.throws(() => checkIsland(noHome, 'x', config), /breaks the contract.*home is missing/);
  const badHome = island();
  badHome.home = () => ({ position: [0, 1, 2] });
  assert.throws(() => checkIsland(badHome, 'x', config), /must return \{position, target\}/);
  const noWorld = island();
  noWorld.worlds.delete('b');
  assert.throws(() => checkIsland(noWorld, 'x', config), /no entry for bot "b"/);
  assert.throws(() => checkIsland(null, 'x', config), /returned nothing/);
});

test('team sizes: a declared size is enforced, the default takes both', () => {
  assert.deepEqual(islandTeamSizes({}), [3, 4]);
  assert.deepEqual(islandTeamSizes({ teamSizes: [3] }), [3]);
  assert.doesNotThrow(() => checkTeamSize({}, 'x', config));
  assert.doesNotThrow(() => checkTeamSize({ teamSizes: [4] }, 'x', config));
  assert.throws(() => checkTeamSize({ teamSizes: [3] }, 'arctic', config), /laid out for a team of 3.*team of 4 counting the lead/);
});
