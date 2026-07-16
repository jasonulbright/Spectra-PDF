import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Flat config (ESLint 10). The renderer is browser-targeted TypeScript/React.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', '**/*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Advisory style rules — reported as warnings, not build-breaking errors.
      '@typescript-eslint/no-explicit-any': 'warn',
      // ignoreRestSiblings exempts ONLY the `{ [k]: _omitted, ...rest }`
      // destructure-omit idiom, not unused variables in general.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
);
