# Profiling

How to find what a frame of the game costs, and where the cost goes. Measure before judging a
performance change: the answer is a number from one of these tools, not a reading of the code.

## Contents

- Which tool answers which question
- `node scripts/render-profile.ts <seed>`
- What each GPU pass costs: `--passes`
- Where the CPU time goes: `--cpuprofile`
- `node scripts/sim-profile.ts <seed>`
- Comparing two builds: `node scripts/profile-compare.ts`
- What the first runs found

## Which tool answers which question

| The question | The tool |
| --- | --- |
| How long does a frame take to draw, still and driving? | `render-profile.ts <seed>` |
| Which pass of the frame costs the GPU time? | `render-profile.ts <seed> --passes` |
| Which code does the main thread spend a frame in? | `render-profile.ts <seed> --cpuprofile` |
| What does one part of the frame cost? | `render-profile.ts` with and without `--no-shadows` etc. |
| What does a tick of the simulation cost, and in which part? | `sim-profile.ts <seed>` |
| Did my change make it faster or slower? | `--json` on each build, then `profile-compare.ts` |

The frame of a session is the simulation step and then the draw. `render-profile.ts` times the draw
alone and runs no simulation. `sim-profile.ts` times the step alone. The two add up to the frame.

## `node scripts/render-profile.ts <seed>`

It draws a few hundred frames, standing still and then driving, and prints the frame times, the
draws, and what each long frame compiled or built. It runs the warm-up of `src/render/warm.ts`
first, as a session does, so a long frame here is a long frame in the game and not one the game
had already paid for behind its loading screen. Its switches take one part of the frame away —
`--no-water`, `--no-shadows`, `--no-lamps`, `--no-post` — so two runs say what that part costs, and
`--dpr=2` is what a Retina display draws. `--tier-at=150:high,300:full` changes quality during the
drive, at the drive frames named, the way the game's own monitor changes it — which is how a tier
change is timed, by what the frames around it compiled. `--memory` adds what the GPU and the page
hold, settled and at the most over the drive; `docs/performance.md` has the numbers it gave.

It needs a real GPU. SwiftShader draws on the processor and says nothing about a frame, so it does
not run in a cloud container. `docs/dev-tooling.md` says how the browser is found.

## What each GPU pass costs: `--passes`

A frame is many passes: the sun's shadow cascades, the scene, and each step of the post chain.
`--passes` puts a WebGPU timestamp query around every one of them (`src/render/gpu-passes.ts`) and
prints the milliseconds each took, at the median, the 95th percentile and the most.

The time a pass is given is **the time it moved the end of the frame's GPU work**, not its end less
its start. A tiled GPU, as in every Apple machine, runs the passes of a frame over each other. A
post step starts when it is handed over and then waits for the scene, so its span covers most of
the frame. On an M1 every pass read about 10 ms by its span, in a frame of 14 ms. The time each pass
adds to the end of the work does add up: the `gpu` line is their sum, and it is the GPU's busy time
for the frame.

A pass is named by what three.js hands the inspector: `shadow sun cascade 1`, `scene -> output`
for the scene drawn into the post chain, and `post <material>` for a full-screen step. A name
repeated in one frame, as `post Bloom_separable` is for each level of the bloom, is summed.

The timing is honest only per pass. Inside the scene pass the draws cannot be told apart. To split
it, take a part away with a `--no-*` switch and compare the runs.

Chrome rounds a timestamp to a tenth of a millisecond unless its WebGPU developer features are on,
so the profiler turns them on with `--passes`. An adapter without the `timestamp-query` feature
says so and prints no passes.

## Where the CPU time goes: `--cpuprofile`

It profiles the main thread through the drive and prints the time four ways: by area (`src/sim`,
`src/render`, three.js, Rapier, the garbage collector, the engine's native code), by file, and by
function, each as self time and as total time. Self time is a function's own code. Total time also
counts what it called, so `post.ts` at 57 % total means more than half of the busy time was spent
under the post chain's render call. `idle` is the thread waiting on the GPU or the next frame, and
the shares are of the busy time without it.

`--cpuprofile=drive.cpuprofile` also writes the profile. Chrome DevTools opens it in the
Performance panel as a flame chart of every sample. `scripts/cpu-profile.ts` does the summing, for
the browser and for Node alike.

## `node scripts/sim-profile.ts <seed>`

It runs `stepSim` over a real city in Node, with no browser: the city of `src/city.ts`, the Rapier
world, the traffic, the crowd, the police and the services. It prints the milliseconds of a tick
and of each part of it. It runs anywhere Node does, a cloud container included.

- `--ticks=3600` is how many ticks are timed, after `--warm=300` that are not.
- `--mode=walk` walks instead of driving. The drive takes slow curves from the nearest road.
- `--heat=4` holds the heat at four stars, so the police chase throughout.
- `--cpuprofile` and `--json` work as they do in `render-profile.ts`.

Each part is timed by wrapping, from the script, the one method the physics steps it through. That
keeps any clock out of `src/sim`. The parts the wrapping cannot reach are counted in
`rest of physics step`; the CPU profile names them. The shops, the contacts, the turf and the
street crime come from the chunk workers in a session, so they are not built here.

A tick is 1/60 s, so a tick over 16.7 ms makes a frame late on its own. The real budget is much
smaller, because the frame must also be drawn.

## Comparing two builds: `node scripts/profile-compare.ts`

```
node scripts/render-profile.ts sunset --passes --json=main-1.json   # on main, twice
node scripts/render-profile.ts sunset --passes --json=branch-1.json # on the branch, twice
node scripts/profile-compare.ts main-1.json main-2.json vs branch-1.json branch-2.json
```

For every series both sides hold, it prints the median and the 95th percentile before and after,
the shift of the median with its 95 % interval, and a verdict. The interval is a bootstrap over
the samples: it is the noise within a run. The spread is the noise between runs of one build: the
largest gap between the medians of the runs on one side. A shift is called faster or slower only
when its interval leaves 0, it is larger than the spread, and it is 2 % of the median or more.

GPU times move by a millisecond or more between runs, so run each build twice at least. With one
run a side there is no spread to weigh, and the script says so. Every file records the commit it
was measured on, with `+` when the tree held changes, and the options it was run with. The script
warns when the options differ.

## What the first runs found

Seed `sunset`, full quality, 1600×900 at a pixel ratio of 1, on an Apple M1, at noon.

The GPU is most of a frame. Of about 14 ms of GPU time while standing still, the scene pass took
11.5 ms, the two sun cascades 1.1 ms, and the whole post chain about 1 ms. `--no-shadows` saved
1.7 ms of GPU and 2.9 ms of CPU: the cascades are drawn once, but the scene pass also samples them.

On the main thread, half the busy time of a frame was in three.js itself, and a quarter in native
code: the engine and the WebGPU calls. The game's own `src/render` took under 10 %.

Driving, the simulation took 5.5 to 5.7 ms a tick at the median and 10 to 12.5 ms at the 95th
percentile, over five runs. One run of 1 800 ticks had 27 ticks over 16.7 ms. More than half of a
tick was `give way`, the traffic and the crowd keeping out of each other (`src/sim/give-way.ts`).
By file, the most self time was in `pedestrian-route.ts`, `give-way.ts`, the road bed of
`src/world/bed.ts` and `src/core/libm.ts`. Rapier's own step took 0.1 ms.
