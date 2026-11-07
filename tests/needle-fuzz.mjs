// extractNeedle(): hand-checked cases plus the differential fuzzer (tests/harness/needle-fuzz.js) in Node.
// The browser suite runs the same checks in Chrome. FUZZ_SEED / FUZZ_PATTERNS override the defaults.
import { register } from 'node:module';
import { CASES, fuzz, runCases } from './harness/needle-fuzz.js';

// index.js imports SillyTavern modules by relative path and reads getContext() at load: stub both.
register('data:text/javascript,' + encodeURIComponent(`
const stub = (code) => ({ url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true });
export async function resolve(specifier, context, next) {
    if (specifier.endsWith('/regex/engine.js')) return stub('export const RegexProvider = { instance: { get() {}, clear() {} } }; export const getRegexScripts = () => [];');
    if (specifier.endsWith('/utils.js')) return stub('export const regexFromString = () => undefined;');
    if (specifier.endsWith('/script.js')) return stub('export let converter; export function updateMessageBlock() {}');
    return next(specifier, context);
}`));
globalThis.SillyTavern = {
    getContext: () => ({
        extensionSettings: {},
        eventSource: { on() { } },
        event_types: {},
        getCurrentLocale: () => 'en',
        t: (strings, ...values) => strings.reduce((a, s, i) => a + s + (i < values.length ? values[i] : ''), ''),
        translate: (s) => s,
        addLocaleData() { },
    }),
};
const { extractNeedle, buildTemplate, analyzeRedos } = await import('../index.js');

const cases = runCases(extractNeedle, buildTemplate, analyzeRedos);
console.log(`  ok  ${cases.checked} hand-checked cases` + (cases.unsupported.length ? ` (${cases.unsupported.length} of ${CASES.length} need a newer V8: ${cases.unsupported.join(' ')})` : ''));

const seed = Number(process.env.FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));
const r = fuzz(extractNeedle, { seed, patterns: Number(process.env.FUZZ_PATTERNS ?? 40000) });
console.log(`  ok  fuzz seed ${r.seed}: ${r.valid} valid patterns, ${r.skips} prefilter skips (${r.lenSkips} by length, ${r.andSkips} by a mandatory term), ${r.matched} matches, no skipped match`);
