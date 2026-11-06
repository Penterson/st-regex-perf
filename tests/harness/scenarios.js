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

/** A chat message as SillyTavern stores it (a character's, unless props say otherwise). */
const msg = (mes, props = {}) => ({ name: 'Char', is_user: false, is_system: false, mes, extra: {}, ...props });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The extension's panel (null without the extension), refreshed first when asked, so it shows the current stats. */
function panel(refresh = false) {
    const root = document.getElementById('regex_perf_kit');
    if (refresh) root?.querySelector('#rpk_refresh').click();
    return root;
}
/** The table row of the script called name. */
const rowOf = (root, name) => [...root?.querySelectorAll('#rpk_table tbody tr') ?? []].find(tr => tr.querySelector('.rpk-col-name')?.firstChild.textContent.trim() === name);
/** Edits a panel control as a user would (a checkbox by boolean, else the value) and fires change; false if it is missing. */
function setControl(root, id, value) {
    const el = root.querySelector('#' + id);
    if (!el) return false;
    if (typeof value === 'boolean') el.checked = value;
    else el.value = String(value);
    el.dispatchEvent(new Event('change'));
    return true;
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
    await sleep(60);
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
    const { extractNeedle, buildTemplate, analyzeRedos } = await import(`/scripts/extensions/third-party/${h.variant}/index.js`);
    const f = await import('/harness/needle-fuzz.js');
    return { cases: f.runCases(extractNeedle, buildTemplate, analyzeRedos), fuzz: f.fuzz(extractNeedle, { seed, patterns }) };
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
    h.st.setState({ chat: [msg('x <status>ok</status> y')] });
    for (let i = 0; i < 3; i++) {
        h.engine.getRegexedString(h.st.chat[0].mes, P.AI);
        h.st.messageFormatting(h.st.chat[0].mes, 'Char', false, false, 0);
    }
    const root = panel(true);
    if (!root) return null;
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
    const root = panel(true);
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
    const mes = (i) => `${i} ${i === 5 ? long.repeat(6) : long}`; // message 5 is six times longer: the slowest
    h.st.setState({ chat: Array.from({ length: 8 }, (_, i) => msg(mes(i))) });
    h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes, m.name, false, false, i));
    const table = async () => (await report(h)).split('\n\n')[1]; // the per-script rows
    const before = await table();
    const root = panel();
    const button = root?.querySelector('#rpk_measure');
    if (!button) return null;
    button.click();
    await sleep(50);
    return {
        text: root.querySelector('#rpk_measure_result p')?.textContent ?? root.querySelector('#rpk_measure_result').textContent,
        slowest: root.querySelector('#rpk_measure_result p.rpk-dim')?.textContent ?? '',
        report: await report(h),
        statsUnchanged: (await table()) === before,
        chatUnchanged: h.st.chat.every((m, i) => m.mes === mes(i)),
    };
}

/** Per-row stopwatch: re-renders the chat without one script and shows the time it costs in the row; stats untouched. */
export async function rowMeasure(h) {
    applyProfile(h, { prefilter: false }); // the stopwatch keeps the prefilter as set: off, so the slow script really runs
    await useScripts(h, [
        script({ scriptName: 'Slow', findRegex: slowRegex, replaceString: '', markdownOnly: true }),
        script({ scriptName: 'Bold', findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '<b>$1</b>', markdownOnly: true }),
    ]);
    const long = 'word **bold** '.repeat(900); // the quadratic script dominates by far
    h.st.setState({ chat: Array.from({ length: 8 }, (_, i) => msg(`${i} ${long}`)) });
    h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes, m.name, false, false, i));
    const table = async () => (await report(h)).split('\n\n')[1];
    const before = await table();
    const root = panel(true);
    const watch = rowOf(root, 'Slow')?.querySelector('.rpk-measure-row');
    if (!watch) return null;
    watch.click();
    await sleep(80);
    const cell = rowOf(root, 'Slow').querySelector('.rpk-row-ms');
    return {
        text: cell?.textContent ?? '',
        title: cell?.title ?? '',
        boldHas: !!rowOf(root, 'Bold').querySelector('.rpk-row-ms'),
        toasts: h.toasts.map(([, m]) => m),
        statsUnchanged: (await table()) === before,
        chatUnchanged: h.st.chat.every((m, i) => m.mes === `${i} ${long}`),
        editorOpened: h.popups.length, // the stopwatch click must not open the script editor (no editor here: popups stay 0 either way)
    };
}

/** Order conflicts: an earlier script removes what a later one would have matched; unrelated pairs are not flagged. */
export async function orderConflict(h, { long = false } = {}) {
    await useScripts(h, [
        script({ scriptName: 'Strip tag', findRegex: '/<x>/g', replaceString: '' }), // removes "<x>", which Tagged needs
        script({ scriptName: 'Tagged', findRegex: '/<x>y/g', replaceString: 'Z' }),
        script({ scriptName: 'Quiet', findRegex: '/<q>/g', replaceString: '' }), // never matches: changes nothing
        script({ scriptName: 'After quiet', findRegex: '/<r>/g', replaceString: 'R' }),
    ]);
    const pad = long ? 'p'.repeat(5000) : '';
    const out = [];
    for (let i = 0; i < 3; i++) out.push(h.engine.getRegexedString(`a <x>y b ${i} ${pad}`, P.AI)); // the conflict, three times
    out.push(h.engine.getRegexedString('plain <r> text', P.AI)); // Quiet did not change the text: no conflict
    out.push(h.engine.getRegexedString('no y: <x> here', P.AI)); // Tagged would not have matched anyway
    const root = panel(true);
    const badge = (name) => rowOf(root, name)?.querySelector('.rpk-badge[title*="runs first"]');
    return {
        out,
        summary: root?.querySelector('#rpk_summary').textContent ?? '',
        taggedBadge: badge('Tagged')?.title ?? null,
        otherBadges: ['Strip tag', 'Quiet', 'After quiet'].map(n => badge(n)?.title ?? null),
        report: await report(h),
    };
}

/** Items 10–13. Report columns and warnings: estimate, changed count, replacer time, nested quantifiers, spikes. */
export async function insights(h, arg) {
    const longHead = !!arg?.longHead;
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
    for (let i = 0; i < 3; i++) h.engine.getRegexedString('@'.repeat(longHead ? 100 : 30) + i, P.AI); // ~60 ms per call (200 ms with longHead)
    const root = panel(true);
    const badges = Object.fromEntries([...root?.querySelectorAll('#rpk_table tbody tr[data-i]') ?? []].map(tr => [
        tr.querySelector('.rpk-col-name').firstChild.textContent.trim(),
        Object.fromEntries([...tr.querySelectorAll('.rpk-badge')].map(b => [b.textContent, b.title])),
    ]));
    return { text: await report(h), badges };
}

