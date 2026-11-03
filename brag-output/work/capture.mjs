// Usage: node capture.mjs <url> <outDir> [frames comma list | "all"]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url); // dir with playwright installed
const { chromium } = require('playwright');
const [url, out, which = 'all'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(url);
await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
const total = await page.evaluate(() => window.TOTAL);
const frames = which === 'all' ? [...Array(total).keys()] : which.split(',').map(Number);
for (const f of frames) {
  const data = await page.evaluate((f) => window.renderFrame(f), f);
  fs.writeFileSync(`${out}/f${String(f).padStart(4, '0')}.png`, Buffer.from(data.split(',')[1], 'base64'));
}
await browser.close();
console.log('captured', frames.length);
