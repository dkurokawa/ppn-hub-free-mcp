import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.wrangler/**',
      'coverage/**',
      'scripts/**',
      'allowlist.json',
      // Config files outside the tsconfig.json "include" (src/**, test/**) —
      // typed linting needs a project that covers the file being linted.
      'eslint.config.js',
      'vitest.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript's own checker (with the ambient Workers globals from
      // @cloudflare/workers-types) already catches undefined identifiers;
      // ESLint's no-undef has no visibility into those and false-positives.
      'no-undef': 'off',
      // Numbers show up in template literals all over (thresholds, counts) —
      // they stringify predictably, unlike objects, so allow them.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // A single-generic-parameter get<T>(key): Promise<T | undefined> style
      // (mirrors DurableObjectStorage/KVNamespace) is intentional here, not
      // an oversight — callers rely on it to type the result at the call site.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    // Tests parse untyped JSON.parse() output and poke at internals — the
    // unsafe-* rules would otherwise flag nearly every assertion.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
