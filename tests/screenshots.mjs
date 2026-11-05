// Panel screenshots for the READMEs: docs/screenshot-desktop.png and docs/screenshot-mobile.png, from the harness
// with a SillyTavern-like theme (tests/harness/theme.css) after a realistic session (the screenshot scenario).
// Usage: node tests/screenshots.mjs [locale]   (default ko-kr)
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { fetchSt } from './fetch-st.mjs';
import { chromePath, startServer } from './server.mjs';

const locale = process.argv[2] ?? 'ko-kr';
await fetchSt();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox'] });
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
for (const [name, width] of [['desktop', 1000], ['mobile', 390]]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
    await page.goto(`${server.url}/?variant=st-regex-perf&locale=${locale}&theme=1`);
    await page.waitForFunction('window.__ready === true');
    await page.evaluate(() => window.__run('screenshot', {}));
    const panel = await page.$('#regex_perf_kit');
    const path = new URL(`../docs/screenshot-${name}.png`, import.meta.url).pathname;
    await panel.screenshot({ path });
    console.log(`${path} (${width}px wide)`);
    await page.close();
}
await browser.close();
await server.close();
