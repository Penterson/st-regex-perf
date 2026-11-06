/**
 * Regex Perf Kit — speeds up SillyTavern's built-in Regex extension without touching any regex script.
 *
 * The engine compiles every script pattern through RegexProvider.instance.get(). That method is patched to
 * return a RegExp subclass whose [Symbol.replace] (where String.prototype.replace() dispatches) adds
 * ① profiler, ② literal prefilter, ③ memo cache and ④ streaming skip of display-only scripts.
 * ST's MessageFormatter hooks add ⑤ a persisted display cache and ④'s compromise mode.
 * No ST core file is modified.
 */

// Namespace import: older engines lack getScriptsByType / SCRIPT_TYPES, and a missing named import fails to load.
import * as engine from '../../regex/engine.js';
import { regexFromString } from '../../../utils.js';

const { RegexProvider, getRegexScripts, getScriptsByType, SCRIPT_TYPES } = engine;
const EXTRA_KEY = 'regex_perf_cache';
const ctx = () => SillyTavern.getContext();
// Fixed for the session, so read once; live state (chat, names, the streaming processor) is read through ctx().
const { t, translate, extensionSettings, eventSource, event_types, getCurrentLocale, addLocaleData } = ctx();

// ---- Settings ----

// Chromium reports the device's memory class (GB, rounded), other browsers nothing: the memo's default size follows it.
const deviceMemory = Number(globalThis.navigator?.deviceMemory) || 0;

const defaultSettings = {
    profiler: true,
    profilerSampling: deviceMemory > 0 && deviceMemory <= 4, // ① past 1000 runs of a script, time 1 run in 8 and scale
    timeReplacer: true, // ① two more clock reads per match for the Replacer column
    prefilter: true,
    memo: true,
    memoStatic: true, // ③ also for scripts whose only macros are {{user}} {{char}} {{persona}} {{group}}: keyed by their values
    memoPostHoc: true, // ③ also for inputs with macro syntax outside the matched text
    fastPath: true, // ⑥ macro-free replacements run as a native string template instead of SillyTavern's callback
    memoMaxEntries: 3000,
    memoMaxLen: 20000,
    memoMaxMB: deviceMemory && deviceMemory <= 2 ? 16 : deviceMemory && deviceMemory <= 4 ? 32 : 64,
    streamingSkip: true,
    streamingThrottle: false, // ④ compromise mode: format the streamed message at most every streamingThrottleMs
    streamingThrottleMs: 500,
    persist: false,
    persistMaxLen: 60000,
    persistMaxMB: 8, // ⑤ per chat; beyond it, the oldest messages' results are dropped
    memoHashKeys: false, // ③ keyed by hash64(input) + length instead of the input: half the memory, see the Limits note
    autoMeasure: false, // run "Measure on this chat" once after a chat opens
    loadHintMs: 3000, // a chat whose first render takes longer gets a one-time hint about "# Messages to Load"
    fuse: false, // ⑦ risky patterns are not run on inputs longer than fuseLen (changes the result: off by default)
    fuseLen: 20000,
    breaker: false, // ⑧ a script with breakerCount runs over breakerMs is skipped for the session (off by default)
    breakerMs: 500,
    breakerCount: 3,
    lint: true, // checks on the scripts (missing g, group references, double escapes, browser support, duplicates), shown only
    listBadges: true, // a cost chip after each script's name in the Regex extension's own list
};

// ST keeps this object for the whole session, so it is resolved once instead of on every replace.
const settings = (extensionSettings.regex_perf_kit ||= {});
for (const [key, value] of Object.entries(defaultSettings)) {
    if (!Object.hasOwn(settings, key)) settings[key] = value;
}
// What the hot path reads. A measurement swaps in an object inheriting from settings with some features off, for the
// duration of one message's formatting, so the saved settings are never touched (and never saved by mistake).
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

/** Two independent 32-bit hashes of str in one pass (fnv1a and a multiply-xorshift mix), as one 64-bit key. */
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

// Set from GENERATION_STARTED until GENERATION_ENDED / GENERATION_STOPPED, so the exact check (which builds the
// whole getContext() object) only runs while a generation can be streaming. Without those events: always check.
let generating = !(event_types.GENERATION_STARTED && event_types.GENERATION_ENDED && event_types.GENERATION_STOPPED);

/** The streaming processor while a stream is live, else null. */
function liveStream() {
    if (!generating) return null;
    const sp = ctx().streamingProcessor;
    return sp && !sp.isFinished && !sp.isStopped ? sp : null;
}

