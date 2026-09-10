# Sunset Driver — working notes for agents

`spec.md` is the single source of truth. Build it top down, section by section. Read the hard vetoes in §1.2 before proposing anything.

## Commands

```
npm run dev        # Vite dev server
npm run verify     # typecheck + determinism lint + tests; run before every commit
npm run typecheck  # tsc --noEmit (TypeScript 7 / tsgo)
npm run lint       # scripts/lint-determinism.ts
npm test           # vitest: seed sweep, simulation sweep, unit tests
npm run build      # vite build → dist/
```

CI (`.github/workflows/deploy.yml`) runs typecheck, lint, test, build and deploys `dist` to Cloudflare Pages. The `build-and-deploy` check is required to merge into `main`. Never deploy with wrangler locally.

## Layout

| Path | Role | Constraints |
|---|---|---|
| `src/core/` | Hashing, seeded RNG, seed parsing, stable sort helpers | Pure; no DOM, no three.js renderer |
| `src/sim/` | Fixed-step clock, input frames, simulation state and `stepSim` | Never reads wall-clock or frame delta; plain serialisable state |
| `src/world/` | World generation → plain world description | Must run headless in Node (the sweeps import it); may use three.js math/generators; never the renderer, Rapier or DOM |
| `src/render/` | WebGPU renderer, fixed tilted camera, scene building | Reads the world description, never mutates it |
| `src/ui/` | DOM overlay: HUD, keyboard, styles | |
| `scripts/` | Build-time tooling: `lint-determinism.ts`, `world-preview.ts` (PNG map of a seed) | Run with plain `node` (type stripping) |
| `test/` | vitest sweeps and unit tests | |

## World generation (`src/world`)

- `generateWorld(seed)` builds the whole-map skeleton: size (`size.ts`), archipelago layout and heightfield (`terrain.ts`), water description with straits crossings, and districts/zones (`districts.ts`). Chunk-level content will hang off this skeleton.
- The archipelago is a power diagram of island sites shrunk by half a channel and domain-warped, so straits bend but never close. The main site is the core at the origin.
- Terrain relief comes from three.js `TerrainGenerator` (with `valleyBias: 1`; fractional values produce NaN) at 10 m cells, reshaped per island.
- Preview a seed with `node scripts/world-preview.ts <seed> out.png` and look at the image before judging layout changes.
- The seed sweep (`test/seed-sweep.test.ts`) runs 200 seeds by default; `SWEEP_SEEDS=20 npm test` for a quick pass.

## Rules the tooling enforces

- No `Math.random()` anywhere in `src/`. Randomness comes from `rngFor(seed, tick, subsystem, entityId)` in `src/core/rng.ts`. Add new subsystems at the end of the `Subsystem` table; never renumber.
- In `src/core`, `src/sim` and `src/world`: no iteration over `Set`, `Map`, iterators from them, `for-in` or `Object.keys/values/entries`. Use `sortedEntries`, `sortedMembers`, `sortedKeys` from `src/core/sort.ts`.
- Simulation time is the integer `tick` (60 Hz). One game day is 86 400 ticks (24 real minutes).
- The TypeScript compiler API for the lint script comes from the `tsapi` alias (TypeScript 5), because TypeScript 7 ships no JS API.

## Conventions

- Relative imports carry explicit `.ts` extensions so scripts and tests run under plain Node; `allowImportingTsExtensions` is on.
- Conventional Commits, one atomic change per commit. No AI attribution lines in commits or PRs.
- Feature branches from `main`, merged through a PR once `build-and-deploy` is green.
- Keep this file current when adding directories, scripts or enforced rules.
- three.js is used at 0.186 with `@types/three` 0.185; `TerrainGenerator`, `SkyscraperGenerator` and `SidewalkGenerator` live under `three/examples/jsm/generators/` and run headless in Node.
