// Picks the event source. URL beats config, config beats demo.

import { createDemoSource } from './demo.js';
import { createReplaySource, buildScriptedReplay, clampSpeed } from './replay.js';
import { createLiveSource } from './live.js';
import { secretKeyProblem, ConfigError } from '../config.js';

export function chooseSourceSpec(params, configSource) {
  const raw = params.get('source') ?? configSource?.mode ?? 'demo';
  if (!['demo', 'replay', 'live'].includes(raw)) {
    throw new ConfigError(`Unknown source "${raw}"`, ['Use source=demo, source=replay or source=live.']);
  }
  const speed = params.get('speed');
  return {
    mode: raw,
    url: params.get('live') ?? configSource?.url,
    anonKey: params.get('anon_key') ?? configSource?.anon_key,
    replay: params.get('replay') ?? configSource?.replay,
    speed: speed !== null ? clampSpeed(speed) : configSource?.speed,
    loop: params.get('loop') !== '0',
  };
}

export async function createSource({ spec, config, store, fetchImpl = (...a) => fetch(...a), wallNow = () => Date.now() }) {
  if (spec.mode === 'demo') return createDemoSource({ config, store, now: wallNow });

  if (spec.mode === 'replay') {
    let file;
    if (spec.replay) {
      let res;
      try {
        res = await fetchImpl(spec.replay, { cache: 'no-store' });
      } catch (err) {
        throw new ConfigError(`Could not load the replay file ${spec.replay}`, [err.message]);
      }
      if (!res.ok) throw new ConfigError(`Could not load the replay file ${spec.replay}`, [`The server answered HTTP ${res.status}.`]);
      try {
        file = await res.json();
      } catch (err) {
        throw new ConfigError(`The replay file ${spec.replay} is not valid JSON`, [err.message]);
      }
    } else {
      file = buildScriptedReplay(config);
    }
    try {
      return createReplaySource({ store, file, speed: spec.speed, loop: spec.loop });
    } catch (err) {
      throw new ConfigError(`The replay file ${spec.replay ?? ''} cannot be played`, [err.message]);
    }
  }

  if (!spec.url) throw new ConfigError('Live mode needs a URL', ['Set source.url in the config, or add live=<url> to the address.']);
  const problem = secretKeyProblem(spec.anonKey);
  if (problem) throw new ConfigError('Refusing to start live mode', [problem]);
  return createLiveSource({ store, url: spec.url, anonKey: spec.anonKey, now: wallNow, fetchImpl });
}
