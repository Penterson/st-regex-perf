// SillyTavern's ESLint setup (.eslintrc.cjs of the commits pinned in tests/st-version.json): the same base,
// plugin and rules, with its browser-side settings (public/**/*.js) for the extension itself.
// `npm run test:eslint-sync` fails when the rules below drift from SillyTavern's.
module.exports = {
    root: true,
    extends: [
        'eslint:recommended',
    ],
    plugins: [
        'jsdoc',
    ],
    env: {
        es6: true,
        browser: true,
        jquery: true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
    globals: {
        globalThis: 'readonly',
        toastr: 'readonly',
        SillyTavern: 'readonly',
    },
    overrides: [
        {
            // Test tooling runs in Node; its harness pages run in the browser.
            files: ['tests/**/*.mjs', 'tests/**/*.js'],
            env: {
                node: true,
            },
        },
        {
            files: ['*.cjs'],
            parserOptions: {
                sourceType: 'commonjs',
            },
            env: {
                node: true,
            },
        },
    ],
    ignorePatterns: [
        '**/node_modules/**',
        'tests/.st/**',
        'tests/.out/**',
    ],
    rules: {
        'jsdoc/no-undefined-types': ['warn', { disableReporting: true, markVariablesAsUsed: true }],
        'no-unused-vars': ['error', { args: 'none' }],
        'no-control-regex': 'off',
        'no-constant-condition': ['error', { checkLoops: false }],
        'require-yield': 'off',
        'quotes': ['error', 'single'],
        'semi': ['error', 'always'],
        'indent': ['error', 4, { SwitchCase: 1, FunctionDeclaration: { parameters: 'first' } }],
        'comma-dangle': ['error', 'always-multiline'],
        'eol-last': ['error', 'always'],
        'no-trailing-spaces': 'error',
        'object-curly-spacing': ['error', 'always'],
        'space-infix-ops': 'error',
        'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
        'no-cond-assign': 'error',
        'no-unneeded-ternary': 'error',
        'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
        'dot-notation': ['error', { 'allowPattern': '[A-Z]\\w*$' }],
        // These rules should eventually be enabled.
        'no-async-promise-executor': 'off',
        'no-inner-declarations': 'off',
        // Additional formatting rules based on codebase conventions
        'brace-style': ['error', '1tbs', { allowSingleLine: true }],
        'array-bracket-spacing': ['error', 'never'],
        'computed-property-spacing': ['error', 'never'],
        'block-spacing': ['error', 'always'],
        'keyword-spacing': ['error', { before: true, after: true }],
        'space-before-blocks': ['error', 'always'],
        'space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
        'space-in-parens': ['error', 'never'],
        'comma-spacing': ['error', { before: false, after: true }],
        'key-spacing': ['error', { beforeColon: false, afterColon: true }],
        'func-call-spacing': ['error', 'never'],
        'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1, maxBOF: 0 }],
        'padded-blocks': ['error', 'never'],
        'no-whitespace-before-property': 'error',
        'space-unary-ops': ['error', { words: true, nonwords: false }],
        'arrow-spacing': ['error', { before: true, after: true }],
        'template-curly-spacing': ['error', 'never'],
        'rest-spread-spacing': ['error', 'never'],
        'generator-star-spacing': ['error', { before: false, after: true }],
        'yield-star-spacing': ['error', { before: false, after: true }],
        'template-tag-spacing': ['error', 'never'],
        'switch-colon-spacing': ['error', { after: true, before: false }],
    },
};
