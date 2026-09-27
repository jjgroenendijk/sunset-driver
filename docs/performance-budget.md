# The performance budget

What a smooth game means, in numbers, on the slowest device the game aims at: an iPhone 13 Pro in
iOS Safari. How to measure each number, on the phone and on a laptop standing in for it. Spec
section 2.4 is the frame budget on integrated graphics; this is the same frame on a phone, and adds
what spec section 9.2 asks of pop-in. How the tools work is in `docs/profiling.md`.

## Contents

- The device
- The budget
- Measuring on the phone
- Measuring on a laptop
- Where the frame stands

## The device

The iPhone 13 Pro and every phone after it. Its A15 has a GPU of five cores and a main core about
as fast as an Apple M1's. Its GPU is taken to do about half the work of the M1's seven cores in the
same time. That is an estimate from published benchmarks, not a measurement; the frame watch on
the phone is what checks it.
iOS Safari reports four cores to a page whatever the phone has, so the game runs its two chunk
workers there too. Those workers may run on the slow cores.

The screen is 844 by 390 CSS pixels held sideways, at a pixel ratio of 3. The game draws one pixel
per CSS pixel (`MAX_PIXEL_RATIO`, `renderer.ts`), so a frame is 330 000 pixels: a quarter of a
1600 by 900 window. Safari draws at 60 Hz. A touch session starts at the `high` tier, which keeps
the sun's shadow. Auto drops to `medium`, the same frame with no shadow, when the phone cannot hold
it.

## The budget

Each line is kept on the phone, driving at the top speed of the roster, over a minute of play after
the loading screen. The frame watch shows the first five on the phone itself.

| What | Budget | Why |
| --- | --- | --- |
| Frame, 95th percentile | 16.7 ms | 60 fps. The median alone hides the frames a player feels. |
| Long frames, 50 ms or more | none after the first 10 s | Two refreshes missed is a stutter anyone sees. |
| A hole in sight | none nearer than the haze | A chunk missing or half built is the city popping in. |
| An edge that pops, top down | none in sight | Top down is the view the game is played in. |
| An edge that pops, a chase view | none nearer than 250 m | The facade ring stands there; nearer is a street changing. |
| An edge that fades, in sight | none nearer than 100 m | A dither fade reads as distance, not as a pop. |
| GPU time a frame | 12 ms | What is left of the frame once the main thread has taken its part. |
| Main thread: simulation tick | 4 ms at the 95th percentile | Spec section 2.4 gives physics and gameplay 4 ms together. |
| Main thread: streaming | 2 ms a frame | `STREAM_BUDGET_MS`, spec section 2.4. |
| Page memory: typed arrays and heap | 500 MB at the peak of a drive | iOS Safari kills a page near 1.5 GB, and reloads it (issue #448). |
| GPU memory | 600 MB at the peak of a drive | It counts toward the same limit on a phone, which shares its memory. |

A hole is a chunk in sight that is not in the scene or has only some of its batches (`pop-in.ts`).
An edge is where a rule stops drawing something: the square the traffic is drawn in, the ring of
chunks with facades. An edge that fades dithers out over 30 m (`fade.ts`); one that pops does not.

## Measuring on the phone

Open the game with `?dev` on the address. The developer block shows from the start, and its last
line is the frame watch (`frame-watch.ts`):

```
60 fps  p50 16.7  p95 17.1  worst 34 ms  0 long  hole none  edge crowd 144 m
```

It covers the last five seconds: the frame rate, the median, 95th percentile and longest frame,
the frames of 50 ms or more, the nearest hole, and the nearest edge in sight with what ends there.
On a laptop, F3 shows and hides the same block.

A frame on a 60 Hz display measures 16.7 ms however little of it the game used, so the frame watch
says whether the budget is kept, not how much room is left. The room is what the laptop measures.

## Measuring on a laptop

`render-profile.ts --device=phone` draws the phone's frame: 844 by 390 at a pixel ratio of 3, at
the `medium` tier, where the phone is expected to settle. The GPU is the laptop's, so a GPU time on
an M1 is about half what the phone takes: the 12 ms of the budget is about 6 ms there.

```
node scripts/render-profile.ts sunset --device=phone --speed=60 --drive=600 --passes
node scripts/render-profile.ts sunset --device=phone --speed=60 --view=third-person
node scripts/render-profile.ts sunset --device=phone --speed=60 --worker-slowdown=4
node scripts/sim-profile.ts sunset --heat=4
```

The first prints the frame, the GPU passes, and the pop-in of the drive: the nearest hole, and
each edge in sight with the share of frames it was seen in. The second does the same from the
chase view, which sees the horizon, so every edge shows there. The third holds each chunk worker's
answer back until four times its build, as a phone whose workers run on its slow cores; a hole it
finds is streaming that falls behind. Chrome cannot throttle a worker, which is why the pool does
it (`slowedWorker`, `chunk-pool.ts`). `--cpu-slowdown=N` slows the page alone. `--memory` adds what
the page and the GPU hold. The fourth is the simulation, in Node.

## Where the frame stands

Measured on an Apple M1 laptop with `--device=phone`, seed `sunset`, driving at 60 m/s, in
September 2026 (issue #774).

GPU is the sum of the timed passes, in ms, median and 95th percentile of the drive. The phone is
taken to need about twice these.

| Tier | GPU standing | GPU driving | Hole, chase view | Old detail, chase view |
| --- | --- | --- | --- | --- |
| `medium` before #774 | 7.8 | 9.6 / 13.0 | 235 m, 14 % of frames | 242 m |
| `medium` | 6.0 | 9.0 / 13.5 | 724 m, in the haze | 242 m |
| `high` | 8.4 | 9.7 / 13.9 | 724 m, in the haze | 242 m |
| `medium`, workers 4 times slower | 6.0 | 9.0 / 13.5 | 703 m, in the haze | 235 m |

Top down, no hole and no edge that pops shows at any tier. The one edge in sight is the crowd's,
which fades at 144 m. The main thread takes 2.5 ms of a frame. Memory at `medium` peaks at 248 MB
of GPU and 169 MB of typed arrays, well inside the budget.

What is still over, on the estimate of twice the M1:

- **The GPU while driving.** About 18 ms against 12. The water's mirror is 2 ms of it at the
  median and 3.7 ms at the 95th percentile (`--no-water`), whatever its resolution: a 169 by 78
  mirror costs the same (issue #781). The lamps' clustered lights are 1.2 ms after dark
  (`--no-lamps`). The render scale is worth 0.7 ms, so the frame is not paying for its pixels.
- **The simulation tick.** 11 ms at the 95th percentile against 4 (issue #778).

