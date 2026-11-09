#!/usr/bin/env node
// Records a video from a replay, one stepped frame at a time. Never real-time screen capture.
//
//   node tools/record.mjs --island orbit-port --config example-4 --replay public/examples/replay.example.json --out out.mp4
//
// Options (defaults in brackets):
//   --island <name>     island to load [from the config]
//   --config <x>        example-3, example-4, a URL, or a local .json file [the bundled team that fits the island]
//   --replay <x>        a URL, or a local .json file [the built-in script for this team]
//   --out <file>        [replay.mp4]
//   --seconds <n> [20]  --fps <n> [60]  --width <n> [1920]  --height <n> [1080]
//   --speed <1-20>      replay speed [from the replay file]
//   --quality <name>    desktop or phone [desktop]
//   --daylight <0-1>    pin the time of day [from the replay clock]
//   --tour              run the cinematic tour rather than event pulls
//   --no-ui             hide the corner UI
//   --no-labels         hide the names and the approval marker
//   --url <http...>     use a server that is already running, rather than starting vite
//
// On this machine, wrap it: tools/gpu_slot.sh node tools/record.mjs ...

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out[key] = argv[i + 1];
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const fallback = resolve(ROOT, '../grok-leads/node_modules/playwright/index.mjs');
    if (existsSync(fallback)) return import(fallback);
    throw new Error('Playwright is not installed. Run npm install at the project root.');
  }
}

function gpuArgs() {
  const args = ['--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'];
  if (process.platform === 'darwin') args.push('--use-angle=metal');
  else args.push('--use-gl=angle', '--use-angle=swiftshader');
  return args;
}

function isLocalFile(x) {
  return typeof x === 'string' && !/^https?:\/\//.test(x) && x.endsWith('.json') && existsSync(resolve(process.cwd(), x));
}

function verify(out, fps, frames, width, height) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration', '-of', 'json', out], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
  const s = JSON.parse(probe.stdout).streams[0];
  const problems = [];
  if (s.r_frame_rate !== `${fps}/1`) problems.push(`frame rate is ${s.r_frame_rate}, wanted ${fps}/1`);
  if (s.avg_frame_rate !== `${fps}/1`) problems.push(`average frame rate is ${s.avg_frame_rate}, wanted ${fps}/1`);
  if (Number(s.nb_read_frames) !== frames) problems.push(`has ${s.nb_read_frames} frames, wanted ${frames}`);
  if (s.width !== width || s.height !== height) problems.push(`is ${s.width}x${s.height}, wanted ${width}x${height}`);
  return { stream: s, problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fps = Number(args.fps ?? 60);
  const seconds = Number(args.seconds ?? 20);
  const width = Number(args.width ?? 1920);
  const height = Number(args.height ?? 1080);
  const frames = Math.round(fps * seconds);
  const out = resolve(process.cwd(), args.out ?? 'replay.mp4');
  mkdirSync(dirname(out), { recursive: true });

  let server = null;
  let base = args.url;
  if (!base) {
    const { createServer } = await import('vite');
    server = await createServer({ root: ROOT, server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false, watch: null }, logLevel: 'error' });
    await server.listen();
    const address = server.httpServer.address();
    base = `http://127.0.0.1:${address.port}`;
  }

  const q = new URLSearchParams({ capture: '1', film: '1', source: 'replay', loop: '0', quality: args.quality ?? 'desktop', dpr: '1' });
  if (args.island) q.set('island', args.island);
  if (args.speed) q.set('speed', args.speed);
  if (args.daylight !== undefined) q.set('daylight', args.daylight);
  if (args['no-ui']) q.set('ui', '0');
  if (args['no-labels']) q.set('labels', '0');
  if (args.tour) q.set('tour', '1');
  const routes = new Map();
  const configArg = args.config;
  if (configArg && isLocalFile(configArg)) {
    routes.set('/__record/config.json', readFileSync(resolve(process.cwd(), configArg)));
    q.set('config', '/__record/config.json');
  } else if (configArg) {
    q.set('config', configArg);
  }
  if (args.replay) {
    if (isLocalFile(args.replay)) {
      routes.set('/__record/replay.json', readFileSync(resolve(process.cwd(), args.replay)));
      q.set('replay', '/__record/replay.json');
    } else {
      q.set('replay', args.replay);
    }
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ args: gpuArgs() });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  for (const [path, body] of routes) {
    await page.route(`**${path}`, (route) => route.fulfill({ body, contentType: 'application/json' }));
  }
  page.on('pageerror', (err) => console.error('Page error:', err.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('Console:', m.text());
  });

  const url = `${base}/?${q}`;
  console.log(`Loading ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000, polling: 100 });
  const fatal = await page.evaluate(() => window.__fatal ?? null);
  if (fatal) throw new Error(`${fatal.title}: ${fatal.details.join('; ')}`);

  const ffmpeg = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
    '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '15',
    '-r', String(fps), '-fps_mode', 'cfr',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-an', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffmpegDone = new Promise((res, rej) => {
    ffmpeg.on('exit', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with ${code}`))));
    ffmpeg.on('error', rej);
  });

  const dt = 1 / fps;
  const started = Date.now();
  let lastHash = '';
  let repeats = 0;
  for (let i = 0; i < frames; i += 1) {
    const res = await page.evaluate((step) => window.__step(step), dt);
    const expected = (i + 1) * dt;
    if (Math.abs(res.time - expected) > 1e-6) throw new Error(`Clock drift at frame ${i}: ${res.time} vs ${expected}`);
    const shot = await page.screenshot({ type: 'jpeg', quality: 100, scale: 'css', caret: 'initial', animations: 'allow' });
    const hash = createHash('md5').update(shot).digest('hex');
    if (hash === lastHash) repeats += 1;
    lastHash = hash;
    if (!ffmpeg.stdin.write(shot)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if ((i + 1) % 120 === 0) {
      const rate = (i + 1) / ((Date.now() - started) / 1000);
      console.log(`${i + 1}/${frames} frames, ${rate.toFixed(1)} per second`);
    }
  }
  ffmpeg.stdin.end();
  await ffmpegDone;
  const fired = await page.evaluate(() => {
    const counts = {};
    for (const e of window.__engine.applied) counts[e.type] = (counts[e.type] ?? 0) + 1;
    return counts;
  });
  await browser.close();
  if (server) await server.close();

  const { stream, problems } = verify(out, fps, frames, width, height);
  console.log(`Events applied: ${JSON.stringify(fired)}`);
  console.log(`Frames identical to the one before: ${repeats}`);
  console.log(`ffprobe: ${JSON.stringify(stream)}`);
  if (problems.length) throw new Error(`The video is wrong: it ${problems.join(', ')}`);
  console.log(`Verified ${out}: ${fps} fps, ${frames} frames, ${width}x${height}.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
