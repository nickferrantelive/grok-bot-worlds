# Island contract

This is the contract between the shared engine and each island scene. A worked example lives in `islands/_placeholder/scene.js`.

**Changed on 2026-11-09 for the line of work layouts.** `home(aspect)` and `route` on every world are now required. The engine no longer places or frames anything for you: there is no default overview, no assumption that the main building is in the middle, and no ring. A team is 3 or 4 bots counting the lead, so `config.bots` holds 2 or 3. Its order is the order of the line.

## Plate islands

The shipped islands stand on `engine/plate/stage.js`: the Cycles frame is the world, and only what moves is live. Read `BUILD_PLATE.md` for how to build one, with `islands/hover-isles/scene.js` as the template. The contract below still applies. The stage fills in `home`, `render`, `resize`, `setDaylight` and `cameraLimits`.

An island may export `exampleTeam`, a config with no `island` field. It is used when nobody asks for a team.

A second `working` from a bot already at work is an update to the same job. It arrives with `evt.update` true, changes the bubble and is not counted as a new start.

## The file

`islands/<name>/scene.js` exports one function. The folder name is the island name, lowercase letters, digits, `-` and `_` only. `?island=<name>` loads it, otherwise `config.island` does.

```js
export async function createIsland({ THREE, scene, camera, renderer, config, quality, assetsBase, mascots }) {
  return {
    // Required
    worlds,                  // Map of bot id to world. One entry for every bot in config.bots.
    main,                    // The main building, belongs to the lead bot.
    setDaylight(t),          // 0 to 1 through the local day. 0 midnight, 0.25 six in the morning, 0.5 noon, 0.75 six in the evening.
    applyEvent(evt, world),  // See "Events". world is an entry of worlds, or main for the lead bot.
    update(dt, t),           // Seconds. dt is clamped by the engine, t is engine time since load.
    home(aspect),            // { position, target } Vector3 pair. Your overview camera for this team size and aspect. Called again on resize.
    dispose(),               // Free geometry, textures, listeners. Remove what you added to scene.

    // Optional
    render(dt, t),           // Draw the frame yourself (post). Default renderer.render(scene, camera).
    resize(width, height),   // CSS pixels. The engine already resized the renderer and the camera.
    cameraLimits,            // See "Camera limits".
  };
}

// Optional. The team sizes your layout has placements for, counting the lead. Default [3, 4].
export const teamSizes = [3];
```

With no `?config=`, the engine picks the bundled example that fits `teamSizes`. A config of a size you did not list gets a clear error page rather than a broken scene.

## What the island receives

| Field | What it is |
|---|---|
| `THREE` | The engine's three.js module. You may also `import * as THREE from 'three'` and `three/addons/...`, both resolve to the same copy. |
| `scene` | An empty `THREE.Scene`. Add everything here. Set `scene.background`, `scene.fog`, `scene.environment` yourself. |
| `camera` | A `PerspectiveCamera`, fov 32. The engine owns its position, rotation and aspect. Read it, do not move it. You may set `near`, `far` and `fov` once during `createIsland`. |
| `renderer` | A `WebGLRenderer` already sized. Output colour space sRGB, tone mapping ACES at exposure 1. Change tone mapping and exposure freely. `shadowMap.enabled` already matches `quality.shadows`. |
| `config` | The validated config, below. |
| `quality` | See "Quality". |
| `assetsBase` | URL of your assets folder, ending in `/`. Files in `islands/<name>/assets/` are served and deployed there. |
| `mascots` | See "Mascots". |

## World

```js
worlds.set(bot.id, {
  anchor,  // Object3D just above the bot's head. The name label hangs here. Follow the bot if it moves or lifts.
  stage,   // Object3D root of this bot's world (the pad, building and ground it stands on).
  focus: { position, target },  // Vector3 pair. Where the camera flies when this world is clicked or has an event.
  route,   // Required. Ordered list of Vector3, world space. See "The line and the route".
  handoff, // Optional. Index in route of the next station. Default is the last point.
  pickRadius, // Optional, world units. How far around anchor a click still counts. Default is from the nearest neighbour.
});
```

`main` has the same `anchor` and `focus`, and no `route`, since the line ends there. `main.anchor` is above the top of the main building: the needs-approval marker sits there.

Every world starts idle. The engine sends no event for that.

**Layout.** Where everything goes is yours: the engine only reads `home`, `focus`, `anchor` and `route`. The main building goes wherever the work ends, usually not the middle of the frame. Keep placements stable from run to run so a bot does not move house.

## The line and the route

`config.bots` in order, then the lead at the main building, is the line of work. Each bot does one step and passes the result on.

`world.route` is the path a `done` result travels: an ordered list of positions that starts at this bot, reaches the next station, and ends at the main building. For the last bot the next station is the main building.

