import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // test/e2e/app is a plain-JS Next app the e2e test builds and runs; Next owns its conventions.
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'cdk.out/**', 'test/e2e/app/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' },
  },
);
