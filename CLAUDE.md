# Sunset Driver — working notes for agents

`spec.md` is the single source of truth. Build it top down, section by section. Read the hard vetoes in §1.2 before proposing anything.

## Commands

```
npm run dev        # Vite dev server
npm run verify     # typecheck + determinism lint + quick tests; run before every commit
npm run typecheck  # tsc --noEmit (TypeScript 7 / tsgo), ~1 s
npm run lint       # scripts/lint-determinism.ts, ~2 s
npm test           # quick tier: 20-seed sweep, simulation sweep, unit tests, ~10 s
npm run test:full  # full tier: 200-seed sweep (what CI runs), ~50 s
npm run build      # vite build → dist/
```

CI (`.github/workflows/deploy.yml`) runs typecheck, lint, `test:full`, build and deploys `dist` to Cloudflare Pages. The `build-and-deploy` check is required to merge into `main`. Changes touching only `**/*.md` or `.claude/**` skip that job, so keep docs commits separate from code commits to save a CI run. Never deploy with wrangler locally.

## Fast iteration

Development happens mainly in the Claude Code cloud environment, by Opus agents working one GitHub issue at a time. Short feedback loops and small context are what keep that productive.

- **Timing budgets.** `npm test` (quick tier) must stay under 15 s and `npm run verify` under 20 s on a laptop; `vitest.config.ts` enforces a 15 s per-test timeout for the quick tier. `npm run test:full` (CI) must stay under 2 min. If a new test pushes past these, cut its seed or tick count in the quick tier and keep the full coverage behind `SWEEP_SEEDS`.
- **Test only what changed while iterating.** `npx vitest run test/<file>.test.ts` or `-t '<name>'`; run the whole quick tier before committing. Never make a test slower to make it pass.
- **Keep tests focused.** One sweep per subsystem, asserting properties, not snapshots of large structures. Budget checks (generation time, step time) are tests too.
- **Surgical edits.** Change only the lines that need changing with Edit; never rewrite a whole file to change a few lines. Read the part of a file you need, not the whole thing. This is what keeps token use per issue small.
- **Hooks do the repetitive work.** `.claude/settings.json` wires Claude Code hooks to `scripts/hooks/`:
  - `SessionStart` → `session-start.sh`: checks the node version against `.nvmrc`, pins the repository-local git identity, and runs `npm ci` when `node_modules` is missing or older than the lockfile.
  - `PostToolUse` on Edit/Write of a `.ts` file → `post-edit.sh`: typecheck, plus the determinism lint for `src/core`, `src/sim`, `src/world`. Failures are fed back immediately.
  - `PreToolUse` on Bash → `guard-bash.sh`: blocks local `wrangler` deploys.
  Anything else that gets repeated across sessions (setup, checks, previews) belongs in a hook or a `scripts/` entry, not in prose instructions.

Cloud sessions run `bash scripts/setup-cloud.sh` as the environment's setup script, before Claude Code launches. It provisions the VM: the cloud image ships Node 20-22 only, so the script installs the `.nvmrc` version into `/opt` and puts it on `PATH`, then warms `node_modules`. Per-session dependency installs stay in the `SessionStart` hook, which runs in cloud and local sessions alike. The setup script's result is cached in a filesystem snapshot keyed on the text typed into the environment dialog, not on this file — after changing the script, re-save the setup script field at claude.ai/code to force a rebuild.

## Layout

| Path | Role | Constraints |
|---|---|---|
| `src/core/` | Hashing, seeded RNG, seed parsing, stable sort helpers | Pure; no DOM, no three.js renderer |
| `src/sim/` | Fixed-step clock, input frames, simulation state and `stepSim` | Never reads wall-clock or frame delta; plain serialisable state |
| `src/world/` | World generation → plain world description | Must run headless in Node (the sweeps import it); may use three.js math/generators; never the renderer, Rapier or DOM |
| `src/render/` | WebGPU renderer, fixed tilted camera, scene building | Reads the world description, never mutates it |
| `src/ui/` | DOM overlay: HUD, keyboard, styles | |
| `scripts/` | Build-time tooling: `lint-determinism.ts`, `world-preview.ts` (PNG map of a seed), `setup-cloud.sh` | `.ts` scripts run with plain `node` (type stripping) |
| `scripts/hooks/` | Claude Code hook scripts wired from `.claude/settings.json` | Must be fast and idempotent; exit 2 to report a problem |
| `test/` | vitest sweeps and unit tests | |

## World generation (`src/world`)

- `generateWorld(seed)` builds the whole-map skeleton: size (`size.ts`), archipelago layout and heightfield (`terrain.ts`), water description with straits crossings, and districts/zones (`districts.ts`). Chunk-level content will hang off this skeleton.
- The archipelago is a power diagram of island sites shrunk by half a channel and domain-warped, so straits bend but never close. The main site is the core at the origin.
- Terrain relief comes from three.js `TerrainGenerator` (with `valleyBias: 1`; fractional values produce NaN) at 10 m cells, reshaped per island.
- Preview a seed with `node scripts/world-preview.ts <seed> out.png` and look at the image before judging layout changes.
- The seed sweep (`test/seed-sweep.test.ts`) runs 20 seeds by default and 200 under `npm run test:full` (`SWEEP_SEEDS=200`).

## Rules the tooling enforces

- No `Math.random()` anywhere in `src/`. Randomness comes from `rngFor(seed, tick, subsystem, entityId)` in `src/core/rng.ts`. Add new subsystems at the end of the `Subsystem` table; never renumber.
- In `src/core`, `src/sim` and `src/world`: no iteration over `Set`, `Map`, iterators from them, `for-in` or `Object.keys/values/entries`. Use `sortedEntries`, `sortedMembers`, `sortedKeys` from `src/core/sort.ts`.
- Simulation time is the integer `tick` (60 Hz). One game day is 86 400 ticks (24 real minutes).
- The TypeScript compiler API for the lint script comes from the `tsapi` alias (TypeScript 5), because TypeScript 7 ships no JS API.

## Conventions

- Relative imports carry explicit `.ts` extensions so scripts and tests run under plain Node; `allowImportingTsExtensions` is on.
- Conventional Commits, one atomic change per commit. No AI attribution lines in commits or PRs: `.claude/settings.json` sets `includeCoAuthoredBy: false` and empties `attribution.commit`, `attribution.pr` and `attribution.sessionUrl`, so no co-author trailer, generated-by line or session link is appended. The same file's `env` block pins `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, and the `SessionStart` hook writes the same identity into the repository-local git config (cloud containers ship a global one of their own) and turns off commit signing unless the repository has its own key.
- Feature branches from `main`, merged through a PR once `build-and-deploy` is green. Work is tracked as GitHub issues, one PR per issue; reference the issue in the PR. Issues are numbered in spec order; each names what it builds on. Pick the lowest open issue whose prerequisites are closed, and keep the change to that issue's scope.
- Keep this file current when adding directories, scripts or enforced rules.
- three.js is used at 0.186 with `@types/three` 0.185; `TerrainGenerator`, `SkyscraperGenerator` and `SidewalkGenerator` live under `three/examples/jsm/generators/` and run headless in Node.
