/**
 * Regex Perf Kit — speeds up SillyTavern's built-in Regex extension without touching any regex script.
 *
 * RegexProvider.instance.get() is patched to return a RegExp subclass whose [Symbol.replace] adds ① profiler,
 * ② literal prefilter, ③ memo, ④ streaming skip, ⑥ fast path, ⑦ fuse and ⑧ circuit breaker. MessageFormatter hooks add
 * ⑤ a persisted display cache (IndexedDB), ⑨ an HTML cache, ④'s compromise mode (incremental formatting, paragraph
 * cache) and per-stage timing of the display pipeline. No SillyTavern core file is modified.
 */

// The engine through a namespace: a named export an older SillyTavern lacks would fail the whole module
// (regexFromString is safe: the engine imports it too).
import * as engine from '../../regex/engine.js';
import { regexFromString } from '../../../utils.js';
// For what getContext() lacks: the showdown converter instance and updateMessageBlock().
import * as st from '../../../../script.js';

const { RegexProvider, getRegexScripts, getScriptsByType, SCRIPT_TYPES } = engine;
const EXTRA_KEY = 'regex_perf_cache';
const ctx = () => SillyTavern.getContext();
// Fixed for the session; live state (chat, names, streaming) is read through ctx().
const { t, translate, extensionSettings, eventSource, event_types, getCurrentLocale, addLocaleData, saveSettingsDebounced } = ctx();

// ---- Settings ----

// Chromium reports the device's memory class in GB; other browsers report nothing.
const deviceMemory = Number(globalThis.navigator?.deviceMemory) || 0;
/** A default by memory class: up to 2 GB, up to 4 GB, more or not reported. */
const byMemory = (low, mid, high) => (!deviceMemory ? high : deviceMemory <= 2 ? low : deviceMemory <= 4 ? mid : high);
const MB = 1048576;

const defaultSettings = {
    profiler: true,
    profilerSampling: deviceMemory > 0 && deviceMemory <= 4, // ① past 1000 runs of a script, time 1 in 8
    timeReplacer: true, // ① the Replacer column
    prefilter: true,
    memo: true,
    memoStatic: true, // ③ also scripts whose only macros are {{user}} {{char}} {{persona}} {{group}}
    memoPostHoc: true, // ③ also inputs with macro syntax outside the matched text
    fastPath: true,
    fastPathStatic: true, // ⑥ also replacements whose only macros are the static ones
    htmlMemo: true,
    htmlMemoMaxEntries: 2000,
    htmlMemoMaxMB: byMemory(8, 16, 32),
    streamingIncremental: true, // ④ compromise: line-local scripts run on the new lines only
    streamingParagraphCache: true, // ④ compromise: markdown and sanitizing on the paragraph being written only
    adaptive: true, // ① time 1 run in 64 once regex is a negligible share of the render
    frameStats: false, // ① stutter counters (late frames, long tasks)
    memoMaxEntries: 3000,
    memoMaxLen: 20000,
    memoMaxMB: byMemory(16, 32, 64),
    streamingSkip: true,
    streamingThrottle: false, // ④ compromise mode
    streamingThrottleMs: 500,
    persist: true,
    persistMaxLen: 60000,
    persistDbMaxMB: 64, // ⑤ all chats together
    memoHashKeys: false, // ③ keyed by hash64(input) + length instead of the input
    autoMeasure: false,
    loadHintMs: 3000,
    fuse: false, // ⑦ changes the result: off by default
    fuseLen: 20000,
    breaker: false,
    breakerMs: 500,
    breakerCount: 3,
    lint: true,
    listBadges: true,
    schema: 1, // since 0.5.2; settings saved without it are migrated once below
};

// SillyTavern keeps this object for the session, so it is resolved once.
const settings = (extensionSettings.regex_perf_kit ||= {});
// 0.5.2 turned the stutter option off by default: older saved settings follow once, later choices are kept.
if (Object.keys(settings).length && !Object.hasOwn(settings, 'schema')) settings.frameStats = false;
for (const [key, value] of Object.entries(defaultSettings)) {
    if (!Object.hasOwn(settings, key)) settings[key] = value;
}
// What the hot path reads. A measurement swaps in an object inheriting from settings for one message's formatting, so
// the saved settings are never touched.
let cfg = settings;

// ---- Utilities ----

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

/** Two independent 32-bit hashes in one pass (fnv1a and a multiply-xorshift mix), as one 64-bit key. */
function hash64(str) {
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193);
        b = Math.imul(b ^ c, 0x85ebca6b);
        b ^= b >>> 13;
    }
    return (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);

// True from a generation's start to GENERATION_ENDED / STOPPED (see startGeneration()); without those events, always.
// It starts at GENERATION_AFTER_COMMANDS: a slash command typed in the chat box emits GENERATION_STARTED and no end.
const START_EVENT = event_types.GENERATION_AFTER_COMMANDS ?? event_types.GENERATION_STARTED;
let generating = !(START_EVENT && event_types.GENERATION_ENDED && event_types.GENERATION_STOPPED);

// script.js exports the processor: read without building getContext() per display script
const exportsStream = 'streamingProcessor' in st;
/** The streaming processor while a stream is live, else null. */
function liveStream() {
    if (!generating) return null;
    const sp = exportsStream ? st.streamingProcessor : ctx().streamingProcessor;
    return sp && !sp.isFinished && !sp.isStopped ? sp : null;
}

// SillyTavern's macro syntax: {{...}} and the legacy <USER> <BOT> <CHAR> <GROUP> <CHARIFNOTGROUP> markers.
const MACRO = /{{|<(?:user|bot|char(?:ifnotgroup)?|group)>/i;
// Macros whose value holds for a whole message render (and their legacy markers): scripts using only these are
// memoized per value set; any other macro keeps a script out of ③.
const STATIC_MACRO = /{{(?:user|char|persona|group)}}|<(?:user|bot|char|group)>/gi;

let macroIn = null;
let macroOut = false;
/** MACRO.test(str), memoized for the last input: consecutive scripts usually see the same string. */
function hasMacro(str) {
    if (str !== macroIn) {
        macroIn = str;
        macroOut = MACRO.test(str);
    }
    return macroOut;
}

// Macro values inside an ESCAPED (substituteRegex 2) pattern, as SillyTavern's sanitizeRegexMacro escapes them.
const REGEX_MACRO_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' };
const sanitizeRegexMacro = (x) => (x && typeof x === 'string'
    ? x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (c) => REGEX_MACRO_ESCAPES[c] ?? '\\' + c)
    : x);

const CONTROL_ESCAPES = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' };
const HEX_DIGITS = { u: 4, x: 2 }; // digits after \u and \x
const HEX = /^[0-9a-fA-F]+$/;
const ASCII_LETTER = /[a-zA-Z]/;
const BAIL = Symbol('bail');
const BRACE_QUANT = /^\{(\d+)(,(\d*))?\}/;
const GROUP_PREFIX = /^(?:<?[=!]|[a-z]*(?:-[a-z]*)?:)/; // after "(?": a lookaround or a modifier group
const MATCH_MACRO = /{{match}}/gi; // $0, as runRegexScript() reads it
const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** The quantifier at source[i], lazy '?' included: {min, max, len} or null. */
function quantAt(source, i) {
    const c = source[i];
    let q = null;
    if (c === '?' || c === '*' || c === '+') {
        q = { min: c === '+' ? 1 : 0, max: c === '?' ? 1 : Infinity, len: 1 };
    } else if (c === '{') {
        const m = BRACE_QUANT.exec(source.slice(i, i + 24));
        if (m) q = { min: Number(m[1]), max: m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : Number(m[1]), len: m[0].length };
    }
    if (q && source[i + q.len] === '?') q.len++;
    return q;
}
/** Index of the ']' that closes the class opening at source[i] (source.length when none does). */
function classEnd(source, i) {
    let j = i + 1;
    if (source[j] === '^') j++; // in JS "[]" is an empty class and "[^]" matches anything: a ']' right after closes it
    while (j < source.length && source[j] !== ']') {
        if (source[j] === '\\') j++;
        j++;
    }
    return j;
}

// ② Literal presence per input: each literal (or case-insensitive check) gets an id and an input's answers are kept by
// id, so a string flowing through every script is scanned once per literal. With keep (displayed messages, which
// re-render) the litCacheMax() most recent inputs are remembered.
let chatLen = 0; // messages in the current chat: the cache grows with it
const litCacheMax = () => Math.max(256, 2 * chatLen);
const litIds = new Map(); // literal or "\0source/flags" -> id
const litCache = new Map(); // input -> answers by id
let litIn = null;
let litSeen = null;
const litId = (key) => {
    let id = litIds.get(key);
    if (id === undefined) litIds.set(key, id = litIds.size);
    return id;
};
function litPresent(str, id, lit, re, keep) {
    if (str !== litIn) {
        litIn = str;
        if (!keep || str.length > cfg.memoMaxLen) {
            litSeen = [];
        } else {
            litSeen = litCache.get(str);
            if (!litSeen) setCapped(litCache, str, litSeen = [], litCacheMax());
        }
    }
    let v = litSeen[id];
    if (v === undefined) litSeen[id] = v = re ? re.test(str) : str.includes(lit);
    return v;
}
const clearLitCache = () => {
    litCache.clear();
    litIn = litSeen = null;
};

/**
 * Parses a pattern once. Every match contains, for each of terms, at least one of its literals (a one-literal term is
 * a mandatory run, a longer one an alternation) and is at least minLen UTF-16 units long; test(str, keep) checks both.
 * needles is the single best term, or null with a NEEDLE_REASONS code in reason; nested flags (a+)+ shapes.
 * Conservative: classes, escapes, backreferences, lookarounds and modifier groups contribute no literal, and patterns
 * with the v flag or a case modifier ((?i:), (?-i:)) get nothing at all.
 * @param {string} source RegExp.source
 * @param {string} flags RegExp.flags
 * @returns {{needles: string[] | null, reason: string | null, terms: string[][], minLen: number, test: ((str: string, keep?: boolean) => boolean) | null, nested: boolean}}
 */
export function extractNeedle(source, flags) {
    const u = flags.includes('u');
    const n = source.length;
    let i = 0;
    let nested = false;
    let lits = 0; // literal characters outside lookarounds and modifier groups
    let opaqueLits = 0; // literal characters inside them
    let opaque = 0; // depth inside such groups

    const quant = () => {
        const q = quantAt(source, i);
        if (q) i += q.len;
        return q;
    };

    // A needle set is better if its shortest needle is longer, then if it has fewer needles.
    const score = (set) => Math.min(...set.map(s => s.length));
    const better = (a, b) => {
        if (!b) return true;
        const sa = score(a);
        const sb = score(b);
        return sa > sb || (sa === sb && a.length < b.length);
    };

    // {lit, len} for a literal character, {group, opaque, zero} for a group (zero: a lookaround), {lit: null, len}
    // otherwise; len is the least number of UTF-16 units the atom matches.
    const one = { lit: null, len: 1 };
    const none = { lit: null, len: 0 };
    const atom = () => {
        const c = source[i];
        if (c === '\\') {
            const nx = source[i + 1];
            i += 2;
            if (nx === undefined) return none;
            if ('dDwWsS'.includes(nx)) return one; // classes
            if (nx === 'b' || nx === 'B') return none; // boundaries
            if (nx >= '0' && nx <= '9') { // backreference or (without u) a legacy octal escape: take every digit
                while (source[i] >= '0' && source[i] <= '9') i++;
                return none;
            }
            if ('pPku'.includes(nx) && (source[i] === '{' || source[i] === '<')) { // \p{..} \u{..} \k<..>
                if (!u && nx !== 'k') return literal(nx); // without u, the letter itself; a {..} after it is a quantifier
                const e = source.indexOf(source[i] === '<' ? '>' : '}', i + 1); // skip the argument
                if (e !== -1) {
                    if (/[|()[\]\\]/.test(source.slice(i + 1, e))) throw BAIL; // without u these are literals around real syntax
                    i = e + 1;
                }
                return nx === 'k' ? none : one;
            }
            const hex = HEX_DIGITS[nx]; // \uXXXX \xXX: skip the digits; without them (and u) it is the letter itself
            if (hex) {
                const digits = source.slice(i, i + hex);
                if (digits.length === hex && HEX.test(digits)) {
                    i += hex;
                    return one;
                }
                return u ? one : literal(nx);
            }
            if (nx === 'c') {
                if (ASCII_LETTER.test(source[i] ?? '')) i++;
                return one;
            }
            return literal(CONTROL_ESCAPES[nx] ?? nx); // \n \t \r \f \v, or an escaped character
        }
        if (c === '[') {
            i = classEnd(source, i) + 1;
            return one;
        }
        if (c === '(') {
            i++;
            let hidden = false; // lookarounds and modifier groups contribute no literal
            let zero = false;
            if (source[i] === '?') {
                i++;
                if (source[i] === ':') {
                    i++;
                } else if (source[i] === '<' && source[i + 1] !== '=' && source[i + 1] !== '!') { // (?<name>
                    const e = source.indexOf('>', i);
                    i = e === -1 ? n : e + 1;
                } else { // (?= (?! (?<= (?<! lookarounds, (?i: (?-s: modifiers
                    hidden = true;
                    const m = GROUP_PREFIX.exec(source.slice(i, i + 16));
                    zero = !!m && !m[0].endsWith(':');
                    i += m ? m[0].length : 0;
                }
            }
            if (hidden) opaque++;
            const group = alternation();
            if (hidden) opaque--;
            if (source[i] !== ')') throw BAIL;
            i++;
            return { group, opaque: hidden, zero };
        }
        if (c === '^' || c === '$') {
            i++;
            return none;
        }
        if (c === '.' || c === '{') { // a '{' that is not a quantifier is a literal without u: break the run anyway
            i++;
            return one;
        }
        const start = i;
        const pair = u && c >= '\uD800' && c <= '\uDBFF' && source[i + 1] >= '\uDC00' && source[i + 1] <= '\uDFFF';
        i += pair ? 2 : 1;
        return literal(source.slice(start, i)); // with u, a surrogate pair is one character
    };
    const literal = (lit) => {
        if (opaque) opaqueLits++;
        else lits++;
        return { lit, len: lit.length };
    };

    // A sequence: pre/suf = literal run at its start/end, full = one literal run throughout, best = best needle set,
    // terms = what every match must satisfy, len = least match length, inf = has an unbounded quantifier.
    const sequence = () => {
        let cur = '';
        let pre = null;
        let best = null;
        let inf = false;
        let len = 0;
        let why = null; // why a mandatory group inside has no needle
        const terms = [];
        const consider = (set) => { if (set && better(set, best)) best = set; };
        const end = () => {
            pre ??= cur;
            if (cur) {
                consider([cur]);
                terms.push([cur]);
            }
            cur = '';
        };
        while (i < n && source[i] !== '|' && source[i] !== ')') {
            const a = atom();
            const q = quant();
            const reps = q ? q.min : 1;
            const rep = q?.max === Infinity;
            if (rep) inf = true;
            if (a.group) {
                const g = a.group;
                if (!a.zero) len += g.len * reps;
                if (g.inf) {
                    inf = true;
                    if (rep) nested = true;
                }
                if (a.opaque || reps === 0) {
                    end();
                } else {
                    cur += g.pre;
                    if (q || !g.full) { // the first repetition continues the run before it, the last one starts the run after it
                        end();
                        consider(g.best);
                        terms.push(...g.terms);
                        cur = g.suf;
                    }
                    why ??= g.why;
                }
            } else {
                len += a.len * reps;
                if (a.lit === null || reps === 0) {
                    end();
                } else {
                    cur += a.lit;
                    if (q) { // "ab+c": "ab" and "bc"
                        end();
                        cur = a.lit;
                    }
                }
            }
        }
        const full = pre === null;
        const suf = cur;
        end();
        return { pre, suf, full, best, inf, len, terms, why: best ? null : why };
    };

    const alternation = () => {
        const seqs = [sequence()];
        while (source[i] === '|') {
            i++;
            seqs.push(sequence());
        }
        if (seqs.length === 1) return seqs[0];
        const union = seqs.every(s => s.best) ? [...new Set(seqs.flatMap(s => s.best))] : null;
        const best = union?.length <= 16 ? union : null;
        const why = best ? null : union ? 'too-many' : 'branch';
        return { pre: '', suf: '', full: false, best, inf: seqs.some(s => s.inf), len: Math.min(...seqs.map(s => s.len)), terms: best ? [best] : [], why };
    };

    let top = null;
    let reason = null;
    try {
        // V8 13.x has been seen to match literals outside a (?i:) group case-insensitively after many regexes ran in
        // the page, against the spec: such patterns are left to the engine.
        if (flags.includes('v')) reason = 'v-flag';
        else if (/\(\?[a-z-]*i[a-z-]*:/.test(source)) reason = 'case-modifier';
        if (reason) throw BAIL;
        top = alternation();
        if (i < n) throw BAIL;
    } catch (e) {
        if (e !== BAIL) throw e;
    }
    if (!top) return { needles: null, reason: reason ?? 'syntax', terms: [], minLen: 0, test: null, nested };
    const terms = pruneTerms(top.terms);
    const minLen = top.len;
    const needles = top.best;
    if (!needles) reason = !source ? 'empty' : top.why ?? (lits ? 'optional' : opaqueLits ? 'lookaround' : 'class-only');
    if (!terms.length && !minLen) return { needles, reason, terms, minLen, test: null, nested };
    let has;
    if (!terms.length) {
        has = null;
    } else if (flags.includes('i')) {
        // Escaped literals under the pattern's i/u flags fold case exactly like it (toLowerCase() does not: σ/ς/Σ, ſ/s).
        const res = terms.map(set => new RegExp(set.map(escapeRe).join('|'), u ? 'iu' : 'i'));
        const ids = res.map(re => litId('\0' + re.source + '/' + re.flags));
        has = res.length === 1 ? (str, keep) => litPresent(str, ids[0], null, res[0], keep) : (str, keep) => res.every((re, k) => litPresent(str, ids[k], null, re, keep));
    } else if (terms.length === 1 && terms[0].length === 1) {
        const [[lit]] = terms;
        const id = litId(lit);
        has = (str, keep) => litPresent(str, id, lit, null, keep);
    } else {
        const ids = terms.map(set => set.map(litId));
        has = (str, keep) => terms.every((set, k) => set.some((lit, j) => litPresent(str, ids[k][j], lit, null, keep)));
    }
    const test = !minLen ? has : !has ? (str) => str.length >= minLen : (str, keep) => str.length >= minLen && has(str, keep);
    return { needles, reason, terms, minLen, test, nested };
}

/** Why a pattern has no needle (extractNeedle().reason), in words. */
const NEEDLE_REASONS = {
    'v-flag': () => t`Patterns with the v flag are not analyzed`,
    'case-modifier': () => t`Patterns with a case modifier group such as (?i:) are not analyzed`,
    'syntax': () => t`Unsupported syntax: the pattern could not be analyzed`,
    'empty': () => t`Empty pattern`,
    'branch': () => t`An alternation branch has no literal, so no single literal is certain`,
    'too-many': () => t`The alternation has more than 16 literals`,
    'class-only': () => t`Only classes, escapes or wildcards: no literal character`,
    'lookaround': () => t`Literals occur only inside lookarounds or modifier groups`,
    'optional': () => t`Every literal is optional or repeated zero or more times`,
};
const needleReason = (r) => (r.needle?.reason ? NEEDLE_REASONS[r.needle.reason]() : '');

/**
 * Drops terms another term implies and caps the count, so a check stays a few scans.
 * @param {string[][]} terms
 */
function pruneTerms(terms) {
    const singles = [];
    for (const s of [...new Set(terms.filter(t => t.length === 1).map(t => t[0]))].sort((a, b) => b.length - a.length)) {
        if (!singles.some(k => k.includes(s))) singles.push(s);
    }
    const sets = [];
    for (const set of terms.filter(t => t.length > 1)) {
        const key = JSON.stringify(set);
        if (!singles.some(k => set.some(s => k.includes(s))) && !sets.some(o => JSON.stringify(o) === key)) sets.push(set);
    }
    return [...singles.slice(0, 6).map(s => [s]), ...sets.slice(0, 2)];
}

// ---- Catastrophic backtracking ----

// Character-class overlap is approximated on a sample: ASCII plus a few other scripts and an astral character.
const REDOS_SAMPLE = [...Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)), '가', '한', '中', 'é', 'ß', 'Σ', '😀', '　', ' '];
const charSets = new Map(); // atom source + flags -> the sample characters it matches on its own
const charSet = (src, flags) => cached(charSets, src + '\u0000' + flags, () => {
    const s = new Set();
    try {
        const re = new RegExp('^(?:' + src + ')$', flags.replace(/[gyd]/g, ''));
        for (const c of REDOS_SAMPLE) if (re.test(c)) s.add(c);
    } catch { /* nothing matches */ }
    return s;
}, 4000);
const overlaps = (a, b) => {
    for (const c of a) if (b.has(c)) return true;
    return false;
};

/**
 * Parses a pattern into alternatives of sequences of {atom, q}: atom {kind: 'char', src} | {kind: 'group', alts, look,
 * src} | {kind: 'anchor'} | {kind: 'back'}; q = {min, max} or null. Throws BAIL on syntax it does not understand.
 */
function parseRegex(source, flags) {
    const u = flags.includes('u') || flags.includes('v');
    const n = source.length;
    let i = 0;
    const quant = () => {
        const q = quantAt(source, i);
        if (q) i += q.len;
        return q;
    };
    const atom = () => {
        const c = source[i];
        const start = i;
        if (c === '\\') {
            const nx = source[i + 1];
            if (nx === undefined) throw BAIL;
            i += 2;
            if (nx === 'b' || nx === 'B') return { kind: 'anchor' };
            if (nx >= '1' && nx <= '9') {
                while (source[i] >= '0' && source[i] <= '9') i++;
                return { kind: 'back' };
            }
            if (nx === 'k' && source[i] === '<') {
                i = source.indexOf('>', i) + 1;
                if (i === 0) throw BAIL;
                return { kind: 'back' };
            }
            if ((nx === 'p' || nx === 'P' || nx === 'u' || nx === 'x') && source[i] === '{') {
                i = source.indexOf('}', i) + 1;
                if (i === 0) throw BAIL;
            } else if ((nx === 'u' || nx === 'x') && HEX.test(source.slice(i, i + (nx === 'x' ? 2 : 4)))) {
                i += nx === 'x' ? 2 : 4;
            } else if (nx === 'c') {
                i++;
            }
            return { kind: 'char', src: source.slice(start, i) };
        }
        if (c === '[') {
            const j = classEnd(source, i);
            if (j >= n) throw BAIL;
            i = j + 1;
            return { kind: 'char', src: source.slice(start, i) };
        }
        if (c === '(') {
            i++;
            let look = false;
            if (source[i] === '?') {
                i++;
                if (source[i] === ':') {
                    i++;
                } else if (source[i] === '<' && source[i + 1] !== '=' && source[i + 1] !== '!') {
                    i = source.indexOf('>', i) + 1;
                    if (i === 0) throw BAIL;
                } else {
                    const m = GROUP_PREFIX.exec(source.slice(i, i + 16));
                    if (!m) throw BAIL;
                    look = !m[0].endsWith(':');
                    i += m[0].length;
                }
            }
            const alts = alternation();
            if (source[i] !== ')') throw BAIL;
            i++;
            return { kind: 'group', alts, look, src: source.slice(start, i) };
        }
        if (c === ')' || c === '|' || c === '*' || c === '+' || c === '?') throw BAIL;
        if (c === '^' || c === '$') {
            i++;
            return { kind: 'anchor' };
        }
        if (c === '{' && BRACE_QUANT.test(source.slice(i, i + 24))) throw BAIL;
        const pair = u && c >= '\uD800' && c <= '\uDBFF';
        i += pair ? 2 : 1;
        return { kind: 'char', src: source.slice(start, i) };
    };
    const sequence = () => {
        const items = [];
        while (i < n && source[i] !== '|' && source[i] !== ')') {
            const a = atom();
            items.push({ atom: a, q: a.kind === 'anchor' ? null : quant() });
        }
        return items;
    };
    const alternation = () => {
        const alts = [sequence()];
        while (source[i] === '|') {
            i++;
            alts.push(sequence());
        }
        return alts;
    };
    const alts = alternation();
    if (i < n) throw BAIL;
    return alts;
}
/** parseRegex(), or null where it bails. */
function tryParse(source, flags) {
    try {
        return parseRegex(source, flags);
    } catch (e) {
        if (e !== BAIL) throw e;
        return null;
    }
}

