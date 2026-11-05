/**
 * Regex Perf Kit — SillyTavern extension
 *
 * Speeds up the built-in Regex extension WITHOUT touching any regex script:
 *   1. Profiler        — per-script call count / total ms / max ms (find the slow one)
 *   2. Memo cache      — same input + same script => reuse the previous result
 *   4. Literal prefilter — if a mandatory literal of the pattern is absent, skip the regex
 *   6. Streaming skip  — skip display-only (markdownOnly) scripts while a stream is live
 *   8. Persisted cache — (optional) store the display result in message.extra so a chat reload
 *                        does not recompute it. Needs ST's MessageFormatter hooks (staging).
 *
 * How it works: the engine compiles every pattern through RegexProvider.instance.get().
 * We replace that method so it returns a RegExp subclass whose [Symbol.replace] is
 * instrumented. String.prototype.replace() dispatches to that symbol, so every
 * regex script run passes through here. No ST core file is modified.
 */

import { RegexProvider, getRegexScripts } from '../../regex/engine.js';
import { regexFromString } from '../../../utils.js';

const MODULE_NAME = 'regex_perf_kit';
const EXTRA_KEY = 'regex_perf_cache';

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const defaultSettings = Object.freeze({
    profiler: true,
    prefilter: true,
    memo: true,
    memoMaxEntries: 3000,
    memoMaxLen: 20000,
    streamingSkip: true,
    persist: false,
    persistMaxLen: 60000,
});

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

function isStreamingLive() {
    const sp = ctx().streamingProcessor;
    return !!sp && !sp.isFinished && !sp.isStopped;
}

/**
 * Extracts a literal substring that EVERY match of the pattern must contain.
 * Conservative: returns null whenever unsure (top-level alternation, exotic escapes, ...).
 * Only characters at group depth 0 that are not optional are considered.
 * @param {string} source RegExp.source
 * @param {string} flags RegExp.flags
 * @returns {{needle: string, ci: boolean} | null}
 */
