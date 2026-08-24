import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Operator CLIs in apps/api/scripts/ — stdout IS their output surface, so
    // the no-console rule (right for server code, where logs go through pino
    // and must never carry PII) is noise here. Everything else still applies:
    // these scripts call into src/services/*, including money movement.
    files: ['apps/api/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Customer-facing copy carries no em dashes. They read as an "AI tell",
    // and since new copy here is often AI-drafted, the ban needs a guard
    // rather than a habit. Scoped to the copy tables ONLY: comments, docs,
    // and server/log strings elsewhere are untouched by this rule.
    //
    // The `ops` namespaces inside translations.ts are operator jargon, not
    // consumer copy, and are fenced off with eslint-disable in the file.
    files: [
      'packages/shared/src/i18n/translations.ts',
      'apps/web/components/legal/content.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\u2014/]',
          message:
            'No em dashes in customer-facing copy. Use a period when both halves are full sentences, a comma for a trailing qualifier, or parentheses around a list.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\u2014/]',
          message:
            'No em dashes in customer-facing copy. Use a period when both halves are full sentences, a comma for a trailing qualifier, or parentheses around a list.',
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '.expo/'],
  },
]
