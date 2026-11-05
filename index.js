/**
 * Regex Perf Kit — speeds up SillyTavern's built-in Regex extension without touching any regex script.
 *
 * The engine compiles every script pattern through RegexProvider.instance.get(). That method is patched to
 * return a RegExp subclass whose [Symbol.replace] (where String.prototype.replace() dispatches) adds
 * ① profiler, ② memo cache, ④ literal prefilter, ⑥ streaming skip of display-only scripts and
 * ⑧ a persisted display cache (needs ST's MessageFormatter hooks). No ST core file is modified.
 */

import { RegexProvider, getRegexScripts } from '../../regex/engine.js';
import { regexFromString } from '../../../utils.js';

const MODULE_NAME = 'regex_perf_kit';
const EXTRA_KEY = 'regex_perf_cache';
const ctx = () => SillyTavern.getContext();

// ---- Settings ----

const defaultSettings = Object.freeze({
    profiler: true,
    prefilter: true,
    memo: true,
    memoMaxEntries: 3000,
    memoMaxLen: 20000,
    memoMaxMB: 64,
    streamingSkip: true,
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

function isStreamingLive() {
    if (!generating) return false;
    const sp = ctx().streamingProcessor;
    return !!sp && !sp.isFinished && !sp.isStopped;
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
    const counts = { total: scripts.length, active: 0, markdownOnly: 0, promptOnly: 0, noNeedle: 0, heavy: 0 };
    const versionParts = [];

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

        // As runRegexScript() reads it: {{match}} is $0, then group references are filled in.
        const replacement = replaceString.replace(/{{match}}/gi, '$0');
        map.set(keyOf(re), {
            name: s.scriptName || '(이름 없음)',
            markdownOnly: !!s.markdownOnly,
            // No macros, and no group reference that could complete one (<$1>, {$1}): the output then depends
            // only on the input, so it can be memoized.
            pure: !MACRO.test(replacement) && !/[{<]\$(?:\d|<)|\$(?:\d+|<[^>]+>)[}>]/.test(replacement)
                && !trims.some(t => MACRO.test(String(t))),
            replaceSig: fnv1a(replaceString + '\u0001' + trimSig),
            needle,
            heavy,
        });
        versionParts.push(re.source, re.flags, replaceString, trimSig, String(!!s.markdownOnly), String(!!s.promptOnly), String(s.minDepth), String(s.maxDepth));
    }
    return { map, counts, version: fnv1a(versionParts.join('\u0003')), builtAt: performance.now() };
}

// ---- Instrumented RegExp ----

const stats = new Map(); // pattern key -> counters, see getStat()
let statsSince = Date.now();
const persistStats = { hits: 0, stores: 0 };
let bypass = false; // set by the persisted-cache hook while a stored result is being shown

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
            name: '(알 수 없음)',
            src: '/' + re.source + '/' + re.flags,
            calls: 0, totalMs: 0, maxMs: 0,
            skipped: 0, hits: 0, streamSkipped: 0, bypass: 0,
            heavy: HEAVY_HINT.test(re.source),
            needle: null, // the needle the wrapper uses, set with its meta
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
        if (settings.streamingSkip && markdownOnly && isStreamingLive()) {
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
        const t0 = performance.now();
        const out = RegExp.prototype[Symbol.replace].call(native, str, replacer);
        if (settings.profiler) {
            const dt = performance.now() - t0;
            stat.calls++;
            stat.totalMs += dt;
            if (dt > stat.maxMs) stat.maxMs = dt;
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

// ---- ⑧ Persisted display cache (MessageFormatter hooks) ----

let persistAvailable = false;
let pending = null; // {msg, key, input}: message awaiting its after-regex result

function installPersistHooks() {
    const mf = ctx().messageFormatter;
    if (!mf || typeof mf.addHook !== 'function' || !mf.stage) return;
    persistAvailable = true;

    // Before regex: on a key match, substitute the stored result and bypass every script for this message.
    mf.addHook((mes, c) => {
        bypass = false;
        pending = null;
        if (!settings.persist || c.messageId < 0 || c.isReasoning || c.isSystem || isStreamingLive()) return mes;
        const { chat, name1, name2 } = ctx();
        const msg = chat?.[c.messageId];
        if (!msg) return mes;
        // {{user}}/{{char}} in replacements and trim strings resolve to these names (ch_name: the message author).
        const names = fnv1a([c.ch_name ?? c.characterName, name1, name2].join('\u0000'));
        const key = fnv1a(mes) + ':' + mes.length + ':' + ensureInfo().version + ':' + names;
        const e = msg.extra?.[EXTRA_KEY];
        if (e && e.k === key) {
            bypass = true;
            persistStats.hits++;
            return e.same ? mes : String(e.v ?? mes);
        }
        pending = { msg, key, input: mes };
        return mes;
    }, { stage: mf.stage.BEFORE_REGEX, order: mf.order?.LATEST ?? 100 });

    // After regex: store the freshly computed result.
    mf.addHook((mes) => {
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

const fmtMs = (x) => x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2);
const avgMs = (r) => (r.calls ? r.totalMs / r.calls : 0);
const fmtNeedles = (r) => r.needle?.needles?.map(s => JSON.stringify(s)).join(' | ') ?? null;

function buildSummary() {
    const { counts } = ensureInfo();
    const rows = [...stats.values()].sort((a, b) => b.totalMs - a.totalMs);
    const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);
    const total = sum('totalMs');
    const top = rows[0];
    return {
        counts,
        rows,
        total,
        calls: sum('calls'),
        skipped: sum('skipped'),
        hits: sum('hits'),
        streamSkipped: sum('streamSkipped'),
        bypass: sum('bypass'),
        chatLen: ctx().chat?.length ?? 0,
        top,
        topShare: top && total > 0 ? top.totalMs / total * 100 : 0,
    };
}

function buildReportText() {
    const s = buildSummary();
    const c = s.counts;
    const lines = [
        `Regex Perf Kit report (${new Date().toLocaleString()})`,
        `측정 시작: ${new Date(statsSince).toLocaleTimeString()} / 채팅 메시지 ${s.chatLen}개`,
        `스크립트: 전체 ${c.total}, 활성 ${c.active} (표시용 ${c.markdownOnly}, 프롬프트용 ${c.promptOnly}), 리터럴 없음 ${c.noNeedle}, 무거운 패턴 의심 ${c.heavy}`,
        `실행 ${s.calls}회 / 총 ${fmtMs(s.total)}ms | 프리필터 스킵 ${s.skipped} | 캐시 히트 ${s.hits} | 스트리밍 스킵 ${s.streamSkipped} | 영구캐시 바이패스 ${s.bypass} (히트 ${persistStats.hits}, 저장 ${persistStats.stores})`,
    ];
    if (s.top) lines.push(`1위 "${s.top.name}" 가 전체 시간의 ${s.topShare.toFixed(0)}% 차지`);
    lines.push('', '순위 | 스크립트 | 실행 | 총ms | 평균ms | 최대ms | 스킵 | 히트 | 리터럴 | 경고');
    s.rows.forEach((r, i) => {
        lines.push(`${i + 1} | ${r.name} | ${r.calls} | ${fmtMs(r.totalMs)} | ${fmtMs(avgMs(r))} | ${fmtMs(r.maxMs)} | ${r.skipped} | ${r.hits} | ${fmtNeedles(r) ?? '-'} | ${r.heavy ? '.* 계열' : ''}`);
    });
    return lines.join('\n');
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

const SETTINGS_HTML = `
<div id="regex_perf_kit" class="regex-perf-kit">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Regex Perf Kit</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="rpk-summary" id="rpk_summary">측정 중...</div>

      <div class="rpk-grid">
        <label class="checkbox_label" title="스크립트별 실행 시간을 측정합니다. 비용이 거의 없습니다.">
          <input type="checkbox" id="rpk_profiler"><span>① 프로파일러</span>
        </label>
        <label class="checkbox_label" title="패턴에 반드시 포함돼야 하는 고정 문자열이 메시지에 없으면 정규식을 실행하지 않습니다. 결과는 동일합니다.">
          <input type="checkbox" id="rpk_prefilter"><span>④ 리터럴 프리필터</span>
        </label>
        <label class="checkbox_label" title="같은 메시지에 같은 스크립트를 다시 돌릴 때 이전 결과를 재사용합니다. 치환문에 {{매크로}}가 있는 스크립트는 자동 제외.">
          <input type="checkbox" id="rpk_memo"><span>② 결과 캐시 (메모리)</span>
        </label>
        <label class="checkbox_label" title="스트리밍 중에는 표시 전용(markdownOnly) 스크립트를 건너뛰고, 생성이 끝나면 한 번 적용합니다.">
          <input type="checkbox" id="rpk_streaming"><span>⑥ 스트리밍 중 표시용 스킵</span>
        </label>
        <label class="checkbox_label" id="rpk_persist_label" title="표시 결과를 메시지(extra)에 저장해 채팅을 다시 열 때 재계산을 생략합니다. 채팅 파일이 커질 수 있습니다.">
          <input type="checkbox" id="rpk_persist"><span>⑧ 표시 결과 영구 캐시 (선택)</span>
        </label>
      </div>
      <div class="rpk-note" id="rpk_persist_note"></div>

      <div class="rpk-buttons">
        <div class="menu_button" id="rpk_refresh">새로고침</div>
        <div class="menu_button" id="rpk_reset">측정 초기화</div>
        <div class="menu_button" id="rpk_copy">리포트 복사</div>
        <div class="menu_button" id="rpk_clear_persist">영구 캐시 삭제(현재 채팅)</div>
      </div>

      <div class="rpk-table-wrap">
        <table class="rpk-table" id="rpk_table">
          <thead><tr><th>#</th><th>스크립트</th><th>실행</th><th>총 ms</th><th>평균</th><th>최대</th><th>스킵</th><th>히트</th><th>리터럴</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <details class="rpk-tips">
        <summary>⑥·⑦ 설정만으로 할 수 있는 것 (ST 기본 설정)</summary>
        <ul>
          <li><b>User Settings → "# Messages to Load"</b>: 채팅을 열 때 렌더링(=정규식 적용)하는 메시지 수. 0=전부. 50~100 정도로 줄이면 로딩이 크게 빨라집니다.</li>
          <li><b>User Settings → "Streaming FPS"</b>: 스트리밍 중 화면 갱신 횟수. 갱신마다 표시용 정규식이 전부 돌아가므로 10~15로 낮추면 렉이 줄어듭니다.</li>
          <li>표시용 스크립트는 <b>"Only Format Display"</b>, 프롬프트용은 <b>"Only Format Prompt"</b>를 켜두세요. 둘 다 꺼진 스크립트는 저장 시점에 돌아가며, 이 확장의 스트리밍 스킵 대상도 아닙니다.</li>
        </ul>
      </details>
    </div>
  </div>
</div>`;

const TOGGLES = { rpk_profiler: 'profiler', rpk_prefilter: 'prefilter', rpk_memo: 'memo', rpk_streaming: 'streamingSkip', rpk_persist: 'persist' };

let ui = null; // panel elements, cached by bindUi()
const rendered = new WeakMap();

/** Assigns el[prop] only when the value changed, so periodic refreshes leave an unchanged panel alone. */
function setContent(el, value, prop = 'innerHTML') {
    if (rendered.get(el) === value) return;
    rendered.set(el, value);
    el[prop] = value;
}

function renderPanel() {
    if (!ui) return;
    const s = buildSummary();
    const c = s.counts;
    let summary = `<div>스크립트 <b>${c.active}</b>/${c.total} 활성 (표시용 ${c.markdownOnly}, 프롬프트용 ${c.promptOnly})`
        + ` · 리터럴 없음 <b>${c.noNeedle}</b> · <code>.*</code> 계열 <b>${c.heavy}</b> · 채팅 ${s.chatLen}개</div>`
        + `<div>실행 <b>${s.calls}</b>회 / <b>${fmtMs(s.total)}</b> ms · 프리필터 스킵 <b>${s.skipped}</b> · 캐시 히트 <b>${s.hits}</b> · 스트리밍 스킵 <b>${s.streamSkipped}</b>`
        + (persistAvailable ? ` · 영구캐시 히트 <b>${persistStats.hits}</b>` : '') + '</div>';
    if (s.top && s.calls > 0) {
        summary += `<div class="${s.topShare >= 50 ? 'rpk-warn' : ''}">가장 느린 스크립트: <b>${esc(s.top.name)}</b> — 전체의 ${s.topShare.toFixed(0)}%</div>`;
    }
    if (!patched) summary += '<div class="rpk-warn">⚠ 정규식 엔진 패치 실패 — 이 ST 버전은 지원되지 않습니다.</div>';
    setContent(ui.summary, summary);

    setContent(ui.tbody, s.rows.slice(0, 60).map((r, i) => {
        const cls = (s.total > 0 && r.totalMs / s.total >= 0.5) ? 'rpk-hot' : (r.heavy ? 'rpk-heavy' : '');
        return `<tr class="${cls}" title="${esc(r.src)}">
          <td>${i + 1}</td><td>${esc(r.name)}${r.heavy ? ' <span class="rpk-badge" title="백트래킹이 많을 수 있는 패턴">.*</span>' : ''}</td>
          <td>${r.calls}</td><td>${fmtMs(r.totalMs)}</td><td>${fmtMs(avgMs(r))}</td><td>${fmtMs(r.maxMs)}</td>
          <td>${r.skipped}</td><td>${r.hits}</td><td>${r.needle?.needles ? esc(fmtNeedles(r)) : '<span class="rpk-dim">없음</span>'}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="9" class="rpk-dim">아직 측정된 실행이 없습니다. 메시지를 렌더링하거나 채팅을 다시 열어보세요.</td></tr>');

    setContent(ui.note, !persistAvailable
        ? '⑧ 영구 캐시는 이 ST 버전에 MessageFormatter 훅이 없어 사용할 수 없습니다 (staging 최신 버전 필요).'
        : settings.persist ? '⑧ 켜짐: 표시 결과가 메시지 extra에 저장됩니다. 스크립트를 바꾸면 키가 달라져 자동으로 재계산됩니다.' : '', 'textContent');
}

function bindUi() {
    const root = document.getElementById('regex_perf_kit');
    const find = (sel) => root.querySelector(sel);
    ui = { summary: find('#rpk_summary'), tbody: find('#rpk_table tbody'), note: find('#rpk_persist_note') };

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
    if (!persistAvailable) find('#rpk_persist').disabled = true;

    find('#rpk_refresh').addEventListener('click', () => { markDirty(); renderPanel(); });
    find('#rpk_reset').addEventListener('click', () => { resetStats(); renderPanel(); toastr.info('측정값을 초기화했습니다.'); });
    find('#rpk_copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(buildReportText());
            toastr.success('리포트를 클립보드에 복사했습니다.');
        } catch {
            toastr.warning('클립보드 복사 실패 — /regexperf 명령으로 팝업에서 확인하세요.');
        }
    });
    find('#rpk_clear_persist').addEventListener('click', async () => {
        const n = await clearPersistedCache();
        toastr.info(`영구 캐시 ${n}개를 삭제했습니다.`);
        renderPanel();
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
                return '측정값 초기화 완료';
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
        helpString: '<div>Regex Perf Kit 리포트를 팝업으로 표시합니다. <code>/regexperf reset</code> 으로 측정 초기화, <code>/regexperf text</code> 로 텍스트 반환.</div>',
    }));
}

// ---- Init ----

const { eventSource, event_types, extensionSettings } = ctx();
if (extensionSettings.disabledExtensions?.includes('regex')) {
    console.log('[RegexPerf] built-in regex extension is disabled; nothing to do.');
}
patchProvider();
eventSource.on(event_types.GENERATION_STARTED, (_type, _params, dryRun) => { if (!dryRun) generating = true; });
eventSource.on(event_types.GENERATION_ENDED, () => { generating = false; });
eventSource.on(event_types.GENERATION_STOPPED, () => { generating = false; });
eventSource.on(event_types.CHAT_CHANGED, markDirty);
eventSource.on(event_types.SETTINGS_UPDATED, markDirty);
if (event_types.PRESET_CHANGED) eventSource.on(event_types.PRESET_CHANGED, markDirty);
eventSource.on(event_types.APP_READY, () => {
    try { installPersistHooks(); } catch (e) { console.warn('[RegexPerf] persist hooks failed', e); }
    try {
        const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (container) {
            container.insertAdjacentHTML('beforeend', SETTINGS_HTML);
            bindUi();
            renderPanel();
        }
    } catch (e) { console.warn('[RegexPerf] UI init failed', e); }
    try { registerSlash(); } catch (e) { console.warn('[RegexPerf] slash command failed', e); }
    console.log('[RegexPerf] ready. patched=', patched, 'persistHooks=', persistAvailable);
});
