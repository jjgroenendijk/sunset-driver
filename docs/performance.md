# Test cost

How the test tiers are measured and where their cost goes. `test/budgets.ts` holds the budget table;
`CLAUDE.md` holds the rule that a budget failure is a regression to find.


**Both ceilings are wall clock, and wall clock is the tier's work divided by the cores it is spread
over.** So the number to compare a session against is the work, which is the same on every machine:
`time npm test` prints it as user plus system seconds. The quick tier costs about **57 CPU-seconds**
and the full tier about **540**, measured on an Apple M1 laptop of 8 cores, where the quick tier
takes 14 s of wall clock at about 420 % CPU.

That is what makes the same tier take 28 s on a cloud session of four Intel Xeon cores: half the
cores, each about twice as slow, on the very same work. A session that measures twice the wall clock
of another has almost always found a different machine. Compare the CPU-seconds first, and only call
a tier a regression when those have grown. Write the machine, its core count, the wall clock **and**
the CPU-seconds into the pull request whenever a change moves either number.

Do not trust one wall-clock reading, on any machine. The full tier on that same laptop took 96 s and
192 s on the same commit, because the laptop was busy the second time. CI runs only `test:full`, on
a GitHub `ubuntu-latest` runner, and three runs of one commit took 71 s, 78 s and 122 s. A runner
can be most of twice as slow as the one before it, so one time says nothing on its own, and the
slowest of them is what the 2 min has to hold. Read CI, and a shared laptop, as a spread of several
runs.

Issue #88 tracks the wall clock the quick tier misses its 15 s by on a four-core session.

A wall-clock measurement only belongs in `test/budget.test.ts`. Vitest runs that file as its own
project, on its own, because the sweeps fill every core; a timing assertion in any other file
measures a busy machine and fails at random. That file is serial by design, so it is about a third
of the quick tier however many cores the machine has. `bestUnder(runs, limit, body)` in
`test/helpers.ts` is what keeps it affordable: a budget is kept when any run comes in under it, so
the repetition is paid only by the run that misses.

Sweeps get their worlds from `worldsFor` in `test/world-pool.ts`, which generates them in worker
threads, so no sweep calls `generateWorld` itself. `buildWorlds` takes a job per seed, and a job
that sets `parts` lays the footprint, cuts the parcels and lays the buildings in the worker as well:
they are the dearest things built on a world, and building them on the test thread is what pushed
the quick tier over its budget. The pool hands out the jobs that ask for parts first, whatever order
the caller listed them in, because one long job started last leaves every other worker idle. The
road graph stays on the test thread, because it carries methods and cannot cross a thread boundary.
`test/world-worker.ts` runs under plain Node, not Vite, so it may import only what `src/world`
imports.

A sweep runs its checks on the test thread, one seed after another, while the pool's workers stand
idle, so what a check costs per seed is what the tier costs. Two things dominate that and neither is
the check itself:

- A vitest `expect` costs about 4 µs, against 4 ns for the comparison inside it. One per road point
  of every seed is seconds. Collect the first thing that went wrong in a `complaint` string and make
  one assertion out of it after the loop — the file does this everywhere, and the message is better
  for it.
- A key built with a template string allocates. `pointKey` answers a number, and a flag per cell of
  a grid is a `Uint8Array`, not a `Set` of `"column,row"`.
