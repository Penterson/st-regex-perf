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

for (const profile of ['default', 'allOn', 'allOff', 'tinyMemo', 'compromise']) {
    test(`equivalence (${profile}): main and this branch give SillyTavern's own output`, async ({ each }) => {
        const r = await each('equivalence', { profile });
        const live = (label) => label.startsWith('live display');
        // With streaming skip on, display scripts are skipped while live by design: compare those renders with main
        // only (compromise mode, new on this branch, formats them partially: compare it with neither).
        const vsNone = profile === 'allOff' ? () => false : live;
        const n = sameRecords(r.none.records, r.current.records, 'none vs current', vsNone);
        sameRecords(r.baseline.records, r.current.records, 'baseline vs current', profile === 'compromise' ? live : () => false);
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
const EN_ALLOWED = /Regex Perf Kit(?: report)?|SillyTavern|User Settings|Messages to Load|Streaming FPS|Only Format (?:Display|Prompt)|MessageFormatter|markdownOnly|staging|extra|regexperf|reset|text|Status card|Greedy|Nobody|Digits|status|nothing-here|\bms\b|\bMB\b|\bKB\b|\bST\b/g;

test('item 17: Korean locale keeps main\'s Korean UI text; nothing is left untranslated', async ({ each }) => {
    const r = await each('uiTexts', null, { locale: 'ko-kr', variants: ['baseline', 'current'] });
    // timings differ between runs; feature numbers were renumbered ① ② ③ ④ ⑤ in screen order (main: ① ④ ② ⑥ ⑧)
    const norm = (s) => s.replace(/\d+(?:\.\d+)?/g, '#').replace(/[①②③④⑤⑥⑦⑧]|·\s*|\s*\(ST 기본 설정\)/g, '').trim();
    const now = new Set(r.current.texts.map(norm));
    const missing = r.baseline.texts.filter(s => !now.has(norm(s)) && !KO_CHANGED.has(s) && /[가-힣]/.test(s));
    assert.deepEqual(missing, [], 'Korean panel strings from main that are gone');
    for (const line of r.baseline.report.split('\n').slice(1)) {
        const fixed = line.replace(/\d[\d.:/ ]*|"[^"]*"|[①②③④⑤⑥⑦⑧]/g, '#').split(/[#|]/).map(s => s.trim()).filter(s => /[가-힣]/.test(s));
        for (const piece of fixed) assert.ok(r.current.report.replace(/[①②③④⑤⑥⑦⑧]/g, '#').includes(piece), `report text "${piece}"`);
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

test('item 9: "Measure on this chat" renders with the features off and on and shows the time saved', async ({ each }) => {
    const r = await each('measure', null, { variants: ['baseline', 'current'] });
    assert.equal(r.baseline, null, 'main has no such button');
    const m = /\((\d+)\D+\): ([\d.]+) ms .*?, ([\d.]+) ms .*?([-\d.]+) ms .*?\(([-\d]+)%\)/.exec(r.current.text);
    assert.ok(m, r.current.text);
    const [messages, off, on, saved, pct] = m.slice(1).map(Number);
    assert.equal(messages, 8);
    assert.ok(off > on * 2, `the prefilter skips the slow script: ${r.current.text}`);
    assert.ok(Math.abs(saved - (off - on)) <= 0.1 + off * 0.01, 'saved = off - on');
    assert.ok(Math.abs(pct - (off - on) / off * 100) <= 1);
    assert.ok(r.current.statsUnchanged, 'measuring does not count as activity');
    assert.ok(r.current.chatUnchanged);
});

const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
const row = (rows, name) => rows.find(x => x.Script === name) ?? assert.fail(`no row ${name}`);

test('item 10: summary shows the estimated time saved = (skips + hits + streaming skips) x average run time', async ({ each }) => {
    const r = await each('insights', null, { variants: ['baseline', 'current'] });
    assert.doesNotMatch(r.baseline.text, /≈/);
    const m = /Estimated time saved: ≈([\d.]+) ms/.exec(r.current.text);
    assert.ok(m, r.current.text);
    const want = r.current.rows.reduce((acc, x) => acc + (num(x.Runs) ? (num(x.Skips) + num(x.Hits) + num(x['Stream skips'])) * num(x['Total ms']) / num(x.Runs) : 0), 0);
    assert.ok(want > 0);
    assert.ok(Math.abs(num(m[1]) - want) <= want * 0.02 + 0.05, `${m[1]} vs ${want}`);
});

test('item 11: scripts that ran many times without changing the text are flagged', async ({ each }) => {
    const r = await each('insights', null, { variants: ['current'] });
    const rows = r.current.rows;
    assert.ok(num(row(rows, 'Changes').Changed) > 0);
    assert.equal(num(row(rows, 'Never changes').Changed), 0);
    for (const name of ['Never changes', 'Slow regex']) assert.match(row(rows, name).Warnings, /no effect/, name);
    for (const name of ['Changes', 'Rarely runs']) assert.doesNotMatch(row(rows, name).Warnings, /no effect/, name);
    assert.match(r.current.text, /Candidates to disable.*Never changes/);
});

test('item 12: replacer (macro) time is measured separately from regex time', async ({ each }) => {
    const r = await each('insights', null, { variants: ['baseline', 'current'] });
    assert.ok(!r.baseline.rows[0] || !('Replacer ms' in r.baseline.rows[0]));
    const macro = row(r.current.rows, 'Slow macro');
    const regex = row(r.current.rows, 'Slow regex');
    assert.ok(num(macro['Replacer ms']) >= 150, `30 x 2 ms x 3: ${macro['Replacer ms']}`);
    assert.ok(num(macro['Replacer ms']) >= num(macro['Total ms']) * 0.8);
    assert.ok(num(regex['Total ms']) > 0);
    assert.equal(num(regex['Replacer ms']), 0, 'it never matches, so its replacer never runs');
});

test('item 13: nested quantifiers and execution spikes are flagged', async ({ each }) => {
    const r = await each('insights', null, { variants: ['current'] });
    assert.match(row(r.current.rows, 'Nested').Warnings, /nested quantifier/);
    assert.match(row(r.current.rows, 'Slow macro').Warnings, /spike/);
    assert.ok(num(row(r.current.rows, 'Slow macro')['Max ms']) > 50);
    assert.doesNotMatch(row(r.current.rows, 'Changes').Warnings, /nested|spike/);
});

test('item 14: a table row opens its script in the regex editor; its off button disables the script', async ({ each }) => {
    const r = await each('rowActions', null, { variants: ['current'] });
    const [alpha, beta] = r.current.ids;
    assert.deepEqual(r.current.events, [`edit ${alpha}`, `save ${beta} disabled=true`]);
    assert.deepEqual(r.current.disabled, [false, true]);
    assert.equal(r.current.unknownHasActions, false, 'patterns that are not scripts get no actions');
});

test('item 15: memo and ⑧ limits are editable (validated) and memo / ⑧ usage is shown', async ({ each }) => {
    const r = await each('limits', null, { variants: ['baseline', 'current'] });
    assert.deepEqual(r.baseline.found, [false, false, false, false]);
    assert.deepEqual(r.current.found, [true, true, true, true]);
    assert.deepEqual(r.current.values, { memoMaxEntries: 4, memoMaxLen: 0, memoMaxMB: 64, persistMaxLen: 123457 });
    assert.match(r.current.usage, /Memo: 4 entries/);
    assert.match(r.current.usage, /in this chat: 3 messages/);
});

test('item 16: streaming compromise mode formats completed lines at most every N ms; final render is complete', async ({ each }) => {
    const on = await each('streamThrottle', { throttle: true }, { variants: ['current'] });
    const off = await each('streamThrottle', { throttle: false });
    const final = 'A <b>one</b>\nB <b>two</b>\nC <b>three</b>\nD <b>four</b>';
    assert.deepEqual(on.current, [
        'A <b>one</b>\nB **t', 1,
        'A <b>one</b>\nB **two**\nC **th', 0,
        'A <b>one</b>\nB <b>two</b>\nC <b>three</b>\nD **f', 1,
        'A <b>one</b>\nB <b>two</b>\nC <b>three</b>\nD **fou', 0,
        final,
    ]);
    assert.deepEqual(off.none.filter(x => typeof x === 'number'), [1, 1, 1, 1], 'plain SillyTavern formats every chunk');
    assert.deepEqual(off.current, off.baseline, 'off by default: same as main (display scripts skipped while live)');
    assert.equal(off.current.at(-1), final);
});

test('unchanged vs main: settings, controls, toggles, /regexperf and ⑧ clearing behave as before', async ({ each }) => {
    for (const locale of ['ko-kr', 'en']) {
        const r = await each('ux', null, { locale, variants: ['baseline', 'current'] });
        const added = ['memoMaxMB', 'streamingThrottle', 'streamingThrottleMs'];
        assert.deepEqual(Object.keys(r.current.initial).filter(k => !added.includes(k)), Object.keys(r.baseline.initial));
        for (const [k, v] of Object.entries(r.baseline.initial)) assert.equal(r.current.initial[k], v, `default ${k}`);
        assert.deepEqual({ memoMaxMB: r.current.initial.memoMaxMB, streamingThrottle: r.current.initial.streamingThrottle }, { memoMaxMB: 64, streamingThrottle: false });
        for (const id of r.baseline.ids) assert.ok(r.current.ids.includes(id), `#${id}`);
        assert.deepEqual(r.current.checked, r.baseline.checked);
        assert.deepEqual(r.current.toggled, r.baseline.toggled);
        assert.deepEqual(r.current.stored, r.baseline.stored);
        if (locale === 'ko-kr') { // main's UI is Korean in every locale
            assert.deepEqual(r.current.cleared, r.baseline.cleared);
            assert.deepEqual(r.current.slash, r.baseline.slash);
        } else {
            assert.deepEqual({ ...r.current.cleared, toast: 0 }, { ...r.baseline.cleared, toast: 0 });
            assert.equal(r.current.cleared.toast, 'Removed 1 persistent cache entries.');
            assert.deepEqual({ ...r.current.slash, reset: 0 }, { ...r.baseline.slash, reset: 0 });
            assert.equal(r.current.slash.reset, 'Stats reset');
        }
    }
});

test('unchanged vs main: saved user settings are kept as they are', async ({ each }) => {
    const saved = { profiler: false, prefilter: false, memo: false, memoMaxEntries: 10, memoMaxLen: 99, streamingSkip: false, persist: true, persistMaxLen: 7 };
    const r = await each('ux', null, { settings: saved, variants: ['baseline', 'current'] });
    for (const [k, v] of Object.entries(saved)) {
        assert.equal(r.baseline.initial[k], v);
        assert.equal(r.current.initial[k], v, k);
    }
    assert.deepEqual(r.current.checked, r.baseline.checked);
});

test('unchanged vs main: without MessageFormatter hooks ⑧ is disabled with a note', async ({ each }) => {
    const r = await each('ux', null, { hooks: false, variants: ['baseline', 'current'] });
    assert.deepEqual(r.current.checked, r.baseline.checked);
    assert.equal(r.current.checked.rpk_persist.disabled, true);
    assert.match(r.current.note, /MessageFormatter/);
    assert.deepEqual(r.current.stored, r.baseline.stored, 'nothing is stored without hooks');
});
