// Screenshots an island from the dev server after it has run for a while.
// node tools/shot.mjs <island> <out.png> [width] [height] [seconds] [extra query] [dpr]
import { chromium } from 'playwright';
const [island, out, w = '1920', h = '1080', seconds = '12', query = '', dpr = '1'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle'] });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +dpr });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('PAGEERROR ' + e.message.slice(0, 500)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ` + m.text().slice(0, 300)); });
page.on('response', (r) => { if (r.status() >= 400) problems.push('HTTP ' + r.status() + ' ' + r.url().slice(0, 120)); });
await page.goto(`http://localhost:3260/?island=${island}&${query}`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
const fatal = await page.evaluate(() => window.__fatal);
if (fatal) console.log('FATAL', JSON.stringify(fatal));
const shots = String(seconds).split(',').map(Number);
let prev = 0;
for (const [i, sec] of shots.entries()) {
  await page.waitForTimeout((sec - prev) * 1000);
  prev = sec;
  const name = shots.length > 1 ? out.replace(/(\.\w+)$/, `_${String(sec).padStart(2, '0')}$1`) : out;
  await page.screenshot({ path: name });
}
const info = await page.evaluate(() => ({ fps: Math.round(window.__fps || 0), frames: window.__engine?.frames?.(), q: window.__engine?.quality?.name, mascots: window.__engine?.mascotsKind, routes: window.__engine?.routeProblems, info: { calls: window.__engine?.renderer?.info?.render?.calls, tris: window.__engine?.renderer?.info?.render?.triangles } }));
console.log(JSON.stringify(info));
for (const p of [...new Set(problems)].slice(0, 15)) console.log(p);
await browser.close();
