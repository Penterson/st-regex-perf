// Stand-in for SillyTavern's public/scripts/preset-manager.js: one API with one selected preset.
export const preset = { apiId: 'openai', name: 'Default', scripts: [] };

export function getPresetManager() {
    return {
        apiId: preset.apiId,
        getSelectedPresetName: () => preset.name,
        readPresetExtensionField: ({ path }) => (path === 'regex_scripts' ? preset.scripts : undefined),
        writePresetExtensionField: async () => { },
    };
}
