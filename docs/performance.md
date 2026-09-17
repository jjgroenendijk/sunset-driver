# Test cost

How the test tiers are measured and where their cost goes. `CLAUDE.md` holds the commands and the
ceilings. No test measures wall clock: a timing assertion on a shared machine fails at random.

## Contents

- What the ceilings are
- Reading a measurement
- Where the full tier's cost goes
- The shards
- What a check costs per seed

## What the ceilings are

The quick tier, `npm test`, has to stay under 15 s.

The full tier is the five jobs of `full-tier.yml`, and **the ceiling is 2 minutes for each job, not
for the tier**. Four of them are shares of the seed sweep's 500 seeds and the fifth is every other
file with the typecheck and both lints. `npm run test:full` runs all five jobs' work in one process,
which is 3 min 36 s on an eight-core M1 Air; that command is the coverage, and the job is the
ceiling. To run one job's work by hand:

```
SWEEP_SHARD=2/4 npm run test:full -- test/seed-sweep.test.ts
```

## Reading a measurement


**Both ceilings are wall clock, and wall clock is the work divided by the cores it is spread over.**
So the number to compare a session against is the work, which is the same on every machine:
`time npm test` prints it as user plus system seconds. On an Apple M1 Air of 8 cores the quick tier
costs about **62 CPU-seconds**, at about 370 % CPU, which is 17 s of wall clock. One share of the
seed sweep's 500 seeds costs about **183 CPU-seconds** at about 350 %, which is **52 s**.

Both grew by about half when the zone rings widened and the city became most of the map (spec
section 8.2): on the commit before, the quick tier and the whole 200-seed tier of the day read 50
and 252 CPU-seconds, 12 s and 60 s. Nothing in the tests got slower; every seed now carries three
times the roads. The quick tier misses its 15 s by that alone, and cutting the sweep from 6 seeds to
4 moves it by under a second, because the cost is spread over every file that builds a world or a
chunk rather than over the sweep.
Issue #198 tracks bringing both back down. The seed sweep's one hook — every world of the sweep,
generated in the pool — can pass the 120 s hang guard `vitest.config.ts` used to set, which is why
that guard is now 300 s. The guard is not the ceiling; this file is.

That is what makes the same work take a very different time on a cloud session of four Intel Xeon
cores: half the cores, each about twice as slow. A session that measures twice the wall clock of
another has almost always found a different machine. Compare the CPU-seconds first, and only call a
tier a regression when those have grown. Write the machine, its core count, the wall clock **and**
the CPU-seconds into the pull request whenever a change moves either number.

Do not trust one wall-clock reading, on any machine. The full tier on that same laptop took 96 s and
192 s on the same commit, because the laptop was busy the second time. On one GitHub
`ubuntu-latest` runner, three runs of `test:full` on one commit took 71 s, 78 s and 122 s. A runner
can be most of twice as slow as the one before it, so one time says nothing on its own, and the
slowest of them is what the 2 min has to hold. Read CI, and a shared laptop, as a spread of several
runs.

## Where the full tier's cost goes

**Generating the worlds is the sweep, and the checks are the rest.** One share of the 500 seeds is
125 worlds: on the M1 Air its 53 checks add up to 22 s on the test thread and the hook that
generates the worlds takes the other 28 s of the 52 s the run costs, at 183 CPU-seconds. The
generation is already spread over every core the machine has, so **the only way further down is
another machine** — a stride through the checks would take at most the 22 s, and the pool would
still need its 28 s.

That is why issue #317 widened the sweep from 200 seeds to 500 by splitting it over runners rather
than by making a check cheaper. On the M1 Air the sweep at 200 seeds in one process took 111 s of
wall clock and 379 CPU-seconds; at 500 seeds in one process it takes 172 s and 713. Split four ways
the four shares take 52, 51, 67 and 54 s, for about 730 CPU-seconds together: the split costs about
2 % more work and gives back two thirds of the wall clock, on two and a half times the seeds.

## The shards

`full-tier.yml` gives the seed sweep four runners and every other file with the typecheck and both
lints a fifth. `SWEEP_SHARD=2/4` is what tells a run which share to read: `seed-limits.ts` takes the
tier's seeds in turn, so shard 1 reads seed 0, shard 2 seed 1, and every shard gets the same spread
of the seed space. The counts taken from the front of the tier — `FOOTPRINT_COUNT`, `REPEAT_COUNT`
and the rest — are shared out the same way, so **the four shards together read exactly the seeds one
unsharded run reads**. Widen a count and every shard grows by its share of it.

A fifth job named `seed-sweep` needs the four and passes only when they all did, because the
ruleset requires the one check name `full-tier / seed-sweep`. A failure there says nothing itself:
the output is in the `sweep 1` to `sweep 4` checks, which `node scripts/pr-wait.ts <pr> --all`
lists.

On `ubuntu-latest` on 17 September 2026 the four shares took 1m12s, 1m42s, 1m35s and 1m20s, and
`other` 43 s. The slowest share is within 20 s of the 2 min, so a check that reads every seed is
what the tier has left to give: widen one and the sweep needs a fifth runner rather than a longer
ceiling.

Before the split, on 13 September 2026, the seed sweep alone took 103 s on its runner at 200 seeds
and every other file took 24 s on the other. The sim sweep took 4 s on its own: in a whole run it
looks slow only because it waits for the pool while the seed sweep generates its worlds. Vitest
writes each shard's durations into its job summary.

Issue #88 tracks the wall clock the quick tier misses its 15 s by on a four-core session, and
issue #198 what the city filling the map added to both tiers.

Sweeps get their worlds from `worldsFor` in `test/world-pool.ts`, which generates them in worker
threads, so no sweep calls `generateWorld` itself. `buildWorlds` takes a job per seed, and a job
that sets `parts` lays the footprint, cuts the parcels and lays the buildings in the worker as well:
they are the dearest things built on a world, and building them on the test thread is what pushed
the quick tier over its budget. The pool hands out the jobs that ask for parts first, whatever order
the caller listed them in, because one long job started last leaves every other worker idle. The
road graph stays on the test thread, because it carries methods and cannot cross a thread boundary.
`test/world-worker.ts` runs under plain Node, not Vite, so it may import only what `src/world`
imports.

## What a check costs per seed

A sweep runs its checks on the test thread, one seed after another, while the pool's workers stand
idle. That is a third of a shard's wall clock, and two things dominate it — neither of them the
comparison the check makes:

- A vitest `expect` costs about 4 µs, against 4 ns for the comparison inside it. One per road point
  of every seed is seconds. Collect the first thing that went wrong in a `complaint` string and make
  one assertion out of it after the loop — the file does this everywhere, and the message is better
  for it.
- A key built with a template string allocates. `pointKey` answers a number, and a flag per cell of
  a grid is a `Uint8Array`, not a `Set` of `"column,row"`.