/** Exports and slash verbs: JSON and CSV copies and commands, /regexperf measure, /regexperf off <name>. */
export async function exports(h) {
    const scripts = [
        script({ scriptName: 'Alpha, "quoted"', findRegex: '/alpha/g', replaceString: 'A' }),
        script({ scriptName: 'Beta', findRegex: '/beta/g', replaceString: 'B', markdownOnly: true }),
        script({ scriptName: 'Betamax', findRegex: '/max/g', replaceString: 'M' }),
    ];
    await useScripts(h, scripts);
    const template = await (await fetch('/scripts/extensions/regex/scriptTemplate.html')).text();
    for (const s of scripts) { // SillyTavern's script list, as in rowActions()
        const row = $(template).attr('id', s.id);
        row.find('.disable_regex').prop('checked', !!s.disabled).on('input', function () { s.disabled = !!$(this).prop('checked'); });
        row.find('.regex-toggle-on').on('click', () => row.find('.disable_regex').prop('checked', true).trigger('input'));
        $('#saved_regex_scripts').append(row);
    }
    h.st.setState({ chat: [msg('alpha beta max')] });
    for (let i = 0; i < 3; i++) h.engine.getRegexedString(`alpha beta ${i}`, P.AI);
    const cmd = h.commands.regexperf;
    const run = (arg) => cmd.callback({}, arg);
    const copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { copied.push(text); } }, configurable: true });
    const root = panel();
    for (const id of ['rpk_copy_json', 'rpk_copy_csv']) root.querySelector('#' + id)?.click();
    await sleep(0);
    return {
        text: await run('text'),
        json: await run('json'),
        csv: await run('csv'),
        copied,
        measure: await run('measure'),
        measureShown: root.querySelector('#rpk_measure_result').textContent,
        offMissing: await run('off nope'),
        offAmbiguous: await run('off beta'), // Beta and Betamax contain it...
        offExact: await run('off BETA'), // ...but an exact (case-insensitive) name wins
        offPartial: await run('off max'),
        offNone: await run('off'),
        disabled: h.extension_settings.regex.map(s => !!s.disabled), // saved through the engine: new script objects
        help: cmd.helpString,
    };
}

/** Auto-measure after a chat opens (option, default off) and the one-time "# Messages to Load" hint. */
export async function chatOpen(h) {
    const root = panel();
    const box = root.querySelector('#rpk_autoMeasure');
    const limit = root.querySelector('#rpk_loadHintMs');
    if (!box || !limit) return null;
    const before = { auto: h.extension_settings.regex_perf_kit.autoMeasure, hintMs: h.extension_settings.regex_perf_kit.loadHintMs };
    await useScripts(h, [script({ scriptName: 'Slow macro', findRegex: '/@/g', replaceString: '{{slow}}', markdownOnly: true })]); // 2 ms per match
    h.st.setState({ chat: Array.from({ length: 4 }, (_, i) => msg(`${i} ${'@'.repeat(20)}`)) });
    const open = async () => { // SillyTavern renders every message, then announces the chat
        h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes, m.name, false, false, i));
        await h.eventSource.emit(h.event_types.CHAT_CHANGED);
    };
    await open();
    const quiet = h.toasts.length; // defaults: no hint (3000 ms), no auto-measure
    limit.value = '100';
    limit.dispatchEvent(new Event('change'));
    await open();
    const hints = () => h.toasts.filter(([, m]) => m.startsWith('Rendering this chat took')).length;
    const measures = () => h.toasts.filter(([, m]) => m.startsWith('This chat (')).length;
    const afterHint = { hints: hints(), measures: measures(), text: h.toasts.at(-1)?.[1] };
    await open();
    const second = { hints: hints(), measures: measures() };
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await open();
    await sleep(700);
    const auto = { hints: hints(), measures: measures(), shown: root.querySelector('#rpk_measure_result').textContent, setting: h.extension_settings.regex_perf_kit.autoMeasure };
    return { before, quiet, afterHint, second, auto };
}

/** "Reset settings" restores the defaults; open <details> sections are remembered in settings.ui. */
export async function resetSettings(h) {
    const root = panel();
    const button = root.querySelector('#rpk_reset_settings');
    if (!button) return null;
    const rpk = h.extension_settings.regex_perf_kit;
    const sections = () => Object.fromEntries([...root.querySelectorAll('details[data-section]')].map(d => [d.dataset.section, d.open]));
    const openAtStart = sections();
    setControl(root, 'rpk_prefilter', false);
    setControl(root, 'rpk_memoMaxEntries', 4);
    setControl(root, 'rpk_persistMaxMB', 2);
    const changed = { prefilter: rpk.prefilter, memoMaxEntries: rpk.memoMaxEntries, persistMaxMB: rpk.persistMaxMB };
    const saves = h.st.counters.saveSettings;
    button.click();
    const after = { ...rpk };
    const controls = { prefilter: root.querySelector('#rpk_prefilter').checked, memoMaxEntries: root.querySelector('#rpk_memoMaxEntries').value, persistMaxMB: root.querySelector('#rpk_persistMaxMB').value };
    const limits = root.querySelector('details[data-section="limits"]');
    limits.open = true;
    await sleep(0); // the toggle event is queued
    const uiAfterOpen = JSON.parse(JSON.stringify(rpk.ui ?? null));
    limits.open = false;
    await sleep(0);
    return { openAtStart, changed, after, controls, saved: h.st.counters.saveSettings - saves, uiAfterOpen, uiAfterClose: JSON.parse(JSON.stringify(rpk.ui ?? null)), toast: h.toasts.at(-1)?.[1] };
}

