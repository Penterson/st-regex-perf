// Boots a SillyTavern-like page: real i18n, events, regex engine and message formatter, a getContext() built from
// the stand-ins, then the extension variant named in ?variant= (none | baseline | st-regex-perf).
// Options: ?locale=ko-kr (UI language), ?hooks=0 (no MessageFormatter, like older SillyTavern), ?settings=<json>.
const params = new URLSearchParams(location.search);
const variant = params.get('variant') ?? 'none';
localStorage.setItem('language', params.get('locale') ?? 'en');

const st = await import('/script.js');
const { extension_settings } = await import('/scripts/extensions.js');
const { preset } = await import('/scripts/preset-manager.js');
const { eventSource, event_types } = await import('/scripts/events.js');
const { MessageFormatter } = await import('/scripts/message-formatter.js');
const engine = await import('/scripts/extensions/regex/engine.js');
const i18n = await import('/scripts/i18n.js');
await i18n.initLocales();

const toasts = [];
globalThis.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(k => [k, (msg) => { toasts.push([k, String(msg)]); }]));
const commands = {};
const popups = [];
const calls = { getContext: 0 };
const hooks = params.get('hooks') !== '0';

globalThis.SillyTavern = {
    getContext() {
        calls.getContext++;
        return {
            chat: st.chat,
            characters: st.characters,
            characterId: st.this_chid,
            name1: st.name1,
            name2: st.name2,
            streamingProcessor: st.streamingProcessor,
            eventSource,
            eventTypes: event_types,
            event_types,
            extensionSettings: extension_settings,
            saveSettingsDebounced: st.saveSettingsDebounced,
            saveChat: st.saveChatConditional,
            substituteParams: st.substituteParams,
            substituteParamsExtended: st.substituteParamsExtended,
            messageFormatting: st.messageFormatting,
            messageFormatter: hooks ? MessageFormatter : undefined,
            SlashCommandParser: { addCommandObject: (cmd) => { commands[cmd.name] = cmd; } },
            SlashCommand: { fromProps: (props) => props },
            SlashCommandArgument: { fromProps: (props) => props },
            ARGUMENT_TYPE: { STRING: 'string' },
            callGenericPopup: async (content, type) => { popups.push({ content, type }); return 1; },
            POPUP_TYPE: { TEXT: 1, CONFIRM: 2 },
            t: i18n.t,
            translate: i18n.translate,
            getCurrentLocale: i18n.getCurrentLocale,
            addLocaleData: i18n.addLocaleData,
        };
    },
};

// ?settings=<json>: what the user had saved before the extension loads
if (params.get('settings')) extension_settings.regex_perf_kit = JSON.parse(params.get('settings'));
if (variant !== 'none') await import(`/scripts/extensions/third-party/${variant}/index.js`);
await eventSource.emit(event_types.APP_READY);

const h = { variant, st, engine, extension_settings, preset, eventSource, event_types, MessageFormatter, i18n, toasts, commands, popups, calls };
window.__run = async (name, arg) => (await import('/harness/scenarios.js'))[name](h, arg);
window.__ready = true;
