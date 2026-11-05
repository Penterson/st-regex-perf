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

const defaultSettings = {
    profiler: true,
    prefilter: true,
    memo: true,
    memoMaxEntries: 3000,
    memoMaxLen: 20000,
    memoMaxMB: 64,
    streamingSkip: true,
    streamingThrottle: false, // ④ compromise mode: format the streamed message at most every streamingThrottleMs
    streamingThrottleMs: 500,
    persist: false,
    persistMaxLen: 60000,
    persistMaxMB: 8, // ⑤ per chat; beyond it, the oldest messages' results are dropped
    memoHashKeys: false, // ③ keyed by hash64(input) + length instead of the input: half the memory, see the Limits note
    autoMeasure: false, // run "Measure on this chat" once after a chat opens
    loadHintMs: 3000, // a chat whose first render takes longer gets a one-time hint about "# Messages to Load"
};

// ST keeps this object for the whole session, so it is resolved once instead of on every replace.
const settings = (extensionSettings.regex_perf_kit ||= {});
for (const [key, value] of Object.entries(defaultSettings)) {
    if (!Object.hasOwn(settings, key)) settings[key] = value;
}

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
const BAIL = Symbol('bail');

// ② Literal presence per input: each literal (or case-insensitive check) gets a small id once, and an input remembers
// the answers in an array by id, so the same string flowing through every script is scanned once per literal. The
// last input is found without hashing. With keep, the input also goes into a map of the LIT_CACHE_MAX most recent
// ones (no longer than the memo's limit) for the re-renders of displayed messages; hashing a fresh long string
// costs about as much as a few scans, so save-time inputs, which never come back, are not kept. Cleared when the
// script info changes.
const LIT_CACHE_MAX = 256;
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
        if (!keep || str.length > settings.memoMaxLen) {
            litSeen = [];
        } else {
            litSeen = litCache.get(str);
            if (!litSeen) {
                if (litCache.size >= LIT_CACHE_MAX) litCache.delete(litCache.keys().next().value);
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
 * is a mandatory run, a longer one comes from an alternation) and is at least minLen UTF-16 units long; test(str)
 * (keep: remember this input's answers for a re-render) checks both, needles is the single best term (null if none is certain, with a NEEDLE_REASONS code in reason).
 * nested: an unbounded quantifier inside an unboundedly repeated group, e.g. (a+)+.
 * Conservative: classes, class escapes, backreferences, lookarounds and modifier groups contribute no literal, and
 * patterns with the v flag or a case modifier ((?i:), (?-i:)) get nothing at all. Literals in groups that must
 * match join the surrounding run; an alternation yields one literal per branch (any of them must occur), provided
 * every branch has one.
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
    const better = (a, b) => !b || score(a) > score(b) || (score(a) === score(b) && a.length < b.length);

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
            const hex = { u: 4, x: 2 }[nx]; // \uXXXX \xXX: skip the digits; without them (and u) it is the letter itself
            if (hex) {
                const digits = source.slice(i, i + hex);
                if (digits.length === hex && /^[0-9a-fA-F]+$/.test(digits)) {
                    i += hex;
                    return one;
                }
                return u ? one : literal(nx);
            }
            if (nx === 'c') {
                if (/[a-zA-Z]/.test(source[i] ?? '')) i++;
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

// .*  .+  [\s\S]*  [^]*  (.|\n)*  [\w\W]* — likely heavy backtracking
const HEAVY_HINT = /\.\*|\.\+|\[\\s\\S\]\*|\[\^\]\*|\(\.\|\\n\)\*|\[\\w\\W\]\*/;

// ---- Script info: compiled pattern key -> script metadata ----

const keyOf = (re) => re.source + '\u0000' + re.flags;

/** @type {{map: Map<string, object>, counts: object, depthRules: number[][], version: string, builtAt: number} | null} */
let infoCache = null; // null = rebuild on next use
const markDirty = () => { infoCache = null; };

function ensureInfo() { // runs on every RegexProvider.get(): Date.now() is the cheaper clock
    if (!infoCache || Date.now() - infoCache.builtAt > 5000) infoCache = buildInfo();
    return infoCache;
}

function buildInfo() {
    // Scripts by origin, in the engine's priority order (global, preset, scoped); older engines only have the flat list.
    const groups = [];
    try {
        if (typeof getScriptsByType === 'function' && SCRIPT_TYPES) {
            for (const [name, type] of Object.entries(SCRIPT_TYPES)) groups.push([name.toLowerCase(), getScriptsByType(type, { allowedOnly: true }) ?? []]);
        } else {
            groups.push(['global', getRegexScripts({ allowedOnly: true }) ?? []]);
        }
    } catch (e) { console.warn('[RegexPerf] reading regex scripts failed', e); }
    const { substituteParamsExtended } = ctx();
    const map = new Map();
    const counts = { total: 0, active: 0, noNeedle: 0, heavy: 0, nested: 0, types: {} };
    const versionParts = [];
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
            if (substitute === 1 || substitute === 2) { // RAW / ESCAPED, as runRegexScript() compiles them
                try { rs = substituteParamsExtended(rs, {}, substitute === 2 ? sanitizeRegexMacro : undefined); } catch { /* keep the raw pattern */ }
            }
            let re;
            try { re = regexFromString(rs); } catch { /* invalid pattern */ }
            if (!re) continue;

            const key = keyOf(re);
            const prev = map.get(key);
            const replaceString = String(s.replaceString ?? '');
            const trims = Array.isArray(s.trimStrings) ? s.trimStrings : [];
            const trimSig = trims.join('\u0002');
            const needle = prev?.needle ?? extractNeedle(re.source, re.flags);
            if (!needle.needles) counts.noNeedle++;
            if (HEAVY_HINT.test(re.source)) counts.heavy++;
            if (needle.nested) counts.nested++;

            // As runRegexScript() reads it: {{match}} is $0, then group references are filled in.
            const replacement = replaceString.replace(/{{match}}/gi, '$0');
            const info = {
                name: s.scriptName || t`(no name)`,
                markdownOnly: !!s.markdownOnly,
                // No macros, and no group reference that could complete one (<$1>, {$1}): the output then depends
                // only on the input, so it can be memoized.
                pure: !MACRO.test(replacement) && !/[{<]\$(?:\d|<)|\$(?:\d+|<[^>]+>)[}>]/.test(replacement)
                    && !trims.some(trim => MACRO.test(String(trim))),
                replaceSig: fnv1a(replaceString + '\u0001' + trimSig),
                needle,
                ids: [s.id], // for the row actions in the table
            };
            if (prev) { // scripts with the same pattern share one wrapper: keep only what holds for all of them
                info.name = prev.name + ', ' + info.name;
                info.ids = [...prev.ids, s.id];
                info.markdownOnly &&= prev.markdownOnly;
                info.pure &&= prev.pure && prev.replaceSig === info.replaceSig;
            }
            map.set(key, info);

            // The same limits getRegexedString() applies; display scripts only, as those are what ⑤ stores.
            const min = !isNaN(s.minDepth) && s.minDepth !== null && s.minDepth >= -1 ? Number(s.minDepth) : -Infinity;
            const max = !isNaN(s.maxDepth) && s.maxDepth !== null && s.maxDepth >= 0 ? Number(s.maxDepth) : Infinity;
            if (s.markdownOnly && (min > -Infinity || max < Infinity)) depthRules.push([min, max]);
            versionParts.push(re.source, re.flags, replaceString, trimSig, String(!!s.markdownOnly), String(!!s.promptOnly), String(s.minDepth), String(s.maxDepth), String(s.placement));
        }
    }
    const version = fnv1a(versionParts.join('\u0003'));
    if (version !== infoCache?.version) clearLitCache(); // other scripts, other literals
    return { map, counts, depthRules, version, builtAt: Date.now() };
}

// ---- Instrumented RegExp ----

// Regex calls come in bursts (a chat opening renders every message back to back); the burst that ends at
// CHAT_CHANGED is the chat's first render, and its length decides the "# Messages to Load" hint.
const BURST_GAP_MS = 1000;
let burstStart = 0;
let lastCall = -Infinity;
const SPIKE_MS = 50; // a single run slower than this is flagged, with a sample of its input
const SPIKE_HEAD = 80; // characters of the input kept in the sample
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

// ③ Memo: memoPrefix -> Map(key -> entry). The key is the input string itself (its hash is cached and the same
// string object flows through consecutive scripts, so no key is built per call) or, with memoHashKeys, its 64-bit
// hash and length: the entry then holds no input, which halves the memory, at the cost of hashing every input and
// of trusting 64 bits + length to tell inputs apart (a collision would return another input's result). memoLru
// orders all entries, least recently used first; memoBytes is their estimated size (2 bytes per UTF-16 unit).
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
    const maxBytes = settings.memoMaxMB * 1048576;
    while (memoLru.size && (memoLru.size > settings.memoMaxEntries || memoBytes > maxBytes)) {
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
            skipped: 0, hits: 0, streamSkipped: 0, bypass: 0,
            spike: null, // {ms, len, head}: the newest run over SPIKE_MS
            heavy: HEAVY_HINT.test(re.source),
            needle: null, // the needle the wrapper uses (and its nested flag), set with its meta
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
        const { stat, markdownOnly, test, memoPrefix } = this._meta;

        if (stat === skipStat) return str;
        if (bypass) {
            stat.bypass++;
            return str;
        }
        if (settings.streamingSkip && markdownOnly && !streamApply && liveStream()) {
            stat.streamSkipped++;
            prevStat = stat;
            prevIn = prevOut = str;
            return str;
        }
        // a displayed message comes back on every re-render: its literal answers are kept (save-time inputs do not)
        if (settings.prefilter && test && !test(str, markdownOnly || displayPass)) {
            stat.skipped++;
            if (prevOut === str && prevIn !== str && prevStat !== stat) noteConflict(prevStat, stat, prevIn, test, this._native, markdownOnly || displayPass);
            prevStat = stat;
            prevIn = prevOut = str;
            return str;
        }

        let bucket;
        let memoKey;
        // Matched text with macros is substituted again after the groups are inserted, so it is not memoized.
        if (settings.memo && memoPrefix && str.length <= settings.memoMaxLen && !hasMacro(str)) {
            bucket = memo.get(memoPrefix);
            if (!bucket) memo.set(memoPrefix, bucket = new Map());
            memoKey = settings.memoHashKeys ? hash64(str) + ':' + str.length : str;
            const hit = bucket.get(memoKey);
            if (hit) {
                memoLru.delete(hit); // mark as most recently used
                memoLru.add(hit);
                stat.hits++;
                prevStat = stat;
                prevIn = str;
                prevOut = hit.out;
                return hit.out;
            }
        }

        const native = this._native;
        native.lastIndex = 0;
        // SillyTavern's replacer (groups, trim strings, macros) is timed apart from the matching itself.
        const profile = settings.profiler;
        let replMs = 0;
        let matched = false; // the replacer ran, so the pattern matched (even if the text came out the same)
        const fn = profile && typeof replacer === 'function'
            ? function () {
                matched = true;
                const t1 = performance.now();
                const r = replacer.apply(this, arguments);
                replMs += performance.now() - t1;
                return r;
            }
            : replacer;
        const t0 = profile ? performance.now() : 0;
        const out = RegExp.prototype[Symbol.replace].call(native, str, fn);
        if (profile) {
            const dt = performance.now() - t0;
            if (t0 - lastCall > BURST_GAP_MS) burstStart = t0;
            lastCall = t0 + dt;
            stat.calls++;
            stat.totalMs += dt;
            stat.replMs += replMs;
            if (dt > stat.maxMs) stat.maxMs = dt;
            if (dt > SPIKE_MS) stat.spike = { ms: dt, len: str.length, head: str.slice(0, SPIKE_HEAD) };
            if (out !== str) stat.changed++;
            // A string replacer (not SillyTavern's) tells nothing: test short inputs, assume a match on long ones.
            if (matched || (fn === replacer && (out !== str || str.length > 2000 || native.test(str)))) stat.matched++;
        }
        this.lastIndex = native.lastIndex; // leave this regex as a native replace would
        prevStat = stat;
        prevIn = str;
        prevOut = out;

        const size = ((memoKey === str ? str.length : memoKey?.length ?? 0) + out.length) * 2;
        if (bucket && size <= settings.memoMaxMB * 1048576) { // an entry larger than the budget would flush the memo
            const entry = { bucket, key: memoKey, out, size };
            bucket.set(memoKey, entry);
            memoLru.add(entry);
            memoBytes += size;
            trimMemo();
        }
        return out;
    }
}

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