/** Other wrappers of RegexProvider.instance.get: one that was there first (?prewrap=1), or one installed later. */
export async function wrapperWarning(h, arg) {
    const replaceLater = !!arg?.replaceLater;
    const root = panel();
    const inst = h.engine.RegexProvider.instance;
    if (replaceLater) {
        const prev = inst.get.bind(inst);
        inst.get = (regexString) => prev(regexString); // a wrapper that still calls ours...
        panel(true);
    }
    await useScripts(h, [script({ findRegex: '/x/g', replaceString: 'y' })]);
    const out = h.engine.getRegexedString('x', P.AI);
    panel(true);
    const summary = root?.querySelector('#rpk_summary').textContent ?? '';
    const warns = h.warnings.filter(w => w.includes('get()'));
    panel(true);
    return { out, summary, warns, warnsAfterSecondRender: h.warnings.filter(w => w.includes('get()')).length };
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
    const root = panel(true);
    rowOf(root, 'Alpha')?.querySelector('td:nth-child(2)')?.click();
    rowOf(root, 'Beta')?.querySelector('.rpk-off')?.click();
    await sleep(0);
    return {
        events,
        ids: scripts.map(s => s.id),
        disabled: h.extension_settings.regex.map(s => !!s.disabled), // saved through the engine: new script objects
        unknownHasActions: !!root.querySelector('#rpk_table tbody tr[title*="gamma"] .rpk-off, #rpk_table tbody tr[title*="gamma"] .rpk-edit'),
    };
}

/** Sortable table and name filter: per session, not saved. */
export async function sortFilter(h) {
    await useScripts(h, [
        script({ scriptName: 'Beta', findRegex: '/b/g', replaceString: 'B' }),
        script({ scriptName: 'Alpha', findRegex: '/a/g', replaceString: 'A' }),
        script({ scriptName: 'Gamma', findRegex: '/g/g', replaceString: 'G' }),
    ]);
    for (let i = 0; i < 3; i++) h.engine.getRegexedString(`ab ${i}`, P.AI); // Beta and Alpha run 3 times, Gamma 0 (skipped)
    h.engine.getRegexedString('aaaa 9', P.AI); // Alpha runs once more: 4
    const root = panel(true);
    const names = () => [...root.querySelectorAll('#rpk_table tbody tr[data-i]')].map(tr => tr.querySelector('.rpk-col-name').firstChild.textContent.trim());
    const ranks = () => [...root.querySelectorAll('#rpk_table tbody tr[data-i]')].map(tr => tr.querySelector('.rpk-col-rank').textContent);
    const header = (col) => root.querySelector(`#rpk_table thead th[data-col="${col}"]`);
    const out = { initial: names(), initialRanks: ranks() };
    header('runs').click();
    out.byRuns = names();
    out.runsHeader = header('runs').textContent;
    header('runs').click();
    out.byRunsAsc = names();
    out.runsHeaderAsc = header('runs').textContent;
    out.ranksAsc = ranks();
    header('name').click();
    out.byName = names();
    header('act').click(); // not sortable: nothing changes
    out.afterAct = names();
    const filter = root.querySelector('#rpk_filter');
    filter.value = 'A';
    filter.dispatchEvent(new Event('input'));
    out.filtered = names();
    filter.value = 'zzz';
    filter.dispatchEvent(new Event('input'));
    out.noneLeft = root.querySelector('#rpk_table tbody .rpk-empty')?.textContent ?? '';
    out.saved = Object.keys(h.extension_settings.regex_perf_kit).filter(k => /sort|nameFilter/i.test(k));
    out.settingsSaves = h.st.counters.saveSettings;
    return out;
}

/** Item 15. Hidden limits are editable in the panel; memo memory and this chat's ⑤ size are shown. */
export async function limits(h) {
    const root = panel();
    const rpk = h.extension_settings.regex_perf_kit;
    const found = ['rpk_memoMaxEntries', 'rpk_memoMaxLen', 'rpk_memoMaxMB', 'rpk_persistMaxLen'].map(id => !!root.querySelector('#' + id));
    if (found.includes(false)) return { found };
    await useScripts(h, [script({ findRegex: '/x/g', replaceString: 'y', markdownOnly: true })]);
    for (let i = 0; i < 10; i++) h.engine.getRegexedString(`x ${i}`, P.AI, { isMarkdown: true });
    setControl(root, 'rpk_memoMaxEntries', 4);
    setControl(root, 'rpk_memoMaxLen', '-5');
    setControl(root, 'rpk_memoMaxMB', 'abc');
    setControl(root, 'rpk_persistMaxLen', 123456.7);
    const values = { memoMaxEntries: rpk.memoMaxEntries, memoMaxLen: rpk.memoMaxLen, memoMaxMB: rpk.memoMaxMB, persistMaxLen: rpk.persistMaxLen };
    rpk.persist = true;
    h.st.setState({ chat: [0, 1, 2].map(i => msg(`x ${i}`)) });
    h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes, m.name, false, false, i));
    panel(true);
    return { found, values, usage: root.querySelector('#rpk_usage')?.textContent ?? '' };
}

/** ③ hashed keys: with the Limits toggle on, entries hold no input (half the memory) and still serve exact results. */
export async function memoHash(h) {
    const root = panel();
    const box = root.querySelector('#rpk_memoHashKeys');
    if (!box) return null;
    await useScripts(h, [script({ findRegex: '/x/g', replaceString: 'y' })]);
    const long = 'x'.repeat(10000);
    const inputs = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')} ${long}`); // same length, different text
    const usage = () => Number(/cache: \d+ entries, ([\d.]+) of/.exec(panel(true).querySelector('#rpk_usage').textContent)[1]);
    const run = (str) => executionsBySource(() => h.engine.getRegexedString(str, P.AI)).x ?? 0;
    const plain = { out: inputs.map(str => h.engine.getRegexedString(str, P.AI)) };
    plain.rerun = inputs.map(run);
    plain.mb = usage();
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    const hashed = { cleared: run(inputs[0]), out: inputs.map(str => h.engine.getRegexedString(str, P.AI)) };
    hashed.rerun = inputs.map(run);
    hashed.mb = usage();
    hashed.setting = h.extension_settings.regex_perf_kit.memoHashKeys;
    return { plain, hashed };
}

/** ⑤ key: two same-length messages with the same fnv1a hash must not share a stored result; old keys are recomputed. */
export async function persistKey(h) {
    applyProfile(h, { persist: true });
    await useScripts(h, [script({ findRegex: '/o/g', replaceString: '0', markdownOnly: true })]);
    const [a, b] = ['zhjotclp', 'tiofsnfk']; // fnv1a("zhjotclp") === fnv1a("tiofsnfk") === 2945646617
    h.st.setState({ chat: [msg(a)] });
    const render = () => h.st.messageFormatting(h.st.chat[0].mes, 'Char', false, false, 0);
    const out = [render()];
    h.st.chat[0].mes = b; // edited to a colliding message of the same length
    out.push(render());
    const entry = h.st.chat[0].extra.regex_perf_cache;
    // an entry in an older key format is ignored and replaced
    if (entry) h.st.chat[0].extra.regex_perf_cache = { k: entry.k.replace(/^[^:]+/, 'old'), v: 'STALE' };
    out.push(render());
    return { out, key: h.st.chat[0].extra.regex_perf_cache?.k ?? null };
}

