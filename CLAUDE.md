# Sunset Driver — working notes for agents

A top-down open-world crime game for the browser: WebGPU render, Rapier physics, Tone.js audio,
everything generated from a seed.

`spec.md` is the single source of truth. Build it top down, section by section, and read the hard
vetoes in section 1.2 before proposing anything. Work is tracked as GitHub issues numbered in spec
order. When you find a pre-existing problem outside the scope of the issue you are on — a bug, a
wrong number, a stale comment, a missing test — open a GitHub issue for it and carry on. The issue
is the deliverable; a note in a PR body or a `TODO` in the code is not.

## Tests

Tests run on your machine, not in CI. The commands:

- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — the determinism lint. `npm run lint:size` — the file-size lint.
- `npm test` — the quick tier. `npm run test:full` — the full tier of 200 seeds (`SWEEP_SEEDS=200`).
- `npm run verify` — typecheck, both lints and the quick tier, under 20 s. Run before every commit.
- `npm run verify:full` — the same with the full tier, about 2 min. Run it before a pull request
  that changes `src/world` or `src/sim`.

`ci.yml` calls the reusable `build.yml` and deploys in a separate job. A pull request only
typechecks, lints and builds; `ci-passed` is the check required to merge. A push to main builds and
deploys `dist` to Cloudflare Pages. Commits touching only `**/*.md` or `.claude/**` skip the build,
so keep docs commits separate from code commits. Each night `nightly.yml` runs `verify:full` on main
plus the day's Dependabot updates, merges the updates when it passes, and opens a `nightly-failure`
issue when it fails.

`npm test` must stay under 15 s and `npm run test:full` under 2 min. Cut seeds or ticks in the quick
tier and keep full coverage behind `SWEEP_SEEDS` — never make a test slower to make it pass. Both
ceilings are wall clock, which is the work divided by the cores it runs on, so compare the
CPU-seconds `time npm test` prints and never one machine's wall clock against another's.
`docs/performance.md` has the measurements and where a sweep spends its time.

## The docs

One doc per subsystem, read when the work touches it. Each holds the gotchas that file's directory
costs a session, and only those.

- `docs/dev-tooling.md` — the free camera, the world preview, the render preview and the frame
  profiler. Look at the image before judging a layout change, the frame before judging a rendering
  change, and the frame times before judging a performance change.
- `docs/world-generation.md` — `src/world`.
- `docs/rendering.md` — `src/render`.
- `docs/sim-and-ui.md` — `src/sim` and `src/ui`.
- `docs/performance.md` — how the test tiers are measured and where their cost goes.
- `docs/claude-md.md` — what belongs in this file.

## File size

`npm run lint:size` (`scripts/check-size.ts`) holds every limit below. It runs in `verify` and in
CI, on markdown as well, so a docs-only commit is checked by the `docs` job even though it skips the
build. The edit hook reports the file just written.

No file under `src`, `scripts` or `test` may pass 800 lines; the hook reports a code file at 700, so
the split happens while it is still small. A long file is a file nobody reads to the end. Split it
along the seams it already has — one concern per file — and keep the name that callers import as the
door onto the pieces: `geom.ts` re-exports the shapes it moved to `ring.ts`, and `weapon.ts` the
table it moved to `arsenal.ts`. Never cut a file in half at the line count.

Markdown wraps at 100 columns; a table row and the body of a fenced code block are the only lines
exempt. A markdown file may not pass 400 lines, and this one may not pass 160, because it is loaded
into every session in full. `spec.md` is exempt from the line limit: it is the whole design as one
document, read by section. When a doc reaches its limit, move a subject out into a doc of its own
rather than writing more tightly.


## Taking an issue

The routine that opens these sessions fires every hour, so two sessions overlap and read the same
list. Claim an issue before the first command, because the assignee is all the next session can see.

- Take the lowest open issue with no assignee, no open pull request referencing it, and its
  prerequisites closed. An assignee means another session has it, however stale it looks.
- Assign it to yourself, then read its state again before you push: a long run can finish after
  someone else has merged the same issue.
- Where two implementations exist anyway, one lands and the other is closed as superseded with a
  comparison on it. They are never merged together.


## Determinism

The whole game is a pure function of its seed, so the tooling enforces:

- No `Math.random()` in `src/`. Randomness comes from `rngFor(seed, tick, subsystem, entityId)` in
  `src/core/rng.ts`. Add new subsystems at the end of the `Subsystem` table; never renumber.
