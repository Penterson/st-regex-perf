// Timing comparison of no extension / main / the working tree (median of 7 fresh pages each). Not a pass/fail test.
// "save": getRegexedString() on 1500 unique inputs (the memo never hits); "display": messageFormatting() over a
// 240-message chat, first render (cold), re-render (warm), and the save path on it.
import puppeteer from 'puppeteer-core';
import { fetchSt } from './fetch-st.mjs';
import { chromePath, startServer } from './server.mjs';

await fetchSt();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox'] });
const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
for (const [name, scenario] of [['save, unique inputs', 'benchSave'], ['display, long chat', 'bench']]) {
    const times = {};
    for (let rep = 0; rep < 7; rep++) {
        for (const variant of ['none', 'baseline', 'st-regex-perf']) {
            const page = await browser.newPage();
            await page.goto(`${server.url}/?variant=${variant}`);
            await page.waitForFunction('window.__ready === true');
            const r = await page.evaluate((n) => window.__run(n, {}), scenario);
            for (const [k, ms] of Object.entries(typeof r === 'number' ? { total: r } : r)) (times[`${variant} ${k}`] ??= []).push(ms);
            await page.close();
        }
    }
    console.log(`${name} (median of 7)`);
    for (const [k, xs] of Object.entries(times)) console.log(`  ${k.padEnd(22)} ${median(xs).toFixed(1)} ms`);
}
await browser.close();
await server.close();
