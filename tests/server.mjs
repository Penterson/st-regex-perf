// Static server that lays out a SillyTavern-shaped URL space for the browser tests:
// pinned SillyTavern files where the code under test needs the real thing, small stand-ins for the rest,
// the working tree as the extension and the BASELINE commit as "baseline".
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { fetchSt, ST_DIR } from './fetch-st.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** The 0.1.0-era main the tests compare the working tree against (the first merge into main). */
export const BASELINE = process.env.BASELINE_COMMIT || '3f3d4027692ef666bc7a64bd93b0f6043b8274fd'; // BASELINE_COMMIT: compare the bench against another commit

const real = (p) => join(ST_DIR, 'public', p);
const mock = (p) => join(here, 'harness', 'st', p);
const FILES = {
    '/': join(here, 'harness', 'index.html'),
    '/lib/eventemitter.js': real('lib/eventemitter.js'),
    '/locales/lang.json': real('locales/lang.json'),
    '/locales/ko-kr.json': real('locales/ko-kr.json'),
    '/scripts/events.js': real('scripts/events.js'),
    '/scripts/extensions/regex/engine.js': real('scripts/extensions/regex/engine.js'),
    '/scripts/extensions/regex/scriptTemplate.html': real('scripts/extensions/regex/scriptTemplate.html'),
    '/scripts/i18n.js': real('scripts/i18n.js'),
    '/scripts/message-formatter.js': real('scripts/message-formatter.js'),
    '/scripts/extensions.js': mock('extensions.js'),
    '/scripts/preset-manager.js': mock('preset-manager.js'),
    '/lib.js': mock('stubs.js'),
    '/scripts/power-user.js': mock('stubs.js'),
    '/scripts/secrets.js': mock('stubs.js'),
};
const DIRS = {
    '/scripts/extensions/third-party/st-regex-perf/': root,
    '/harness/': join(here, 'harness'),
    '/node_modules/': join(root, 'node_modules'),
};
const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css' };

function exportedFunction(src, name) {
    const start = src.indexOf(`export function ${name}(`);
    const end = src.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error(`${name}() not found`);
    return src.slice(start, end + 3);
}

const splice = async (file, marker, code) => (await readFile(file, 'utf8')).replace(marker, () => code);
const GENERATED = {
    // the whole messageFormatting(): hooks, regex, markdown (a stand-in converter), DOMPurify (a stand-in)
    '/script.js': async () => splice(mock('script.js'), '/* @messageFormatting */',
        exportedFunction(await readFile(real('script.js'), 'utf8'), 'messageFormatting')),
    '/scripts/utils.js': async () => splice(mock('utils.js'), '/* @regexFromString */',
        exportedFunction(await readFile(real('scripts/utils.js'), 'utf8'), 'regexFromString')),
};

const baselineFiles = new Map();
function baselineFile(name) {
    if (!baselineFiles.has(name)) {
        baselineFiles.set(name, execFileSync('git', ['show', `${BASELINE}:${name}`], { cwd: root }));
    }
    return baselineFiles.get(name);
}

async function resolve(path) {
    if (GENERATED[path]) return GENERATED[path]();
    if (FILES[path]) return readFile(FILES[path]);
    const base = '/scripts/extensions/third-party/baseline/';
    if (path.startsWith(base)) return baselineFile(path.slice(base.length));
    for (const [prefix, dir] of Object.entries(DIRS)) {
        if (path.startsWith(prefix)) {
            const file = normalize(join(dir, path.slice(prefix.length)));
            if (!file.startsWith(dir)) return null;
            return readFile(file);
        }
    }
    return null;
}

/** @returns {Promise<{url: string, close: () => Promise<void>}>} */
async function startServer() {
    const server = createServer(async (req, res) => {
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        try {
            const body = await resolve(path);
            if (body === null) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
            // cross-origin isolated, so performance.now() has microsecond resolution and the pipeline stage times mean something
            res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'text/html', 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
            res.end(body);
        } catch (e) {
            res.writeHead(e.code === 'ENOENT' ? 404 : 500);
            res.end(String(e.message));
        }
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((ok) => server.close(() => ok())),
    };
}

/** The pinned SillyTavern files, the harness server and a headless Chrome, for the test entry points. */
export async function launch() {
    await fetchSt();
    const server = await startServer();
    const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--lang=en-US'] });
    return {
        server,
        browser,
        async close() {
            await browser.close();
            await server.close();
        },
    };
}

/** Chrome for puppeteer: $CHROME_PATH, else google-chrome / chromium on PATH. */
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
