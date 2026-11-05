/**
 * Regex Perf Kit — speeds up SillyTavern's built-in Regex extension without touching any regex script.
 *
 * The engine compiles every script pattern through RegexProvider.instance.get(). That method is patched to
 * return a RegExp subclass whose [Symbol.replace] (where String.prototype.replace() dispatches) adds
 * ① profiler, ② memo cache, ④ literal prefilter, ⑥ streaming skip of display-only scripts and
 * ⑧ a persisted display cache (needs ST's MessageFormatter hooks, as does ⑥'s compromise mode).
 * No ST core file is modified.
 */

import { RegexProvider, getRegexScripts } from '../../regex/engine.js';
import { regexFromString } from '../../../utils.js';

const MODULE_NAME = 'regex_perf_kit';
const EXTRA_KEY = 'regex_perf_cache';
const ctx = () => SillyTavern.getContext();
const { t, translate } = ctx();

// ---- Settings ----

const defaultSettings = Object.freeze({
    profiler: true,
    prefilter: true,
    memo: true,
    memoMaxEntries: 3000,
    memoMaxLen: 20000,
    memoMaxMB: 64,
    streamingSkip: true,
    streamingThrottle: false, // ⑥ compromise mode: format the streamed message at most every streamingThrottleMs
    streamingThrottleMs: 500,
    persist: false,
    persistMaxLen: 60000,
});

// ST keeps this object for the whole session, so it is resolved once instead of on every replace.
const settings = (ctx().extensionSettings[MODULE_NAME] ||= {});
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

// Set from GENERATION_STARTED until GENERATION_ENDED / GENERATION_STOPPED, so the exact check (which builds the
// whole getContext() object) only runs while a generation can be streaming. Without those events: always check.
const { event_types: EVENTS } = ctx();
let generating = !(EVENTS.GENERATION_STARTED && EVENTS.GENERATION_ENDED && EVENTS.GENERATION_STOPPED);

/** The streaming processor while a stream is live, else null. */
function liveStream() {
    if (!generating) return null;
    const sp = ctx().streamingProcessor;
    return sp && !sp.isFinished && !sp.isStopped ? sp : null;
}

