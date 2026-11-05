// Test cases for tests/run.mjs. Each case gets {open, each}: open(variant) boots one harness page, each(scenario)
// runs a scenario from harness/scenarios.js on a fresh page per variant and returns {none, baseline, current}.
import assert from 'node:assert/strict';

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
