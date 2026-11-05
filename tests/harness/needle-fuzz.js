// Shared by tests/needle-fuzz.mjs (Node) and the browser suite (Chrome, the engine SillyTavern runs on):
// hand-checked extractNeedle() cases, and a differential fuzzer of the prefilter's soundness: whenever the
// prefilter says "skip", the regex must have no match in the string.

/** [pattern, flags, expected needles (null: no prefilter)] */
export const CASES = [
    ['</status>', '', ['</status>']],
    ['<status>([\\s\\S]*?)<\\/status>', 'g', ['</status>']],
    ['ab+c', '', ['ab']],
    ['ab?c', '', ['a']],
    ['a*', '', null],
    ['', '', null],
    ['(?:abc)', '', ['abc']],
    ['x(?:abc)y', '', ['xabcy']],
    ['x(abc)y', '', ['xabcy']],
    ['x(?<n>abc)y', '', ['xabcy']],
    ['(?:ab\\dcd)ef', '', ['cdef']],
    ['x(?:ab)+y', '', ['xab']],
    ['(abc)+d', '', ['abcd']],
    ['(?:abc)?d', '', ['d']],
    ['(?:abc){0,2}d', '', ['d']],
    ['foo|bar', '', ['foo', 'bar']],
    ['foo|bar|foo', 'g', ['foo', 'bar']],
    ['<thinking>[\\s\\S]*?<\\/thinking>|<think>[\\s\\S]*?<\\/think>', 'gi', ['</thinking>', '</think>']],
    ['foo|', '', null],
    ['foo|\\d+', '', null],
    ['(?:foo|bar)x', '', ['foo', 'bar']],
    ['(?:a|b)cd', '', ['cd']],
    ['(?:a|b)c', '', ['c']],
    ['q(?:foo|bar)?', '', ['q']],
    ['(?i:abc)', '', null],
    ['x(?i:abc)', '', null], // case modifiers: no needle at all (see extractNeedle)
    ['x(?-i:abc)y', 'i', null],
    ['x(?ms-i:abc)', '', null],
    ['x(?s:a.c)y', '', ['x']],
    ['(?=abc)def', '', ['def']],
    ['(?<=abc)def', '', ['def']],
    ['(?!abc)def', '', ['def']],
    ['(a)\\1', '', ['a']],
    ['\\.\\*\\/', '', ['.*/']],
    ['a\\nb', '', ['a\nb']],
    ['a{', '', ['a']],
    ['a{2}b', '', ['ab']],
    ['😀*', 'u', null],
    ['😀+x', 'u', ['😀x']],
    ['a😀?', 'u', ['a']],
    ['\\u0041bc', '', ['bc']],
    ['k*?\\011*', '', null], // legacy octal escape: \011 is one character, the * repeats it
    ['\\12x', '', ['x']],
    ['(a)\\1bc', '', ['bc']],
    ['\\p{L}+abc', 'u', ['abc']],
    ['(\\p{a)|b}', '', null],
    ['[abc]', 'v', null],
];

