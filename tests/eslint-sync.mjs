// Fails when .eslintrc.cjs drifts from SillyTavern's own (.eslintrc.cjs at the pinned commit): same base config,
// plugins and rules, and the settings SillyTavern uses for its browser code (public/**/*.js).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fetchSt, ST_DIR } from './fetch-st.mjs';

await fetchSt();
const require = createRequire(import.meta.url);
const ours = require('../.eslintrc.cjs');
const theirs = require(join(ST_DIR, '.eslintrc.cjs'));

assert.deepEqual(ours.extends, theirs.extends, 'extends');
assert.deepEqual(ours.plugins, theirs.plugins, 'plugins');
assert.deepEqual(ours.rules, theirs.rules, 'rules');
assert.deepEqual(ours.parserOptions, { ...theirs.parserOptions, sourceType: 'module' }, 'parserOptions');
const browser = theirs.overrides.find(o => o.files.includes('public/**/*.js'));
for (const [key, on] of Object.entries(browser.env)) assert.equal(ours.env[key], on, `env.${key}`);
for (const name of ['globalThis', 'toastr', 'SillyTavern']) assert.equal(ours.globals[name], browser.globals[name], `globals.${name}`);
console.log(`  ok  ESLint config matches SillyTavern's (${Object.keys(ours.rules).length} rules)`);