// SillyTavern's macro syntax: {{...}} and the legacy <USER> <BOT> <CHAR> <GROUP> <CHARIFNOTGROUP> markers.
const MACRO = /{{|<(?:user|bot|char(?:ifnotgroup)?|group)>/i;
// Macros whose value holds for a whole message render: {{user}} {{char}} {{persona}} {{group}} and the legacy markers
// SillyTavern maps to them. A replacement or trim string using only these is memoized per value set (feature list 1.2);
// any other macro, known or not, keeps the script out of ③.
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

// Escapes for macro values inside an ESCAPED (substituteRegex 2) pattern, as SillyTavern's sanitizeRegexMacro does.
const REGEX_MACRO_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' };
const sanitizeRegexMacro = (x) => (x && typeof x === 'string'
    ? x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (c) => REGEX_MACRO_ESCAPES[c] ?? '\\' + c)
    : x);

const CONTROL_ESCAPES = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' };
const HEX_DIGITS = { u: 4, x: 2 }; // digits after \u and \x
const HEX = /^[0-9a-fA-F]+$/;
const ASCII_LETTER = /[a-zA-Z]/;
const BAIL = Symbol('bail');

// ② Literal presence per input: each literal (or case-insensitive check) gets a small id, and an input's answers are
// kept in an array by id, so a string flowing through every script is scanned once per literal. The last input needs
// no hashing; with keep (displayed messages, which re-render) the litCacheMax() most recent inputs up to the memo's
// length limit are remembered too. Save-time inputs never come back, so hashing them would cost more than it saves.
let chatLen = 0; // messages in the current chat: a re-render brings each displayed one back, so the cache grows with it
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
            if (!litSeen) {
                if (litCache.size >= litCacheMax()) litCache.delete(litCache.keys().next().value);
                litCache.set(str, litSeen = []);
            }
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
 * Parses a pattern once. Every match contains, for each of terms, at least one of its literals (a one-literal term
 * is a mandatory run, a longer one comes from an alternation) and is at least minLen UTF-16 units long; test(str, keep)
 * checks both (keep: remember this input's answers for a re-render). needles is the single best term, null with a
 * NEEDLE_REASONS code in reason when none is certain; nested flags an unbounded quantifier inside an unboundedly
 * repeated group, e.g. (a+)+.
 * Conservative: classes, class escapes, backreferences, lookarounds and modifier groups contribute no literal, and
 * patterns with the v flag or a case modifier ((?i:), (?-i:)) get nothing at all. Literals in groups that must match
 * join the surrounding run; an alternation yields one literal per branch, provided every branch has one.
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

    // Quantifier at i, with its lazy '?': {min, inf} or null.
    const quant = () => {
        let q = null;
        const c = source[i];
        if (c === '?' || c === '*' || c === '+') {
            q = { min: c === '+' ? 1 : 0, inf: c !== '?' };
            i++;
        } else if (c === '{') {
            const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i, i + 24));
            if (m) {
                q = { min: Number(m[1]), inf: m[3] === '' };
                i += m[0].length;
            }
        }
        if (q && source[i] === '?') i++;
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

    // {lit, len} for a literal character, {group, opaque, zero} for a group (zero: a lookaround, which consumes
    // nothing), {lit: null, len} for anything else; len is the least number of UTF-16 units the atom matches.
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
            let j = i + 1;
            if (source[j] === '^') j++;
            // In JS "[]" is an empty class and "[^]" matches anything: a ']' right after '[' closes it.
            while (j < n && source[j] !== ']') {
                if (source[j] === '\\') j++;
                j++;
            }
            i = j + 1;
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
                    const m = /^(?:<?[=!]|[a-z]*(?:-[a-z]*)?:)/.exec(source.slice(i, i + 16));
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

    // Summary of a sequence: pre/suf = literal run at its start/end, full = the whole sequence is one literal run,
    // best = best needle set inside it, terms = every term a match of it must satisfy, len = its least match
    // length, inf = it contains an unbounded quantifier.
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
            if (q?.inf) inf = true;
            if (a.group) {
                const g = a.group;
                if (!a.zero) len += g.len * reps;
                if (g.inf) {
                    inf = true;
                    if (q?.inf) nested = true;
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
        // (?i:) / (?-i:) groups: V8 (13.x) has been seen to match literals outside such a group case-insensitively
        // after many regexes ran in the same page, which the spec does not allow. Such patterns are left to the engine.
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
        // With the i flag, escaped copies of the literals under the pattern's i/u flags decide: they fold case exactly
        // like the pattern itself (toLowerCase() does not: σ/ς/Σ, µ/μ, ſ/s ...).
        const res = terms.map(set => new RegExp(set.map(s => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')).join('|'), u ? 'iu' : 'i'));
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
    // test(str, keep): keep remembers the input's answers for its next render (see litPresent)
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
 * Drops terms another term implies (a literal inside a longer mandatory literal, an alternation one of whose
 * literals is inside a mandatory one) and caps the count, so a check stays a few scans.
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

// ---- Catastrophic backtracking (feature list 1.5) ----

// Character-class overlap is approximated on a sample: ASCII plus a few other scripts and an astral character.
const REDOS_SAMPLE = [...Array.from({ length: 128 }, (_, i) => String.fromCharCode(i)), '가', '한', '中', 'é', 'ß', 'Σ', '😀', '　', ' '];
const charSets = new Map(); // atom source + flags -> the sample characters it matches on its own
function charSet(src, flags) {
    const key = src + '\u0000' + flags;
    let s = charSets.get(key);
    if (!s) {
        s = new Set();
        try {
            const re = new RegExp('^(?:' + src + ')$', flags.replace(/[gyd]/g, ''));
            for (const c of REDOS_SAMPLE) if (re.test(c)) s.add(c);
        } catch { /* nothing matches */ }
        if (charSets.size >= 4000) charSets.delete(charSets.keys().next().value);
        charSets.set(key, s);
    }
    return s;
}
const overlaps = (a, b) => {
    for (const c of a) if (b.has(c)) return true;
    return false;
};

/**
 * Parses a pattern into alternatives of sequences of {atom, q}: atom {kind: 'char', src} | {kind: 'group', alts, look,
 * src} | {kind: 'anchor'} | {kind: 'back'}; q = {min, max, lazy} or null. Throws BAIL on syntax it does not understand.
 */
function parseRegex(source, flags) {
    const u = flags.includes('u') || flags.includes('v');
    const n = source.length;
    let i = 0;
    const quant = () => {
        const c = source[i];
        let q = null;
        if (c === '?' || c === '*' || c === '+') {
            q = { min: c === '+' ? 1 : 0, max: c === '?' ? 1 : Infinity };
            i++;
        } else if (c === '{') {
            const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i, i + 24));
            if (m) {
                q = { min: Number(m[1]), max: m[2] ? (m[3] === '' ? Infinity : Number(m[3])) : Number(m[1]) };
                i += m[0].length;
            }
        }
        if (q && source[i] === '?') {
            q.lazy = true;
            i++;
        }
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
            let j = i + 1;
            if (source[j] === '^') j++;
            while (j < n && source[j] !== ']') {
                if (source[j] === '\\') j++;
                j++;
            }
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
                    const m = /^(?:<?[=!]|[a-z]*(?:-[a-z]*)?:)/.exec(source.slice(i, i + 16));
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
        if (c === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(i, i + 24))) throw BAIL;
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

/** Sample characters a sequence can start with: the leading optional items' joined with the first mandatory one's. */
function firstOfSeq(items, flags) {
    const s = new Set();
    for (const { atom, q } of items) {
        if (atom.kind === 'anchor' || (atom.kind === 'group' && atom.look)) continue;
        for (const c of firstOfAtom(atom, flags)) s.add(c);
        const optional = q ? q.min === 0 : false;
        const canBeEmpty = atom.kind === 'group' && atom.alts.some(a => a.length === 0);
        if (!optional && !canBeEmpty && atom.kind !== 'back') break;
    }
    return s;
}
function firstOfAtom(atom, flags) {
    if (atom.kind === 'char') return charSet(atom.src, flags);
    const s = new Set();
    if (atom.kind === 'group') for (const alt of atom.alts) for (const c of firstOfSeq(alt, flags)) s.add(c);
    return s;
}
const unbounded = (q) => !!q && q.max === Infinity;
/** An unbounded quantifier anywhere inside (lookarounds aside). */
const hasUnboundedInside = (alts) => alts.some(items => items.some(({ atom, q }) => (unbounded(q) && atom.kind !== 'anchor') || (atom.kind === 'group' && !atom.look && hasUnboundedInside(atom.alts))));

const NO_REDOS = { severity: null, kind: null, snippet: null };
/**
 * Static ReDoS analysis (feature list 1.5): nested unbounded quantifiers (x+)+ and an unbounded group whose branches can
 * start with the same character (a|ab)+ are exponential; adjacent unbounded atoms that can match the same characters
 * \s*\s* polynomial (exponential inside an unbounded group). Character overlap is sampled, so this is a verdict on the
 * pattern's shape, not a proof. kind names the shape (also 'dotalt' for the linear but slow (.|\n)*, which gets a
 * suggestion and no severity), snippet the piece of the pattern.
 * @param {string} source
 * @param {string} flags
 * @returns {{severity: 'exp' | 'poly' | null, kind: 'nested' | 'alternation' | 'adjacent' | 'dotalt' | null, snippet: string | null}}
 */
export function analyzeRedos(source, flags) {
    let alts;
    try {
        alts = parseRegex(source, flags);
    } catch (e) {
        if (e !== BAIL) throw e;
        return NO_REDOS;
    }
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
                        let overlap = false;
                        for (let a = 0; a < sets.length && !overlap; a++) {
                            for (let b = a + 1; b < sets.length && !overlap; b++) overlap = overlaps(sets[a], sets[b]);
                        }
                        if (overlap) report('exp', 'alternation', atom.src + quantText(q));
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
const redosCache = new Map(); // "source\0flags" -> analyzeRedos()
const redosOf = (re) => cached(redosCache, keyOf(re), () => analyzeRedos(re.source, re.flags));

/** The analyzer's verdict in words, and what to do about it. */
const REDOS_REASONS = {
    nested: (s) => t`nested quantifier ${s}`,
    alternation: (s) => t`alternation with overlapping branches ${s}`,
    adjacent: (s) => t`adjacent overlapping quantifiers ${s}`,
    dotalt: (s) => t`${s} → a character class such as [\\s\\S]`,
};
const REDOS_SUGGESTIONS = {
    nested: () => t`Repeat one thing only: (x+)+ → x+, (?:\\w+\\s?)* → [\\w\\s]*`,
    alternation: () => t`Make the branches start with different characters, or merge them: (a|ab) → ab?`,
    adjacent: () => t`Merge them into one quantifier, or end the first at a character the second cannot match: .*.* → .*`,
    dotalt: (s) => t`${s} → a character class such as [\\s\\S]`,
};
const redosReason = (r) => REDOS_REASONS[r.kind]?.(r.snippet) ?? '';
const redosSuggestion = (r) => REDOS_SUGGESTIONS[r.kind]?.(r.snippet) ?? '';

// ---- Script info: compiled pattern key -> script metadata ----

const keyOf = (re) => re.source + '\u0000' + re.flags;

// A RAW/ESCAPED find pattern with macros ({{random}}, {{getvar::x}}) compiles to another string on every run, so the
// compiled key misses its script. The raw pattern is matched instead: re-substituted (exact when the macro's value is
// stable) or as a shape in which each macro stands for any text (feature list 3, row 2).
const MACRO_SPLIT = /{{[^{}]*}}|<(?:user|bot|char(?:ifnotgroup)?|group)>/gi;
const shapeOf = (raw) => new RegExp('^' + raw.split(MACRO_SPLIT).map(s => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')).join('[\\s\\S]*?') + '$');
function resolveDynamic(regexString, dynamic) {
    if (!dynamic.length) return undefined;
    const { substituteParamsExtended } = ctx();
    for (const d of dynamic) {
        try {
            if (substituteParamsExtended(d.raw, {}, d.substitute === 2 ? sanitizeRegexMacro : undefined) === regexString) return d.info;
        } catch { /* try the shape */ }
    }
    return dynamic.find(d => d.shape.test(regexString))?.info;
}

// ---- ⑥ Fast path (feature list 1.1) ----

const VERIFY_RUNS = 3; // a script's first fast-path runs are compared with SillyTavern's own callback
const fastPathOff = new Set(); // fast keys (pattern + replacement) that disagreed once: back to the callback for the session

/**
 * SillyTavern's replacer (runRegexScript) as a native string template: {{match}} and $0 become $&, $n a two-digit $nn
 * (so a digit after it cannot join it) when the pattern has that many groups, $<name> stays when the pattern has named
 * groups and is '' otherwise (the callback finds no groups object then), every other $ is escaped. A $n beyond the
 * group count gives null: the callback then reads the match offset or the input from its arguments, which no template
 * can express (the lint reports such references). refs lists every reference for the lint.
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
    const template = replaceString.replace(/{{match}}/gi, '$0').replace(/\$(\d+)|\$<([^>]+)>|\$/g, (m, num, name) => {
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
    const normalized = replaceString.replace(/{{match}}/gi, '$0');
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

/** @type {{map: Map<string, object>, dynamic: object[], counts: object, depthRules: number[][], version: string, displayVersion: string, builtAt: number} | null} */
let infoCache = null; // null = rebuild on next use
const markDirty = () => { infoCache = null; };
let infoBuilds = 0; // how often the script info was rebuilt (in the JSON report)
const FINGERPRINT_EVERY_MS = 16; // the script lists are fingerprinted at most once per frame

// Parsed patterns, needles and templates outlive a rebuild: with hundreds of scripts, re-parsing all of them on every
// rebuild was a parse storm (feature list 1.3, 3 row 5).
const CACHE_MAX = 2000;
const compiledCache = new Map(); // pattern string, as RegexProvider receives it -> RegExp | null
const needleCache = new Map(); // "source\0flags" -> extractNeedle()
const templateCache = new Map(); // fast key -> buildTemplate()
function cached(map, key, make) {
    let v = map.get(key);
    if (v === undefined) {
        v = make();
        if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
        map.set(key, v);
    }
    return v;
}
// regexFromString() swallows the engine's error; the invalid-pattern list (feature list 2.2) shows it, so the pattern is
// compiled again the way SillyTavern splits it.
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
    const invalid = []; // {id, name, type, error} of scripts whose pattern does not compile (feature list 2.2)
    const versionParts = [];
    const displayParts = []; // the parts that can change a display result: the ⑤ key's version (feature list 3, row 4)
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
            const substitute = Number(s.substituteRegex);
            const isDynamic = (substitute === 1 || substitute === 2) && MACRO.test(rs);
            if (substitute === 1 || substitute === 2) { // RAW / ESCAPED, as runRegexScript() compiles them
                try { rs = substituteParamsExtended(rs, {}, substitute === 2 ? sanitizeRegexMacro : undefined); } catch { /* keep the raw pattern */ }
            }
            const { re, error } = compile(rs);
            if (!re) { // SillyTavern returns the input unchanged for such a script: listed, so it does not stay silent
                invalid.push({ id: s.id, name: s.scriptName || t`(no name)`, type: origin, error });
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

            // As runRegexScript() reads it: {{match}} is $0, then group references are filled in.
            const replacement = replaceString.replace(/{{match}}/gi, '$0');
            // No macros, and no group reference that could complete one (<$1>, {$1}): the output then depends only
            // on the input, so it can be memoized. semiPure: the same once the static macros are taken out, so it
            // depends on the input and their values.
            const pureOf = (rep, trimList) => !MACRO.test(rep) && !/[{<]\$(?:\d|<)|\$(?:\d+|<[^>]+>)[}>]/.test(rep) && !trimList.some(trim => MACRO.test(String(trim)));
            const pure = pureOf(replacement, trims);
            const strippedTrims = trims.map(trim => String(trim).replace(STATIC_MACRO, ''));
            const semiPure = !pure && pureOf(replacement.replace(STATIC_MACRO, ''), strippedTrims);
            const info = {
                name: s.scriptName || t`(no name)`,
                markdownOnly: !!s.markdownOnly,
                pure,
                semiPure,
                semiPureTrims: semiPure && strippedTrims.some((trim, k) => trim !== String(trims[k])), // a trim string holds a static macro
                replaceSig: fnv1a(replaceString + '\u0001' + trimSig),
                needle,
                redos,
                ids: [s.id], // for the row actions in the table
                statKey: isDynamic ? '\u0004' + s.findRegex : key, // a dynamic pattern's runs are counted under its raw pattern
                raw: isDynamic ? s.findRegex : null,
            };
            if (prev) { // scripts with the same pattern share one wrapper: keep only what holds for all of them
                info.name = prev.name + ', ' + info.name;
                info.ids = [...prev.ids, s.id];
                info.markdownOnly &&= prev.markdownOnly;
                info.pure &&= prev.pure && prev.replaceSig === info.replaceSig;
                info.semiPure &&= prev.semiPure && prev.replaceSig === info.replaceSig;
                info.semiPureTrims &&= info.semiPure;
                info.statKey = prev.statKey;
                info.raw = prev.raw;
                for (const d of dynamic) if (d.info === prev) d.info = info;
            }
            map.set(key, info);
            if (isDynamic) dynamic.push({ raw: s.findRegex, substitute, shape: shapeOf(s.findRegex), info });
            // ⑥: a pure replacement as a template (no trim strings) or a lean callback (trim strings), until a run disagrees
            const fastKey = key + '\u0001' + info.replaceSig;
            const tpl = cached(templateCache, fastKey, () => buildTemplate(replaceString, re));
            info.refs = tpl.refs; // for the lint
            info.find = s.findRegex;
            info.source = re.source;
            info.flags = re.flags;
            info.fast = null;
            if (info.pure && !fastPathOff.has(fastKey)) {
                if (tpl.template !== null) {
                    info.fast = {
                        key: fastKey,
                        template: trims.length ? null : tpl.template,
                        replacer: trims.length ? buildTrimReplacer(replaceString, trims, tpl.named) : null,
                        verify: VERIFY_RUNS,
                        // can a match be replaced by itself? If not, an unchanged output means the pattern did not match
                        identity: tpl.refs.length > 0 || matchesWhole(re, tpl.template.replace(/\$\$/g, '$')),
                    };
                }
            }

            // The same limits getRegexedString() applies; display scripts only, as those are what ⑤ stores.
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
    return { map, dynamic, invalid, counts, depthRules, version, displayVersion: fnv1a(displayParts.join('\u0003')), fp: fingerprint(groups), checkedAt: Date.now(), builtAt: Date.now() };
}

// ---- Instrumented RegExp ----

// Regex calls come in bursts (a chat opening renders every message back to back); the burst that ends at
// CHAT_CHANGED is the chat's first render, and its length decides the "# Messages to Load" hint.
const BURST_GAP_MS = 1000;
let burstStart = 0;
let lastCall = -Infinity;
const SPIKE_MS = 50; // a single run slower than this is flagged, with a sample of its input
const SPIKE_HEAD = 80; // characters of the input kept in the sample
const SPIKE_KEEP = 20; // spikes kept per script
let passMessageId = null; // the message a display pass formats (null outside one): spikes record it
const SAMPLE_AFTER = 1000; // ① with profilerSampling, a script past this many runs is timed on 1 run in SAMPLE_EVERY
const SAMPLE_EVERY = 8;
let statsDirty = false; // the stats changed since the panel was last rendered
let tripSeq = 0; // ⑧ ids for the Undo controls of tripped scripts

/** ⑧ Turns a script off for the session and says so, with Undo and Open script in the toast (feature list 1.5). */
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
/** The Undo / Open script controls of the breaker's toasts and badges, wherever they are shown. */
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
let bypass = false; // set by the formatter hooks while a stored result is being shown
let skipStat = null; // the pattern a per-row measurement renders the chat without
// The previous call: scripts run in sequence on one message, so when a call's input is the previous call's output
// they are neighbours in that pass. Used to spot an earlier script removing what a later one looks for.
let prevStat = null;
let prevIn = null;
let prevOut = null;
const conflicts = new Map(); // "earlierKey\0laterKey" -> {earlier, later, count, confirmed, sample}
let streamApply = false; // set by the formatter hooks for a ④ compromise pass that does run the display scripts
let displayPass = false; // set by the formatter hooks while a message is being formatted for display

// ③ for static-macro scripts: what {{user}} {{char}} {{persona}} {{group}} resolve to in the display pass being
// formatted (null outside one), as SillyTavern resolves them for a replacement and, with the message author as
// {{char}}, for a trim string. Recomputed only when the names, group or persona behind them change.
let passChName = null; // the message author of the display pass being formatted (null outside one)
let passStatic = null;
let passStaticTrim = null;
let staticFp = null;
let staticVals = null;
/** The key for a static-macro script in this pass (level 2: a trim string holds one), resolved on first use. */
function staticKeyFor(level) {
    if (passStatic === null) setPassStatic(passChName);
    return level === 2 ? passStaticTrim : passStatic;
}
function setPassStatic(chName) {
    const { name1, name2, groupId, groups, powerUserSettings, substituteParams } = ctx();
    const group = groupId ? groups?.find?.(g => g.id === groupId) : null;
    const fp = [name1, name2, chName, groupId, group?.members?.join(), group?.disabled_members?.join(), powerUserSettings?.persona_description].join('\u0000');
    if (fp !== staticFp) {
        staticFp = fp;
        const base = substituteParams('{{user}}\u0000{{char}}\u0000{{persona}}\u0000{{group}}');
        staticVals = [fnv1a(base), fnv1a(base + '\u0000' + substituteParams('{{char}}', { name2Override: chName }))];
    }
    [passStatic, passStaticTrim] = staticVals;
}

// ③ Memo: memoPrefix -> Map(key -> entry). The key is the input itself (no key is built per call; V8 caches string
// hashes) or, with memoHashKeys, its 64-bit hash and length, so the entry holds no input: half the memory, for the
// cost of hashing every input and the chance of a collision returning another input's result. memoLru orders all
// entries, least recently used first; memoBytes is their estimated size (2 bytes per UTF-16 unit).
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
    const maxBytes = cfg.memoMaxMB * 1048576;
    while (memoLru.size && (memoLru.size > cfg.memoMaxEntries || memoBytes > maxBytes)) {
        const old = memoLru.values().next().value;
        memoLru.delete(old);
        old.bucket.delete(old.key);
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
            skipped: 0, hits: 0, streamSkipped: 0, bypass: 0, fast: 0,
            seen: 0, // every run that executed, also the ones sampling left untimed
            spike: null, // {ms, len, head, messageId}: the newest run over SPIKE_MS
            spikes: [], // the SPIKE_KEEP newest such runs, newest first (feature list 2.2)
            moreMatches: 0, // runs of a pattern without g that would have matched again (lint "missing g")
            needle: null, // the needle the wrapper uses (and its nested flag), set with its meta
            redos: NO_REDOS, // the analyzer's verdict, set with its meta
            fused: 0, // ⑦ inputs the fuse skipped
            broken: 0, // ⑧ runs skipped since the breaker tripped
            slowRuns: 0, // ⑧ runs over breakerMs
            tripped: false, // ⑧ turned off for the session
            tripId: ++tripSeq, // for the Undo controls
            ids: [], // scripts with this pattern
        };
        stats.set(key, st);
    }
    return st;
}

class PerfRegExp extends RegExp {
    constructor(source, flags) {
        super(source, flags);
        this._meta = null; // set by RegexProvider.get() for each script-info version
        this._version = null;
        // V8 only takes its fast replace path on plain RegExps, so matching runs on an unsubclassed twin.
        this._native = new RegExp(source, flags);
    }

    [Symbol.replace](str, replacer) {
        const { stat, markdownOnly, test, memoPrefix, memoStatic } = this._meta;

        if (stat === skipStat) return str;
        if (bypass && displayPass) { // a stored ⑤ result is being shown for this message
            stat.bypass++;
            statsDirty = true;
            return str;
        }
        if (stat.tripped) { // ⑧ turned off by the circuit breaker for this session
            stat.broken++;
            return unchanged(stat, str);
        }
        if (cfg.fuse && stat.redos.severity && str.length > cfg.fuseLen) { // ⑦ a risky pattern on a very long input
            stat.fused++;
            return unchanged(stat, str);
        }
        if (cfg.streamingSkip && markdownOnly && !streamApply && liveStream()) {
            stat.streamSkipped++;
            return unchanged(stat, str);
        }
        // a displayed message comes back on every re-render: its literal answers are kept (save-time inputs do not)
        const keep = markdownOnly || displayPass;
        if (cfg.prefilter && test && !test(str, keep)) {
            stat.skipped++;
            if (prevOut === str && prevIn !== str && prevStat !== stat) noteConflict(prevStat, stat, prevIn, test, this._native, keep);
            return unchanged(stat, str);
        }

        let bucket;
        let memoKey;
        let postHoc = false; // the input has macro syntax: memoized only if no match contains any (checked as the callback runs)
        // Matched text with macros is substituted again after the groups are inserted, so it is not memoized. A script
        // with static macros is keyed by their values, which are known inside a display pass only.
        const staticKey = memoStatic === 0 ? '' : cfg.memoStatic && passChName !== null ? staticKeyFor(memoStatic) : null;
        if (cfg.memo && memoPrefix && staticKey !== null && str.length <= cfg.memoMaxLen
            && (!hasMacro(str) || (postHoc = cfg.memoPostHoc && typeof replacer === 'function'))) {
            bucket = memo.get(memoPrefix);
            if (!bucket) memo.set(memoPrefix, bucket = new Map());
            memoKey = cfg.memoHashKeys ? hash64(str) + ':' + str.length : str;
            if (staticKey) memoKey = staticKey + '\u0000' + memoKey;
            const hit = bucket.get(memoKey);
            if (hit) {
                memoLru.delete(hit); // mark as most recently used
                memoLru.add(hit);
                stat.hits++;
                return done(stat, str, hit.same ? str : hit.out);
            }
        }

        const native = this._native;
        native.lastIndex = 0;
        // ① Past SAMPLE_AFTER runs of a script with sampling on, one run in SAMPLE_EVERY is timed and counted for all.
        stat.seen++;
        const sampled = cfg.profilerSampling && stat.seen > SAMPLE_AFTER;
        const profile = cfg.profiler && (!sampled || stat.seen % SAMPLE_EVERY === 0);
        const weight = sampled ? SAMPLE_EVERY : 1;
        const timeRepl = profile && cfg.timeReplacer;
        let replMs = 0;
        let matched = false; // the replacer ran, so the pattern matched (even if the text came out the same)
        let fn = replacer;
        let out;
        let fastRun = false;
        let macroSeen = false; // a match contained macro syntax: SillyTavern substituted it, the result is not memoizable
        const t0 = profile || cfg.breaker ? performance.now() : 0;
        // ⑥ With no macro syntax in the input, SillyTavern's per-match callback amounts to its template, which V8 applies
        // without a JS call per match. Should group text assemble macro syntax anyway, the callback is used instead.
        const fast = cfg.fastPath && typeof replacer === 'function' && !hasMacro(str) ? this._meta.fast : null;
        if (fast && fast.verify <= 0) {
            out = RegExp.prototype[Symbol.replace].call(native, str, fast.template ?? fast.replacer);
            if (MACRO.test(out)) {
                out = undefined; // group text assembled macro syntax: SillyTavern would substitute it
                native.lastIndex = 0;
            } else {
                fastRun = true;
            }
        }
        if (!fastRun) {
            // SillyTavern's replacer (groups, trim strings, macros) is timed apart from the matching itself. On a
            // fast-path script's first runs, what the template gives for each match is compared with the callback's
            // result (self-verification): one difference turns ⑥ off for the script.
            let checked = false;
            if (typeof replacer === 'function' && (profile || fast || postHoc)) {
                const meta = this._meta;
                fn = function () {
                    matched = true;
                    const t1 = timeRepl ? performance.now() : 0;
                    const r = replacer.apply(this, arguments);
                    if (timeRepl) replMs += performance.now() - t1;
                    if (postHoc && !macroSeen && MACRO.test(arguments[0])) macroSeen = true;
                    if (fast && meta.fast) {
                        const mine = fast.template !== null ? expandTemplate(fast.template, arguments) : fast.replacer.apply(this, arguments);
                        if (MACRO.test(mine)) return r; // the fast path would have fallen back here: nothing to compare
                        checked = true;
                        if (mine !== r) {
                            fastPathOff.add(fast.key);
                            meta.fast = null;
                            console.warn(`[RegexPerf] fast path disagreed with SillyTavern for "${stat.name}": back to the callback for this script`, { match: String(arguments[0]).slice(0, 200), expected: r.slice(0, 200), got: mine.slice(0, 200) });
                        }
                    }
                    return r;
                };
            }
            out = RegExp.prototype[Symbol.replace].call(native, str, fn);
            if (checked && this._meta.fast) fast.verify--;
        }
        const dt = t0 ? performance.now() - t0 : 0;
        if (cfg.breaker && dt > cfg.breakerMs && ++stat.slowRuns >= cfg.breakerCount) trip(stat); // ⑧
        if (profile) {
            if (t0 - lastCall > BURST_GAP_MS) burstStart = t0;
            lastCall = t0 + dt;
            stat.calls += weight;
            stat.totalMs += dt * weight;
            stat.replMs += replMs * weight;
            if (fastRun) stat.fast += weight;
            if (dt > stat.maxMs) stat.maxMs = dt;
            if (dt > SPIKE_MS) {
                stat.spike = { ms: dt, len: str.length, head: str.slice(0, SPIKE_HEAD), messageId: passMessageId };
                stat.spikes.unshift(stat.spike);
                if (stat.spikes.length > SPIKE_KEEP) stat.spikes.length = SPIKE_KEEP;
            }
            if (out !== str) stat.changed += weight;
            if (!matched) {
                // A template changed the text or not: unchanged means no match unless a match can be its own replacement.
                if (fastRun) matched = out !== str || (fast.identity && native.test(str));
                // A string replacer (not SillyTavern's) tells nothing: test short inputs, assume a match on long ones.
                else if (fn === replacer) matched = out !== str || str.length > 2000 || native.test(str);
            }
            if (matched) stat.matched += weight;
            // lint "missing g": a pattern without g that would have matched again further on (short inputs only)
            if (matched && !native.global && str.length <= CONFLICT_TEST_MAX) {
                const m = native.exec(str);
                if (m && m.index + m[0].length < str.length && native.test(str.slice(m.index + m[0].length))) stat.moreMatches++;
            }
        }
        this.lastIndex = native.lastIndex; // leave this regex as a native replace would

        if (bucket && !macroSeen) {
            // an unchanged output is kept as a marker: V8 shares the string anyway, and counting it twice evicts early
            const same = out === str;
            const size = (memoKey.length + (same ? 0 : out.length)) * 2;
            if (size <= cfg.memoMaxMB * 1048576) { // an entry larger than the budget would flush the memo
                const entry = { bucket, key: memoKey, out: same ? null : out, same, size };
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

const CONFLICT_TEST_MAX = 4000; // the later pattern is really run on inputs up to this long to confirm a match

/**
 * The later script was skipped on the earlier one's output although its needle was in the earlier one's input: the
 * earlier script removed it. Confirmed by running the later pattern on that input when it is short.
 */
function noteConflict(earlier, later, input, test, native, keep) {
    const seen = [litIn, litSeen]; // the check looks at another input; the current one stays the fast path
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
let patchedGet = null; // our RegexProvider.instance.get, to notice a later replacement
let wrapperWarning = ''; // shown once in the panel (and the console)

function patchProvider() {
    const inst = RegexProvider?.instance;
    if (!inst || typeof inst.get !== 'function') {
        console.warn('[RegexPerf] RegexProvider.instance not found — this ST version is not supported.');
        return;
    }
    // SillyTavern's get() is the class method; an own property on the instance is another extension's wrapper.
    if (inst.get !== Object.getPrototypeOf(inst)?.get) warnWrapper(t`Another extension had already replaced the regex engine's get() when Regex Perf Kit loaded: its runs may be measured twice or not at all.`);
    const origGet = inst.get.bind(inst);
    const origClear = inst.clear.bind(inst);

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
            if (wrapped.size >= 1000) wrapped.delete(wrapped.keys().next().value);
            wrapped.set(regexString, w);
        }
        // Script info is re-read whenever it changes, so an edited script takes effect without RegexProvider.clear().
        if (w._version !== version) {
            const key = keyOf(base);
            const info = map.get(key) ?? resolveDynamic(regexString, dynamic);
            const stat = getStat(info?.statKey ?? key, base);
            if (info) stat.name = info.name;
            if (info?.raw) stat.src = info.raw;
            stat.ids = info?.ids ?? [];
            for (const id of stat.ids) statById.set(id, stat);
            stat.needle = info?.needle ?? needleOf(base);
            stat.redos = info?.redos ?? redosOf(base);
            stat.tripped = false; // ⑧ an edit resets the breaker
            stat.slowRuns = 0;
            w._meta = {
                stat,
                markdownOnly: !!info?.markdownOnly,
                test: stat.needle.test,
                memoPrefix: info?.pure || info?.semiPure ? key + '\u0001' + info.replaceSig + (info.pure ? '\u0001' : '\u0002') : null,
                memoStatic: info?.semiPure ? (info.semiPureTrims ? 2 : 1) : 0, // 1: static macros in the replacement, 2: in a trim string too
                fast: info?.fast ?? null,
            };
            w._version = version;
        }
        w.lastIndex = 0;
        return w;
    };

    inst.clear = function () {
        origClear();
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
/** Checked now and then: if another extension replaced get() after us, our features no longer apply. */
function checkWrapper() {
    if (patched && RegexProvider.instance?.get !== patchedGet) warnWrapper(t`Another extension replaced the regex engine's get() after Regex Perf Kit: the features may no longer apply. Check the extension load order.`);
}

// ---- MessageFormatter hooks: ⑤ persisted display cache, ④ compromise mode ----

let persistAvailable = false; // the hooks exist (recent SillyTavern)
let pending = null; // {msg, key, input}: message awaiting its after-regex result
const streamViews = new Map(); // ④ compromise: "<messageId><m|r>" -> {at, prefix, out} of the streamed message
let streamView = null; // the view this pass formats
let streamTail = null; // raw text this pass appends after the regex stage

// Depth of a message as messageFormatting() counts it (non-system messages after it), from one table per render burst:
// built on first use, dropped by a microtask, so a synchronous run over the chat computes it once (feature list 1.3).
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

/** Clears the state the two hooks share for one formatting pass. */
function resetPass() {
    bypass = streamApply = displayPass = false;
    pending = streamView = streamTail = passChName = passStatic = passStaticTrim = passMessageId = null;
}

/**
 * ④ compromise mode, for the message being streamed: the display scripts format the completed lines at most every
 * streamingThrottleMs; in between, the last formatted lines are reused and the rest is shown as it streams.
 */
function streamPass(mes, c) {
    const key = c.messageId + (c.isReasoning ? 'r' : 'm');
    const view = streamViews.get(key);
    const now = performance.now();
    // the last line is still being written, along with any ``` / ~~~ fence SillyTavern appends to balance it
    const cut = mes.replace(/(?:\n(?:```|~~~))+$/, '').lastIndexOf('\n') + 1;
    if (view?.out != null && mes.startsWith(view.prefix) && (cut <= view.prefix.length || now - view.at < cfg.streamingThrottleMs)) {
        streamTail = mes.slice(view.prefix.length); // the streaming skip leaves the reused part alone
        return view.out;
    }
    streamView = { at: now, prefix: mes.slice(0, cut), out: null };
    streamViews.set(key, streamView);
    streamTail = mes.slice(cut);
    streamApply = true;
    return streamView.prefix;
}

function installPersistHooks() {
    const mf = ctx().messageFormatter;
    if (!mf || typeof mf.addHook !== 'function' || !mf.stage) return;
    persistAvailable = true;

    // Before regex: ④ compromise mode for the streamed message; otherwise, on a ⑤ key match, substitute the
    // stored result and bypass every script for this message.
    mf.addHook((mes, c) => {
        resetPass();
        displayPass = true;
        if (c.messageId < 0 || c.isSystem) return mes;
        passChName = c.ch_name ?? c.characterName ?? ''; // static-macro scripts resolve their key on first use
        passMessageId = c.messageId;
        const sp = cfg.persist || cfg.streamingThrottle ? liveStream() : null;
        if (sp) return cfg.streamingSkip && cfg.streamingThrottle && sp.messageId === c.messageId ? streamPass(mes, c) : mes;
        if (!cfg.persist || c.isReasoning) return mes;
        const { chat, name1, name2 } = ctx();
        const msg = chat?.[c.messageId];
        if (!msg) return mes;
        // {{user}}/{{char}} in replacements and trim strings resolve to these names (ch_name: the message author).
        const names = fnv1a([c.ch_name ?? c.characterName, name1, name2].join('\u0000'));
        const { displayVersion, depthRules } = ensureInfo();
        let depths = '';
        if (depthRules.length) { // which depth-limited scripts apply at this message's depth, as messageFormatting() counts it
            const depth = depthAt(chat, c.messageId);
            depths = msg.is_system ? ':*' : ':' + depthRules.map(([min, max]) => (depth < min || depth > max ? 0 : 1)).join('');
        }
        // 64 bits of the text: a 32-bit hash alone collides once in a few tens of thousands of same-length messages.
        // Entries keyed the old way simply miss and are recomputed.
        const key = hash64(mes) + ':' + mes.length + ':' + displayVersion + ':' + names + depths;
        const e = msg.extra?.[EXTRA_KEY];
        if (e && e.k === key) {
            bypass = true;
            // messageFormatting() is synchronous: should it throw before the after-regex hook, the next task starts clean
            queueMicrotask(resetPass);
            persistStats.hits++;
            return e.same ? mes : String(e.v ?? mes);
        }
        pending = { msg, key, input: mes };
        return mes;
    }, { stage: mf.stage.BEFORE_REGEX, order: mf.order?.LATEST ?? 100 });

    // After regex: append ④'s raw tail, or store the freshly computed result for ⑤.
    mf.addHook((mes) => {
        const tail = streamTail;
        const view = streamView;
        const p = pending; // null after a ⑤ hit (bypass)
        resetPass();
        if (tail !== null) {
            if (view) view.out = mes;
            return mes + tail;
        }
        if (!p || mes.length > cfg.persistMaxLen) return mes;
        const chat = ctx().chat;
        storePersisted(chat, p.msg, mes === p.input ? { k: p.key, same: 1 } : { k: p.key, v: mes });
        persistStats.stores++;
        trimPersisted(chat);
        return mes;
    }, { stage: mf.stage.AFTER_REGEX, order: mf.order?.EARLIEST ?? 0 });
}

async function clearPersistedCache() {
    const { chat, saveChat } = ctx();
    let removed = 0;
    for (const m of chat ?? []) {
        if (m?.extra && Object.hasOwn(m.extra, EXTRA_KEY)) {
            delete m.extra[EXTRA_KEY];
            removed++;
        }
    }
    forgetPersistAcct();
    if (removed && typeof saveChat === 'function') {
        try { await saveChat(); } catch (e) { console.warn('[RegexPerf] saveChat failed', e); }
    }
    return removed;
}

// ---- Report ----

const INEFFECTIVE_RUNS = 20; // a script that ran this often without ever matching is a candidate to disable

/** Milliseconds for display: an exact zero is "0", otherwise 2 / 1 / 0 decimals as the value grows. */
const fmtMs = (x) => (x === 0 ? '0' : x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2));
const avgMs = (r) => (r.calls ? r.totalMs / r.calls : 0);
/** The prefilter's terms as text: literals joined by & must all occur, those joined by | need one ("a" & ("b" | "c")). */
const fmtNeedles = (r) => {
    const terms = r.needle?.terms;
    if (!terms?.length) return undefined;
    const q = (set) => set.map(s => JSON.stringify(s)).join(' | ');
    return terms.map(set => (set.length > 1 && terms.length > 1 ? `(${q(set)})` : q(set))).join(' & ');
};
// every call the prefilter, the memo or the streaming skip avoided would have cost the script's average run
const avoided = (r) => r.skipped + r.hits + r.streamSkipped;
const savedMs = (r) => avoided(r) * avgMs(r);
const ineffective = (r) => r.calls >= INEFFECTIVE_RUNS && !r.matched;
/** Conflicts in which r is the later script (the one whose match an earlier script removed). */
const conflictsOf = (r) => [...conflicts.values()].filter(c => c.later === r);
const conflictText = (c) => (c.confirmed
    ? t`"${c.earlier.name}" runs first and removes what "${c.later.name}" would have matched: ${c.count} times`
    : t`"${c.earlier.name}" runs first and removes the literal "${c.later.name}" looks for: ${c.count} times (match not verified on long inputs)`);
/** The sample kept from a run over SPIKE_MS: how long the input was and how it started. */
const spikeText = (sp) => t`Last spike: ${fmtMs(sp.ms)} ms on ${sp.len} characters, starting ${JSON.stringify(sp.head)}`;
/** How many runs ⑥ replaced without SillyTavern's callback. */
const fastText = (n) => t`⑥ fast path: ${n} runs without SillyTavern's callback`;
/** A pattern the extension has seen do anything: rows that never ran nor were skipped are left out of the table. */
const active = (r) => r.calls + avoided(r) + r.bypass > 0;
const badge = (text, title, cls = '', attrs = '') => ` <span class="rpk-badge${cls ? ' ' + cls : ''}"${attrs} title="${esc(title)}">${text}</span>`;
/** The older spikes of a script, for the ⚡ tooltip, and where a click goes. */
const spikeHistory = (r) => r.spikes.slice(1, 5).map(sp => '\n' + t`${fmtMs(sp.ms)} ms on ${sp.len} characters` + (sp.messageId != null ? ` (#${sp.messageId})` : '')).join('')
    + (r.spike?.messageId != null ? '\n' + t`Click to scroll to message #${r.spike.messageId}` : '');
/** A row's warnings: words for the report, or badges for the panel. */
function warnings(r, badges = false) {
    const conflicted = conflictsOf(r);
    return [
        r.redos.severity === 'exp' && (badges ? badge('(a+)+', t`Exponential backtracking: ${redosReason(r.redos)}. ${redosSuggestion(r.redos)}`) : t`exponential backtracking (${redosReason(r.redos)})`),
        r.redos.severity === 'poly' && (badges ? badge('a*a*', t`Polynomial backtracking: ${redosReason(r.redos)}. ${redosSuggestion(r.redos)}`) : t`polynomial backtracking (${redosReason(r.redos)})`),
        r.fused > 0 && (badges ? badge('fuse', t`${r.fused} inputs over ${settings.fuseLen} characters were skipped by the fuse`) : t`fused`),
        r.tripped && (badges ? ` <span class="rpk-badge rpk-undo" data-trip="${r.tripId}" title="${esc(t`Turned off by the circuit breaker: ${r.slowRuns} runs took over ${settings.breakerMs} ms. Click to turn it back on.`)}">off</span>` : t`breaker`),
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
    const top = rows.find(r => r.calls > 0);
    const { chat } = ctx();
    return {
        counts,
        invalid,
        rows,
        total,
        calls: sum('calls'),
        skipped: sum('skipped'),
        hits: sum('hits'),
        streamSkipped: sum('streamSkipped'),
        bypass: sum('bypass'),
        fast: sum('fast'),
        saved: rows.reduce((acc, r) => acc + savedMs(r), 0),
        ineffective: rows.filter(ineffective).map(r => r.name),
        chatLen: chat?.length ?? 0,
        top,
        topShare: top && total > 0 ? top.totalMs / total * 100 : 0,
        usage: t`③ memory cache: ${memoLru.size} entries, ${(memoBytes / 1048576).toFixed(1)} of ${settings.memoMaxMB} MB`
            + (persistAvailable ? '. ' + persistUsage(chat) : ''),
        persist: persistAvailable ? (({ entries, chars }) => ({ entries, chars }))(persistTotals(chat)) : null,
    };
}

/** Size of a ⑤ entry, in characters (about its bytes in the chat file). */
const persistSize = (e) => String(e.k).length + (e.v?.length ?? 0);

// ⑤ usage is a running total per chat (feature list 1.3): a full scan only for another chat or after a change the
// hooks cannot see (CHAT_CHANGED, a deleted message).
const persistAcct = { chat: null, entries: 0, chars: 0 };
const forgetPersistAcct = () => { persistAcct.chat = null; };

/** The ⑤ entries in a chat: how many messages hold one and their total size. */
function persistTotals(chat) {
    if (chat !== persistAcct.chat) {
        let entries = 0;
        let chars = 0;
        for (const m of chat ?? []) {
            const e = m?.extra?.[EXTRA_KEY];
            if (!e) continue;
            entries++;
            chars += persistSize(e);
        }
        Object.assign(persistAcct, { chat, entries, chars });
    }
    return persistAcct;
}

/** Puts a ⑤ entry on a message, keeping the running total. */
function storePersisted(chat, msg, entry) {
    const acct = persistTotals(chat);
    msg.extra ||= {};
    const old = msg.extra[EXTRA_KEY];
    if (old) {
        acct.entries--;
        acct.chars -= persistSize(old);
    }
    msg.extra[EXTRA_KEY] = entry;
    acct.entries++;
    acct.chars += persistSize(entry);
}

/** Drops ⑤ entries from the oldest messages until the chat is within persistMaxMB. */
function trimPersisted(chat) {
    if (!chat) return;
    const acct = persistTotals(chat);
    const max = cfg.persistMaxMB * 1048576;
    for (let i = 0; acct.chars > max && i < chat.length; i++) {
        const e = chat[i]?.extra?.[EXTRA_KEY];
        if (!e) continue;
        acct.chars -= persistSize(e);
        acct.entries--;
        delete chat[i].extra[EXTRA_KEY];
    }
}

/** ⑤ storage in this chat against its cap (only scanned when the hooks exist). */
function persistUsage(chat) {
    const { entries, chars } = persistTotals(chat);
    return t`⑤ saved in this chat: ${entries} messages, ≈${Math.round(chars / 1024)} KB of ${settings.persistMaxMB} MB`;
}

let measured = null; // last "Measure on this chat" result
const rowMeasures = new Map(); // stat -> {with, without}: per-row measurements of this session

const SLOWEST_MESSAGES = 5;
/** "#12 (4321 chars) 85 ms, ..." for the slowest messages of a measurement. */
const slowestText = (m) => t`Slowest messages (features off): ${m.slowest.map(x => t`#${x.i} (${x.len} chars) ${fmtMs(x.ms)} ms`).join(', ')}`;
const measureText = (m) => t`This chat (${m.messages} messages): ${fmtMs(m.off)} ms with the features off, ${fmtMs(m.on)} ms on — ${fmtMs(m.off - m.on)} ms saved (${m.off > 0 ? Math.round((m.off - m.on) / m.off * 100) : 0}%)`;
/** The table's columns, in the text report and the CSV. */
const reportHeader = () => t`Rank | Script | Runs | Total ms | Avg ms | Max ms | Replacer ms | Matched | Changed | Skips | Hits | Stream skips | Literal | Min length | Warnings`;

/** "global 3/40 · preset 2/8 · scoped 0/0": active/total per script origin. */
const typeCounts = (c) => {
    const [g, p, s] = ['global', 'preset', 'scoped'].map(k => c.types[k] ?? { active: 0, total: 0 });
    return [t`global ${g.active}/${g.total}`, t`preset ${p.active}/${p.total}`, t`scoped ${s.active}/${s.total}`].join(', ');
};

function buildReportText() {
    const s = buildSummary();
    const c = s.counts;
    const skips = s.skipped + s.hits + s.streamSkipped;
    const lines = [
        `Regex Perf Kit report (${new Date().toLocaleString()})`,
        t`Since: ${new Date(statsSince).toLocaleTimeString()} / chat messages: ${s.chatLen}`,
        t`Scripts: ${c.total} total, ${c.active} active (${typeCounts(c)}), no literal ${c.noNeedle}, backtracking risk ${c.redos} (exponential ${c.redosExp})`,
        t`Ran ${s.calls} times / ${fmtMs(s.total)} ms total | skipped ${skips} (prefilter ${s.skipped}, cache hits ${s.hits}, streaming ${s.streamSkipped}) | persistent cache bypasses ${s.bypass} (hits ${persistStats.hits}, stored ${persistStats.stores})`,
        s.calls
            ? t`Estimated time saved: ≈${fmtMs(s.saved)} ms (${skips} skipped runs × each script's average run time)`
            : t`Estimated time saved: not available yet (no measured runs)`,
        s.usage,
    ];
    if (s.fast) lines.push(fastText(s.fast));
    if (measured) lines.push(measureText(measured), slowestText(measured));
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
            lines.push(`${r.name}: ${spikeText(r.spike)}` + (r.spike.messageId != null ? ` (#${r.spike.messageId})` : ''));
            for (const sp of r.spikes.slice(1)) lines.push(`  ${fmtMs(sp.ms)} ms / ${sp.len}` + (sp.messageId != null ? ` (#${sp.messageId})` : ''));
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
        totals: { calls: s.calls, totalMs: s.total, skipped: s.skipped, hits: s.hits, streamSkipped: s.streamSkipped, bypass: s.bypass, fastRuns: s.fast, persistHits: persistStats.hits, persistStores: persistStats.stores, savedMs: s.calls ? s.saved : null },
        memo: { entries: memoLru.size, bytes: memoBytes, maxMB: settings.memoMaxMB, persist: s.persist },
        measured,
        candidatesToDisable: s.ineffective,
        orderConflicts: [...conflicts.values()].map(c => ({ earlier: c.earlier.name, later: c.later.name, count: c.count, confirmed: c.confirmed, sample: c.sample })),
        invalidPatterns: s.invalid,
        lint: lintRows().map(row => ({ script: row.info.name, ids: row.info.ids, rule: row.rule, text: row.text, fixable: !!row.fix })),
        rows: s.rows.map((r, i) => ({
            rank: i + 1, name: r.name, pattern: r.src, runs: r.calls, totalMs: r.totalMs, avgMs: avgMs(r), maxMs: r.maxMs, replacerMs: r.replMs,
            matched: r.matched, changed: r.changed, skips: r.skipped, hits: r.hits, streamSkips: r.streamSkipped, fastRuns: r.fast,
            sampled: !!settings.profilerSampling && r.seen > SAMPLE_AFTER, // runs, totals, matched and changed are scaled from 1 run in 8
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

/** Turns off the scripts whose name matches (exactly, else as the only one containing it); the message to show. */
async function turnOffByName(name) {
    const want = name.trim().toLowerCase();
    if (!want) return t`Usage: /regexperf off <script name>`;
    const infos = [...ensureInfo().map.values()];
    const found = infos.filter(r => r.name.toLowerCase() === want);
    const hits = found.length ? found : infos.filter(r => r.name.toLowerCase().includes(want));
    if (hits.length !== 1) return hits.length ? t`"${name}" matches several scripts: ${hits.map(r => r.name).join(', ')}` : t`"${name}" is not in the Regex extension's list.`;
    await scriptAction(hits[0], true);
    renderPanel();
    return t`Turned off: ${hits[0].name}`;
}

// ---- Lint (feature list 2.3) and saving through the engine ----

/**
 * Saves a change to the scripts with these ids through the engine (no Regex drawer involved) and re-reads the script
 * info; false when this SillyTavern cannot (no saveScriptsByType).
 */
async function saveScript(ids, patch) {
    if (typeof engine.saveScriptsByType !== 'function' || typeof getScriptsByType !== 'function' || !SCRIPT_TYPES) return false;
    let saved = false;
    for (const type of Object.values(SCRIPT_TYPES)) {
        const list = getScriptsByType(type, { allowedOnly: false }) ?? [];
        if (!list.some(s => ids.includes(s?.id))) continue;
        await engine.saveScriptsByType(list.map(s => (ids.includes(s?.id) ? { ...s, ...patch } : s)), type);
        saved = true;
    }
    if (saved) markDirty();
    return saved;
}

const LINT_TEXT = {
    'missing-g': () => t`Matched more than once in a message, but without the g flag only the first match is replaced`,
    'group-ref': (refs) => t`Group references the pattern cannot fill: ${refs}`,
    'double-escape': () => t`Double escapes such as \\\\n in the pattern (a JSON copy): they match a backslash and a letter, not a newline`,
    'browser-compat': (what) => t`Not supported by every browser: ${what} (invalid on iOS and Safari before 16.4 / 17, where the script does nothing)`,
    'duplicate': (names) => t`Several scripts share this pattern (${names}): one wrapper serves all of them, so ③ and ④ apply only when they suit every one`,
};

/** The lint findings for every active script: {rule, info, text, fix}, fix = {label, patch} where it is mechanical. */
function lintRows() {
    if (!settings.lint) return [];
    const rows = [];
    for (const info of ensureInfo().map.values()) {
        const stat = stats.get(info.statKey);
        const find = String(info.find ?? '');
        if (!info.flags.includes('g') && stat?.moreMatches >= 3) {
            const m = /^\/([\s\S]+)\/([a-z]*)$/i.exec(find);
            rows.push({ rule: 'missing-g', info, text: LINT_TEXT['missing-g'](), fix: { label: t`Add g`, patch: { findRegex: m ? `/${m[1]}/${m[2]}g` : `/${find}/g` } } });
        }
        const bad = [...new Set(info.refs.filter(r => !r.ok).map(r => r.ref))];
        if (bad.length) rows.push({ rule: 'group-ref', info, text: LINT_TEXT['group-ref'](bad.join(' ')), fix: null });
        if (/\\\\[nrtsdwb]/.test(find)) rows.push({ rule: 'double-escape', info, text: LINT_TEXT['double-escape'](), fix: { label: t`Unescape`, patch: { findRegex: find.replace(/\\\\([nrtsdwb])/g, '\\$1') } } });
        const compat = [];
        if (/\(\?<[=!]/.test(info.source)) compat.push(t`lookbehind`);
        if (info.flags.includes('v')) compat.push(t`the v flag`);
        if (info.flags.includes('d')) compat.push(t`the d flag`);
        const names = info.source.match(/\(\?<([^>=!][^>]*)>/g) ?? [];
        if (new Set(names).size < names.length) compat.push(t`duplicate group names`);
        if (compat.length) rows.push({ rule: 'browser-compat', info, text: LINT_TEXT['browser-compat'](compat.join(', ')), fix: null });
        if (info.ids.length > 1) rows.push({ rule: 'duplicate', info, text: LINT_TEXT.duplicate(info.name), fix: null });
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

// ---- Cost chips in the Regex extension's own list (feature list 2.1) ----

const LIST_IDS = ['saved_regex_scripts', 'saved_scoped_scripts', 'saved_preset_scripts'];
const observedLists = new WeakSet();
const statById = new Map(); // script id -> its stat, for the chips
let chipTimer = 0;
/** Watches the Regex drawer's lists (SillyTavern rebuilds them) once they exist; called from the refresh interval. */
function installListBadges() {
    for (const id of LIST_IDS) {
        const box = document.getElementById(id);
        if (!box || observedLists.has(box)) continue;
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
    if (r.maxMs > SPIKE_MS) parts.push('⚡');
    if (r.tripped) parts.push('off');
    return parts.join(' · ');
}
function updateListBadges() {
    if (!settings.listBadges) {
        for (const el of document.querySelectorAll('.rpk-chip')) el.remove();
        return;
    }
    const total = [...stats.values()].reduce((acc, r) => acc + r.totalMs, 0);
    for (const id of LIST_IDS) {
        const box = document.getElementById(id);
        if (!box) continue;
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

const COUNTERS = ['calls', 'totalMs', 'maxMs', 'replMs', 'matched', 'changed', 'skipped', 'hits', 'streamSkipped', 'bypass', 'fast', 'seen', 'fused', 'broken', 'slowRuns', 'moreMatches', 'spike', 'spikes'];
const FEATURES_OFF = { profiler: false, prefilter: false, memo: false, persist: false, breaker: false }; // what a measurement turns off

const CACHES_OFF = { profiler: false, memo: false, persist: false, breaker: false }; // a per-row measurement keeps the prefilter as set

const MEASURE_CHUNK = 10; // messages formatted between two yields to the page
let measureBusy = false; // a measurement is running (it yields, so other code runs in between)

/**
 * Renders every message of the current chat as SillyTavern displays it (messageFormatting), first with the
 * prefilter, the memo and ⑤ off, then with the user's settings, and returns both times. With a stat, both passes
 * run with the caches off, the second one without that pattern: {with, without}. The chat was rendered when it
 * opened, so this is a re-render, as on swipes, edits and reloads. Chunked (feature list 1.4): every MEASURE_CHUNK
 * messages it yields to the page, so the page stays usable. The features are turned off through cfg only while a
 * message is being formatted, so a render that happens in between gets the user's settings and nothing temporary can
 * be saved; the stats are restored afterwards.
 */
async function measureChat(without = null) {
    const { chat, messageFormatting } = ctx();
    if (!chat?.length || typeof messageFormatting !== 'function' || measureBusy) return null;
    measureBusy = true;
    const pause = () => globalThis.scheduler?.yield?.() ?? new Promise(resolve => setTimeout(resolve, 0));
    const over = (changes) => Object.assign(Object.create(settings), changes);
    const render = async (times, skip, config) => { // times: per-message {i, len, ms} are pushed when given
        let total = 0;
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            cfg = config;
            skipStat = skip;
            const t1 = performance.now();
            try {
                if (m?.mes) messageFormatting(m.mes, m.name, m.is_system, m.is_user, i);
                if (m?.extra?.reasoning) messageFormatting(m.extra.reasoning, '', false, false, i, {}, true);
            } finally {
                cfg = settings;
                skipStat = null;
            }
            const ms = performance.now() - t1;
            total += ms;
            if (times) times.push({ i, len: (m?.mes?.length ?? 0) + (m?.extra?.reasoning?.length ?? 0), ms });
            if (i % MEASURE_CHUNK === MEASURE_CHUNK - 1) await pause();
        }
        return total;
    };
    const saved = new Map([...stats].map(([k, st]) => [k, COUNTERS.map(c => (Array.isArray(st[c]) ? [...st[c]] : st[c]))]));
    const savedPersist = { ...persistStats };
    const savedConflicts = new Map([...conflicts].map(([k, c]) => [k, { ...c }]));
    const times = [];
    let first, second;
    try {
        first = await render(without ? null : times, null, over(without ? CACHES_OFF : FEATURES_OFF)); // the raw cost of each message
        second = await render(null, without, over(without ? CACHES_OFF : { profiler: false }));
    } finally {
        measureBusy = false;
        for (const [k, st] of stats) COUNTERS.forEach((c, i) => { st[c] = saved.get(k)?.[i] ?? 0; });
        Object.assign(persistStats, savedPersist);
        conflicts.clear();
        for (const [k, c] of savedConflicts) conflicts.set(k, c);
    }
    if (without) return { with: first, without: second };
    return { messages: chat.length, off: first, on: second, slowest: times.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_MESSAGES) };
}

/** "Measure on this chat": the new result, kept as the last one (an empty chat leaves the previous result). */
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
    statById.clear();
    wrapped.clear(); // wrappers hold their stat object; new ones link to fresh stats
}

// ---- UI ----

// UI text is English; locales/<locale>.json holds the translations (ko-kr today), loaded before the panel is built.
// addLocaleData() never overrides SillyTavern's own translations, so a key SillyTavern already translates differently
// gets its own id (translate(text, id)).
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

/** A row of the Limits grid: a number field for LIMITS[key] or a checkbox for TOGGLES; bindUi() finds it as #rpk_<key>. */
const limit = (key, name, title, type = 'number') => `<label${title ? ` title="${title}"` : ''}><span>${name}</span><input type="${type}"${type === 'number' ? ' class="text_pole"' : ''} id="rpk_${key}"></label>`;

// Sorting and the name filter are per session (not saved). Clicking a header sorts by it, again flips the direction.
const SORT_KEYS = {
    rank: (r, i) => i, name: (r) => r.name.toLowerCase(), runs: (r) => r.calls, total: (r) => r.totalMs, avg: avgMs, max: (r) => r.maxMs,
    repl: (r) => r.replMs, matched: (r) => r.matched, changed: (r) => r.changed, skips: (r) => r.skipped, hits: (r) => r.hits, lit: (r) => fmtNeedles(r) ?? '',
};
let sortBy = null;
let sortDesc = true;
let nameFilter = '';

// Table cells carry a column class so the narrow layout can hide columns; headers explain themselves on hover.
const th = (col, text, title) => `<th class="rpk-col-${col}${SORT_KEYS[col] ? ' rpk-sortable' : ''}${sortBy === col ? ' rpk-sorted' : ''}" data-col="${col}"${title ? ` title="${esc(title)}"` : ''}>${text}${sortBy === col ? (sortDesc ? ' ▾' : ' ▴') : ''}</th>`;
const td = (col, value, cls = '', title = '') => `<td class="rpk-col-${col}${cls ? ' ' + cls : ''}"${title ? ` title="${esc(title)}"` : ''}>${value}</td>`;

const headerHtml = () => `<tr>
            ${th('rank', '#')}${th('name', t`Script`)}
            ${th('runs', t`Runs`, t`Regex runs that really happened`)}${th('total', t`Total ms`)}${th('avg', t`Avg`, t`Time per run, averaged`)}${th('max', t`Max`, t`Slowest single run`)}
            ${th('repl', t`Replacer`, t`Time spent in the replacement (group filling, trim strings, macros), included in Total ms`)}${th('matched', t`Matched`, t`Runs where the pattern matched, even if the text came out the same`)}${th('changed', t`Changed`, t`Runs that changed the text`)}
            ${th('skips', t`Skips`, t`Runs skipped by ② (the fixed text was absent)`)}${th('hits', t`Hits`, t`Results reused by ③`)}${th('lit', t`Literal`, t`The fixed text ② looks for before running this script: every literal joined by & must be present, one of those joined by |. Hover a cell for the shortest possible match.`)}${th('act', '')}
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

      <h4 class="rpk-section">${t`Features`}</h4>
      <div class="rpk-features">
        <div class="rpk-feature-group">
        ${feature('rpk_profiler', t`① Measure run time (profiler)`, t`Counts how often each script runs and how long it takes, for the table below. Costs almost nothing.`)}
        ${feature('rpk_profilerSampling', t`Sample: past 1000 runs of a script, time 1 run in 8`, t`Timing is two clock reads per run; with sampling, the totals of a busy script are scaled from every eighth run. On by default on devices with 4 GB or less.`, { sub: true })}
        ${feature('rpk_timeReplacer', t`Time the replacement separately (the Replacer column)`, t`Two more clock reads per match. Off, that column stays 0.`, { sub: true })}
        </div>
        ${feature('rpk_prefilter', t`② Skip runs that cannot match (literal prefilter)`, t`If the message does not even contain the fixed text a script looks for (such as &lt;/status&gt;), the regex is not run. The result is exactly the same.`)}
        <div class="rpk-feature-group">
        ${feature('rpk_memo', t`③ Reuse results (memory cache)`, t`When the same script runs on the same message again (swipes, re-renders, reloads), the previous result is reused. Scripts and text with {{macros}} are left out automatically.`)}
        ${feature('rpk_memoStatic', t`Also cache scripts that use {{user}}, {{char}}, {{persona}} or {{group}}`, t`These macros keep their value while a message is rendered, so the result is cached per name set and computed again after a rename or a persona change. Other macros still exclude a script.`, { sub: true })}
        ${feature('rpk_memoPostHoc', t`Also cache messages that show macro syntax`, t`A message with {{ outside the matched text (a code sample, for instance) is cached when no match itself contained macro syntax.`, { sub: true })}
        </div>
        ${feature('rpk_fastPath', t`⑥ Replace without SillyTavern's callback (fast path)`, t`When a script's replacement has no macros, the browser's own template replacement is used instead of SillyTavern's per-match callback, where most of the replacer time goes. The first runs of every script are compared with SillyTavern's result; on any difference the script goes back to the callback.`)}
        <div class="rpk-feature-group">
        ${feature('rpk_streaming', t`④ Rest display scripts while streaming`, t`While a reply is being generated, "Only Format Display" scripts are skipped and applied once when it finishes. This removes most streaming lag.`)}
        ${feature('rpk_stream_throttle', t`Compromise: keep formatting the finished lines`, t`With ④ on, display scripts still format the lines that are already complete, at most once per interval (0.5 s by default, under Limits). The line being written stays raw; the finished reply gets every script.`, { sub: true })}
        </div>
        ${feature('rpk_persist', t`⑤ Save results in the chat file (persistent cache)`, t`Stores the display result with the message, so reopening the chat skips the work. The chat file grows; results are recomputed automatically when a script changes.`, { labelId: 'rpk_persist_label' })}
        ${feature('rpk_fuse', t`⑦ Fuse: skip very long inputs for risky patterns`, t`A pattern the analyzer flags for catastrophic backtracking is not run on inputs longer than the limit under Limits (20,000 characters by default): that text is shown as it is. Off by default, as it changes the result.`)}
        ${feature('rpk_breaker', t`⑧ Circuit breaker: turn off a script that keeps running long`, t`After the set number of runs over the set time (3 runs over 500 ms by default), the script is skipped for the rest of the session, with an Undo in the toast and in the table. The script itself is never changed. Off by default.`)}
      </div>
      <div class="rpk-note" id="rpk_persist_note"></div>
      <div class="rpk-note" id="rpk_usage"></div>

      <details class="rpk-limits" data-section="limits">
        <summary>${t`Limits`}</summary>
        <div class="rpk-grid">
          ${limit('memoMaxEntries', t`③ Cache entries`, t`Oldest results are dropped beyond this many.`)}
          ${limit('memoMaxLen', t`③ Longest input to cache (characters)`, t`Longer inputs are not cached.`)}
          ${limit('memoMaxMB', t`③ Cache memory (MB)`, t`Oldest results are dropped beyond this estimated size (2 bytes per character of input and output).`)}
          ${limit('persistMaxLen', t`⑤ Longest result to save (characters)`, t`Longer display results are not saved in the chat.`)}
          ${limit('persistMaxMB', t`⑤ Saved results per chat (MB)`, t`Beyond this, the oldest messages' results are dropped from the chat.`)}
          ${limit('streamingThrottleMs', t`Compromise interval (ms)`)}
          ${limit('fuseLen', t`⑦ Fuse: longest input a risky pattern runs on (characters)`)}
          ${limit('breakerMs', t`⑧ Breaker: a run counts as long over (ms)`)}
          ${limit('breakerCount', t`⑧ Breaker: long runs before the script is turned off`)}
          ${limit('memoHashKeys', t`③ Key the cache by a hash of the input`, t`Keeps a 64-bit hash of each input instead of the input: about half the memory for long chats, at the cost of hashing every input. A collision (two same-length inputs with the same hash) would return the other input's result; with 64 bits that takes billions of inputs.`, 'checkbox')}
          ${limit('loadHintMs', t`Hint about "# Messages to Load" when opening a chat takes longer than (ms)`, t`Shown once per session as a toast.`)}
          ${limit('autoMeasure', t`Measure automatically when a chat opens`, t`Runs "Measure on this chat" once after a chat opens.`, 'checkbox')}
          ${limit('lint', t`Lint the scripts`, t`Missing g, group references the pattern cannot fill, double escapes, browser support, duplicate patterns. Shown under Lint; a fix is applied only when you confirm it.`, 'checkbox')}
          ${limit('listBadges', t`Show each script's cost in the Regex extension's list`, t`A chip after the script name: total ms, share of all regex time, and the marks of the table.`, 'checkbox')}
        </div>
      </details>

      <div class="rpk-buttons">
        <div class="menu_button rpk-primary" id="rpk_measure" title="${t`Re-renders this chat twice, with the features off and on, and shows the real difference. Runs in small steps, so the page stays usable.`}">${t`Measure on this chat`}</div>
        <div class="menu_button" id="rpk_copy">${t`Copy report`}</div>
        <div class="menu_button rpk-minor" id="rpk_copy_json" title="${t`Copy the report as JSON`}">JSON</div>
        <div class="menu_button rpk-minor" id="rpk_copy_csv" title="${t`Copy the table as CSV`}">CSV</div>
        <div class="menu_button" id="rpk_reset">${t`Reset stats`}</div>
        <div class="menu_button" id="rpk_refresh">${translate('Refresh', 'rpk_refresh')}</div>
        <div class="menu_button" id="rpk_clear_persist">${t`Clear saved results (this chat)`}</div>
        <div class="menu_button" id="rpk_reset_settings" title="${t`Turns every feature and limit back to its default.`}">${t`Reset settings`}</div>
      </div>
      <div class="rpk-note rpk-measured" id="rpk_measure_result"></div>

      <div class="rpk-table-head">
        <h4 class="rpk-section">${t`Per-script measurements (slowest first)`}</h4>
        <input type="text" class="text_pole" id="rpk_filter" placeholder="${t`Filter by name`}" title="${t`Shows only the scripts whose name contains this. Click a column header to sort by it, again to flip the direction.`}">
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
      <details class="rpk-tips rpk-legend" data-section="legend">
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

const TOGGLES = { rpk_profiler: 'profiler', rpk_profilerSampling: 'profilerSampling', rpk_timeReplacer: 'timeReplacer', rpk_prefilter: 'prefilter', rpk_memo: 'memo', rpk_memoStatic: 'memoStatic', rpk_memoPostHoc: 'memoPostHoc', rpk_fastPath: 'fastPath', rpk_streaming: 'streamingSkip', rpk_stream_throttle: 'streamingThrottle', rpk_persist: 'persist', rpk_fuse: 'fuse', rpk_breaker: 'breaker', rpk_memoHashKeys: 'memoHashKeys', rpk_autoMeasure: 'autoMeasure', rpk_lint: 'lint', rpk_listBadges: 'listBadges' };
// editable limits: setting -> [min, max]
const LIMITS = { memoMaxEntries: [0, 1e6], memoMaxLen: [0, 1e7], memoMaxMB: [0, 4096], persistMaxLen: [0, 1e8], persistMaxMB: [1, 4096], streamingThrottleMs: [50, 60000], fuseLen: [1000, 1e7], breakerMs: [50, 60000], breakerCount: [1, 100], loadHintMs: [100, 600000] };

const RENDER_MIN_MS = 500; // the panel is re-rendered at most this often while stats keep changing
let ui = null; // panel elements, cached by bindUi()
const rendered = new WeakMap();

/** Assigns el[prop] only when the value changed, so periodic refreshes leave an unchanged panel alone. */
function setContent(el, value, prop = 'innerHTML') {
    if (rendered.get(el) === value) return;
    rendered.set(el, value);
    el[prop] = value;
}

/** The Literal cell's tooltip: why there is no literal (lit = fmtNeedles(r)), and the shortest possible match. */
const litTitle = (r, lit) => [
    !lit && needleReason(r),
    r.needle?.minLen && t`Shortest possible match: ${r.needle.minLen} characters. ② skips shorter messages.`,
].filter(Boolean).join('\n');
/** A key figure in the summary; the tests read it by its key. */
const fig = (key, value) => `<b data-k="${key}">${value}</b>`;

function renderPanel() {
    if (!ui) return;
    const s = buildSummary();
    const c = s.counts;
    const skips = s.skipped + s.hits + s.streamSkipped;
    const lines = [];
    lines.push(t`${c.active} of ${c.total} scripts active (${typeCounts(c)}). ${s.chatLen} messages in this chat.`);
    if (c.noNeedle || c.redos) {
        lines.push(`<span class="rpk-dim">${t`Patterns to look at: no fixed text ${c.noNeedle}, backtracking risk ${c.redos} (exponential ${c.redosExp}).`}</span>`);
    }
    const breakdown = t`prefilter ${s.skipped}, cache ${s.hits}, streaming ${s.streamSkipped}` + (persistAvailable ? ', ' + t`saved results ${s.bypass}` : '');
    if (!s.calls && !skips && !s.bypass) {
        lines.push(`<span class="rpk-dim">${t`No runs measured yet. Render a message or reopen the chat.`}</span>`);
    } else {
        lines.push(t`Regex ran ${fig('runs', s.calls)} times, ${fig('ms', fmtMs(s.total) + ' ms')} in total.`);
        lines.push(s.calls
            ? t`${fig('skipped', skips + s.bypass)} runs were skipped (${breakdown}), saving about ${fig('saved', fmtMs(s.saved) + ' ms')}.`
            : t`${fig('skipped', skips + s.bypass)} runs were skipped (${breakdown}). The time saved is known once some runs have been measured.`);
        if (s.fast) lines.push(`<span class="rpk-dim">${fastText(s.fast)}</span>`);
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

    setContent(ui.thead, headerHtml());
    const ranks = new Map(s.rows.map((r, i) => [r, i + 1])); // by total time, whatever the sort
    let rows = nameFilter ? s.rows.filter(r => r.name.toLowerCase().includes(nameFilter)) : s.rows;
    if (sortBy) {
        const key = SORT_KEYS[sortBy];
        rows = rows.map((r, i) => [key(r, i), r]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0) * (sortDesc ? -1 : 1)).map(([, r]) => r);
    }
    ui.rows = rows.slice(0, 60);
    setContent(ui.tbody, ui.rows.map((r, i) => {
        const cls = (s.total > 0 && r.totalMs / s.total >= 0.5) ? 'rpk-hot' : (r.redos.severity === 'exp' ? 'rpk-heavy' : '');
        const lit = fmtNeedles(r);
        const m = rowMeasures.get(r);
        const actions = (m ? `<span class="rpk-row-ms" title="${esc(t`Without this script the chat renders in ${fmtMs(m.without)} ms instead of ${fmtMs(m.with)} ms (③ and ⑤ off)`)}">${m.with >= m.without ? '−' : '+'}${fmtMs(Math.abs(m.with - m.without))} ms</span>` : '')
            + `<span class="rpk-measure-row fa-solid fa-stopwatch" title="${t`Measure this chat without this script`}"></span>`
            + (r.spike ? ` <span class="rpk-repro fa-solid fa-copy" title="${t`Copy a repro of the newest spike (pattern, input length and head) for a bug report`}"></span>` : '')
            + (r.ids.length ? ` <span class="rpk-edit fa-solid fa-pencil" title="${t`Open in the Regex extension`}"></span> <span class="rpk-off fa-solid fa-power-off" title="${t`Turn this script off`}"></span>` : '');
        return `<tr class="${cls}${r.ids.length ? ' rpk-script' : ''}" title="${esc(r.src)}" data-i="${i}">
          ${td('rank', ranks.get(r))}${td('name', esc(r.name) + warnings(r, true).join(''))}
          ${td('runs', r.calls)}${td('total', fmtMs(r.totalMs))}${td('avg', fmtMs(avgMs(r)))}${td('max', fmtMs(r.maxMs))}
          ${td('repl', fmtMs(r.replMs))}${td('matched', r.matched)}${td('changed', r.changed)}
          ${td('skips', r.skipped)}${td('hits', r.hits)}${td('lit', lit ? esc(lit) : `<span class="rpk-dim">${t`none`}</span>`, 'rpk-lit', litTitle(r, lit))}
          ${td('act', actions, 'rpk-act')}
        </tr>`;
    }).join('') || `<tr><td colspan="13" class="rpk-dim rpk-empty">${nameFilter && s.rows.length ? t`No script name contains "${nameFilter}".` : t`No runs measured yet. Render a message or reopen the chat.`}</td></tr>`);

    setContent(ui.note, !persistAvailable
        ? t`⑤ and the compromise mode need a newer SillyTavern (staging with MessageFormatter hooks).`
        : settings.persist ? t`⑤ is on: display results are being saved in this chat. Changing a script invalidates them automatically.` : '', 'textContent');
    setContent(ui.usage, s.usage, 'textContent');
    setContent(ui.measure, measured ? `<p>${esc(measureText(measured))}</p><p class="rpk-dim">${esc(slowestText(measured))}</p>` : '');

    const lint = lintRows();
    ui.lint = lint;
    setContent(ui.lintCount, lint.length ? `(${lint.length})` : '', 'textContent');
    setContent(ui.lintList, lint.length ? lint.map((row, i) => `<li data-rule="${row.rule}" data-script="${esc(row.info.name)}" data-i="${i}"><b>${esc(row.info.name)}</b>: ${esc(row.text)}`
        + (row.fix ? ` <span class="menu_button rpk-fix" title="${esc(t`Shows the change and saves it through the regex engine when you confirm`)}">${esc(row.fix.label)}</span>` : '')
        + (row.info.ids.length ? ` <span class="rpk-edit fa-solid fa-pencil" title="${t`Open in the Regex extension`}"></span>` : '') + '</li>').join('')
        : `<li class="rpk-dim">${settings.lint ? t`Nothing to report` : t`Lint is off (Limits)`}</li>`);
}

/**
 * Turning a script off goes through the engine (saveScriptsByType, feature list 3 row 9); opening it in the editor
 * has no API, so the Regex drawer's own list is used: each script row has the script's id and an .edit_existing_regex
 * button (and a .regex-toggle-on switch, the fallback for turning it off on an engine without saveScriptsByType).
 */
async function scriptAction(r, off) {
    if (off && await saveScript(r.ids, { disabled: true })) {
        toastr.info(t`Turned off: ${r.name}`);
        return;
    }
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
    toastr.info(t`Turned off: ${r.name}`);
}

function bindUi() {
    const root = document.getElementById('regex_perf_kit');
    const find = (sel) => root.querySelector(sel);
    ui = { summary: find('#rpk_summary'), thead: find('#rpk_table thead'), tbody: find('#rpk_table tbody'), note: find('#rpk_persist_note'), usage: find('#rpk_usage'), measure: find('#rpk_measure_result'), lintList: find('#rpk_lint_list'), lintCount: find('#rpk_lint_count'), rows: [], lint: [] };

    /** Shows the current settings in the toggles and limit fields (at start and after a reset). */
    const syncControls = () => {
        for (const [id, key] of Object.entries(TOGGLES)) find('#' + id).checked = !!settings[key];
        for (const key of Object.keys(LIMITS)) find('#rpk_' + key).value = settings[key];
    };
    for (const [id, key] of Object.entries(TOGGLES)) {
        const el = find('#' + id);
        el.addEventListener('change', () => {
            settings[key] = el.checked;
            ctx().saveSettingsDebounced();
            if ((key === 'memo' && !el.checked) || key === 'memoHashKeys') clearMemo(); // entries keyed the other way are useless
            renderPanel();
        });
    }
    if (!persistAvailable) find('#rpk_persist').disabled = find('#rpk_stream_throttle').disabled = true;

    for (const [key, [min, max]] of Object.entries(LIMITS)) {
        const el = find('#rpk_' + key);
        Object.assign(el, { min, max });
        el.addEventListener('change', () => {
            const v = Number(el.value);
            if (el.value.trim() !== '' && Number.isFinite(v)) settings[key] = Math.min(max, Math.max(min, Math.round(v)));
            el.value = settings[key];
            ctx().saveSettingsDebounced();
            trimMemo();
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
            ctx().saveSettingsDebounced();
        });
    }

    find('#rpk_reset_settings').addEventListener('click', () => {
        Object.assign(settings, defaultSettings); // settings.ui (open sections) is not a feature setting and stays
        syncControls();
        clearMemo();
        ctx().saveSettingsDebounced();
        renderPanel();
        toastr.info(t`Settings restored to their defaults.`);
    });
    find('#rpk_refresh').addEventListener('click', () => { markDirty(); renderPanel(); });
    find('#rpk_reset').addEventListener('click', () => { resetStats(); renderPanel(); toastr.info(t`Stats reset.`); });
    for (const [id, build] of [['rpk_copy', buildReportText], ['rpk_copy_json', () => JSON.stringify(buildReportData(), null, 2)], ['rpk_copy_csv', buildReportCsv]]) {
        find('#' + id).addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(build());
                toastr.success(t`Report copied to the clipboard.`);
            } catch {
                toastr.warning(t`Could not copy — use the /regexperf command to see the report in a popup.`);
            }
        });
    }
    find('#rpk_clear_persist').addEventListener('click', async () => {
        const n = await clearPersistedCache();
        toastr.info(t`Removed ${n} persistent cache entries.`);
        renderPanel();
    });
    /** Runs fn (a measurement) after the toast had a moment to paint; not during a stream, not twice at a time. */
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

    // auto-refresh: when the stats changed, on the next frame, at most every RENDER_MIN_MS, only while the drawer is open;
    // the cost chips in the Regex drawer's lists follow the same beat
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

/** Copies text to the clipboard, with a toast either way. */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toastr.success(t`Copied to the clipboard.`);
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
    console.log('[RegexPerf] built-in regex extension is disabled; nothing to do.');
}
patchProvider();
eventSource.on(event_types.GENERATION_STARTED, (_type, _params, dryRun) => {
    if (dryRun) return;
    checkWrapper();
    generating = true;
    streamViews.clear();
});
for (const event of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
    eventSource.on(event, () => {
        generating = false;
        streamViews.clear();
    });
}
let loadHintShown = false; // once per session
for (const event of [event_types.CHARACTER_MESSAGE_RENDERED, event_types.USER_MESSAGE_RENDERED]) {
    if (event) eventSource.on(event, () => { chatLen++; });
}
eventSource.on(event_types.CHAT_CHANGED, () => {
    markDirty();
    streamViews.clear();
    forgetPersistAcct();
    chatLen = ctx().chat?.length ?? 0;
    const now = performance.now();
    const loadMs = now - lastCall < BURST_GAP_MS ? lastCall - burstStart : 0; // the render burst that just ended
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
if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, forgetPersistAcct);
eventSource.on(event_types.SETTINGS_UPDATED, markDirty);
if (event_types.PRESET_CHANGED) eventSource.on(event_types.PRESET_CHANGED, markDirty);
eventSource.on(event_types.APP_READY, () => {
    try { installPersistHooks(); } catch (e) { console.warn('[RegexPerf] persist hooks failed', e); }
    try {
        const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (container) {
            container.insertAdjacentHTML('beforeend', settingsHtml());
            bindUi();
            document.addEventListener('click', onTripControl); // ⑧ Undo / Open script, in toasts and in the table
            renderPanel();
        }
    } catch (e) { console.warn('[RegexPerf] UI init failed', e); }
    try { registerSlash(); } catch (e) { console.warn('[RegexPerf] slash command failed', e); }
    console.log('[RegexPerf] ready. patched=', patched, 'persistHooks=', persistAvailable);
});
