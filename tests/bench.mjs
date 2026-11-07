// Timing comparison of no extension / the baseline commit / the working tree (median of N fresh pages each).
// "save": getRegexedString() on 1500 unique inputs (the memo never hits); "display": messageFormatting() over a
// 240-message chat, first render (cold), re-render (warm), and the save path on it.
//   node tests/bench.mjs            prints both benchmarks (not a pass/fail test)
//   node tests/bench.mjs --gate     fails if the warm display render of the working tree is more than GATE_SLOWER
//                                   slower than the previous commit's (BASELINE_COMMIT, HEAD~1 by default), measured
//                                   in the same run on the same machine, interleaved, or slower than no extension at
//                                   all by more than GATE_OVERHEAD (the claim "installing it costs nothing");
//                                   re-measured up to twice when it is, since a shared CI runner is noisy. A ratio
//                                   stored elsewhere is no reference: the same code measures 0.48 of no extension on
//                                   a desktop and 0.53 on the GitHub runner. tests/bench-baseline.json is printed for
//                                   comparison only.
//   node tests/bench.mjs --update   stores the current ratio as the baseline (for the comparison line)
// BENCH_REPS overrides the number of pages per variant (7 for a run, 11 for the gate).
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ST_REF } from './fetch-st.mjs';

const GATE_SLOWER = 0.1; // vs the previous commit, same machine and run (two interleaved medians of 11 still differ by a few percent)
const GATE_OVERHEAD = 0.02; // vs no extension: the warm render may not be more than 2% slower
const BASELINE_FILE = new URL('./bench-baseline.json', import.meta.url);
const gate = process.argv.includes('--gate');
const update = process.argv.includes('--update');
const reps = Number(process.env.BENCH_REPS ?? (gate || update ? 11 : 7));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// the gate's reference commit, read by server.mjs when it loads
if (gate && !process.env.BASELINE_COMMIT) process.env.BASELINE_COMMIT = git('rev-parse', 'HEAD~1');
const { launch } = await import('./server.mjs');

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

/** The gate's measurement: the working tree against the previous commit and against no extension, interleaved. */
async function gateRatios() {
    const m = await run('bench', ['none', 'baseline', 'st-regex-perf']);
    print('display, long chat', m);
    return { vsPrevious: m['st-regex-perf warm'] / m['baseline warm'], vsNone: m['st-regex-perf warm'] / m['none warm'] };
}

let failed = false;
if (update) {
    const r = await warmRatio();
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    const commit = git('rev-parse', '--short', 'HEAD') + (dirty ? '-dirty' : ''); // -dirty: measured with uncommitted changes
    const baseline = { warmRatio: Number(r.ratio.toFixed(3)), warmMs: Number(r.warmMs.toFixed(1)), noneWarmMs: Number(r.noneWarmMs.toFixed(1)), reps, stRef: ST_REF, commit, date: new Date().toISOString().slice(0, 10) };
    await writeFile(BASELINE_FILE, JSON.stringify(baseline, null, 4) + '\n');
    console.log(`baseline written: warm ratio ${baseline.warmRatio}`);
} else if (gate) {
    const stored = JSON.parse(await readFile(BASELINE_FILE, 'utf8'));
    const previous = git('rev-parse', '--short', process.env.BASELINE_COMMIT);
    const over = (r) => r.vsPrevious > 1 + GATE_SLOWER || r.vsNone > 1 + GATE_OVERHEAD;
    let r = await gateRatios();
    for (let again = 0; over(r) && again < 2; again++) {
        console.log(`warm render: ${r.vsPrevious.toFixed(3)} of the previous commit's, ${r.vsNone.toFixed(3)} of no extension: measuring again`);
        r = await gateRatios();
    }
    console.log(`warm display render: ${r.vsPrevious.toFixed(3)} of the previous commit's (${previous}, limit ${(1 + GATE_SLOWER).toFixed(2)}), ${r.vsNone.toFixed(3)} of no extension (limit ${(1 + GATE_OVERHEAD).toFixed(2)}; stored for comparison: ${stored.warmRatio} on ${stored.commit}, ${stored.date})`);
    if (over(r)) {
        console.log(`FAIL  more than ${GATE_SLOWER * 100}% slower than the previous commit, or more than ${GATE_OVERHEAD * 100}% slower than no extension`);
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