/** [pattern, flags, nested quantifier expected] */
export const NESTED = [
    ['(a+)+', '', true],
    ['(?:\\w+\\s?)*$', '', true],
    ['(?:a|b+)*', '', true],
    ['((a*))+', '', true],
    ['(a+){2,}', '', true],
    ['(a+){1,5}', '', false],
    ['(a+)?', '', false],
    ['a+b+', '', false],
    ['(?:ab)+', '', false],
    ['[\\s\\S]*', '', false],
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Checks the cases; patterns this engine cannot compile (e.g. (?i:) before V8 12.5) are returned, not run. */
export function runCases(extractNeedle) {
    const unsupported = [];
    for (const [source, flags, want] of CASES) {
        try {
            new RegExp(source, flags);
        } catch {
            unsupported.push(`/${source}/${flags}`);
            continue;
        }
        const got = extractNeedle(source, flags).needles;
        if (!same(got, want)) throw new Error(`extractNeedle(/${source}/${flags}).needles = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    for (const [source, flags, want] of NESTED) {
        const got = extractNeedle(source, flags).nested;
        if (got !== want) throw new Error(`extractNeedle(/${source}/${flags}).nested = ${got}, want ${want}`);
    }
    return { checked: CASES.length + NESTED.length - unsupported.length, unsupported };
}

// Characters whose case folding differs between toLowerCase() and the regex engine, astral characters, syntax
// characters (escaped where needed) and plain letters.
const CHARS = ['a', 'b', 'c', 'x', 'A', 'B', 'σ', 'Σ', 'ς', 'µ', 'μ', 'Μ', 'ß', 'ẞ', 'ſ', 's', 'S', 'K', 'k', 'K', 'İ', 'ı', 'i', 'I',
    'ǅ', 'Ǆ', 'ǆ', 'Ω', 'Ω', 'ω', 'Å', 'å', '😀', '😁', '-', ' ', '\n', '_', '1', '<', '>', '=', ':', '"', '#'];
const SYNTAX = ['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '/'];
const QUANTS = ['', '', '', '?', '*', '+', '{2}', '{0,2}', '{1,}', '{0}', '{1,3}', '{3}'];
const GROUPS = ['(', '(', '(?:', '(?:', '(?<n>', '(?=', '(?!', '(?<=', '(?<!', '(?i:', '(?-i:', '(?s:', '(?m-i:'];

/**
 * Generates random patterns (biased toward the constructs extractNeedle treats specially) and strings built from
 * their characters, and fails if the prefilter would skip a string the regex matches.
 * @returns {{seed: number, valid: number, skips: number, matched: number}}
 */
export function fuzz(extractNeedle, { seed, patterns }) {
    let state = seed;
    const rand = () => { // mulberry32
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const chance = (p) => rand() < p;

    const quant = () => {
        const q = pick(QUANTS);
        return q && chance(0.25) ? q + '?' : q;
    };
    const gen = (depth, ctx) => {
        const out = [];
        for (let a = chance(0.15) ? 2 + Math.floor(rand() * 2) : 1; a > 0; a--) {
            let seq = '';
            for (let k = chance(0.08) ? 0 : 1 + Math.floor(rand() * 4); k > 0; k--) seq += atom(depth, ctx) + quant();
            out.push(seq);
        }
        return out.join('|');
    };
    const atom = (depth, ctx) => {
        const r = rand();
        if (r < 0.45) {
            const c = pick(CHARS);
            return c === '\n' ? '\\n' : c;
        }
        if (r < 0.52) return '\\' + pick(SYNTAX);
        if (r < 0.58) return pick(['.', '^', '$', '\\b', '\\B', '\\d', '\\w', '\\s', '\\S']);
        if (r < 0.63) return pick(['[abc]', '[^a]', '[a-z]', '[σς]', '[]', '[^]', '[\\]x]', '[😀]']);
        if (r < 0.66) return pick(['\\u0041', '\\x61', '\\cJ', '\\0', '\\t', '\\-']);
        if (r < 0.68) return ctx.u ? pick(['\\p{L}', '\\P{Lu}', '\\u{1F600}', '\\u{61}']) : pick(['\\p', '\\k', '\\u{61}', 'a{', '}', ']', 'x{,2}', '\\p{a)|b}']);
        if (r < 0.70 && ctx.groups) return '\\' + (1 + Math.floor(rand() * ctx.groups));
        if (depth > 1) return pick(CHARS); // deeper nesting makes the engine itself backtrack for minutes
        const g = pick(GROUPS);
        if (g === '(' || g === '(?<n>') ctx.groups++;
        return (g === '(?<n>' ? `(?<n${ctx.groups}>` : g) + gen(depth + 1, ctx) + ')';
    };
    const sample = (source) => {
        const pieces = [...source.replace(/\\[pPu]\{[^}]*\}|\\./g, ' ')].filter(c => !SYNTAX.includes(c));
        let s = '';
        for (let k = Math.floor(rand() * 11); k > 0; k--) s += chance(0.6) && pieces.length ? pick(pieces) : pick(CHARS);
        return chance(0.5) ? s : chance(0.5) ? s.toUpperCase() : s.toLowerCase();
    };

    let valid = 0;
    let skips = 0;
    let matched = 0;
    for (let p = 0; p < patterns; p++) {
        const ctx = { groups: 0, u: chance(0.35) };
        const source = gen(0, ctx);
        const flags = [...'dgimsy'].filter(() => chance(0.3)).join('') + (ctx.u ? 'u' : '');
        let re;
        try {
            re = new RegExp(source, flags.replace(/[gy]/g, ''));
        } catch {
            continue;
        }
        valid++;
        const { needles, test } = extractNeedle(source, flags);
        if (!test) continue;
        for (let k = 0; k < 30; k++) {
            const str = sample(source);
            const matches = re.test(str);
            if (matches) matched++;
            if (test(str)) continue;
            skips++;
            if (matches) {
                throw new Error(`seed ${seed}: /${source}/${flags} has needles ${JSON.stringify(needles)} but matches ${JSON.stringify(str)} (match ${JSON.stringify(str.match(re)?.[0])})`);
            }
        }
    }
    if (skips < patterns || matched < patterns) throw new Error(`fuzzer too weak (seed ${seed}): ${skips} skips, ${matched} matches`);
    return { seed, valid, skips, matched };
}