// SillyTavern's macro syntax: {{...}} and the legacy <USER> <BOT> <CHAR> <GROUP> <CHARIFNOTGROUP> markers.
const MACRO = /{{|<(?:user|bot|char(?:ifnotgroup)?|group)>/i;

// Escapes for macro values inside an ESCAPED (substituteRegex 2) pattern, as SillyTavern's sanitizeRegexMacro does.
const REGEX_MACRO_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' };
const sanitizeRegexMacro = (x) => (x && typeof x === 'string'
    ? x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, (c) => REGEX_MACRO_ESCAPES[c] ?? '\\' + c)
    : x);

const CONTROL_ESCAPES = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' };
const BAIL = Symbol('bail');

/**
 * Parses a pattern once. needles: literals of which every match contains at least one (null if none is certain),
 * decided by test(str). nested: an unbounded quantifier inside an unboundedly repeated group, e.g. (a+)+.
 * Conservative: classes, class escapes, backreferences, lookarounds, (?i:) modifier groups and the v flag
 * contribute no literal. Literals in groups that must match join the surrounding run; an alternation yields one
 * needle per branch (any of them must occur), provided every branch has one.
 * @param {string} source RegExp.source
 * @param {string} flags RegExp.flags
 * @returns {{needles: string[] | null, test: ((str: string) => boolean) | null, nested: boolean}}
 */
export function extractNeedle(source, flags) {
    const u = flags.includes('u');
    const n = source.length;
    let i = 0;
    let nested = false;

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

    // {lit} for a literal character, {group, opaque} for a group, {lit: null} for anything else.
    const atom = () => {
        const c = source[i];
        if (c === '\\') {
            const nx = source[i + 1];
            i += 2;
            if (nx === undefined || 'dDwWsSbB0123456789'.includes(nx)) return { lit: null }; // classes, boundaries, backreferences
            if ('pPku'.includes(nx) && (source[i] === '{' || source[i] === '<')) { // \p{..} \u{..} \k<..>: skip the argument
                const e = source.indexOf(source[i] === '<' ? '>' : '}', i + 1);
                if (e !== -1) {
                    if (/[|()[\]\\]/.test(source.slice(i + 1, e))) throw BAIL; // without u these are literals around real syntax
                    i = e + 1;
                }
                return { lit: null };
            }
            const hex = { u: 4, x: 2 }[nx];
            if (hex) {
                if (new RegExp(`^[0-9a-fA-F]{${hex}}`).test(source.slice(i, i + hex))) i += hex;
                return { lit: null };
            }
            if (nx === 'c') {
                if (/[a-zA-Z]/.test(source[i] ?? '')) i++;
                return { lit: null };
            }
            return { lit: CONTROL_ESCAPES[nx] ?? nx }; // \n \t \r \f \v, or an escaped character
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
            return { lit: null };
        }
        if (c === '(') {
            i++;
            let opaque = false;
            if (source[i] === '?') {
                i++;
                if (source[i] === ':') {
                    i++;
                } else if (source[i] === '<' && source[i + 1] !== '=' && source[i + 1] !== '!') { // (?<name>
                    const e = source.indexOf('>', i);
                    i = e === -1 ? n : e + 1;
                } else { // (?= (?! (?<= (?<! lookarounds, (?i: (?-s: modifiers
                    opaque = true;
                    const m = /^(?:<?[=!]|[a-z]*(?:-[a-z]*)?:)/.exec(source.slice(i, i + 16));
                    i += m ? m[0].length : 0;
                }
            }
            const group = alternation();
            if (source[i] !== ')') throw BAIL;
            i++;
            return { group, opaque };
        }
        if ('.^${'.includes(c)) { // a '{' that is not a quantifier is a literal without u: break the run anyway
            i++;
            return { lit: null };
        }
        const pair = u && c >= '\uD800' && c <= '\uDBFF' && source[i + 1] >= '\uDC00' && source[i + 1] <= '\uDFFF';
        i += pair ? 2 : 1;
        return { lit: source.slice(i - (pair ? 2 : 1), i) }; // with u, a surrogate pair is one character
    };

    // Summary of a sequence: pre/suf = literal run at its start/end, full = the whole sequence is one literal run,
    // best = best needle set inside it, inf = it contains an unbounded quantifier.
    const sequence = () => {
        let cur = '';
        let pre = null;
        let best = null;
        let inf = false;
        const consider = (set) => { if (set && better(set, best)) best = set; };
        const end = () => {
            pre ??= cur;
            if (cur) consider([cur]);
            cur = '';
        };
        while (i < n && source[i] !== '|' && source[i] !== ')') {
            const a = atom();
            const q = quant();
            if (q?.inf) inf = true;
            if (a.group) {
                const g = a.group;
                if (g.inf) {
                    inf = true;
                    if (q?.inf) nested = true;
                }
                if (a.opaque || q?.min === 0) {
                    end();
                } else if (!q && g.full) {
                    cur += g.pre;
                } else { // the first repetition continues the run before it, the last one starts the run after it
                    cur += g.pre;
                    end();
                    consider(g.best);
                    cur = g.suf;
                }
            } else if (a.lit === null || q?.min === 0) {
                end();
            } else if (q) { // "ab+c": "ab" and "bc"
                cur += a.lit;
                end();
                cur = a.lit;
            } else {
                cur += a.lit;
            }
        }
        const full = pre === null;
        const suf = cur;
        end();
        return { pre, suf, full, best, inf };
    };

    const alternation = () => {
        const seqs = [sequence()];
        while (source[i] === '|') {
            i++;
            seqs.push(sequence());
        }
        if (seqs.length === 1) return seqs[0];
        const best = seqs.every(s => s.best) ? [...new Set(seqs.flatMap(s => s.best))] : null;
        return { pre: '', suf: '', full: false, best: best?.length <= 16 ? best : null, inf: seqs.some(s => s.inf) };
    };

    let needles = null;
    try {
        if (flags.includes('v')) throw BAIL;
        const top = alternation();
        if (i < n) throw BAIL;
        needles = top.best;
    } catch (e) {
        if (e !== BAIL) throw e;
    }
    if (!needles) return { needles: null, test: null, nested };
    // With the i flag, escaped copies of the needles under the pattern's i/u flags decide: they fold case exactly
    // like the pattern itself (toLowerCase() does not: σ/ς/Σ, µ/μ, ſ/s ...).
    if (flags.includes('i')) {
        const re = new RegExp(needles.map(s => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')).join('|'), u ? 'iu' : 'i');
        return { needles, test: (str) => re.test(str), nested };
    }
    const [one] = needles;
    return { needles, test: needles.length === 1 ? (str) => str.includes(one) : (str) => needles.some(s => str.includes(s)), nested };
}

// .*  .+  [\s\S]*  [^]*  (.|\n)*  [\w\W]* — likely heavy backtracking
const HEAVY_HINT = /\.\*|\.\+|\[\\s\\S\]\*|\[\^\]\*|\(\.\|\\n\)\*|\[\\w\\W\]\*/;

// ---- Script info: compiled pattern key -> script metadata ----

const keyOf = (re) => re.source + '\u0000' + re.flags;

/** @type {{map: Map<string, object>, counts: object, version: string, builtAt: number} | null} */
let infoCache = null; // null = rebuild on next use
const markDirty = () => { infoCache = null; };

function ensureInfo() {
    if (!infoCache || performance.now() - infoCache.builtAt > 5000) infoCache = buildInfo();
    return infoCache;
}

function buildInfo() {
    let scripts = [];
    try { scripts = getRegexScripts({ allowedOnly: true }) ?? []; } catch (e) { console.warn('[RegexPerf] getRegexScripts failed', e); }
    const { substituteParamsExtended } = ctx();
    const map = new Map();
    const counts = { total: scripts.length, active: 0, markdownOnly: 0, promptOnly: 0, noNeedle: 0, heavy: 0, nested: 0 };
    const versionParts = [];
    const depthRules = []; // [min, max] of display scripts with depth limits, for the ⑧ key

    for (const s of scripts) {
        if (!s?.findRegex || s.disabled) continue;
        counts.active++;
        if (s.markdownOnly) counts.markdownOnly++;
        if (s.promptOnly) counts.promptOnly++;

        let rs = s.findRegex;
        const substitute = Number(s.substituteRegex);
        if (substitute === 1 || substitute === 2) { // RAW / ESCAPED, as runRegexScript() compiles them
            try { rs = substituteParamsExtended(rs, {}, substitute === 2 ? sanitizeRegexMacro : undefined); } catch { /* keep the raw pattern */ }
        }
        let re;
        try { re = regexFromString(rs); } catch { /* invalid pattern */ }
        if (!re) continue;

        const replaceString = String(s.replaceString ?? '');
        const trims = Array.isArray(s.trimStrings) ? s.trimStrings : [];
        const trimSig = trims.join('\u0002');
        const needle = extractNeedle(re.source, re.flags);
        const heavy = HEAVY_HINT.test(re.source);
        if (!needle.needles) counts.noNeedle++;
        if (heavy) counts.heavy++;
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
            heavy,
            ids: [s.id], // for the row actions in the table
        };
        const key = keyOf(re);
        const prev = map.get(key);
        if (prev) { // scripts with the same pattern share one wrapper: keep only what holds for all of them
            info.name = prev.name + ', ' + info.name;
            info.ids = [...prev.ids, s.id];
            info.markdownOnly &&= prev.markdownOnly;
            info.pure &&= prev.pure && prev.replaceSig === info.replaceSig;
        }
        map.set(key, info);

        // The same limits getRegexedString() applies; display scripts only, as those are what ⑧ stores.
        const min = !isNaN(s.minDepth) && s.minDepth !== null && s.minDepth >= -1 ? Number(s.minDepth) : -Infinity;
        const max = !isNaN(s.maxDepth) && s.maxDepth !== null && s.maxDepth >= 0 ? Number(s.maxDepth) : Infinity;
        if (s.markdownOnly && (min > -Infinity || max < Infinity)) depthRules.push([min, max]);
        versionParts.push(re.source, re.flags, replaceString, trimSig, String(!!s.markdownOnly), String(!!s.promptOnly), String(s.minDepth), String(s.maxDepth), String(s.placement));
    }
    return { map, counts, depthRules, version: fnv1a(versionParts.join('\u0003')), builtAt: performance.now() };
}

// ---- Instrumented RegExp ----

const stats = new Map(); // pattern key -> counters, see getStat()
let statsSince = Date.now();
const persistStats = { hits: 0, stores: 0 };
let bypass = false; // set by the formatter hooks while a stored result is being shown
let streamApply = false; // set by the formatter hooks for a ⑥ compromise pass that does run the display scripts

// ② Memo: memoPrefix -> Map(input -> entry). Keying by the input string itself (its hash is cached and the same
// string object flows through consecutive scripts) avoids building a new key per call. memoLru orders all
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
    const maxBytes = settings.memoMaxMB * 1048576;
    while (memoLru.size && (memoLru.size > settings.memoMaxEntries || memoBytes > maxBytes)) {
        const old = memoLru.values().next().value;
        memoLru.delete(old);
        old.bucket.delete(old.str);
        memoBytes -= old.size;
    }
}

function getStat(key, re) {
    let st = stats.get(key);
    if (!st) {
        st = {
            name: t`(unknown)`,
            src: '/' + re.source + '/' + re.flags,
            calls: 0, totalMs: 0, maxMs: 0, replMs: 0, changed: 0,
            skipped: 0, hits: 0, streamSkipped: 0, bypass: 0,
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

        if (bypass) {
            stat.bypass++;
            return str;
        }
        if (settings.streamingSkip && markdownOnly && !streamApply && liveStream()) {
            stat.streamSkipped++;
            return str;
        }
        if (settings.prefilter && test && !test(str)) {
            stat.skipped++;
            return str;
        }

        let bucket;
        // Matched text with macros is substituted again after the groups are inserted, so it is not memoized.
        if (settings.memo && memoPrefix && str.length <= settings.memoMaxLen && !MACRO.test(str)) {
            bucket = memo.get(memoPrefix);
            if (!bucket) memo.set(memoPrefix, bucket = new Map());
            const hit = bucket.get(str);
            if (hit) {
                memoLru.delete(hit); // mark as most recently used
                memoLru.add(hit);
                stat.hits++;
                return hit.out;
            }
        }

        const native = this._native;
        native.lastIndex = 0;
        // SillyTavern's replacer (groups, trim strings, macros) is timed apart from the matching itself.
        let replMs = 0;
        const fn = settings.profiler && typeof replacer === 'function'
            ? function (...args) {
                const t1 = performance.now();
                const r = replacer.apply(this, args);
                replMs += performance.now() - t1;
                return r;
            }
            : replacer;
        const t0 = performance.now();
        const out = RegExp.prototype[Symbol.replace].call(native, str, fn);
        if (settings.profiler) {
            const dt = performance.now() - t0;
            stat.calls++;
            stat.totalMs += dt;
            stat.replMs += replMs;
            if (dt > stat.maxMs) stat.maxMs = dt;
            if (out !== str) stat.changed++;
        }
        this.lastIndex = native.lastIndex; // leave this regex as a native replace would

        const size = (str.length + out.length) * 2;
        if (bucket && size <= settings.memoMaxMB * 1048576) { // an entry larger than the budget would flush the memo
            const entry = { bucket, str, out, size };
            bucket.set(str, entry);
            memoLru.add(entry);
            memoBytes += size;
            trimMemo();
        }
        return out;
    }
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
            const info = map.get(key) ?? null;
            const stat = getStat(key, base);
            if (info) stat.name = info.name;
            stat.ids = info?.ids ?? [];
            stat.needle = info ? info.needle : extractNeedle(base.source, base.flags);
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

// ---- MessageFormatter hooks: ⑧ persisted display cache, ⑥ compromise mode ----

let persistAvailable = false; // the hooks exist (recent SillyTavern)
let pending = null; // {msg, key, input}: message awaiting its after-regex result
const streamViews = new Map(); // ⑥ compromise: "<messageId><m|r>" -> {at, prefix, out} of the streamed message
let streamView = null; // the view this pass formats
let streamTail = null; // raw text this pass appends after the regex stage

/**
 * ⑥ compromise mode, for the message being streamed: the display scripts format the completed lines at most every
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

    // Before regex: ⑥ compromise mode for the streamed message; otherwise, on a ⑧ key match, substitute the
    // stored result and bypass every script for this message.
    mf.addHook((mes, c) => {
        bypass = false;
        pending = null;
        streamView = streamTail = null;
        streamApply = false;
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
        const key = fnv1a(mes) + ':' + mes.length + ':' + version + ':' + names + depths;
        const e = msg.extra?.[EXTRA_KEY];
        if (e && e.k === key) {
            bypass = true;
            persistStats.hits++;
            return e.same ? mes : String(e.v ?? mes);
        }
        pending = { msg, key, input: mes };
        return mes;
    }, { stage: mf.stage.BEFORE_REGEX, order: mf.order?.LATEST ?? 100 });

    // After regex: append ⑥'s raw tail, or store the freshly computed result for ⑧.
    mf.addHook((mes) => {
        if (streamTail !== null) {
            if (streamView) streamView.out = mes;
            const tail = streamTail;
            streamView = streamTail = null;
            streamApply = false;
            return mes + tail;
        }
        if (bypass) {
            bypass = false;
            return mes;
        }
        const p = pending;
        pending = null;
        if (!p || mes.length > settings.persistMaxLen) return mes;
        p.msg.extra ||= {};
        p.msg.extra[EXTRA_KEY] = mes === p.input ? { k: p.key, same: 1 } : { k: p.key, v: mes };
        persistStats.stores++;
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

const SPIKE_MS = 50; // a single run slower than this is flagged
const INEFFECTIVE_RUNS = 20; // a script that ran this often without changing the text is a candidate to disable

const fmtMs = (x) => x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2);
const avgMs = (r) => (r.calls ? r.totalMs / r.calls : 0);
const fmtNeedles = (r) => r.needle?.needles?.map(s => JSON.stringify(s)).join(' | ') ?? null;
// ⑩ every call the prefilter, the memo or the streaming skip avoided would have cost the script's average run
const savedMs = (r) => (r.skipped + r.hits + r.streamSkipped) * avgMs(r);
const ineffective = (r) => r.calls >= INEFFECTIVE_RUNS && !r.changed;
const warnings = (r) => [
    r.heavy && t`.*-style`,
    r.needle?.nested && t`nested quantifier`,
    r.maxMs > SPIKE_MS && t`spike`,
    ineffective(r) && t`no effect`,
].filter(Boolean);

function buildSummary() {
    const { counts } = ensureInfo();
    const rows = [...stats.values()].sort((a, b) => b.totalMs - a.totalMs);
    const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);
    const total = sum('totalMs');
    const top = rows[0];
    let persistEntries = 0;
    let persistChars = 0;
    const { chat } = ctx();
    for (const m of chat ?? []) {
        const e = m?.extra?.[EXTRA_KEY];
        if (!e) continue;
        persistEntries++;
        persistChars += String(e.k).length + (e.v?.length ?? 0);
    }
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
        usage: t`Memo: ${memoLru.size} entries, ${(memoBytes / 1048576).toFixed(1)} of ${settings.memoMaxMB} MB`
            + (persistAvailable ? ' · ' + t`⑧ in this chat: ${persistEntries} messages, ≈${Math.round(persistChars / 1024)} KB` : ''),
    };
}

let measured = null; // last "Measure on this chat" result

const measureText = (m) => t`This chat (${m.messages} messages): ${fmtMs(m.off)} ms with the features off, ${fmtMs(m.on)} ms on — ${fmtMs(m.off - m.on)} ms saved (${m.off > 0 ? Math.round((m.off - m.on) / m.off * 100) : 0}%)`;

function buildReportText() {
    const s = buildSummary();
    const c = s.counts;
    const lines = [
        `Regex Perf Kit report (${new Date().toLocaleString()})`,
        t`Since: ${new Date(statsSince).toLocaleTimeString()} / chat messages: ${s.chatLen}`,
        t`Scripts: ${c.total} total, ${c.active} active (display ${c.markdownOnly}, prompt ${c.promptOnly}), no literal ${c.noNeedle}, possibly heavy ${c.heavy}, nested quantifiers ${c.nested}`,
        t`Ran ${s.calls} times / ${fmtMs(s.total)} ms total | prefilter skips ${s.skipped} | cache hits ${s.hits} | streaming skips ${s.streamSkipped} | persistent cache bypasses ${s.bypass} (hits ${persistStats.hits}, stored ${persistStats.stores})`,
        t`Estimated time saved: ≈${fmtMs(s.saved)} ms ((prefilter skips + cache hits + streaming skips) × average run time)`,
        s.usage,
    ];
    if (measured) lines.push(measureText(measured));
    if (s.top) lines.push(t`#1 "${s.top.name}" takes ${s.topShare.toFixed(0)}% of the total time`);
    if (s.ineffective.length) lines.push(t`Candidates to disable (ran ${INEFFECTIVE_RUNS}+ times, never changed the text): ${s.ineffective.join(', ')}`);
    lines.push('', t`Rank | Script | Runs | Total ms | Avg ms | Max ms | Replacer ms | Changed | Skips | Hits | Stream skips | Literal | Warnings`);
    s.rows.forEach((r, i) => {
        lines.push(`${i + 1} | ${r.name} | ${r.calls} | ${fmtMs(r.totalMs)} | ${fmtMs(avgMs(r))} | ${fmtMs(r.maxMs)} | ${fmtMs(r.replMs)} | ${r.changed} | ${r.skipped} | ${r.hits} | ${r.streamSkipped} | ${fmtNeedles(r) ?? '-'} | ${warnings(r).join(', ')}`);
    });
    return lines.join('\n');
}

const COUNTERS = ['calls', 'totalMs', 'maxMs', 'replMs', 'changed', 'skipped', 'hits', 'streamSkipped', 'bypass'];

/**
 * ⑨ Renders every message of the current chat as SillyTavern displays it (messageFormatting), first with the
 * prefilter, the memo and ⑧ off, then with the user's settings, and returns both times. The chat was rendered when
 * it opened, so this is a re-render, as on swipes, edits and reloads. Synchronous, so the temporarily changed
 * settings can never be saved, and the stats are restored afterwards.
 */
function measureChat() {
    const { chat, messageFormatting } = ctx();
    if (!chat?.length || typeof messageFormatting !== 'function') return null;
    const render = () => {
        const t0 = performance.now();
        chat.forEach((m, i) => {
            if (m?.mes) messageFormatting(m.mes, m.name, m.is_system, m.is_user, i);
            if (m?.extra?.reasoning) messageFormatting(m.extra.reasoning, '', false, false, i, {}, true);
        });
        return performance.now() - t0;
    };
    const user = { profiler: settings.profiler, prefilter: settings.prefilter, memo: settings.memo, persist: settings.persist };
    const saved = new Map([...stats].map(([k, st]) => [k, COUNTERS.map(c => st[c])]));
    const savedPersist = { ...persistStats };
    const times = {};
    try {
        Object.assign(settings, { profiler: false, prefilter: false, memo: false, persist: false });
        times.off = render();
        Object.assign(settings, user, { profiler: false });
        times.on = render();
    } finally {
        Object.assign(settings, user);
        for (const [k, st] of stats) COUNTERS.forEach((c, i) => { st[c] = saved.get(k)?.[i] ?? 0; });
        Object.assign(persistStats, savedPersist);
    }
    return { messages: chat.length, ...times };
}

function resetStats() {
    stats.clear();
    statsSince = Date.now();
    persistStats.hits = 0;
    persistStats.stores = 0;
    wrapped.clear(); // wrappers hold their stat object; new ones link to fresh stats
}

// ---- UI ----

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ESCAPES[c]);

// UI text is English; Korean locales get the Korean wording below. addLocaleData() never overrides SillyTavern's own
// translations, so a key SillyTavern already translates differently gets its own id (translate(text, id)).
const KO = {
    'Measuring...': '측정 중...',
    'Measures each script\'s execution time. Almost free.': '스크립트별 실행 시간을 측정합니다. 비용이 거의 없습니다.',
    '① Profiler': '① 프로파일러',
    'Skips a regex when the message lacks a fixed string that every match must contain. Results are identical.': '패턴에 반드시 포함돼야 하는 고정 문자열이 메시지에 없으면 정규식을 실행하지 않습니다. 결과는 동일합니다.',
    '④ Literal prefilter': '④ 리터럴 프리필터',
    'Reuses the previous result when the same script runs on the same message again. Scripts with {{macros}} in the replacement, and text containing macros, are excluded automatically.': '같은 메시지에 같은 스크립트를 다시 돌릴 때 이전 결과를 재사용합니다. 치환문에 {{매크로}}가 있는 스크립트와 매크로가 든 텍스트는 자동 제외.',
    '② Result cache (memory)': '② 결과 캐시 (메모리)',
    'While streaming, display-only (markdownOnly) scripts are skipped and applied once the generation finishes.': '스트리밍 중에는 표시 전용(markdownOnly) 스크립트를 건너뛰고, 생성이 끝나면 한 번 적용합니다.',
    '⑥ Skip display scripts while streaming': '⑥ 스트리밍 중 표시용 스킵',
    'Stores the display result in the message (extra) so reopening the chat skips recomputing it. Chat files may grow.': '표시 결과를 메시지(extra)에 저장해 채팅을 다시 열 때 재계산을 생략합니다. 채팅 파일이 커질 수 있습니다.',
    '⑧ Persistent display cache (optional)': '⑧ 표시 결과 영구 캐시 (선택)',
    'rpk_refresh': '새로고침',
    'Reset stats': '측정 초기화',
    'Copy report': '리포트 복사',
    'Clear persistent cache (this chat)': '영구 캐시 삭제(현재 채팅)',
    'Script': '스크립트',
    'Runs': '실행',
    'Total ms': '총 ms',
    'Avg': '평균',
    'Max': '최대',
    'Skips': '스킵',
    'Hits': '히트',
    'Literal': '리터럴',
    '⑥·⑦ What SillyTavern\'s own settings can do': '⑥·⑦ 설정만으로 할 수 있는 것 (ST 기본 설정)',
    '<b>User Settings → "# Messages to Load"</b>: how many messages are rendered (= regex applied) when a chat opens. 0 = all. 50–100 makes loading much faster.': '<b>User Settings → "# Messages to Load"</b>: 채팅을 열 때 렌더링(=정규식 적용)하는 메시지 수. 0=전부. 50~100 정도로 줄이면 로딩이 크게 빨라집니다.',
    '<b>User Settings → "Streaming FPS"</b>: screen updates per second while streaming. Every update runs all display regexes, so 10–15 reduces lag.': '<b>User Settings → "Streaming FPS"</b>: 스트리밍 중 화면 갱신 횟수. 갱신마다 표시용 정규식이 전부 돌아가므로 10~15로 낮추면 렉이 줄어듭니다.',
    'Turn on <b>"Only Format Display"</b> for display scripts and <b>"Only Format Prompt"</b> for prompt scripts. Scripts with neither run when a message is saved and are not skipped while streaming.': '표시용 스크립트는 <b>"Only Format Display"</b>, 프롬프트용은 <b>"Only Format Prompt"</b>를 켜두세요. 둘 다 꺼진 스크립트는 저장 시점에 돌아가며, 이 확장의 스트리밍 스킵 대상도 아닙니다.',
    'Scripts <b>${0}</b>/${1} active (display ${2}, prompt ${3})': '스크립트 <b>${0}</b>/${1} 활성 (표시용 ${2}, 프롬프트용 ${3})',
    'no literal <b>${0}</b>': '리터럴 없음 <b>${0}</b>',
    '<code>.*</code>-style <b>${0}</b>': '<code>.*</code> 계열 <b>${0}</b>',
    'chat ${0} messages': '채팅 ${0}개',
    'Ran <b>${0}</b> times / <b>${1}</b> ms': '실행 <b>${0}</b>회 / <b>${1}</b> ms',
    'prefilter skips <b>${0}</b>': '프리필터 스킵 <b>${0}</b>',
    'cache hits <b>${0}</b>': '캐시 히트 <b>${0}</b>',
    'streaming skips <b>${0}</b>': '스트리밍 스킵 <b>${0}</b>',
    'persistent cache hits <b>${0}</b>': '영구캐시 히트 <b>${0}</b>',
    'Slowest script: <b>${0}</b> — ${1}% of the total': '가장 느린 스크립트: <b>${0}</b> — 전체의 ${1}%',
    '⚠ Could not patch the regex engine — this SillyTavern version is not supported.': '⚠ 정규식 엔진 패치 실패 — 이 ST 버전은 지원되지 않습니다.',
    'Pattern that may backtrack a lot': '백트래킹이 많을 수 있는 패턴',
    'none': '없음',
    'No runs measured yet. Render a message or reopen the chat.': '아직 측정된 실행이 없습니다. 메시지를 렌더링하거나 채팅을 다시 열어보세요.',
    '⑧ on: display results are stored in the message extra. Changing a script changes the key, so results are recomputed automatically.': '⑧ 켜짐: 표시 결과가 메시지 extra에 저장됩니다. 스크립트를 바꾸면 키가 달라져 자동으로 재계산됩니다.',
    'Stats reset.': '측정값을 초기화했습니다.',
    'Report copied to the clipboard.': '리포트를 클립보드에 복사했습니다.',
    'Could not copy — use the /regexperf command to see the report in a popup.': '클립보드 복사 실패 — /regexperf 명령으로 팝업에서 확인하세요.',
    'Removed ${0} persistent cache entries.': '영구 캐시 ${0}개를 삭제했습니다.',
    'Stats reset': '측정값 초기화 완료',
    '<div>Shows the Regex Perf Kit report in a popup. <code>/regexperf reset</code> resets the stats, <code>/regexperf text</code> returns it as text.</div>': '<div>Regex Perf Kit 리포트를 팝업으로 표시합니다. <code>/regexperf reset</code> 으로 측정 초기화, <code>/regexperf text</code> 로 텍스트 반환.</div>',
    '(no name)': '(이름 없음)',
    '(unknown)': '(알 수 없음)',
    'Since: ${0} / chat messages: ${1}': '측정 시작: ${0} / 채팅 메시지 ${1}개',
    'Ran ${0} times / ${1} ms total | prefilter skips ${2} | cache hits ${3} | streaming skips ${4} | persistent cache bypasses ${5} (hits ${6}, stored ${7})': '실행 ${0}회 / 총 ${1}ms | 프리필터 스킵 ${2} | 캐시 히트 ${3} | 스트리밍 스킵 ${4} | 영구캐시 바이패스 ${5} (히트 ${6}, 저장 ${7})',
    '#1 "${0}" takes ${1}% of the total time': '1위 "${0}" 가 전체 시간의 ${1}% 차지',
    '.*-style': '.* 계열',
    'Scripts: ${0} total, ${1} active (display ${2}, prompt ${3}), no literal ${4}, possibly heavy ${5}, nested quantifiers ${6}': '스크립트: 전체 ${0}, 활성 ${1} (표시용 ${2}, 프롬프트용 ${3}), 리터럴 없음 ${4}, 무거운 패턴 의심 ${5}, 중첩 수량자 ${6}',
    'Rank | Script | Runs | Total ms | Avg ms | Max ms | Replacer ms | Changed | Skips | Hits | Stream skips | Literal | Warnings': '순위 | 스크립트 | 실행 | 총ms | 평균ms | 최대ms | 치환ms | 변경 | 스킵 | 히트 | 스트리밍 스킵 | 리터럴 | 경고',
    '⑧ and ⑥\'s compromise mode are unavailable: this SillyTavern version has no MessageFormatter hooks (needs a recent staging build).': '⑧ 영구 캐시와 ⑥ 절충 모드는 이 ST 버전에 MessageFormatter 훅이 없어 사용할 수 없습니다 (staging 최신 버전 필요).',
    'nested quantifier': '중첩 수량자',
    'spike': '스파이크',
    'no effect': '효과 없음',
    'Memo: ${0} entries, ${1} of ${2} MB': '결과 캐시: ${0}개, ${1} / ${2} MB',
    '⑧ in this chat: ${0} messages, ≈${1} KB': '⑧ 현재 채팅: 메시지 ${0}개, ≈${1} KB',
    'This chat (${0} messages): ${1} ms with the features off, ${2} ms on — ${3} ms saved (${4}%)': '이 채팅 (메시지 ${0}개): 기능 끔 ${1} ms, 켬 ${2} ms — ${3} ms 절약 (${4}%)',
    'Estimated time saved: ≈${0} ms ((prefilter skips + cache hits + streaming skips) × average run time)': '절약 추정: ≈${0} ms ((프리필터 스킵 + 캐시 히트 + 스트리밍 스킵) × 평균 실행 시간)',
    'Candidates to disable (ran ${0}+ times, never changed the text): ${1}': '끄기 후보 (${0}회 이상 실행, 텍스트 변경 없음): ${1}',
    'With ⑥ on: instead of skipping them, display scripts format the completed lines of the streamed message at most every N ms (set under Limits); the line being written stays raw. The final render applies every script.': '⑥이 켜져 있을 때: 건너뛰는 대신, 스트리밍 중인 메시지의 완성된 줄에 표시용 스크립트를 최대 N ms마다 한 번 적용합니다(한도에서 설정). 작성 중인 줄은 그대로 보이고, 마지막 렌더링에는 모든 스크립트가 적용됩니다.',
    '⑥ Compromise: format while streaming': '⑥ 절충: 스트리밍 중에도 표시',
    'Limits': '한도',
    'Oldest results are evicted beyond this many.': '이 개수를 넘으면 가장 오래된 결과부터 지웁니다.',
    '② Memo entries': '② 결과 캐시 개수',
    'Longer inputs are not memoized.': '이보다 긴 입력은 캐시하지 않습니다.',
    '② Memo max input (characters)': '② 캐시할 최대 입력 길이 (글자)',
    'Oldest results are evicted beyond this estimated size (2 bytes per character of input and output).': '추정 크기(입력+출력 글자당 2바이트)가 이를 넘으면 가장 오래된 결과부터 지웁니다.',
    '② Memo memory (MB)': '② 결과 캐시 메모리 (MB)',
    'Longer display results are not stored in the chat.': '이보다 긴 표시 결과는 채팅에 저장하지 않습니다.',
    '⑧ Max stored result (characters)': '⑧ 저장할 최대 결과 길이 (글자)',
    '⑥ Compromise interval (ms)': '⑥ 절충 모드 간격 (ms)',
    'Re-renders this chat with the features off, then on, and shows the difference. The page is busy meanwhile.': '이 채팅을 기능을 끈 상태와 켠 상태로 다시 렌더링해 차이를 보여줍니다. 그동안 화면이 멈춥니다.',
    'Measure on this chat': '이 채팅으로 측정',
    'Time spent in SillyTavern\'s replacer (group filling, trim strings, macros), included in Total ms': 'SillyTavern 치환 함수(그룹 채우기, 트림 문자열, 매크로)에 쓴 시간. 총 ms에 포함됩니다.',
    'Replacer': '치환',
    'Runs that changed the text': '텍스트를 바꾼 실행 횟수',
    'Changed': '변경',
    'nested quantifiers <b>${0}</b>': '중첩 수량자 <b>${0}</b>',
    '≈<b>${0}</b> ms saved (estimate)': '절약 추정 ≈<b>${0}</b> ms',
    'Ran ${0}+ times without changing the text (candidates to disable): <b>${1}</b>': '${0}회 이상 실행했지만 텍스트를 바꾸지 않음 (끄기 후보): <b>${1}</b>',
    'Nested quantifier: can backtrack catastrophically on long text': '중첩 수량자: 긴 텍스트에서 백트래킹이 폭증할 수 있습니다',
    'A single run took ${0} ms (over ${1} ms)': '한 번 실행에 ${0} ms 걸림 (${1} ms 초과)',
    'Ran ${0} times without changing the text: a candidate to disable': '${0}회 실행했지만 텍스트를 바꾸지 않음: 끄기 후보',
    'Open in the Regex extension': '정규식 확장에서 열기',
    'Turn this script off': '이 스크립트 끄기',
    '"${0}" is not in the Regex extension\'s list.': '"${0}" 스크립트를 정규식 확장 목록에서 찾을 수 없습니다.',
    'Turned off: ${0}': '껐습니다: ${0}',
    'Wait until the generation finishes.': '생성이 끝난 뒤에 측정하세요.',
};
{
    const { getCurrentLocale, addLocaleData } = ctx();
    const locale = getCurrentLocale();
    if (locale.startsWith('ko')) addLocaleData(locale, KO);
}

const settingsHtml = () => `
<div id="regex_perf_kit" class="regex-perf-kit">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Regex Perf Kit</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="rpk-summary" id="rpk_summary">${t`Measuring...`}</div>

      <div class="rpk-grid">
        <label class="checkbox_label" title="${t`Measures each script's execution time. Almost free.`}">
          <input type="checkbox" id="rpk_profiler"><span>${t`① Profiler`}</span>
        </label>
        <label class="checkbox_label" title="${t`Skips a regex when the message lacks a fixed string that every match must contain. Results are identical.`}">
          <input type="checkbox" id="rpk_prefilter"><span>${t`④ Literal prefilter`}</span>
        </label>
        <label class="checkbox_label" title="${t`Reuses the previous result when the same script runs on the same message again. Scripts with {{macros}} in the replacement, and text containing macros, are excluded automatically.`}">
          <input type="checkbox" id="rpk_memo"><span>${t`② Result cache (memory)`}</span>
        </label>
        <label class="checkbox_label" title="${t`While streaming, display-only (markdownOnly) scripts are skipped and applied once the generation finishes.`}">
          <input type="checkbox" id="rpk_streaming"><span>${t`⑥ Skip display scripts while streaming`}</span>
        </label>
        <label class="checkbox_label" title="${t`With ⑥ on: instead of skipping them, display scripts format the completed lines of the streamed message at most every N ms (set under Limits); the line being written stays raw. The final render applies every script.`}">
          <input type="checkbox" id="rpk_stream_throttle"><span>${t`⑥ Compromise: format while streaming`}</span>
        </label>
        <label class="checkbox_label" id="rpk_persist_label" title="${t`Stores the display result in the message (extra) so reopening the chat skips recomputing it. Chat files may grow.`}">
          <input type="checkbox" id="rpk_persist"><span>${t`⑧ Persistent display cache (optional)`}</span>
        </label>
      </div>
      <div class="rpk-note" id="rpk_persist_note"></div>
      <div class="rpk-note" id="rpk_usage"></div>

      <details class="rpk-limits">
        <summary>${t`Limits`}</summary>
        <div class="rpk-grid">
          <label title="${t`Oldest results are evicted beyond this many.`}">${t`② Memo entries`} <input type="number" class="text_pole" id="rpk_memoMaxEntries"></label>
          <label title="${t`Longer inputs are not memoized.`}">${t`② Memo max input (characters)`} <input type="number" class="text_pole" id="rpk_memoMaxLen"></label>
          <label title="${t`Oldest results are evicted beyond this estimated size (2 bytes per character of input and output).`}">${t`② Memo memory (MB)`} <input type="number" class="text_pole" id="rpk_memoMaxMB"></label>
          <label title="${t`Longer display results are not stored in the chat.`}">${t`⑧ Max stored result (characters)`} <input type="number" class="text_pole" id="rpk_persistMaxLen"></label>
          <label>${t`⑥ Compromise interval (ms)`} <input type="number" class="text_pole" id="rpk_streamingThrottleMs"></label>
        </div>
      </details>

      <div class="rpk-buttons">
        <div class="menu_button" id="rpk_refresh">${translate('Refresh', 'rpk_refresh')}</div>
        <div class="menu_button" id="rpk_reset">${t`Reset stats`}</div>
        <div class="menu_button" id="rpk_copy">${t`Copy report`}</div>
        <div class="menu_button" id="rpk_clear_persist">${t`Clear persistent cache (this chat)`}</div>
        <div class="menu_button" id="rpk_measure" title="${t`Re-renders this chat with the features off, then on, and shows the difference. The page is busy meanwhile.`}">${t`Measure on this chat`}</div>
      </div>
      <div class="rpk-note" id="rpk_measure_result"></div>

      <div class="rpk-table-wrap">
        <table class="rpk-table" id="rpk_table">
          <thead><tr><th>#</th><th>${t`Script`}</th><th>${t`Runs`}</th><th>${t`Total ms`}</th><th>${t`Avg`}</th><th>${t`Max`}</th><th title="${t`Time spent in SillyTavern's replacer (group filling, trim strings, macros), included in Total ms`}">${t`Replacer`}</th><th title="${t`Runs that changed the text`}">${t`Changed`}</th><th>${t`Skips`}</th><th>${t`Hits`}</th><th>${t`Literal`}</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <details class="rpk-tips">
        <summary>${t`⑥·⑦ What SillyTavern's own settings can do`}</summary>
        <ul>
          <li>${t`<b>User Settings → "# Messages to Load"</b>: how many messages are rendered (= regex applied) when a chat opens. 0 = all. 50–100 makes loading much faster.`}</li>
          <li>${t`<b>User Settings → "Streaming FPS"</b>: screen updates per second while streaming. Every update runs all display regexes, so 10–15 reduces lag.`}</li>
          <li>${t`Turn on <b>"Only Format Display"</b> for display scripts and <b>"Only Format Prompt"</b> for prompt scripts. Scripts with neither run when a message is saved and are not skipped while streaming.`}</li>
        </ul>
      </details>
    </div>
  </div>
</div>`;

const TOGGLES = { rpk_profiler: 'profiler', rpk_prefilter: 'prefilter', rpk_memo: 'memo', rpk_streaming: 'streamingSkip', rpk_stream_throttle: 'streamingThrottle', rpk_persist: 'persist' };
// ⑮ editable limits: setting -> [min, max]
const LIMITS = { memoMaxEntries: [0, 1e6], memoMaxLen: [0, 1e7], memoMaxMB: [0, 4096], persistMaxLen: [0, 1e8], streamingThrottleMs: [50, 60000] };

let ui = null; // panel elements, cached by bindUi()
const rendered = new WeakMap();

/** Assigns el[prop] only when the value changed, so periodic refreshes leave an unchanged panel alone. */
function setContent(el, value, prop = 'innerHTML') {
    if (rendered.get(el) === value) return;
    rendered.set(el, value);
    el[prop] = value;
}

const badge = (text, title) => ` <span class="rpk-badge" title="${esc(title)}">${text}</span>`;

function renderPanel() {
    if (!ui) return;
    const s = buildSummary();
    const c = s.counts;
    let summary = '<div>' + [
        t`Scripts <b>${c.active}</b>/${c.total} active (display ${c.markdownOnly}, prompt ${c.promptOnly})`,
        t`no literal <b>${c.noNeedle}</b>`,
        t`<code>.*</code>-style <b>${c.heavy}</b>`,
        t`nested quantifiers <b>${c.nested}</b>`,
        t`chat ${s.chatLen} messages`,
    ].join(' · ') + '</div><div>' + [
        t`Ran <b>${s.calls}</b> times / <b>${fmtMs(s.total)}</b> ms`,
        t`prefilter skips <b>${s.skipped}</b>`,
        t`cache hits <b>${s.hits}</b>`,
        t`streaming skips <b>${s.streamSkipped}</b>`,
        ...(persistAvailable ? [t`persistent cache hits <b>${persistStats.hits}</b>`] : []),
        t`≈<b>${fmtMs(s.saved)}</b> ms saved (estimate)`,
    ].join(' · ') + '</div>';
    if (s.top && s.calls > 0) {
        summary += `<div class="${s.topShare >= 50 ? 'rpk-warn' : ''}">${t`Slowest script: <b>${esc(s.top.name)}</b> — ${s.topShare.toFixed(0)}% of the total`}</div>`;
    }
    if (s.ineffective.length) {
        summary += `<div class="rpk-warn">${t`Ran ${INEFFECTIVE_RUNS}+ times without changing the text (candidates to disable): <b>${esc(s.ineffective.join(', '))}</b>`}</div>`;
    }
    if (!patched) summary += `<div class="rpk-warn">${t`⚠ Could not patch the regex engine — this SillyTavern version is not supported.`}</div>`;
    setContent(ui.summary, summary);

    ui.rows = s.rows.slice(0, 60);
    setContent(ui.tbody, ui.rows.map((r, i) => {
        const cls = (s.total > 0 && r.totalMs / s.total >= 0.5) ? 'rpk-hot' : (r.heavy ? 'rpk-heavy' : '');
        const badges = (r.heavy ? badge('.*', t`Pattern that may backtrack a lot`) : '')
            + (r.needle?.nested ? badge('(a+)+', t`Nested quantifier: can backtrack catastrophically on long text`) : '')
            + (r.maxMs > SPIKE_MS ? badge('⚡', t`A single run took ${fmtMs(r.maxMs)} ms (over ${SPIKE_MS} ms)`) : '')
            + (ineffective(r) ? badge('∅', t`Ran ${r.calls} times without changing the text: a candidate to disable`) : '');
        const actions = r.ids.length
            ? `<span class="rpk-edit fa-solid fa-pencil" title="${t`Open in the Regex extension`}"></span> <span class="rpk-off fa-solid fa-power-off" title="${t`Turn this script off`}"></span>`
            : '';
        return `<tr class="${cls}${r.ids.length ? ' rpk-script' : ''}" title="${esc(r.src)}" data-i="${i}">
          <td>${i + 1}</td><td>${esc(r.name)}${badges}</td>
          <td>${r.calls}</td><td>${fmtMs(r.totalMs)}</td><td>${fmtMs(avgMs(r))}</td><td>${fmtMs(r.maxMs)}</td>
          <td>${fmtMs(r.replMs)}</td><td>${r.changed}</td>
          <td>${r.skipped}</td><td>${r.hits}</td><td class="rpk-lit">${r.needle?.needles ? esc(fmtNeedles(r)) : `<span class="rpk-dim">${t`none`}</span>`}</td>
          <td class="rpk-act">${actions}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="12" class="rpk-dim">${t`No runs measured yet. Render a message or reopen the chat.`}</td></tr>`);

    setContent(ui.note, !persistAvailable
        ? t`⑧ and ⑥'s compromise mode are unavailable: this SillyTavern version has no MessageFormatter hooks (needs a recent staging build).`
        : settings.persist ? t`⑧ on: display results are stored in the message extra. Changing a script changes the key, so results are recomputed automatically.` : '', 'textContent');
    setContent(ui.usage, s.usage, 'textContent');
    setContent(ui.measure, measured ? measureText(measured) : '', 'textContent');
}

