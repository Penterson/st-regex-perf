// Test cases for tests/run.mjs. Each case gets {open, each}: open(variant) boots one harness page, each(scenario)
// runs a scenario from harness/scenarios.js on a fresh page per variant and returns {none, baseline, current}.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** @type {[string, (t: {open: Function, each: Function}) => Promise<void>][]} */
export const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Asserts two record lists ([label, value][]) are identical, naming the first differing record. */
export function sameRecords(a, b, what, skip = () => false) {
    assert.equal(a.length, b.length, `${what}: record count`);
    let compared = 0;
    for (let i = 0; i < a.length; i++) {
        assert.equal(a[i][0], b[i][0], `${what}: record ${i} label`);
        if (skip(a[i][0])) continue;
        compared++;
        if (a[i][1] !== b[i][1]) {
            assert.fail(`${what}: "${a[i][0]}" differs\n        ${JSON.stringify(a[i][1])}\n     vs ${JSON.stringify(b[i][1])}`);
        }
    }
    return compared;
}

for (const profile of ['default', 'allOn', 'allOff', 'tinyMemo']) {
    test(`equivalence (${profile}): main and this branch give SillyTavern's own output`, async ({ each }) => {
        const r = await each('equivalence', { profile });
        const live = (label) => label.startsWith('live display');
        // With streaming skip on, display scripts are skipped while live by design: compare those renders with main only.
        const vsNone = profile === 'allOff' ? () => false : live;
        const n = sameRecords(r.none.records, r.current.records, 'none vs current', vsNone);
        sameRecords(r.baseline.records, r.current.records, 'baseline vs current');
        assert.ok(n > 1500, `compared ${n} records`);
        // The workload must exercise the extension: fewer regex executions than plain SillyTavern...
        if (profile !== 'allOff') assert.ok(r.current.nativeReplaces < r.none.nativeReplaces * 0.8, `executions ${r.current.nativeReplaces} vs ${r.none.nativeReplaces}`);
        // ...and visibly skip display scripts while streaming.
        if (profile !== 'allOff') assert.ok(r.none.records.some(([l, v], i) => live(l) && v !== r.current.records[i][1]), 'streaming skip had no effect');
    });
}

test('harness: every variant boots and the extension patches the engine', async ({ each }) => {
    const r = await each('smoke');
    assert.equal(r.none.wrapped, false);
    assert.equal(r.baseline.wrapped, true);
    assert.equal(r.current.wrapped, true);
    assert.equal(r.none.out, 'Hello [b]world[/b]!');
    assert.deepEqual(r.baseline.out, r.none.out);
    assert.deepEqual(r.current.out, r.none.out);
});

