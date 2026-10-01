import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    // Un `eslint-disable` che non disabilita niente è un ERRORE, non un avviso
    // (il default di ESLint 9 è `warn`, e un avviso in mezzo ad altri passa).
    // Il caso concreto: `-next-line` silenzia LA RIGA SEGUENTE, quindi bastava
    // scrivere la motivazione sotto la direttiva invece che sopra perché il suo
    // bersaglio diventasse il commento e il codice tornasse scoperto. Il file
    // continua a sembrare protetto — è la forma peggiore di regressione. Con
    // `error` la direttiva orfana ferma la build nel momento in cui nasce.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
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

      // react-hooks v6 `recommended` enables the React Compiler readiness
      // rules. This project does NOT use the React Compiler (no
      // babel-plugin-react-compiler in vite.config). The rules are kept
      // ENFORCED (error); every site has been reviewed and either fixed or
      // resolved with a per-line eslint-disable carrying a reason. The single
      // exception is preserve-manual-memoization: "the compiler can't preserve
      // this memo" is not actionable without the compiler, so it's off.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn', // recommended default
      'react-hooks/refs': 'error',
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/static-components': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/preserve-manual-memoization': 'off',

      // Fast-refresh hygiene (dev-only, zero production impact). Allow the
      // common "component + constant" colocation.
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    // The server side: server/, shared/ and server.ts, linted from the repo
    // root by `bun run lint:server` (scripts/lint.ts), which passes this file
    // with --config, so these globs are relative to the root. The client's own
    // `eslint .` runs inside client/ and never matches them.
    files: ['server/**/*.ts', 'shared/**/*.ts', 'server.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // `any` here is governed by check:any (files that must stay at zero) and
      // check:any-budget (the ratchet on the total), not by eslint: two gates
      // with two different answers for the same line is how one gets muted.
      '@typescript-eslint/no-explicit-any': 'off',
      // A `let` that a closure reads before its one assignment (a `settle`
      // that clears a timer armed later, a service the earlier handlers call
      // once boot has created it) cannot become `const` where it stands: moved
      // down it throws in the temporal dead zone on the path that runs first.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
])
