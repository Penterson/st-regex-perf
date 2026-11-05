// Scenarios run inside the harness page. Each receives the harness handles (see boot.js) and returns plain data.

/** Regex placements (SillyTavern's regex_placement). */
export const P = { USER: 1, AI: 2, SLASH: 3, WI: 5, REASONING: 6 };

let ids = 0;
/** A regex script with SillyTavern's defaults for every field. */
export function script(props) {
    return {
        id: `s${++ids}`,
        scriptName: `script ${ids}`,
        findRegex: '',
        replaceString: '',
        trimStrings: [],
        placement: [P.AI],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        ...props,
    };
}

/** Installs global scripts the way SillyTavern does before rendering: settings change, then the chat (re)loads. */
export async function useScripts(h, scripts) {
    h.extension_settings.regex = scripts;
    await h.eventSource.emit(h.event_types.CHAT_CHANGED);
}

/** Extension settings per test profile (applied on top of the extension's defaults). */
const PROFILES = {
    default: {},
    allOn: { profiler: true, prefilter: true, memo: true, streamingSkip: true, persist: true },
    allOff: { profiler: false, prefilter: false, memo: false, streamingSkip: false, persist: false },
    tinyMemo: { memoMaxEntries: 5, memoMaxLen: 60, persist: true },
    compromise: { streamingThrottle: true, streamingThrottleMs: 0, persist: true },
};

/** Applies a profile to whichever extension variant is loaded (no-op for "none"). */
export function applyProfile(h, profile) {
    const rpk = h.extension_settings.regex_perf_kit;
    if (rpk) Object.assign(rpk, PROFILES[profile] ?? profile);
    return rpk;
}

/** Depth of chat[i] as messageFormatting() computes it (non-system messages after it). */
const depthOf = (chat, i) => (chat[i].is_system ? undefined : chat.slice(i + 1).filter(m => !m.is_system).length);

/** Every getRegexedString() mode SillyTavern uses, plus the display pipeline, for every message. */
function renderAll(h, rec, tag) {
    const { chat } = h.st;
    chat.forEach((m, i) => {
        const depth = depthOf(chat, i);
        const modes = { save: {}, md: { isMarkdown: true }, prompt: { isPrompt: true }, mdDepth: { isMarkdown: true, depth }, promptDepth: { isPrompt: true, depth }, edit: { isEdit: true } };
        for (const placement of Object.values(P)) {
            for (const [mode, opts] of Object.entries(modes)) rec(`${tag} #${i} p${placement} ${mode}`, h.engine.getRegexedString(m.mes, placement, opts));
        }
        rec(`${tag} #${i} display`, h.st.messageFormatting(m.mes, m.name, m.is_system, m.is_user, i));
        if (m.extra?.reasoning) rec(`${tag} #${i} reasoning`, h.st.messageFormatting(m.extra.reasoning, '', false, false, i, {}, true));
    });
}

/**
 * The broad equivalence workload: cold and warm renders, setting toggles, a cache clear and a streamed message.
 * Labels containing "live" are renders while a stream is running.
 */
export async function equivalence(h, { profile }) {
    const corpus = await import('./corpus.js');
    const rpk = applyProfile(h, profile);
    h.st.setState({ name1: 'User', name2: 'Dr. A (B)', chat: corpus.CHAT() });
    // ⑤ stores display output, so a {{random}} display script keeps its first roll there (documented in the README).
    await useScripts(h, corpus.SCRIPTS().filter(s => !(PROFILES[profile].persist && s.scriptName === 'Dice')));
    const out = [];
    const rec = (label, value) => out.push([label, value]);
    const toggle = (key) => { if (rpk) rpk[key] = !rpk[key]; };
    const counted = countNativeReplaces();

    renderAll(h, rec, 'cold');
    renderAll(h, rec, 'warm');
    for (const key of ['memo', 'prefilter', 'profiler']) {
        toggle(key);
        renderAll(h, rec, `${key} toggled`);
        toggle(key);
        renderAll(h, rec, `${key} restored`);
    }
    h.engine.RegexProvider.instance.clear();
    await h.eventSource.emit(h.event_types.CHAT_CHANGED);
    renderAll(h, rec, 'after clear');
    // "Measure on this chat" re-renders the chat with the features off and on: nothing it leaves behind may change
    // the output
    document.querySelector('#rpk_measure')?.click();
    await new Promise(r => setTimeout(r, 60));
    h.st.reseed(); // its renders also rolled {{random}}, as any re-render does
    renderAll(h, rec, 'after measure');

    // A swipe streams into the last message, as StreamingProcessor does: GENERATION_STARTED, live renders, the
    // final render once isFinished is set, then GENERATION_ENDED.
    const { chat } = h.st;
    const last = chat.length - 1;
    const full = chat[last].mes;
    const sp = { messageId: last, isFinished: false, isStopped: false };
    await h.eventSource.emit(h.event_types.GENERATION_STARTED, 'swipe', {}, false);
    h.st.setState({ streamingProcessor: sp });
    for (let n = 7; n < full.length; n += 13) {
        chat[last].mes = full.slice(0, n);
        rec(`live display ${n}`, h.st.messageFormatting(chat[last].mes, chat[last].name, false, false, last));
        rec(`live save ${n}`, h.engine.getRegexedString(chat[last].mes, P.AI));
    }
    sp.isFinished = true;
    chat[last].mes = full;
    rec('stream final', h.st.messageFormatting(full, chat[last].name, false, false, last));
    h.st.setState({ streamingProcessor: null });
    await h.eventSource.emit(h.event_types.GENERATION_ENDED, chat.length);
    renderAll(h, rec, 'after stream');
    return { records: out, nativeReplaces: counted.stop() };
}