- In `src/core`, `src/sim` and `src/world`: no iteration over `Set`, `Map`, iterators from them,
  `for-in` or `Object.keys/values/entries`. Use `sortedEntries`, `sortedMembers`, `sortedKeys` from
  `src/core/sort.ts`.
- Simulation time is the integer `tick` (60 Hz); one game day is 86 400 ticks (24 real minutes).
  Nothing in `src/sim` may read wall-clock or frame delta.

## Directory constraints

Beyond what the file names suggest:

- `src/core` — pure; no DOM, no three.js renderer.
- `src/sim` — plain serialisable state; no wall-clock, no frame delta.
- `src/world` — must run headless in Node, since the sweeps import it. three.js math and generators
  are fine; the renderer, Rapier and the DOM are not. Produces a plain world description.
- `src/render` — reads the world description, never mutates it.
- `scripts/*.ts` — run with plain `node` (type stripping), not through Vite.
  `scripts/render-preview.html` and `scripts/map-preview.html` are the exceptions a script serves
  rather than runs; they are not build inputs.
- `scripts/hooks/` — Claude Code hooks wired from `.claude/settings.json`; fast, idempotent, exit 2
  to report a problem. Anything repeated across sessions belongs in a hook or a `scripts/` entry
  rather than in prose here.


## Traps

The ones that cost a session with nothing to say why. The subsystem docs hold the rest.

- three.js `TerrainGenerator` needs `valleyBias: 1`; fractional values produce NaN.
- **A `BatchedMesh` is a trap on WebGPU in three.js 0.186**: one draw call per instance in every
  pass, and shaders keyed on the batch. `batch.ts` merges into one `Mesh` instead.
- TSL's chained `mix` takes the receiver as the factor: `a.mix(b, t)` compiles to `mix(b, t, a)`.
  Use the free `mix(a, b, t)` from `src/render/tsl.ts`, which is the one door onto `three/tsl`.
  `smoothstep` chains the same way.
- A `Data3DTexture` needs `generateMipmaps = false` on WebGPU: three.js 0.186 builds mipmaps of it
  through 2D views, which the browser refuses, and each frame fills the console with errors.
- `renderer.shadowMap.enabled` is false by default on `WebGPURenderer`, so without the line in
  `renderer.ts` the cascades are built every frame and never drawn.
- Rapier reads a heightfield as `heights[j * (rows + 1) + i]` with `i` walking `z`; the other way
  round gives a world rotated a quarter turn, with no error. It also keeps a force or a torque until
  it is told to forget it.
- WebGPU pads each row of a readback to 256 bytes, so a picture read without unpadding the rows
  comes back sheared — which looks exactly like a broken mesh.

## Conventions

- Relative imports carry explicit `.ts` extensions (`allowImportingTsExtensions` is on) so scripts
  and tests run under plain Node.
- The lint script's TypeScript compiler API comes from the `tsapi` alias (TypeScript 5), because the
  TypeScript 7 the project builds with ships no JS API.
- three.js 0.186 with `@types/three` 0.185. `TerrainGenerator`, `SkyscraperGenerator` and
  `SidewalkGenerator` live under `three/examples/jsm/generators/` and run headless in Node.
- Conventional Commits, one atomic change per commit, feature branches from `main`, one PR per issue
  referencing that issue.
- Never deploy with wrangler locally; `scripts/hooks/guard-bash.sh` blocks it.
- Cloud sessions run `bash scripts/setup-cloud.sh` as the environment setup script. Its result is
  cached in a snapshot keyed on the text typed into the environment dialog, not on the script —
  after changing it, re-save the setup script field at claude.ai/code to force a rebuild.

## Writing

Prose here, in `spec.md`, in `docs/`, in commit messages and in PR bodies is read by non-native
English speakers. Write for them: short sentences, plain words, one idea per sentence, the subject
up front. No idioms, no wordplay, no cleverness a reader has to decode.

Aim for the highest information per word: every sentence carries something the reader did not know,
and nothing restates the sentence before it. Cut a qualifier before you add one. When a sentence
needs two readings, split it rather than explain it.


## Keeping this file current

Update this file whenever a directory, enforced rule or non-obvious gotcha changes.
`docs/claude-md.md` says what belongs here and what does not — read it before adding a section.