export function extractNeedle(source, flags) {
    if (flags.includes('v')) return null;
    const n = source.length;
    let i = 0;
    let depth = 0;
    let cur = '';
    const runs = [];
    const endRun = () => { if (cur) runs.push(cur); cur = ''; };

    // Returns quantifier info starting at index j, or null if none.
    const quantAt = (j) => {
        const c = source[j];
        if (c === '?' || c === '*') return { optional: true, len: 1 };
        if (c === '+') return { optional: false, len: 1 };
        if (c === '{') {
            const m = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(j, j + 24));
            if (m) return { optional: Number(m[1]) === 0, len: m[0].length };
        }
        return null;
    };
    // Consumes a quantifier (and lazy '?') if present.
    const skipQuant = (j) => {
        const q = quantAt(j);
        if (!q) return { j, optional: false, had: false };
        let k = j + q.len;
        if (source[k] === '?') k++;
        return { j: k, optional: q.optional, had: true };
    };
    // Adds a literal (or breaks the run) depending on the following quantifier.
    const pushLiteral = (lit, j) => {
        const q = skipQuant(j);
        if (depth === 0) {
            if (lit !== null && !q.optional) {
                cur += lit;
                if (q.had) endRun(); // "ab+c": run ends after the repeated char
            } else {
                endRun();
            }
        }
        return q.j;
    };

    while (i < n) {
        const c = source[i];

        if (c === '\\') {
            const nx = source[i + 1];
            if (nx === undefined) break;
            let lit = null;
            let adv = 2;
            if ('dDwWsSbB'.includes(nx) || /[0-9]/.test(nx)) {
                lit = null; // class escapes, anchors, backreferences
            } else if ((nx === 'p' || nx === 'P' || nx === 'k' || nx === 'u') && (source[i + 2] === '{' || source[i + 2] === '<')) {
                // \p{..} \P{..} \u{..} \k<..> — skip the argument; give up if it looks like real syntax
                const close = source[i + 2] === '<' ? '>' : '}';
                const e = source.indexOf(close, i + 3);
                if (e === -1) {
                    adv = 2;
                } else {
                    const inner = source.slice(i + 3, e);
                    if (/[|()[\]\\]/.test(inner)) return null;
                    adv = e + 1 - i;
                }
            } else if (nx === 'u') {
                adv = /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6)) ? 6 : 2;
            } else if (nx === 'x') {
                adv = /^[0-9a-fA-F]{2}$/.test(source.slice(i + 2, i + 4)) ? 4 : 2;
            } else if (nx === 'c') {
                adv = /^[a-zA-Z]$/.test(source[i + 2] ?? '') ? 3 : 2;
            } else if (nx === 'n') lit = '\n';
            else if (nx === 't') lit = '\t';
            else if (nx === 'r') lit = '\r';
            else if (nx === 'f') lit = '\f';
            else if (nx === 'v') lit = '\v';
            else if (nx === '0') lit = null;
            else lit = nx; // escaped punctuation => literal char
            i = pushLiteral(lit, i + adv);
            continue;
        }

        if (c === '[') {
            let j = i + 1;
            if (source[j] === '^') j++;
            // Note: in JS "[]" is an empty class and "[^]" matches anything — ']' right after '[' closes it.
            while (j < n && source[j] !== ']') {
                if (source[j] === '\\') j++;
                j++;
            }
            i = pushLiteral(null, j + 1);
            continue;
        }

        if (c === '(') {
            depth++;
            if (depth === 1) endRun();
            i++;
            // "(?" prefixes: consume so the '?' is not read as a quantifier
            if (source[i] === '?') {
                i++;
                if (source[i] === '<' && source[i + 1] !== '=' && source[i + 1] !== '!') {
                    const e = source.indexOf('>', i);
                    i = e === -1 ? n : e + 1;
                } else {
                    i++; // ':', '=', '!', '<' (lookbehind handled by next char)
                    if (source[i - 1] === '<') i++;
                }
            }
            continue;
        }

        if (c === ')') {
            depth--;
            i = pushLiteral(null, i + 1);
            continue;
        }

        if (c === '|') {
            if (depth === 0) return null; // top-level alternation => no mandatory literal
            i++;
            continue;
        }

        if (c === '.' || c === '^' || c === '$') {
            i = pushLiteral(null, i + 1);
            continue;
        }

        if (c === '*' || c === '+' || c === '?' || c === '{') {
            // Stray quantifier / literal brace: be conservative and break the run
            const q = skipQuant(i);
            i = q.had ? q.j : i + 1;
            if (depth === 0) endRun();
            continue;
        }

        i = pushLiteral(c, i + 1);
    }
    endRun();

    if (!runs.length) return null;
    let best = '';
    for (const r of runs) if (r.length > best.length) best = r;
    if (!best) return null;

    if (flags.includes('i')) {
        const lower = best.toLowerCase();
        const hasLetters = lower !== best.toUpperCase();
        return { needle: lower, ci: hasLetters };
    }
    return { needle: best, ci: false };
}

const HEAVY_HINT = /(\.\*|\.\+|\[\\s\\S\]\*|\[\^\]\*|\(\.\|\\n\)\*|\[\\w\\W\]\*)/;

// ---------------------------------------------------------------------------
// Script info map: compiled key -> script metadata
// ---------------------------------------------------------------------------

let infoMap = new Map();
let infoDirty = true;
let infoBuiltAt = 0;
let scriptsVersion = '0';
let scriptCounts = { total: 0, active: 0, markdownOnly: 0, promptOnly: 0, noNeedle: 0, heavy: 0 };

function keyOf(re) {
    return re.source + '\u0000' + re.flags;
}

