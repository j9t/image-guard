import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'media/'
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      globals: globals.node
    },
    rules: {
      'no-console': 'off', // CLI tool—allow console
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      curly: ['warn', 'multi-line']
    }
  }
]