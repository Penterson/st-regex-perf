// Stand-in for SillyTavern's public/script.js with only what the regex engine, the message formatter and
// Regex Perf Kit touch. The body of messageFormatting() up to its regex stage is SillyTavern's own code,
// spliced in at the marker below by tests/server.mjs from the pinned script.js.
/* eslint-disable no-unused-vars -- the names below are used by the spliced code */
import { getRegexedString, regex_placement } from './scripts/extensions/regex/engine.js';
import { MessageFormatter } from './scripts/message-formatter.js';

export let chat = [];
export let characters = [];
export let this_chid;
export let name1 = 'User';
export let name2 = 'Char';
export let streamingProcessor = null;
export const power_user = { user_prompt_bias: '', show_user_prompt_bias: true };
const COMMENT_NAME_DEFAULT = 'Note';
const systemUserName = 'SillyTavern System';
let mesForShowdownParse; // written by the spliced code

/** Replaces module state; the bindings above are live for every importer. */
export function setState(patch) {
    if ('chat' in patch) chat = patch.chat;
    if ('characters' in patch) characters = patch.characters;
    if ('this_chid' in patch) this_chid = patch.this_chid;
    if ('name1' in patch) name1 = patch.name1;
    if ('name2' in patch) name2 = patch.name2;
    if ('streamingProcessor' in patch) streamingProcessor = patch.streamingProcessor;
}

export const counters = { saveSettings: 0, saveChat: 0 };
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