/** Counts regex executions (RegExp.prototype[Symbol.replace] calls) per pattern source; stop() returns the total. */
function countNativeReplaces() {
    const orig = RegExp.prototype[Symbol.replace];
    const bySource = {};
    let total = 0;
    RegExp.prototype[Symbol.replace] = function (...args) {
        total++;
        bySource[this.source] = (bySource[this.source] ?? 0) + 1;
        return orig.apply(this, args);
    };
    return { bySource, stop: () => { RegExp.prototype[Symbol.replace] = orig; return total; } };
}

export async function smoke(h) {
    h.extension_settings.regex = [script({ findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '[b]$1[/b]' })];
    const out = h.engine.getRegexedString('Hello **world**!', P.AI);
    const re = h.engine.RegexProvider.instance.get('/x/g');
    return { out, wrapped: Object.getPrototypeOf(re) !== RegExp.prototype };
}

/** Runs fn while counting regex executions per pattern source. */
function executionsBySource(fn) {
    const counter = countNativeReplaces();
    try {
        fn();
    } finally {
        counter.stop();
    }
    return counter.bySource;
}

/** The extension's text report (the /regexperf text command), or '' without the extension. */
async function report(h) {
    return h.commands.regexperf ? String(await h.commands.regexperf.callback({}, 'text')) : '';
}

/** Item 1. Case-insensitive patterns whose matches need Unicode case folding (σ/Σ/ς, µ/μ, ſ/s). */
export async function caseFold(h) {
    await useScripts(h, [
        script({ findRegex: '/ΣΟΦΙΑ/gi', replaceString: '[sophia]' }),
        script({ findRegex: '/σ/gi', replaceString: '[sigma]' }),
        script({ findRegex: '/μm/gi', replaceString: '[micrometre]' }),
        script({ findRegex: '/ſun/giu', replaceString: '[sun]' }),
    ]);
    return ['ΟΔΟΣ', 'οδος', 'a 5µm grain', 'Sunday', 'σοφια'].map(s => h.engine.getRegexedString(s, P.AI));
}

/** Item 2. A script's replacement is edited, then the chat reloads (or a preset switches) without RegexProvider.clear(). */
export async function staleEdit(h) {
    const out = [];
    await useScripts(h, [script({ findRegex: '/hello/g', replaceString: 'A' })]);
    out.push(h.engine.getRegexedString('hello there', P.AI));
    // The regex editor saves a new object for the same id, then reloads the chat.
    h.extension_settings.regex = [{ ...h.extension_settings.regex[0], replaceString: 'B' }];
    await h.eventSource.emit(h.event_types.CHAT_CHANGED);
    out.push(h.engine.getRegexedString('hello there', P.AI));
    // Switching to a preset whose scripts reuse the pattern: PRESET_CHANGED, no clear, no reload.
    h.extension_settings.preset_allowed_regex = { [h.preset.apiId]: [h.preset.name] };
    h.extension_settings.regex = [];
    h.preset.scripts = [script({ findRegex: '/hello/g', replaceString: 'C', markdownOnly: true })];
    await h.eventSource.emit(h.event_types.PRESET_CHANGED, { apiId: h.preset.apiId, name: h.preset.name });
    out.push(h.engine.getRegexedString('hello there', P.AI, { isMarkdown: true }));
    return out;
}

/** Item 3. Matched text that contains macros: SillyTavern substitutes them again after inserting the groups. */
export async function macroInMatch(h) {
    await useScripts(h, [
        script({ findRegex: '/\\[(.*?)\\]/g', replaceString: '($1)' }),
        // a group reference that completes a legacy marker: {user} -> <user>
        script({ findRegex: '/\\{(\\w+)\\}/g', replaceString: '<$1>' }),
        // a trim string with a legacy marker
        script({ findRegex: '/~(.+?)~/g', replaceString: '$1', trimStrings: ['<CHAR>'] }),
    ]);
    const out = [];
    for (const [user, char] of [['Ann', 'Cat'], ['Bob', 'Kit']]) {
        h.st.setState({ name1: user, name2: char });
        out.push(h.engine.getRegexedString('Hi [{{user}}] and [<USER>]', P.AI));
        out.push(h.engine.getRegexedString('Hi {user}', P.AI));
        out.push(h.engine.getRegexedString('~Cat waves~', P.AI));
    }
    out.push(h.engine.getRegexedString('Roll [{{random::1::2::3}}]', P.AI));
    out.push(h.engine.getRegexedString('Roll [{{random::1::2::3}}]', P.AI));
    return out;
}