function rebuildInfoMap() {
    const map = new Map();
    let scripts = [];
    try { scripts = getRegexScripts({ allowedOnly: true }) ?? []; } catch (e) { console.warn('[RegexPerf] getRegexScripts failed', e); }
    const { substituteParamsExtended } = ctx();
    const counts = { total: scripts.length, active: 0, markdownOnly: 0, promptOnly: 0, noNeedle: 0, heavy: 0 };
    const versionParts = [];

    for (const s of scripts) {
        if (!s?.findRegex) continue;
        if (s.disabled) continue;
        counts.active++;
        if (s.markdownOnly) counts.markdownOnly++;
        if (s.promptOnly) counts.promptOnly++;

        let rs = s.findRegex;
        if (Number(s.substituteRegex) === 1) {
            try { rs = substituteParamsExtended(rs); } catch { /* ignore */ }
        }
        let re = null;
        try { re = regexFromString(rs); } catch { /* ignore */ }
        if (!re) continue;

        const replaceString = String(s.replaceString ?? '');
        const trims = Array.isArray(s.trimStrings) ? s.trimStrings : [];
        const pure = !/{{(?!match}})/i.test(replaceString) && !trims.some(t => String(t).includes('{{'));
        const needle = extractNeedle(re.source, re.flags);
        const heavy = HEAVY_HINT.test(re.source);
        if (!needle) counts.noNeedle++;
        if (heavy) counts.heavy++;

        const info = {
            name: s.scriptName || '(이름 없음)',
            markdownOnly: !!s.markdownOnly,
            promptOnly: !!s.promptOnly,
            pure,
            replaceSig: fnv1a(replaceString + '\u0001' + trims.join('\u0002')),
            needle,
            heavy,
        };
        map.set(keyOf(re), info);
        versionParts.push(re.source, re.flags, replaceString, trims.join('\u0002'), String(!!s.markdownOnly), String(!!s.promptOnly), String(s.minDepth), String(s.maxDepth));
    }

    infoMap = map;
    scriptCounts = counts;
    scriptsVersion = fnv1a(versionParts.join('\u0003'));
    infoDirty = false;
    infoBuiltAt = performance.now();
}

function ensureInfo() {
    if (infoDirty || performance.now() - infoBuiltAt > 5000) {
        rebuildInfoMap();
    }
}

// ---------------------------------------------------------------------------
// Instrumented RegExp
// ---------------------------------------------------------------------------

/** @type {Map<string, {name:string, src:string, calls:number, totalMs:number, maxMs:number, skipped:number, hits:number, streamSkipped:number, bypass:number, heavy:boolean, needle:string|null}>} */
const stats = new Map();
let statsSince = Date.now();
const persistStats = { hits: 0, stores: 0 };

/** Memo cache (LRU via Map insertion order) */
const memo = new Map();

const state = {
    bypass: false,   // set by the persisted-cache BEFORE_REGEX hook
    pending: null,   // {msg, key, input}
};

function getStat(key, re, info) {
    let st = stats.get(key);
    if (!st) {
        st = {
            name: info?.name ?? '(알 수 없음)',
            src: '/' + re.source + '/' + re.flags,
            calls: 0, totalMs: 0, maxMs: 0,
            skipped: 0, hits: 0, streamSkipped: 0, bypass: 0,
            heavy: !!info?.heavy,
            needle: info?.needle?.needle ?? null,
        };
        stats.set(key, st);
    } else if (info && st.name !== info.name) {
        st.name = info.name;
    }
    return st;
}

class PerfRegExp extends RegExp {
    constructor(source, flags, meta) {
        super(source, flags);
        this._meta = meta;
    }

    [Symbol.replace](str, replacer) {
        const meta = this._meta;
        const settings = getSettings();
        const st = meta.stat;

        if (state.bypass) {
            st.bypass++;
            return str;
        }

        if (settings.streamingSkip && meta.info?.markdownOnly && isStreamingLive()) {
            st.streamSkipped++;
            return str;
        }

        if (settings.prefilter && meta.needle) {
            const hay = meta.needle.ci ? str.toLowerCase() : str;
            if (!hay.includes(meta.needle.needle)) {
                st.skipped++;
                return str;
            }
        }

        let cacheKey;
        if (settings.memo && meta.info?.pure && str.length <= settings.memoMaxLen) {
            cacheKey = meta.key + '\u0001' + meta.info.replaceSig + '\u0001' + str;
            const hit = memo.get(cacheKey);
            if (hit !== undefined) {
                memo.delete(cacheKey);
                memo.set(cacheKey, hit);
                st.hits++;
                return hit;
            }
        }

        this.lastIndex = 0;
        const t0 = performance.now();
        const out = RegExp.prototype[Symbol.replace].call(this, str, replacer);
        const dt = performance.now() - t0;

        if (settings.profiler) {
            st.calls++;
            st.totalMs += dt;
            if (dt > st.maxMs) st.maxMs = dt;
        }

        if (cacheKey !== undefined) {
            memo.set(cacheKey, out);
            while (memo.size > settings.memoMaxEntries) {
                memo.delete(memo.keys().next().value);
            }
        }
        return out;
    }
}