function patchProvider() {
    const inst = RegexProvider?.instance;
    if (!inst || typeof inst.get !== 'function') {
        console.warn('[RegexPerf] RegexProvider.instance not found — this ST version is not supported.');
        return;
    }
    const origGet = inst.get.bind(inst);
    const origClear = inst.clear.bind(inst);

    inst.get = function (regexString) {
        const base = origGet(regexString);
        if (!base) return null;
        const { map, version } = ensureInfo();
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
            const info = map.get(key);
            const stat = getStat(key, base);
            if (info) stat.name = info.name;
            stat.ids = info?.ids ?? [];
            stat.needle = info?.needle ?? extractNeedle(base.source, base.flags);
            w._meta = {
                stat,
                markdownOnly: !!info?.markdownOnly,
                test: stat.needle.test,
                memoPrefix: info?.pure ? key + '\u0001' + info.replaceSig + '\u0001' : null,
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

// ---- MessageFormatter hooks: ⑤ persisted display cache, ④ compromise mode ----

let persistAvailable = false; // the hooks exist (recent SillyTavern)
let pending = null; // {msg, key, input}: message awaiting its after-regex result
const streamViews = new Map(); // ④ compromise: "<messageId><m|r>" -> {at, prefix, out} of the streamed message
let streamView = null; // the view this pass formats
let streamTail = null; // raw text this pass appends after the regex stage

/** Clears the state the two hooks share for one formatting pass. */
function resetPass() {
    bypass = streamApply = displayPass = false;
    pending = streamView = streamTail = null;
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
    if (view?.out != null && mes.startsWith(view.prefix) && (cut <= view.prefix.length || now - view.at < settings.streamingThrottleMs)) {
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
        const sp = settings.persist || settings.streamingThrottle ? liveStream() : null;
        if (sp) return settings.streamingSkip && settings.streamingThrottle && sp.messageId === c.messageId ? streamPass(mes, c) : mes;
        if (!settings.persist || c.isReasoning) return mes;
        const { chat, name1, name2 } = ctx();
        const msg = chat?.[c.messageId];
        if (!msg) return mes;
        // {{user}}/{{char}} in replacements and trim strings resolve to these names (ch_name: the message author).
        const names = fnv1a([c.ch_name ?? c.characterName, name1, name2].join('\u0000'));
        const { version, depthRules } = ensureInfo();
        let depths = '';
        if (depthRules.length) { // which depth-limited scripts apply at this message's depth, as messageFormatting() counts it
            let depth = 0;
            for (let k = c.messageId + 1; k < chat.length; k++) if (!chat[k]?.is_system) depth++;
            depths = msg.is_system ? ':*' : ':' + depthRules.map(([min, max]) => (depth < min || depth > max ? 0 : 1)).join('');
        }
        // 64 bits of the text: a 32-bit hash alone collides once in a few tens of thousands of same-length messages.
        // Entries keyed the old way simply miss and are recomputed.
        const key = hash64(mes) + ':' + mes.length + ':' + version + ':' + names + depths;
        const e = msg.extra?.[EXTRA_KEY];
        if (e && e.k === key) {
            bypass = true;
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
        if (!p || mes.length > settings.persistMaxLen) return mes;
        p.msg.extra ||= {};
        p.msg.extra[EXTRA_KEY] = mes === p.input ? { k: p.key, same: 1 } : { k: p.key, v: mes };
        persistStats.stores++;
        trimPersisted(ctx().chat);
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
/** A pattern the extension has seen do anything: rows that never ran nor were skipped are left out of the table. */
const active = (r) => r.calls + avoided(r) + r.bypass > 0;
const badge = (text, title) => ` <span class="rpk-badge" title="${esc(title)}">${text}</span>`;
/** A row's warnings: words for the report, or badges for the panel. */
const warnings = (r, badges = false) => [
    r.heavy && (badges ? badge('.*', t`Contains .* or similar: may be slow on long text (backtracking)`) : t`.*-style`),
    r.needle?.nested && (badges ? badge('(a+)+', t`Nested quantifier such as (a+)+: can become extremely slow on long text`) : t`nested quantifier`),
    r.maxMs > SPIKE_MS && (badges ? badge('⚡', t`One run took ${fmtMs(r.maxMs)} ms (more than ${SPIKE_MS} ms)` + (r.spike ? '\n' + spikeText(r.spike) : '')) : t`spike`),
    conflictsOf(r).length > 0 && (badges ? badge('⇅', conflictsOf(r).map(c => conflictText(c)).join('\n')) : t`order conflict`),
    ineffective(r) && (badges ? badge('∅', t`Ran ${r.calls} times without ever matching: consider turning it off`) : t`no match`),
].filter(Boolean);

function buildSummary() {
    const { counts } = ensureInfo();
    const rows = [...stats.values()].filter(active).sort((a, b) => b.totalMs - a.totalMs || avoided(b) - avoided(a));
    const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);
    const total = sum('totalMs');
    const top = rows.find(r => r.calls > 0);
    const { chat } = ctx();
    return {
        counts,
        rows,
        total,
        calls: sum('calls'),
        skipped: sum('skipped'),
        hits: sum('hits'),
        streamSkipped: sum('streamSkipped'),
        bypass: sum('bypass'),
        saved: rows.reduce((acc, r) => acc + savedMs(r), 0),
        ineffective: rows.filter(ineffective).map(r => r.name),
        chatLen: chat?.length ?? 0,
        top,
        topShare: top && total > 0 ? top.totalMs / total * 100 : 0,
        usage: t`③ memory cache: ${memoLru.size} entries, ${(memoBytes / 1048576).toFixed(1)} of ${settings.memoMaxMB} MB`
            + (persistAvailable ? '. ' + persistUsage(chat) : ''),
    };
}

/** Size of a ⑤ entry, in characters (about its bytes in the chat file). */
const persistSize = (e) => String(e.k).length + (e.v?.length ?? 0);

/** Drops ⑤ entries from the oldest messages until the chat is within persistMaxMB. */
function trimPersisted(chat) {
    if (!chat) return;
    let chars = 0;
    for (const m of chat) {
        const e = m?.extra?.[EXTRA_KEY];
        if (e) chars += persistSize(e);
    }
    const max = settings.persistMaxMB * 1048576;
    for (let i = 0; chars > max && i < chat.length; i++) {
        const e = chat[i]?.extra?.[EXTRA_KEY];
        if (!e) continue;
        chars -= persistSize(e);
        delete chat[i].extra[EXTRA_KEY];
    }
}

/** ⑤ storage in this chat against its cap (only scanned when the hooks exist). */
function persistUsage(chat) {
    let entries = 0;
    let chars = 0;
    for (const m of chat ?? []) {
        const e = m?.extra?.[EXTRA_KEY];
        if (!e) continue;
        entries++;
        chars += persistSize(e);
    }
    return t`⑤ saved in this chat: ${entries} messages, ≈${Math.round(chars / 1024)} KB of ${settings.persistMaxMB} MB`;
}

let measured = null; // last "Measure on this chat" result
const rowMeasures = new Map(); // stat -> {with, without}: per-row measurements of this session

const SLOWEST_MESSAGES = 5;
/** "#12 (4321 chars) 85 ms, ..." for the slowest messages of a measurement. */
const slowestText = (m) => t`Slowest messages (features off): ${m.slowest.map(x => t`#${x.i} (${x.len} chars) ${fmtMs(x.ms)} ms`).join(', ')}`;
const measureText = (m) => t`This chat (${m.messages} messages): ${fmtMs(m.off)} ms with the features off, ${fmtMs(m.on)} ms on — ${fmtMs(m.off - m.on)} ms saved (${m.off > 0 ? Math.round((m.off - m.on) / m.off * 100) : 0}%)`;

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
        t`Scripts: ${c.total} total, ${c.active} active (${typeCounts(c)}), no literal ${c.noNeedle}, possibly heavy ${c.heavy}, nested quantifiers ${c.nested}`,
        t`Ran ${s.calls} times / ${fmtMs(s.total)} ms total | skipped ${skips} (prefilter ${s.skipped}, cache hits ${s.hits}, streaming ${s.streamSkipped}) | persistent cache bypasses ${s.bypass} (hits ${persistStats.hits}, stored ${persistStats.stores})`,
        s.calls
            ? t`Estimated time saved: ≈${fmtMs(s.saved)} ms (${skips} skipped runs × each script's average run time)`
            : t`Estimated time saved: not available yet (no measured runs)`,
        s.usage,
    ];
    if (measured) lines.push(measureText(measured), slowestText(measured));
    if (s.top) lines.push(t`#1 "${s.top.name}" takes ${s.topShare.toFixed(0)}% of the total time`);
    if (s.ineffective.length) lines.push(t`Candidates to disable (ran ${INEFFECTIVE_RUNS}+ times, never matched): ${s.ineffective.join(', ')}`);
    lines.push('', t`Rank | Script | Runs | Total ms | Avg ms | Max ms | Replacer ms | Matched | Changed | Skips | Hits | Stream skips | Literal | Min length | Warnings`);
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
        spikes.forEach(r => lines.push(`${r.name}: ${spikeText(r.spike)}`));
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
        scripts: s.counts,
        totals: { calls: s.calls, totalMs: s.total, skipped: s.skipped, hits: s.hits, streamSkipped: s.streamSkipped, bypass: s.bypass, persistHits: persistStats.hits, persistStores: persistStats.stores, savedMs: s.calls ? s.saved : null },
        memo: { entries: memoLru.size, bytes: memoBytes, maxMB: settings.memoMaxMB },
        measured,
        candidatesToDisable: s.ineffective,
        orderConflicts: [...conflicts.values()].map(c => ({ earlier: c.earlier.name, later: c.later.name, count: c.count, confirmed: c.confirmed, sample: c.sample })),
        rows: s.rows.map((r, i) => ({
            rank: i + 1, name: r.name, pattern: r.src, runs: r.calls, totalMs: r.totalMs, avgMs: avgMs(r), maxMs: r.maxMs, replacerMs: r.replMs,
            matched: r.matched, changed: r.changed, skips: r.skipped, hits: r.hits, streamSkips: r.streamSkipped,
            literal: r.needle?.terms ?? [], literalReason: r.needle?.reason ?? null, minLength: r.needle?.minLen ?? 0, warnings: warnings(r), spike: r.spike,
        })),
    };
}

/** The report's table as CSV (RFC 4180 quoting), with the text report's translated header. */
function buildReportCsv() {
    const cell = (v) => {
        const str = String(v ?? '');
        return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const header = t`Rank | Script | Runs | Total ms | Avg ms | Max ms | Replacer ms | Matched | Changed | Skips | Hits | Stream skips | Literal | Min length | Warnings`.split(' | ');
    const lines = [header.map(cell).join(',')];
    buildSummary().rows.forEach((r, i) => {
        lines.push([i + 1, r.name, r.calls, r.totalMs, avgMs(r), r.maxMs, r.replMs, r.matched, r.changed, r.skipped, r.hits, r.streamSkipped, fmtNeedles(r) ?? '', r.needle?.minLen || '', warnings(r).join('; ')].map(cell).join(','));
    });
    return lines.join('\r\n');
}

/** Turns off the scripts whose name matches (exactly, else as the only one containing it); the message to show. */
function turnOffByName(name) {
    const want = name.trim().toLowerCase();
    if (!want) return t`Usage: /regexperf off <script name>`;
    const infos = [...ensureInfo().map.values()];
    const found = infos.filter(r => r.name.toLowerCase() === want);
    const hits = found.length ? found : infos.filter(r => r.name.toLowerCase().includes(want));
    if (hits.length !== 1) return hits.length ? t`"${name}" matches several scripts: ${hits.map(r => r.name).join(', ')}` : t`"${name}" is not in the Regex extension's list.`;
    scriptAction(hits[0], true);
    renderPanel();
    return t`Turned off: ${hits[0].name}`;
}

const COUNTERS = ['calls', 'totalMs', 'maxMs', 'replMs', 'matched', 'changed', 'skipped', 'hits', 'streamSkipped', 'bypass', 'spike'];
const FEATURES_OFF = { profiler: false, prefilter: false, memo: false, persist: false }; // what a measurement turns off

const CACHES_OFF = { profiler: false, memo: false, persist: false }; // a per-row measurement keeps the prefilter as set

/**
 * Renders every message of the current chat as SillyTavern displays it (messageFormatting), first with the
 * prefilter, the memo and ⑤ off, then with the user's settings, and returns both times. With a stat, both passes
 * run with the caches off, the second one without that pattern: {with, without}. The chat was rendered when it
 * opened, so this is a re-render, as on swipes, edits and reloads. Synchronous, so the temporarily changed settings
 * can never be saved, and the stats are restored afterwards.
 */
function measureChat(without = null) {
    const { chat, messageFormatting } = ctx();
    if (!chat?.length || typeof messageFormatting !== 'function') return null;
    const render = (times) => { // times: per-message {i, len, ms} are pushed when given
        const t0 = performance.now();
        chat.forEach((m, i) => {
            const t1 = times ? performance.now() : 0;
            if (m?.mes) messageFormatting(m.mes, m.name, m.is_system, m.is_user, i);
            if (m?.extra?.reasoning) messageFormatting(m.extra.reasoning, '', false, false, i, {}, true);
            if (times) times.push({ i, len: (m?.mes?.length ?? 0) + (m?.extra?.reasoning?.length ?? 0), ms: performance.now() - t1 });
        });
        return performance.now() - t0;
    };
    const user = Object.fromEntries(Object.keys(FEATURES_OFF).map(k => [k, settings[k]]));
    const saved = new Map([...stats].map(([k, st]) => [k, COUNTERS.map(c => st[c])]));
    const savedPersist = { ...persistStats };
    const savedConflicts = new Map([...conflicts].map(([k, c]) => [k, { ...c }]));
    const times = [];
    let first, second;
    try {
        Object.assign(settings, without ? CACHES_OFF : FEATURES_OFF);
        first = render(without ? null : times); // per message with the features off: the raw cost of each
        if (without) skipStat = without;
        else Object.assign(settings, user, { profiler: false });
        second = render();
    } finally {
        skipStat = null;
        Object.assign(settings, user);
        for (const [k, st] of stats) COUNTERS.forEach((c, i) => { st[c] = saved.get(k)?.[i] ?? 0; });
        Object.assign(persistStats, savedPersist);
        conflicts.clear();
        for (const [k, c] of savedConflicts) conflicts.set(k, c);
    }
    if (without) return { with: first, without: second };
    return { messages: chat.length, off: first, on: second, slowest: times.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_MESSAGES) };
}

function resetStats() {
    stats.clear();
    rowMeasures.clear();
    conflicts.clear();
    statsSince = Date.now();
    persistStats.hits = persistStats.stores = 0;
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

/** A number field for LIMITS[key]; bindUi() finds it as #rpk_<key>. */
const limit = (key, name, title) => `<label${title ? ` title="${title}"` : ''}><span>${name}</span><input type="number" class="text_pole" id="rpk_${key}"></label>`;

// Table cells carry a column class so the narrow layout can hide columns; headers explain themselves on hover.
const th = (col, text, title) => `<th class="rpk-col-${col}${SORT_KEYS[col] ? ' rpk-sortable' : ''}${sortBy === col ? ' rpk-sorted' : ''}" data-col="${col}"${title ? ` title="${esc(title)}"` : ''}>${text}${sortBy === col ? (sortDesc ? ' ▾' : ' ▴') : ''}</th>`;

// Sorting and the name filter are per session (not saved). Clicking a header sorts by it, again flips the direction.
const SORT_KEYS = {
    rank: (r, i) => i, name: (r) => r.name.toLowerCase(), runs: (r) => r.calls, total: (r) => r.totalMs, avg: avgMs, max: (r) => r.maxMs,
    repl: (r) => r.replMs, matched: (r) => r.matched, changed: (r) => r.changed, skips: (r) => r.skipped, hits: (r) => r.hits, lit: (r) => fmtNeedles(r) ?? '',
};
let sortBy = null;
let sortDesc = true;
let nameFilter = '';

const headerHtml = () => `<tr>
            ${th('rank', '#')}${th('name', t`Script`)}
            ${th('runs', t`Runs`, t`Regex runs that really happened`)}${th('total', t`Total ms`)}${th('avg', t`Avg`, t`Time per run, averaged`)}${th('max', t`Max`, t`Slowest single run`)}
            ${th('repl', t`Replacer`, t`Time spent in the replacement (group filling, trim strings, macros), included in Total ms`)}${th('matched', t`Matched`, t`Runs where the pattern matched, even if the text came out the same`)}${th('changed', t`Changed`, t`Runs that changed the text`)}
            ${th('skips', t`Skips`, t`Runs skipped by ② (the fixed text was absent)`)}${th('hits', t`Hits`, t`Results reused by ③`)}${th('lit', t`Literal`, t`The fixed text ② looks for before running this script: every literal joined by & must be present, one of those joined by |. Hover a cell for the shortest possible match.`)}${th('act', '')}
          </tr>`;
const td = (col, value, cls = '', title = '') => `<td class="rpk-col-${col}${cls ? ' ' + cls : ''}"${title ? ` title="${esc(title)}"` : ''}>${value}</td>`;

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
        ${feature('rpk_profiler', t`① Measure run time (profiler)`, t`Counts how often each script runs and how long it takes, for the table below. Costs almost nothing.`)}
        ${feature('rpk_prefilter', t`② Skip runs that cannot match (literal prefilter)`, t`If the message does not even contain the fixed text a script looks for (such as &lt;/status&gt;), the regex is not run. The result is exactly the same.`)}
        ${feature('rpk_memo', t`③ Reuse results (memory cache)`, t`When the same script runs on the same message again (swipes, re-renders, reloads), the previous result is reused. Scripts and text with {{macros}} are left out automatically.`)}
        <div class="rpk-feature-group">
        ${feature('rpk_streaming', t`④ Rest display scripts while streaming`, t`While a reply is being generated, "Only Format Display" scripts are skipped and applied once when it finishes. This removes most streaming lag.`)}
        ${feature('rpk_stream_throttle', t`Compromise: keep formatting the finished lines`, t`With ④ on, display scripts still format the lines that are already complete, at most once per interval (0.5 s by default, under Limits). The line being written stays raw; the finished reply gets every script.`, { sub: true })}
        </div>
        ${feature('rpk_persist', t`⑤ Save results in the chat file (persistent cache)`, t`Stores the display result with the message, so reopening the chat skips the work. The chat file grows; results are recomputed automatically when a script changes.`, { labelId: 'rpk_persist_label' })}
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
          <label title="${t`Keeps a 64-bit hash of each input instead of the input: about half the memory for long chats, at the cost of hashing every input. A collision (two same-length inputs with the same hash) would return the other input's result; with 64 bits that takes billions of inputs.`}"><span>${t`③ Key the cache by a hash of the input`}</span><input type="checkbox" id="rpk_memoHashKeys"></label>
          ${limit('loadHintMs', t`Hint about "# Messages to Load" when opening a chat takes longer than (ms)`, t`Shown once per session as a toast.`)}
          <label title="${t`Runs "Measure on this chat" once after a chat opens. The page freezes for a moment each time.`}"><span>${t`Measure automatically when a chat opens`}</span><input type="checkbox" id="rpk_autoMeasure"></label>
        </div>
      </details>

      <div class="rpk-buttons">
        <div class="menu_button rpk-primary" id="rpk_measure" title="${t`Re-renders this chat twice, with the features off and on, and shows the real difference. The page freezes for a moment.`}">${t`Measure on this chat`}</div>
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
      <details class="rpk-tips rpk-legend" data-section="legend">
        <summary>${t`How to read the table`}</summary>
        <ul>
          <li>${t`Rows are sorted by total time. A highlighted row takes half or more of all regex time: fixing or turning it off helps the most.`}</li>
          <li>${t`<b>Runs</b> are real regex executions; <b>Skips</b> and <b>Hits</b> are runs avoided by ② and ③. A script with 0 runs and many skips never had to run at all.`}</li>
          <li>${t`<b>Replacer</b> is the part of Total ms spent in the replacement; if it is large, the replacement (macros) is slow, not the pattern.`}</li>
          <li>${t`Marks after a name: <code>.*</code> may be slow on long text, <code>(a+)+</code> nested quantifier, <code>⚡</code> one run over ${SPIKE_MS} ms, <code>∅</code> ran ${INEFFECTIVE_RUNS}+ times without ever matching, <code>⇅</code> an earlier script removes what this one looks for (order conflict).`}</li>
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

const TOGGLES = { rpk_profiler: 'profiler', rpk_prefilter: 'prefilter', rpk_memo: 'memo', rpk_streaming: 'streamingSkip', rpk_stream_throttle: 'streamingThrottle', rpk_persist: 'persist', rpk_memoHashKeys: 'memoHashKeys', rpk_autoMeasure: 'autoMeasure' };
// editable limits: setting -> [min, max]
const LIMITS = { memoMaxEntries: [0, 1e6], memoMaxLen: [0, 1e7], memoMaxMB: [0, 4096], persistMaxLen: [0, 1e8], persistMaxMB: [1, 4096], streamingThrottleMs: [50, 60000], loadHintMs: [100, 600000] };

let ui = null; // panel elements, cached by bindUi()
const rendered = new WeakMap();

/** Assigns el[prop] only when the value changed, so periodic refreshes leave an unchanged panel alone. */
function setContent(el, value, prop = 'innerHTML') {
    if (rendered.get(el) === value) return;
    rendered.set(el, value);
    el[prop] = value;
}

/** The Literal cell's tooltip: why there is no literal, and the shortest possible match. */
const litTitle = (r) => [
    !fmtNeedles(r) && needleReason(r),
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
    if (c.noNeedle || c.heavy || c.nested) {
        lines.push(`<span class="rpk-dim">${t`Patterns to look at: no fixed text ${c.noNeedle}, .*-style ${c.heavy}, nested quantifiers ${c.nested}.`}</span>`);
    }
    const breakdown = t`prefilter ${s.skipped}, cache ${s.hits}, streaming ${s.streamSkipped}` + (persistAvailable ? ', ' + t`saved results ${s.bypass}` : '');
    if (!s.calls && !skips && !s.bypass) {
        lines.push(`<span class="rpk-dim">${t`No runs measured yet. Render a message or reopen the chat.`}</span>`);
    } else {
        lines.push(t`Regex ran ${fig('runs', s.calls)} times, ${fig('ms', fmtMs(s.total) + ' ms')} in total.`);
        lines.push(s.calls
            ? t`${fig('skipped', skips + s.bypass)} runs were skipped (${breakdown}), saving about ${fig('saved', fmtMs(s.saved) + ' ms')}.`
            : t`${fig('skipped', skips + s.bypass)} runs were skipped (${breakdown}). The time saved is known once some runs have been measured.`);
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
    if (!patched) lines.push(`<span class="rpk-warn">${t`⚠ Could not patch the regex engine — this SillyTavern version is not supported.`}</span>`);
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
        const cls = (s.total > 0 && r.totalMs / s.total >= 0.5) ? 'rpk-hot' : (r.heavy ? 'rpk-heavy' : '');
        const m = rowMeasures.get(r);
        const actions = (m ? `<span class="rpk-row-ms" title="${esc(t`Without this script the chat renders in ${fmtMs(m.without)} ms instead of ${fmtMs(m.with)} ms (③ and ⑤ off)`)}">−${fmtMs(m.with - m.without)} ms</span>` : '')
            + `<span class="rpk-measure-row fa-solid fa-stopwatch" title="${t`Measure this chat without this script`}"></span>`
            + (r.ids.length ? ` <span class="rpk-edit fa-solid fa-pencil" title="${t`Open in the Regex extension`}"></span> <span class="rpk-off fa-solid fa-power-off" title="${t`Turn this script off`}"></span>` : '');
        return `<tr class="${cls}${r.ids.length ? ' rpk-script' : ''}" title="${esc(r.src)}" data-i="${i}">
          ${td('rank', ranks.get(r))}${td('name', esc(r.name) + warnings(r, true).join(''))}
          ${td('runs', r.calls)}${td('total', fmtMs(r.totalMs))}${td('avg', fmtMs(avgMs(r)))}${td('max', fmtMs(r.maxMs))}
          ${td('repl', fmtMs(r.replMs))}${td('matched', r.matched)}${td('changed', r.changed)}
          ${td('skips', r.skipped)}${td('hits', r.hits)}${td('lit', fmtNeedles(r) ? esc(fmtNeedles(r)) : `<span class="rpk-dim">${t`none`}</span>`, 'rpk-lit', litTitle(r))}
          ${td('act', actions, 'rpk-act')}
        </tr>`;
    }).join('') || `<tr><td colspan="13" class="rpk-dim rpk-empty">${nameFilter && s.rows.length ? t`No script name contains "${nameFilter}".` : t`No runs measured yet. Render a message or reopen the chat.`}</td></tr>`);

    setContent(ui.note, !persistAvailable
        ? t`⑤ and the compromise mode need a newer SillyTavern (staging with MessageFormatter hooks).`
        : settings.persist ? t`⑤ is on: display results are being saved in this chat. Changing a script invalidates them automatically.` : '', 'textContent');
    setContent(ui.usage, s.usage, 'textContent');
    setContent(ui.measure, measured ? `<p>${esc(measureText(measured))}</p><p class="rpk-dim">${esc(slowestText(measured))}</p>` : '');
}

/**
 * The Regex extension has no API to open or toggle a script, so its own list is used: each script row has the
 * script's id, an .edit_existing_regex button and a .regex-toggle-on switch (the one that disables it).
 */
function scriptAction(r, off) {
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
    ui = { summary: find('#rpk_summary'), thead: find('#rpk_table thead'), tbody: find('#rpk_table tbody'), note: find('#rpk_persist_note'), usage: find('#rpk_usage'), measure: find('#rpk_measure_result'), rows: [] };

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
        trimMemo();
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
    /** Runs fn (a measurement that freezes the page) after the toast had a moment to paint; not during a stream. */
    const measuring = async (fn) => {
        if (liveStream()) {
            toastr.warning(t`Wait until the generation finishes.`);
            return;
        }
        toastr.info(t`Measuring...`);
        await new Promise(resolve => setTimeout(resolve, 20));
        fn();
        renderPanel();
    };
    find('#rpk_measure').addEventListener('click', () => measuring(() => {
        measured = measureChat() ?? measured;
        if (measured) toastr.success(measureText(measured));
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
        const r = ui.rows[e.target.closest('tr[data-i]')?.dataset.i];
        if (!r) return;
        if (e.target.closest('.rpk-measure-row')) {
            measuring(() => {
                const m = measureChat(r);
                if (m) rowMeasures.set(r, m);
            });
        } else if (r.ids.length) {
            scriptAction(r, !!e.target.closest('.rpk-off'));
        }
    });

    // auto-refresh while the drawer is open
    const content = find('.inline-drawer-content');
    setInterval(() => { if (content.offsetParent !== null) renderPanel(); }, 2000);
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
                measured = measureChat() ?? measured;
                renderPanel();
                return measured ? measureText(measured) : t`Nothing to measure: the chat is empty.`;
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
eventSource.on(event_types.CHAT_CHANGED, () => {
    markDirty();
    streamViews.clear();
    const now = performance.now();
    const loadMs = now - lastCall < BURST_GAP_MS ? lastCall - burstStart : 0; // the render burst that just ended
    if (!loadHintShown && loadMs > settings.loadHintMs) {
        loadHintShown = true;
        toastr.info(t`Rendering this chat took ${(loadMs / 1000).toFixed(1)} s. A lower "# Messages to Load" (User Settings) opens chats faster.`, 'Regex Perf Kit', { timeOut: 15000 });
    }
    if (settings.autoMeasure && !liveStream()) {
        setTimeout(() => { // once the page has settled
            if (liveStream()) return;
            measured = measureChat() ?? measured;
            renderPanel();
            if (measured) toastr.info(measureText(measured), 'Regex Perf Kit');
        }, 500);
    }
});
eventSource.on(event_types.SETTINGS_UPDATED, markDirty);
if (event_types.PRESET_CHANGED) eventSource.on(event_types.PRESET_CHANGED, markDirty);
eventSource.on(event_types.APP_READY, () => {
    try { installPersistHooks(); } catch (e) { console.warn('[RegexPerf] persist hooks failed', e); }
    try {
        const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (container) {
            container.insertAdjacentHTML('beforeend', settingsHtml());
            bindUi();
            renderPanel();
        }
    } catch (e) { console.warn('[RegexPerf] UI init failed', e); }
    try { registerSlash(); } catch (e) { console.warn('[RegexPerf] slash command failed', e); }
    console.log('[RegexPerf] ready. patched=', patched, 'persistHooks=', persistAvailable);
});
