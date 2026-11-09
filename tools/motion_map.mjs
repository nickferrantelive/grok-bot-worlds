// How much of the frame actually moves, measured. Runs an island live, compares frames pixel by pixel.
// node tools/motion_map.mjs <island> <outdir> [seconds=5] [extra query]
// Writes <island>_t0.png, <island>_t1.png, <island>_heat.png (black = dead still, bright = moving) and prints the share of frame moving.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const [island, outdir, seconds = '5', query = ''] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)));
await page.goto(`http://localhost:3260/?still=1&labels=0&quality=desktop&island=${island}&${query}`, { timeout: 180000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await page.waitForTimeout(8000);
const shots = [];
const count = 6;
for (let i = 0; i < count; i += 1) {
  const path = `${outdir}/${island}_f${i}.png`;
  await page.screenshot({ path });
  shots.push(`data:image/png;base64,${readFileSync(path).toString('base64')}`);
  await page.waitForTimeout((Number(seconds) * 1000) / (count - 1));
}
const report = await page.evaluate(async (shots) => {
  const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = src; });
  const images = await Promise.all(shots.map(load));
  const w = images[0].width, h = images[0].height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  const data = images.map((im) => { g.drawImage(im, 0, 0); return g.getImageData(0, 0, w, h).data; });
  const heat = g.createImageData(w, h);
  let seen = 0, strong = 0;
  const cols = 8, rows = 4;
  const cells = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const k = (y * w + x) * 4;
      let d = 0;
      for (let f = 1; f < data.length; f += 1) {
        d = Math.max(d, Math.abs(data[f][k] - data[0][k]), Math.abs(data[f][k + 1] - data[0][k + 1]), Math.abs(data[f][k + 2] - data[0][k + 2]));
      }
      if (d >= 3) { seen += 1; cells[Math.floor((y * rows) / h)][Math.floor((x * cols) / w)] += 1; }
      if (d >= 10) strong += 1;
      const v = Math.min(255, d * 10);
      heat.data[k] = v; heat.data[k + 1] = v; heat.data[k + 2] = v; heat.data[k + 3] = 255;
    }
  }
  g.putImageData(heat, 0, 0);
  const area = (w * h) / (rows * cols);
  return {
    movingPct: +((100 * seen) / (w * h)).toFixed(1),
    strongPct: +((100 * strong) / (w * h)).toFixed(1),
    grid: cells.map((r) => r.map((n) => String(Math.round((100 * n) / area)).padStart(3)).join(' ')),
    heat: c.toDataURL('image/png'),
  };
}, shots);
writeFileSync(`${outdir}/${island}_heat.png`, Buffer.from(report.heat.split(',')[1], 'base64'));
console.log(JSON.stringify({ island, moving_pct: report.movingPct, strong_pct: report.strongPct, errors: errors.slice(0, 3) }));
console.log(report.grid.join('\n'));
await browser.close();