```js
// A team of 3: drill, then tow, then the lead's vault.
worlds.get('drill').route = [drillPad, bendInTheRiver, towPad, riverHead, vaultDoor];
worlds.get('drill').handoff = 2;                  // route[2] is the next station.
worlds.get('tow').route = [towPad, riverHead, vaultDoor];   // handoff defaults to the last point.
```

A `done` arrives with two more fields:

```js
evt.next   // Id of the next station: the next bot, or the lead for the last bot. null when the lead itself is done.
evt.route  // The leg to play: route up to and including handoff. null for the lead.
```

Play the result along `evt.route` in `applyEvent`, unless `evt.catchup`. The engine draws nothing in 3D, so what travels is your design: a crate, a sled of cores, a pod. Rules:

- Reach the end of the leg within 2.5 seconds. Demo and the scripted replay send the next bot's `working` 3 seconds after the `done`, so the result lands, then the next bot starts.
- Never wait for that `working` before moving, and never hold it back. A live team sends what it sends, and at 20x replay it comes much sooner. A new `done` during a run may restart the run.
- A `done` from the lead has no route. Show the finished work arriving at the main building, or the pile growing.
- Follow bends. A straight line between stations rarely follows your terrain, so add as many points as the path needs.

A small helper does the distance arithmetic, so that a run keeps a steady speed however uneven the points are:

```js
import { routeLength, pointAlongRoute } from '../../engine/route.js';

pointAlongRoute(evt.route, k, out);  // k from 0 to 1 along the leg, by distance. Writes out and returns it.
routeLength(evt.route);              // World units.
```

The engine checks each route when the island loads: at least two finite points, `route[0]` nearest this bot's anchor, the next station's point nearest that station's anchor, the last point nearest `main.anchor`. Nearest is measured across the ground, ignoring height, because the main anchor sits on top of a tall building. A broken route logs a console warning and the page carries on. `check-island` reports it as a failure.

## Config the island receives

The engine has validated and normalised this. Anything else in the raw file is not passed on.

```js
{
  workspace: 'my business name',
  island: 'orbit-port',
  timezone: 'America/New_York',
  lead: { id: 'lead', name: 'lead', role: '...', color: '#ffffff', lead: true, index: -1 },
  bots: [
    { id: 'research', name: 'research', role: 'finds what buyers talk about', color: '#3fd18b', schedule: 'mon, thu', index: 0 },
    { id: 'writer', name: 'writer', role: 'turns it into drafts', color: '#ff4d8d', schedule: 'tue, fri', index: 1 },
  ],
}
```

`bots` is 2 or 3 entries, in line order, each gets a world, and the lead is never in it, so the team is 3 or 4 counting the lead. A raw bot with `"lead": true` is moved out to `lead`. With no such bot the engine adds a default white lead. `color` is always `#rrggbb`. Colours are data: never bake one into the design, and always expect any colour, including a dark one or one close to your island's palette.

## Events

```js
applyEvent({
  bot_id: 'research',
  type: 'found',            // idle, working, found, done, needs_approval
  text: 'three new threads',
  timestamp: '2026-11-09T14:31:00Z',
  ms: 1794234660000,        // The same moment in epoch milliseconds.
  value: 3,                 // Optional, raw, found only in practice. Any number.

  // Added by the engine so that you do not have to track state
  intensity: 0.6,           // 0 to 1. From value on a log scale, 0.5 when there is no value. Scale the found effect by this.
  activity: 'working',      // 'idle' or 'working'. What the bot is doing once any one-shot has played.
  pending: false,           // True while this bot has an approval waiting, on every event, until a later done clears it.
  catchup: false,           // True for history on load, and when a new demo day or replay loop resets everyone. Jump to the end state, play no effect or sound.
  next: 'writer',           // done only. See "The line and the route".
  route: [ /* Vector3 */ ], // done only.
}, world);
```

What each event must do:

- `idle` and `working` set an ongoing state. Idle never looks dead.
- `found` and `done` are one-shots that play over the current state, then settle into `evt.activity` on their own. The engine sends nothing more.
- `done` also sends the result down the line, along `evt.route`.
- `needs_approval` turns on a waiting state in the world. It stays on while `evt.pending` is true, through any `working` or `found` that follows. Only a later `done` from that bot clears it, and that `done` arrives with `pending: false`.
- The five states must be tellable apart with no text. The engine draws all text.
- A `found` moment must be visible from anywhere on the island.
- `applyEvent` may be called several times in one frame and must not throw on any `text` or `value`.

Events from the lead bot arrive with `world === main`.

## Time and determinism

Videos step the clock frame by frame (`?capture=1`), so a scene must look the same every run.

- Animate only from `dt` and `t` in `update`. Do not read `Date.now()` or `performance.now()`.
- Use a seeded random. `Math.random` is seeded in capture mode but its sequence depends on call order.
- Do not start CSS or `setTimeout` animation. Do not use `renderer.setAnimationLoop`, the engine runs the loop.
- `createIsland` may take as long as it needs. Await every asset before returning: the first frame goes out right after.

## Daylight