/** ⑤ budget: beyond persistMaxMB per chat, the oldest messages' stored results are dropped first. */
export async function persistBudget(h) {
    applyProfile(h, { persist: true, persistMaxMB: 1, persistMaxLen: 100000 });
    await useScripts(h, [script({ findRegex: '/x/g', replaceString: 'y', markdownOnly: true })]);
    const body = 'x'.repeat(50000); // each stored result is ≈50 KB: 1 MB holds 20 of them
    h.st.setState({ chat: Array.from({ length: 26 }, (_, i) => msg(`${i} ${body}`)) });
    h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes, m.name, false, false, i));
    const stored = h.st.chat.map(m => !!m.extra.regex_perf_cache);
    const chars = h.st.chat.reduce((a, m) => a + (m.extra.regex_perf_cache ? m.extra.regex_perf_cache.k.length + (m.extra.regex_perf_cache.v?.length ?? 0) : 0), 0);
    const root = panel(true);
    const usage = root.querySelector('#rpk_usage')?.textContent ?? ''; // the baseline has no usage line
    const hasLimit = setControl(root, 'rpk_persistMaxMB', 2);
    return { stored, chars, usage, hasLimit, limit: h.extension_settings.regex_perf_kit.persistMaxMB };
}

/** Item 16. Compromise mode: while streaming, display scripts format the completed lines at most every N ms. */
export async function streamThrottle(h, { throttle }) {
    applyProfile(h, { streamingThrottle: throttle, streamingThrottleMs: 500 });
    const bold = script({ findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '<b>$1</b>', markdownOnly: true });
    await useScripts(h, [bold]);
    h.st.setState({ chat: [msg('')] });
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
    const root = panel();
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
    h.st.setState({ chat: [msg('x')] });
    h.st.messageFormatting('x', 'Char', false, false, 0);
    const stored = Object.keys(h.st.chat[0].extra.regex_perf_cache ?? {}).sort();
    const chatSaves = h.st.counters.saveChat;
    root.querySelector('#rpk_clear_persist').click();
    await sleep(0);
    const cleared = { left: 'regex_perf_cache' in h.st.chat[0].extra, saved: h.st.counters.saveChat - chatSaves, toast: h.toasts.at(-1)?.[1] };
    return { initial, ids, checked, toggled, slash, stored, cleared, note: root.querySelector('#rpk_persist_note').textContent };
}

/**
 * Feature list 3, row 3. A ⑤ hit sets bypass; if something throws between the two hooks (here: another extension's
 * wrapper of get()), the prompt-side regex that runs next must not be skipped.
 */
export async function bypassStuck(h) {
    applyProfile(h, { persist: true });
    await useScripts(h, [
        script({ findRegex: '/x/g', replaceString: 'y', markdownOnly: true }),
        script({ findRegex: '/p/g', replaceString: 'q', promptOnly: true }),
    ]);
    h.st.setState({ chat: [msg('x')] });
    const render = () => h.st.messageFormatting(h.st.chat[0].mes, h.st.chat[0].name, false, false, 0);
    const out = [render(), render()]; // the second render is served from ⑤
    const inst = h.engine.RegexProvider.instance;
    const prev = inst.get.bind(inst);
    let armed = true;
    inst.get = (s) => {
        if (armed) {
            armed = false;
            throw new Error('boom');
        }
        return prev(s);
    };
    let threw = false;
    try {
        render();
    } catch {
        threw = true;
    }
    await Promise.resolve(); // the next task: a generation builds its prompt
    out.push(threw, h.engine.getRegexedString('p', P.AI, { isPrompt: true }), render());
    return out;
}

/** Feature list 3, row 4. Editing a prompt-only script must not invalidate the ⑤ results of display scripts. */
export async function persistDisplayVersion(h) {
    applyProfile(h, { persist: true });
    const display = script({ scriptName: 'D', findRegex: '/a/g', replaceString: 'b', markdownOnly: true });
    const prompt = script({ scriptName: 'P', findRegex: '/p/g', replaceString: 'q', promptOnly: true });
    await useScripts(h, [display, prompt]);
    h.st.setState({ chat: [msg('a p')] });
    const render = () => h.st.messageFormatting(h.st.chat[0].mes, h.st.chat[0].name, false, false, 0);
    const bypasses = async () => (h.commands.regexperf ? JSON.parse(await h.commands.regexperf.callback({}, 'json')).totals.bypass : 0);
    const out = [];
    const step = async () => { out.push(render(), await bypasses()); };
    await step();
    await step();
    await useScripts(h, [display, { ...prompt, replaceString: 'r' }]); // the editor saves a new object for the same id, then reloads the chat
    await step();
    await useScripts(h, [{ ...display, replaceString: 'c' }, { ...prompt, replaceString: 'r' }]);
    await step();
    return out;
}

/** Feature list 3, row 2. A find pattern with a dynamic macro compiles to a new string on every run. */
export async function dynamicFind(h) {
    h.st.setState({ name1: 'Ann', name2: 'Cat', chat: [msg('[a] [b] Ann!')] });
    await useScripts(h, [
        script({ scriptName: 'Dyn', findRegex: '/\\[{{random::a::b}}\\]/g', replaceString: 'X', substituteRegex: 1, markdownOnly: true }),
        script({ scriptName: 'Var', findRegex: '/{{user}}!/g', replaceString: 'U', substituteRegex: 1, markdownOnly: true }),
    ]);
    const render = () => h.st.messageFormatting(h.st.chat[0].mes, h.st.chat[0].name, false, false, 0);
    const outs = [];
    for (let i = 0; i < 6; i++) outs.push(render());
    await h.eventSource.emit(h.event_types.GENERATION_STARTED, 'normal', {}, false);
    h.st.setState({ streamingProcessor: { messageId: 0, isFinished: false, isStopped: false } });
    const live = render();
    h.st.setState({ streamingProcessor: null });
    await h.eventSource.emit(h.event_types.GENERATION_ENDED, 1);
    const json = h.commands.regexperf ? JSON.parse(await h.commands.regexperf.callback({}, 'json')) : null;
    return { outs, live, report: await report(h), rows: json?.rows.map(r => ({ name: r.name, runs: r.runs, hits: r.hits, streamSkips: r.streamSkips })) ?? [] };
}

