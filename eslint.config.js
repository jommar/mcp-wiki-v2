import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },

    rules: {
      // ─── Errors ────────────────────────────────────────────────────────
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',

      // ─── Best Practices ────────────────────────────────────────────────
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-return-await': 'error',
      'no-throw-literal': 'error',
      'require-await': 'error',

      // ─── Style ─────────────────────────────────────────────────────────
      'no-trailing-spaces': 'error',
      'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
      'eol-last': ['error', 'always'],
    },

    ignores: ['node_modules/', 'logs/', 'export/', 'migration-staging/'],
  },
];