/** Item 4. ⑤ keeps display output per message; renaming the persona or the character must refresh it. */
export async function persistNames(h) {
    applyProfile(h, { persist: true });
    await useScripts(h, [
        script({ findRegex: '/\\bme\\b/g', replaceString: '{{user}}', markdownOnly: true }),
        script({ findRegex: '/\\bthem\\b/g', replaceString: '{{char}}', markdownOnly: true }),
        script({ findRegex: '/\\[(.*?)\\]/g', replaceString: '$1', trimStrings: ['{{char}}'], markdownOnly: true }),
    ]);
    h.st.setState({ name1: 'Ann', name2: 'Cat', chat: [{ name: 'Cat', is_user: false, is_system: false, mes: 'me and them [Cat waves]', extra: {} }] });
    const render = () => h.st.messageFormatting(h.st.chat[0].mes, h.st.chat[0].name, false, false, 0);
    const out = [render(), render()];
    h.st.setState({ name1: 'Bob' });
    out.push(render());
    h.st.chat[0].name = 'Kit'; // the author name SillyTavern passes as ch_name
    h.st.setState({ name2: 'Kit' });
    out.push(render());
    return out;
}

/** Item 5. substituteRegex = 2 (ESCAPED): recognized as its script, memoized, and skipped while streaming. */
export async function escapedSubst(h) {
    h.st.setState({ name1: 'User', name2: 'Dr. A (B)' });
    const s = script({ scriptName: 'Escaped char', findRegex: '/{{char}}: (.+)/g', replaceString: '<b>$1</b>', substituteRegex: 2, markdownOnly: true });
    await useScripts(h, [s]);
    const mes = 'Dr. A (B): hello';
    const source = h.st.substituteParamsExtended('{{char}}: (.+)', {}, (x) => x.replace(/[.^$*+?{}[\]\\/|()]/g, '\\$&'));
    const display = () => h.engine.getRegexedString(mes, P.AI, { isMarkdown: true });
    const first = display();
    const second = executionsBySource(display)[source] ?? 0;
    // Unknown patterns (compiled outside any script) still get a needle; the literal column must show it.
    'xx abc yy'.replace(h.engine.RegexProvider.instance.get('/abc/g'), 'z');
    await h.eventSource.emit(h.event_types.GENERATION_STARTED, 'normal', {}, false);
    h.st.setState({ streamingProcessor: { messageId: 0, isFinished: false, isStopped: false } });
    const live = display();
    h.st.setState({ streamingProcessor: null });
    await h.eventSource.emit(h.event_types.GENERATION_ENDED, 1);
    return { first, second, live, report: await report(h) };
}

/** Item 8. The hand-checked cases and the fuzzer, in Chrome, against the loaded extension's extractNeedle(). */
export async function needleFuzz(h, { seed, patterns }) {
    const { extractNeedle } = await import(`/scripts/extensions/third-party/${h.variant}/index.js`);
    const f = await import('/harness/needle-fuzz.js');
    return { cases: f.runCases(extractNeedle), fuzz: f.fuzz(extractNeedle, { seed, patterns }) };
}

/** Item 8. Literals inside groups and alternations prefilter; an optional astral character under u is not a needle. */
export async function needleCoverage(h) {
    const group = script({ findRegex: '/(?:<summary>)([\\s\\S]*?)(?:<\\/summary>)/g', replaceString: '$1' });
    const alt = script({ findRegex: '/<thinking>[\\s\\S]*?<\\/thinking>|<think>[\\s\\S]*?<\\/think>/g', replaceString: '' });
    const astral = script({ findRegex: '/💬?"(.+?)"/gu', replaceString: '<q>$1</q>' });
    await useScripts(h, [group, alt, astral]);
    const plain = 'He said "hi" and left.';
    const runs = executionsBySource(() => h.engine.getRegexedString(plain, P.AI));
    const src = (s) => h.engine.RegexProvider.instance.get(s.findRegex).source;
    return {
        out: [plain, 'a <summary>b</summary> <think>c</think>'].map(s => h.engine.getRegexedString(s, P.AI)),
        groupRuns: runs[src(group)] ?? 0,
        altRuns: runs[src(alt)] ?? 0,
    };
}