/** A small seeded generator (mulberry32) for the differential fuzz below. */
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Feature list 1.1. The fast path must give SillyTavern's own output for every replacement template: random patterns
 * (numbered, named, optional and empty groups), replacements built from every token the template translation handles,
 * trim strings, and inputs with and without macro syntax. Compares the extension with the fast path off and on (③ off,
 * so nothing is served from the memo), on SillyTavern's real engine.
 */
export async function fastPathEquivalence(h, { seed, scripts = 80 }) {
    const rpk = applyProfile(h, { memo: false, prefilter: false });
    const rand = rng(seed);
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    const PATTERNS = [
        '/(\\w+) (\\w+)/g', '/(?<a>x)(y)?/g', '/\\[(.*?)\\]/g', '/(a)|(b)/g', '/x/g', '/x/', '/(\\d)(\\d)(\\d)(\\d)(\\d)(\\d)(\\d)(\\d)(\\d)(\\d)(\\d)/g',
        '/(?<n>\\d+)-(?<m>\\d+)/g', '/()/g', '/(a*)/g', '/^/gm', '/(A)/gi', '/(.)(.)/gs', '/(😀)/gu', '/(?<q>")(.*?)(?<r>")/g', '/b(?=x)/g', '/(x)(?!y)/g',
    ];
    const TOKENS = ['$0', '$1', '$2', '$3', '$10', '$11', '$12', '$<n>', '$<a>', '$<zz>', '{{match}}', '{{MATCH}}', '$$', '$', '$&', '$`', '$\'', 'a', 'b', '-', '$01', '$1x', '$<', '>', '{', '}', '$00', '$007', ' ', '\n', '"'];
    const TRIMS = [[], [], ['"'], ['a'], [''], ['x', '-'], ['\n']];
    const ALPHA = 'abx yz[]"-\n123AB{}$<>😀';
    const input = () => Array.from({ length: Math.floor(rand() * 30) }, () => ALPHA[Math.floor(rand() * ALPHA.length)]).join('');
    let compared = 0;
    let mismatch = null;
    for (let k = 0; k < scripts && !mismatch; k++) {
        const findRegex = pick(PATTERNS);
        const replaceString = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(TOKENS)).join('');
        const trimStrings = pick(TRIMS);
        await useScripts(h, [script({ scriptName: 'fuzz', findRegex, replaceString, trimStrings })]);
        // A $n beyond the group count makes SillyTavern's own callback throw on a trim string (filterString gets the
        // match offset, a number): the extension must then throw the same way.
        const run = (str) => {
            try {
                return h.engine.getRegexedString(str, P.AI);
            } catch (e) {
                return 'THROW ' + e.message;
            }
        };
        for (let j = 0; j < 8; j++) {
            const str = j === 7 ? input() + '{{user}}' : input();
            if (rpk) rpk.fastPath = false;
            const off = run(str);
            if (rpk) rpk.fastPath = true;
            const on = run(str);
            compared++;
            if (on !== off) mismatch = { findRegex, replaceString, trimStrings, str, off, on };
        }
    }
    const json = rpk ? JSON.parse(await h.commands.regexperf.callback({}, 'json')) : null;
    return { compared, mismatch, fastRuns: json?.totals.fastRuns ?? 0, fallbacks: h.warnings.filter(w => w.includes('fast path')) };
}

/** Feature list 1.1. A display script on a long message: with the fast path the replacer time disappears. */
export async function fastPathStats(h) {
    const rpk = applyProfile(h, { memo: false });
    await useScripts(h, [script({ scriptName: 'Waves', findRegex: '/(\\w+) waves/g', replaceString: '<b>$1</b>', markdownOnly: true })]);
    const mes = Array.from({ length: 200 }, (_, i) => `Bob${i} waves at Ann`).join('\n');
    const row = async () => JSON.parse(await h.commands.regexperf.callback({}, 'json')).rows.find(r => r.name === 'Waves');
    const pickRow = (r) => ({ replacerMs: r.replacerMs, fastRuns: r.fastRuns, matched: r.matched, changed: r.changed });
    rpk.fastPath = false;
    const offOut = h.engine.getRegexedString(mes, P.AI, { isMarkdown: true });
    const off = pickRow(await row());
    rpk.fastPath = true;
    for (let i = 0; i < 3; i++) h.engine.getRegexedString(mes, P.AI, { isMarkdown: true }); // the self-verifying first runs
    await h.commands.regexperf.callback({}, 'reset');
    const onOut = h.engine.getRegexedString(mes, P.AI, { isMarkdown: true });
    const on = pickRow(await row());
    return { same: offOut === onOut, off, on };
}

/**
 * Feature list 1.1. A replacer that is not SillyTavern's (another caller of String.replace with our RegExp) must be
 * caught by the self-verification: the fast path is turned off for that script with a warning, and the caller gets its
 * own callback's result.
 */
export async function fastPathFallback(h) {
    applyProfile(h, { memo: false });
    await useScripts(h, [script({ findRegex: '/a/g', replaceString: 'b' })]);
    const re = h.engine.RegexProvider.instance.get('/a/g');
    const out = 'aa'.replace(re, () => 'Z');
    const warned = h.warnings.some(w => w.includes('fast path'));
    return [out, warned, h.engine.getRegexedString('a', P.AI)];
}

/** Feature list 1.1. Group text that assembles a macro with the replacement ({ + {user}}) must still be substituted. */
export async function fastPathAssembled(h) {
    h.st.setState({ name1: 'Ann', name2: 'Cat' });
    await useScripts(h, [script({ findRegex: '/(\\{)x(\\{user\\}\\})/g', replaceString: '$1$2' })]);
    return [h.engine.getRegexedString('{x{user}}', P.AI), h.engine.getRegexedString('{x{user}} and {x{user}}', P.AI)];
}

/**
 * Feature list 1.2. A display script whose replacement is {{char}} is memoized per value set: hits while name2 stays
 * (whoever the message author is: replacements resolve {{char}} to name2), a miss after a rename; a {{random}} script
 * is never memoized.
 */
