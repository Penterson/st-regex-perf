// Served for SillyTavern modules that the real files import but the tests never exercise
// (lib.js, power-user.js, secrets.js).
export const lodash = {
    set(obj, path, value) {
        let o = obj;
        path.slice(0, -1).forEach((k) => { o = (o[k] ??= {}); });
        o[path[path.length - 1]] = value;
        return obj;
    },
};
export function registerDebugFunction() { }
export function updateSecretDisplay() { }