/** AND prefilter and minimum length: every mandatory literal must be present, shorter messages than the least match skip. */
export async function needleAnd(h) {
    const both = script({ scriptName: 'Both', findRegex: '/x(?:ab)+y/g', replaceString: '!' }); // "xab" & "aby"
    const five = script({ scriptName: 'Five', findRegex: '/\\d{5}/g', replaceString: '#' }); // no literal, at least 5 characters
    const tag = script({ scriptName: 'Tag', findRegex: '/<status>([\\s\\S]*?)<\\/status>/g', replaceString: '$1' }); // "</status>" & "<status>"
    await useScripts(h, [both, five, tag]);
    const src = (s) => h.engine.RegexProvider.instance.get(s.findRegex).source;
    const inputs = ['xab aby', 'xab only', 'xababy', '123', '12345', 'has </status> only', '<status>ok</status>'];
    const out = [];
    const runs = inputs.map(str => executionsBySource(() => out.push(h.engine.getRegexedString(str, P.AI))));
    const per = (s) => runs.map(r => r[src(s)] ?? 0);
    return { out, both: per(both), five: per(five), tag: per(tag), report: await report(h) };
}

/**
 * Shared literal check: each literal is scanned once per input however many scripts look for it; a displayed message
 * (display: true) keeps its answers for its re-renders, a save-time input does not.
 */
export async function litMemo(h, { display }) {
    await useScripts(h, [
        script({ scriptName: 'A1', findRegex: '/<a>\\d/g', replaceString: '1', markdownOnly: display }), // "<a>" twice
        script({ scriptName: 'A2', findRegex: '/<a>\\w/g', replaceString: '2', markdownOnly: display }),
        script({ scriptName: 'B', findRegex: '/<b>/g', replaceString: '3', markdownOnly: display }),
        script({ scriptName: 'C', findRegex: '/<c>/gi', replaceString: '4', markdownOnly: display }), // case-insensitive: a RegExp check, not includes()
        script({ scriptName: 'D', findRegex: '/<d>/g', replaceString: '{{user}}', markdownOnly: display }), // impure: never memoized by ③, still prefiltered
    ]);
    const mes = 'no tags here but <a>y and <D> ' + 'words '.repeat(50);
    const orig = String.prototype.includes;
    const scans = {};
    String.prototype.includes = function (lit, ...rest) {
        if (lit[0] === '<') scans[lit] = (scans[lit] ?? 0) + 1; // the literals (flags.includes('u') and such are not counted)
        return orig.call(this, lit, ...rest);
    };
    const out = [];
    const perRender = [];
    try {
        for (let k = 0; k < 3; k++) {
            const before = Object.values(scans).reduce((a, b) => a + b, 0);
            out.push(h.engine.getRegexedString(mes, P.AI, display ? { isMarkdown: true } : {}));
            perRender.push(Object.values(scans).reduce((a, b) => a + b, 0) - before);
        }
    } finally {
        String.prototype.includes = orig;
    }
    return { out, scans, perRender };
}

/** Item 6. Memo memory budget: with a 1 MB budget, old large entries are evicted (LRU) well before the entry cap. */
export async function memoBudget(h) {
    applyProfile(h, { memoMaxMB: 1, memoMaxLen: 20000 });
    const s = script({ findRegex: '/x/g', replaceString: 'y' });
    await useScripts(h, [s]);
    const inputs = Array.from({ length: 100 }, (_, i) => `${i} ` + 'x'.repeat(10000));
    const outs = inputs.map(str => h.engine.getRegexedString(str, P.AI));
    const source = h.engine.RegexProvider.instance.get(s.findRegex).source;
    const runsFirst = executionsBySource(() => h.engine.getRegexedString(inputs[0], P.AI))[source] ?? 0;
    const runsLast = executionsBySource(() => h.engine.getRegexedString(inputs[99], P.AI))[source] ?? 0;
    return { ok: outs.every((o, i) => o === `${i} ` + 'y'.repeat(10000)), runsFirst, runsLast };
}

/** Item 7. Display scripts outside a generation do not build getContext(); during one, the exact check still decides. */
export async function streamingCheck(h) {
    await useScripts(h, [
        script({ findRegex: '/a/g', replaceString: 'A', markdownOnly: true }),
        script({ findRegex: '/b/g', replaceString: 'B', markdownOnly: true }),
    ]);
    const display = () => h.engine.getRegexedString('ab', P.AI, { isMarkdown: true });
    const contexts = (fn) => {
        const before = h.calls.getContext;
        const out = fn();
        return [out, h.calls.getContext - before];
    };
    const r = {};
    display(); // builds the script info once after the chat change
    [r.idle, r.idleContexts] = contexts(display);
    await h.eventSource.emit(h.event_types.GENERATION_STARTED, 'normal', {}, true); // a dry run never streams
    [r.dryRun, r.dryRunContexts] = contexts(display);
    await h.eventSource.emit(h.event_types.GENERATION_STARTED, 'normal', {}, false);
    h.st.setState({ streamingProcessor: { messageId: 0, isFinished: false, isStopped: false } });
    r.live = display();
    h.st.streamingProcessor.isFinished = true;
    r.finished = display();
    // An aborted stream can leave a processor that is neither finished nor stopped; once the generation has
    // ended, display scripts must still apply.
    h.st.streamingProcessor.isFinished = false;
    await h.eventSource.emit(h.event_types.GENERATION_STOPPED);
    r.afterStop = display();
    return r;
}

