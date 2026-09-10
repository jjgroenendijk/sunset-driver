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
| `scripts/` | Build-time tooling (`lint-determinism.ts`) | Run with plain `node` (type stripping) |
| `test/` | vitest sweeps and unit tests | |

## Rules the tooling enforces

- No `Math.random()` anywhere in `src/`. Randomness comes from `rngFor(seed, tick, subsystem, entityId)` in `src/core/rng.ts`. Add new subsystems at the end of the `Subsystem` table; never renumber.
- In `src/core`, `src/sim` and `src/world`: no iteration over `Set`, `Map`, iterators from them, `for-in` or `Object.keys/values/entries`. Use `sortedEntries`, `sortedMembers`, `sortedKeys` from `src/core/sort.ts`.
- Simulation time is the integer `tick` (60 Hz). One game day is 86 400 ticks (24 real minutes).
- The TypeScript compiler API for the lint script comes from the `tsapi` alias (TypeScript 5), because TypeScript 7 ships no JS API.

## Conventions

- Conventional Commits, one atomic change per commit. No AI attribution lines in commits or PRs.
- Feature branches from `main`, merged through a PR once `build-and-deploy` is green.
- Keep this file current when adding directories, scripts or enforced rules.
- three.js is used at 0.186 with `@types/three` 0.185; `TerrainGenerator`, `SkyscraperGenerator` and `SidewalkGenerator` live under `three/examples/jsm/generators/` and run headless in Node.