/** Sample characters a sequence can start with: the leading optional items' joined with the first mandatory one's. */
function firstOfSeq(items, flags) {
    const s = new Set();
    for (const { atom, q } of items) {
        if (atom.kind === 'anchor' || (atom.kind === 'group' && atom.look)) continue;
        for (const c of firstOfAtom(atom, flags)) s.add(c);
        const canBeEmpty = atom.kind === 'group' && atom.alts.some(a => a.length === 0);
        if (q?.min !== 0 && !canBeEmpty && atom.kind !== 'back') break;
    }
    return s;
}
function firstOfAtom(atom, flags) {
    if (atom.kind === 'char') return charSet(atom.src, flags);
    const s = new Set();
    if (atom.kind === 'group') for (const alt of atom.alts) for (const c of firstOfSeq(alt, flags)) s.add(c);
    return s;
}
const unbounded = (q) => q?.max === Infinity;
/** An unbounded quantifier anywhere inside (lookarounds aside). */
const hasUnboundedInside = (alts) => alts.some(items => items.some(({ atom, q }) => (unbounded(q) && atom.kind !== 'anchor') || (atom.kind === 'group' && !atom.look && hasUnboundedInside(atom.alts))));

const NO_REDOS = { severity: null, kind: null, snippet: null };
/**
 * Static ReDoS analysis: (x+)+ and an unbounded group whose branches can start with the same character, (a|ab)+, are
 * exponential; adjacent unbounded atoms that can match the same characters, \s*\s*, polynomial (exponential inside an
 * unbounded group). Overlap is sampled: a verdict on the pattern's shape, not a proof. kind 'dotalt' marks the linear
 * but slow (.|\n)* (a suggestion, no severity).
 * @param {string} source
 * @param {string} flags
 * @returns {{severity: 'exp' | 'poly' | null, kind: 'nested' | 'alternation' | 'adjacent' | 'dotalt' | null, snippet: string | null}}
 */
export function analyzeRedos(source, flags) {
    const alts = tryParse(source, flags);
    if (!alts) return NO_REDOS;
    let found = null;
    const report = (severity, kind, snippet) => {
        if (!found || (severity === 'exp' && found.severity !== 'exp')) found = { severity, kind, snippet };
    };
    const quantText = (q) => (q.max === Infinity && q.min <= 1 ? (q.min ? '+' : '*') : `{${q.min},}`);
    const walk = (seqs, inUnbounded) => {
        for (const items of seqs) {
            for (let k = 0; k < items.length; k++) {
                const { atom, q } = items[k];
                if (atom.kind === 'anchor' || atom.kind === 'back' || (atom.kind === 'group' && atom.look)) continue;
                if (atom.kind === 'group') {
                    const rep = unbounded(q);
                    if (rep && hasUnboundedInside(atom.alts)) report('exp', 'nested', atom.src + quantText(q));
                    if (rep && atom.alts.length > 1) {
                        const sets = atom.alts.map(a => firstOfSeq(a, flags));
                        if (sets.some((s, a) => sets.slice(a + 1).some(o => overlaps(s, o)))) report('exp', 'alternation', atom.src + quantText(q));
                        else if (!found && atom.alts.every(a => a.length === 1 && a[0].atom.kind === 'char' && !a[0].q)) found = { severity: null, kind: 'dotalt', snippet: atom.src + quantText(q) };
                    }
                    walk(atom.alts, inUnbounded || rep);
                }
                const next = items[k + 1];
                if (unbounded(q) && next && unbounded(next.q) && next.atom.kind !== 'anchor' && next.atom.kind !== 'back' && overlaps(firstOfAtom(atom, flags), firstOfAtom(next.atom, flags))) {
                    report(inUnbounded ? 'exp' : 'poly', 'adjacent', atom.src + quantText(q) + next.atom.src + quantText(next.q));
                }
            }
        }
    };
    walk(alts, false);
    return found ?? NO_REDOS;
}
/**
 * Whether no match can contain or depend on a newline, so running the pattern on the text after a line break gives
 * the same replacements as on the whole text (④ incremental). Conservative: no character atom (lookarounds included)
 * may match "\n", ^ and $ need the m flag, g is required, y refused, unparsed patterns are not line-local.
 * @param {RegExp} re
 * @returns {boolean}
 */
export function isLineLocal(re) {
    const { flags } = re;
    if (!flags.includes('g') || flags.includes('y')) return false;
    const alts = tryParse(re.source, flags);
    if (!alts) return false;
    // Without m, ^ and $ are the text's ends: checked on the source (classes removed), as parseRegex() keeps anchors
    // without their kind.
    if (!flags.includes('m') && /(?:^|[^\\])(?:\\\\)*[$^]/.test(re.source.replace(/\[(?:\\.|[^\]])*\]/g, ''))) return false;
    const ok = (seqs) => seqs.every(items => items.every(({ atom }) => {
        if (atom.kind === 'back' || atom.kind === 'anchor') return true; // a backreference repeats a group, which cannot hold a newline either
        if (atom.kind === 'char') return !charSet(atom.src, flags).has('\n');
        return ok(atom.alts);
    }));
    return ok(alts);
}
const lineLocalCache = new Map();
const isLineLocalCached = (re) => cached(lineLocalCache, keyOf(re), () => isLineLocal(re));

const redosCache = new Map(); // "source\0flags" -> analyzeRedos()
const redosOf = (re) => cached(redosCache, keyOf(re), () => analyzeRedos(re.source, re.flags));

/** The analyzer's verdict in words, and what to do about it. */
const REDOS_REASONS = {
    nested: (s) => t`nested quantifier ${s}`,
    alternation: (s) => t`alternation with overlapping branches ${s}`,
    adjacent: (s) => t`adjacent overlapping quantifiers ${s}`,
    dotalt: (s) => t`${s} → a character class such as [\\s\\S]`,
};
const REDOS_SUGGESTIONS = { // for the exp / poly shapes; dotalt's reason is its suggestion
    nested: () => t`Repeat one thing only: (x+)+ → x+, (?:\\w+\\s?)* → [\\w\\s]*`,
    alternation: () => t`Make the branches start with different characters, or merge them: (a|ab) → ab?`,
    adjacent: () => t`Merge them into one quantifier, or end the first at a character the second cannot match: .*.* → .*`,
};
const redosReason = (r) => REDOS_REASONS[r.kind]?.(r.snippet) ?? '';
const redosSuggestion = (r) => REDOS_SUGGESTIONS[r.kind]?.() ?? '';

// ---- Script info: compiled pattern key -> script metadata ----

const keyOf = (re) => re.source + '\u0000' + re.flags;

// A RAW/ESCAPED find pattern with macros compiles differently when their values change ({{user}} after a rename,
// {{random}} on every run), so the compiled key misses its script: a pattern with the name macros only is substituted
// again (side-effect free), any other is matched as a shape where each macro is any text (its macros run once a run,
// in SillyTavern).
const MACRO_SPLIT = /{{[^{}]*}}|<(?:user|bot|char(?:ifnotgroup)?|group)>/gi;
const shapeOf = (raw) => new RegExp('^' + raw.split(MACRO_SPLIT).map(escapeRe).join('[\\s\\S]*?') + '$');
function resolveDynamic(regexString, dynamic) {
    const exact = dynamic.filter(d => d.exact);
    if (exact.length) {
        const { substituteParamsExtended } = ctx();
        for (const d of exact) {
            try {
                if (substituteParamsExtended(d.raw, {}, d.substitute === 2 ? sanitizeRegexMacro : undefined) === regexString) return d.info;
            } catch { /* try the shape */ }
        }
    }
    return dynamic.find(d => d.shape.test(regexString))?.info;
}

// ---- ⑥ Fast path ----

const VERIFY_RUNS = 3; // a script's first fast-path runs are compared with SillyTavern's callback
const fastPathOff = new Set(); // fast keys that disagreed once: the callback for the session
const INC_VERIFY_RUNS = 3; // ④ a script's first incremental runs are compared with a full run
const incOff = new Set(); // pattern keys whose incremental run disagreed once: full runs for the session

/**
 * SillyTavern's replacer (runRegexScript) as a native string template: {{match}} and $0 become $&, $n a two-digit $nn,
 * $<name> stays with named groups and is '' without, every other $ is escaped. A $n beyond the group count gives a
 * null template (the callback would read the match offset or input there); refs lists every reference for the lint.
 * @param {string} replaceString
 * @param {RegExp} re
 * @returns {{template: string | null, groupCount: number, named: boolean, refs: {ref: string, ok: boolean}[]}}
 */
export function buildTemplate(replaceString, re) {
    const probe = new RegExp(re.source + '|', re.flags).exec('');
    const groupCount = probe.length - 1;
    const named = !!probe.groups;
    const refs = [];
    let ok = true;
    const template = replaceString.replace(MATCH_MACRO, '$0').replace(/\$(\d+)|\$<([^>]+)>|\$/g, (m, num, name) => {
        if (num) {
            const n = Number(num);
            if (n === 0) return '$&';
            const fits = n <= groupCount && n <= 99;
            refs.push({ ref: m, ok: fits });
            ok &&= fits;
            return fits ? '$' + String(n).padStart(2, '0') : m;
        }
        if (name !== undefined) {
            refs.push({ ref: m, ok: named });
            return named ? m : '';
        }
        return '$$';
    });
    return { template: ok ? template : null, groupCount, named, refs };
}

/**
 * What a native replace makes of a buildTemplate() template for one match (its callback arguments): $$, $&, two-digit
 * $nn and $<name> as GetSubstitution reads them. Used to verify the template against SillyTavern's callback per match.
 */
function expandTemplate(template, args) {
    const last = args[args.length - 1];
    const groups = typeof last === 'object' ? last : undefined;
    let out = '';
    for (let i = 0; i < template.length; i++) {
        const c = template[i];
        if (c !== '$') {
            out += c;
            continue;
        }
        const n = template[i + 1];
        if (n === '$') {
            out += '$';
            i++;
        } else if (n === '&') {
            out += args[0];
            i++;
        } else if (n === '<') {
            const e = template.indexOf('>', i);
            out += groups?.[template.slice(i + 2, e)] ?? '';
            i = e;
        } else if (n >= '0' && n <= '9') {
            const d = template[i + 2];
            const two = d >= '0' && d <= '9';
            out += args[Number(two ? n + d : n)] ?? '';
            i += two ? 2 : 1;
        } else {
            out += '$';
        }
    }
    return out;
}

/** Whether text, as a whole, is a match of re (true when unsure). */
function matchesWhole(re, text) {
    try {
        if (text.includes('\n') && re.flags.includes('m')) return true;
        return new RegExp('^(?:' + re.source + ')$', re.flags.replace(/[gy]/g, '')).test(text);
    } catch {
        return true;
    }
}

/** The second tier: groups filled and trim strings removed as runRegexScript() does it, without substituteParams(). */
function buildTrimReplacer(replaceString, trims, named) {
    const normalized = replaceString.replace(MATCH_MACRO, '$0');
    return function () {
        const args = arguments;
        const groups = named ? args[args.length - 1] : null;
        return normalized.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, name) => {
            let v = num ? args[Number(num)] : groups && groups[name];
            if (!v) return '';
            for (const trim of trims) v = v.replaceAll(trim, '');
            return v;
        });
    };
}

/**
 * A ⑥ fast path: the template, or a lean callback when there are trim strings. identity: a match can be its own
 * replacement (otherwise an unchanged output means no match).
 */
const fastOf = (key, template, replaceString, trims, named, refs, re) => ({
    key,
    template: trims.length ? null : template,
    replacer: trims.length ? buildTrimReplacer(replaceString, trims, named) : null,
    verify: VERIFY_RUNS,
    identity: refs.length > 0 || template.includes('$&') || matchesWhole(re, template.replace(/\$\$/g, '$')),
});

/** @type {{map: Map<string, object>, dynamic: object[], invalid: object[], counts: object, depthRules: number[][], version: string, displayVersion: string, fp: string, checkedAt: number} | null} */
let infoCache = null; // null = rebuild on next use
const markDirty = () => { infoCache = null; };
let infoBuilds = 0; // in the JSON report
const FINGERPRINT_EVERY_MS = 16; // the script lists are fingerprinted at most once per frame

// Parsed patterns, needles and templates outlive a rebuild (re-parsing hundreds of scripts each time was a parse storm).
const CACHE_MAX = 2000;
const compiledCache = new Map(); // pattern string, as RegexProvider receives it -> RegExp | null
const needleCache = new Map(); // "source\0flags" -> extractNeedle()
const templateCache = new Map(); // fast key -> buildTemplate()
/** Adds a new key to a map holding at most max entries, dropping the oldest first. */
function setCapped(map, key, value, max) {
    if (map.size >= max) map.delete(map.keys().next().value);
    map.set(key, value);
}
function cached(map, key, make, max = CACHE_MAX) {
    let v = map.get(key);
    if (v === undefined) setCapped(map, key, v = make(), max);
    return v;
}
// regexFromString() swallows the engine's error: compiled again, split the same way, for the invalid-pattern list.
const compile = (pattern) => cached(compiledCache, pattern, () => {
    try {
        const re = regexFromString(pattern);
        if (re) return { re, error: null };
    } catch { /* reported below */ }
    let error = t`Not a valid pattern`;
    try {
        const m = /(\/?)(.+)\1([a-z]*)/i.exec(pattern);
        new RegExp(m ? m[2] : pattern, m ? m[3] : '');
    } catch (e) { error = String(e?.message ?? e); }
    return { re: null, error };
});
const needleOf = (re) => cached(needleCache, keyOf(re), () => extractNeedle(re.source, re.flags));

