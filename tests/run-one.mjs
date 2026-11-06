// Runs one scenario on the working tree and prints its result: node tests/run-one.mjs <scenario> [json arg]
import { launch } from './server.mjs';

const { server, browser, close } = await launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') errors.push(m.text()); });
await page.goto(`${server.url}/?variant=st-regex-perf&locale=en`);
await page.waitForFunction('window.__ready === true', { timeout: 20000 });
const arg = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const r = await page.evaluate((n, a) => window.__run(n, a), process.argv[2], arg);
console.log(JSON.stringify(r, null, 2));
if (errors.length) console.log('PAGE ERRORS/WARNINGS:\n' + errors.join('\n'));
await page.close();
await close();
