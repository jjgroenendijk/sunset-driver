# Sunset Driver — working notes for agents

A top-down open-world crime game for the browser: WebGPU render, Rapier physics, Tone.js audio, everything generated from a seed.

`spec.md` is the single source of truth. Build it top down, section by section, and read the hard vetoes in section 1.2 before proposing anything. Work is tracked as GitHub issues numbered in spec order; take the lowest open issue whose prerequisites are closed and keep the change to that issue's scope. When you find a pre-existing problem outside that scope — a bug, a wrong number, a stale comment, a missing test — open a GitHub issue for it and carry on. The issue is the deliverable; a note in a PR body or a `TODO` in the code is not.

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

A wall-clock measurement only belongs in `test/budget.test.ts`. Vitest runs that file as its own project, on its own, because the sweeps fill every core; a timing assertion in any other file measures a busy machine and fails at random. Sweeps get their worlds from `generateWorlds` in `test/world-pool.ts`, which generates them in worker threads, so no sweep calls `generateWorld` itself. `test/world-worker.ts` runs under plain Node, not Vite, so it may import only what `src/world` imports.

## World generation gotchas

- `generateWorld(seed)` builds the whole-map skeleton; chunk-level content will hang off it. The archipelago is a power diagram of island sites shrunk by half a channel and domain-warped, so straits bend but never close. The main site is the core at the origin.
- three.js `TerrainGenerator` needs `valleyBias: 1`; fractional values produce NaN.
- `new LandMasses(hf, islands, minHeight)` (`landmass.ts`) labels the connected pieces of dry land and says which carry an island site. A cell of the power diagram can hold a rock in the sea that no crossing reaches, so anything that places ground content asks `carriesIsland` first. District sites do.
- Ask `islandAt(islands, size, coastNoise(seed), x, y)` which island a point stands on. `islandIndexAt` reads the raw power cells, and the coastline is cut from those cells after a domain warp that moves them by up to 6 % of the map.
- `buildTensorField(world)` (`tensor.ts`) is the seeded field road direction follows (spec section 6.1). Influences blend as tensors, so ones facing opposite ways reinforce instead of cancelling; `sample(x, y)` returns both directions and a `strength` saying how decided the field is, and `majorAt(x, y)` is the allocation-free hot path.
- `traceRoads(world, field)` (`roads.ts`) traces every tier as streamlines of that field: highways, then arterials, then the minor fill of streets, alleys and dirt roads. Three invariants hold by construction, and the sweep checks them: every curve shares a point with another curve, so the network is one component; no segment stands over water unless its index is in the curve's `bridges` and it spans a crossing of the water description; and no segment on the ground climbs harder than `TIERS[tier].maxGrade`. A curve that reaches neither the network nor its target is dropped, never left dangling.
- A step too steep for its tier is refused, so the trace turns along the contour. Where no turn is left, the road holds its line and spans several steps at once, and the ground it may not climb is bored through or carried over. `bridges` and `tunnels` hold the indices of the segments that stand off the ground: the ground under a bridge falls more than `FILL` below the road, and the ground over a tunnel stands more than `CUT` above it.
- The minor fill takes its tier and its block size from the ground under each seed: `MINOR_BY_ZONE` gives the zone's spacing range, and the density of the district there says where in that range the spacing lands. A road that met nothing on one side is trimmed to a cul-de-sac rather than left running into nothing.
- A highway takes a junction only at an interchange (spec section 6.2). `interchangesOf` places them along the curve, `RoadCurve.interchanges` lists the point indices, and `mayJoin` is the rule: a highway or an arterial ramp joins one there, and a street, alley or dirt road never joins a highway anywhere. Where a minor road crosses a highway instead, `graph.crossings` makes it an overpass.
- `buildRoadGraph(roads)` (`graph.ts`) is the queryable road graph of spec section 6.5. It is built on demand from the curves, not stored in the world description. A node is a point two curves share, so two roads that only cross on the map stay grade separated. `graph.crossings` lists those crossings and says which road is carried over the other; both runs of both roads carry the index. `shortestPath(from, to, allow?)` narrows the network to the edges `allow` accepts, which is how the tram is routed over the arterials alone. `tiers.ts` holds the width, verge, pavement, lanes, speed limit, permitted traffic and maximum grade of each tier; nothing else should carry those numbers.
- `buildFootprint(roads, corridors, graph)` (`footprint.ts`) is the ground the roads claim (spec section 6.4). It is built on demand like the graph, not stored in the world description. Each curve is offset by `footprintHalfWidth(tier)`, an apron is laid where three roads or more meet, and the corridor strips join them. Only the runs a road stands on are claimed: the ground under a deck belongs to that road's elevated corridor, or is not land at all. The holes of the union are the city blocks, and subtracting it from the land gives the parcels.
- `src/core/geom.ts` is the polygon arithmetic the parcel model runs on: `strip`, `disc`, `union`, `difference`, `split`, `ringArea`, `pointInRing`. A `Region` is an outer ring wound anticlockwise with its holes wound clockwise. They round every coordinate to the millimetre, so the cross products that say which side of an edge a point falls on are exact integers and can never contradict one another. Over a whole network they cost about a third of a world generation, so a caller keeps the answer instead of asking twice. `split` gives both sides of a cut off one pass, so the two sides are bounded by the same edges. The engine files an edge in every bucket the box around it touches, so a clip polygon that reaches across the map is laid in short steps rather than four long diagonals.
- `landRegions(hf, seaLevel)` (`land.ts`) traces the coastline off the heightfield as regions wound with the land on their left. Everything else about the land is a grid; the parcel subtraction is the one thing that needs it as a polygon.
- `buildParcels(world, footprint, graph, field)` (`parcels.ts`) is the parcel model of spec section 6.4. It is built on demand like the graph and the footprint, not stored in the world description. A parcel is a piece of the land the footprint leaves, and every one of them has a road running along it: ground no road reaches is dropped, because nothing can be driven to it. Only a block the roads enclose is cut down to the size its zone builds in, so open country past the last road stays one piece rather than becoming strips no road touches.
- `buildCorridors(world, roads, graph)` (`corridors.ts`) lays the corridors of spec section 6.3 and the tram route of spec section 13.2. It is the last step of `generateWorld`, and the only place that builds the graph during generation. A corridor claims its ground at the moment it is laid: a strip is claimed segment by segment, ground within `CLAIM_CLEARANCE` of a claimed strip is not free, and a run that meets claimed ground is cut and continues past it. Two corridors therefore cannot overlap, and the sweep only confirms it. The tram claims first, so a deck over its lane gives way. A line that turns more than `MAX_BEND` is cut at the turn, because a strip carried round a corner that sharp folds over itself.
- An elevated corridor is the ground under a deck that stands over land, with the pillar feet that carry it; a deck over water owns nothing, because there is no ground under it. A tram corridor is the reserved lane, down the middle of an arterial from one stop to the next. `world.tram` holds the line the tram drives, its stops, and the level crossings where another road meets it.
- Look at the image before judging a layout change: `node scripts/world-preview.ts <seed> out.png`. It draws one colour per tier — highways black, arterials red, streets blue, alleys green, dirt roads tan — with bridge decks orange, bores through the ground cyan and the interchanges of the highways lime, and strokes the field's major direction, dark where the field is decided and pale where influences cancel. Corridors are outlined too: the ground under a deck in amber with its pillars as dark dots, the tram's lane and route in magenta, its stops pink and its level crossings white. The footprint of the roads is filled in dark grey under all of it, and each parcel in the colour of its owner.
- `test/seed-sweep.test.ts` runs 16 seeds, or 200 under `SWEEP_SEEDS=200`. The quick count is what holds `npm test` under its 15 s, since a seed generates a whole world.

## Player and interface

- The player's look is indices into the tables in `src/sim/character.ts`, so a save carries numbers, not colours. `normaliseAppearance` folds an out-of-range index back onto a real option, and `resolveAppearance` hands the renderer the entries. `src/render/character.ts` builds the model from them as boxes; the parts a top-down camera sees carry the chosen colours.
- `src/ui/controls.ts` is the one list of key bindings. It is shown on the title screen and copied into the README; `Keyboard.sample` must stay in step with it.

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