// ---------------------------------------------------------------------------
// Patch RegexProvider.instance
// ---------------------------------------------------------------------------

/** @type {Map<string, PerfRegExp>} */
const wrapped = new Map();
let patched = false;

function patchProvider() {
    const inst = RegexProvider?.instance;
    if (!inst || typeof inst.get !== 'function') {
        console.warn('[RegexPerf] RegexProvider.instance not found — this ST version is not supported.');
        return false;
    }
    const origGet = inst.get.bind(inst);
    const origClear = inst.clear.bind(inst);

    inst.get = function (regexString) {
        const base = origGet(regexString);
        if (!base) return null;
        let w = wrapped.get(regexString);
        if (!w) {
            ensureInfo();
            const key = keyOf(base);
            const info = infoMap.get(key) ?? null;
            let needle = info?.needle;
            if (needle === undefined) {
                needle = extractNeedle(base.source, base.flags);
            }
            const meta = { key, info, needle: needle ?? null, stat: null };
            meta.stat = getStat(key, base, info);
            try {
                w = new PerfRegExp(base.source, base.flags, meta);
            } catch (e) {
                console.warn('[RegexPerf] could not wrap regex, falling back', e);
                return base;
            }
            if (wrapped.size >= 1000) wrapped.delete(wrapped.keys().next().value);
            wrapped.set(regexString, w);
        }
        w.lastIndex = 0;
        return w;
    };

    inst.clear = function () {
        origClear();
        wrapped.clear();
        infoDirty = true;
    };

    patched = true;
    return true;
}

// ---------------------------------------------------------------------------
// Feature 8: persisted display cache (MessageFormatter hooks)
// ---------------------------------------------------------------------------

let persistAvailable = false;

