'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'indent': ['error', 2, { SwitchCase: 1 }],
      // Rules newly added to eslint:recommended in modern ESLint that
      // flag pre-existing stylistic patterns. Surfaced as warnings so
      // they stay visible without blocking the build; clean up over time.
      'no-useless-assignment': 'warn',
      'no-unassigned-vars': 'warn',
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
  },
];
