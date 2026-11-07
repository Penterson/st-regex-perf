// Stand-in for SillyTavern's public/script.js with only what the regex engine, the message formatter and
// Regex Perf Kit touch. The whole body of messageFormatting() is SillyTavern's own code, spliced in at the marker
// below by tests/server.mjs from the pinned script.js; the markdown converter and DOMPurify it calls are stand-ins
// here (see converter / DOMPurify), counted so a test can tell whether the markdown stage ran.
/* eslint-disable no-unused-vars -- the names below are used by the spliced code */
import { getRegexedString, regex_placement } from './scripts/extensions/regex/engine.js';
import { MessageFormatter } from './scripts/message-formatter.js';

export let chat = [];
export let characters = [];
export let this_chid;
export let name1 = 'User';
export let name2 = 'Char';
export let streamingProcessor = null;
export let chatId = 'harness-' + Math.random().toString(36).slice(2); // a chat of its own per page, so ⑤'s IndexedDB rows never cross between tests
export let groupId;
export const power_user = {
    user_prompt_bias: '', show_user_prompt_bias: true,
    auto_fix_generated_markdown: false, encode_tags: false, allow_name2_display: true,
    reasoning: { prefix: '', suffix: '' },
    markdown_escape_strings: '',
};
const COMMENT_NAME_DEFAULT = 'Note';
const systemUserName = 'SillyTavern System';
export let mesForShowdownParse; // written by the spliced code

// ---- The rest of the display pipeline, as stand-ins ----
export const counters = { saveSettings: 0, saveChat: 0, makeHtml: 0, sanitize: 0, converterChars: 0, sanitizeChars: 0 };
/**
 * The markdown converter: the identity by default (so tests can assert on the text), or, with setConverter('para'),
 * a small paragraph/bold converter whose cost grows with the input, for the benchmarks; 'numbered' is 'para' with each
 * paragraph numbered, so a conversion depends on the whole text (what the ④ paragraph cache's self-check must catch).
 */
let converterMode = 'identity';
const PARA_PASSES = [
    [/\*\*(.+?)\*\*/g, '<b>$1</b>'], [/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1<i>$2</i>'], [/`([^`]+)`/g, '<code>$1</code>'],
    [/^#{1,6} (.*)$/gm, '<h4>$1</h4>'], [/^> (.*)$/gm, '<blockquote>$1</blockquote>'], [/^[-*] (.*)$/gm, '<li>$1</li>'],
    [/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'], [/~~(.+?)~~/g, '<s>$1</s>'], [/__(.+?)__/g, '<u>$1</u>'],
    [/(https?:\/\/\S+)/g, '<a href="$1">$1</a>'], [/:\w+:/g, '☺'], [/[ \t]+$/gm, ''], // trailing spaces per line (\s would eat the blank line between paragraphs)
];
export function setConverter(mode) { converterMode = mode; }
/** The shape of showdown: a Converter class whose prototype carries makeHtml(), reachable as SillyTavern.libs.showdown. */
export class Converter {
    makeHtml(s) {
        counters.makeHtml++;
        counters.converterChars += s.length;
        if (converterMode === 'identity') return s;
        // a handful of passes over the text, as a markdown converter makes (showdown runs dozens)
        let out = s;
        for (let k = 0; k < 64; k++) for (const [re, rep] of PARA_PASSES) out = out.replace(re, rep);
        return out.split(/\n{2,}/).map((p, i) => `<p${converterMode === 'numbered' ? ` data-n="${i}"` : ''}>` + p.replace(/\n/g, '<br>') + '</p>').join('\n');
    }
}
export const showdown = { Converter };
const converter = new Converter();
/** DOMPurify stand-in: the same object SillyTavern.libs.DOMPurify points at, so the extension can wrap sanitize(). */
export const DOMPurify = {
    sanitize(s, config) {
        counters.sanitize++;
        counters.sanitizeChars += String(s).length;
        return String(s).replace(/<script[\s\S]*?<\/script>/gi, '');
    },
};
const fixMarkdown = (s) => s;
const canUseNegativeLookbehind = () => true;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);
const escapeRegex = (s) => s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
const encodeStyleTags = (s) => s;
const decodeStyleTags = (s) => s;

/** Replaces module state; the bindings above are live for every importer. */
export function setState(patch) {
    if ('chat' in patch) chat = patch.chat;
    if ('characters' in patch) characters = patch.characters;
    if ('this_chid' in patch) this_chid = patch.this_chid;
    if ('name1' in patch) name1 = patch.name1;
    if ('name2' in patch) name2 = patch.name2;
    if ('streamingProcessor' in patch) streamingProcessor = patch.streamingProcessor;
    if ('chatId' in patch) chatId = patch.chatId;
    if ('groupId' in patch) groupId = patch.groupId;
}

export function saveSettingsDebounced() { counters.saveSettings++; }
export async function saveChatConditional() { counters.saveChat++; }

let rolls = 0;
/** Restarts the {{random}} sequence. */
export function reseed() { rolls = 0; }
const LEGACY = { user: 'user', bot: 'char', char: 'char', group: 'char', charifnotgroup: 'char' };

/**
 * A small macro engine with the properties that matter here: names come from the current state, legacy <USER>
 * markers are honored, {{random::a::b}} gives a different value on every evaluation, unknown macros stay as-is
 * and postProcessFn sees each substituted value (substitute_find_regex.ESCAPED relies on that).
 * Accepts both call forms SillyTavern uses: (content, options) and the legacy (content, name1, name2).
 */
export function substituteParams(content, options = {}) {
    if (!content) return '';
    const o = options && typeof options === 'object' ? options : { name1Override: arguments[1], name2Override: arguments[2] };
    const env = { user: o.name1Override ?? name1, char: o.name2Override ?? name2, ...o.dynamicMacros };
    const post = typeof o.postProcessFn === 'function' ? o.postProcessFn : (x) => x;
    return String(content).replace(/<(USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>|{{([^{}]*)}}/gi, (m, legacy, body) => {
        if (legacy) return post(String(env[LEGACY[legacy.toLowerCase()]]));
        const [name, ...args] = body.split('::');
        const key = name.trim();
        if (/^random$/i.test(key)) return post(args.length ? args[rolls++ % args.length] : String(rolls++));
        if (/^slow$/i.test(key)) { // test-only: a macro that takes 2 ms
            const end = performance.now() + 2;
            while (performance.now() < end) { /* busy */ }
            return '';
        }
        const envKey = Object.keys(env).find(k => k.toLowerCase() === key.toLowerCase());
        if (envKey === undefined) return m;
        const value = env[envKey];
        return post(String(typeof value === 'function' ? value() : value));
    });
}

export function substituteParamsExtended(content, additionalMacro = {}, postProcessFn = (x) => x) {
    return substituteParams(content, { dynamicMacros: additionalMacro, postProcessFn });
}

/* @messageFormatting */
