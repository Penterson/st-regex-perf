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
    const { corpus } = await importCorpus();
    const rpk = applyProfile(h, profile);
    h.st.setState({ name1: 'User', name2: 'Dr. A (B)', chat: corpus.CHAT() });
    // ⑧ stores display output, so a {{random}} display script keeps its first roll there (documented in the README).
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

/** Counts RegExp.prototype[Symbol.replace] calls (regex executions) until stop(). */
export function countNativeReplaces() {
    const orig = RegExp.prototype[Symbol.replace];
    let n = 0;
    RegExp.prototype[Symbol.replace] = function (...args) {
        n++;
        return orig.apply(this, args);
    };
    return { stop: () => { RegExp.prototype[Symbol.replace] = orig; return n; } };
}

const importCorpus = async () => ({ corpus: await import('./corpus.js') });

export async function smoke(h) {
    h.extension_settings.regex = [script({ findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '[b]$1[/b]' })];
    const out = h.engine.getRegexedString('Hello **world**!', P.AI);
    const re = h.engine.RegexProvider.instance.get('/x/g');
    return { out, wrapped: Object.getPrototypeOf(re) !== RegExp.prototype };
}

/** Runs fn while counting regex executions per pattern source. */
function executionsBySource(fn) {
    const orig = RegExp.prototype[Symbol.replace];
    const counts = {};
    RegExp.prototype[Symbol.replace] = function (...args) {
        counts[this.source] = (counts[this.source] ?? 0) + 1;
        return orig.apply(this, args);
    };
    try {
        fn();
    } finally {
        RegExp.prototype[Symbol.replace] = orig;
    }
    return counts;
}

/** The extension's text report (the /regexperf text command), or '' without the extension. */
async function report(h) {
    return h.commands.regexperf ? String(await h.commands.regexperf.callback({}, 'text')) : '';
}

/** ① Case-insensitive patterns whose matches need Unicode case folding (σ/Σ/ς, µ/μ, ſ/s). */
export async function caseFold(h) {
    await useScripts(h, [
        script({ findRegex: '/ΣΟΦΙΑ/gi', replaceString: '[sophia]' }),
        script({ findRegex: '/σ/gi', replaceString: '[sigma]' }),
        script({ findRegex: '/μm/gi', replaceString: '[micrometre]' }),
        script({ findRegex: '/ſun/giu', replaceString: '[sun]' }),
    ]);
    return ['ΟΔΟΣ', 'οδος', 'a 5µm grain', 'Sunday', 'σοφια'].map(s => h.engine.getRegexedString(s, P.AI));
}

/** ② A script's replacement is edited, then the chat reloads (or a preset switches) without RegexProvider.clear(). */
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

/** ③ Matched text that contains macros: SillyTavern substitutes them again after inserting the groups. */
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

/** ④ ⑧ keeps display output per message; renaming the persona or the character must refresh it. */
export async function persistNames(h, { charName = 'ch_name' } = {}) {
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
    if (charName === 'ch_name') h.st.chat[0].name = 'Kit'; // the author name SillyTavern passes as ch_name
    h.st.setState({ name2: 'Kit' });
    out.push(render());
    return out;
}

/** ⑤ substituteRegex = 2 (ESCAPED): recognized as its script, memoized, and skipped while streaming. */
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
