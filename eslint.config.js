/**
 * @file Flat ESLint configuration for the self-codex workspace.
 * The ruleset focuses on TypeScript sources and tests without changing runtime behaviour.
 */
import path from 'node:path';
import url from 'node:url';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const projectRoot = path.dirname(url.fileURLToPath(import.meta.url));
const projectFile = path.resolve(projectRoot, 'tsconfig.eslint.json');

export default [
  {
    ignores: [
      'dist/**',
      'graph-forge/dist/**',
      'graph-forge/test/**/*.js',
      'runs/**',
      'children/**',
      'tmp/**',
      'coverage/**',
    ],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: projectFile,
        tsconfigRootDir: projectRoot,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      /**
       * Disallow `var` declarations so modern block scoping is enforced consistently.
       */
      'no-var': 'error',
      /**
       * Prefer const declarations when bindings are never reassigned.
       */
      'prefer-const': ['error', { destructuring: 'all' }],
      /**
       * Ensure promises are either awaited or intentionally handled to avoid silent failures.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      /**
       * Disable strict nullish preferences until the legacy codebase is fully migrated.
       */
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      /**
       * Tests commonly use unused expressions to express assertions.
       */
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
];