function installPersistHooks() {
    const mf = ctx().messageFormatter;
    if (!mf || typeof mf.addHook !== 'function' || !mf.stage) {
        persistAvailable = false;
        return;
    }
    persistAvailable = true;

    mf.addHook((mes, c) => {
        state.bypass = false;
        state.pending = null;
        const settings = getSettings();
        if (!settings.persist || c.messageId < 0 || c.isReasoning || c.isSystem) return mes;
        if (isStreamingLive()) return mes;
        const msg = ctx().chat?.[c.messageId];
        if (!msg) return mes;
        ensureInfo();
        const key = fnv1a(mes) + ':' + mes.length + ':' + scriptsVersion + ':' + (c.characterName || '');
        const e = msg.extra?.[EXTRA_KEY];
        if (e && e.k === key) {
            state.bypass = true;
            persistStats.hits++;
            return e.same ? mes : String(e.v ?? mes);
        }
        state.pending = { msg, key, input: mes };
        return mes;
    }, { stage: mf.stage.BEFORE_REGEX, order: mf.order?.LATEST ?? 100 });

    mf.addHook((mes, c) => {
        if (state.bypass) {
            state.bypass = false;
            return mes;
        }
        const p = state.pending;
        state.pending = null;
        if (!p) return mes;
        const settings = getSettings();
        if (mes.length > settings.persistMaxLen) return mes;
        if (!p.msg.extra) p.msg.extra = {};
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

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function sortedStats() {
    return [...stats.values()].sort((a, b) => b.totalMs - a.totalMs);
}

function fmtMs(x) { return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2); }

function buildSummary() {
    ensureInfo();
    const rows = sortedStats();
    const total = rows.reduce((a, r) => a + r.totalMs, 0);
    const calls = rows.reduce((a, r) => a + r.calls, 0);
    const skipped = rows.reduce((a, r) => a + r.skipped, 0);
    const hits = rows.reduce((a, r) => a + r.hits, 0);
    const streamSkipped = rows.reduce((a, r) => a + r.streamSkipped, 0);
    const bypass = rows.reduce((a, r) => a + r.bypass, 0);
    const chatLen = ctx().chat?.length ?? 0;
    const top = rows[0];
    const topShare = top && total > 0 ? (top.totalMs / total * 100) : 0;
    return { rows, total, calls, skipped, hits, streamSkipped, bypass, chatLen, top, topShare };
}

function buildReportText() {
    const s = buildSummary();
    const lines = [];
    lines.push(`Regex Perf Kit report (${new Date().toLocaleString()})`);
    lines.push(`측정 시작: ${new Date(statsSince).toLocaleTimeString()} / 채팅 메시지 ${s.chatLen}개`);
    lines.push(`스크립트: 전체 ${scriptCounts.total}, 활성 ${scriptCounts.active} (표시용 ${scriptCounts.markdownOnly}, 프롬프트용 ${scriptCounts.promptOnly}), 리터럴 없음 ${scriptCounts.noNeedle}, 무거운 패턴 의심 ${scriptCounts.heavy}`);
    lines.push(`실행 ${s.calls}회 / 총 ${fmtMs(s.total)}ms | 프리필터 스킵 ${s.skipped} | 캐시 히트 ${s.hits} | 스트리밍 스킵 ${s.streamSkipped} | 영구캐시 바이패스 ${s.bypass} (히트 ${persistStats.hits}, 저장 ${persistStats.stores})`);
    if (s.top) lines.push(`1위 "${s.top.name}" 가 전체 시간의 ${s.topShare.toFixed(0)}% 차지`);
    lines.push('');
    lines.push('순위 | 스크립트 | 실행 | 총ms | 평균ms | 최대ms | 스킵 | 히트 | 리터럴 | 경고');
    s.rows.forEach((r, i) => {
        const avg = r.calls ? r.totalMs / r.calls : 0;
        lines.push(`${i + 1} | ${r.name} | ${r.calls} | ${fmtMs(r.totalMs)} | ${fmtMs(avg)} | ${fmtMs(r.maxMs)} | ${r.skipped} | ${r.hits} | ${r.needle ? JSON.stringify(r.needle) : '-'} | ${r.heavy ? '.* 계열' : ''}`);
    });
    return lines.join('\n');
}

function resetStats() {
    stats.clear();
    statsSince = Date.now();
    persistStats.hits = 0;
    persistStats.stores = 0;
    // re-link stat objects on next get()
    wrapped.clear();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function settingsHtml() {
    return `
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
}

function renderPanel() {
    const root = document.getElementById('regex_perf_kit');
    if (!root) return;
    const s = buildSummary();
    const sum = root.querySelector('#rpk_summary');
    const parts = [];
    parts.push(`<div>스크립트 <b>${scriptCounts.active}</b>/${scriptCounts.total} 활성 (표시용 ${scriptCounts.markdownOnly}, 프롬프트용 ${scriptCounts.promptOnly})`
        + ` · 리터럴 없음 <b>${scriptCounts.noNeedle}</b> · <code>.*</code> 계열 <b>${scriptCounts.heavy}</b> · 채팅 ${s.chatLen}개</div>`);
    parts.push(`<div>실행 <b>${s.calls}</b>회 / <b>${fmtMs(s.total)}</b> ms · 프리필터 스킵 <b>${s.skipped}</b> · 캐시 히트 <b>${s.hits}</b> · 스트리밍 스킵 <b>${s.streamSkipped}</b>`
        + (persistAvailable ? ` · 영구캐시 히트 <b>${persistStats.hits}</b>` : '') + `</div>`);
    if (s.top && s.calls > 0) {
        const cls = s.topShare >= 50 ? 'rpk-warn' : '';
        parts.push(`<div class="${cls}">가장 느린 스크립트: <b>${esc(s.top.name)}</b> — 전체의 ${s.topShare.toFixed(0)}%</div>`);
    }
    if (!patched) parts.push('<div class="rpk-warn">⚠ 정규식 엔진 패치 실패 — 이 ST 버전은 지원되지 않습니다.</div>');
    sum.innerHTML = parts.join('');

    const tbody = root.querySelector('#rpk_table tbody');
    const rows = s.rows.slice(0, 60);
    tbody.innerHTML = rows.map((r, i) => {
        const avg = r.calls ? r.totalMs / r.calls : 0;
        const cls = (s.total > 0 && r.totalMs / s.total >= 0.5) ? 'rpk-hot' : (r.heavy ? 'rpk-heavy' : '');
        return `<tr class="${cls}" title="${esc(r.src)}">
          <td>${i + 1}</td><td>${esc(r.name)}${r.heavy ? ' <span class="rpk-badge" title="백트래킹이 많을 수 있는 패턴">.*</span>' : ''}</td>
          <td>${r.calls}</td><td>${fmtMs(r.totalMs)}</td><td>${fmtMs(avg)}</td><td>${fmtMs(r.maxMs)}</td>
          <td>${r.skipped}</td><td>${r.hits}</td><td>${r.needle ? esc(JSON.stringify(r.needle)) : '<span class="rpk-dim">없음</span>'}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="9" class="rpk-dim">아직 측정된 실행이 없습니다. 메시지를 렌더링하거나 채팅을 다시 열어보세요.</td></tr>';

    const note = root.querySelector('#rpk_persist_note');
    if (!persistAvailable) {
        note.textContent = '⑧ 영구 캐시는 이 ST 버전에 MessageFormatter 훅이 없어 사용할 수 없습니다 (staging 최신 버전 필요).';
        root.querySelector('#rpk_persist').disabled = true;
    } else {
        note.textContent = getSettings().persist
            ? '⑧ 켜짐: 표시 결과가 메시지 extra에 저장됩니다. 스크립트를 바꾸면 키가 달라져 자동으로 재계산됩니다.'
            : '';
    }
}

function bindUi() {
    const settings = getSettings();
    const root = document.getElementById('regex_perf_kit');
    const bind = (id, key) => {
        const el = root.querySelector('#' + id);
        el.checked = !!settings[key];
        el.addEventListener('change', () => {
            settings[key] = el.checked;
            ctx().saveSettingsDebounced();
            if (key === 'memo' && !el.checked) memo.clear();
            renderPanel();
        });
    };
    bind('rpk_profiler', 'profiler');
    bind('rpk_prefilter', 'prefilter');
    bind('rpk_memo', 'memo');
    bind('rpk_streaming', 'streamingSkip');
    bind('rpk_persist', 'persist');

    root.querySelector('#rpk_refresh').addEventListener('click', () => { infoDirty = true; renderPanel(); });
    root.querySelector('#rpk_reset').addEventListener('click', () => { resetStats(); renderPanel(); toastr.info('측정값을 초기화했습니다.'); });
    root.querySelector('#rpk_copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(buildReportText());
            toastr.success('리포트를 클립보드에 복사했습니다.');
        } catch {
            toastr.warning('클립보드 복사 실패 — /regexperf 명령으로 팝업에서 확인하세요.');
        }
    });
    root.querySelector('#rpk_clear_persist').addEventListener('click', async () => {
        const n = await clearPersistedCache();
        toastr.info(`영구 캐시 ${n}개를 삭제했습니다.`);
        renderPanel();
    });

    // auto-refresh while visible
    setInterval(() => {
        const content = root.querySelector('.inline-drawer-content');
        if (content && content.offsetParent !== null) renderPanel();
    }, 2000);
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
            if (arg === 'text') return text;
            const html = `<pre class="rpk-report">${esc(text)}</pre>`;
            if (typeof callGenericPopup === 'function') {
                await callGenericPopup(html, POPUP_TYPE?.TEXT ?? 1, '', { wide: true, large: true, allowVerticalScrolling: true });
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

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(function init() {
    const { eventSource, event_types, extensionSettings } = ctx();
    getSettings();

    if (extensionSettings?.disabledExtensions?.includes('regex')) {
        console.log('[RegexPerf] built-in regex extension is disabled; nothing to do.');
    }

    patchProvider();

    const markDirty = () => { infoDirty = true; };
    eventSource.on(event_types.CHAT_CHANGED, markDirty);
    eventSource.on(event_types.SETTINGS_UPDATED, markDirty);
    if (event_types.PRESET_CHANGED) eventSource.on(event_types.PRESET_CHANGED, markDirty);

    const onReady = () => {
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
    };
    eventSource.on(event_types.APP_READY, onReady);
})();