/** Two scripts with the same pattern: each must get its own output (memo) and only display scripts stream-skip. */
export async function sharedPattern(h) {
    const thinking = '/<thinking>[\\s\\S]*?<\\/thinking>/g';
    await useScripts(h, [
        script({ scriptName: 'Hide thinking', findRegex: thinking, replaceString: '', promptOnly: true }),
        script({ scriptName: 'Fold thinking', findRegex: thinking, replaceString: '<details>{{match}}</details>', markdownOnly: true }),
        script({ scriptName: 'Save-time', findRegex: '/foo/g', replaceString: 'bar' }),
        script({ scriptName: 'Display', findRegex: '/foo/g', replaceString: 'baz', markdownOnly: true }),
    ]);
    const mes = 'A <thinking>x</thinking> B';
    const out = [h.engine.getRegexedString(mes, P.AI, { isPrompt: true }), h.engine.getRegexedString(mes, P.AI, { isMarkdown: true })];
    await h.eventSource.emit(h.event_types.GENERATION_STARTED, 'normal', {}, false);
    h.st.setState({ streamingProcessor: { messageId: 0, isFinished: false, isStopped: false } });
    out.push(h.engine.getRegexedString('foo', P.AI)); // what cleanUpMessage() runs on every streamed chunk
    h.st.setState({ streamingProcessor: null });
    await h.eventSource.emit(h.event_types.GENERATION_ENDED, 1);
    return out;
}

/** ⑤ The persisted display output also depends on the message depth and on each script's placement. */
export async function persistDepth(h) {
    applyProfile(h, { persist: true });
    const hp = script({ findRegex: '/\\[HP\\]/g', replaceString: '<meter>', markdownOnly: true, maxDepth: 0 });
    const shout = script({ findRegex: '/!/g', replaceString: '!!', markdownOnly: true, placement: [P.AI] });
    await useScripts(h, [hp, shout]);
    const m = (isUser, mes) => ({ name: isUser ? 'User' : 'Char', is_user: isUser, is_system: false, mes, extra: {} });
    h.st.setState({ chat: [m(false, 'Hi [HP]')] });
    const render = (i) => h.st.messageFormatting(h.st.chat[i].mes, h.st.chat[i].name, false, h.st.chat[i].is_user, i);
    const out = [render(0)]; // depth 0
    h.st.chat.push(m(true, 'Yo!'));
    out.push(render(1), render(0)); // message 0 is now at depth 1
    h.st.chat.push(m(false, 'Next [HP]'));
    out.push(render(2));
    shout.placement = [P.AI, P.USER]; // the regex editor saves, then reloads the chat
    await h.eventSource.emit(h.event_types.CHAT_CHANGED);
    out.push(render(1));
    return out;
}

/** Item 17. Everything the panel, the report, the slash command and the toasts show, after some activity. */
export async function uiTexts(h) {
    applyProfile(h, { persist: true });
    await useScripts(h, [
        script({ scriptName: 'Status card', findRegex: '/<status>([\\s\\S]*?)<\\/status>/g', replaceString: '<b>$1</b>', markdownOnly: true }),
        script({ scriptName: 'Greedy', findRegex: '/x.*y/g', replaceString: 'z' }),
        script({ scriptName: 'Nobody', findRegex: '/nothing-here/g', replaceString: '' }),
        script({ scriptName: 'Digits', findRegex: '/\\d+/g', replaceString: '#' }), // no literal: shows "none"
    ]);
    h.st.setState({ chat: [{ name: 'Char', is_user: false, is_system: false, mes: 'x <status>ok</status> y', extra: {} }] });
    for (let i = 0; i < 3; i++) {
        h.engine.getRegexedString(h.st.chat[0].mes, P.AI);
        h.st.messageFormatting(h.st.chat[0].mes, 'Char', false, false, 0);
    }
    const root = document.getElementById('regex_perf_kit');
    if (!root) return null;
    root.querySelector('#rpk_refresh').click();
    const texts = new Set();
    const walk = (el) => {
        for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) texts.add(node.textContent.trim());
            if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.title) texts.add(node.title);
                walk(node);
            }
        }
    };
    walk(root);
    const litTitles = Object.fromEntries([...root.querySelectorAll('#rpk_table tbody tr')].map(tr => [tr.querySelector('.rpk-col-name').firstChild.textContent.trim(), tr.querySelector('.rpk-lit').title]));
    const reportText = await report(h); // with the table rows, before the stats reset below
    root.querySelector('#rpk_reset').click();
    return {
        texts: [...texts],
        all: root.innerText + '\n' + [...root.querySelectorAll('[title]')].map(e => e.title).join('\n'),
        report: reportText,
        help: h.commands.regexperf.helpString,
        toasts: h.toasts.map(([, msg]) => msg),
        litTitles,
    };
}

