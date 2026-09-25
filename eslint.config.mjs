/**
 * The code-smell lint of issue #680: the `recommended` rules of eslint-plugin-sonarjs, the analyser
 * behind SonarQube's JavaScript and TypeScript rules, over `src`, `scripts` and `test`. Run it with
 * `npm run lint:smells`.
 *
 * The rules read types, so the parser builds the TypeScript program. A rule is turned off only
 * where it conflicts with an enforced project rule, and the exception is listed here with its
 * reason. An inline `eslint-disable` must give its reason after `--`.
 */
import './scripts/eslint-typescript.mjs';
import comments from '@eslint-community/eslint-plugin-eslint-comments';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

export default [
  // The fixtures of the determinism lint break rules on purpose.
  { ignores: ['dist/**', 'test/fixtures/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true } },
  },
  sonarjs.configs.recommended,
  {
    plugins: { '@eslint-community/eslint-comments': comments },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { '@eslint-community/eslint-comments/require-description': 'error' },
  },
];
