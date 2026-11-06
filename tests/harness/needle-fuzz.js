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
    ['(\\p{a)|b}', '', ['p', 'b}']], // without u, \p is the letter p and {a) is not a quantifier
    ['\\p{0,2}x', '', ['x']],
    ['\\u{61}', '', ['u']],
    ['\\u{0}x', '', ['x']],
    ['\\x{2}', '', ['x']],
    ['[abc]', 'v', null],
];

/** [pattern, flags, expected terms (every match satisfies all: a one-literal term must occur, one of a longer term)] */
export const TERMS = [
    ['x(?:ab)+y', '', [['xab'], ['aby']]],
    ['ab?c', '', [['a'], ['c']]],
    ['ab+c', '', [['ab'], ['bc']]],
    ['(?:foo|bar)x', '', [['x'], ['foo', 'bar']]],
    ['x(?:a\\db\\dc)y', '', [['xa'], ['cy'], ['b']]],
    ['(abc)+d', '', [['abcd']]],
    ['xfoo(?:foo|bar)', '', [['xfoo']]], // the alternation is implied by the mandatory run
    ['foo|bar', '', [['foo', 'bar']]],
    ['<status>([\\s\\S]*?)<\\/status>', 'g', [['</status>'], ['<status>']]],
    ['(?=abc)def', '', [['def']]],
    ['a*', '', []],
    ['\\d{5}', '', []],
];

/** [pattern, flags, expected reason code for having no needle (null: it has one)] */
export const REASONS = [
    ['abc', '', null],
    ['', '', 'empty'],
    ['\\d+', '', 'class-only'],
    ['[abc].*', 'g', 'class-only'],
    ['a*', '', 'optional'],
    ['(?:abc)?\\d', '', 'optional'],
    ['(?=abc)\\w+', '', 'lookaround'],
    ['(?<!x)\\d', '', 'lookaround'],
    ['foo|\\d+', '', 'branch'],
    ['(?:foo|\\d+)\\s', '', 'branch'],
    ['foo|', '', 'branch'],
    [Array.from({ length: 17 }, (_, k) => 'w' + k).join('|'), '', 'too-many'],
    ['abc', 'v', 'v-flag'],
    ['x(?i:abc)', '', 'case-modifier'],
    ['(\\p{a)|b}', 'u', 'syntax'],
];