/** The scripts by origin, in the engine's priority order (global, preset, scoped); older engines only have the flat list. */
function readGroups() {
    const groups = [];
    try {
        if (typeof getScriptsByType === 'function' && SCRIPT_TYPES) {
            for (const [name, type] of Object.entries(SCRIPT_TYPES)) groups.push([name.toLowerCase(), getScriptsByType(type, { allowedOnly: true }) ?? []]);
        } else {
            groups.push(['global', getRegexScripts({ allowedOnly: true }) ?? []]);
        }
    } catch (e) { console.warn('[RegexPerf] reading regex scripts failed', e); }
    return groups;
}
/** What an edit that fires no event changes: ids, switches, pattern and replacement lengths, the display flags. */
const fingerprint = (groups) => groups.map(([, list]) => list.map(s => `${s?.id}|${s?.disabled ? 1 : 0}|${s?.findRegex?.length ?? 0}|${s?.replaceString?.length ?? 0}|${s?.markdownOnly ? 1 : 0}${s?.promptOnly ? 1 : 0}`).join()).join(';');
// No macros in the replacement or trim strings, and no group reference that could complete one (<$1>, {$1}): the
// output depends only on the input, so it can be memoized.
const pureOf = (rep, trims) => !MACRO.test(rep) && !/[{<]\$(?:\d|<)|\$(?:\d+|<[^>]+>)[}>]/.test(rep) && !trims.some(trim => MACRO.test(String(trim)));
// Group text can still join into macro syntax (SillyTavern substitutes it) where two references meet ($1$2), a brace
// follows one ($1{user}}) or trim strings cut out what stood between two braces: ③ checks such a script's matches.
const GROUP_REF = /\$(?:\d+|<[^>]+>)/;
const assemblesOf = (rep, trims) => /\$(?:\d+|<[^>]+>)[{$]/.test(rep) || (trims.length > 0 && GROUP_REF.test(rep));

function ensureInfo() { // runs on every RegexProvider.get(): Date.now() is the cheaper clock
    if (!infoCache) return (infoCache = buildInfo(readGroups()));
    const now = Date.now();
    if (now - infoCache.checkedAt >= FINGERPRINT_EVERY_MS) { // edits that fire no event are caught here, once per frame
        infoCache.checkedAt = now;
        const groups = readGroups();
        if (fingerprint(groups) !== infoCache.fp) infoCache = buildInfo(groups);
    }
    return infoCache;
}

function buildInfo(groups) {
    infoBuilds++;
    const { substituteParamsExtended } = ctx();
    const map = new Map();
    const dynamic = []; // {raw, substitute, shape, info} of RAW/ESCAPED scripts whose pattern has macros, see resolveDynamic()
    const counts = { total: 0, active: 0, noNeedle: 0, redos: 0, redosExp: 0, invalid: 0, types: {} };
    const invalid = []; // {id, name, type, error} of scripts whose pattern does not compile
    const versionParts = [];
    const displayParts = []; // the parts that can change a display result: the ⑤ key's version
    const depthRules = []; // [min, max] of display scripts with depth limits, for the ⑤ key

    for (const [origin, list] of groups) {
        const tally = { total: list.length, active: 0 };
        counts.types[origin] = tally;
        counts.total += list.length;
        for (const s of list) {
            if (!s?.findRegex || s.disabled) continue;
            tally.active++;
            counts.active++;

            let rs = s.findRegex;
            const name = s.scriptName || t`(no name)`;
            const substitute = Number(s.substituteRegex);
            const substituted = substitute === 1 || substitute === 2; // RAW / ESCAPED, as runRegexScript() compiles them
            const isDynamic = substituted && MACRO.test(rs);
            // static macros compile the same way for a whole render (their values are in the ⑨/⑤ key); others do not
            const dynamicVolatile = isDynamic && MACRO.test(rs.replace(STATIC_MACRO, ''));
            if (substituted) {
                try { rs = substituteParamsExtended(rs, {}, substitute === 2 ? sanitizeRegexMacro : undefined); } catch { /* keep the raw pattern */ }
            }
            const { re, error } = compile(rs);
            if (!re) { // SillyTavern silently does nothing for such a script: listed in the panel
                invalid.push({ id: s.id, name, type: origin, error });
                counts.invalid++;
                continue;
            }

            const key = keyOf(re);
            const prev = map.get(key);
            const replaceString = String(s.replaceString ?? '');
            const trims = Array.isArray(s.trimStrings) ? s.trimStrings : [];
            const trimSig = trims.join('\u0002');
            const needle = needleOf(re);
            if (!needle.needles) counts.noNeedle++;
            const redos = redosOf(re);
            if (redos.severity) {
                counts.redos++;
                if (redos.severity === 'exp') counts.redosExp++;
            }

            const replacement = replaceString.replace(MATCH_MACRO, '$0');
            const pure = pureOf(replacement, trims);
            // semiPure: pure once the static macros are taken out (the output depends on the input and their values)
            const strippedTrims = trims.map(trim => String(trim).replace(STATIC_MACRO, ''));
            const semiPure = !pure && pureOf(replacement.replace(STATIC_MACRO, ''), strippedTrims);
            const info = {
                name,
                markdownOnly: !!s.markdownOnly,
                pure,
                semiPure,
                assembles: (pure || semiPure) && assemblesOf(replacement, trims),
                // two renders of the same text can differ ({{random}}, {{getvar}}): ⑨ and ⑤ keep no message it matched
                volatile: dynamicVolatile || !(pure || semiPure),
                dynamicVolatile,
                semiPureTrims: semiPure && strippedTrims.some((trim, k) => trim !== String(trims[k])), // a trim string holds a static macro
                replaceSig: fnv1a(replaceString + '\u0001' + trimSig),
                needle,
                redos,
                ids: [s.id], // for the row actions in the table
                statKey: isDynamic ? '\u0004' + s.findRegex : key, // dynamic patterns are counted under the raw pattern
                raw: isDynamic ? s.findRegex : null,
            };
            if (prev) { // scripts sharing a pattern share one wrapper: keep only what holds for all of them
                info.name = prev.name + ', ' + info.name;
                info.ids = [...prev.ids, s.id];
                info.markdownOnly &&= prev.markdownOnly;
                info.pure &&= prev.pure && prev.replaceSig === info.replaceSig;
                info.semiPure &&= prev.semiPure && prev.replaceSig === info.replaceSig;
                info.semiPureTrims &&= info.semiPure;
                info.assembles ||= prev.assembles;
                info.volatile ||= prev.volatile;
                info.dynamicVolatile ||= prev.dynamicVolatile;
                info.statKey = prev.statKey;
                info.raw = prev.raw;
                for (const d of dynamic) if (d.info === prev) d.info = info;
            }
            map.set(key, info);
            if (isDynamic) dynamic.push({ raw: s.findRegex, substitute, shape: shapeOf(s.findRegex), info, exact: !dynamicVolatile });
            const fastKey = key + '\u0001' + info.replaceSig;
            const tpl = cached(templateCache, fastKey, () => buildTemplate(replaceString, re));
            info.refs = tpl.refs; // for the lint
            info.find = s.findRegex;
            info.source = re.source;
            info.flags = re.flags;
            info.fast = info.pure && tpl.template !== null && !fastPathOff.has(fastKey) ? fastOf(fastKey, tpl.template, replaceString, trims, tpl.named, tpl.refs, re) : null;
            // ⑥ with static macros: the template is finished per value set, in a display pass (staticFastFor)
            info.fastStatic = info.semiPure && tpl.template !== null ? {
                key: fastKey, template: tpl.template, replaceString, trims, named: tpl.named, refs: tpl.refs,
                level: info.semiPureTrims ? 2 : 1, byKey: new Map(),
            } : null;
            // ④ incremental: no match of this pattern crosses a line, so new lines can be formatted alone
            info.lineLocal = tpl.refs.every(r => r.ok) && needle.minLen > 0 && isLineLocalCached(re);
            if (prev) info.lineLocal &&= prev.lineLocal;

            // The depth limits getRegexedString() applies, for display scripts (what ⑤ stores).
            const min = !isNaN(s.minDepth) && s.minDepth !== null && s.minDepth >= -1 ? Number(s.minDepth) : -Infinity;
            const max = !isNaN(s.maxDepth) && s.maxDepth !== null && s.maxDepth >= 0 ? Number(s.maxDepth) : Infinity;
            if (s.markdownOnly && (min > -Infinity || max < Infinity)) depthRules.push([min, max]);
            // a dynamic pattern is versioned by its raw form: its compiled form can change on every rebuild
            const part = [isDynamic ? s.findRegex : re.source, re.flags, replaceString, trimSig, String(!!s.markdownOnly), String(!!s.promptOnly), String(s.minDepth), String(s.maxDepth), String(s.placement)].join('\u0003');
            versionParts.push(part);
            if (!s.promptOnly) displayParts.push(part);
        }
    }
    const version = fnv1a(versionParts.join('\u0003'));
    if (version !== infoCache?.version) clearLitCache(); // other scripts, other literals
    // a rename changes no version, so no wrapper is linked again: the stats take the scripts' names here
    for (const info of map.values()) {
        const stat = stats.get(info.statKey);
        if (!stat) continue;
        stat.name = info.name;
        stat.ids = info.ids;
        for (const id of info.ids) statById.set(id, stat);
    }
    return { map, dynamic, invalid, counts, depthRules, version, displayVersion: fnv1a(displayParts.join('\u0003')), fp: fingerprint(groups), checkedAt: Date.now() };
}

// ---- Instrumented RegExp ----

// Regex calls come in bursts; the burst that ends at CHAT_CHANGED is the chat's first render (the load hint's length
// where display passes are not timed).
const BURST_GAP_MS = 1000;
let burstStart = 0;
let lastCall = -Infinity;
const SPIKE_MS = 50; // a run slower than this is flagged, with a sample of its input
const SPIKE_HEAD = 80; // characters of the input kept in the sample
const SPIKE_KEEP = 20; // spikes kept per script
let passMessageId = null; // the message a display pass formats (null outside one)
const SAMPLE_AFTER = 1000; // ① with profilerSampling, a script past this many runs is timed on 1 run in SAMPLE_EVERY
const SAMPLE_EVERY = 8;
let statsDirty = false; // the stats changed since the panel was last rendered
let tripSeq = 0; // ⑧ ids for the Undo controls

/** ⑧ Turns a script off for the session and says so, with Undo and Open script in the toast. */
function trip(stat) {
    stat.tripped = true;
    statsDirty = true;
    const control = (cls, text) => ` <span class="${cls}" data-trip="${stat.tripId}">${esc(text)}</span>`;
    toastr.warning(esc(t`"${stat.name}" was turned off for this session: ${stat.slowRuns} runs took over ${cfg.breakerMs} ms.`)
        + control('rpk-undo', t`Undo`) + (stat.ids.length ? control('rpk-open', t`Open script`) : ''), 'Regex Perf Kit', { timeOut: 0, extendedTimeOut: 0, escapeHtml: false, closeButton: true });
}
function untrip(stat) {
    stat.tripped = false;
    stat.slowRuns = 0;
    statsDirty = true;
}
/** The Undo / Open script controls of the breaker's toasts and badges. */
function onTripControl(e) {
    const el = e.target.closest?.('.rpk-undo, .rpk-open');
    if (!el) return;
    const stat = [...stats.values()].find(s => String(s.tripId) === el.dataset.trip);
    if (!stat) return;
    if (el.classList.contains('rpk-undo')) untrip(stat);
    else scriptAction(stat, false);
    renderPanel();
}
const stats = new Map(); // pattern key -> counters, see getStat()
let statsSince = Date.now();
const persistStats = { hits: 0, stores: 0 };
let bypass = null; // the hooks are showing a stored result: 'html' (⑨) or 'persist' (⑤)
let skipStat = null; // the pattern a per-row measurement renders the chat without
// The previous call: when a call's input is the previous call's output, the two scripts are neighbours in one pass
// (to spot an earlier script removing what a later one looks for).
let prevStat = null;
let prevIn = null;
let prevOut = null;
const conflicts = new Map(); // "earlierSrc\0laterSrc" -> {earlier, later, count, confirmed, sample}
let streamApply = false; // a ④ compromise pass that does run the display scripts
let streamSkippedMsg = null; // ④ the message whose display scripts were last skipped while streaming, until its final render
let displayPass = false; // a message is being formatted for display
let passVolatile = false; // a volatile script matched in this pass

// ③ for static-macro scripts: what {{user}} {{char}} {{persona}} {{group}} resolve to in this display pass (null
// outside one), for a replacement and, with the message author as {{char}}, for a trim string.
let passChName = null; // the message author of the display pass (null outside one)
let passStatic = null;
let passStaticTrim = null;
let staticFp = null;
let staticVals = null;
let staticChName = null; // the author the trim-string values were resolved for
const staticByFp = new Map(); // fingerprint -> values: alternating authors both stay resolved
/** The key for a static-macro script in this pass (level 2: a trim string holds one), resolved on first use. */
function staticKeyFor(level, context) {
    if (passStatic === null) setPassStatic(passChName, context);
    return level === 2 ? passStaticTrim : passStatic;
}
function setPassStatic(chName, context = ctx()) {
    const { name1, name2, groupId, groups, characters, powerUserSettings, substituteParams } = context;
    const group = groupId ? groups?.find?.(g => g.id === groupId) : null;
    // {{group}} resolves to the members' names, so a renamed member changes the values
    const memberNames = group?.members?.map(avatar => characters?.find?.(c => c?.avatar === avatar)?.name ?? avatar).join();
    const fp = [name1, name2, chName, groupId, group?.members?.join(), memberNames, group?.disabled_members?.join(), powerUserSettings?.persona_description].join('\u0000');
    if (fp !== staticFp) {
        staticFp = fp;
        staticVals = staticByFp.get(fp);
        if (!staticVals) {
            const base = substituteParams('{{user}}\u0000{{char}}\u0000{{persona}}\u0000{{group}}');
            staticVals = [fnv1a(base), fnv1a(base + '\u0000' + substituteParams('{{char}}', { name2Override: chName }))];
            setCapped(staticByFp, fp, staticVals, 32);
        }
        staticChName = chName;
    }
    [passStatic, passStaticTrim] = staticVals;
}
/**
 * ⑥ for a static-macro script: the template with the static macros replaced by this pass's values (a trim string's
 * {{char}} is the message author, as filterString() resolves it), built once per value set and verified like any fast
 * path. null outside a display pass.
 */
function staticFastFor(meta) {
    const fs = meta.fastStatic;
    if (!fs || passChName === null || !cfg.fastPathStatic) return null;
    const key = staticKeyFor(fs.level);
    let f = fs.byKey.get(key);
    if (f === undefined && fastPathOff.has(fs.key + '\u0001' + key)) f = null; // disagreed once this session
    if (f === undefined) {
        const { substituteParams } = ctx();
        const value = (m) => String(substituteParams(m) ?? '');
        const trimValue = (m) => String(substituteParams(m, { name2Override: staticChName }) ?? '');
        // a $ in a value is text, not a group reference
        const template = fs.template.replace(STATIC_MACRO, m => value(m).replace(/\$/g, '$$$$'));
        const replacement = fs.replaceString.replace(STATIC_MACRO, value);
        const trims = fs.trims.map(trim => String(trim).replace(STATIC_MACRO, trimValue));
        f = fastOf(fs.key + '\u0001' + key, template, replacement, trims, fs.named, fs.refs, meta.re);
        f.staticKey = key;
        setCapped(fs.byKey, key, f, 8);
    }
    return f;
}

// ③ Memo: memoPrefix -> Map(key -> entry). The key is the input itself (no key built per call; V8 caches string
// hashes) or, with memoHashKeys, its 64-bit hash and length (half the memory, at the cost of hashing every input).
// memoLru orders all entries, least recently used first; memoBytes estimates their size (2 bytes per UTF-16 unit).
const memo = new Map();
const memoLru = new Set();
let memoBytes = 0;
const clearMemo = () => {
    memo.clear();
    memoLru.clear();
    memoBytes = 0;
};

/** Evicts least recently used entries until the memo fits both its entry and its memory limit. */
function trimMemo() {
    const maxBytes = cfg.memoMaxMB * MB;
    while (memoLru.size && (memoLru.size > cfg.memoMaxEntries || memoBytes > maxBytes)) {
        const old = memoLru.values().next().value;
        memoLru.delete(old);
        old.bucket.delete(old.key);
        if (!old.bucket.size) memo.delete(old.prefix); // a volatile find pattern compiles to a new bucket on every run: empty ones do not pile up
        memoBytes -= old.size;
    }
}

function getStat(key, re) {
    let st = stats.get(key);
    if (!st) {
        st = {
            name: t`(unknown)`,
            src: '/' + re.source + '/' + re.flags,
            calls: 0, totalMs: 0, maxMs: 0, replMs: 0, matched: 0, changed: 0,
            skipped: 0, hits: 0, streamSkipped: 0, fast: 0,
            bypass: 0, // runs skipped while a stored result was shown (⑤ or ⑨)
            htmlBypass: 0, // the part of them ⑨ served from memory
            incremental: 0, // ④ runs on the new lines only
            seen: 0, // every executed run, sampled or not
            seenMatched: 0, // executed runs known to have matched (changed the text, or seen matching), sampled or not
            spike: null, // {ms, len, head, messageId}: the newest run over SPIKE_MS
            spikes: [], // the SPIKE_KEEP newest such runs, newest first
            moreMatches: 0, // runs without g that would have matched again (lint "missing g")
            needle: null, redos: NO_REDOS, // set with the wrapper's meta
            fused: 0, // ⑦ inputs skipped
            broken: 0, // ⑧ runs skipped since the breaker tripped
            slowRuns: 0, // ⑧ runs over breakerMs
            tripped: false,
            tripId: ++tripSeq,
            ids: [], // scripts with this pattern
            replaceSig: undefined, // to notice an edit of this script (⑧)
        };
        stats.set(key, st);
    }
    return st;
}

class PerfRegExp extends RegExp {
    constructor(source, flags) {
        super(source, flags);
        this._meta = null; // set by RegexProvider.get() per script-info version
        this._version = null;
        // V8 takes its fast replace path on plain RegExps only: matching runs on an unsubclassed twin.
        this._native = new RegExp(source, flags);
    }

    [Symbol.replace](str, replacer) {
        const meta = this._meta;
        if (!meta) return super[Symbol.replace](str, replacer); // a copy made with this constructor: a plain RegExp
        const { stat, markdownOnly, test, memoPrefix, memoStatic } = meta;

        if (stat === skipStat) return str;
        if (bypass && displayPass) { // a stored ⑤/⑨ result is being shown
            stat.bypass++;
            if (bypass === 'html') stat.htmlBypass++;
            statsDirty = true;
            return str;
        }
        if (stat.tripped && cfg.breaker) { // ⑧ (off, as in a measurement's features-off pass: nothing is skipped)
            stat.broken++;
            passVolatile = true; // a pass with a skipped script is not the message's result
            return unchanged(stat, str);
        }
        if (cfg.fuse && stat.redos.severity && str.length > cfg.fuseLen) { // ⑦
            stat.fused++;
            passVolatile = true;
            return unchanged(stat, str);
        }
        if (cfg.streamingSkip && markdownOnly && !streamApply) {
            // the streamed message only; without the hooks (passMessageId null) every display pass during a stream
            const sp = liveStream();
            if (sp && (passMessageId === null || sp.messageId === passMessageId)) {
                stat.streamSkipped++;
                if (passMessageId !== null) streamSkippedMsg = passMessageId; // see rerenderSkipped()
                return unchanged(stat, str);
            }
        }
        if (displayPass && meta.dynamic) passVolatile = true; // another render may compile another pattern
        // ④ incremental: a line-local script that formatted a prefix of this stream up to a line break runs on the
        // lines after it only and reuses the rest of its output.
        const incremental = streamApply && cfg.streamingIncremental && meta.lineLocal;
        // displayed messages re-render: their literal answers are kept
        const keep = markdownOnly || displayPass;
        if (cfg.prefilter && test && !test(str, keep)) {
            stat.skipped++;
            if (prevOut === str && prevIn !== str && prevStat !== stat) noteConflict(prevStat, stat, prevIn, test, this._native, keep);
            if (incremental) meta.inc.set(streamKey, { in: str, out: str });
            return unchanged(stat, str);
        }
        let inc = null; // the prefix already formatted, when the new text continues it after a line break
        let incIn = str; // what the regex really runs on
        if (incremental) {
            const prev = meta.inc.get(streamKey); // the reasoning and the body keep prefixes of their own
            if (prev && str.length > prev.in.length && prev.in.endsWith('\n') && str.startsWith(prev.in)) {
                inc = prev;
                incIn = str.slice(prev.in.length);
            }
        }

        let bucket;
        let memoKey;
        let postHoc = false; // the input has macro syntax: memoized only if no match contains any
        // A static-macro script is keyed by their values, known inside a display pass only.
        const staticKey = memoStatic === 0 ? '' : cfg.memoStatic && passChName !== null ? staticKeyFor(memoStatic) : null;
        if (!inc && cfg.memo && memoPrefix && staticKey !== null && str.length <= cfg.memoMaxLen
            && (!hasMacro(str) || (postHoc = cfg.memoPostHoc && typeof replacer === 'function'))) {
            bucket = memo.get(memoPrefix);
            if (!bucket) memo.set(memoPrefix, bucket = new Map());
            memoKey = cfg.memoHashKeys ? hash64(str) + ':' + str.length : str;
            if (staticKey) memoKey = staticKey + '\u0000' + memoKey;
            const hit = bucket.get(memoKey);
            if (hit) {
                memoLru.delete(hit); // most recently used
                memoLru.add(hit);
                stat.hits++;
                return done(stat, str, hit.same ? str : hit.out);
            }
        }

        const native = this._native;
        native.lastIndex = 0;
        // ① sampling: 1 run in SAMPLE_EVERY past SAMPLE_AFTER runs, 1 in LIGHT_EVERY when adaptive; each timed run
        // counts for all of them
        stat.seen++;
        const every = cfg.adaptive && adaptiveLight ? LIGHT_EVERY : cfg.profilerSampling && stat.seen > SAMPLE_AFTER ? SAMPLE_EVERY : 0;
        const profile = cfg.profiler && (!every || stat.seen % every === 0);
        const weight = every || 1;
        const timeRepl = profile && cfg.timeReplacer;
        let replMs = 0;
        let matched = false; // the replacer ran (even if the text came out the same)
        let fn = replacer;
        let out;
        let fastRun = false;
        let macroSeen = false; // a match held macro syntax SillyTavern substituted: not memoizable
        const t0 = profile || cfg.breaker ? performance.now() : 0;
        // ⑥ Without macro syntax in the input, SillyTavern's per-match callback amounts to a template V8 applies without
        // a JS call per match; should group text assemble macro syntax anyway, the callback runs instead. With ⑥ off,
        // the template still checks each match of a script whose groups can assemble it, before ③ keeps the output.
        const tpl = typeof replacer === 'function' && !hasMacro(str) && (cfg.fastPath || (bucket && meta.assembles)) ? meta.fast ?? staticFastFor(meta) : null;
        if (bucket && meta.assembles && !tpl) bucket = undefined; // nothing to check the matches with: not kept
        const fast = cfg.fastPath ? tpl : null;
        let fastAlive = !!fast;
        if (fast && fast.verify <= 0) {
            out = native[Symbol.replace](incIn, fast.template ?? fast.replacer);
            if (MACRO.test(out)) {
                out = undefined;
                native.lastIndex = 0;
            } else {
                fastRun = true;
            }
        }
        if (!fastRun) {
            // The replacer is timed apart from the matching. On a fast-path script's first runs each match's template
            // result is compared with the callback's: one difference turns ⑥ off for the script.
            let checked = false;
            if (typeof replacer === 'function' && (profile || tpl || postHoc)) {
                fn = function () {
                    matched = true;
                    const t1 = timeRepl ? performance.now() : 0;
                    const r = replacer.apply(this, arguments);
                    if (timeRepl) replMs += performance.now() - t1;
                    if (postHoc && !macroSeen && MACRO.test(arguments[0])) macroSeen = true;
                    if (fastAlive || (tpl && !macroSeen)) {
                        const mine = tpl.template !== null ? expandTemplate(tpl.template, arguments) : tpl.replacer.apply(this, arguments);
                        if (MACRO.test(mine)) { // the fast path would fall back here; SillyTavern substituted the macro
                            macroSeen = true;
                            return r;
                        }
                        if (!fastAlive) return r;
                        checked = true;
                        if (mine !== r) {
                            fastAlive = false;
                            fastPathOff.add(fast.key);
                            if (fast.staticKey !== undefined) meta.fastStatic?.byKey.set(fast.staticKey, null);
                            else meta.fast = null;
                            console.warn(`[RegexPerf] fast path disagreed with SillyTavern for "${stat.name}": back to the callback for this script`, { match: String(arguments[0]).slice(0, 200), expected: r.slice(0, 200), got: mine.slice(0, 200) });
                        }
                    }
                    return r;
                };
            }
            out = native[Symbol.replace](incIn, fn);
            if (checked && fastAlive) fast.verify--;
        }
        const lastIndex = native.lastIndex; // what a native replace leaves; the checks below move it
        if (inc) {
            out = inc.out + out;
            if (meta.incVerify > 0) {
                native.lastIndex = 0;
                const whole = native[Symbol.replace](str, fastRun ? fast.template ?? fast.replacer : replacer);
                if (whole !== out) {
                    incOff.add(keyOf(native));
                    meta.lineLocal = false;
                    console.warn(`[RegexPerf] incremental formatting disagreed with a full run for "${stat.name}": off for this script`, { pattern: stat.src, expected: whole.slice(-200), got: out.slice(-200) });
                    out = whole;
                } else {
                    meta.incVerify--;
                }
            }
        }
        if (incremental) meta.inc.set(streamKey, { in: str, out });
        const dt = t0 ? performance.now() - t0 : 0;
        if (cfg.breaker && dt > cfg.breakerMs && ++stat.slowRuns >= cfg.breakerCount) trip(stat); // ⑧
        if (profile) {
            if (t0 - lastCall > BURST_GAP_MS) burstStart = t0;
            lastCall = t0 + dt;
            stat.calls += weight;
            stat.totalMs += dt * weight;
            stat.replMs += replMs * weight;
            if (fastRun) stat.fast += weight;
            if (inc) stat.incremental += weight;
            if (dt > stat.maxMs) stat.maxMs = dt;
            if (dt > SPIKE_MS) {
                stat.spike = { ms: dt, len: incIn.length, head: incIn.slice(0, SPIKE_HEAD), messageId: passMessageId };
                stat.spikes.unshift(stat.spike);
                if (stat.spikes.length > SPIKE_KEEP) stat.spikes.length = SPIKE_KEEP;
            }
            if (out !== str) stat.changed += weight;
            if (!matched) {
                // a template: unchanged means no match unless a match can be its own replacement
                if (fastRun) matched = out !== str || (fast.identity && native.test(incIn));
                // a string replacer (not SillyTavern's): test short inputs, assume a match on long ones
                else if (fn === replacer) matched = out !== str || incIn.length > 2000 || native.test(incIn);
            }
            if (matched) stat.matched += weight;
            // lint "missing g" (short inputs only)
            if (matched && !native.global && str.length <= CONFLICT_TEST_MAX) {
                const m = native.exec(str);
                if (m && m.index + m[0].length < str.length && native.test(str.slice(m.index + m[0].length))) stat.moreMatches++;
            }
        }
        if (matched || out !== str) stat.seenMatched++; // on unsampled runs too: ∅ is a verdict, not an estimate
        // a volatile script that matched: ⑨ and ⑤ store nothing for this pass
        if (displayPass && meta.volatile && !passVolatile) {
            native.lastIndex = 0;
            if (out !== str || native.test(incIn)) passVolatile = true;
            native.lastIndex = 0;
        }
        this.lastIndex = native.lastIndex = lastIndex; // leave this regex as a native replace would

        if (bucket && !macroSeen) {
            // an unchanged output is a marker, so it is not counted twice
            const same = out === str;
            const size = (memoKey.length + (same ? 0 : out.length)) * 2;
            if (size <= cfg.memoMaxMB * MB) { // a larger entry would flush the memo
                const entry = { bucket, prefix: memoPrefix, key: memoKey, out: same ? null : out, same, size };
                bucket.set(memoKey, entry);
                memoLru.add(entry);
                memoBytes += size;
                trimMemo();
            }
        }
        return done(stat, str, out);
    }
}

/** Records a call's input and output for the order-conflict check (see prevStat) and returns the output. */
function done(stat, str, out) {
    statsDirty = true;
    prevStat = stat;
    prevIn = str;
    prevOut = out;
    return out;
}
const unchanged = (stat, str) => done(stat, str, str);

const CONFLICT_TEST_MAX = 4000; // inputs up to this long are run to confirm a match

/**
 * The later script was skipped on the earlier one's output although its needle was in the earlier one's input: the
 * earlier script removed it (confirmed by a run on short inputs).
 */
function noteConflict(earlier, later, input, test, native, keep) {
    const seen = [litIn, litSeen]; // the current input stays the ② fast path
    const had = test(input, keep);
    [litIn, litSeen] = seen;
    if (!had) return;
    let confirmed = null;
    if (input.length <= CONFLICT_TEST_MAX) {
        native.lastIndex = 0;
        confirmed = native.test(input);
        native.lastIndex = 0;
        if (!confirmed) return;
    }
    const key = earlier.src + '\0' + later.src;
    let c = conflicts.get(key);
    if (!c) conflicts.set(key, c = { earlier, later, count: 0, confirmed: false, sample: input.slice(0, SPIKE_HEAD) });
    c.count++;
    if (confirmed) c.confirmed = true;
}

// ---- Patch RegexProvider.instance ----

/** @type {Map<string, PerfRegExp>} */
const wrapped = new Map();
let patched = false;
let patchedGet = null; // to notice a later replacement
let wrapperWarning = ''; // shown once in the panel and the console

function patchProvider() {
    const inst = RegexProvider?.instance;
    if (!inst || typeof inst.get !== 'function') {
        console.warn('[RegexPerf] RegexProvider.instance not found — this ST version is not supported.');
        return;
    }
    // SillyTavern's get() is the class method; an own property on the instance is another extension's wrapper.
    if (inst.get !== Object.getPrototypeOf(inst)?.get) warnWrapper(t`Another extension had already replaced the regex engine's get() when Regex Perf Kit loaded: its runs may be measured twice or not at all.`);
    const origGet = inst.get.bind(inst);
    const origClear = typeof inst.clear === 'function' ? inst.clear.bind(inst) : null; // older providers lack it

    inst.get = patchedGet = function (regexString) {
        const base = origGet(regexString);
        if (!base) return null;
        const { map, dynamic, version } = ensureInfo();
        let w = wrapped.get(regexString);
        if (!w) {
            try {
                w = new PerfRegExp(base.source, base.flags);
            } catch (e) {
                console.warn('[RegexPerf] could not wrap regex, falling back', e);
                return base;
            }
            setCapped(wrapped, regexString, w, 1000);
        }
        // re-linked whenever the script info changes, so an edit takes effect without RegexProvider.clear()
        if (w._version !== version) {
            const key = keyOf(base);
            let info = map.get(key);
            // a dynamic pattern compiled with other macro values than its script info: the literal prefilter is this
            // pattern's own, and ⑥ and ④'s incremental runs, analysed on the other, stay off
            const form = !info;
            if (form) info = resolveDynamic(regexString, dynamic);
            const stat = getStat(info?.statKey ?? key, base);
            if (info) stat.name = info.name;
            if (info?.raw) stat.src = info.raw;
            stat.ids = info?.ids ?? [];
            for (const id of stat.ids) statById.set(id, stat);
            stat.needle = form ? needleOf(base) : info.needle;
            stat.redos = form ? redosOf(base) : info.redos;
            const replaceSig = info?.replaceSig ?? null;
            if (stat.tripped && stat.replaceSig !== undefined && stat.replaceSig !== replaceSig) untrip(stat); // ⑧ an edit of this script resets it
            stat.replaceSig = replaceSig;
            w._meta = {
                stat,
                re: base,
                markdownOnly: !!info?.markdownOnly,
                test: stat.needle.test,
                memoPrefix: info?.pure || info?.semiPure ? key + '\u0001' + info.replaceSig + (info.pure ? '\u0001' : '\u0002') : null,
                memoStatic: info?.semiPure ? (info.semiPureTrims ? 2 : 1) : 0, // 2: a trim string holds a static macro
                fast: form ? null : info.fast,
                fastStatic: form ? null : info.fastStatic,
                assembles: !!info?.assembles,
                volatile: info ? info.volatile : true,
                dynamic: !info || info.dynamicVolatile, // the find pattern itself can change between renders
                lineLocal: !form && info.lineLocal && !incOff.has(key),
                inc: new Map(), // ④ stream key -> {in, out}: the last prefix this script formatted in that stream
                incVerify: w._meta?.incVerify ?? INC_VERIFY_RUNS,
            };
            w._version = version;
        }
        w.lastIndex = 0;
        return w;
    };

    inst.clear = function () {
        origClear?.();
        wrapped.clear();
        markDirty();
    };

    patched = true;
}

function warnWrapper(text) {
    if (wrapperWarning) return;
    wrapperWarning = text;
    console.warn('[RegexPerf] ' + text);
}
/** If another extension replaced get() after us, our features no longer apply. */
function checkWrapper() {
    if (patched && RegexProvider.instance?.get !== patchedGet) warnWrapper(t`Another extension replaced the regex engine's get() after Regex Perf Kit: the features may no longer apply. Check the extension load order.`);
}

// ---- Display pipeline timing (regex / markdown / sanitize) and what a user feels ----

// messageFormatting() runs, per message: BEFORE_REGEX hooks → regex scripts → AFTER_REGEX hooks → markdown fix-ups,
// quotes, showdown → AFTER_MARKDOWN hooks → name strip → DOMPurify. Our hooks sit at the stage boundaries (last of
// BEFORE_REGEX, first of AFTER_REGEX and AFTER_MARKDOWN) and DOMPurify.sanitize() is wrapped for the MESSAGE_SANITIZE
// config only messageFormatting() uses, so a display pass is timed in four parts.
const pipe = {
    passes: 0, // display passes timed end to end
    hookMs: 0, // our BEFORE_REGEX hook: the ⑨/⑤ key and lookups (the extension's own cost)
    regexMs: 0, // → AFTER_REGEX: the regex scripts
    markdownMs: 0, // → AFTER_MARKDOWN: markdown fix-ups, quotes and showdown
    sanitizeMs: 0, // DOMPurify.sanitize()
    htmlHits: 0, // ⑨ passes served from the HTML cache
    htmlHitMs: 0, // what those passes still cost (placeholder markdown + sanitize)
    htmlStores: 0,
    paraPasses: 0, // ④ paragraph cache: streaming renders split at a paragraph boundary
    paraHits: 0, // of those, renders that reused the finished paragraphs' HTML
    paraFallbacks: 0, // messages whose split render differed from a whole one
    loadMs: 0, // how long opening the chat rendered (the burst that ended at the last CHAT_CHANGED)
};
let passT0 = null; // at our BEFORE_REGEX hook (null outside a timed pass)
let passTk = null; // at the end of it
let passT1 = null; // at our AFTER_REGEX hook
let passT2 = null; // at our AFTER_MARKDOWN hook
let passHtmlHit = false;
const resetPipe = () => { for (const k of Object.keys(pipe)) if (k !== 'loadMs') pipe[k] = 0; }; // loadMs belongs to the chat
const pipeTotal = () => pipe.hookMs + pipe.regexMs + pipe.markdownMs + pipe.sanitizeMs;
/** Regex time as a share of the timed display renders (0..1), null before anything was timed. */
const regexShare = () => {
    const total = pipeTotal();
    return total > 0 ? pipe.regexMs / total : null;
};
/** Average cost of a full (uncached) display pass, for the ⑨ savings estimate. */
const avgPassMs = () => {
    const full = pipe.passes - pipe.htmlHits;
    return full > 0 ? pipeTotal() / full : 0;
};

let sanitizeWrapped = false;
/** Wraps DOMPurify.sanitize() to close the timing of a display pass; the output is untouched. */
function wrapSanitize() {
    const purify = globalThis.SillyTavern?.libs?.DOMPurify ?? globalThis.DOMPurify;
    if (!purify || typeof purify.sanitize !== 'function' || sanitizeWrapped) return;
    const orig = purify.sanitize;
    purify.sanitize = function (dirty, config) {
        if (passT2 === null || !config?.MESSAGE_SANITIZE) return orig.apply(this, arguments);
        const t2 = passT2;
        passT2 = null; // one sanitize per pass; a second call is another caller's
        const t3 = performance.now();
        const view = paraSplit; // ④ paragraph cache: the finished paragraphs are sanitized once
        paraSplit = null;
        try {
            if (view !== null && paraHeadPre !== null && dirty.startsWith(paraHeadPre) && dirty.charCodeAt(paraHeadPre.length) === 10) return paragraphSanitize(this, orig, view, dirty, config);
            return orig.apply(this, arguments);
        } finally {
            const t4 = performance.now();
            const tk = passTk ?? passT0;
            const t1 = passT1 ?? t2;
            pipe.passes++;
            notePass(passT0, t4);
            if (passHtmlHit) { // stage times are of full passes only
                pipe.htmlHits++;
                pipe.htmlHitMs += t4 - passT0;
            } else {
                pipe.hookMs += tk - passT0;
                pipe.regexMs += t1 - tk;
                pipe.markdownMs += t2 - t1;
                pipe.sanitizeMs += t4 - t3;
                if ((pipe.passes - pipe.htmlHits) % ADAPTIVE_EVERY_PASSES === 0) adaptiveLight = regexShare() < ADAPTIVE_SHARE;
            }
            statsDirty = true;
        }
    };
    sanitizeWrapped = true;
}
// ① adaptive: once the regex stage is under ADAPTIVE_SHARE of the timed renders (checked every ADAPTIVE_EVERY_PASSES
// full passes), 1 run in LIGHT_EVERY is timed.
const ADAPTIVE_SHARE = 0.02;
const ADAPTIVE_EVERY_PASSES = 64;
const LIGHT_EVERY = 64;
let adaptiveLight = false;

const MAKE_HTML_WRAPPED = Symbol('rpk.makeHtml');
let showdownWrapped = false; // the converter in use is wrapped (in the JSON report)
/**
 * Wraps makeHtml() of the converter messageFormatting() is about to call. showdown sets makeHtml as an own property of
 * each Converter and SillyTavern remakes the converter in reloadMarkdownProcessor(), so this runs before every markdown
 * stage. On a ⑨ hit the placeholder is returned unconverted (showdown's cost is mostly per call, so a hit would
 * otherwise still pay most of the markdown stage); in a ④ compromise pass the paragraph cache converts the paragraph
 * being written only. Everything else passes through.
 */
function ensureShowdownWrapped() {
    const conv = st.converter;
    if (conv && typeof conv.makeHtml === 'function' && !conv.makeHtml[MAKE_HTML_WRAPPED]) {
        const orig = conv.makeHtml;
        const makeHtml = function (text) {
            if (htmlHit !== null && text === HTML_PLACEHOLDER) return text;
            if (streamKey !== null && paraSplit === null && passT1 !== null && passT2 === null && cfg.streamingParagraphCache && sanitizeWrapped) {
                const out = paragraphPass(this, orig, text);
                if (out !== null) return out;
            }
            return orig.apply(this, arguments);
        };
        makeHtml[MAKE_HTML_WRAPPED] = true;
        conv.makeHtml = makeHtml;
    }
    showdownWrapped = !!conv?.makeHtml?.[MAKE_HTML_WRAPPED];
}

// Stutter: frames painted late during a generation, and long tasks (PerformanceObserver, Chromium). The frame sampler
// runs only during a generation, so idle pages pay nothing.
const FRAME_BUDGET_MS = 1000 / 60;
const FEEL_ZERO = { frames: 0, dropped: 0, frozen: 0, longTasks: 0, longTaskMs: 0, longTasks100: 0, streamLongTasks: 0, longTaskPipeMs: 0, lastLongTask: null };
const feel = { ...FEEL_ZERO };
const resetFeel = () => { Object.assign(feel, FEEL_ZERO); };
// Recent display passes as [start, end] pairs, so a long task can be split into render pipeline time and the rest
// (SillyTavern's DOM work, layout, other extensions).
const recentPasses = [];
const RECENT_PASSES_MS = 10000;
const RECENT_PASSES_MAX = 1024;
// The pass burst that ends at CHAT_CHANGED is the chat's first render, ⑨/⑤ hits included.
let passBurstStart = 0;
let passLastEnd = -Infinity;
function notePass(start, end) {
    if (start - passLastEnd > BURST_GAP_MS) passBurstStart = start;
    passLastEnd = end;
    recentPasses.push(start, end);
    if (recentPasses.length > RECENT_PASSES_MAX || end - recentPasses[0] > RECENT_PASSES_MS) {
        let i = 0;
        while (i < recentPasses.length && end - recentPasses[i + 1] > RECENT_PASSES_MS) i += 2;
        if (recentPasses.length - i > RECENT_PASSES_MAX) i = recentPasses.length - RECENT_PASSES_MAX;
        recentPasses.splice(0, i);
    }
}
/** Display-pass time that fell inside [start, end]. */
function passMsWithin(start, end) {
    let ms = 0;
    for (let i = 0; i < recentPasses.length; i += 2) {
        const s = recentPasses[i], e = recentPasses[i + 1];
        if (s >= start && e <= end) ms += e - s;
    }
    return ms;
}
let frameRaf = 0;
let frameLast = 0;
function frameTick() {
    if (!generating || !cfg.frameStats) {
        frameRaf = 0;
        return;
    }
    const now = performance.now(); // when the callbacks ran, not the frame's scheduled start: what was felt
    if (!underway()) {
        frameLast = 0; // not before SillyTavern marks the page
    } else {
        if (frameLast) {
            const gap = now - frameLast;
            feel.frames++;
            if (gap > FRAME_BUDGET_MS * 2) feel.dropped++;
            if (gap > 100) feel.frozen++;
        }
        frameLast = now;
    }
    frameRaf = requestAnimationFrame(frameTick);
}
function startFrames() {
    if (frameRaf || !cfg.frameStats || typeof requestAnimationFrame !== 'function') return;
    frameLast = 0;
    frameRaf = requestAnimationFrame(frameTick);
}
// "Measure on this chat" renders in chunks, each a long task, whose entries arrive after measureChat() restored the
// counters: tasks overlapping a measurement are recognized by their times and left out.
const measureSpans = []; // [start, end] of recent measurements, newest last
const MEASURE_SPANS_KEPT = 8;
const inMeasurement = (start, end) => measureSpans.some(([a, b]) => start <= b && end >= a);
let longTaskObserver = null;
function observeLongTasks() {
    if (longTaskObserver || typeof PerformanceObserver !== 'function') return;
    try {
        if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
        longTaskObserver = new PerformanceObserver((list) => {
            if (!cfg.frameStats) return;
            for (const e of list.getEntries()) {
                if (inMeasurement(e.startTime, e.startTime + e.duration)) continue;
                feel.longTasks++;
                feel.longTaskMs += e.duration;
                if (e.duration >= 100) feel.longTasks100++;
                if (generating) feel.streamLongTasks++;
                const pipeMs = passMsWithin(e.startTime, e.startTime + e.duration);
                feel.longTaskPipeMs += pipeMs;
                feel.lastLongTask = { ms: e.duration, pipeMs, streaming: generating };
            }
            statsDirty = true;
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch { longTaskObserver = null; }
}

// ⑨ HTML cache: key (see keyFor) -> the HTML at our AFTER_MARKDOWN hook. A hit returns a placeholder at BEFORE_REGEX,
// so regex is bypassed and markdown runs on a few characters; the stored HTML takes over at AFTER_MARKDOWN and
// DOMPurify still runs on it. Least recently used entries go first, by count and by estimated size.
const HTML_PLACEHOLDER = 'rpk';
class Lru {
    constructor() {
        this.map = new Map();
        this.bytes = 0;
    }
    get(key) {
        const e = this.map.get(key);
        if (e) { // re-insert: a Map iterates in insertion order
            this.map.delete(key);
            this.map.set(key, e);
        }
        return e;
    }
    set(key, value, size) {
        const old = this.map.get(key);
        if (old) {
            this.map.delete(key);
            this.bytes -= old.size;
        }
        this.map.set(key, { value, size });
        this.bytes += size;
    }
    trim(maxEntries, maxBytes) {
        for (const [key, e] of this.map) {
            if (this.map.size <= maxEntries && this.bytes <= maxBytes) break;
            this.map.delete(key);
            this.bytes -= e.size;
        }
    }
    clear() {
        this.map.clear();
        this.bytes = 0;
    }
}
const htmlMemo = new Lru();
let htmlHit = null; // the HTML to return at AFTER_MARKDOWN for this pass
/** The power_user settings that change the markdown stage, for the ⑨ key. */
function pipeVersion(pu) {
    if (!pu) return '';
    const regexOff = extensionSettings.disabledExtensions?.includes?.('regex') ? 1 : 0; // no scripts run then
    return fnv1a([pu.auto_fix_generated_markdown, pu.encode_tags, pu.reasoning?.prefix, pu.reasoning?.suffix, pu.markdown_escape_strings, pu.allow_name2_display, regexOff].map(String).join('\u0000'));
}

// ④ paragraph cache (compromise mode): while a reply streams, its finished paragraphs' HTML is kept, so showdown and
// DOMPurify run on the paragraph being written (showdown joins blocks with a line break, so the parts equal the whole).
// A message's first split renders are compared with whole ones; a difference sends it back to whole renders.
const paraViews = new Map(); // stream key -> {messageId, sep, tailStart, head, html, pre, san, checks, sanChecks, off}
const PARA_MARK = '\uE000'; // between the two HTML parts, taken out by our AFTER_MARKDOWN hook
const PARA_VERIFY = 3;
let streamKey = null; // the ④ compromise key of the message this pass formats
let paraSplit = null; // the paragraph-cache entry this pass split its markdown with, until the sanitizer
let paraHeadPre = null; // the finished paragraphs' HTML after our AFTER_MARKDOWN hook: where the sanitizer splits
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr', 'param']);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d+[.)])(?:\s|$)/;
const INDENTED = /^[ \t]/; // continues the block above (a list item's paragraph, indented code)
const TAG_START = /<(\/?)([a-zA-Z][\w-]*)/y;
const REF_DEF = /^ {0,3}\[[^\]]+\]:\s/; // resolves across paragraphs: such a text is never split

/**
 * Raw HTML on one line (outside fences and inline code), carried to the next: html.depth counts the tags left open,
 * html.comment is an open comment, html.tag a tag whose attributes go on to the next line. A paragraph boundary needs
 * all of them closed.
 */
function scanHtml(line, html) {
    if (html.tag) html.tag.fresh = false;
    for (let i = 0; i < line.length;) {
        if (html.comment) {
            const end = line.indexOf('-->', i);
            if (end < 0) return;
            html.comment = false;
            i = end + 3;
        } else if (html.tag) {
            const end = line.indexOf('>', i);
            if (end < 0) {
                // it goes on to the next line if it did on this one, or its name ends the line, or an attribute value
                // follows (<div class="x"): "a<b then" is text
                if (html.tag.fresh && line.slice(i).trim() && !line.includes('=', i)) html.tag = null;
                return;
            }
            if (line[end - 1] !== '/' && !VOID_TAGS.has(html.tag.name)) html.depth = Math.max(0, html.depth + (html.tag.close ? -1 : 1));
            html.tag = null;
            i = end + 1;
        } else {
            const lt = line.indexOf('<', i);
            if (lt < 0) return;
            if (line.startsWith('<!--', lt)) {
                html.comment = true;
                i = lt + 4;
                continue;
            }
            TAG_START.lastIndex = lt;
            const m = TAG_START.exec(line);
            if (m) html.tag = { close: !!m[1], name: m[2].toLowerCase(), fresh: true };
            i = m ? TAG_START.lastIndex : lt + 1;
        }
    }
}

/**
 * The last paragraph boundary of a markdown text, scanning from `from` (a tail known to follow a boundary):
 * {headEnd, tailStart}, null when the scanned part has none, false when the text must not be split.
 */
export function paragraphCut(text, from = 0) {
    let inFence = null; // the fence marker that has to close
    let ticks = 0; // backticks outside fences: odd means an inline code span is open
    const html = { depth: 0, comment: false, tag: null }; // raw HTML outside fences and inline code, see scanHtml()
    let prev = 'blank'; // the last non-blank line: para (or heading) | list | quote | table | indent | fence
    let pending = null; // headEnd of a blank line after a para or closed fence, until the next non-blank line
    let cut = null;
    const n = text.length;
    for (let pos = from; pos < n;) {
        let nl = text.indexOf('\n', pos);
        if (nl < 0) nl = n;
        const line = text.slice(pos, nl);
        if (inFence !== null) {
            const m = FENCE.exec(line);
            if (m && m[1][0] === inFence[0] && m[1].length >= inFence.length && line.slice(m[0].length).trim() === '') inFence = null;
            prev = 'fence';
        } else if (line.trim() === '') {
            if (pending === null && (prev === 'para' || prev === 'fence') && ticks % 2 === 0 && !html.depth && !html.comment && !html.tag) pending = pos - 1;
        } else {
            if (pending !== null) {
                if (!INDENTED.test(line) && !/^ {0,3}(?:=+|-+)\s*$/.test(line)) cut = { headEnd: pending, tailStart: pos }; // not a continuation or a setext underline
                pending = null;
            }
            if (REF_DEF.test(line)) return false;
            const fence = FENCE.exec(line);
            if (fence) {
                inFence = fence[1];
                prev = 'fence';
            } else {
                prev = INDENTED.test(line) ? 'indent' : LIST_ITEM.test(line) ? 'list' : line.charCodeAt(line.search(/\S/)) === 62 ? 'quote' : line.includes('|') ? 'table' : 'para';
                for (let i = line.indexOf('`'); i >= 0; i = line.indexOf('`', i + 1)) ticks++;
                scanHtml(line.replace(/`[^`]*`/g, ''), html);
            }
        }
        pos = nl + 1;
    }
    return cut; // a trailing blank line is no cut (the tail would be empty)
}

/** The paragraph-cache split of a compromise pass's makeHtml(): the HTML to return, or null to convert the whole text. */
function paragraphPass(conv, orig, text) {
    let view = paraViews.get(streamKey);
    if (view?.off || text.includes(PARA_MARK)) return null;
    let cut;
    if (view && text.startsWith(view.sep)) { // the known boundary stands: scan after it only
        cut = paragraphCut(text, view.tailStart);
        if (cut === null) cut = { headEnd: view.head.length, tailStart: view.tailStart };
    } else {
        cut = paragraphCut(text);
    }
    if (!cut || cut.tailStart >= text.length) return null;
    if (!view) {
        view = { messageId: passMessageId, sep: '', tailStart: 0, head: null, html: null, pre: null, san: null, checks: PARA_VERIFY, sanChecks: PARA_VERIFY, off: false };
        paraViews.set(streamKey, view);
    }
    const head = text.slice(0, cut.headEnd);
    const tail = text.slice(cut.tailStart);
    const hit = view.head === head;
    if (!hit) {
        view.head = head;
        view.sep = text.slice(0, cut.tailStart);
        view.tailStart = cut.tailStart;
        view.html = orig.call(conv, head);
        view.pre = view.san = null;
    }
    const tailHtml = orig.call(conv, tail);
    if (view.checks > 0) {
        view.checks--;
        const whole = orig.call(conv, text);
        const split = view.html + '\n' + tailHtml;
        if (whole !== split) return paraOff(view, 'markdown', whole, split);
    }
    pipe.paraPasses++;
    if (hit) pipe.paraHits++;
    paraSplit = view;
    return view.html + PARA_MARK + '\n' + tailHtml;
}

/** The sanitizer side of a split pass: the finished paragraphs once, the rest on every render. */
function paragraphSanitize(purify, orig, view, dirty, config) {
    const headPre = paraHeadPre;
    const tailPre = dirty.slice(headPre.length + 1);
    if (view.pre !== headPre) {
        view.pre = headPre;
        view.san = orig.call(purify, headPre, config);
    }
    const out = view.san + '\n' + orig.call(purify, tailPre, config);
    if (view.sanChecks > 0) {
        view.sanChecks--;
        const whole = orig.call(purify, dirty, config);
        if (whole !== out) return paraOff(view, 'sanitizing', whole, out);
    }
    return out;
}

/** A split render differed from a whole one: whole renders for this message from now on. */
function paraOff(view, stage, whole, got) {
    view.off = true;
    pipe.paraFallbacks++;
    console.warn(`[RegexPerf] ④ paragraph cache: the split ${stage} differed from the whole one for message #${view.messageId}: whole renders for this message`, { expected: whole.slice(-200), got: got.slice(-200) });
    return whole;
}

// ---- MessageFormatter hooks: ⑤ persisted display cache, ⑨ HTML cache, ④ compromise mode ----

let persistAvailable = false; // the hooks exist (recent SillyTavern)
let htmlStageAvailable = false; // AFTER_MARKDOWN exists too (⑨ and the pipeline timing)
let pending = null; // {id, key, input, html}: awaiting its result (id: ⑤'s row, null when nothing is stored)
const streamViews = new Map(); // ④ compromise: "<messageId><m|r>" -> {at, prefix, out}
/** ④'s per-generation state (both hold the streamed message's text). */
const clearStreamCaches = () => { streamViews.clear(); paraViews.clear(); };
let streamView = null; // the view this pass formats
let streamTail = null; // raw text this pass appends after the regex stage

// A message's depth as messageFormatting() counts it (non-system messages after it), from one table per synchronous
// render burst (dropped by a microtask).
let depthTable = null;
function depthAt(chat, i) {
    if (depthTable?.chat !== chat || depthTable.len !== chat.length) {
        const n = chat.length;
        const d = new Int32Array(n);
        for (let k = n - 1, after = 0; k >= 0; k--) {
            d[k] = after;
            if (!chat[k]?.is_system) after++;
        }
        depthTable = { chat, len: n, d };
        queueMicrotask(() => { depthTable = null; });
    }
    return depthTable.d[i];
}

/** Clears the state the hooks share for one formatting pass, timing included. */
function resetPass() {
    resetPassKeepTiming();
    passT0 = passTk = passT1 = passT2 = null;
    passHtmlHit = false;
    paraSplit = paraHeadPre = null;
}
/** Cleared at AFTER_MARKDOWN; the pass timing stays for the sanitize wrapper. */
function resetPassKeepTiming() {
    bypass = null;
    streamApply = displayPass = passVolatile = false;
    pending = streamView = streamTail = streamKey = passChName = passStatic = passStaticTrim = passMessageId = htmlHit = null;
}

/**
 * ④ compromise mode for the streamed message: display scripts format the completed lines at most every
 * streamingThrottleMs; in between, the last formatted lines are reused and the rest is shown raw.
 */
function streamPass(mes, c) {
    const key = c.messageId + (c.isReasoning ? 'r' : 'm');
    streamKey = key;
    const view = streamViews.get(key);
    const now = performance.now();
    // the last line is still being written (and any ``` / ~~~ fence SillyTavern appends to balance it)
    const cut = mes.replace(/(?:\n(?:```|~~~))+$/, '').lastIndexOf('\n') + 1;
    if (view?.out != null && mes.startsWith(view.prefix) && (cut <= view.prefix.length || now - view.at < cfg.streamingThrottleMs)) {
        streamTail = mes.slice(view.prefix.length);
        return view.out;
    }
    streamView = { at: now, prefix: mes.slice(0, cut), out: null };
    streamViews.set(key, streamView);
    streamTail = mes.slice(cut);
    streamApply = true;
    return streamView.prefix;
}

/**
 * The ⑤/⑨ key of a message: a 64-bit hash of its text and its length, the display scripts, the names (ch_name: the
 * author), which depth-limited scripts apply, the static macro values, the placement and the markdown settings.
 */
function keyFor(mes, c, msg, context) {
    const { name1, name2, chat } = context;
    const names = fnv1a([c.ch_name ?? c.characterName, name1, name2].join('\u0000'));
    const { displayVersion, depthRules } = ensureInfo();
    let depths = '';
    if (depthRules.length) {
        const depth = depthAt(chat, c.messageId);
        depths = msg.is_system ? ':*' : ':' + depthRules.map(([min, max]) => (depth < min || depth > max ? 0 : 1)).join('');
    }
    const statics = staticKeyFor(2, context);
    // the placement decides which scripts run: USER_INPUT, SLASH_COMMAND (narrator) or AI_OUTPUT
    const placement = c.isReasoning ? ':r' : c.isUser ? ':u' : msg.extra?.type === 'narrator' ? ':n' : '';
    // before the |, ⑤'s row id: the text, its placement and speaker tell apart the messages of a chat; what follows
    // (scripts, names, depth, settings) replaces a message's row when it changes
    return hash64(mes) + ':' + mes.length + placement + ':' + fnv1a(String(c.ch_name ?? c.characterName)) + '|' + displayVersion + ':' + names + depths + ':' + statics + ':' + pipeVersion(context.powerUserSettings);
}

/** A ⑨ hit (or ⑤'s stored HTML): the regex stage is bypassed and the stored HTML takes over at AFTER_MARKDOWN. */
function serveHtml(html, source = 'html') {
    bypass = source;
    htmlHit = html;
    passHtmlHit = true;
    return HTML_PLACEHOLDER;
}

function installPersistHooks() {
    const mf = ctx().messageFormatter;
    if (!mf || typeof mf.addHook !== 'function' || !mf.stage) return;
    persistAvailable = true;
    htmlStageAvailable = !!mf.stage.AFTER_MARKDOWN;

    // Before regex: ④ compromise mode for the streamed message; otherwise serve a stored ⑨ or ⑤ result.
    mf.addHook((mes, c) => {
        resetPass();
        displayPass = true;
        queueMicrotask(resetPass); // should messageFormatting() throw between the hooks, the next task starts clean
        if (c.messageId < 0 || c.isSystem) return mes;
        if (htmlStageAvailable) passT0 = performance.now();
        const out = beforeRegex(mes, c);
        if (passT0 !== null) passTk = performance.now();
        return out;
    }, { stage: mf.stage.BEFORE_REGEX, order: mf.order?.LATEST ?? 100 });

    function beforeRegex(mes, c) {
        passChName = c.ch_name ?? c.characterName ?? '';
        passMessageId = c.messageId;
        const wantHtml = cfg.htmlMemo && htmlStageAvailable;
        const wantPersist = cfg.persist && !c.isReasoning;
        const sp = liveStream();
        if (!sp && c.messageId === streamSkippedMsg) streamSkippedMsg = null; // the streamed message's final render
        // the streamed message changes every tick: ④'s compromise mode or nothing; other messages are served as usual
        if (sp && sp.messageId === c.messageId) return cfg.streamingSkip && cfg.streamingThrottle ? streamPass(mes, c) : mes;
        if (!wantHtml && !wantPersist) return mes;
        const context = ctx(); // one snapshot for the whole hook
        const msg = context.chat?.[c.messageId];
        if (!msg) return mes;
        // SillyTavern prints a chat before CHAT_CHANGED: the chat this pass belongs to is read here
        if (wantPersist) loadPersisted(context);
        const key = keyFor(mes, c, msg, context);
        const id = wantPersist && persistChatKey !== null ? persistIdOf(key) : null;
        if (wantHtml) {
            const hit = htmlMemo.get(key);
            if (hit) {
                if (id !== null && !measurePass && persistMem.get(id)?.k !== key && hit.value.length <= cfg.persistMaxLen) storePersisted(id, { k: key, h: hit.value }); // ⑤ learns it too
                return serveHtml(hit.value);
            }
        }
        if (wantPersist) {
            // this chat's rows, else what an older version wrote into the chat file (read, never written)
            const e = (id !== null ? persistMem.get(id) : undefined) ?? msg.extra?.[EXTRA_KEY];
            if (e && e.k === key) {
                if (e.h != null) { // stored HTML needs ⑨'s stage; without it, recompute
                    if (wantHtml) {
                        persistStats.hits++;
                        return serveHtml(String(e.h), 'persist');
                    }
                } else {
                    bypass = 'persist';
                    persistStats.hits++;
                    return e.same ? mes : String(e.v ?? mes);
                }
            }
        }
        pending = measurePass ? null : { id, key, input: mes, html: wantHtml };
        return mes;
    }

    // After regex: append ④'s raw tail, or store the computed text for ⑤ (HTML is stored a stage later).
    mf.addHook((mes) => {
        if (passT0 !== null) passT1 = performance.now();
        if (htmlStageAvailable) ensureShowdownWrapped(); // the markdown stage comes next
        const tail = streamTail;
        const view = streamView;
        const p = pending; // null after a hit
        if (htmlHit !== null) return mes; // the placeholder passes through
        if (tail !== null) {
            if (view) view.out = mes;
            if (!htmlStageAvailable) resetPass();
            return mes + tail;
        }
        if (p && !p.html) {
            pending = null;
            if (p.id !== null && !passVolatile && mes.length <= cfg.persistMaxLen) storePersisted(p.id, mes === p.input ? { k: p.key, same: 1 } : { k: p.key, v: mes });
        }
        if (!htmlStageAvailable) resetPass();
        return mes;
    }, { stage: mf.stage.AFTER_REGEX, order: mf.order?.EARLIEST ?? 0 });

    if (!htmlStageAvailable) return;
    // After markdown: serve the ⑨ hit, or store the HTML just made (⑨ in memory, ⑤ in IndexedDB).
    mf.addHook((mes) => {
        const now = performance.now();
        if (paraSplit !== null) { // the paragraph marker comes out before other hooks see the HTML
            const i = mes.indexOf(PARA_MARK);
            if (i >= 0) {
                paraHeadPre = mes.slice(0, i);
                mes = paraHeadPre + mes.slice(i + 1);
            }
        }
        const hit = htmlHit;
        const p = pending;
        const volatile = passVolatile;
        resetPassKeepTiming();
        if (passT0 !== null) passT2 = now; // closed by the sanitize wrapper
        if (hit !== null) return hit;
        if (p?.html && !volatile) {
            if (cfg.htmlMemo) {
                const size = (p.key.length + mes.length) * 2;
                const maxBytes = cfg.htmlMemoMaxMB * MB;
                if (size <= maxBytes) {
                    htmlMemo.set(p.key, mes, size);
                    htmlMemo.trim(cfg.htmlMemoMaxEntries, maxBytes);
                    pipe.htmlStores++;
                }
            }
            if (p.id !== null && cfg.persist && mes.length <= cfg.persistMaxLen) storePersisted(p.id, { k: p.key, h: mes });
        }
        return mes;
    }, { stage: mf.stage.AFTER_MARKDOWN, order: mf.order?.EARLIEST ?? 0 });
    wrapSanitize();
    ensureShowdownWrapped();
}

/** "Clear saved results (this chat)": this chat's rows in IndexedDB, and what an older version wrote into the chat file. */
async function clearPersistedCache() {
    const { chat, saveChat } = ctx();
    let removed = 0;
    for (const m of chat ?? []) {
        if (m?.extra && Object.hasOwn(m.extra, EXTRA_KEY)) {
            delete m.extra[EXTRA_KEY];
            removed++;
        }
    }
    if (removed && typeof saveChat === 'function') {
        try { await saveChat(); } catch (e) { console.warn('[RegexPerf] saveChat failed', e); }
    }
    return removed + await clearPersistedDb();
}

// ---- Report ----

const INEFFECTIVE_RUNS = 20; // runs without a match that make a script a candidate to disable

/** Milliseconds for display: "0", else 2 / 1 / 0 decimals as the value grows. */
const fmtMs = (x) => (x === 0 ? '0' : x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2));
const avgMs = (r) => (r.calls ? r.totalMs / r.calls : 0);
/** The prefilter's terms as text: "a" & ("b" | "c"). */
const fmtNeedles = (r) => {
    const terms = r.needle?.terms;
    if (!terms?.length) return undefined;
    const q = (set) => set.map(s => JSON.stringify(s)).join(' | ');
    return terms.map(set => (set.length > 1 && terms.length > 1 ? `(${q(set)})` : q(set))).join(' & ');
};
// each call ②, ③ or ④ avoided would have cost the script's average run
const avoided = (r) => r.skipped + r.hits + r.streamSkipped;
const savedMs = (r) => avoided(r) * avgMs(r);
const ineffective = (r) => r.calls >= INEFFECTIVE_RUNS && !r.seenMatched;
/** Conflicts in which r is the later script. */
const conflictsOf = (r) => [...conflicts.values()].filter(c => c.later === r);
const conflictText = (c) => (c.confirmed
    ? t`"${c.earlier.name}" runs first and removes what "${c.later.name}" would have matched: ${c.count} times`
    : t`"${c.earlier.name}" runs first and removes the literal "${c.later.name}" looks for: ${c.count} times (match not verified on long inputs)`);
const spikeText = (sp) => t`Last spike: ${fmtMs(sp.ms)} ms on ${sp.len} characters, starting ${JSON.stringify(sp.head)}`;
/** " (#12)": the message a spike happened on, when known. */
const spikeMes = (sp) => (sp.messageId != null ? ` (#${sp.messageId})` : '');
const fastText = (n) => t`⑥ fast path: ${n} runs without SillyTavern's callback`;
/** Rows that never ran nor were skipped are left out of the table. */
const active = (r) => r.calls + avoided(r) + r.bypass > 0;
const badge = (text, title, cls = '', attrs = '') => ` <span class="rpk-badge${cls ? ' ' + cls : ''}"${attrs} title="${esc(title)}">${text}</span>`;
/** The older spikes, for the ⚡ tooltip, and where a click goes. */
const spikeHistory = (r) => r.spikes.slice(1, 5).map(sp => '\n' + t`${fmtMs(sp.ms)} ms on ${sp.len} characters` + spikeMes(sp)).join('')
    + (r.spike?.messageId != null ? '\n' + t`Click to scroll to message #${r.spike.messageId}` : '');
/** A row's warnings: words for the report, or badges for the panel. */
function warnings(r, badges = false) {
    const conflicted = conflictsOf(r);
    return [
        r.redos.severity === 'exp' && (badges ? badge('(a+)+', t`Exponential backtracking: ${redosReason(r.redos)}. ${redosSuggestion(r.redos)}`) : t`exponential backtracking (${redosReason(r.redos)})`),
        r.redos.severity === 'poly' && (badges ? badge('a*a*', t`Polynomial backtracking: ${redosReason(r.redos)}. ${redosSuggestion(r.redos)}`) : t`polynomial backtracking (${redosReason(r.redos)})`),
        r.fused > 0 && (badges ? badge('fuse', t`${r.fused} inputs over ${settings.fuseLen} characters were skipped by the fuse`) : t`fused`),
        r.tripped && (badges ? badge('off', t`Turned off by the circuit breaker: ${r.slowRuns} runs took over ${settings.breakerMs} ms. Click to turn it back on.`, 'rpk-undo', ` data-trip="${r.tripId}"`) : t`breaker`),
        r.maxMs > SPIKE_MS && (badges ? badge('⚡', t`One run took ${fmtMs(r.maxMs)} ms (more than ${SPIKE_MS} ms)` + (r.spike ? '\n' + spikeText(r.spike) + spikeHistory(r) : ''), 'rpk-spike', r.spike?.messageId != null ? ` data-mesid="${r.spike.messageId}"` : '') : t`spike`),
        conflicted.length > 0 && (badges ? badge('⇅', conflicted.map(conflictText).join('\n')) : t`order conflict`),
        ineffective(r) && (badges ? badge('∅', t`Ran ${r.calls} times without ever matching: consider turning it off`) : t`no match`),
    ].filter(Boolean);
}

function buildSummary() {
    const { counts, invalid } = ensureInfo();
    const rows = [...stats.values()].filter(active).sort((a, b) => b.totalMs - a.totalMs || avoided(b) - avoided(a));
    const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);
    const total = sum('totalMs');
    const skipped = sum('skipped');
    const hits = sum('hits');
    const streamSkipped = sum('streamSkipped');
    const top = rows.find(r => r.calls > 0);
    const { chat } = ctx();
    const persist = persistAvailable ? { entries: persistMem.size, bytes: persistMemBytes, dbRows: persistDbRows, dbBytes: persistDbBytes, maxMB: settings.persistDbMaxMB, loaded: persistLoaded, pending: persistPending.size + persistInFlight, available: !persistDbFailed } : null;
    return {
        counts,
        invalid,
        rows,
        total,
        calls: sum('calls'),
        skipped,
        hits,
        streamSkipped,
        skips: skipped + hits + streamSkipped,
        bypass: sum('bypass'),
        htmlBypass: sum('htmlBypass'),
        fast: sum('fast'),
        saved: rows.reduce((acc, r) => acc + savedMs(r), 0),
        ineffective: rows.filter(ineffective).map(r => r.name),
        chatLen: chat?.length ?? 0,
        top,
        topShare: top && total > 0 ? top.totalMs / total * 100 : 0,
        usage: t`③ memory cache: ${memoLru.size} entries, ${(memoBytes / MB).toFixed(1)} of ${settings.memoMaxMB} MB`
            + (htmlStageAvailable ? '. ' + t`⑨ HTML cache: ${htmlMemo.map.size} messages, ${(htmlMemo.bytes / MB).toFixed(1)} of ${settings.htmlMemoMaxMB} MB` : '')
            + (persist ? '. ' + t`⑤ saved results: ${persist.entries} messages in this chat, ${(persist.dbBytes / MB).toFixed(1)} of ${settings.persistDbMaxMB} MB in all chats` : ''),
        persist,
        pipe: pipelineSummary(),
        feel: { ...feel },
    };
}

/** The display pipeline since the stats were reset: stage times and shares, ⑨ hits and what they saved. */
function pipelineSummary() {
    const full = pipe.passes - pipe.htmlHits;
    const total = pipeTotal();
    const pct = (ms) => (total > 0 ? Math.round(ms / total * 100) : 0);
    return {
        available: htmlStageAvailable,
        passes: pipe.passes,
        full,
        hookMs: pipe.hookMs, regexMs: pipe.regexMs, markdownMs: pipe.markdownMs, sanitizeMs: pipe.sanitizeMs, totalMs: total,
        hookPct: pct(pipe.hookMs), regexPct: pct(pipe.regexMs), markdownPct: pct(pipe.markdownMs), sanitizePct: pct(pipe.sanitizeMs),
        htmlHits: pipe.htmlHits,
        htmlStores: pipe.htmlStores,
        htmlSavedMs: Math.max(0, pipe.htmlHits * avgPassMs() - pipe.htmlHitMs), // a hit still pays the placeholder markdown and the sanitizing
        paragraph: { passes: pipe.paraPasses, hits: pipe.paraHits, fallbacks: pipe.paraFallbacks },
        converterWrapped: showdownWrapped, // the ⑨ placeholder and the ④ paragraph cache need the converter's makeHtml wrapped
        avgPassMs: avgPassMs(),
        loadMs: pipe.loadMs,
        light: adaptiveLight && settings.adaptive,
    };
}
const pipeText = (p) => t`Display renders timed: ${p.full}, ${fmtMs(p.totalMs)} ms: regex ${p.regexPct}%, markdown ${p.markdownPct}%, sanitizing ${p.sanitizePct}%, this extension's own lookups ${p.hookPct}%`;
const htmlText = (p) => t`⑨ HTML cache: ${p.htmlHits} renders reused, about ${fmtMs(p.htmlSavedMs)} ms saved`;
const paraText = (p) => t`④ paragraph cache: ${p.paragraph.hits} streaming renders reused the finished paragraphs' HTML and converted the last paragraph only (${p.paragraph.passes} renders were split)`
    + (p.paragraph.fallbacks ? ' ' + t`(${p.paragraph.fallbacks} messages went back to whole renders)` : '');
/** The stutter figures in words: late frames, long tasks and the display renders inside them. */
function feelText(f) {
    const parts = [];
    if (f.frames) parts.push(t`frames late during a generation: ${f.dropped} of ${f.frames} (${f.frozen} freezes over 100 ms)`);
    if (f.longTasks) parts.push(t`tasks over 50 ms: ${f.longTasks} (${f.longTasks100} over 100 ms, ${fmtMs(f.longTaskMs)} ms blocked, ${f.streamLongTasks} during a generation)`);
    if (f.longTasks && f.lastLongTask) parts.push(t`display renders inside those tasks: ${fmtMs(f.longTaskPipeMs)} ms of ${fmtMs(f.longTaskMs)} ms; the latest task: ${fmtMs(f.lastLongTask.pipeMs)} ms of ${fmtMs(f.lastLongTask.ms)} ms (the rest: SillyTavern's DOM work and layout, other extensions, and this extension's own storage and panel work)`);
    return parts.join('; ');
}

// ---- ⑤ storage: IndexedDB ----

// One row per displayed message: id = chat key + "\0" + the message's hash and length (the first two fields of its key),
// value = {id, chat, k (the whole key), h | v | same, at, n (estimated bytes)}. The hooks are synchronous, so a chat's
// rows are read into persistMem when it opens; stores reach memory at once and IndexedDB in one transaction a moment
// later. Beyond persistDbMaxMB (all chats) the oldest rows go first. Older versions' extra.regex_perf_cache entries in
// chat files are read, never written.
const DB_NAME = 'regex_perf_kit';
const DB_STORE = 'results';
const FLUSH_MS = 200;
let persistDb = null;
let persistDbOpening = null; // the opening promise
let persistDbFailed = false; // IndexedDB could not be opened in this browser
let persistDbBytes = 0; // estimated size of all rows, all chats (measured at the first open, kept up to date)
let persistDbRows = 0;
let persistChatKey = null; // the chat persistMem holds, null when no chat is open
const persistMem = new Map(); // this chat's rows by id
let persistMemBytes = 0;
const persistPending = new Map(); // rows waiting for the next flush, by id
let persistFlushTimer = 0;
let persistInFlight = 0; // rows of the running flush (the JSON's `pending` counts them)
let persistLoaded = true; // this chat's rows have been read (or there is nothing to read)
let persistLastAt = 0; // `at` is strictly increasing, so rows of the same millisecond still age in order
let persistLoadGen = 0; // bumped by every read and clear, so an overtaken read puts nothing back
const countDb = (bytes, rows) => {
    persistDbBytes += bytes;
    persistDbRows += rows;
};

const idbDone = (req) => new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); });
/** Walks a key cursor request; each(cursor) returning false stops the walk. */
const eachKey = (req, each) => new Promise((ok, no) => {
    req.onsuccess = () => {
        const cur = req.result;
        if (!cur || each(cur) === false) return ok();
        cur.continue();
    };
    req.onerror = () => no(req.error);
});
const txDone = (tx) => new Promise((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => no(tx.error); });
/** The results store in a new transaction, which is store.transaction. */
const storeOf = (db, mode = 'readonly') => db.transaction(DB_STORE, mode).objectStore(DB_STORE);

/** Opens (and on first use creates) the database; resolves to null where IndexedDB is unavailable. */
function openPersistDb() {
    if (persistDb) return Promise.resolve(persistDb);
    if (persistDbOpening) return persistDbOpening;
    persistDbOpening = (async () => {
        try {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const store = req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
                store.createIndex('chat', 'chat');
                store.createIndex('age', ['at', 'n']); // a key cursor gives sizes oldest first without reading rows
            };
            const db = await idbDone(req);
            db.onversionchange = () => { db.close(); persistDb = persistDbOpening = null; }; // reopened on the next use
            persistDb = db;
            await measurePersistDb(db);
            return db;
        } catch (e) {
            persistDbFailed = true;
            console.warn('[RegexPerf] ⑤ IndexedDB is not available; only results older versions wrote into chat files are read', e);
            return null;
        }
    })();
    return persistDbOpening;
}

/** Sums the stored rows' sizes from the index keys, plus the rows still pending (the scan cannot see them). */
async function measurePersistDb(db) {
    let bytes = 0;
    let rows = 0;
    try {
        await eachKey(storeOf(db).index('age').openKeyCursor(), (cur) => {
            bytes += cur.key[1];
            rows++;
        });
    } catch { /* an unreadable store counts as empty */ }
    for (const row of persistPending.values()) bytes += row.n;
    persistDbBytes = bytes;
    persistDbRows = rows + persistPending.size;
    statsDirty = true;
}

/** The current chat as ⑤ keys it (character avatar or group id + chat id), or null without an open chat. */
function persistChatKeyNow(context = ctx()) {
    const { chatId, groupId, characterId, characters } = context;
    if (!chatId) return null;
    return groupId ? `g:${groupId}:${chatId}` : `c:${characters?.[characterId]?.avatar ?? characterId}:${chatId}`;
}

/** ⑤'s row id for a message: the chat, then its key up to the |. */
function persistIdOf(key) {
    return persistChatKey + '\u0000' + key.slice(0, key.indexOf('|'));
}

/**
 * Reads the current chat's rows into persistMem, unless that chat is already read or being read. Called at a chat's
 * first display pass (SillyTavern prints a chat before CHAT_CHANGED), when #chat is emptied for the next chat, at
 * CHAT_CHANGED and once at start.
 */
function loadPersisted(context) {
    const chatKey = persistChatKeyNow(context);
    if (chatKey === persistChatKey) return;
    persistChatKey = chatKey;
    persistMem.clear();
    persistMemBytes = 0;
    persistLoaded = chatKey === null;
    if (chatKey === null) return;
    const gen = ++persistLoadGen;
    const stale = () => persistChatKey !== chatKey || gen !== persistLoadGen;
    (async () => {
        const db = await openPersistDb();
        if (stale()) return;
        if (db) {
            try {
                const rows = await idbDone(storeOf(db).index('chat').getAll(chatKey));
                if (stale()) return;
                const old = [];
                for (const row of rows) {
                    if (!String(row.k).includes('|')) { // keyed by a version before 0.5.5: never served again
                        old.push(row.id);
                        countDb(-row.n, -1);
                        continue;
                    }
                    if (persistMem.has(row.id)) { // stored again during the read: the new row replaced it in the database
                        countDb(-row.n, -1);
                        continue;
                    }
                    persistMem.set(row.id, row);
                    persistMemBytes += row.n;
                }
                if (old.length) {
                    const store = storeOf(db, 'readwrite');
                    for (const id of old) store.delete(id);
                }
            } catch (e) { console.warn('[RegexPerf] ⑤ could not read the stored results', e); }
        }
        persistLoaded = true;
        statsDirty = true;
    })();
}

/**
 * SillyTavern empties #chat and sets the next chat's id before it fetches and prints that chat: reading the rows then
 * lets them serve the first render, as far as IndexedDB answers before the chat file arrives.
 */
function watchChatClear() {
    const el = globalThis.document?.getElementById('chat');
    if (!el || typeof MutationObserver !== 'function') return;
    new MutationObserver(() => { if (!el.firstElementChild) setTimeout(loadPersisted, 0); }).observe(el, { childList: true });
}

/** Keeps a message's result: in memory at once, in IndexedDB at the next flush. */
function storePersisted(id, fields) {
    const at = persistLastAt = Math.max(Date.now(), persistLastAt + 1);
    const row = { id, chat: persistChatKey, at, n: 0, ...fields };
    row.n = (id.length + row.k.length + (row.h?.length ?? 0) + (row.v?.length ?? 0) + 40) * 2;
    const old = persistMem.get(id);
    persistMem.set(id, row);
    persistMemBytes += row.n - (old?.n ?? 0);
    if (!persistDbFailed) countDb(row.n - (old?.n ?? 0), old ? 0 : 1); // without IndexedDB nothing is ever stored
    persistPending.set(id, row);
    persistStats.stores++;
    if (!persistFlushTimer) persistFlushTimer = setTimeout(flushPersisted, FLUSH_MS);
}

/** Writes the pending rows in one transaction, then drops the oldest rows while the store is over its size limit. */
async function flushPersisted() {
    persistFlushTimer = 0;
    const db = await openPersistDb();
    if (!db) { // counted as storage before the open failed: never written
        for (const row of persistPending.values()) countDb(-row.n, -1);
        persistPending.clear();
        statsDirty = true;
        return;
    }
    const rows = [...persistPending.values()];
    persistPending.clear();
    persistInFlight += rows.length;
    try {
        if (rows.length) {
            try {
                const store = storeOf(db, 'readwrite');
                for (const row of rows) store.put(row);
                await txDone(store.transaction);
            } catch (e) { console.warn('[RegexPerf] ⑤ could not store the results', e); }
        }
        if (persistDbBytes > settings.persistDbMaxMB * MB) await evictPersisted(db);
    } finally {
        persistInFlight -= rows.length;
        statsDirty = true;
    }
}

/** Deletes rows oldest first (all chats) until the store is under 90% of its limit. */
async function evictPersisted(db) {
    const target = settings.persistDbMaxMB * MB * 0.9;
    try {
        const store = storeOf(db, 'readwrite');
        await eachKey(store.index('age').openKeyCursor(), (cur) => {
            if (persistDbBytes <= target) return false;
            store.delete(cur.primaryKey);
            countDb(-cur.key[1], -1);
            const mine = persistMem.get(cur.primaryKey);
            if (mine && mine.at === cur.key[0]) { // a newer row in memory is pending and will be written again
                persistMem.delete(cur.primaryKey);
                persistMemBytes -= mine.n;
            }
        });
        await txDone(store.transaction);
    } catch (e) { console.warn('[RegexPerf] ⑤ could not drop old results', e); }
}

/** Deletes this chat's rows; how many there were. */
async function clearPersistedDb() {
    const chatKey = persistChatKey;
    const removed = persistMem.size;
    const wasLoaded = persistLoaded;
    persistLoadGen++; // a read still running puts nothing back
    persistLoaded = true;
    for (const [id, row] of persistPending) if (row.chat === chatKey) persistPending.delete(id); // another chat's rows may be pending too
    if (!persistDbFailed) countDb(-persistMemBytes, -persistMem.size);
    persistMem.clear();
    persistMemBytes = 0;
    if (chatKey === null) return removed;
    const db = await openPersistDb();
    if (!db) return removed;
    try {
        const store = storeOf(db, 'readwrite');
        await eachKey(store.index('chat').openKeyCursor(IDBKeyRange.only(chatKey)), (cur) => { store.delete(cur.primaryKey); });
        await txDone(store.transaction);
        if (!wasLoaded) await measurePersistDb(db); // rows not read yet were deleted too
    } catch (e) { console.warn('[RegexPerf] ⑤ could not clear the stored results', e); }
    statsDirty = true;
    return removed;
}

let measured = null; // last "Measure on this chat" result
const rowMeasures = new Map(); // stat -> {with, without}

const SLOWEST_MESSAGES = 5;
const slowestText = (m) => t`Slowest messages (features off): ${m.slowest.map(x => t`#${x.i} (${x.len} chars) ${fmtMs(x.ms)} ms`).join(', ')}`;
const measureText = (m) => t`This chat (${m.messages} messages): ${fmtMs(m.off)} ms with the features off, ${fmtMs(m.on)} ms on — ${fmtMs(m.off - m.on)} ms saved (${m.off > 0 ? Math.round((m.off - m.on) / m.off * 100) : 0}%)`;
/** The table's columns, in the text report and the CSV. */
const reportHeader = () => t`Rank | Script | Runs | Total ms | Avg ms | Max ms | Replacer ms | Matched | Changed | Skips | Hits | Stream skips | Literal | Min length | Warnings`;

/** "global 3/40, preset 2/8, scoped 0/0": active/total per script origin. */
const typeCounts = (c) => {
    const [g, p, s] = ['global', 'preset', 'scoped'].map(k => c.types[k] ?? { active: 0, total: 0 });
    return [t`global ${g.active}/${g.total}`, t`preset ${p.active}/${p.total}`, t`scoped ${s.active}/${s.total}`].join(', ');
};

function buildReportText() {
    const s = buildSummary();
    const c = s.counts;
    const lines = [
        `Regex Perf Kit report (${new Date().toLocaleString()})`,
        t`Since: ${new Date(statsSince).toLocaleTimeString()} / chat messages: ${s.chatLen}`,
        t`Scripts: ${c.total} total, ${c.active} active (${typeCounts(c)}), no literal ${c.noNeedle}, backtracking risk ${c.redos} (exponential ${c.redosExp})`,
        t`Ran ${s.calls} times / ${fmtMs(s.total)} ms total | skipped ${s.skips} (prefilter ${s.skipped}, cache hits ${s.hits}, streaming ${s.streamSkipped}) | persistent cache bypasses ${s.bypass - s.htmlBypass} (hits ${persistStats.hits}, stored ${persistStats.stores})`
            + (htmlStageAvailable ? ' | ' + t`HTML cache bypasses ${s.htmlBypass}` : ''),
        s.calls
            ? t`Estimated time saved: ≈${fmtMs(s.saved)} ms (${s.skips} skipped runs × each script's average run time)`
            : t`Estimated time saved: not available yet (no measured runs)`,
        s.usage,
    ];
    if (s.fast) lines.push(fastText(s.fast));
    if (s.pipe.available && s.pipe.full) {
        lines.push(pipeText(s.pipe));
        if (s.pipe.htmlHits) lines.push(htmlText(s.pipe));
        if (s.pipe.paragraph.passes) lines.push(paraText(s.pipe));
        if (s.pipe.light) lines.push(t`The regex stage is under 2% of the renders: the profiler times 1 run in 64 (adaptive).`);
    }
    const felt = feelText(s.feel);
    if (felt) lines.push(t`Stutter: ${felt}`);
    if (s.pipe.loadMs) lines.push(t`Opening this chat rendered for ${fmtMs(s.pipe.loadMs)} ms`);
    if (measured) lines.push(measureText(measured), slowestText(measured), ...measureVerdict(measured));
    if (s.top) lines.push(t`#1 "${s.top.name}" takes ${s.topShare.toFixed(0)}% of the total time`);
    if (s.ineffective.length) lines.push(t`Candidates to disable (ran ${INEFFECTIVE_RUNS}+ times, never matched): ${s.ineffective.join(', ')}`);
    lines.push('', reportHeader());
    s.rows.forEach((r, i) => {
        lines.push(`${i + 1} | ${r.name} | ${r.calls} | ${fmtMs(r.totalMs)} | ${fmtMs(avgMs(r))} | ${fmtMs(r.maxMs)} | ${fmtMs(r.replMs)} | ${r.matched} | ${r.changed} | ${r.skipped} | ${r.hits} | ${r.streamSkipped} | ${fmtNeedles(r) ?? '- (' + needleReason(r) + ')'} | ${r.needle?.minLen || '-'} | ${warnings(r).join(', ')}`);
    });
    if (conflicts.size) {
        lines.push('', t`Order conflicts (an earlier script removed what a later one looks for)`);
        for (const c of conflicts.values()) lines.push(`${conflictText(c)}, e.g. ${JSON.stringify(c.sample)}`);
    }
    const spikes = s.rows.filter(r => r.spike);
    if (spikes.length) {
        lines.push('', t`Spikes (newest run over ${SPIKE_MS} ms per script)`);
        for (const r of spikes) {
            lines.push(`${r.name}: ${spikeText(r.spike)}` + spikeMes(r.spike));
            for (const sp of r.spikes.slice(1)) lines.push(`  ${fmtMs(sp.ms)} ms / ${sp.len}` + spikeMes(sp));
        }
    }
    const risks = s.rows.filter(r => r.redos.kind);
    if (risks.length) {
        lines.push('', t`Backtracking risks (the pattern's shape, as the analyzer reads it)`);
        for (const r of risks) {
            const sev = r.redos.severity === 'exp' ? t`exponential` : r.redos.severity === 'poly' ? t`polynomial` : null;
            lines.push(`${r.name}: ${sev ? `${sev}: ${redosReason(r.redos)}. ${redosSuggestion(r.redos)}` : redosReason(r.redos)}`);
        }
    }
    if (s.invalid.length) {
        lines.push('', t`Invalid patterns (${s.invalid.length})`);
        for (const i of s.invalid) lines.push(`${i.name}: ${i.error}`);
    }
    const lint = lintRows();
    if (lint.length) {
        lines.push('', t`Lint (${lint.length})`);
        for (const row of lint) lines.push(`${row.info.name}: ${row.text}`);
    }
    return lines.join('\n');
}

/** The report as data (English keys), for /regexperf json and the JSON copy. */
function buildReportData() {
    const s = buildSummary();
    return {
        generatedAt: new Date().toISOString(),
        since: new Date(statsSince).toISOString(),
        chatMessages: s.chatLen,
        scripts: { ...s.counts, infoBuilds },
        totals: { calls: s.calls, totalMs: s.total, skipped: s.skipped, hits: s.hits, streamSkipped: s.streamSkipped, bypass: s.bypass, htmlBypass: s.htmlBypass, fastRuns: s.fast, persistHits: persistStats.hits, persistStores: persistStats.stores, savedMs: s.calls ? s.saved : null },
        memo: { entries: memoLru.size, bytes: memoBytes, maxMB: settings.memoMaxMB, persist: s.persist, html: { entries: htmlMemo.map.size, bytes: htmlMemo.bytes, maxMB: settings.htmlMemoMaxMB } },
        pipeline: s.pipe,
        felt: s.feel,
        measured,
        candidatesToDisable: s.ineffective,
        orderConflicts: [...conflicts.values()].map(c => ({ earlier: c.earlier.name, later: c.later.name, count: c.count, confirmed: c.confirmed, sample: c.sample })),
        invalidPatterns: s.invalid,
        lint: lintRows().map(row => ({ script: row.info.name, ids: row.info.ids, rule: row.rule, text: row.text, fixable: !!row.fix })),
        rows: s.rows.map((r, i) => ({
            rank: i + 1, name: r.name, pattern: r.src, runs: r.calls, totalMs: r.totalMs, avgMs: avgMs(r), maxMs: r.maxMs, replacerMs: r.replMs,
            matched: r.matched, changed: r.changed, skips: r.skipped, hits: r.hits, streamSkips: r.streamSkipped, fastRuns: r.fast, incrementalRuns: r.incremental,
            sampled: (!!settings.profilerSampling && r.seen > SAMPLE_AFTER) || s.pipe.light, // runs, totals, matched and changed are scaled from 1 run in 8 (64 when adaptive)
            redos: r.redos, fused: r.fused, broken: r.broken, tripped: r.tripped,
            literal: r.needle?.terms ?? [], literalReason: r.needle?.reason ?? null, minLength: r.needle?.minLen ?? 0, warnings: warnings(r), spike: r.spike, spikes: r.spikes,
        })),
    };
}

/** The report's table as CSV (RFC 4180 quoting), with the text report's translated header. */
function buildReportCsv() {
    const cell = (v) => {
        const str = String(v ?? '');
        return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const lines = [reportHeader().split(' | ').map(cell).join(',')];
    buildSummary().rows.forEach((r, i) => {
        lines.push([i + 1, r.name, r.calls, r.totalMs, avgMs(r), r.maxMs, r.replMs, r.matched, r.changed, r.skipped, r.hits, r.streamSkipped, fmtNeedles(r) ?? '', r.needle?.minLen || '', warnings(r).join('; ')].map(cell).join(','));
    });
    return lines.join('\r\n');
}

/** Turns off the script whose name matches (exactly, else as the only one containing it); the message to show. */
async function turnOffByName(name) {
    const want = name.trim().toLowerCase();
    if (!want) return t`Usage: /regexperf off <script name>`;
    // each script by its own name: scripts sharing a pattern share a table row, not this command
    const scripts = readGroups().flatMap(([, list]) => list).filter(s => s?.findRegex && !s.disabled).map(s => ({ ids: [s.id], name: s.scriptName || t`(no name)` }));
    const found = scripts.filter(r => r.name.toLowerCase() === want);
    const hits = found.length ? found : scripts.filter(r => r.name.toLowerCase().includes(want));
    if (hits.length !== 1) return hits.length ? t`"${name}" matches several scripts: ${hits.map(r => r.name).join(', ')}` : t`"${name}" is not in the Regex extension's list.`;
    await scriptAction(hits[0], true);
    renderPanel();
    return t`Turned off: ${hits[0].name}`;
}

// ---- Lint and saving through the engine ----

/**
 * Saves a change to the scripts with these ids through the engine; false where SillyTavern lacks saveScriptsByType.
 * The script objects change in place: the Regex drawer's rows hold them and save them back as they are.
 */
async function saveScript(ids, patch) {
    if (typeof engine.saveScriptsByType !== 'function' || typeof getScriptsByType !== 'function' || !SCRIPT_TYPES) return false;
    let saved = false;
    for (const type of Object.values(SCRIPT_TYPES)) {
        const list = getScriptsByType(type, { allowedOnly: false }) ?? [];
        const mine = list.filter(s => ids.includes(s?.id));
        if (!mine.length) continue;
        for (const s of mine) Object.assign(s, patch);
        await engine.saveScriptsByType(list, type);
        saved = true;
    }
    if (!saved) return false;
    if ('disabled' in patch) { // the drawer's switch for each script, as its own click would leave it
        for (const id of ids) {
            const box = document.getElementById(id)?.querySelector('.disable_regex');
            if (box) box.checked = !!patch.disabled;
        }
    }
    markDirty();
    return true;
}

/** Lint findings for every active script: {rule, info, text, fix}, fix = {label, patch} where it is mechanical. */
function lintRows() {
    if (!settings.lint) return [];
    const rows = [];
    for (const info of ensureInfo().map.values()) {
        const stat = stats.get(info.statKey);
        const find = String(info.find ?? '');
        if (!info.flags.includes('g') && stat?.moreMatches >= 3) {
            const m = /^\/([\s\S]+)\/([a-z]*)$/i.exec(find);
            rows.push({ rule: 'missing-g', info, text: t`Matched more than once in a message, but without the g flag only the first match is replaced`, fix: { label: t`Add g`, patch: { findRegex: m ? `/${m[1]}/${m[2]}g` : `/${find}/g` } } });
        }
        const bad = [...new Set(info.refs.filter(r => !r.ok).map(r => r.ref))];
        if (bad.length) rows.push({ rule: 'group-ref', info, text: t`Group references the pattern cannot fill: ${bad.join(' ')}`, fix: null });
        if (/\\\\[nrtsdwb]/.test(find)) rows.push({ rule: 'double-escape', info, text: t`Double escapes such as \\\\n in the pattern (a JSON copy): they match a backslash and a letter, not a newline`, fix: { label: t`Unescape`, patch: { findRegex: find.replace(/\\\\([nrtsdwb])/g, '\\$1') } } });
        const compat = [];
        if (/\(\?<[=!]/.test(info.source)) compat.push(t`lookbehind`);
        if (info.flags.includes('v')) compat.push(t`the v flag`);
        if (info.flags.includes('d')) compat.push(t`the d flag`);
        const names = info.source.match(/\(\?<([^>=!][^>]*)>/g) ?? [];
        if (new Set(names).size < names.length) compat.push(t`duplicate group names`);
        if (compat.length) rows.push({ rule: 'browser-compat', info, text: t`Not supported by every browser: ${compat.join(', ')} (invalid in older browsers, such as Safari and iOS before 16.4 for lookbehind, 17 for the v flag and duplicate group names, 15 for the d flag, where the script does nothing)`, fix: null });
        if (info.ids.length > 1) rows.push({ rule: 'duplicate', info, text: t`Several scripts share this pattern (${info.name}): one wrapper serves all of them, so ③ and ④ apply only when they suit every one`, fix: null });
    }
    return rows;
}

/** A yes/no popup; true without SillyTavern's popups. */
async function confirmPopup(html) {
    const { callGenericPopup, POPUP_TYPE } = ctx();
    if (typeof callGenericPopup !== 'function') return true;
    const r = await callGenericPopup(html, POPUP_TYPE?.CONFIRM ?? 2);
    return r === 1 || r === true;
}

// ---- Cost chips in the Regex extension's own list ----

const LIST_IDS = ['saved_regex_scripts', 'saved_scoped_scripts', 'saved_preset_scripts'];
const observedLists = new WeakSet();
const statById = new Map(); // script id -> its stat, for the chips
let chipTimer = 0;
const listBoxes = () => LIST_IDS.map(id => document.getElementById(id)).filter(Boolean);
/** Watches the Regex drawer's lists (SillyTavern rebuilds them) once they exist. */
function installListBadges() {
    for (const box of listBoxes()) {
        if (observedLists.has(box)) continue;
        observedLists.add(box);
        new MutationObserver(() => {
            if (!chipTimer) chipTimer = setTimeout(() => { chipTimer = 0; updateListBadges(); }, 50);
        }).observe(box, { childList: true, subtree: true });
    }
}
/** The chip after a script's name: total ms, share of all regex time, and the marks of the table. */
function chipText(r, total) {
    const parts = [`${fmtMs(r.totalMs)} ms`];
    if (total > 0 && r.calls) parts.push(`${Math.round(r.totalMs / total * 100)}%`);
    if (ineffective(r)) parts.push('∅');
    if (r.redos.severity === 'exp') parts.push('(a+)+');
    if (r.redos.severity === 'poly') parts.push('a*a*');
    if (r.maxMs > SPIKE_MS) parts.push('⚡');
    if (conflictsOf(r).length) parts.push('⇅');
    if (r.fused > 0) parts.push('fuse');
    if (r.tripped) parts.push('off');
    return parts.join(' · ');
}
function updateListBadges() {
    if (!settings.listBadges) {
        for (const el of document.querySelectorAll('.rpk-chip')) el.remove();
        return;
    }
    const total = [...stats.values()].reduce((acc, r) => acc + r.totalMs, 0);
    for (const box of listBoxes()) {
        for (const row of box.querySelectorAll('.regex-script-label[id]')) {
            const name = row.querySelector('.regex_script_name');
            const stat = statById.get(row.id);
            let chip = row.querySelector('.rpk-chip');
            if (!name || !stat || !active(stat)) {
                chip?.remove();
                continue;
            }
            if (!chip) {
                chip = document.createElement('span');
                chip.className = 'rpk-chip';
                name.after(chip);
            }
            const text = chipText(stat, total);
            if (chip.textContent !== text) chip.textContent = text;
            const title = warnings(stat).join(', ');
            if (chip.title !== title) chip.title = title;
        }
    }
}

const COUNTERS = ['calls', 'totalMs', 'maxMs', 'replMs', 'matched', 'changed', 'skipped', 'hits', 'streamSkipped', 'bypass', 'htmlBypass', 'fast', 'incremental', 'seen', 'seenMatched', 'fused', 'broken', 'slowRuns', 'moreMatches', 'spike', 'spikes'];
const FEATURES_OFF = { profiler: false, prefilter: false, memo: false, htmlMemo: false, persist: false, fastPath: false, breaker: false, adaptive: false };
const CACHES_OFF = { profiler: false, memo: false, htmlMemo: false, persist: false, breaker: false, adaptive: false }; // per row: ② as set

const MEASURE_CHUNK = 10; // messages formatted between two yields to the page
let measureBusy = false;
let measurePass = false; // a measurement is formatting a message: ⑤ and ⑨ serve it but store nothing

/**
 * Re-renders every message of the current chat as SillyTavern displays it, first with the features off, then with the
 * user's settings, and returns both times. With a stat, both passes run with the caches off and the second without
 * that pattern: {with, without}. Yields every MEASURE_CHUNK messages; the features are off through cfg only while a
 * message is formatted, so renders in between get the user's settings, and the stats are restored afterwards.
 */
async function measureChat(without = null) {
    const { chat, messageFormatting } = ctx();
    if (!chat?.length || typeof messageFormatting !== 'function' || measureBusy) return null;
    measureBusy = true;
    const pause = () => globalThis.scheduler?.yield?.() ?? new Promise(resolve => setTimeout(resolve, 0));
    const over = (changes) => Object.assign(Object.create(settings), changes);
    const stageSnap = () => [pipe.regexMs, pipe.markdownMs, pipe.sanitizeMs, pipe.htmlHitMs, pipe.htmlHits, pipe.hookMs];
    const render = async (times, skip, config) => { // times: receives per-message {i, len, ms}
        let total = 0;
        const before = stageSnap();
        let over16 = 0; // messages over a frame on their own
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            const text = m?.extra?.display_text ?? m?.mes; // what SillyTavern shows (a translation, say)
            cfg = config;
            skipStat = skip;
            measurePass = true;
            const t1 = performance.now();
            try {
                if (text) messageFormatting(text, m.name, m.is_system, m.is_user, i);
                if (m?.extra?.reasoning) messageFormatting(m.extra.reasoning, '', false, false, i, {}, true);
            } finally {
                cfg = settings;
                skipStat = null;
                measurePass = false;
            }
            const ms = performance.now() - t1;
            total += ms;
            if (ms > FRAME_BUDGET_MS) over16++;
            if (times) times.push({ i, len: (text?.length ?? 0) + (m?.extra?.reasoning?.length ?? 0), ms });
            if (i % MEASURE_CHUNK === MEASURE_CHUNK - 1) await pause();
        }
        const after = stageSnap();
        const [regex, markdown, sanitize, hitMs, hits, hook] = after.map((v, k) => v - before[k]);
        return { total, over16, stages: htmlStageAvailable ? { regex, markdown, sanitize, hitMs, hits, hook } : null };
    };
    const saved = new Map([...stats].map(([k, st]) => [k, COUNTERS.map(c => (Array.isArray(st[c]) ? [...st[c]] : st[c]))]));
    const zero = (c) => (c === 'spikes' ? [] : c === 'spike' ? null : 0); // a stat first seen during the measurement
    const savedPersist = { ...persistStats };
    const savedPipe = { ...pipe };
    const savedFeel = { ...feel };
    const savedPasses = recentPasses.slice();
    const savedConflicts = new Map([...conflicts].map(([k, c]) => [k, { ...c }]));
    const savedLight = adaptiveLight;
    const times = [];
    let first, second;
    const span = [performance.now(), Infinity]; // see inMeasurement()
    measureSpans.push(span);
    if (measureSpans.length > MEASURE_SPANS_KEPT) measureSpans.shift();
    try {
        first = await render(without ? null : times, null, over(without ? CACHES_OFF : FEATURES_OFF));
        second = await render(null, without, over(without ? CACHES_OFF : { profiler: false, adaptive: false }));
    } finally {
        span[1] = performance.now();
        measureBusy = false;
        for (const [k, st] of stats) COUNTERS.forEach((c, i) => { st[c] = saved.get(k)?.[i] ?? zero(c); });
        Object.assign(persistStats, savedPersist);
        Object.assign(pipe, savedPipe);
        Object.assign(feel, savedFeel);
        recentPasses.splice(0, recentPasses.length, ...savedPasses);
        adaptiveLight = savedLight;
        conflicts.clear();
        for (const [k, c] of savedConflicts) conflicts.set(k, c);
    }
    if (without) return { with: first.total, without: second.total };
    return {
        messages: chat.length, off: first.total, on: second.total, slowest: times.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_MESSAGES),
        over16: { off: first.over16, on: second.over16 },
        stages: first.stages && second.stages ? { off: first.stages, on: second.stages } : null,
    };
}

/**
 * A measurement's verdict in words a user can act on: whether the saving can be felt, the regex stage's share of the
 * render, and SillyTavern's own settings when regex is not the cost.
 */
export function measureVerdict(m) {
    const savedMs = m.off - m.on;
    const share = m.off > 0 ? savedMs / m.off : 0;
    const perMsg = m.messages ? m.on / m.messages : 0;
    const lines = [];
    let regexPart = null; // the regex stage's share with the features off: what ②③④⑥ can save at most
    if (m.stages) {
        const s = m.stages.off;
        const total = s.regex + s.markdown + s.sanitize + s.hook;
        if (total > 0) {
            regexPart = s.regex / total;
            lines.push(t`Of the render with the features off, the regex stage was ${Math.round(regexPart * 100)}%, markdown ${Math.round(s.markdown / total * 100)}%, sanitizing ${Math.round(s.sanitize / total * 100)}%.`);
        }
    }
    if (m.over16) lines.push(t`Messages over a frame (${Math.round(FRAME_BUDGET_MS)} ms) on their own: ${m.over16.off} → ${m.over16.on}.`);
    const sameOver16 = m.over16?.on === m.over16?.off;
    const unfelt = savedMs < FRAME_BUDGET_MS && sameOver16;
    // A saving of a few ms is noise, the stage split is not: with a negligible regex share, any saving came from ⑨.
    const negligible = regexPart !== null && regexPart < ADAPTIVE_SHARE && sameOver16;
    if (unfelt) {
        lines.push(t`The saving is under one frame for the whole chat: nothing a user can feel here. The extension costs nothing either; the profiler is what remains useful.`);
    } else if (share < 0.1 && perMsg > FRAME_BUDGET_MS) {
        lines.push(t`The regex stage is not the cost in this chat: each message still takes over a frame to render with every feature on.`);
    } else if (negligible) {
        lines.push(t`The regex stage was under 2% of the render with the features off: ②③④⑥ have little to save here; what was saved came from ⑨.`);
    }
    // an unfelt saving makes the share noise, so the settings hint goes with it
    if (unfelt || negligible || perMsg > FRAME_BUDGET_MS || share < 0.1) {
        lines.push(t`What helps more: User Settings → "# Messages to Load" at 50–100 (fewer renders when a chat opens) and "Streaming FPS" at 10–15 (fewer renders while streaming).`);
    }
    return lines;
}

/** "Measure on this chat" (an empty chat keeps the previous result). */
async function measureNow() {
    measured = (await measureChat()) ?? measured;
    renderPanel();
    return measured;
}

function resetStats() {
    stats.clear();
    rowMeasures.clear();
    conflicts.clear();
    statsSince = Date.now();
    persistStats.hits = persistStats.stores = 0;
    resetPipe();
    resetFeel();
    adaptiveLight = false;
    statById.clear();
    wrapped.clear(); // wrappers hold their stat object; new ones link to fresh stats
}

// ---- UI ----

// UI text is English; locales/<locale>.json holds the translations, loaded before the panel is built. addLocaleData()
// never overrides SillyTavern's own translations, so a key it translates differently gets its own id (translate(text, id)).
const LOCALES = ['ko-kr'];
const locale = getCurrentLocale();
const localeFile = LOCALES.find(l => l === locale) ?? LOCALES.find(l => l.split('-')[0] === locale.split('-')[0]);
if (localeFile) {
    try {
        addLocaleData(locale, await (await fetch(new URL(`locales/${localeFile}.json`, import.meta.url))).json());
    } catch (e) { console.warn('[RegexPerf] could not load the locale file', e); }
}

/** A feature toggle with its description under the name; sub = an option of the feature above it. */
const feature = (id, name, desc, { labelId = '', sub = false } = {}) => `
        <label class="rpk-feature${sub ? ' rpk-sub' : ''}"${labelId ? ` id="${labelId}"` : ''}>
          <input type="checkbox" id="${id}">
          <span class="rpk-feature-text"><span class="rpk-feature-name">${name}</span><span class="rpk-feature-desc">${desc}</span></span>
        </label>`;

/** A row of the Limits grid: a number field for LIMITS[key] or a checkbox for TOGGLES, as #rpk_<key>. */
const limit = (key, name, title, type = 'number') => `<label${title ? ` title="${esc(title)}"` : ''}><span>${name}</span><input type="${type}"${type === 'number' ? ' class="text_pole"' : ''} id="rpk_${key}"></label>`;

// Sorting and the name filter are per session (not saved).
const SORT_KEYS = {
    rank: (r, i) => i, name: (r) => r.name.toLowerCase(), runs: (r) => r.calls, total: (r) => r.totalMs, avg: avgMs, max: (r) => r.maxMs,
    repl: (r) => r.replMs, matched: (r) => r.matched, changed: (r) => r.changed, skips: (r) => r.skipped, hits: (r) => r.hits, lit: (r) => fmtNeedles(r) ?? '',
};
let sortBy = null;
let sortDesc = true;
let nameFilter = '';

// Cells carry a column class (the narrow layout pins the Script column; tests read cells by it).
const th = (col, text, title) => `<th class="rpk-col-${col}${SORT_KEYS[col] ? ' rpk-sortable' : ''}${sortBy === col ? ' rpk-sorted' : ''}" data-col="${col}"${title ? ` title="${esc(title)}"` : ''}>${text}${sortBy === col ? (sortDesc ? ' ▾' : ' ▴') : ''}</th>`;
const td = (col, value, cls = '', title = '') => `<td class="rpk-col-${col}${cls ? ' ' + cls : ''}"${title ? ` title="${esc(title)}"` : ''}>${value}</td>`;

const headerHtml = () => `<tr>
            ${th('rank', '#')}${th('name', t`Script`)}
            ${th('runs', t`Runs`, t`Regex runs that really happened`)}${th('total', t`Total ms`)}${th('avg', t`Avg`, t`Time per run, averaged`)}${th('max', t`Max`, t`Slowest single run`)}
            ${th('repl', t`Replacer`, t`Time spent in the replacement (group filling, trim strings, macros), included in Total ms`)}${th('matched', t`Matched`, t`Runs where the pattern matched, even if the text came out the same`)}${th('changed', t`Changed`, t`Runs that changed the text`)}
            ${th('skips', t`Skips`, t`Runs skipped by ② (the fixed text was absent, or the message was shorter than the least possible match)`)}${th('hits', t`Hits`, t`Results reused by ③`)}${th('lit', t`Literal`, t`The fixed text ② looks for before running this script: every literal joined by & must be present, one of those joined by |. Hover a cell for the shortest possible match.`)}${th('act', '')}
          </tr>`;

const settingsHtml = () => `
<div id="regex_perf_kit" class="regex-perf-kit">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Regex Perf Kit</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="rpk-summary" id="rpk_summary">${t`Measuring...`}</div>
      <div class="rpk-pipe" id="rpk_pipe" title="${esc(t`Where the time of a display render goes: the regex scripts (what this extension can save), SillyTavern's markdown conversion, and the HTML sanitizer. Timed since the stats were reset.`)}"></div>

      <h4 class="rpk-section">${t`Features`}</h4>
      <div class="rpk-features">
        <div class="rpk-feature-group">
        ${feature('rpk_profiler', t`① Measure run time (profiler)`, t`Counts how often each script runs and how long it takes, for the table below. Costs almost nothing.`)}
        ${feature('rpk_profilerSampling', t`Sample: past 1000 runs of a script, time 1 run in 8`, t`Timing is two clock reads per run; with sampling, the totals of a busy script are scaled from every eighth run. On by default on devices reporting 4 GB or less (only Chromium-based browsers report it).`, { sub: true })}
        ${feature('rpk_timeReplacer', t`Time the replacement separately (the Replacer column)`, t`Two more clock reads per match. Off, that column stays 0.`, { sub: true })}
        ${feature('rpk_adaptive', t`Adaptive: time 1 run in 64 once regex is under 2% of the renders`, t`The whole display pipeline is timed (regex, markdown, sanitizing). When the regex stage is a negligible share, the profiler steps back and the summary says so instead of promising savings.`, { sub: true })}
        ${feature('rpk_frameStats', t`Measure stutter: late frames during a generation, tasks over 50 ms`, t`Counts the frames the page painted late while a reply was generated and the tasks that blocked the page for over 50 ms (from the browser's PerformanceObserver, Chromium only), and says how much of those tasks was display rendering. The figures keep changing while the page runs, so this is off by default; turning it off clears them. The frame sampler runs during a generation only.`, { sub: true })}
        </div>
        ${feature('rpk_prefilter', t`② Skip runs that cannot match (literal prefilter)`, t`If the message does not even contain the fixed text a script looks for (such as &lt;/status&gt;), the regex is not run. The result is exactly the same.`)}
        <div class="rpk-feature-group">
        ${feature('rpk_memo', t`③ Reuse results (memory cache)`, t`When the same script runs on the same message again (swipes, re-renders, reloads), the previous result is reused. Scripts and text with {{macros}} are left out automatically.`)}
        ${feature('rpk_memoStatic', t`Also cache scripts that use {{user}}, {{char}}, {{persona}} or {{group}}`, t`These macros keep their value while a message is rendered, so the result is cached per name set and computed again after a rename or a persona change. Other macros still exclude a script. Needs the MessageFormatter hooks, like ⑤ (display renders only).`, { sub: true })}
        ${feature('rpk_memoPostHoc', t`Also cache messages that show macro syntax`, t`A message with {{ outside the matched text (a code sample, for instance) is cached when no match itself contained macro syntax.`, { sub: true })}
        </div>
        <div class="rpk-feature-group">
        ${feature('rpk_streaming', t`④ Rest display scripts while streaming`, t`While a reply is being generated, "Only Format Display" scripts are skipped and applied once when it finishes. This removes most streaming lag.`)}
        ${feature('rpk_stream_throttle', t`Compromise: keep formatting the finished lines`, t`With ④ on, display scripts still format the lines that are already complete, at most once per interval (0.5 s by default, under Limits). The line being written stays raw; the finished reply gets every script.`, { sub: true })}
        ${feature('rpk_streamingIncremental', t`Incremental: run line-local scripts on the new lines only`, t`In compromise mode, a script whose matches cannot cross a line break (no \\n, \\s, [^…] or dotAll, no ^ or $ without the m flag; the g flag is required) formats only the lines added since its last run and reuses the rest. The first runs are compared with a full run; on any difference the script goes back to full runs.`, { sub: true })}
        ${feature('rpk_streamingParagraphCache', t`Paragraph cache: convert and sanitize the last paragraph only`, t`In compromise mode, while a reply streams, the HTML of its finished paragraphs (up to the last blank line outside code fences, lists, quotes and tables) is kept, so markdown and the sanitizer run on the paragraph being written. The first renders are compared with a whole conversion; on any difference the message goes back to whole renders, with a console warning. Dropped when the generation ends.`, { sub: true })}
        </div>
        ${feature('rpk_persist', t`⑤ Save results in the browser (persistent cache)`, t`Stores each displayed message's result in the browser's IndexedDB (not in the chat file any more), so reopening the chat skips the work. Keyed by the chat and a hash of the message; recomputed automatically when a script, a name or a markdown setting changes. Beyond the size under Limits the results stored longest ago are dropped first. With ⑨ on, the finished HTML is stored, so markdown is skipped too. Results an older version wrote into the chat file are still read, never written.`, { labelId: 'rpk_persist_label' })}
        <div class="rpk-feature-group">
        ${feature('rpk_fastPath', t`⑥ Replace without SillyTavern's callback (fast path)`, t`When a script's replacement has no macros, the browser's own template replacement is used instead of SillyTavern's per-match callback, where most of the replacer time goes. The first runs of every script are compared with SillyTavern's result; on any difference the script goes back to the callback.`)}
        ${feature('rpk_fastPathStatic', t`Also for replacements with {{user}}, {{char}}, {{persona}} or {{group}}`, t`Their values hold for a whole message render, so the template is finished per name set and verified the same way (display renders only).`, { sub: true })}
        </div>
        ${feature('rpk_fuse', t`⑦ Fuse: skip very long inputs for risky patterns`, t`A pattern the analyzer flags for catastrophic backtracking is not run on inputs longer than the limit under Limits (20,000 characters by default): that text is shown as it is. Off by default, as it changes the result.`)}
        ${feature('rpk_breaker', t`⑧ Circuit breaker: turn off a script that keeps running long`, t`After the set number of runs over the set time (3 runs over 500 ms by default), the script is skipped for the rest of the session, with an Undo in the toast and in the table. The script itself is never changed. Off by default.`)}
        ${feature('rpk_htmlMemo', t`⑨ Reuse the formatted HTML (HTML cache)`, t`When a message is rendered again unchanged (swipes, re-renders, scrolling back), the HTML made last time is reused: regex scripts and markdown are both skipped, only the sanitizer runs. Memory-only, limited under Limits; with ⑤ on, the HTML is saved in the browser's IndexedDB too. A message whose text, scripts, names or markdown settings changed is formatted again.`, { labelId: 'rpk_htmlMemo_label' })}
      </div>
      <div class="rpk-note" id="rpk_persist_note"></div>
      <div class="rpk-note" id="rpk_usage"></div>

      <details class="rpk-limits" data-section="limits">
        <summary>${t`Limits`}</summary>
        <div class="rpk-grid">
          ${limit('memoMaxEntries', t`③ Cache entries`, t`Oldest results are dropped beyond this many.`)}
          ${limit('memoMaxLen', t`③ Longest input to cache (characters)`, t`Longer inputs are not cached.`)}
          ${limit('memoMaxMB', t`③ Cache memory (MB)`, t`Oldest results are dropped beyond this estimated size (2 bytes per character of input and output).`)}
          ${limit('memoHashKeys', t`③ Key the cache by a hash of the input`, t`Keeps a 64-bit hash of each input instead of the input: about half the memory for long chats, at the cost of hashing every input. A collision (two same-length inputs with the same hash) would return the other input's result; with 64 bits that takes billions of inputs.`, 'checkbox')}
          ${limit('persistMaxLen', t`⑤ Longest result to save (characters)`, t`Longer display results are not saved.`)}
          ${limit('persistDbMaxMB', t`⑤ Saved results, all chats (MB)`, t`Beyond this estimated size the results stored longest ago are dropped first, whichever chat they belong to. Stored in the browser's IndexedDB, not in the chat file.`)}
          ${limit('streamingThrottleMs', t`Compromise interval (ms)`)}
          ${limit('fuseLen', t`⑦ Fuse: longest input a risky pattern runs on (characters)`)}
          ${limit('breakerMs', t`⑧ Breaker: a run counts as long over (ms)`)}
          ${limit('breakerCount', t`⑧ Breaker: long runs that turn the script off`)}
          ${limit('htmlMemoMaxEntries', t`⑨ HTML cache entries`, t`Oldest formatted messages are dropped beyond this many.`)}
          ${limit('htmlMemoMaxMB', t`⑨ HTML cache memory (MB)`, t`Oldest formatted messages are dropped beyond this estimated size.`)}
          ${limit('loadHintMs', t`Hint about "# Messages to Load" when opening a chat takes longer than (ms)`, t`Shown once per session as a toast.`)}
          ${limit('autoMeasure', t`Measure automatically when a chat opens`, t`Runs "Measure on this chat" once after a chat opens.`, 'checkbox')}
          ${limit('lint', t`Lint the scripts`, t`Missing g, group references the pattern cannot fill, double escapes, browser support, duplicate patterns. Shown under Lint; a fix is applied only when you confirm it.`, 'checkbox')}
          ${limit('listBadges', t`Show each script's cost in the Regex extension's list`, t`A chip after the script name: total ms, share of all regex time, and the marks of the table.`, 'checkbox')}
        </div>
      </details>

      <div class="rpk-buttons">
        <div class="menu_button" id="rpk_measure" title="${esc(t`Re-renders this chat twice, with the features off and on, and shows the real difference. Runs in small steps, so the page stays usable.`)}">${t`Measure on this chat`}</div>
        <div class="menu_button" id="rpk_copy">${t`Copy report`}</div>
        <div class="menu_button rpk-minor" id="rpk_copy_json" title="${esc(t`Copy the report as JSON`)}">JSON</div>
        <div class="menu_button rpk-minor" id="rpk_copy_csv" title="${esc(t`Copy the table as CSV`)}">CSV</div>
        <div class="menu_button" id="rpk_reset">${t`Reset stats`}</div>
        <div class="menu_button" id="rpk_refresh">${translate('Refresh', 'rpk_refresh')}</div>
        <div class="menu_button" id="rpk_clear_persist">${t`Clear saved results (this chat)`}</div>
        <div class="menu_button" id="rpk_reset_settings" title="${esc(t`Turns every feature and limit back to its default.`)}">${t`Reset settings`}</div>
      </div>
      <div class="rpk-note rpk-measured" id="rpk_measure_result"></div>

      <div class="rpk-table-head">
        <h4 class="rpk-section">${t`Per-script measurements (slowest first)`}</h4>
        <input type="text" class="text_pole" id="rpk_filter" placeholder="${esc(t`Filter by name`)}" title="${esc(t`Shows only the scripts whose name contains this. Click a column header to sort by it, again to flip the direction.`)}">
      </div>
      <div class="rpk-table-wrap">
        <table class="rpk-table" id="rpk_table">
          <thead>${headerHtml()}</thead>
          <tbody></tbody>
        </table>
      </div>
      <details class="rpk-lint" data-section="lint">
        <summary>${t`Lint`} <span class="rpk-dim" id="rpk_lint_count"></span></summary>
        <ul id="rpk_lint_list"></ul>
      </details>
      <details class="rpk-tips" data-section="legend">
        <summary>${t`How to read the table`}</summary>
        <ul>
          <li>${t`Rows are sorted by total time. A highlighted row takes half or more of all regex time: fixing or turning it off helps the most.`}</li>
          <li>${t`<b>Runs</b> are real regex executions; <b>Skips</b> and <b>Hits</b> are runs avoided by ② and ③. A script with 0 runs and many skips never had to run at all.`}</li>
          <li>${t`<b>Replacer</b> is the part of Total ms spent in the replacement; if it is large, the replacement (macros) is slow, not the pattern.`}</li>
          <li>${t`Marks after a name: <code>(a+)+</code> exponential backtracking (a nested quantifier or an alternation whose branches overlap; hover for the reason and a rewrite), <code>a*a*</code> polynomial backtracking (adjacent overlapping quantifiers), <code>⚡</code> one run over ${SPIKE_MS} ms, <code>∅</code> ran ${INEFFECTIVE_RUNS}+ times without ever matching, <code>⇅</code> an earlier script removes what this one looks for (order conflict), <code>fuse</code> long inputs skipped by ⑦, <code>off</code> turned off by ⑧ (click to turn it back on).`}</li>
          <li>${t`Click a row to open the script in the Regex extension; the stopwatch re-renders this chat without the script and shows the time it costs, the power icon turns it off.`}</li>
        </ul>
      </details>

      <details class="rpk-tips" data-section="tips">
        <summary>${t`What SillyTavern's own settings can do`}</summary>
        <ul>
          <li>${t`<b>User Settings → "# Messages to Load"</b>: how many messages are rendered (= regex applied) when a chat opens. 0 = all. 50–100 makes loading much faster.`}</li>
          <li>${t`<b>User Settings → "Streaming FPS"</b>: screen updates per second while streaming. Every update runs all display regexes, so 10–15 reduces lag.`}</li>
          <li>${t`Turn on <b>"Only Format Display"</b> for display scripts and <b>"Only Format Prompt"</b> for prompt scripts. Scripts with neither run when a message is saved and are not skipped while streaming.`}</li>
        </ul>
      </details>
    </div>
  </div>
</div>`;

// checkbox id -> setting: #rpk_<setting>, but for ④'s first two
const TOGGLES = { rpk_streaming: 'streamingSkip', rpk_stream_throttle: 'streamingThrottle' };
for (const key of ['profiler', 'profilerSampling', 'timeReplacer', 'adaptive', 'frameStats', 'prefilter', 'memo', 'memoStatic', 'memoPostHoc', 'fastPath', 'fastPathStatic', 'htmlMemo', 'streamingIncremental', 'streamingParagraphCache', 'persist', 'fuse', 'breaker', 'memoHashKeys', 'autoMeasure', 'lint', 'listBadges']) TOGGLES['rpk_' + key] = key;
// setting -> [min, max]
const LIMITS = { memoMaxEntries: [0, 1e6], memoMaxLen: [0, 1e7], memoMaxMB: [0, 4096], htmlMemoMaxEntries: [0, 1e6], htmlMemoMaxMB: [0, 4096], persistMaxLen: [0, 1e8], persistDbMaxMB: [1, 4096], streamingThrottleMs: [50, 60000], fuseLen: [1000, 1e7], breakerMs: [50, 60000], breakerCount: [1, 100], loadHintMs: [100, 600000] };

const RENDER_MIN_MS = 500; // the panel re-renders at most this often
let ui = null; // panel elements, cached by bindUi()
const rendered = new WeakMap();

/** Assigns el[prop] only when the value changed. */
function setContent(el, value, prop = 'innerHTML') {
    if (rendered.get(el) === value) return;
    rendered.set(el, value);
    el[prop] = value;
}

/** The Literal cell's tooltip: why there is no literal, and the shortest possible match. */
const litTitle = (r, lit) => [
    !lit && needleReason(r),
    r.needle?.minLen && t`Shortest possible match: ${r.needle.minLen} characters. ② skips shorter messages.`,
].filter(Boolean).join('\n');
/** A key figure in the summary; the tests read it by its key. */
const fig = (key, value) => `<b data-k="${key}">${value}</b>`;
const dim = (html) => `<span class="rpk-dim">${html}</span>`;
const editIcon = () => ` <span class="rpk-edit fa-solid fa-pencil" title="${esc(t`Open in the Regex extension`)}"></span>`;

/** The display pipeline as a stacked bar; empty until something was timed. */
function pipeBarHtml(p) {
    if (!p.available || !p.full || p.totalMs <= 0) return '';
    const seg = (cls, pct, ms, label) => `<span class="rpk-pipe-seg rpk-pipe-${cls}" style="width:${pct}%" title="${esc(`${label}: ${fmtMs(ms)} ms (${pct}%)`)}" data-k="pipe-${cls}" data-pct="${pct}">${pct >= 12 ? `${esc(label)} ${pct}%` : ''}</span>`;
    return `<div class="rpk-pipe-bar">${seg('regex', p.regexPct, p.regexMs, t`regex`)}${seg('markdown', p.markdownPct, p.markdownMs, t`markdown`)}${seg('sanitize', p.sanitizePct, p.sanitizeMs, t`sanitize`)}${seg('hook', p.hookPct, p.hookMs, t`cache lookups`)}</div>`
        + `<div class="rpk-pipe-legend rpk-dim">${esc(t`One display render: ${fmtMs(p.avgPassMs)} ms on average; the regex stage (what ②③④⑥ can save) is ${p.regexPct}% of it.`)}</div>`;
}

function renderPanel() {
    if (!ui) return;
    const s = buildSummary();
    const c = s.counts;
    const lines = [];
    lines.push(t`${c.active} of ${c.total} scripts active (${typeCounts(c)}). ${s.chatLen} messages in this chat.`);
    if (c.noNeedle || c.redos) {
        lines.push(dim(t`Patterns to look at: no fixed text ${c.noNeedle}, backtracking risk ${c.redos} (exponential ${c.redosExp}).`));
    }
    const breakdown = t`prefilter ${s.skipped}, cache ${s.hits}, streaming ${s.streamSkipped}`
        + (htmlStageAvailable ? ', ' + t`HTML cache ${s.htmlBypass}` : '') + (persistAvailable ? ', ' + t`saved results ${s.bypass - s.htmlBypass}` : '');
    if (!s.calls && !s.skips && !s.bypass) {
        lines.push(dim(t`No runs measured yet. Render a message or reopen the chat.`));
    } else {
        lines.push(t`Regex ran ${fig('runs', s.calls)} times, ${fig('ms', fmtMs(s.total) + ' ms')} in total.`);
        lines.push(s.calls
            ? t`${fig('skipped', s.skips + s.bypass)} runs were skipped (${breakdown}), saving about ${fig('saved', fmtMs(s.saved) + ' ms')}.`
            : t`${fig('skipped', s.skips + s.bypass)} runs were skipped (${breakdown}). The time saved is known once some runs have been measured.`);
        if (s.fast) lines.push(dim(fastText(s.fast)));
    }
    if (s.pipe.available && s.pipe.full) {
        lines.push(dim(esc(pipeText(s.pipe)) + '.') + (s.pipe.htmlHits ? ` ${esc(htmlText(s.pipe))}.` : '') + (s.pipe.paragraph.passes ? ' ' + dim(esc(paraText(s.pipe)) + '.') : ''));
        if (s.pipe.light) lines.push(dim(t`The regex stage is under 2% of the renders here: ②③④ have little to save, so the profiler times 1 run in 64. What helps more is under "What SillyTavern's own settings can do".`));
    }
    const felt = feelText(s.feel);
    if (felt || s.pipe.loadMs) {
        lines.push(dim(esc([felt, s.pipe.loadMs ? t`opening this chat rendered for ${fmtMs(s.pipe.loadMs)} ms` : ''].filter(Boolean).join('; ')) + '.'));
    }
    if (s.top && s.calls > 0) {
        lines.push(t`Slowest: <b>${esc(s.top.name)}</b>, ${s.topShare.toFixed(0)}% of the time.` + (s.topShare >= 50 ? ' ' + t`Turning it off or fixing it helps the most.` : ''));
    }
    for (const c of conflicts.values()) {
        lines.push(t`Order conflict: <b>${esc(c.earlier.name)}</b> runs first and removes what <b>${esc(c.later.name)}</b> looks for (${c.count} times). Swap them or merge them.`);
    }
    if (s.ineffective.length) {
        lines.push(t`Never matched in ${INEFFECTIVE_RUNS}+ runs: <b>${esc(s.ineffective.join(', '))}</b>. Consider turning them off.`);
    }
    if (s.invalid.length) {
        lines.push(`<span class="rpk-warn">${t`Invalid patterns (${s.invalid.length}), doing nothing: ${s.invalid.map(i => `<b>${esc(i.name)}</b> (${esc(i.error)})`).join('; ')}`}</span>`);
    }
    if (!patched) lines.push(`<span class="rpk-warn">${t`⚠ Could not patch the regex engine — this SillyTavern version is not supported.`}</span>`);
    checkWrapper();
    if (wrapperWarning) lines.push(`<span class="rpk-warn">⚠ ${esc(wrapperWarning)}</span>`);
    lines.push(`<span class="rpk-dim rpk-since">${t`Since ${new Date(statsSince).toLocaleTimeString()}`}</span>`);
    const summary = lines.map(l => `<p>${l}</p>`).join('');
    setContent(ui.summary, summary);
    setContent(ui.pipe, pipeBarHtml(s.pipe));

    setContent(ui.thead, headerHtml());
    const ranks = new Map(s.rows.map((r, i) => [r, i + 1])); // by total time, whatever the sort
    let rows = nameFilter ? s.rows.filter(r => r.name.toLowerCase().includes(nameFilter)) : s.rows;
    if (sortBy) {
        const key = SORT_KEYS[sortBy];
        rows = rows.map((r, i) => [key(r, i), r]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0) * (sortDesc ? -1 : 1)).map(([, r]) => r);
    }
    ui.rows = rows.slice(0, 60);
    setContent(ui.tbody, ui.rows.map((r, i) => {
        const cls = s.total > 0 && r.totalMs / s.total >= 0.5 ? 'rpk-hot' : '';
        const lit = fmtNeedles(r);
        const m = rowMeasures.get(r);
        const actions = (m ? `<span class="rpk-row-ms" title="${esc(t`Without this script the chat renders in ${fmtMs(m.without)} ms instead of ${fmtMs(m.with)} ms (③, ⑤ and ⑨ off)`)}">${m.with >= m.without ? '−' : '+'}${fmtMs(Math.abs(m.with - m.without))} ms</span>` : '')
            + `<span class="rpk-measure-row fa-solid fa-stopwatch" title="${esc(t`Measure this chat without this script`)}"></span>`
            + (r.spike ? ` <span class="rpk-repro fa-solid fa-copy" title="${esc(t`Copy a repro of the newest spike (pattern, input length and head) for a bug report`)}"></span>` : '')
            + (r.ids.length ? editIcon() + ` <span class="rpk-off fa-solid fa-power-off" title="${esc(t`Turn this script off`)}"></span>` : '');
        return `<tr class="${cls}${r.ids.length ? ' rpk-script' : ''}" title="${esc(r.src)}" data-i="${i}">
          ${td('rank', ranks.get(r))}${td('name', esc(r.name) + warnings(r, true).join(''))}
          ${td('runs', r.calls)}${td('total', fmtMs(r.totalMs))}${td('avg', fmtMs(avgMs(r)))}${td('max', fmtMs(r.maxMs))}
          ${td('repl', fmtMs(r.replMs))}${td('matched', r.matched)}${td('changed', r.changed)}
          ${td('skips', r.skipped)}${td('hits', r.hits)}${td('lit', lit ? esc(lit) : dim(t`none`), 'rpk-lit', litTitle(r, lit))}
          ${td('act', actions, 'rpk-act')}
        </tr>`;
    }).join('') || `<tr><td colspan="13" class="rpk-dim rpk-empty">${nameFilter && s.rows.length ? t`No script name contains "${esc(nameFilter)}".` : t`No runs measured yet. Render a message or reopen the chat.`}</td></tr>`);

    setContent(ui.note, !persistAvailable
        ? t`⑤, the compromise mode and the name-macro options of ③ and ⑥ need a SillyTavern with the MessageFormatter hooks.`
        : settings.persist && persistDbFailed ? t`⑤: IndexedDB is not available in this browser; only results an older version wrote into chat files are read.`
            : settings.persist ? t`⑤ is on: display results are saved in the browser (IndexedDB) and served when the chat opens again. Changing a script invalidates them automatically.` : '', 'textContent');
    setContent(ui.usage, s.usage, 'textContent');
    setContent(ui.measure, measured ? `<p>${esc(measureText(measured))}</p><p class="rpk-dim">${esc(slowestText(measured))}</p>` + measureVerdict(measured).map(l => `<p class="rpk-verdict">${esc(l)}</p>`).join('') : '');

    const lint = lintRows();
    ui.lint = lint;
    setContent(ui.lintCount, lint.length ? `(${lint.length})` : '', 'textContent');
    setContent(ui.lintList, lint.length ? lint.map((row, i) => `<li data-rule="${row.rule}" data-script="${esc(row.info.name)}" data-i="${i}"><b>${esc(row.info.name)}</b>: ${esc(row.text)}`
        + (row.fix ? ` <span class="menu_button rpk-fix" title="${esc(t`Shows the change and saves it through the regex engine when you confirm`)}">${esc(row.fix.label)}</span>` : '')
        + (row.info.ids.length ? editIcon() : '') + '</li>').join('')
        : `<li class="rpk-dim">${settings.lint ? t`Nothing to report` : t`Lint is off (Limits)`}</li>`);
}

/**
 * Turns a script off through the engine, or opens it in the editor. Opening has no API, so the Regex drawer's rows are
 * used (id = the script's, .edit_existing_regex), as is their .regex-toggle-on switch without saveScriptsByType.
 */
async function scriptAction(r, off) {
    if (!off || !await saveScript(r.ids, { disabled: true })) {
        const rows = r.ids.map(id => document.getElementById(id));
        if (!rows[0]) {
            toastr.warning(t`"${r.name}" is not in the Regex extension's list.`);
            return;
        }
        if (!off) {
            rows[0].querySelector('.edit_existing_regex')?.click();
            return;
        }
        rows.forEach(row => row?.querySelector('.regex-toggle-on')?.click());
    }
    toastr.info(t`Turned off: ${r.name}`);
}

function bindUi() {
    const root = document.getElementById('regex_perf_kit');
    const find = (sel) => root.querySelector(sel);
    ui = { summary: find('#rpk_summary'), pipe: find('#rpk_pipe'), thead: find('#rpk_table thead'), tbody: find('#rpk_table tbody'), note: find('#rpk_persist_note'), usage: find('#rpk_usage'), measure: find('#rpk_measure_result'), lintList: find('#rpk_lint_list'), lintCount: find('#rpk_lint_count'), rows: [], lint: [] };

    /** Shows the current settings in the toggles and limit fields (at start and after a reset). */
    const syncControls = () => {
        for (const [id, key] of Object.entries(TOGGLES)) find('#' + id).checked = !!settings[key];
        for (const key of Object.keys(LIMITS)) find('#rpk_' + key).value = settings[key];
    };
    /** What flipping a toggle does beyond the setting, by hand or through "Reset settings". */
    const afterToggle = (key) => {
        const on = !!settings[key];
        if ((key === 'memo' && !on) || key === 'memoHashKeys') clearMemo(); // entries keyed the other way are useless
        if (key === 'htmlMemo' && !on) htmlMemo.clear();
        if (key === 'breaker' && !on) for (const s of stats.values()) if (s.tripped) untrip(s); // off: nothing stays skipped
        if (key === 'frameStats' && !on) resetFeel(); // off: the figures leave the summary
        if (key === 'listBadges') updateListBadges(); // off: the chips leave at once, not at the list's next rebuild
    };
    for (const [id, key] of Object.entries(TOGGLES)) {
        const el = find('#' + id);
        el.addEventListener('change', () => {
            settings[key] = el.checked;
            saveSettingsDebounced();
            afterToggle(key);
            renderPanel();
        });
    }
    if (!persistAvailable) find('#rpk_persist').disabled = find('#rpk_stream_throttle').disabled = find('#rpk_memoStatic').disabled = find('#rpk_streamingIncremental').disabled = find('#rpk_fastPathStatic').disabled = true;
    if (!htmlStageAvailable) find('#rpk_htmlMemo').disabled = find('#rpk_adaptive').disabled = find('#rpk_streamingParagraphCache').disabled = true;

    for (const [key, [min, max]] of Object.entries(LIMITS)) {
        const el = find('#rpk_' + key);
        Object.assign(el, { min, max });
        el.addEventListener('change', () => {
            const v = Number(el.value);
            if (el.value.trim() !== '' && Number.isFinite(v)) settings[key] = Math.min(max, Math.max(min, Math.round(v)));
            el.value = settings[key];
            saveSettingsDebounced();
            trimMemo();
            htmlMemo.trim(settings.htmlMemoMaxEntries, settings.htmlMemoMaxMB * MB);
            if (key === 'persistDbMaxMB' && !persistFlushTimer) persistFlushTimer = setTimeout(flushPersisted, 0); // evicts beyond the new limit
            renderPanel();
        });
    }

    syncControls();

    // Open sections are remembered (settings.ui.<section>)
    const uiState = (settings.ui ||= {});
    for (const d of root.querySelectorAll('details[data-section]')) {
        const name = d.dataset.section;
        if (name in uiState) d.open = !!uiState[name];
        d.addEventListener('toggle', () => {
            if (uiState[name] === d.open) return;
            uiState[name] = d.open;
            saveSettingsDebounced();
        });
    }

    find('#rpk_reset_settings').addEventListener('click', () => {
        const was = Object.fromEntries(Object.values(TOGGLES).map(key => [key, !!settings[key]]));
        Object.assign(settings, defaultSettings); // settings.ui (open sections) is not a feature setting and stays
        syncControls();
        for (const key of Object.values(TOGGLES)) if (!!settings[key] !== was[key]) afterToggle(key);
        clearMemo();
        htmlMemo.clear();
        if (persistAvailable && !persistFlushTimer) persistFlushTimer = setTimeout(flushPersisted, 0); // evicts beyond the default size limit
        saveSettingsDebounced();
        renderPanel();
        toastr.info(t`Settings restored to their defaults.`);
    });
    find('#rpk_refresh').addEventListener('click', () => { markDirty(); renderPanel(); });
    find('#rpk_reset').addEventListener('click', () => { resetStats(); renderPanel(); toastr.info(t`Stats reset.`); });
    for (const [id, build] of [['rpk_copy', buildReportText], ['rpk_copy_json', () => JSON.stringify(buildReportData(), null, 2)], ['rpk_copy_csv', buildReportCsv]]) {
        find('#' + id).addEventListener('click', () => copyText(build, t`Report copied to the clipboard.`));
    }
    find('#rpk_clear_persist').addEventListener('click', async () => {
        const n = await clearPersistedCache();
        toastr.info(t`Removed ${n} persistent cache entries.`);
        renderPanel();
    });
    /** Runs a measurement after the toast had a moment to paint; not during a stream, not twice at a time. */
    const measuring = async (fn) => {
        if (liveStream()) {
            toastr.warning(t`Wait until the generation finishes.`);
            return;
        }
        if (measureBusy) return;
        toastr.info(t`Measuring...`);
        await new Promise(resolve => setTimeout(resolve, 20));
        await fn();
    };
    find('#rpk_measure').addEventListener('click', () => measuring(async () => {
        if (await measureNow()) toastr.success(measureText(measured));
    }));
    ui.thead.addEventListener('click', (e) => {
        const col = e.target.closest('th')?.dataset.col;
        if (!SORT_KEYS[col]) return;
        if (sortBy === col) sortDesc = !sortDesc;
        else [sortBy, sortDesc] = [col, col !== 'name' && col !== 'lit' && col !== 'rank']; // numbers largest first, text A to Z
        renderPanel();
    });
    find('#rpk_filter').addEventListener('input', (e) => {
        nameFilter = e.target.value.trim().toLowerCase();
        renderPanel();
    });
    ui.tbody.addEventListener('click', (e) => {
        if (e.target.closest('.rpk-undo, .rpk-open')) return; // the breaker's controls, see onTripControl()
        const r = ui.rows[e.target.closest('tr[data-i]')?.dataset.i];
        if (!r) return;
        if (e.target.closest('.rpk-measure-row')) {
            measuring(async () => {
                const m = await measureChat(r);
                if (m) rowMeasures.set(r, m);
                renderPanel();
            });
        } else if (e.target.closest('.rpk-spike')) { // ⚡: scroll to the message of the newest spike
            const id = e.target.closest('.rpk-spike').dataset.mesid;
            if (id) document.querySelector(`.mes[mesid="${id}"]`)?.scrollIntoView({ block: 'center' });
        } else if (e.target.closest('.rpk-repro')) {
            if (r.spike) copyText(`${r.src}\n${r.spike.len} chars\n${JSON.stringify(r.spike.head)}`);
        } else if (r.ids.length) {
            scriptAction(r, !!e.target.closest('.rpk-off'));
        }
    });
    ui.lintList.addEventListener('click', async (e) => {
        const row = ui.lint[e.target.closest('li[data-i]')?.dataset.i];
        if (!row) return;
        if (e.target.closest('.rpk-fix')) {
            const ok = await confirmPopup(`<p>${esc(t`Change the pattern of "${row.info.name}"?`)}</p><pre class="rpk-report">${esc(String(row.info.find ?? ''))}</pre><p>→</p><pre class="rpk-report">${esc(row.fix.patch.findRegex)}</pre>`);
            if (!ok) return;
            if (await saveScript(row.info.ids, row.fix.patch)) toastr.success(t`Saved: ${row.info.name}`);
            else toastr.warning(t`This SillyTavern cannot save scripts from here: edit it in the Regex extension.`);
            renderPanel();
        } else if (e.target.closest('.rpk-edit')) {
            scriptAction(row.info, false);
        }
    });

    // auto-refresh when the stats changed, at most every RENDER_MIN_MS, only while the drawer is open; the cost chips
    // follow the same beat
    const content = find('.inline-drawer-content');
    setInterval(() => {
        installListBadges();
        if (!statsDirty) return;
        if (settings.listBadges) updateListBadges();
        if (content.offsetParent === null) return;
        statsDirty = false;
        requestAnimationFrame(renderPanel);
    }, RENDER_MIN_MS);
}

/** Copies text (or what a function returns) to the clipboard, with a toast either way. */
async function copyText(text, done = t`Copied to the clipboard.`) {
    try {
        await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
        toastr.success(done);
    } catch {
        toastr.warning(t`Could not copy — use the /regexperf command to see the report in a popup.`);
    }
}

function registerSlash() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE, callGenericPopup, POPUP_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'regexperf',
        callback: async (_named, unnamed) => {
            const [, verb = '', rest = ''] = /^(\S*)\s*([\s\S]*)$/.exec(String(unnamed ?? '').trim());
            const arg = verb.toLowerCase();
            if (arg === 'reset') {
                resetStats();
                renderPanel();
                return t`Stats reset`;
            }
            if (arg === 'json') return JSON.stringify(buildReportData(), null, 2);
            if (arg === 'csv') return buildReportCsv();
            if (arg === 'off') return turnOffByName(rest);
            if (arg === 'measure') {
                if (liveStream()) return t`Wait until the generation finishes.`;
                return (await measureNow()) ? measureText(measured) : t`Nothing to measure: the chat is empty.`;
            }
            const text = buildReportText();
            if (arg !== 'text' && typeof callGenericPopup === 'function') {
                await callGenericPopup(`<pre class="rpk-report">${esc(text)}</pre>`, POPUP_TYPE?.TEXT ?? 1, '', { wide: true, large: true, allowVerticalScrolling: true });
            }
            return text;
        },
        unnamedArgumentList: SlashCommandArgument ? [
            SlashCommandArgument.fromProps({
                description: 'reset | text | json | csv | measure | off <script name>',
                typeList: [ARGUMENT_TYPE?.STRING ?? 'string'],
                isRequired: false,
            }),
        ] : [],
        helpString: t`<div>Shows the Regex Perf Kit report in a popup. <code>/regexperf reset</code> resets the stats, <code>/regexperf text</code> returns it as text, <code>/regexperf json</code> and <code>/regexperf csv</code> as data, <code>/regexperf measure</code> re-renders this chat with the features off and on, <code>/regexperf off &lt;script name&gt;</code> turns a script off.</div>`,
    }));
}

// ---- Init ----

if (extensionSettings.disabledExtensions?.includes('regex')) {
    console.log('[RegexPerf] the built-in Regex extension is disabled: its scripts do not run until it is turned on; the panel and the caches stay ready.');
}
patchProvider();
// SillyTavern marks the page once a generation is underway (deactivateSendButtons(): body[data-generating]). A start
// it gives up on before that (no backend connection, the server unreachable) emits no end event: it ends after a grace
// period, and one that gets underway later (a slow server) starts again when the mark appears.
const START_GRACE_MS = 3000;
function underway() {
    return globalThis.document?.body?.dataset.generating === 'true' || !!liveStream();
}
let startSeq = 0;
function startGeneration() {
    checkWrapper();
    generating = true;
    clearStreamCaches();
    startFrames();
    const seq = ++startSeq;
    setTimeout(() => { if (seq === startSeq && generating && !underway()) endGeneration(); }, START_GRACE_MS);
}
function endGeneration() {
    generating = false;
    clearStreamCaches();
    for (const w of wrapped.values()) w._meta?.inc.clear(); // ④ holds the streamed text
    rerenderSkipped();
}
eventSource.on(START_EVENT, (_type, _params, dryRun) => { if (!dryRun) startGeneration(); });
for (const event of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) eventSource.on(event, endGeneration);
if (typeof MutationObserver === 'function' && globalThis.document?.body) {
    new MutationObserver(() => { if (!generating && underway()) startGeneration(); })
        .observe(document.body, { attributes: true, attributeFilter: ['data-generating'] });
}
/**
 * ④: a stream that ended in an error has no final render, so the message would keep its raw live text: rendered once
 * more, after the generation's own clean-up.
 */
function rerenderSkipped() {
    const id = streamSkippedMsg;
    if (id === null) return;
    setTimeout(() => {
        if (streamSkippedMsg !== id) return; // its final render came after all
        streamSkippedMsg = null;
        const { chat, updateMessageBlock } = ctx();
        const update = updateMessageBlock ?? st.updateMessageBlock;
        if (chat?.[id] && typeof update === 'function') {
            try { update(id, chat[id]); } catch (e) { console.warn('[RegexPerf] ④ could not render the stopped message again', e); }
        }
    }, 0);
}
observeLongTasks();
let loadHintShown = false; // once per session
for (const event of [event_types.CHARACTER_MESSAGE_RENDERED, event_types.USER_MESSAGE_RENDERED]) {
    if (event) eventSource.on(event, () => { chatLen++; });
}
eventSource.on(event_types.CHAT_CHANGED, () => {
    markDirty();
    clearStreamCaches();
    const context = ctx();
    loadPersisted(context);
    chatLen = context.chat?.length ?? 0;
    const now = performance.now();
    // the render burst that just ended: timed display passes, else profiled regex calls
    const [burstEnd, burstFrom] = htmlStageAvailable ? [passLastEnd, passBurstStart] : [lastCall, burstStart];
    const loadMs = now - burstEnd < BURST_GAP_MS ? burstEnd - burstFrom : 0;
    pipe.loadMs = loadMs;
    if (!loadHintShown && loadMs > settings.loadHintMs) {
        loadHintShown = true;
        toastr.info(t`Rendering this chat took ${(loadMs / 1000).toFixed(1)} s. A lower "# Messages to Load" (User Settings) opens chats faster.`, 'Regex Perf Kit', { timeOut: 15000 });
    }
    if (settings.autoMeasure && !liveStream()) {
        setTimeout(async () => { // once the page has settled
            if (!liveStream() && await measureNow()) toastr.info(measureText(measured), 'Regex Perf Kit');
        }, 500);
    }
});
// ⑤ best effort before the tab closes or hides: a tab killed at once can lose the last 200 ms of rows
const flushNow = () => { if (persistPending.size) flushPersisted(); };
globalThis.addEventListener?.('pagehide', flushNow);
globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); });
eventSource.on(event_types.SETTINGS_UPDATED, markDirty);
if (event_types.PRESET_CHANGED) eventSource.on(event_types.PRESET_CHANGED, markDirty);
eventSource.on(event_types.APP_READY, () => {
    try { installPersistHooks(); } catch (e) { console.warn('[RegexPerf] persist hooks failed', e); }
    if (persistAvailable) {
        loadPersisted(); // a chat may be open already
        watchChatClear();
    }
    try {
        const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (container) {
            container.insertAdjacentHTML('beforeend', settingsHtml());
            bindUi();
            document.addEventListener('click', onTripControl); // ⑧ Undo / Open script, in toasts and the table
            renderPanel();
        }
    } catch (e) { console.warn('[RegexPerf] UI init failed', e); }
    try { registerSlash(); } catch (e) { console.warn('[RegexPerf] slash command failed', e); }
    console.log('[RegexPerf] ready. patched=', patched, 'persistHooks=', persistAvailable);
});