export async function memoStatic(h) {
    h.st.setState({ name1: 'Ann', name2: 'Cat', chat: [msg('me', { name: 'Cat' }), msg('me', { name: 'Kit' }), msg('roll [d]', { name: 'Cat' })] });
    await useScripts(h, [
        script({ scriptName: 'Who', findRegex: '/\\bme\\b/g', replaceString: '{{char}}', markdownOnly: true }),
        script({ scriptName: 'Dice', findRegex: '/\\[d\\]/g', replaceString: '{{random::1::2::3::4::5::6}}', markdownOnly: true }),
    ]);
    const render = (i) => h.st.messageFormatting(h.st.chat[i].mes, h.st.chat[i].name, false, false, i);
    const outs = [render(0), render(0), render(1), render(1)];
    h.st.setState({ name2: 'Dog' });
    outs.push(render(0), render(2), render(2));
    const json = h.commands.regexperf ? JSON.parse(await h.commands.regexperf.callback({}, 'json')) : null;
    return { outs, hits: Object.fromEntries(json?.rows.map(r => [r.name, r.hits]) ?? []) };
}

/** Feature list 1.2. An input with macro syntax outside the matches is memoized; one with it inside a match is not. */
export async function memoPostHoc(h) {
    await useScripts(h, [script({ scriptName: 'Bold', findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '<b>$1</b>' })]);
    h.st.setState({ name1: 'Ann', name2: 'Cat' });
    const hitsOf = async () => (h.commands.regexperf ? JSON.parse(await h.commands.regexperf.callback({}, 'json')).rows.find(r => r.name === 'Bold')?.hits ?? 0 : 0);
    const outside = 'use {{user}} like this: **x**';
    const outs = [h.engine.getRegexedString(outside, P.AI), h.engine.getRegexedString(outside, P.AI)];
    const afterOutside = await hitsOf();
    const inside = 'say **{{user}}** now';
    outs.push(h.engine.getRegexedString(inside, P.AI));
    h.st.setState({ name1: 'Bob' });
    outs.push(h.engine.getRegexedString(inside, P.AI));
    return { outs, afterOutside, afterInside: await hitsOf() };
}

/** Feature list 1.2. A run that leaves the text as it is stores a marker, not a copy of the output. */
export async function memoSame(h) {
    applyProfile(h, { prefilter: false });
    await useScripts(h, [script({ scriptName: 'Nine', findRegex: '/\\d{9}/g', replaceString: '#' })]);
    const str = 'letters only '.repeat(77); // 1001 characters, no digits
    const out = [h.engine.getRegexedString(str, P.AI), h.engine.getRegexedString(str, P.AI)];
    const json = h.commands.regexperf ? JSON.parse(await h.commands.regexperf.callback({}, 'json')) : null;
    return { same: out[0] === str && out[1] === str, bytes: json?.memo.bytes ?? 0, hits: json?.rows[0]?.hits ?? 0, len: str.length };
}

/** Feature list 3 row 5 / 1.3. Script info is rebuilt on events or when the script lists' fingerprint changes, not on a timer. */
export async function rebuilds(h) {
    await useScripts(h, [
        script({ scriptName: 'A', findRegex: '/a/g', replaceString: 'A' }),
        script({ scriptName: 'B', findRegex: '/b/g', replaceString: 'B' }),
    ]);
    const json = async () => JSON.parse(await h.commands.regexperf.callback({}, 'json')).scripts;
    const outs = [h.engine.getRegexedString('ab', P.AI)];
    const s0 = await json();
    for (let i = 0; i < 30; i++) h.engine.getRegexedString('ab' + i, P.AI);
    await sleep(40); // a few frames
    for (let i = 0; i < 30; i++) h.engine.getRegexedString('ab' + i, P.AI);
    const s1 = await json();
    h.extension_settings.regex[1].disabled = true; // the list's switch, without any event
    await sleep(40);
    outs.push(h.engine.getRegexedString('ab', P.AI));
    const s2 = await json();
    return { outs, builds: [s0.infoBuilds, s1.infoBuilds, s2.infoBuilds], active: [s0.active, s1.active, s2.active] };
}

/** Feature list 1.4. "Measure on this chat" yields to the page between chunks of messages. */
export async function measureAsync(h) {
    const corpus = await import('./corpus.js');
    await useScripts(h, corpus.SCRIPTS());
    h.st.setState({ name1: 'User', name2: 'Dr. A (B)', chat: Array.from({ length: 20 }, () => corpus.CHAT()).flat() });
    const root = panel();
    const button = root?.querySelector('#rpk_measure');
    if (!button) return null;
    // Without scheduler.yield() the measurement falls back to a timeout, so a timer of our own gets a turn at every
    // chunk (with scheduler.yield(), Chrome runs the continuation before other timers: that path yields to rendering).
    Object.defineProperty(globalThis, 'scheduler', { value: undefined, configurable: true });
    let ticks = 0;
    let running = true;
    const tick = () => {
        if (!running) return;
        ticks++;
        setTimeout(tick, 0);
    };
    try {
        button.click();
        await sleep(25); // the "Measuring..." toast's delay: the measurement starts after it
        setTimeout(tick, 0);
        const until = Date.now() + 5000;
        while (Date.now() < until && !root.querySelector('#rpk_measure_result p')) await sleep(0);
    } finally {
        running = false;
        delete globalThis.scheduler;
    }
    return { ticks, text: root.querySelector('#rpk_measure_result p')?.textContent ?? '', messages: h.st.chat.length };
}

/** Feature list 1.3. ⑤ usage is kept incrementally and matches a full scan of the chat. */
export async function persistAccounting(h) {
    applyProfile(h, { persist: true, persistMaxMB: 1 });
    await useScripts(h, [script({ findRegex: '/x/g', replaceString: 'y', markdownOnly: true })]);
    h.st.setState({ chat: Array.from({ length: 30 }, (_, i) => msg(`${i} x ` + 'x'.repeat(50000))) }); // ~100 KB each
    const render = (i) => h.st.messageFormatting(h.st.chat[i].mes, h.st.chat[i].name, false, false, i);
    const scan = () => {
        let entries = 0;
        let chars = 0;
        for (const m of h.st.chat) {
            const e = m.extra?.regex_perf_cache;
            if (!e) continue;
            entries++;
            chars += String(e.k).length + (e.v?.length ?? 0);
        }
        return { entries, chars };
    };
    const shown = async () => JSON.parse(await h.commands.regexperf.callback({}, 'json')).memo.persist;
    for (let i = 0; i < 30; i++) render(i);
    const a = [await shown(), scan()];
    render(3); // its entry was dropped as one of the oldest: stored again, the oldest remaining one dropped
    render(29); // a hit: nothing changes
    const b = [await shown(), scan()];
    return { a, b, max: 1048576 };
}

