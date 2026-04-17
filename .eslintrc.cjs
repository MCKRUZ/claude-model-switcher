/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    'src/dashboard/frontend/',
    '*.cjs',
    '*.config.ts',
    '*.config.js',
  ],
  rules: {
    'max-depth': ['error', 4],
    'no-console': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      files: ['src/**/*.ts'],
      rules: {
        'max-lines': [
          'error',
          { max: 400, skipBlankLines: true, skipComments: true },
        ],
        'max-lines-per-function': [
          'error',
          {
            max: 50,
            skipBlankLines: true,
            skipComments: true,
            IIFEs: true,
          },
        ],
      },
    },
    {
      files: ['tests/**/*.ts'],
      rules: {
        'max-lines-per-function': ['error', { max: 200 }],
        'no-console': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