test('item 1: case-insensitive prefilter decides like the regex engine (σ/Σ/ς, µ/μ, ſ)', async ({ each }) => {
    const r = await each('caseFold');
    assert.deepEqual(r.none, ['ΟΔΟ[sigma]', 'οδο[sigma]', 'a 5[micrometre] grain', '[sun]day', '[sophia]']);
    assert.notDeepEqual(r.baseline, r.none, 'main skips these (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('item 2: an edited replacement is used after a chat reload or preset switch without clear()', async ({ each }) => {
    const r = await each('staleEdit');
    assert.deepEqual(r.none, ['A there', 'B there', 'C there']);
    assert.notDeepEqual(r.baseline, r.none, 'main returns the old cached output (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('item 3: matched text containing {{macros}} or <USER> is not served from the memo', async ({ each }) => {
    const r = await each('macroInMatch');
    assert.deepEqual(r.none, ['Hi (Ann) and (Ann)', 'Hi Ann', ' waves', 'Hi (Bob) and (Bob)', 'Hi Bob', 'Cat waves', 'Roll (1)', 'Roll (2)']);
    assert.notDeepEqual(r.baseline, r.none, 'main reuses the first result (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('item 4: ⑧ persisted display output refreshes after a persona or character rename', async ({ each }) => {
    const r = await each('persistNames');
    assert.deepEqual(r.none, ['Ann and Cat  waves', 'Ann and Cat  waves', 'Bob and Cat  waves', 'Bob and Kit Cat waves']);
    assert.notDeepEqual(r.baseline, r.none, 'main keeps the old names (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('item 5: escaped-substitution scripts are recognized, memoized and stream-skipped; literal column shows the used needle', async ({ each }) => {
    const r = await each('escapedSubst');
    assert.equal(r.none.first, '<b>hello</b>');
    assert.equal(r.current.first, r.none.first);
    assert.equal(r.none.live, '<b>hello</b>');
    // main: unknown script, so no memo and no streaming skip
    assert.ok(r.baseline.second > 0);
    assert.equal(r.baseline.live, '<b>hello</b>');
    assert.match(r.baseline.report, /\(알 수 없음\)/);
    assert.match(r.baseline.report, /^\d+ \| \(알 수 없음\) \|.*\| - \|/m, 'main shows no literal for the unknown /abc/');
    // this branch: second render is a memo hit, display script skipped while streaming, named row, real literal
    assert.equal(r.current.second, 0);
    assert.equal(r.current.live, 'Dr. A (B): hello');
    assert.match(r.current.report, /^\d+ \| Escaped char \|/m);
    assert.match(r.current.report, /^\d+ \| [^|]+ \|.*\| "abc" \|/m, 'the unknown /abc/ row shows its needle');
});

test('item 8: extractNeedle cases and differential fuzz in Chrome (prefilter never skips a match)', async ({ each }) => {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const r = await each('needleFuzz', { seed, patterns: 15000 }, { variants: ['current'] });
    assert.deepEqual(r.current.cases.unsupported, [], 'Chrome supports every case');
    assert.ok(r.current.fuzz.skips > 15000, `seed ${seed}: ${JSON.stringify(r.current.fuzz)}`);
});

test('item 8: group and alternation literals prefilter; optional astral characters under u are not needles', async ({ each }) => {
    const r = await each('needleCoverage');
    assert.deepEqual(r.none.out, ['He said <q>hi</q> and left.', 'a b ']);
    assert.notDeepEqual(r.baseline.out, r.none.out, 'main skips the 💬? script (bug reproduced)');
    assert.deepEqual(r.current.out, r.none.out);
    assert.ok(r.baseline.groupRuns > 0 && r.baseline.altRuns > 0, 'main has no needle for these');
    assert.equal(r.current.groupRuns, 0, 'group literal prefilters');
    assert.equal(r.current.altRuns, 0, 'alternation prefilters');
});

test('item 6: the memo has a memory budget with LRU eviction', async ({ each }) => {
    const r = await each('memoBudget');
    for (const v of ['none', 'baseline', 'current']) assert.ok(r[v].ok, `${v} output`);
    assert.equal(r.baseline.runsFirst, 0, 'main keeps all 100 x 10k-char entries (count cap only)');
    assert.equal(r.current.runsFirst, 1, 'the oldest entry was evicted by the 1 MB budget');
    assert.equal(r.current.runsLast, 0, 'the newest entry is still cached');
});

test('item 7: no getContext() per display script outside a generation; exact check during one', async ({ each }) => {
    const r = await each('streamingCheck');
    assert.deepEqual([r.none.idle, r.none.live, r.none.finished, r.none.afterStop], ['AB', 'AB', 'AB', 'AB']);
    assert.ok(r.baseline.idleContexts > 0, 'main builds the context for every display script');
    assert.equal(r.current.idleContexts, 0);
    assert.equal(r.current.dryRunContexts, 0, 'dry runs never stream');
    assert.equal(r.current.idle, 'AB');
    assert.equal(r.current.live, 'ab', 'display scripts are skipped while the stream is live');
    assert.equal(r.current.finished, 'AB');
    assert.equal(r.baseline.afterStop, 'ab', 'main keeps skipping after the generation stopped');
    assert.equal(r.current.afterStop, 'AB', 'finished messages get their display scripts');
});

test('extra: scripts sharing a pattern keep their own replacement and streaming behavior', async ({ each }) => {
    const r = await each('sharedPattern');
    assert.deepEqual(r.none, ['A  B', 'A <details><thinking>x</thinking></details> B', 'bar']);
    assert.notDeepEqual(r.baseline, r.none, 'main serves one script the other one\'s memo entry (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('extra: ⑧ persisted display output refreshes when the message depth or a script\'s placement changes', async ({ each }) => {
    const r = await each('persistDepth');
    assert.deepEqual(r.none, ['Hi <meter>', 'Yo!', 'Hi [HP]', 'Next <meter>', 'Yo!!']);
    assert.notDeepEqual(r.baseline, r.none, 'main shows the stored depth-0 output and the old placement (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

/** Korean wording that this branch changes on purpose (the behavior it describes changed). */
const KO_CHANGED = new Set([
    // ② tooltip: text containing macros is now excluded too (item 3)
    '같은 메시지에 같은 스크립트를 다시 돌릴 때 이전 결과를 재사용합니다. 치환문에 {{매크로}}가 있는 스크립트는 자동 제외.',
]);
// Words the Korean UI keeps in English: product and SillyTavern setting names, units, the test's script names.
const EN_ALLOWED = /Regex Perf Kit(?: report)?|SillyTavern|User Settings|Messages to Load|Streaming FPS|Only Format (?:Display|Prompt)|MessageFormatter|markdownOnly|staging|extra|regexperf|reset|text|Status card|Greedy|Nobody|status|nothing-here|\bms\b|\bMB\b|\bKB\b|\bST\b/g;

test('item 17: Korean locale keeps main\'s Korean UI text; nothing is left untranslated', async ({ each }) => {
    const r = await each('uiTexts', null, { locale: 'ko-kr', variants: ['baseline', 'current'] });
    const norm = (s) => s.replace(/\d+(?:\.\d+)?/g, '#'); // timings differ between runs
    const now = new Set(r.current.texts.map(norm));
    const missing = r.baseline.texts.filter(s => !now.has(norm(s)) && !KO_CHANGED.has(s) && /[가-힣]/.test(s));
    assert.deepEqual(missing, [], 'Korean panel strings from main that are gone');
    for (const line of r.baseline.report.split('\n').slice(1)) {
        const fixed = line.replace(/\d[\d.:/ ]*|"[^"]*"/g, '#').split(/[#|]/).map(s => s.trim()).filter(s => /[가-힣]/.test(s));
        for (const piece of fixed) assert.ok(r.current.report.includes(piece), `report text "${piece}"`);
    }
    assert.equal(r.current.help, r.baseline.help);
    for (const toast of r.baseline.toasts) assert.ok(r.current.toasts.includes(toast), `toast "${toast}"`);
    const leftover = (r.current.all + '\n' + r.current.report + '\n' + r.current.help.replace(/<[^>]+>/g, ' ')).replace(EN_ALLOWED, '').match(/[A-Za-z]{3,}/g);
    assert.equal(leftover, null, 'untranslated English in the Korean UI');
});

test('item 17: English locale shows no Korean', async ({ each }) => {
    const r = await each('uiTexts', null, { locale: 'en', variants: ['current'] });
    const hangul = [r.current.all, r.current.report, r.current.help, ...r.current.toasts].join('\n').match(/[가-힣ㄱ-ㅎ]+/g);
    assert.equal(hangul, null);
});

test('item 17: every Korean string resolves under SillyTavern\'s real ko-kr.json (no key collisions)', async ({ each }) => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('const KO = {'), src.indexOf('\n};', src.indexOf('const KO = {')));
    const unquote = (q) => q.slice(1, -1).replace(/\\(.)/g, '$1');
    const entries = [...block.matchAll(/^ {4}('(?:[^'\\]|\\.)*'): ('(?:[^'\\]|\\.)*'),$/gm)].map(m => [unquote(m[1]), unquote(m[2])]);
    assert.ok(entries.length > 50, `parsed ${entries.length} entries`);
    const r = await each('translations', entries, { locale: 'ko-kr', variants: ['current'] });
    assert.deepEqual(r.current, []);
});
