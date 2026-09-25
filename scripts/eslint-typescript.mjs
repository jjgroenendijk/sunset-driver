/**
 * ESLint's TypeScript parser and the sonarjs rules load the TypeScript compiler API by the name
 * `typescript`. The project builds with TypeScript 7, which ships no such API, so a lookup of that
 * name from inside `node_modules` is sent to the `tsapi` alias (TypeScript 5), as
 * `scripts/lint-determinism.ts` does by hand. `eslint.config.mjs` imports this first.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromPackage = context.parentURL?.includes('/node_modules/') ?? false;
    if (fromPackage && (specifier === 'typescript' || specifier.startsWith('typescript/'))) {
      return nextResolve(`tsapi${specifier.slice('typescript'.length)}`, context);
    }
    return nextResolve(specifier, context);
  },
});
