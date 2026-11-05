// Browser tests: boots the harness in headless Chrome once per variant and compares what SillyTavern's real
// regex engine produces with no extension ("none"), with main ("baseline") and with the working tree ("current").
// Usage: node tests/run.mjs [name filter]   Chrome: $CHROME_PATH, else google-chrome / chromium on PATH.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { fetchSt } from './fetch-st.mjs';
import { startServer } from './server.mjs';
import { tests } from './cases.mjs';

function chromePath() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        try {
            const p = execFileSync('which', [name], { encoding: 'utf8' }).trim();
            if (p && existsSync(p)) return p;
        } catch { /* not installed */ }
    }
    throw new Error('Chrome not found: set CHROME_PATH');
}

await fetchSt();
const server = await startServer();
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox'] });
const VARIANTS = { none: 'none', baseline: 'baseline', current: 'st-regex-perf' };

/**
 * Opens a fresh harness page.
 * @param {'none'|'baseline'|'current'} variant
 * @param {{locale?: string, hooks?: boolean}} [options]
 */
async function open(variant, { locale = 'en', hooks = true } = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${server.url}/?variant=${VARIANTS[variant]}&locale=${locale}${hooks ? '' : '&hooks=0'}`);
    await page.waitForFunction('window.__ready === true', { timeout: 20000 }).catch((e) => {
        throw new Error(`harness did not boot (${variant}): ${errors.join(' | ') || e.message}`);
    });
    return {
        page,
        errors,
        run: (name, arg) => page.evaluate((n, a) => window.__run(n, a), name, arg),
        close: () => page.close(),
    };
}

/** Runs one scenario on a fresh page per variant: {none, baseline, current}. */
async function each(name, arg, { variants = Object.keys(VARIANTS), ...options } = {}) {
    const out = {};
    for (const v of variants) {
        const p = await open(v, options);
        try {
            out[v] = await p.run(name, arg);
        } finally {
            await p.close();
        }
        if (p.errors.length) throw new Error(`${v}: page errors: ${p.errors.join(' | ')}`);
    }
    return out;
}

const filter = process.argv[2] ?? '';
let failed = 0;
let passed = 0;
for (const [name, fn] of tests) {
    if (!name.includes(filter)) continue;
    const t0 = Date.now();
    try {
        await fn({ open, each });
        passed++;
        console.log(`  ok  ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
        failed++;
        console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 12).join('\n      ')}`);
    }
}
await browser.close();
await server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