/** The panel's headline numbers as shown: the summary's key figures by key, the table rows and the empty-table text. */
function panelNumbers() {
    const root = document.getElementById('regex_perf_kit');
    root.querySelector('#rpk_refresh').click();
    const figures = Object.fromEntries([...root.querySelectorAll('#rpk_summary [data-k]')].map(el => [el.dataset.k, el.textContent]));
    const rows = [...root.querySelectorAll('#rpk_table tbody tr[data-i]')];
    return {
        figures,
        summary: root.querySelector('#rpk_summary').textContent,
        rows: rows.length,
        skipped: rows[0]?.querySelector('.rpk-col-skips')?.textContent,
        empty: root.querySelector('#rpk_table tbody .rpk-empty')?.textContent ?? '',
        panel: root.querySelector('#rpk_summary').textContent + root.querySelector('#rpk_table').textContent,
    };
}

/** Numbers that used to mislead: an estimate of 0.00 ms before anything ran, and rows for patterns that never ran. */
export async function numbers(h) {
    await useScripts(h, [script({ scriptName: 'Tagged', findRegex: '/<tag>/g', replaceString: '' })]);
    h.engine.getRegexedString('', P.USER); // compiles (wraps) the pattern without running it on anything
    const before = panelNumbers();
    for (let i = 0; i < 3; i++) h.engine.getRegexedString(`no tag here ${i}`, P.AI); // prefiltered: skipped, never run
    const skippedOnly = panelNumbers();
    for (let i = 0; i < 2; i++) h.engine.getRegexedString(`<tag> ${i}`, P.AI);
    const after = panelNumbers();
    return { before, skippedOnly, after };
}

/** Item 17. Keys whose translation in this locale is not the expected value (e.g. SillyTavern already translates them). */
export function translations(h, entries) {
    return entries.filter(([key, value]) => h.i18n.translate(key) !== value);
}

const slowRegex = '/[\\s\\S]*?ZZZ/g'; // no match in the chat below: quadratic scan, prefiltered by "ZZZ"

/** Item 9. "Measure on this chat": renders the chat with the features off and on; stats are left as they were. */
export async function measure(h) {
    await useScripts(h, [script({ scriptName: 'Slow', findRegex: slowRegex, replaceString: '', markdownOnly: true }),
        script({ scriptName: 'Bold', findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '<b>$1</b>', markdownOnly: true })]);
    const long = 'word **bold** '.repeat(400);
    h.st.setState({ chat: Array.from({ length: 8 }, (_, i) => ({ name: 'Char', is_user: false, is_system: false, mes: `${i} ${long}`, extra: {} })) });
    h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes, m.name, false, false, i));
    const table = async () => (await report(h)).split('\n\n')[1]; // the per-script rows
    const before = await table();
    const root = document.getElementById('regex_perf_kit');
    const button = root?.querySelector('#rpk_measure');
    if (!button) return null;
    button.click();
    await new Promise(r => setTimeout(r, 50));
    return {
        text: root.querySelector('#rpk_measure_result').textContent,
        statsUnchanged: (await table()) === before,
        chatUnchanged: h.st.chat.every((m, i) => m.mes === `${i} ${long}`),
    };
}

/** Items 10–13. Report columns and warnings: estimate, changed count, replacer time, nested quantifiers, spikes. */
export async function insights(h) {
    await useScripts(h, [
        script({ scriptName: 'Changes', findRegex: '/\\bcat\\b/g', replaceString: 'dog' }),
        script({ scriptName: 'Never changes', findRegex: '/\\d{5}/g', replaceString: 'N' }), // never matches either
        script({ scriptName: 'Same', findRegex: '/\\bsat\\b/g', replaceString: 'sat' }), // matches, leaves the text as it is
        script({ scriptName: 'Rarely runs', findRegex: '/\\d{6}/g', replaceString: 'N', placement: [P.USER] }),
        script({ scriptName: 'Slow regex', findRegex: '/x[\\s\\S]*?\\d{3}/g', replaceString: '' }), // needle "x": each one scans to the end
        script({ scriptName: 'Slow macro', findRegex: '/@/g', replaceString: '{{slow}}' }), // 2 ms per match
        script({ scriptName: 'Nested', findRegex: '/(?:\\w+\\s?)+!/g', replaceString: '!' }), // never runs: no "!"
    ]);
    const long = 'lorem ipsum x '.repeat(500);
    for (let i = 0; i < 25; i++) {
        const mes = `msg ${i}: the cat sat ${long}`;
        h.engine.getRegexedString(mes, P.AI);
        h.engine.getRegexedString(mes, P.AI); // memo hits for the pure scripts
    }
    for (let i = 0; i < 3; i++) h.engine.getRegexedString(`user ${i}`, P.USER);
    for (let i = 0; i < 3; i++) h.engine.getRegexedString('@'.repeat(30) + i, P.AI); // ~60 ms per call
    return { text: await report(h) };
}

