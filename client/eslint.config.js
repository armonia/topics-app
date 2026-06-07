import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Honour the `_`-prefix convention the codebase already uses to mark
      // intentionally-unused bindings (props received but not consumed,
      // ignored args/destructure members, swallowed catch errors).
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'all',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      // Empty catch blocks are an intentional, pervasive pattern here
      // (best-effort cleanup paths that deliberately swallow errors).
      'no-empty': ['error', { allowEmptyCatch: true }],

      // eslint-plugin-react-hooks v6's `recommended` turns on the React
      // Compiler readiness rules as ERRORS. This project does NOT use the
      // React Compiler (no babel-plugin-react-compiler in vite.config), so
      // these flag working, intentional code. Keep the genuine correctness
      // rules strict; demote the compiler-readiness rules to warn (visible
      // tech-debt, non-blocking) and turn off the ones that are meaningless
      // without the compiler. Real issues these surface are fixed in code.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      // No compiler ⇒ "compiler can't preserve this memo" is not actionable.
      'react-hooks/preserve-manual-memoization': 'off',

      // Fast-refresh hygiene (dev-only, zero production impact). Allow the
      // common "component + constant" colocation; keep the rest as a warning
      // rather than a hard error.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
])
