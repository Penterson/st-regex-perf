// Test cases for tests/run.mjs. Each case gets {open, each}: open(variant) boots one harness page, each(scenario)
// runs a scenario from harness/scenarios.js on a fresh page per variant and returns {none, baseline, current}.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** @type {[string, (t: {open: Function, each: Function}) => Promise<void>][]} */
export const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));
const row = (rows, name) => rows.find(x => x.Script === name) ?? assert.fail(`no row ${name}`);
/** Rows of the extension's text report, each keyed by the column headers. */
function reportRows(text) {
    const lines = text.split('\n');
    const head = lines.indexOf('') + 1; // the table header follows the first blank line
    const cols = lines[head].split(' | ');
    const end = lines.indexOf('', head); // the table ends at the next blank line (sections may follow)
    return lines.slice(head + 1, end === -1 ? undefined : end).filter(Boolean).map(l => Object.fromEntries(l.split(' | ').map((v, i) => [cols[i], v])));
}

/** Asserts two record lists ([label, value][]) are identical, naming the first differing record. */
function sameRecords(a, b, what, skip = () => false) {
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
    test(`equivalence (${profile}): baseline and current give SillyTavern's own output`, async ({ each }) => {
        const r = await each('equivalence', { profile });
        const live = (label) => label.startsWith('live display');
        // With streaming skip on, display scripts are skipped while live by design: compare those renders with the
        // baseline only (compromise mode, which the baseline lacks, formats them partially: compare it with neither).
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
    assert.notDeepEqual(r.baseline, r.none, 'baseline skips these (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('item 2: an edited replacement is used after a chat reload or preset switch without clear()', async ({ each }) => {
    const r = await each('staleEdit');
    assert.deepEqual(r.none, ['A there', 'B there', 'C there']);
    assert.notDeepEqual(r.baseline, r.none, 'baseline returns the old cached output (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('item 3: matched text containing {{macros}} or <USER> is not served from the memo', async ({ each }) => {
    const r = await each('macroInMatch');
    assert.deepEqual(r.none, ['Hi (Ann) and (Ann)', 'Hi Ann', ' waves', 'Hi (Bob) and (Bob)', 'Hi Bob', 'Cat waves', 'Roll (1)', 'Roll (2)']);
    assert.notDeepEqual(r.baseline, r.none, 'baseline reuses the first result (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('item 4: ⑤ persisted display output refreshes after a persona or character rename', async ({ each }) => {
    const r = await each('persistNames');
    assert.deepEqual(r.none, ['Ann and Cat  waves', 'Ann and Cat  waves', 'Bob and Cat  waves', 'Bob and Kit Cat waves']);
    assert.notDeepEqual(r.baseline, r.none, 'baseline keeps the old names (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('item 5: escaped-substitution scripts are recognized, memoized and stream-skipped; literal column shows the used needle', async ({ each }) => {
    const r = await each('escapedSubst');
    assert.equal(r.none.first, '<b>hello</b>');
    assert.equal(r.current.first, r.none.first);
    assert.equal(r.none.live, '<b>hello</b>');
    // baseline: unknown script, so no memo and no streaming skip
    assert.ok(r.baseline.second > 0);
    assert.equal(r.baseline.live, '<b>hello</b>');
    assert.match(r.baseline.report, /\(알 수 없음\)/);
    assert.match(r.baseline.report, /^\d+ \| \(알 수 없음\) \|.*\| - \|/m, 'baseline shows no literal for the unknown /abc/');
    // current: second render is a memo hit, display script skipped while streaming, named row, real literal
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
    assert.notDeepEqual(r.baseline.out, r.none.out, 'baseline skips the 💬? script (bug reproduced)');
    assert.deepEqual(r.current.out, r.none.out);
    assert.ok(r.baseline.groupRuns > 0 && r.baseline.altRuns > 0, 'baseline has no needle for these');
    assert.equal(r.current.groupRuns, 0, 'group literal prefilters');
    assert.equal(r.current.altRuns, 0, 'alternation prefilters');
});

test('AND prefilter: every mandatory literal must be present; messages shorter than the least match are skipped', async ({ each }) => {
    const r = await each('needleAnd');
    assert.deepEqual(r.none.out, ['xab aby', 'xab only', '!', '123', '#', 'has </status> only', 'ok']);
    assert.deepEqual(r.baseline.out, r.none.out);
    assert.deepEqual(r.current.out, r.none.out);
    assert.deepEqual(r.baseline.both, [1, 1, 1, 0, 0, 0, 0], 'baseline checks one literal');
    assert.deepEqual(r.current.both, [1, 0, 1, 0, 0, 0, 0], '"xab" and "aby" must both be present');
    assert.deepEqual(r.baseline.five, [1, 1, 1, 1, 1, 1, 1], 'baseline always runs a pattern without literals');
    assert.deepEqual(r.current.five, [1, 1, 0, 0, 1, 1, 1], 'a 3-character message (or "!" left by Both) cannot contain 5 digits');
    assert.deepEqual(r.baseline.tag, [0, 0, 0, 0, 0, 1, 1]);
    assert.deepEqual(r.current.tag, [0, 0, 0, 0, 0, 0, 1], 'the opening tag is mandatory too');
    const rows = reportRows(r.current.report);
    assert.equal(row(rows, 'Both').Literal, '"xab" & "aby"');
    assert.equal(row(rows, 'Both')['Min length'], '4');
    assert.match(row(rows, 'Five').Literal, /^- \(Only classes/);
    assert.equal(row(rows, 'Five')['Min length'], '5');
    assert.equal(row(rows, 'Tag').Literal, '"</status>" & "<status>"');
    assert.equal(row(rows, 'Tag')['Min length'], '17');
});

test('shared literal check: one scan per literal per input across scripts; displayed messages keep theirs for re-renders', async ({ each }) => {
    const want = Array(3).fill('no tags here but 2 and <D> ' + 'words '.repeat(50)); // D is case-sensitive
    const save = await each('litMemo', { display: false });
    for (const v of ['none', 'baseline', 'current']) assert.deepEqual(save[v].out, want, v);
    assert.deepEqual(save.none.perRender, [0, 0, 0], 'plain SillyTavern scans nothing');
    assert.deepEqual(save.baseline.perRender, [5, 5, 5], 'baseline: every script scans on every render');
    assert.deepEqual(save.current.perRender, [4, 4, 4], 'save path: each of the three literals once per render ("<a>" is shared), plus the order-conflict check of "<b>" on the input A2 changed');
    const display = await each('litMemo', { display: true }, { variants: ['baseline', 'current'] });
    for (const v of ['baseline', 'current']) assert.deepEqual(display[v].out, want, v);
    assert.deepEqual(display.baseline.perRender, [5, 5, 5]);
    assert.deepEqual(display.current.scans, { '<a>': 1, '<b>': 2, '<d>': 1 }, 'display path: each literal once ("<b>" also on the input A2 changed, for the order-conflict check)');
    assert.deepEqual(display.current.perRender, [4, 0, 0], 're-renders scan nothing');
});

test('item 6: the memo has a memory budget with LRU eviction', async ({ each }) => {
    const r = await each('memoBudget');
    for (const v of ['none', 'baseline', 'current']) assert.ok(r[v].ok, `${v} output`);
    assert.equal(r.baseline.runsFirst, 0, 'baseline keeps all 100 x 10k-char entries (count cap only)');
    assert.equal(r.current.runsFirst, 1, 'the oldest entry was evicted by the 1 MB budget');
    assert.equal(r.current.runsLast, 0, 'the newest entry is still cached');
});

test('item 7: no getContext() per display script outside a generation; exact check during one', async ({ each }) => {
    const r = await each('streamingCheck');
    assert.deepEqual([r.none.idle, r.none.live, r.none.finished, r.none.afterStop], ['AB', 'AB', 'AB', 'AB']);
    assert.ok(r.baseline.idleContexts > 0, 'baseline builds the context for every display script');
    assert.equal(r.current.idleContexts, 0);
    assert.equal(r.current.dryRunContexts, 0, 'dry runs never stream');
    assert.equal(r.current.idle, 'AB');
    assert.equal(r.current.live, 'ab', 'display scripts are skipped while the stream is live');
    assert.equal(r.current.finished, 'AB');
    assert.equal(r.baseline.afterStop, 'ab', 'baseline keeps skipping after the generation stopped');
    assert.equal(r.current.afterStop, 'AB', 'finished messages get their display scripts');
});

test('extra: scripts sharing a pattern keep their own replacement and streaming behavior', async ({ each }) => {
    const r = await each('sharedPattern');
    assert.deepEqual(r.none, ['A  B', 'A <details><thinking>x</thinking></details> B', 'bar']);
    assert.notDeepEqual(r.baseline, r.none, 'baseline serves one script the other one\'s memo entry (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

test('extra: ⑤ persisted display output refreshes when the message depth or a script\'s placement changes', async ({ each }) => {
    const r = await each('persistDepth');
    assert.deepEqual(r.none, ['Hi <meter>', 'Yo!', 'Hi [HP]', 'Next <meter>', 'Yo!!']);
    assert.notDeepEqual(r.baseline, r.none, 'baseline shows the stored depth-0 output and the old placement (bug reproduced)');
    assert.deepEqual(r.current, r.none);
});

// Words the Korean UI keeps in English: product and SillyTavern setting names, slash command verbs, data formats,
// units, the test's script names.
const EN_ALLOWED = /Regex Perf Kit(?: report)?|SillyTavern|User Settings|Messages to Load|Streaming FPS|Only Format (?:Display|Prompt)|MessageFormatter|staging|regexperf|reset|text|json|csv|measure|\boff\b|JSON|CSV|Status card|Greedy|Nobody|Digits|status|nothing-here|\bms\b|\bMB\b|\bKB\b|\bST\b|{{(?:user|char|persona|group)}}|\bfuse\b/g;

/** What the Korean panel must say (the plain-language wording of the panel redesign), as shown on screen. */
const KO_PANEL = [
    '① 프로파일러', '② 리터럴 프리필터', '③ 결과 캐시',
    '④ 스트리밍 중 표시용 스크립트 건너뛰기', '절충안: 완성된 줄은 계속 꾸미기', '⑤ 영구 캐시 (채팅 파일에 저장)',
    '</status>', // the example tag in ②'s description survives HTML insertion
    '한도', '이 채팅으로 측정', '리포트 복사', '측정 초기화', '새로고침', '저장된 결과 삭제 (이 채팅)',
    '번 실행했고', '번은 실행하지 않았습니다', '부터 측정', '표 읽는 법', '설정만으로 할 수 있는 것',
    '스크립트', '총 ms', '평균', '최대', '치환', '변경', '스킵', '히트', '리터럴',
];

test('item 17: Korean locale shows the plain-language panel in Korean; nothing is left untranslated', async ({ each }) => {
    const r = await each('uiTexts', null, { locale: 'ko-kr', variants: ['current'] });
    const all = r.current.all;
    const shown = r.current.texts.join('\n') + '\n' + all; // texts: before the stats reset, so the run sentences are there
    for (const text of KO_PANEL) assert.ok(shown.includes(text), `panel text "${text}"`);
    assert.match(r.current.report, /^측정 시작: .*채팅 메시지 \d+개$/m);
    assert.match(r.current.report, /절약 추정: (?:≈[\d.]+ ms \(건너뛴 \d+회 × 스크립트별 평균 실행 시간\)|아직 계산할 수 없음 \(측정된 실행 없음\))/);
    assert.match(r.current.report, /^순위 \| 스크립트 \| 실행 \| /m);
    for (const toast of ['측정값을 초기화했습니다.']) assert.ok(r.current.toasts.includes(toast), `toast "${toast}"`);
    const leftover = (all + '\n' + r.current.report + '\n' + r.current.help.replace(/<[^>]+>/g, ' ')).replace(EN_ALLOWED, '').match(/[A-Za-z]{3,}/g);
    assert.equal(leftover, null, 'untranslated English in the Korean UI');
});

test('numbers: the panel never shows a saved-time estimate without measured runs, and hides patterns that did nothing', async ({ each }) => {
    const r = await each('numbers', null, { variants: ['current'] });
    assert.equal(r.current.before.figures.saved, undefined, 'no runs yet: no estimate at all');
    assert.match(r.current.before.summary, /No runs measured yet/);
    assert.equal(r.current.before.rows, 0, 'wrapped but never run or skipped: no table rows');
    assert.match(r.current.before.empty, /No runs measured yet/);
    assert.equal(r.current.skippedOnly.figures.saved, undefined, 'only prefilter skips, no measured run: still no estimate');
    assert.match(r.current.skippedOnly.summary, /once some runs have been measured/);
    assert.equal(r.current.skippedOnly.figures.skipped, '3');
    assert.equal(r.current.skippedOnly.rows, 1, 'a script that was skipped is listed');
    assert.equal(r.current.skippedOnly.skipped, '3');
    assert.match(r.current.after.figures.saved, /^[\d.]+ ms$/);
    assert.equal(r.current.after.figures.runs, '2');
    assert.doesNotMatch(r.current.after.panel, /\b0\.00\b/, 'exact zeros are shown as 0');
});

test('missing literals are explained: the Literal cell tooltip and the report say why ② cannot prefilter', async ({ each }) => {
    const en = await each('uiTexts', null, { locale: 'en', variants: ['current'] });
    assert.match(en.current.litTitles.Digits, /^Only classes, escapes or wildcards: no literal character\nShortest possible match: 1 characters/);
    assert.equal(en.current.litTitles.Greedy, 'Shortest possible match: 2 characters. ② skips shorter messages.');
    assert.equal(row(reportRows(en.current.report), 'Digits').Literal, '- (Only classes, escapes or wildcards: no literal character)');
    const ko = await each('uiTexts', null, { locale: 'ko-kr', variants: ['current'] });
    assert.match(ko.current.litTitles.Digits, /^문자 클래스/);
    assert.match(reportRows(ko.current.report).find(x => x['스크립트'] === 'Digits')['리터럴'], /^- \(문자 클래스/);
});

test('item 17: English locale shows no Korean', async ({ each }) => {
    const r = await each('uiTexts', null, { locale: 'en', variants: ['current'] });
    const hangul = [r.current.all, r.current.report, r.current.help, ...r.current.toasts].join('\n').match(/[가-힣ㄱ-ㅎ]+/g);
    assert.equal(hangul, null);
});

test('item 17: every Korean string resolves under SillyTavern\'s real ko-kr.json (no key collisions)', async ({ each }) => {
    const entries = Object.entries(JSON.parse(readFileSync(new URL('../locales/ko-kr.json', import.meta.url), 'utf8')));
    assert.ok(entries.length > 50, `parsed ${entries.length} entries`);
    const r = await each('translations', entries, { locale: 'ko-kr', variants: ['current'] });
    assert.deepEqual(r.current, []);
});

test('locale files: the Korean table lives in locales/ko-kr.json; a locale without a file keeps the English UI', async ({ each }) => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /const KO = \{/, 'no inline translation table');
    assert.match(src, /locales\/\$\{localeFile\}\.json/, 'loads the locale file');
    const ko = await each('uiTexts', null, { locale: 'ko', variants: ['current'] });
    assert.ok(ko.current.all.includes('① 프로파일러'), 'a bare "ko" locale uses the ko-kr file');
    const xx = await each('uiTexts', null, { locale: 'xx-yy', variants: ['current'] });
    assert.ok(xx.current.all.includes('① Measure run time (profiler)'), 'no file: English');
});

test('item 9: "Measure on this chat" renders with the features off and on and shows the time saved', async ({ each }) => {
    const r = await each('measure', null, { variants: ['baseline', 'current'] });
    assert.equal(r.baseline, null, 'baseline has no such button');
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

test('per-row stopwatch: re-renders the chat without that script and shows the ms it costs inline; stats restored', async ({ each }) => {
    const r = await each('rowMeasure', null, { variants: ['baseline', 'current'] });
    assert.equal(r.baseline, null, 'baseline has no stopwatch');
    const m = /^([−+])([\d.]+) ms$/.exec(r.current.text);
    assert.ok(m, `inline difference: ${JSON.stringify(r.current.text)}`);
    assert.equal(m[1], '−', 'the chat is faster without the slow script');
    const t = /renders in ([\d.]+) ms instead of ([\d.]+) ms/.exec(r.current.title);
    assert.ok(t, r.current.title);
    const [without, with_] = t.slice(1).map(Number);
    assert.ok(with_ > without * 1.5, `the slow script dominates: ${r.current.title}`);
    assert.ok(Math.abs(Number(m[2]) - (with_ - without)) <= 0.1 + with_ * 0.01, 'shown difference = with - without');
    assert.equal(r.current.boldHas, false, 'only the measured row shows a time');
    assert.ok(r.current.toasts.includes('Measuring...'));
    assert.ok(r.current.statsUnchanged, 'measuring does not count as activity');
    assert.ok(r.current.chatUnchanged);
});

test('order conflicts: an earlier script removing what a later one would have matched is flagged; unrelated pairs are not', async ({ each }) => {
    const r = await each('orderConflict');
    assert.deepEqual(r.none.out, ['a y b 0 ', 'a y b 1 ', 'a y b 2 ', 'plain R text', 'no y:  here']);
    assert.deepEqual(r.baseline.out, r.none.out);
    assert.deepEqual(r.current.out, r.none.out);
    assert.doesNotMatch(r.baseline.report, /Order conflict/);
    const text = '"Strip tag" runs first and removes what "Tagged" would have matched: 3 times';
    assert.equal(r.current.taggedBadge, text);
    assert.deepEqual(r.current.otherBadges, [null, null, null]);
    assert.match(r.current.summary, /Order conflict: Strip tag runs first and removes what Tagged looks for \(3 times\)\. Swap them or merge them\./);
    assert.match(r.current.report, new RegExp(`^Order conflicts \\(an earlier script removed what a later one looks for\\)\n${text.replace(/[()"]/g, '\\$&')}, e\\.g\\. "a <x>y b 0 "$`, 'm'));
    assert.match(row(reportRows(r.current.report), 'Tagged').Warnings, /order conflict/);
    const long = (await each('orderConflict', { long: true }, { variants: ['current'] })).current;
    assert.match(long.taggedBadge, /removes the literal "Tagged" looks for: 3 times \(match not verified on long inputs\)$/, 'inputs over 4000 characters are not re-run');
});

test('per-message time: "Measure on this chat" lists the 5 slowest messages under the result and in the report', async ({ each }) => {
    const r = (await each('measure', null, { variants: ['current'] })).current;
    const entry = /#(\d+) \((\d+) chars\) ([\d.]+) ms/g;
    const list = [...r.slowest.matchAll(entry)].map(m => m.slice(1).map(Number));
    assert.equal(list.length, 5, r.slowest);
    assert.match(r.slowest, /^Slowest messages \(features off\): #5 \(33602 chars\) /, 'the six-times-longer message 5 comes first, with its length');
    for (let k = 1; k < list.length; k++) assert.ok(list[k - 1][2] >= list[k][2], 'sorted by time');
    assert.ok(list[0][2] > list[1][2] * 2, `message 5 is clearly slower: ${r.slowest}`);
    assert.ok(r.report.includes('\n' + r.slowest + '\n'), 'the report has the same line');
});


test('item 10: summary shows the estimated time saved = (skips + hits + streaming skips) x average run time', async ({ each }) => {
    const r = await each('insights', null, { variants: ['baseline', 'current'] });
    assert.doesNotMatch(r.baseline.text, /≈/);
    const m = /Estimated time saved: ≈([\d.]+) ms/.exec(r.current.text);
    assert.ok(m, r.current.text);
    const want = reportRows(r.current.text).reduce((acc, x) => acc + (num(x.Runs) ? (num(x.Skips) + num(x.Hits) + num(x['Stream skips'])) * num(x['Total ms']) / num(x.Runs) : 0), 0);
    assert.ok(want > 0);
    assert.ok(Math.abs(num(m[1]) - want) <= want * 0.02 + 0.05, `${m[1]} vs ${want}`);
});

test('item 11: scripts that ran many times without ever matching are flagged; matched is counted apart from changed', async ({ each }) => {
    const r = await each('insights', null, { variants: ['current'] });
    const rows = reportRows(r.current.text);
    assert.ok(num(row(rows, 'Changes').Changed) > 0);
    assert.equal(num(row(rows, 'Changes').Matched), num(row(rows, 'Changes').Changed));
    assert.equal(num(row(rows, 'Never changes').Changed), 0);
    assert.equal(num(row(rows, 'Never changes').Matched), 0);
    assert.equal(num(row(rows, 'Same').Changed), 0, 'the replacement equals the match');
    assert.equal(num(row(rows, 'Same').Matched), 25, 'but it matched on every message');
    for (const name of ['Never changes', 'Slow regex']) assert.match(row(rows, name).Warnings, /no match/, name);
    for (const name of ['Changes', 'Rarely runs', 'Same']) assert.doesNotMatch(row(rows, name).Warnings, /no match/, name);
    assert.match(r.current.text, /Candidates to disable \(ran 20\+ times, never matched\): Slow regex, Never changes$/m, 'slowest first; Same is not listed');
});

test('item 12: replacer (macro) time is measured separately from regex time', async ({ each }) => {
    const r = await each('insights', null, { variants: ['baseline', 'current'] });
    assert.doesNotMatch(r.baseline.text, /Replacer ms/);
    const rows = reportRows(r.current.text);
    const macro = row(rows, 'Slow macro');
    const regex = row(rows, 'Slow regex');
    assert.ok(num(macro['Replacer ms']) >= 150, `30 x 2 ms x 3: ${macro['Replacer ms']}`);
    assert.ok(num(macro['Replacer ms']) >= num(macro['Total ms']) * 0.8);
    assert.ok(num(regex['Total ms']) > 0);
    assert.equal(num(regex['Replacer ms']), 0, 'it never matches, so its replacer never runs');
});

test('item 13: nested quantifiers and execution spikes are flagged', async ({ each }) => {
    const rows = reportRows((await each('insights', null, { variants: ['current'] })).current.text);
    assert.match(row(rows, 'Nested').Warnings, /nested quantifier/);
    assert.match(row(rows, 'Slow macro').Warnings, /spike/);
    assert.ok(num(row(rows, 'Slow macro')['Max ms']) > 50);
    assert.doesNotMatch(row(rows, 'Changes').Warnings, /nested|spike/);
});

test('spike samples: the newest run over 50 ms keeps its input length and first 80 characters, in the ⚡ tooltip and the report', async ({ each }) => {
    const r = (await each('insights', null, { variants: ['current'] })).current;
    const head = '@'.repeat(30) + '2'; // the third (newest) slow input
    const sample = new RegExp(`Last spike: [\\d.]+ ms on 31 characters, starting ${JSON.stringify(head)}`);
    assert.match(r.badges['Slow macro']['⚡'], /^One run took [\d.]+ ms \(more than 50 ms\)\n/);
    assert.match(r.badges['Slow macro']['⚡'], sample);
    const section = r.text.slice(r.text.indexOf('\nSpikes (newest run over 50 ms per script)\n'));
    assert.match(section, new RegExp(`^Slow macro: ${sample.source}$`, 'm'));
    assert.doesNotMatch(section, /^Changes:/m, 'only scripts with a spike');
    assert.equal(row(reportRows(r.text), 'Slow macro').Script, 'Slow macro', 'the table is still parsed up to the section');
    const long = (await each('insights', { longHead: true }, { variants: ['current'] })).current;
    assert.match(long.badges['Slow macro']['⚡'], /on 101 characters, starting "@{80}"(\n|$)/, 'the sample is cut at 80 characters');
});

test('exports and slash verbs: JSON and CSV (buttons and /regexperf), /regexperf measure, /regexperf off <name>', async ({ each }) => {
    const r = (await each('exports', null, { variants: ['current'] })).current;
    const data = JSON.parse(r.json);
    const textRows = reportRows(r.text);
    assert.equal(data.rows.length, textRows.length);
    assert.deepEqual(data.rows.map(x => x.name), textRows.map(x => x.Script), 'same rows in the same order');
    const alpha = data.rows.find(x => x.name === 'Alpha, "quoted"');
    assert.equal(alpha.runs, 3);
    assert.deepEqual(alpha.literal, [['alpha']]);
    assert.equal(alpha.pattern, '/alpha/g');
    assert.equal(data.totals.calls, Number(/Ran (\d+) times/.exec(r.text)[1]));
    assert.equal(typeof data.generatedAt, 'string');
    const csv = r.csv.split('\r\n');
    assert.equal(csv[0], 'Rank,Script,Runs,Total ms,Avg ms,Max ms,Replacer ms,Matched,Changed,Skips,Hits,Stream skips,Literal,Min length,Warnings');
    assert.equal(csv.length, 1 + textRows.length);
    assert.ok(csv.some(l => l.includes('"Alpha, ""quoted""",3,')), `quoted name: ${csv[1]}`);
    assert.ok(csv.some(l => l.includes(',"""alpha""",5,')), 'the literal column is quoted too');
    assert.deepEqual(r.copied.map(c => c[0]), ['{', 'R'], 'the JSON and CSV buttons copy the same formats');
    assert.deepEqual(Object.keys(JSON.parse(r.copied[0])), Object.keys(data));
    assert.equal(r.copied[1].split('\r\n')[0], csv[0]);
    assert.match(r.measure, /^This chat \(1 messages\): [\d.]+ ms with the features off/);
    assert.match(r.measureShown, /^This chat \(1 messages\)/, 'the panel shows it too');
    assert.equal(r.offMissing, '"nope" is not in the Regex extension\'s list.');
    assert.equal(r.offAmbiguous, 'Turned off: Beta', 'an exact name wins over a longer one containing it');
    // Beta is off now (saved through the engine, so the script info knows at once): "beta" only matches Betamax
    assert.equal(r.offExact, 'Turned off: Betamax', 'a unique partial match works');
    assert.equal(r.offPartial, '"max" is not in the Regex extension\'s list.', 'both are off: nothing active matches');
    assert.equal(r.offNone, 'Usage: /regexperf off <script name>');
    assert.deepEqual(r.disabled, [false, true, true]);
    assert.match(r.help, /\/regexperf json|\/regexperf csv|\/regexperf measure|\/regexperf off/);
});

test('chat open: optional auto-measure and a one-time hint when the first render was slow', async ({ each }) => {
    const r = (await each('chatOpen', null, { variants: ['current'] })).current;
    assert.deepEqual(r.before, { auto: false, hintMs: 3000 }, 'defaults: off, 3 s');
    assert.equal(r.quiet, 0, 'nothing at the defaults');
    assert.deepEqual([r.afterHint.hints, r.afterHint.measures], [1, 0]);
    assert.match(r.afterHint.text, /^Rendering this chat took 0\.\d s\. A lower "# Messages to Load" \(User Settings\) opens chats faster\.$/);
    assert.deepEqual(r.second, { hints: 1, measures: 0 }, 'the hint is shown once per session');
    assert.equal(r.auto.hints, 1);
    assert.equal(r.auto.measures, 1, 'auto-measure ran once after the chat opened');
    assert.match(r.auto.shown, /^This chat \(4 messages\)/);
    assert.equal(r.auto.setting, true);
});

test('reset settings restores the defaults; open sections are remembered across loads', async ({ each }) => {
    const r = (await each('resetSettings', null, { variants: ['current'] })).current;
    assert.deepEqual(r.openAtStart, { limits: false, lint: false, legend: false, tips: false }, 'closed by default');
    assert.deepEqual(r.changed, { prefilter: false, memoMaxEntries: 4, persistMaxMB: 2 });
    const features = { ...r.after };
    delete features.ui;
    assert.deepEqual(features, { profiler: true, profilerSampling: false, timeReplacer: true, prefilter: true, memo: true, memoStatic: true, memoPostHoc: true, fastPath: true, memoMaxEntries: 3000, memoMaxLen: 20000, memoMaxMB: 64, streamingSkip: true, streamingThrottle: false, streamingThrottleMs: 500, persist: false, persistMaxLen: 60000, persistMaxMB: 8, memoHashKeys: false, autoMeasure: false, loadHintMs: 3000, fuse: false, fuseLen: 20000, breaker: false, breakerMs: 500, breakerCount: 3, lint: true, listBadges: true }, 'defaultSettings');
    assert.deepEqual(r.controls, { prefilter: true, memoMaxEntries: '3000', persistMaxMB: '8' }, 'the controls follow');
    assert.ok(r.saved >= 1, 'saved');
    assert.equal(r.toast, 'Settings restored to their defaults.');
    assert.deepEqual(r.uiAfterOpen, { limits: true }, 'opening a section is remembered');
    assert.deepEqual(r.uiAfterClose, { limits: false });
    const again = (await each('resetSettings', null, { settings: { ui: { limits: true, tips: true } }, variants: ['current'] })).current;
    assert.deepEqual(again.openAtStart, { limits: true, lint: false, legend: false, tips: true }, 'remembered sections open on load');
});

test('other wrappers of RegexProvider.instance.get are noticed, at patch time and later, and warned about once', async ({ each }) => {
    const clean = (await each('wrapperWarning', null, { variants: ['current'] })).current;
    assert.equal(clean.out, 'y');
    assert.doesNotMatch(clean.summary, /get\(\)/, 'no warning normally');
    assert.deepEqual(clean.warns, []);
    const pre = await each('wrapperWarning', null, { prewrap: true, variants: ['baseline', 'current'] });
    assert.equal(pre.baseline.out, 'y');
    assert.doesNotMatch(pre.baseline.summary, /get\(\)/, 'baseline cannot tell');
    assert.equal(pre.current.out, 'y', 'still works');
    assert.match(pre.current.summary, /⚠ Another extension had already replaced the regex engine's get\(\) when Regex Perf Kit loaded/);
    assert.equal(pre.current.warns.length, 1, 'console.warn once');
    assert.equal(pre.current.warnsAfterSecondRender, 1, 'and only once');
    const later = (await each('wrapperWarning', { replaceLater: true }, { variants: ['current'] })).current;
    assert.equal(later.out, 'y');
    assert.match(later.summary, /⚠ Another extension replaced the regex engine's get\(\) after Regex Perf Kit/);
    assert.equal(later.warns.length, 1);
});

test('item 14: a table row opens its script in the regex editor; its off button disables the script', async ({ each }) => {
    const r = await each('rowActions', null, { variants: ['current'] });
    const [alpha, beta] = r.current.ids;
    assert.deepEqual(r.current.events, [`edit ${alpha}`], 'opening uses the drawer; turning off goes through the engine, not the switch');
    assert.deepEqual(r.current.disabled, [false, true]);
    assert.ok(beta);
    assert.equal(r.current.unknownHasActions, false, 'patterns that are not scripts get no actions');
});

test('sortable table: a header click sorts by that column, again flips it; the filter box narrows by name; nothing is saved', async ({ each }) => {
    const r = (await each('sortFilter', null, { variants: ['current'] })).current;
    assert.deepEqual([...r.initial].sort(), ['Alpha', 'Beta', 'Gamma'], 'default: by total time (sub-millisecond runs may tie)');
    assert.deepEqual(r.initialRanks, ['1', '2', '3']);
    assert.deepEqual(r.byRuns, ['Alpha', 'Beta', 'Gamma'], 'runs 4, 3, 0');
    assert.match(r.runsHeader, /Runs ▾$/);
    assert.deepEqual(r.byRunsAsc, ['Gamma', 'Beta', 'Alpha']);
    assert.match(r.runsHeaderAsc, /Runs ▴$/);
    assert.equal(r.ranksAsc[0], String(r.initial.indexOf('Gamma') + 1), 'the # column keeps the rank by total time');
    assert.deepEqual(r.byName, ['Alpha', 'Beta', 'Gamma'], 'text sorts A to Z first');
    assert.deepEqual(r.afterAct, r.byName, 'the actions column is not sortable');
    assert.deepEqual(r.filtered, ['Alpha', 'Beta', 'Gamma'].filter(n => /a/i.test(n)), 'filter "A" is case-insensitive');
    assert.equal(r.noneLeft, 'No script name contains "zzz".');
    assert.deepEqual(r.saved, [], 'sorting and filtering are not settings');
    assert.equal(r.settingsSaves, 0);
});

test('item 15: memo and ⑤ limits are editable (validated) and memo / ⑤ usage is shown', async ({ each }) => {
    const r = await each('limits', null, { variants: ['baseline', 'current'] });
    assert.deepEqual(r.baseline.found, [false, false, false, false]);
    assert.deepEqual(r.current.found, [true, true, true, true]);
    assert.deepEqual(r.current.values, { memoMaxEntries: 4, memoMaxLen: 0, memoMaxMB: 64, persistMaxLen: 123457 });
    assert.match(r.current.usage, /cache: 4 entries/);
    assert.match(r.current.usage, /in this chat: 3 messages, ≈0 KB of 8 MB/);
});

test('③ hashed keys (Limits toggle, default off): exact results from half the memory; toggling clears the cache', async ({ each }) => {
    const r = await each('memoHash', null, { variants: ['baseline', 'current'] });
    assert.equal(r.baseline, null, 'baseline has no such toggle');
    const want = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')} ${'y'.repeat(10000)}`);
    assert.deepEqual(r.current.plain.out, want);
    assert.deepEqual(r.current.hashed.out, want, 'same-length inputs each get their own result');
    assert.deepEqual(r.current.plain.rerun, Array(20).fill(0), 'all hits');
    assert.deepEqual(r.current.hashed.rerun, Array(20).fill(0), 'all hits with hashed keys too');
    assert.equal(r.current.hashed.cleared, 1, 'toggling cleared the cache: the first input ran again');
    assert.ok(r.current.hashed.mb < r.current.plain.mb * 0.55, `half the memory: ${r.current.hashed.mb} vs ${r.current.plain.mb} MB`);
    assert.equal(r.current.hashed.setting, true, 'saved as a setting');
});

test('⑤ key: 64 bits of the text, so same-length fnv1a collisions do not share a result; old-format entries are recomputed', async ({ each }) => {
    const r = await each('persistKey');
    assert.deepEqual(r.none.out, ['zhj0tclp', 'ti0fsnfk', 'ti0fsnfk']);
    assert.deepEqual(r.baseline.out, ['zhj0tclp', 'zhj0tclp', 'ti0fsnfk'], 'baseline serves the colliding message the stored result (bug reproduced)');
    assert.deepEqual(r.current.out, r.none.out);
    assert.match(r.current.key, /^[0-9a-z]+-[0-9a-z]+:8:/, 'two hashes, then the length');
});

test('⑤ budget: beyond the per-chat cap the oldest messages\' results are dropped; usage is shown against the cap', async ({ each }) => {
    const r = await each('persistBudget', null, { variants: ['baseline', 'current'] });
    assert.deepEqual(r.baseline.stored, Array(26).fill(true), 'baseline keeps everything');
    assert.equal(r.baseline.hasLimit, false);
    const kept = r.current.stored.map((v, i) => v ? i : -1).filter(i => i >= 0);
    assert.ok(kept.length >= 18 && kept.length <= 20, `about 20 x 50 KB fit in 1 MB: ${kept.length}`);
    assert.deepEqual(kept, Array.from({ length: kept.length }, (_, k) => 26 - kept.length + k), 'the newest messages are kept, the oldest dropped');
    assert.ok(r.current.chars <= 1048576, 'within the cap');
    assert.match(r.current.usage, new RegExp(`⑤ saved in this chat: ${kept.length} messages, ≈\\d+ KB of 1 MB`));
    assert.equal(r.current.hasLimit, true);
    assert.equal(r.current.limit, 2, 'the cap is editable under Limits');
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
    assert.deepEqual(off.current, off.baseline, 'off by default: same as the baseline (display scripts skipped while live)');
    assert.equal(off.current.at(-1), final);
});

test('release hygiene: manifest version in the changelog, auto_update on, screenshots present and linked', async () => {
    const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const manifest = JSON.parse(read('manifest.json'));
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.auto_update, true);
    assert.match(manifest.homePage, /^https:\/\/github\.com\/Penterson\/st-regex-perf$/);
    assert.match(read('CHANGELOG.md'), new RegExp(`^## ${manifest.version.replace(/\./g, '\\.')} — \\d{4}-\\d{2}-\\d{2}$`, 'm'), 'the changelog has an entry for this version');
    for (const shot of ['docs/screenshot-desktop.png', 'docs/screenshot-mobile.png']) {
        assert.ok(read(shot).length > 10000, shot);
        for (const readme of ['README.md', 'README.en.md']) assert.ok(read(readme).includes(`src="${shot}"`), `${readme} shows ${shot}`);
    }
});

test('unchanged vs baseline: settings, controls, toggles, /regexperf and ⑤ clearing behave as before', async ({ each }) => {
    for (const locale of ['ko-kr', 'en']) {
        const r = await each('ux', null, { locale, variants: ['baseline', 'current'] });
        const added = ['memoMaxMB', 'streamingThrottle', 'streamingThrottleMs', 'persistMaxMB', 'memoHashKeys', 'autoMeasure', 'loadHintMs', 'ui', 'fastPath', 'memoStatic', 'memoPostHoc', 'profilerSampling', 'timeReplacer', 'fuse', 'fuseLen', 'breaker', 'breakerMs', 'breakerCount', 'lint', 'listBadges'];
        assert.deepEqual(Object.keys(r.current.initial).filter(k => !added.includes(k)), Object.keys(r.baseline.initial));
        for (const [k, v] of Object.entries(r.baseline.initial)) assert.equal(r.current.initial[k], v, `default ${k}`);
        assert.deepEqual({ memoMaxMB: r.current.initial.memoMaxMB, streamingThrottle: r.current.initial.streamingThrottle }, { memoMaxMB: 64, streamingThrottle: false });
        for (const id of r.baseline.ids) assert.ok(r.current.ids.includes(id), `#${id}`);
        assert.deepEqual(r.current.checked, r.baseline.checked);
        // ⑥ verifies a script's first fast-path runs against SillyTavern's callback, so those runs execute the regex twice
        assert.deepEqual({ ...r.current.toggled, rerun: Math.min(r.current.toggled.rerun, 1) }, r.baseline.toggled);
        assert.deepEqual(r.current.stored, r.baseline.stored);
        const verbs = ['reset | text | json | csv | measure | off <script name>']; // the argument help grew with the new verbs
        assert.deepEqual(r.current.slash.args, verbs);
        if (locale === 'ko-kr') { // the baseline's UI is Korean in every locale
            assert.deepEqual(r.current.cleared, r.baseline.cleared);
            assert.deepEqual({ ...r.current.slash, args: 0 }, { ...r.baseline.slash, args: 0 });
        } else {
            assert.deepEqual({ ...r.current.cleared, toast: 0 }, { ...r.baseline.cleared, toast: 0 });
            assert.equal(r.current.cleared.toast, 'Removed 1 persistent cache entries.');
            assert.deepEqual({ ...r.current.slash, reset: 0, args: 0 }, { ...r.baseline.slash, reset: 0, args: 0 });
            assert.equal(r.current.slash.reset, 'Stats reset');
        }
    }
});

test('unchanged vs baseline: saved user settings are kept as they are', async ({ each }) => {
    const saved = { profiler: false, prefilter: false, memo: false, memoMaxEntries: 10, memoMaxLen: 99, streamingSkip: false, persist: true, persistMaxLen: 7 };
    const r = await each('ux', null, { settings: saved, variants: ['baseline', 'current'] });
    for (const [k, v] of Object.entries(saved)) {
        assert.equal(r.baseline.initial[k], v);
        assert.equal(r.current.initial[k], v, k);
    }
    assert.deepEqual(r.current.checked, r.baseline.checked);
});

test('feature list 3 row 3: bypass does not stick when something throws between the two hooks', async ({ each }) => {
    const r = await each('bypassStuck', null, { variants: ['none', 'current'] });
    assert.deepEqual(r.none, ['y', 'y', true, 'q', 'y']);
    assert.deepEqual(r.current, r.none);
});

test('feature list 3 row 4: ⑤ keys use a display-only version, so editing a prompt script keeps the stored results', async ({ each }) => {
    const r = await each('persistDisplayVersion', null, { variants: ['none', 'current'] });
    assert.deepEqual(r.none, ['b p', 0, 'b p', 0, 'b p', 0, 'c p', 0]);
    assert.deepEqual(r.current, ['b p', 0, 'b p', 1, 'b p', 2, 'c p', 2]);
});

test('feature list 3 row 2: a find pattern with a dynamic macro keeps its script name, ③ and ④', async ({ each }) => {
    const r = await each('dynamicFind', null, { variants: ['none', 'current'] });
    const allowed = new Set(['X [b] U', '[a] X U']);
    for (const o of [...r.none.outs, ...r.current.outs]) assert.ok(allowed.has(o), o);
    assert.equal(r.current.live, '[a] [b] Ann!', 'display scripts rest while streaming');
    assert.doesNotMatch(r.current.report, /\(unknown\)/);
    const names = r.current.rows.map(x => x.name);
    assert.equal(names.filter(n => n === 'Dyn').length, 1, `one row for the raw pattern: ${names.join(', ')}`);
    assert.ok(names.includes('Var'));
    const dyn = r.current.rows.find(x => x.name === 'Dyn');
    assert.equal(dyn.runs + dyn.hits, 6, JSON.stringify(dyn));
    assert.ok(dyn.hits >= 1, 'the same compiled pattern came back and hit ③');
    assert.equal(dyn.streamSkips, 1);
});

test('feature list 1.1: the fast path gives SillyTavern\'s own output for every template (differential fuzz, off vs on)', async ({ each }) => {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const r = await each('fastPathEquivalence', { seed, scripts: 80 }, { variants: ['current'] });
    assert.equal(r.current.mismatch, null, `seed ${seed}: ${JSON.stringify(r.current.mismatch)}`);
    assert.deepEqual(r.current.fallbacks, [], `seed ${seed}: the self-verification disagreed`);
    assert.equal(r.current.compared, 640);
    assert.ok(r.current.fastRuns >= 20, `seed ${seed}: only ${r.current.fastRuns} fast runs`);
});

test('feature list 1.1: the fast path removes the replacer time; matched, changed and the output are unchanged', async ({ each }) => {
    const r = await each('fastPathStats', null, { variants: ['current'] });
    assert.equal(r.current.same, true);
    assert.equal(r.current.off.fastRuns, 0);
    assert.equal(r.current.on.fastRuns, 1);
    assert.equal(r.current.on.replacerMs, 0);
    assert.deepEqual([r.current.on.matched, r.current.on.changed], [r.current.off.matched, r.current.off.changed]);
});

test('feature list 1.1: self-verification turns the fast path off for a script whose replacer disagrees, with a warning', async ({ each }) => {
    const r = await each('fastPathFallback', null, { variants: ['current'] });
    assert.deepEqual(r.current, ['ZZ', true, 'b']);
});

test('feature list 1.1: matched text that assembles a macro with the replacement is still substituted', async ({ each }) => {
    const r = await each('fastPathAssembled', null, { variants: ['none', 'current'] });
    assert.deepEqual(r.none, ['Ann', 'Ann and Ann']);
    assert.deepEqual(r.current, r.none);
});

test('feature list 1.2: {{char}} replacements are cached per value set and miss after a rename; {{random}} is never cached', async ({ each }) => {
    const r = await each('memoStatic', null, { variants: ['none', 'current'] });
    assert.deepEqual(r.none.outs.slice(0, 5), ['Cat', 'Cat', 'Cat', 'Cat', 'Dog']);
    assert.deepEqual(r.current.outs.slice(0, 5), r.none.outs.slice(0, 5));
    assert.notEqual(r.current.outs[5], r.current.outs[6], 'two rolls');
    assert.equal(r.current.hits.Who, 3, JSON.stringify(r.current.hits));
    assert.equal(r.current.hits.Dice ?? 0, 0);
});

test('feature list 1.2: macro syntax outside the matched text does not prevent caching; inside a match it does', async ({ each }) => {
    const r = await each('memoPostHoc', null, { variants: ['none', 'current'] });
    assert.deepEqual(r.none.outs, ['use {{user}} like this: <b>x</b>', 'use {{user}} like this: <b>x</b>', 'say <b>Ann</b> now', 'say <b>Bob</b> now']);
    assert.deepEqual(r.current.outs, r.none.outs);
    assert.equal(r.current.afterOutside, 1, 'the second run was a hit');
    assert.equal(r.current.afterInside, 1, 'a match with macro syntax is never served from the memo');
});

test('feature list 1.2: an unchanged output is stored as a marker, not as a copy', async ({ each }) => {
    const r = (await each('memoSame', null, { variants: ['current'] })).current;
    assert.equal(r.same, true);
    assert.equal(r.hits, 1);
    assert.ok(r.bytes > 0 && r.bytes <= r.len * 2 + 64, `bytes ${r.bytes} for a ${r.len}-character input`);
});

test('feature list 3 row 5: script info is rebuilt on events or a fingerprint change, never on a timer', async ({ each }) => {
    const r = (await each('rebuilds', null, { variants: ['current'] })).current;
    assert.deepEqual(r.outs, ['AB', 'Ab']);
    assert.equal(r.builds[1], r.builds[0], 'no rebuild while nothing changed');
    assert.equal(r.builds[2], r.builds[0] + 1, 'one rebuild after the switch, caught by the fingerprint');
    assert.deepEqual(r.active, [2, 2, 1]);
});

test('feature list 1.4: "Measure on this chat" yields to the page between chunks of messages', async ({ each }) => {
    const r = (await each('measureAsync', null, { variants: ['current'] })).current;
    assert.match(r.text, /^This chat \(120 messages\)/);
    assert.ok(r.ticks >= 20, `the page ran ${r.ticks} timer ticks during the measurement (2 passes of 12 chunks)`);
});

test('feature list 1.3: ⑤ usage is kept incrementally and matches a scan of the chat', async ({ each }) => {
    const r = (await each('persistAccounting', null, { variants: ['current'] })).current;
    for (const [shown, scanned] of [r.a, r.b]) {
        assert.deepEqual(shown, scanned);
        assert.ok(scanned.chars <= r.max && scanned.entries >= 5, JSON.stringify(scanned));
    }
});

test('feature list 1.3: sampled profiling after 1000 runs; the replacer timing can be turned off', async ({ each }) => {
    const r = (await each('sampling', null, { variants: ['current'] })).current;
    assert.equal(r.sampled.sampled, true);
    for (const k of ['runs', 'changed', 'matched']) assert.ok(Math.abs(r.sampled[k] - 1100) <= 8, `${k}: ${JSON.stringify(r.sampled)}`);
    assert.deepEqual(r.untimed, { runs: 5, replacerMs: 0, matched: 5, sampled: false });
});

test('feature list 1.3: the panel refreshes on its own after activity, on a frame, not on a timer', async ({ each }) => {
    const r = (await each('autoRefresh', null, { variants: ['current'] })).current;
    assert.equal(r.immediately, r.before, 'nothing is rendered inside the regex call');
    assert.notEqual(r.later, r.before, 'rendered within 1.3 s without the refresh button');
    assert.equal(r.later, '7');
});

test('feature list 1.5: with the fuse and the breaker off (defaults) a risky script runs as always; the analyzer flags it', async ({ each }) => {
    const r = await each('breakerFuse', { mode: 'off' }, { variants: ['none', 'current'] });
    assert.deepEqual(r.none.outs, ['Y' + 'a'.repeat(1500) + ' Q', 'x'.repeat(22) + ' Q', 'x'.repeat(22) + ' Q', 'Y Q']);
    assert.deepEqual(r.current.outs, r.none.outs);
    assert.deepEqual(r.current.after, { fused: 0, broken: 0, tripped: false, redos: 'exp' });
    assert.deepEqual(r.current.plain, { fused: 0, broken: 0, tripped: false, redos: null });
    assert.equal(r.current.toast, '');
});

test('feature list 1.5: the fuse skips inputs over fuseLen for risky scripts only', async ({ each }) => {
    const r = (await each('breakerFuse', { mode: 'fuse' }, { variants: ['current'] })).current;
    assert.deepEqual(r.outs, ['xxy' + 'a'.repeat(1500) + ' Q', 'x'.repeat(22) + ' Q', 'x'.repeat(22) + ' Q', 'Y Q']);
    assert.deepEqual(r.after, { fused: 1, broken: 0, tripped: false, redos: 'exp' });
    assert.deepEqual(r.plain, { fused: 0, broken: 0, tripped: false, redos: null }, 'the long input ran through the plain script');
});

test('feature list 1.5: the circuit breaker turns a script off after N long runs, with an Undo in the toast', async ({ each }) => {
    const r = (await each('breakerFuse', { mode: 'breaker' }, { variants: ['current'] })).current;
    assert.deepEqual(r.outs.slice(0, 3), ['Y' + 'a'.repeat(1500) + ' Q', 'x'.repeat(22) + ' Q', 'x'.repeat(22) + ' Q']);
    assert.equal(r.outs[3], 'xxy Q', 'skipped after the trip');
    assert.deepEqual(r.after, { fused: 0, broken: 1, tripped: true, redos: 'exp' });
    assert.match(r.toastText, /^"Risky" was turned off for this session: 2 runs took over 20 ms\. Undo Open script$/);
    assert.match(r.toast, /class="rpk-undo"/);
    assert.equal(r.undone, 'Y Q', 'Undo turns it back on');
});

test('feature list 1.5: the report and the badges explain each backtracking risk with a rewrite suggestion', async ({ each }) => {
    const r = (await each('redosReport', null, { variants: ['current'] })).current;
    assert.deepEqual(r.redos.Nested, { severity: 'exp', kind: 'nested', snippet: '(?:\\w+\\s?)+' });
    assert.deepEqual(r.redos.Adjacent, { severity: 'poly', kind: 'adjacent', snippet: '\\s*\\s*' });
    assert.deepEqual(r.redos.Fine, { severity: null, kind: null, snippet: null });
    assert.deepEqual(r.redos.Dot, { severity: null, kind: 'dotalt', snippet: '(.|\\n)*' });
    assert.match(r.badges.Nested['(a+)+'], /^Exponential backtracking: nested quantifier \(\?:\\w\+\\s\?\)\+\. Repeat one thing only/);
    assert.match(r.badges.Adjacent['a*a*'], /^Polynomial backtracking: adjacent overlapping quantifiers \\s\*\\s\*\. Merge them/);
    assert.deepEqual(Object.keys(r.badges.Fine), []);
    assert.deepEqual(Object.keys(r.badges.Dot), [], 'a suggestion alone gets no badge');
    const section = r.report.slice(r.report.indexOf('\nBacktracking risks'));
    assert.match(section, /^Nested: exponential: nested quantifier \(\?:\\w\+\\s\?\)\+\. Repeat one thing only: /m);
    assert.match(section, /^Adjacent: polynomial: adjacent overlapping quantifiers \\s\*\\s\*\. Merge them into one quantifier/m);
    assert.match(section, /^Dot: \(\.\|\\n\)\* → a character class such as \[\\s\\S\]$/m);
    assert.doesNotMatch(section, /^Fine:/m);
    assert.deepEqual([r.counts.redos, r.counts.redosExp], [2, 1]);
});

test('feature list 2.2: invalid patterns are listed with the engine\'s error in the summary, the report and the JSON', async ({ each }) => {
    const r = (await each('invalidList', null, { variants: ['current'] })).current;
    assert.equal(r.out, 'OK (abc', 'SillyTavern leaves the text alone for a broken script');
    assert.equal(r.invalid.length, 1);
    assert.equal(r.invalid[0].name, 'Broken');
    assert.equal(r.invalid[0].type, 'global');
    assert.match(r.invalid[0].error, /Unterminated group/);
    assert.equal(r.counts.invalid, 1);
    assert.match(r.summary, /Invalid patterns \(1\), doing nothing: Broken \(Invalid regular expression: \/\(abc\/g: Unterminated group\)/);
    assert.match(r.report, /^Invalid patterns \(1\)\nBroken: Invalid regular expression: \/\(abc\/g: Unterminated group$/m);
});

test('feature list 2.2: spikes keep a history with the message; the ⚡ badge scrolls to it; a repro can be copied', async ({ each }) => {
    const r = (await each('spikes', null, { variants: ['current'] })).current;
    assert.deepEqual(r.spikes.map(s => s.messageId), [2, 1, 0], 'newest first');
    assert.deepEqual(r.spikes.map(s => s.len), [31, 31, 31]);
    assert.deepEqual(r.scrolled, ['2']);
    assert.match(r.copied, /^\/@\/g\n31 chars\n"@{30}2"$/);
    assert.match(r.title, /Click to scroll to message #2/);
    assert.match(r.title, /\n[\d.]+ ms on 31 characters \(#1\)\n[\d.]+ ms on 31 characters \(#0\)/);
    assert.match(r.report, /^Slow macro: Last spike: [\d.]+ ms on 31 characters, starting "@{30}2" \(#2\)\n {2}[\d.]+ ms \/ 31 \(#1\)\n {2}[\d.]+ ms \/ 31 \(#0\)$/m);
    assert.ok(r.toasts.includes('Copied to the clipboard.'));
});

test('feature list 2.3: lint rows (missing g, group references, double escapes, browser support, duplicates); a fix and the off switch save through the engine', async ({ each }) => {
    const r = (await each('lintRules', null, { variants: ['current'] })).current;
    assert.deepEqual(r.outs, ['bar foo foo 0', 'bar foo foo 1', 'bar foo foo 2', 'xY 1']);
    const rules = Object.fromEntries(r.rows.map(x => [x.rule, x]));
    assert.deepEqual(Object.keys(rules).sort(), ['browser-compat', 'double-escape', 'duplicate', 'group-ref', 'missing-g']);
    assert.deepEqual([rules['missing-g'].script, rules['missing-g'].fix], ['NoG', 'Add g']);
    assert.deepEqual([rules['group-ref'].script, rules['group-ref'].fix], ['Ref', null]);
    assert.deepEqual([rules['double-escape'].script, rules['double-escape'].fix], ['Esc', 'Unescape']);
    assert.deepEqual([rules['browser-compat'].script, rules['browser-compat'].fix], ['Look', null]);
    assert.deepEqual([rules.duplicate.script, rules.duplicate.fix], ['Dup1, Dup2', null]);
    assert.ok(r.lint.some(x => x.rule === 'missing-g' && x.fixable && x.ids.length === 1), JSON.stringify(r.lint));
    assert.equal(r.fixed, '/foo/g', 'the fix was saved through saveScriptsByType');
    assert.equal(r.off, true, 'turned off through saveScriptsByType, no Regex drawer in the page');
    assert.ok(r.saves >= 2, `saveSettingsDebounced ran for both saves (${r.saves})`);
    assert.ok(r.popups >= 1, 'the fix was confirmed in a popup first');
    assert.ok(r.toasts.includes('Saved: NoG') && r.toasts.includes('Turned off: Ref'), r.toasts.join(' | '));
});

test('feature list 2.1: a cost chip after each script in the Regex extension\'s list, restored when the list is re-rendered', async ({ each }) => {
    const r = (await each('listBadges', null, { variants: ['current'] })).current;
    assert.match(r.chip1 ?? '', /^[\d.]+ ms · \d+%$/, `chip ${r.chip1}`);
    assert.equal(r.chip2, r.chip1);
});

test('unchanged vs baseline: without MessageFormatter hooks ⑤ is disabled with a note', async ({ each }) => {
    const r = await each('ux', null, { hooks: false, variants: ['baseline', 'current'] });
    assert.deepEqual(r.current.checked, r.baseline.checked);
    assert.equal(r.current.checked.rpk_persist.disabled, true);
    assert.match(r.current.note, /MessageFormatter/);
    assert.deepEqual(r.current.stored, r.baseline.stored, 'nothing is stored without hooks');
});
