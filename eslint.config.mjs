// The lint rules for every TypeScript and JavaScript file, loaded from lint/, the linter's own install with the
// TypeScript release its type-aware rules support.

import { createRequire } from 'node:module';

import comments from './lint/comment-rules.mjs';

const lintPackages = createRequire(new URL('./lint/package.json', import.meta.url));
const { defineConfig } = lintPackages('eslint/config');
const js = lintPackages('@eslint/js');
const tseslint = lintPackages('typescript-eslint');
const prettierConfig = lintPackages('eslint-config-prettier');
const simpleImportSort = lintPackages('eslint-plugin-simple-import-sort');
const unusedImports = lintPackages('eslint-plugin-unused-imports');
const reactHooks = lintPackages('eslint-plugin-react-hooks');
const globals = lintPackages('globals');

const root = import.meta.dirname;

// No tsconfig.json of their own: tsconfig.scripts.json is the configuration that types them.
const TYPED_BY_SCRIPTS_CONFIG = ['scripts/**/*.ts', 'contracts/**/*.ts', 'vitest.config.ts'];
// Two library tests that reach into the wallet: the wallet's configuration types them.
const TYPED_BY_WALLET_CONFIG = [
  'packages/identity/src/profile/registry-open.test.tsx',
  'packages/identity/src/profile/unlock.test.ts'
];
// In no TypeScript configuration: linted without type information, so the promise rules do not reach them.
const UNTYPED = ['**/*.mjs', 'packages/identity/vitest.config.ts'];

export default defineConfig(
  {
    // A stale disable comment hides nothing but says it does.
    linterOptions: { reportUnusedDisableDirectives: 'error' }
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      // Built output, generated code and compiler output that the tests read as it was written.
      'packages/identity/lib/**',
      'contracts/managed*/**',
      'contracts/fixtures/**'
    ]
  },
  {
    // A stale disable comment for a rule this configuration does not enable, left while each test is rewritten.
    files: ['src/core/wallet-sign-in.test.ts', 'src/server/two-companies.test.ts'],
    linterOptions: { reportUnusedDisableDirectives: 'off' }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: root } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // A cast the compiler cannot check, such as one that narrows a type.
      '@typescript-eslint/no-unsafe-type-assertion': 'error'
    }
  },
  {
    files: TYPED_BY_SCRIPTS_CONFIG,
    languageOptions: {
      parserOptions: { projectService: false, project: 'tsconfig.scripts.json', tsconfigRootDir: root }
    }
  },
  {
    files: TYPED_BY_WALLET_CONFIG,
    languageOptions: {
      parserOptions: { projectService: false, project: 'apps/wallet/tsconfig.json', tsconfigRootDir: root }
    }
  },
  {
    files: UNTYPED,
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { ...tseslint.configs.disableTypeChecked.languageOptions, globals: globals.node }
  },
  {
    plugins: { 'simple-import-sort': simpleImportSort, 'unused-imports': unusedImports, comments },
    rules: {
      'comments/at-most-two-lines': 'error',
      'comments/no-dates-or-ids': 'error',
      'comments/disable-needs-reason': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-require-imports': 'error',
      // A function declaration and a type are hoisted, so using one above its line is safe; a const, a let or a
      // class read before its line throws.
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': [
        'error',
        { functions: false, classes: true, variables: true, typedefs: false }
      ],
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }]
    }
  },
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/ui/**/*.ts', 'packages/ui/**/*.tsx'],
    ...reactHooks.configs.flat.recommended,
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // A missing dependency leaves an effect reading a stale value, so it is an error, not a warning.
      'react-hooks/exhaustive-deps': 'error'
    }
  },
  prettierConfig
);