/** [pattern, flags, expected minimum match length in UTF-16 units] */
export const MINLEN = [
    ['\\d{5}', '', 5],
    ['<status>([\\s\\S]*?)<\\/status>', 'g', 17],
    ['ab?c', '', 2],
    ['(?:abc){2,}d', '', 7],
    ['(?=abc)def', '', 3],
    ['(?<!x)y\\b', '', 1],
    ['a|bcd', '', 1],
    ['(a)\\1', '', 1],
    ['^$', 'm', 0],
    ['😀x', 'u', 3],
    ['[😀]x', 'u', 2],
    ['\\p{L}x', 'u', 2],
    ['\\p{0,2}x', '', 1],
    ['\\u{61}', '', 61],
    ['\\u{0}', '', 0],
    ['x{,2}', '', 5],
    ['(?s:a.c)', '', 3],
    ['a\\k<n>(?<n>b)', '', 2],
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

/**
 * [replaceString, pattern, flags, expected native template (null: the fast path does not apply)], feature list 1.1:
 * {{match}}/$0 → $&, $n → two-digit $nn when the group exists (else no template: SillyTavern reads the offset or the
 * input there), $<name> kept only with named groups, every other $ escaped.
 */
export const TEMPLATES = [
    ['$1', '(a)', '', '$01'],
    ['$12', '(a)(b)', '', null], // SillyTavern reads group 12, not group 1 and "2"
    ['$3', '(a)(b)', '', null],
    ['{{match}}', 'a', '', '$&'],
    ['{{MATCH}}x', 'a', 'g', '$&x'],
    ['$0', 'a', '', '$&'],
    ['$00', 'a', '', '$&'],
    ['$007', '(a)(b)(c)(d)(e)(f)(g)', '', '$07'],
    ['$$', 'a', '', '$$$$'],
    ['$&', 'a', '', '$$&'],
    ['$', 'a', '', '$$'],
    ['$<', '(a)', '', '$$<'],
    ['a$b', 'a', '', 'a$$b'],
    ['$<n>', '(?<n>a)', '', '$<n>'],
    ['$<zz>', '(?<n>a)', '', '$<zz>'],
    ['$<n>', '(a)', '', ''],
    ['$10', '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)', '', '$10'],
    ['$10', '(a)', '', null],
    ['$1$2', '(a)(b)?', '', '$01$02'],
    ['<b>$1</b> ${x}', '(\\w+)', 'g', '<b>$01</b> $${x}'],
];

/**
 * [pattern, flags, expected analyzeRedos().severity], feature list 1.5: nested unbounded quantifiers and unbounded
 * alternations with overlapping branches are exponential, adjacent overlapping unbounded atoms polynomial; shapes the
 * old .* heuristic flagged are not risks by themselves.
 */
export const REDOS = [
    ['(x+)+', '', 'exp'], ['(a|a)+', '', 'exp'], ['(\\w|\\d)+', '', 'exp'], ['(\\s*\\n){3,}', 'g', 'exp'], ['^(\\s*\\w+)*$', '', 'exp'],
    ['(a*)*', '', 'exp'], ['(?:ab|a)+b', '', 'exp'], ['(\\d+)+$', '', 'exp'], ['([a-z]+)*', '', 'exp'], ['(.+)+x', '', 'exp'],
    ['(?:\\s|\\t)+', '', 'exp'], ['(?:\\w+\\s?)+!', '', 'exp'], ['(a|ab)+', '', 'exp'], ['x(\\s*\\s*)*y', '', 'exp'], ['(?:a+){2,}', '', 'exp'],
    ['<(.*)*>', '', 'exp'], ['(x+x+)+y', '', 'exp'],
    ['\\s*\\s*', '', 'poly'], ['.*.*', '', 'poly'], ['[\\s\\S]*?[\\s\\S]*', '', 'poly'], ['\\w*\\w*', '', 'poly'], ['a+a+', '', 'poly'], ['[ab]*b*c', '', 'poly'],
    ['abc', '', null], ['<status>([\\s\\S]*?)<\\/status>', 'g', null], ['\\*\\*(.+?)\\*\\*', 'g', null], ['^#+ (.*)$', 'gm', null], ['[^<]*', '', null],
    ['(a|b)+', '', null], ['\\d+\\s+\\w+', '', null], ['(?:foo|bar)x', '', null], ['a+b+', '', null], ['[ \\t]+$', 'gm', null], ['(.|\\n)*', '', null],
    ['\\bOOC:\\s*(.*)$', 'gim', null], ['(?<who>\\w+) waves', 'g', null], ['<br\\s*\\/?>', 'gi', null], ['\\p{L}+-\\d+', 'u', null],
    ['x[\\s\\S]*?\\d{3}', 'g', null], ['(a+){1,5}', '', null], ['(?:ab)+', '', null], ['[\\s\\S]*', '', null], ['.*', '', null], ['(.+?)\\n', '', null],
    ['("|\')(.*?)\\1', '', null], ['\\[(.*?)\\]', 'g', null], ['(?:<summary>)([\\s\\S]*?)(?:<\\/summary>)', 'g', null], ['(?=a+)+b', '', null],
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Checks the cases; patterns this engine cannot compile (e.g. (?i:) before V8 12.5) are returned, not run. */
export function runCases(extractNeedle, buildTemplate, analyzeRedos) {
    const unsupported = [];
    if (analyzeRedos) {
        for (const [source, flags, want] of REDOS) {
            const got = analyzeRedos(source, flags).severity;
            if (got !== want) throw new Error(`analyzeRedos(/${source}/${flags}).severity = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        }
    }
    if (buildTemplate) {
        for (const [replaceString, source, flags, want] of TEMPLATES) {
            const got = buildTemplate(replaceString, new RegExp(source, flags)).template;
            if (got !== want) throw new Error(`buildTemplate(${JSON.stringify(replaceString)}, /${source}/${flags}).template = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        }
    }
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
    for (const [source, flags, want] of TERMS) {
        const got = extractNeedle(source, flags).terms;
        if (!same(got, want)) throw new Error(`extractNeedle(/${source}/${flags}).terms = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    for (const [source, flags, want] of REASONS) {
        const got = extractNeedle(source, flags).reason;
        if (got !== want) throw new Error(`extractNeedle(/${source}/${flags}).reason = ${got}, want ${want}`);
    }
    for (const [source, flags, want] of MINLEN) {
        const got = extractNeedle(source, flags).minLen;
        if (got !== want) throw new Error(`extractNeedle(/${source}/${flags}).minLen = ${got}, want ${want}`);
        let re;
        try {
            re = new RegExp(source, flags);
        } catch {
            unsupported.push(`/${source}/${flags}`);
            continue;
        }
        if (want > 0 && re.test('x'.repeat(want - 1))) throw new Error(`/${source}/${flags} matches a string shorter than ${want}`);
    }
    return { checked: CASES.length + NESTED.length + TERMS.length + REASONS.length + MINLEN.length + (buildTemplate ? TEMPLATES.length : 0) + (analyzeRedos ? REDOS.length : 0) - unsupported.length, unsupported };
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
 * @returns {{seed: number, valid: number, skips: number, matched: number, lenSkips: number, andSkips: number}}
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
    let lenSkips = 0; // skips the minimum length alone decided
    let andSkips = 0; // skips a mandatory term decided where the best needle set was present
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
        const { needles, test, minLen } = extractNeedle(source, flags);
        if (!test) continue;
        for (let k = 0; k < 30; k++) {
            const str = sample(source);
            const matches = re.test(str);
            if (matches) matched++;
            if (test(str)) continue;
            skips++;
            if (str.length < minLen) lenSkips++;
            else if (!needles || needles.some(s => str.includes(s))) andSkips++;
            if (matches) {
                throw new Error(`seed ${seed}: /${source}/${flags} has needles ${JSON.stringify(needles)} but matches ${JSON.stringify(str)} (match ${JSON.stringify(str.match(re)?.[0])})`);
            }
        }
    }
    if (skips < patterns || matched < patterns || lenSkips < patterns / 20 || andSkips < patterns / 100) {
        throw new Error(`fuzzer too weak (seed ${seed}): ${skips} skips (${lenSkips} by length, ${andSkips} by a mandatory term), ${matched} matches`);
    }
    return { seed, valid, skips, matched, lenSkips, andSkips };
}