/** Item 14. Clicking a table row opens the script in SillyTavern's regex editor; the row's off button disables it. */
export async function rowActions(h) {
    const scripts = [script({ scriptName: 'Alpha', findRegex: '/alpha/g', replaceString: 'A' }), script({ scriptName: 'Beta', findRegex: '/beta/g', replaceString: 'B' })];
    await useScripts(h, scripts);
    // SillyTavern's script list, built from its real scriptTemplate.html with the handlers renderScript() binds
    const template = await (await fetch('/scripts/extensions/regex/scriptTemplate.html')).text();
    const events = [];
    for (const s of scripts) {
        const row = $(template).attr('id', s.id);
        row.find('.edit_existing_regex').on('click', () => events.push(`edit ${s.id}`));
        row.find('.disable_regex').prop('checked', !!s.disabled).on('input', function () {
            s.disabled = !!$(this).prop('checked');
            events.push(`save ${s.id} disabled=${s.disabled}`);
        });
        row.find('.regex-toggle-on').on('click', () => row.find('.disable_regex').prop('checked', true).trigger('input'));
        $('#saved_regex_scripts').append(row);
    }
    'alpha beta'.replace(h.engine.RegexProvider.instance.get('/alpha/g'), 'A');
    'beta'.replace(h.engine.RegexProvider.instance.get('/beta/g'), 'B');
    'gamma'.replace(h.engine.RegexProvider.instance.get('/gamma/g'), 'C'); // not a script: no actions
    const root = document.getElementById('regex_perf_kit');
    root.querySelector('#rpk_refresh').click();
    const rows = () => [...root.querySelectorAll('#rpk_table tbody tr')];
    const rowOf = (name) => rows().find(tr => tr.textContent.includes(name));
    rowOf('Alpha')?.querySelector('td:nth-child(2)')?.click();
    rowOf('Beta')?.querySelector('.rpk-off')?.click();
    await new Promise(r => setTimeout(r, 0));
    return {
        events,
        ids: scripts.map(s => s.id),
        disabled: scripts.map(s => !!s.disabled),
        unknownHasActions: !!rows().find(tr => tr.title.includes('gamma'))?.querySelector('.rpk-off, .rpk-edit'),
    };
}

/** Item 15. Hidden limits are editable in the panel; memo memory and this chat's ⑤ size are shown. */
export async function limits(h) {
    const root = document.getElementById('regex_perf_kit');
    const set = (id, value) => {
        const el = root.querySelector('#' + id);
        if (!el) return false;
        el.value = String(value);
        el.dispatchEvent(new Event('change'));
        return true;
    };
    const rpk = h.extension_settings.regex_perf_kit;
    const found = ['rpk_memoMaxEntries', 'rpk_memoMaxLen', 'rpk_memoMaxMB', 'rpk_persistMaxLen'].map(id => !!root.querySelector('#' + id));
    if (found.includes(false)) return { found };
    await useScripts(h, [script({ findRegex: '/x/g', replaceString: 'y', markdownOnly: true })]);
    for (let i = 0; i < 10; i++) h.engine.getRegexedString(`x ${i}`, P.AI, { isMarkdown: true });
    set('rpk_memoMaxEntries', 4);
    set('rpk_memoMaxLen', '-5');
    set('rpk_memoMaxMB', 'abc');
    set('rpk_persistMaxLen', 123456.7);
    const values = { memoMaxEntries: rpk.memoMaxEntries, memoMaxLen: rpk.memoMaxLen, memoMaxMB: rpk.memoMaxMB, persistMaxLen: rpk.persistMaxLen };
    rpk.persist = true;
    h.st.setState({ chat: [0, 1, 2].map(i => ({ name: 'Char', is_user: false, is_system: false, mes: `x ${i}`, extra: {} })) });
    h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes, m.name, false, false, i));
    root.querySelector('#rpk_refresh').click();
    return { found, values, usage: root.querySelector('#rpk_usage')?.textContent ?? '' };
}

/** Item 16. Compromise mode: while streaming, display scripts format the completed lines at most every N ms. */
export async function streamThrottle(h, { throttle }) {
    applyProfile(h, { streamingThrottle: throttle, streamingThrottleMs: 500 });
    const bold = script({ findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '<b>$1</b>', markdownOnly: true });
    await useScripts(h, [bold]);
    h.st.setState({ chat: [{ name: 'Char', is_user: false, is_system: false, mes: '', extra: {} }] });
    const source = h.engine.RegexProvider.instance.get(bold.findRegex).source;
    const realNow = performance.now.bind(performance);
    let clock = 0;
    performance.now = () => clock;
    const ticks = [[0, 'A **one**\nB **t'], [100, 'A **one**\nB **two**\nC **th'], [600, 'A **one**\nB **two**\nC **three**\nD **f'], [700, 'A **one**\nB **two**\nC **three**\nD **fou']];
    const out = [];
    try {
        await h.eventSource.emit(h.event_types.GENERATION_STARTED, 'normal', {}, false);
        const sp = { messageId: 0, isFinished: false, isStopped: false };
        h.st.setState({ streamingProcessor: sp });
        for (const [at, text] of ticks) {
            clock = at;
            h.st.chat[0].mes = text;
            const runs = executionsBySource(() => out.push(h.st.messageFormatting(text, 'Char', false, false, 0)))[source] ?? 0;
            out.push(runs);
        }
        clock = 800;
        sp.isFinished = true;
        const final = 'A **one**\nB **two**\nC **three**\nD **four**';
        h.st.chat[0].mes = final;
        out.push(h.st.messageFormatting(final, 'Char', false, false, 0));
        h.st.setState({ streamingProcessor: null });
        await h.eventSource.emit(h.event_types.GENERATION_ENDED, 1);
    } finally {
        performance.now = realNow;
    }
    return out;
}

