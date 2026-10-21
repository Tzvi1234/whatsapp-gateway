import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';

/**
 * Architecture boundaries (CODE-STRUCTURE.md §2, TEST-PLAN S12):
 *  - core depends on nothing internal
 *  - policy, relay, automations depend only on core
 *  - providers/* depend on core; providers/baileys only importable by apps/worker (and the spike)
 *  - mcp depends on core + policy, never on a provider
 *  - nothing imports apps/* or spikes/*
 */
const allow = (from, to) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: to } } } },
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.claude/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'docs/**',
      '**/next-env.d.ts',
      'services/transcriber/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use string-literal unions, not TS enums.' },
        {
          selector: "CallExpression[callee.name='useMultiFileAuthState']",
          message: 'useMultiFileAuthState is dev-only; use the encrypted SessionStore.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'baileys',
              importNames: ['useMultiFileAuthState'],
              message: 'useMultiFileAuthState is banned (C13).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['{apps,packages,spikes}/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['{apps,packages,spikes}/**/*'],
      'boundaries/elements': [
        { type: 'app-worker', pattern: 'apps/worker' },
        { type: 'app-web', pattern: 'apps/web' },
        { type: 'spike', pattern: 'spikes/*' },
        { type: 'provider-baileys', pattern: 'packages/providers/baileys' },
        { type: 'provider-cloud', pattern: 'packages/providers/cloud' },
        { type: 'core', pattern: 'packages/core' },
        { type: 'policy', pattern: 'packages/policy' },
        { type: 'relay', pattern: 'packages/relay' },
        { type: 'automations', pattern: 'packages/automations' },
        { type: 'mcp', pattern: 'packages/mcp' },
      ],
      'import/resolver': {
        typescript: {
          project: ['apps/*/tsconfig.json', 'packages/**/tsconfig.json', 'spikes/*/tsconfig.json'],
          noWarnOnMultipleProjects: true,
        },
        node: true,
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            allow('core', ['core']),
            allow('policy', ['core', 'policy']),
            allow('relay', ['core', 'relay']),
            allow('automations', ['core', 'automations']),
            allow('provider-cloud', ['core', 'provider-cloud']),
            allow('provider-baileys', ['core', 'provider-baileys']),
            allow('mcp', ['core', 'policy', 'mcp']),
            allow('app-worker', [
              'app-worker',
              'core',
              'policy',
              'relay',
              'automations',
              'provider-baileys',
            ]),
            allow('app-web', [
              'app-web',
              'core',
              'policy',
              'relay',
              'automations',
              'mcp',
              'provider-cloud',
            ]),
            allow('spike', ['spike', 'core', 'provider-baileys']),
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