/** Feature list 1.3. Sampled profiling after 1000 runs, and the replacer timing toggle. */
export async function sampling(h) {
    const rpk = applyProfile(h, { profilerSampling: true, memo: false, prefilter: false });
    await useScripts(h, [script({ scriptName: 'S', findRegex: '/a/g', replaceString: 'b' })]);
    for (let i = 0; i < 1100; i++) h.engine.getRegexedString('a' + i, P.AI);
    const row = async () => JSON.parse(await h.commands.regexperf.callback({}, 'json')).rows.find(r => r.name === 'S');
    const s = await row();
    rpk.timeReplacer = false;
    rpk.fastPath = false; // SillyTavern's callback runs, untimed
    await h.commands.regexperf.callback({}, 'reset');
    for (let i = 0; i < 5; i++) h.engine.getRegexedString('a' + i, P.AI);
    const u = await row();
    return { sampled: { runs: s.runs, changed: s.changed, matched: s.matched, sampled: s.sampled }, untimed: { runs: u.runs, replacerMs: u.replacerMs, matched: u.matched, sampled: u.sampled } };
}

/** Feature list 1.3. The panel refreshes on its own soon after activity, without the refresh button. */
export async function autoRefresh(h) {
    await useScripts(h, [script({ scriptName: 'R', findRegex: '/r/g', replaceString: 'R' })]);
    const root = panel();
    if (!root) return null;
    const runs = () => root.querySelector('#rpk_summary [data-k="runs"]')?.textContent ?? '';
    const before = runs();
    for (let i = 0; i < 7; i++) h.engine.getRegexedString('r' + i, P.AI);
    const immediately = runs();
    await sleep(1300);
    return { before, immediately, later: runs() };
}

/**
 * Feature list 1.5. With the fuse and the breaker off (the defaults) a risky script runs as it always did; the fuse
 * skips inputs over fuseLen for risky scripts; the breaker turns a script off for the session after breakerCount runs
 * over breakerMs, with an Undo in the toast. ② and ③ are off, so the slow runs really happen.
 */
export async function breakerFuse(h, { mode }) {
    const rpk = applyProfile(h, { prefilter: false, memo: false, ...(mode === 'fuse' ? { fuse: true, fuseLen: 1000 } : mode === 'breaker' ? { breaker: true, breakerMs: 5, breakerCount: 2 } : {}) }); // 5 ms: a fast CI runner finished the slow input under 20
    await useScripts(h, [
        script({ scriptName: 'Risky', findRegex: '/(x+x+)+y/g', replaceString: 'Y' }), // exponential on a run of x without a y
        script({ scriptName: 'Plain', findRegex: '/q/g', replaceString: 'Q' }),
    ]);
    const slow = 'x'.repeat(22); // tens of milliseconds in V8
    const long = 'xxy' + 'a'.repeat(1500); // over fuseLen, matches at once
    const row = async (name) => {
        const r = JSON.parse(await h.commands.regexperf.callback({}, 'json')).rows.find(x => x.name === name);
        return r ? { fused: r.fused, broken: r.broken, tripped: r.tripped, redos: r.redos?.severity ?? null } : null;
    };
    const outs = [
        h.engine.getRegexedString(long + ' q', P.AI), // a long input: fused, or replaced
        h.engine.getRegexedString(slow + ' q', P.AI), // slow run 1
        h.engine.getRegexedString(slow + ' q', P.AI), // slow run 2: trips the breaker (count 2)
        h.engine.getRegexedString('xxy q', P.AI), // after the trip: skipped by the breaker, else replaced
    ];
    const after = rpk ? await row('Risky') : null;
    const toast = h.toasts.at(-1);
    let undone = null;
    let toastText = '';
    if (toast && /rpk-undo/.test(toast[1])) { // the toast's HTML as toastr would show it: read it, click its Undo
        document.body.insertAdjacentHTML('beforeend', `<div id="rpk_toast_test">${toast[1]}</div>`);
        const div = document.getElementById('rpk_toast_test');
        toastText = div.textContent;
        div.querySelector('.rpk-undo').click();
        div.remove();
        undone = h.engine.getRegexedString('xxy q', P.AI);
    }
    return { outs, after, toast: toast?.[1] ?? '', toastText, undone, plain: rpk ? await row('Plain') : null };
}

/** Feature list 1.5. The report lists every backtracking risk with its reason and a suggestion; the badges carry them. */
export async function redosReport(h) {
    await useScripts(h, [
        script({ scriptName: 'Nested', findRegex: '/(?:\\w+\\s?)+!/g', replaceString: '!' }),
        script({ scriptName: 'Adjacent', findRegex: '/\\s*\\s*x/g', replaceString: 'X' }),
        script({ scriptName: 'Fine', findRegex: '/<status>([\\s\\S]*?)<\\/status>/g', replaceString: '$1' }),
        script({ scriptName: 'Dot', findRegex: '/(.|\\n)*z/g', replaceString: 'Z' }),
    ]);
    for (const s of ['hello world!', ' x', '<status>a</status>', 'z']) h.engine.getRegexedString(s, P.AI);
    const root = panel(true);
    const badges = Object.fromEntries([...root?.querySelectorAll('#rpk_table tbody tr[data-i]') ?? []].map(tr => [
        tr.querySelector('.rpk-col-name').firstChild.textContent.trim(),
        Object.fromEntries([...tr.querySelectorAll('.rpk-badge')].map(b => [b.textContent, b.title])),
    ]));
    const json = JSON.parse(await h.commands.regexperf.callback({}, 'json'));
    return { report: await report(h), badges, redos: Object.fromEntries(json.rows.map(r => [r.name, r.redos])), counts: json.scripts };
}

/** Feature list 2.2. Invalid patterns are listed with the engine's error: summary, report and JSON. */
export async function invalidList(h) {
    await useScripts(h, [
        script({ scriptName: 'Broken', findRegex: '/(abc/g', replaceString: '' }),
        script({ scriptName: 'Fine', findRegex: '/ok/g', replaceString: 'OK' }),
    ]);
    const out = h.engine.getRegexedString('ok (abc', P.AI);
    const root = panel(true);
    const json = JSON.parse(await h.commands.regexperf.callback({}, 'json'));
    return { out, summary: root?.querySelector('#rpk_summary').textContent ?? '', report: await report(h), invalid: json.invalidPatterns, counts: json.scripts };
}