/** The user-facing surface the baseline already had: settings, controls, toggles, /regexperf, clearing ⑤. */
export async function ux(h) {
    const root = document.getElementById('regex_perf_kit');
    const rpk = h.extension_settings.regex_perf_kit;
    const initial = { ...rpk };
    const ids = [...root.querySelectorAll('[id]')].map(e => e.id);
    const checked = Object.fromEntries(['rpk_profiler', 'rpk_prefilter', 'rpk_memo', 'rpk_streaming', 'rpk_persist']
        .map(id => [id, { checked: root.querySelector('#' + id).checked, disabled: root.querySelector('#' + id).disabled }]));
    // toggling memo off clears it: the next run executes again
    await useScripts(h, [script({ findRegex: '/x/g', replaceString: 'y' })]);
    h.engine.getRegexedString('x', P.AI);
    const memoBox = root.querySelector('#rpk_memo');
    const saves = h.st.counters.saveSettings;
    memoBox.checked = false;
    memoBox.dispatchEvent(new Event('change'));
    memoBox.checked = true;
    memoBox.dispatchEvent(new Event('change'));
    const rerun = executionsBySource(() => h.engine.getRegexedString('x', P.AI)).x ?? 0;
    const toggled = { memo: rpk.memo, saved: h.st.counters.saveSettings - saves, rerun };
    // /regexperf: reset returns a message, text returns the report, no argument opens it in a popup
    const cmd = h.commands.regexperf;
    const slash = {
        name: cmd.name,
        args: cmd.unnamedArgumentList.map(a => a.description),
        reset: await cmd.callback({}, 'reset'),
        textStarts: String(await cmd.callback({}, 'text')).split('\n')[0].replace(/\(.*\)/, ''),
        popup: (await cmd.callback({}, ''), h.popups.map(p => /^<pre class="rpk-report">/.test(p.content))),
    };
    // ⑤: entries stored in the chat, then cleared by the button (which saves the chat)
    rpk.persist = true;
    h.st.setState({ chat: [{ name: 'Char', is_user: false, is_system: false, mes: 'x', extra: {} }] });
    h.st.messageFormatting('x', 'Char', false, false, 0);
    const stored = Object.keys(h.st.chat[0].extra.regex_perf_cache ?? {}).sort();
    const chatSaves = h.st.counters.saveChat;
    root.querySelector('#rpk_clear_persist').click();
    await new Promise(r => setTimeout(r, 0));
    const cleared = { left: 'regex_perf_cache' in h.st.chat[0].extra, saved: h.st.counters.saveChat - chatSaves, toast: h.toasts.at(-1)?.[1] };
    return { initial, ids, checked, toggled, slash, stored, cleared, note: root.querySelector('#rpk_persist_note').textContent };
}

/** tests/bench.mjs: cold and warm display renders of a long chat, and the save path on it. */
export async function bench(h) {
    const corpus = await import('./corpus.js');
    h.st.setState({ name1: 'User', name2: 'Dr. A (B)', chat: Array.from({ length: 40 }, () => corpus.CHAT()).flat() });
    await useScripts(h, corpus.SCRIPTS());
    const pass = () => {
        const t0 = performance.now();
        h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes + ' '.repeat(i % 7), m.name, m.is_system, m.is_user, i));
        return performance.now() - t0;
    };
    const save = () => {
        const t0 = performance.now();
        h.st.chat.forEach((m, i) => h.engine.getRegexedString(m.mes + i, P.AI));
        return performance.now() - t0;
    };
    pass(); // JIT warm-up with different inputs below
    h.st.chat.forEach(m => { m.mes += ' .'; });
    return { cold: pass(), warm: pass(), save: save() };
}

/** tests/bench.mjs: many save-path calls on unique inputs, with the given extension settings. */
export async function benchSave(h, settings) {
    const corpus = await import('./corpus.js');
    applyProfile(h, settings);
    h.st.setState({ name1: 'User', name2: 'Dr. A (B)', chat: corpus.CHAT() });
    await useScripts(h, corpus.SCRIPTS());
    const msgs = Array.from({ length: 300 }, (_, i) => corpus.CHAT()[i % 6].mes + ' #' + i);
    msgs.forEach(m => h.engine.getRegexedString(m, P.AI));
    const t0 = performance.now();
    for (let r = 0; r < 5; r++) msgs.forEach(m => h.engine.getRegexedString(m + r, P.AI));
    return performance.now() - t0;
}
