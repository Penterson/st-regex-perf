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