/** Feature list 2.2. Spikes keep a history with the message id; the ⚡ badge scrolls to the message; a repro can be copied. */
export async function spikes(h) {
    await useScripts(h, [script({ scriptName: 'Slow macro', findRegex: '/@/g', replaceString: '{{slow}}', markdownOnly: true })]);
    h.st.setState({ chat: [0, 1, 2].map(i => msg('@'.repeat(30) + i)) });
    const mesDiv = document.createElement('div');
    mesDiv.innerHTML = [0, 1, 2].map(i => `<div class="mes" mesid="${i}"></div>`).join('');
    document.body.append(mesDiv);
    const scrolled = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () { scrolled.push(this.getAttribute('mesid')); };
    let copied = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text) => { copied = text; } }, configurable: true });
    try {
        for (let i = 0; i < 3; i++) h.st.messageFormatting(h.st.chat[i].mes, 'Char', false, false, i);
        const root = panel(true);
        const row = rowOf(root, 'Slow macro');
        const badge = [...row.querySelectorAll('.rpk-badge')].find(b => b.textContent === '⚡');
        badge.click();
        row.querySelector('.rpk-repro').click();
        await sleep(10);
        const json = JSON.parse(await h.commands.regexperf.callback({}, 'json'));
        return { spikes: json.rows[0].spikes.map(s => ({ len: s.len, messageId: s.messageId, head: s.head })), title: badge.title, scrolled, copied, report: await report(h), toasts: h.toasts.map(([, m]) => m) };
    } finally {
        Element.prototype.scrollIntoView = orig;
        delete navigator.clipboard;
        mesDiv.remove();
    }
}

/** Feature list 2.3. Lint rows, a one-click fix through saveScriptsByType, and on/off without the Regex drawer's DOM. */
export async function lintRules(h) {
    const noG = script({ scriptName: 'NoG', findRegex: '/foo/', replaceString: 'bar' });
    await useScripts(h, [
        noG,
        script({ scriptName: 'Ref', findRegex: '/(\\d+)-/g', replaceString: '$2' }),
        script({ scriptName: 'Esc', findRegex: '/\\\\n/g', replaceString: ' ' }), // the pattern text is \\n: a JSON double escape
        script({ scriptName: 'Look', findRegex: '/(?<=x)y/g', replaceString: 'Y' }),
        script({ scriptName: 'Dup1', findRegex: '/dup/g', replaceString: '1' }),
        script({ scriptName: 'Dup2', findRegex: '/dup/g', replaceString: '2' }),
    ]);
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(h.engine.getRegexedString(`foo foo foo ${i}`, P.AI)); // distinct inputs: ③ must not serve them
    outs.push(h.engine.getRegexedString('xy dup', P.AI));
    const root = panel(true);
    const rows = [...root.querySelectorAll('#rpk_lint_list li[data-rule]')].map(li => ({ rule: li.dataset.rule, script: li.dataset.script, fix: li.querySelector('.rpk-fix')?.textContent ?? null }));
    const json = JSON.parse(await h.commands.regexperf.callback({}, 'json'));
    const saves = h.st.counters.saveSettings;
    root.querySelector('#rpk_lint_list li[data-rule="missing-g"] .rpk-fix')?.click(); // the confirm popup resolves at once in the harness
    await sleep(30);
    const fixed = h.extension_settings.regex.find(s => s.id === noG.id).findRegex;
    rowOf(root, 'Ref').querySelector('.rpk-off').click(); // no Regex drawer in the page: the engine's save is used
    await sleep(30);
    const off = h.extension_settings.regex.find(s => s.scriptName === 'Ref').disabled;
    return { outs, rows, lint: json.lint, fixed, off, saves: h.st.counters.saveSettings - saves, popups: h.popups.length, toasts: h.toasts.map(([, m]) => m) };
}

/** Feature list 2.1. Cost chips in the Regex extension's own list, kept up to date when SillyTavern re-renders it. */
export async function listBadges(h) {
    const s = script({ scriptName: 'Status card', findRegex: '/<status>([\\s\\S]*?)<\\/status>/g', replaceString: '$1', markdownOnly: true });
    await useScripts(h, [s]);
    const list = document.getElementById('saved_regex_scripts'); // the harness page has the drawer's global list
    const render = () => { list.innerHTML = `<div id="${s.id}" class="regex-script-label"><span class="regex_script_name">Status card</span></div>`; };
    render();
    for (let i = 0; i < 5; i++) h.engine.getRegexedString(`<status>${i}</status>`, P.AI, { isMarkdown: true });
    await sleep(1200); // the panel's refresh interval installs the observer and draws the chip
    const chip1 = list.querySelector('.rpk-chip')?.textContent ?? null;
    render(); // SillyTavern re-renders the list: the chip must come back
    await sleep(150);
    const chip2 = list.querySelector('.rpk-chip')?.textContent ?? null;
    list.innerHTML = '';
    return { chip1, chip2 };
}

/** tests/screenshots.mjs: a realistic session in the panel (the corpus chat, a measurement, a per-row stopwatch). */
export async function screenshot(h) {
    const corpus = await import('./corpus.js');
    applyProfile(h, { persist: true });
    h.st.setState({ name1: 'User', name2: 'Dr. A (B)', chat: Array.from({ length: 8 }, () => corpus.CHAT()).flat() });
    await useScripts(h, [...corpus.SCRIPTS(), script({ scriptName: 'Digits', findRegex: '/\\d{4,}/g', replaceString: '####', markdownOnly: true })]);
    for (let k = 0; k < 3; k++) h.st.chat.forEach((m, i) => h.st.messageFormatting(m.mes, m.name, m.is_system, m.is_user, i));
    h.st.chat.forEach((m) => h.engine.getRegexedString(m.mes, P.AI));
    const root = panel();
    root.querySelector('#rpk_measure').click();
    await sleep(80);
    root.querySelector('#rpk_table tbody tr[data-i="0"] .rpk-measure-row')?.click();
    await sleep(80);
    root.querySelector('details[data-section="limits"]').open = true;
    panel(true);
    return root.getBoundingClientRect().height;
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
