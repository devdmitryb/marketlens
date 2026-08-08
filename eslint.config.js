// Minimal ESLint flat config — meant to catch real bugs (undefined references,
// unreachable code) without blocking commits on style. Scoped to server *.js;
// dashboard.html is excluded (one huge vanilla-JS file full of browser globals).
'use strict';

// Node globals defined inline so this config needs no extra dependency.
const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', global: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', queueMicrotask: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly',
  fetch: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**', 'dashboard.html'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'warn',
      'no-unreachable': 'error',
    },
  },
];