/**
 * ⑭ The Regex extension has no API to open or toggle a script, so its own list is used: each script row has the
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
    ui = { summary: find('#rpk_summary'), tbody: find('#rpk_table tbody'), note: find('#rpk_persist_note'), usage: find('#rpk_usage'), measure: find('#rpk_measure_result'), rows: [] };

    for (const [id, key] of Object.entries(TOGGLES)) {
        const el = find('#' + id);
        el.checked = !!settings[key];
        el.addEventListener('change', () => {
            settings[key] = el.checked;
            ctx().saveSettingsDebounced();
            if (key === 'memo' && !el.checked) clearMemo();
            renderPanel();
        });
    }
    if (!persistAvailable) find('#rpk_persist').disabled = find('#rpk_stream_throttle').disabled = true;

    for (const [key, [min, max]] of Object.entries(LIMITS)) {
        const el = find('#rpk_' + key);
        Object.assign(el, { min, max, value: settings[key] });
        el.addEventListener('change', () => {
            const v = Number(el.value);
            if (el.value.trim() !== '' && Number.isFinite(v)) settings[key] = Math.min(max, Math.max(min, Math.round(v)));
            el.value = settings[key];
            ctx().saveSettingsDebounced();
            trimMemo();
            renderPanel();
        });
    }

    find('#rpk_refresh').addEventListener('click', () => { markDirty(); renderPanel(); });
    find('#rpk_reset').addEventListener('click', () => { resetStats(); renderPanel(); toastr.info(t`Stats reset.`); });
    find('#rpk_copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(buildReportText());
            toastr.success(t`Report copied to the clipboard.`);
        } catch {
            toastr.warning(t`Could not copy — use the /regexperf command to see the report in a popup.`);
        }
    });
    find('#rpk_clear_persist').addEventListener('click', async () => {
        const n = await clearPersistedCache();
        toastr.info(t`Removed ${n} persistent cache entries.`);
        renderPanel();
    });
    find('#rpk_measure').addEventListener('click', async () => {
        if (liveStream()) {
            toastr.warning(t`Wait until the generation finishes.`);
            return;
        }
        toastr.info(t`Measuring...`);
        await new Promise(resolve => setTimeout(resolve, 20)); // let the toast paint before the page is busy
        measured = measureChat() ?? measured;
        renderPanel();
        if (measured) toastr.success(measureText(measured));
    });
    ui.tbody.addEventListener('click', (e) => {
        const r = ui.rows[e.target.closest('tr[data-i]')?.dataset.i];
        if (r?.ids.length) scriptAction(r, !!e.target.closest('.rpk-off'));
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
            const arg = String(unnamed ?? '').trim().toLowerCase();
            if (arg === 'reset') {
                resetStats();
                renderPanel();
                return t`Stats reset`;
            }
            const text = buildReportText();
            if (arg !== 'text' && typeof callGenericPopup === 'function') {
                await callGenericPopup(`<pre class="rpk-report">${esc(text)}</pre>`, POPUP_TYPE?.TEXT ?? 1, '', { wide: true, large: true, allowVerticalScrolling: true });
            }
            return text;
        },
        unnamedArgumentList: SlashCommandArgument ? [
            SlashCommandArgument.fromProps({
                description: 'reset | text',
                typeList: [ARGUMENT_TYPE?.STRING ?? 'string'],
                isRequired: false,
            }),
        ] : [],
        helpString: t`<div>Shows the Regex Perf Kit report in a popup. <code>/regexperf reset</code> resets the stats, <code>/regexperf text</code> returns it as text.</div>`,
    }));
}

// ---- Init ----

const { eventSource, event_types, extensionSettings } = ctx();
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
eventSource.on(event_types.CHAT_CHANGED, () => {
    markDirty();
    streamViews.clear();
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
