# Sunset Driver — working notes for agents

A top-down open-world crime game for the browser: WebGPU render, Rapier physics, Tone.js audio, everything generated from a seed.

`spec.md` is the single source of truth. Build it top down, section by section, and read the hard vetoes in section 1.2 before proposing anything. Work is tracked as GitHub issues numbered in spec order; take the lowest open issue whose prerequisites are closed and keep the change to that issue's scope.

Run `npm run verify` (typecheck + determinism lint + quick tests, under 20 s) before every commit. CI runs the same checks with `test:full` and deploys `dist` to Cloudflare Pages; `build-and-deploy` is required to merge. Commits touching only `**/*.md` or `.claude/**` skip that job, so keep docs commits separate from code commits.

## Determinism

The whole game is a pure function of its seed, so the tooling enforces:

- No `Math.random()` in `src/`. Randomness comes from `rngFor(seed, tick, subsystem, entityId)` in `src/core/rng.ts`. Add new subsystems at the end of the `Subsystem` table; never renumber.
- In `src/core`, `src/sim` and `src/world`: no iteration over `Set`, `Map`, iterators from them, `for-in` or `Object.keys/values/entries`. Use `sortedEntries`, `sortedMembers`, `sortedKeys` from `src/core/sort.ts`.
- Simulation time is the integer `tick` (60 Hz); one game day is 86 400 ticks (24 real minutes). Nothing in `src/sim` may read wall-clock or frame delta.

## Directory constraints

Beyond what the file names suggest:

- `src/core` — pure; no DOM, no three.js renderer.
- `src/sim` — plain serialisable state; no wall-clock, no frame delta.
- `src/world` — must run headless in Node, since the sweeps import it. three.js math and generators are fine; the renderer, Rapier and the DOM are not. Produces a plain world description.
- `src/render` — reads the world description, never mutates it.
- `scripts/*.ts` — run with plain `node` (type stripping), not through Vite.
- `scripts/hooks/` — Claude Code hooks wired from `.claude/settings.json`; fast, idempotent, exit 2 to report a problem. Anything repeated across sessions belongs in a hook or a `scripts/` entry rather than in prose here.

## Performance budgets

`test/budgets.ts` holds the budget table and `test/budget.test.ts` enforces it, so a budget moves in one place. An enforced number is what the code spends today plus room for a slow runner, not the spec section 2.4 slice it will grow into. **A budget failure is a regression to find, never a threshold to bump.** Raise a budget only together with the system that spends it, never past its slice.

The same applies to test timing: `npm test` must stay under 15 s and `npm run test:full` under 2 min. Cut seeds or ticks in the quick tier and keep full coverage behind `SWEEP_SEEDS` — never make a test slower to make it pass.

## World generation gotchas

- `generateWorld(seed)` builds the whole-map skeleton; chunk-level content will hang off it. The archipelago is a power diagram of island sites shrunk by half a channel and domain-warped, so straits bend but never close. The main site is the core at the origin.
- three.js `TerrainGenerator` needs `valleyBias: 1`; fractional values produce NaN.
- `buildTensorField(world)` (`tensor.ts`) is the seeded field road direction follows (spec section 6.1). Influences blend as tensors, so ones facing opposite ways reinforce instead of cancelling; `sample(x, y)` returns both directions and a `strength` saying how decided the field is, and `majorAt(x, y)` is the allocation-free hot path.
- Look at the image before judging a layout change: `node scripts/world-preview.ts <seed> out.png`. It strokes the field's major direction, dark where the field is decided and pale where influences cancel.
- `test/seed-sweep.test.ts` runs 20 seeds, or 200 under `SWEEP_SEEDS=200`.

## Conventions

- Relative imports carry explicit `.ts` extensions (`allowImportingTsExtensions` is on) so scripts and tests run under plain Node.
- The lint script's TypeScript compiler API comes from the `tsapi` alias (TypeScript 5), because the TypeScript 7 the project builds with ships no JS API.
- three.js 0.186 with `@types/three` 0.185. `TerrainGenerator`, `SkyscraperGenerator` and `SidewalkGenerator` live under `three/examples/jsm/generators/` and run headless in Node.
- Conventional Commits, one atomic change per commit, feature branches from `main`, one PR per issue referencing that issue.
- Never deploy with wrangler locally; `scripts/hooks/guard-bash.sh` blocks it.
- Cloud sessions run `bash scripts/setup-cloud.sh` as the environment setup script. Its result is cached in a snapshot keyed on the text typed into the environment dialog, not on the script — after changing it, re-save the setup script field at claude.ai/code to force a rebuild.

## Writing

Prose here, in `spec.md`, in `docs/`, in commit messages and in PR bodies is read by non-native English speakers. Write for them: short sentences, plain words, one idea per sentence, the subject up front. No idioms, no wordplay, no cleverness that a reader has to decode.

Effortless to read is not the same as long. Aim for the highest information per word: every sentence carries something the reader did not already know, and nothing restates the sentence before it. Cut a qualifier before you add one. When a sentence needs two readings, the fix is to split it, not to add an explanation.

## Keeping this file current

Update this file whenever a directory, enforced rule or non-obvious gotcha changes. `docs/claude-md.md` says what belongs here and what does not — read it before adding a section.
