// eslint.config.js — flat config (ESLint 9). Added Sep 29 2026 as the first
// lint gate this repo has had. Deliberately CORRECTNESS-ONLY: recommended
// rules + React hooks + React runtime checks. No stylistic rules, so
// `--fix` never reformats code and every reported error is a real defect.
import js from '@eslint/js'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/**', 'coverage/**', 'android/**', 'ios/**', '.netlify/**'] },
  js.configs.recommended,
  // ── Browser app (ESM + JSX) ───────────────────────────────────────────────
  {
    files: ['src/**/*.{js,jsx}'],
    ...react.configs.flat.recommended,
    ...react.configs.flat['jsx-runtime'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-control-regex': 'off', // sanitizers strip control chars on purpose
      'react/prop-types': 'off',          // no PropTypes in this codebase
      'react/no-unescaped-entities': 'off', // copy-heavy JSX; apostrophes are fine
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // ── Netlify functions (CommonJS, Node) ───────────────────────────────────
  {
    files: ['netlify/functions/**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Input sanitizers intentionally match \\x00-\\x1f (strip control chars);
      // the rule has no correct fix other than weakening the sanitizer.
      'no-control-regex': 'off',
    },
  },
  // 26 functions are authored as ES modules (esbuild bundles either style).
  // Generated Sep 29 2026 by grepping for top-level import/export; extend
  // this list when adding an ESM function.
  {
    files: ['netlify/functions/**/*.mjs', 'netlify/functions/_email-templates.js', 'netlify/functions/admin-billing.js', 'netlify/functions/admin-dashboard.js', 'netlify/functions/admin-stripe-setup.js', 'netlify/functions/auto-regenerate-dossiers.js', 'netlify/functions/calendar-feed.js', 'netlify/functions/cancel-at-period-end.js', 'netlify/functions/create-checkout-session.js', 'netlify/functions/create-portal-session.js', 'netlify/functions/dossier-review.js', 'netlify/functions/downgrade-to-free.js', 'netlify/functions/error-log.js', 'netlify/functions/fetch-candidate-x-feed.js', 'netlify/functions/invite-volunteer.js', 'netlify/functions/manage-coupons.js', 'netlify/functions/payment-webhook.js', 'netlify/functions/polling-snapshot-background.js', 'netlify/functions/recruit-research-background.js', 'netlify/functions/research-district-events-background.js', 'netlify/functions/research-district-history.js', 'netlify/functions/research-incumbent.js', 'netlify/functions/research-swot.js', 'netlify/functions/run-security-audit.js', 'netlify/functions/support-chat.js', 'netlify/functions/update-subscription.js', 'netlify/functions/volunteer-auth.js'],
    languageOptions: { sourceType: 'module' },
  },
  // ── Tests / scripts (Node, ESM) ──────────────────────────────────────────
  {
    files: ['tests/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', '*.mjs', '*.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
]
