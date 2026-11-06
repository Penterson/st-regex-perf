// Timing comparison of no extension / the baseline commit / the working tree (median of N fresh pages each).
// "save": getRegexedString() on 1500 unique inputs (the memo never hits); "display": messageFormatting() over a
// 240-message chat, first render (cold), re-render (warm), and the save path on it.
//   node tests/bench.mjs            prints both benchmarks (not a pass/fail test)
//   node tests/bench.mjs --gate     fails if the warm display render, relative to no extension, is more than
//                                   GATE_SLOWER slower than tests/bench-baseline.json (re-measured once when it is,
//                                   since a shared CI runner is noisy); the ratio is used because absolute ms
//                                   differ per machine
//   node tests/bench.mjs --update   stores the current ratio as the baseline
// BENCH_REPS overrides the number of pages per variant (7 for a run, 11 for the gate).
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ST_REF } from './fetch-st.mjs';
import { launch } from './server.mjs';

const GATE_SLOWER = 0.2;
const BASELINE_FILE = new URL('./bench-baseline.json', import.meta.url);
const gate = process.argv.includes('--gate');
const update = process.argv.includes('--update');
const reps = Number(process.env.BENCH_REPS ?? (gate || update ? 11 : 7));

const { server, browser, close } = await launch();
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/** Medians of every number the scenario returns, per variant: {"none warm": 12.3, ...}. */
async function run(scenario, variants) {
    const times = {};
    for (let rep = 0; rep < reps; rep++) {
        for (const variant of variants) {
            const page = await browser.newPage();
            await page.goto(`${server.url}/?variant=${variant}`);
            await page.waitForFunction('window.__ready === true');
            const r = await page.evaluate((n) => window.__run(n, {}), scenario);
            for (const [k, ms] of Object.entries(typeof r === 'number' ? { total: r } : r)) (times[`${variant} ${k}`] ??= []).push(ms);
            await page.close();
        }
    }
    return Object.fromEntries(Object.entries(times).map(([k, xs]) => [k, median(xs)]));
}

const print = (name, medians) => {
    console.log(`${name} (median of ${reps})`);
    for (const [k, ms] of Object.entries(medians)) console.log(`  ${k.padEnd(22)} ${ms.toFixed(1)} ms`);
};

/** The warm display render with the extension, relative to no extension (1.0 = the same time). */
async function warmRatio() {
    const m = await run('bench', ['none', 'st-regex-perf']);
    print('display, long chat', m);
    return { ratio: m['st-regex-perf warm'] / m['none warm'], warmMs: m['st-regex-perf warm'], noneWarmMs: m['none warm'] };
}

let failed = false;
if (update) {
    const r = await warmRatio();
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const baseline = { warmRatio: Number(r.ratio.toFixed(3)), warmMs: Number(r.warmMs.toFixed(1)), noneWarmMs: Number(r.noneWarmMs.toFixed(1)), reps, stRef: ST_REF, commit, date: new Date().toISOString().slice(0, 10) };
    await writeFile(BASELINE_FILE, JSON.stringify(baseline, null, 4) + '\n');
    console.log(`baseline written: warm ratio ${baseline.warmRatio}`);
} else if (gate) {
    const baseline = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
    const limit = baseline.warmRatio * (1 + GATE_SLOWER);
    let r = await warmRatio();
    if (r.ratio > limit) {
        console.log(`warm ratio ${r.ratio.toFixed(3)} is over ${limit.toFixed(3)}: measuring again`);
        r = await warmRatio();
    }
    console.log(`warm display render: ${r.ratio.toFixed(3)} of no extension (baseline ${baseline.warmRatio}, limit ${limit.toFixed(3)})`);
    if (r.ratio > limit) {
        console.log(`FAIL  more than ${GATE_SLOWER * 100}% slower than the stored baseline`);
        failed = true;
    } else {
        console.log('  ok  benchmark gate');
    }
} else {
    print('save, unique inputs', await run('benchSave', ['none', 'baseline', 'st-regex-perf']));
    print('display, long chat', await run('bench', ['none', 'baseline', 'st-regex-perf']));
}
await close();
process.exit(failed ? 1 : 0);