`setDaylight(t)` is called once before the first frame, then whenever `t` moves by a minute or more. In replay it follows the replay clock. Each island keeps its signature light and lets the clock nudge it, so a Neon Atoll stays a night scene at noon. `?daylight=0.8` pins it for look testing.

## Quality

```js
quality = {
  name: 'desktop',   // or 'phone'
  shadows: true,     // phone: false
  post: true,        // phone: false. Skip bloom, depth of field and any composer.
  pixelRatio: 2,     // Already applied to the renderer. Pass it to any composer you create.
  detail: 1,         // phone: 0.5. Multiply particle and instance counts by this.
}
```

`?quality=desktop` or `?quality=phone` overrides the automatic pick. Phone must hold 30 fps on a recent phone. The engine reads the frame rate into `window.__fps`.

## Camera limits

The engine owns the camera: drag orbit, zoom, flights, tour, and the pull toward a world with an event. It clamps the pose every frame in every mode, using the island's numbers. Rest and overview pose come only from your `home(aspect)`. Each flight comes from a `focus`. The tour walks the line in order, ends at the main building, then returns to `home`.

```js
cameraLimits: {
  groundHeight(x, z),  // Optional. Surface height at x, z (rock, ice, water). The camera stays above it by clearance.
  groundY: 0,          // Used when groundHeight is absent.
  colliders: [ { center: Vector3, radius } ],  // Spheres the camera may not enter: towers, cliffs, rocks.
  clearance: 0.4,      // Metres above ground. Default 0.4.
  minDistance: 2,      // Orbit distance from the look target.
  maxDistance: 60,
  maxPolar: 1.45,      // Radians from straight down. Default 1.45, just above the horizon.
}
```

Real islands must provide `groundHeight` or `groundY`, and `colliders` around tall structures. Keep each `focus.position` and the `home` position outside the colliders and above the ground or the clamp will push them. With no `maxDistance`, zoom stops at 1.6 times the `home` distance. `home` must show the whole line on a wide screen and on a tall phone. Look at both, since a line that fits at 16:9 usually needs a different angle at 9:19.5. On a tall screen keep anchors out of the top and bottom 15 percent, where the page's text sits, or their names hide to stay clear of it.

## Mascots

`mascots` is always present. It wraps `assets/mascots/mascots.js` and `mascots.glb` when they load, and a plain fallback bot otherwise, with the same calls, so an island does not change when the real set lands. It already knows the camera and the shadow setting.

```js
const bot = await mascots.create({ color: bot.color, index: bot.index, lead: false, size: 0.8 });
scene.add(bot.object);       // object.position is the ground point. size 1 is about 1 unit tall.
bot.setState('found', { value: evt.intensity, onPeak() { /* fire your found moment here */ } });
bot.setState('working');     // idle, working, found, done, needs_approval
bot.update(dt);              // Call it in your update.
bot.dispose();
```

`index` picks the body shape, so a team gets varied shapes, and `lead: true` gives the lead's. To force one, pass `shape` (see `MASCOT_SHAPES`). Anything else you pass goes through to `createMascot` in `assets/mascots/mascots.js`: `seed`, `envMap`, `glow`, `contactShadow`, `shadowStrength`. The real bot also has `hopTo`, `faceTowards`, `setFacing`, `head()`, `clearApproval()`, `setColor`, and the fallback copies them. A `found` returns to the previous state by itself. A `done` holds its orb until the next state, so settle it yourself after a few seconds.

Wiring it to events:

```js
applyEvent(evt, world) {
  const bot = world.bot;  // Your own field.
  if (evt.catchup) {      // History on load: end state, no effect.
    if (!evt.pending) bot.clearApproval();
    bot.setState(evt.pending ? 'needs_approval' : evt.activity);
    return;
  }
  bot.setState(evt.type, { value: evt.intensity });
}
```

## Shipping

Only `islands/<name>/scene.js`, whatever it imports, and `islands/<name>/assets/` are deployed. `references/` and `blender/` never ship, so do not load anything from them at run time. No key or secret goes in any island file.

## Testing your island

```
npm run dev
http://localhost:3260/?island=<name>                       demo day on loop
http://localhost:3260/?island=<name>&config=example-3      team of 3, or example-4 for a team of 4
http://localhost:3260/?island=<name>&source=replay         scripted replay of all five events
http://localhost:3260/?island=<name>&quality=phone
http://localhost:3260/?island=<name>&daylight=0.8
http://localhost:3260/?island=<name>&debug=1               frame rate. Keys 1 to 5 fire idle, working, found, done, needs_approval. Tab picks the next bot.
http://localhost:3260/?island=<name>&focus=main            start close on main or a bot id, and hold, for look testing
```

`node engine/test/check-island.mjs <name>` loads your island with teams of 3 and 4 at desktop and phone width (a size outside your `teamSizes` is skipped), runs all five events on every bot, checks every route, reports contract breaks, page errors, frame rate and anything out of frame, and saves screenshots to `.work/engine/check/<name>/`. Run it before you report.
