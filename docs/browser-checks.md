# The checks that need a browser

Two checks in this repository open a browser: one draws a frame and reads the pixels, the other
builds a world in the page and compares it with the world Node builds. Everything else in `npm run
verify` runs headless in Node. `docs/dev-tooling.md` is the list of tools that take a picture of the
game; this is the pair that says the game still works.

## Contents

- `npm run test:render`
- `npm run test:world`

## `npm run test:render`

Whether the renderer draws anything at all. It is the one check that opens a WebGPU device: `npm
run verify` builds worlds and meshes headless, so a change that leaves the game drawing a blank
screen passes every other check in the repository.

It renders one frame of one fixed seed through the harness `render-preview.ts` uses, then reads the
pixels. It fails on four things:

- The page threw. What the page writes to its **console** does not fail it: three.js reports WebGPU
  validation there and a frame can still be right. A validation error that does break the frame
  shows up in the pixels instead, which is why they are measured.
- Too few distinct colours. A blank frame holds one.
- One colour over most of the frame. An empty scene clears to a single value.
- Too few edges. Two pixels side by side differ only where something has an outline, so a frame
  that is sky and nothing else has almost none — it holds thousands of colours and still means the
  world was never drawn.

The thresholds are 64 colours, 90% for the flattest colour and 2% of pairs differing. Four real
frames — noon, one in the small hours, another seed, and the one CI drew — measured 298, 193, 265
and 276 colours, 20%, 62%, 17% and 16% flat, and 15.5%, 12.4%, 9.3% and 13.1% edges, so the nearest
threshold has more than four times the margin it needs. They are set that low on purpose: this
check says the renderer drew a world, not that the world looks right. A picture from
`render-preview.ts` is what answers that.

`test/render-check.test.ts` measures frames built by hand — blank, flat, a bare sky gradient, and
one with blocks in it — so what the check would say costs nothing to test. Only the frame needs a
browser.

It takes about a minute, almost all of it the one SwiftShader frame, so it runs neither in `npm
test` nor in `npm run verify`. On a pull request the `render-smoke` job of `ci.yml` runs it, in
about 65 seconds. That job does not gate the merge: SwiftShader draws on a shared runner's
processor, and a device lost there is not a rendering regression. The repository ruleset is where
that is changed.

A black frame used to be the tool's own fault. The colour grade's table is a 3D texture, and
three.js uploaded it a slice at a time, which some Chromium builds refuse: the cube kept the zeros
it was allocated with and the grade mapped every colour to black, so the check failed all three
measures at once. `lut-upload.ts` writes the whole cube in one copy now (`docs/post.md`), and a
grade that still cannot be uploaded is dropped with a warning rather than drawn. A frame that comes
back blank is therefore worth believing. Read the console the run collected before blaming the
browser.

## `npm run test:world`

Whether the browser builds the city Node builds. The world is a pure function of its seed, so the
two must agree; every other check in the repository runs on one side only, so for a long time
nothing noticed that they did not. Issue #243 is what that looked like: `Math.cos` rounded one bit
differently in the two engines, the road tracer took a different step, and the render preview drew
grass where Node had buildings and laid car park bays a kilometre from where Node laid them. No
test failed and the page reported no error.

It builds each seed twice — once here, once in a page Vite serves — and compares `worldDigest`
(`src/world/digest.ts`), which is one line per layer in the order generation builds them. The first
line that differs names the stage that went its own way; every line under it follows from that one.
Two fixed seeds by default, or name your own: `node scripts/world-check.ts 42 hello`.

Nothing here draws, so it opens no graphics device and has none of `test:render`'s flakiness. Two
seeds take about 12 seconds, almost all of it generation. On a pull request the `world-check` job of
`ci.yml` runs it.

A seed can agree by luck, so a failure is always real and a pass on one seed proves less than a pass
on several. Reach for more seeds when judging a change to `src/core/libm.ts` or to anything the road
tracer reads.

**Which browser ran it is part of the answer.** Engines differ from each other as well as from Node:
Chromium 141 parts company with Node on `sin` and `cos` alone, while Chrome for Testing 153 does so
on a dozen functions. A cloud session's browser cache usually holds an older build than the lockfile
names, and the resolver takes what it finds, so a green run here can still be red in CI. The check
prints the build it used. To answer for CI's browser, install the one the lockfile names and point
the check at it:

```
node_modules/.bin/playwright-core install --no-shell chromium
CHROMIUM_PATH=~/.cache/ms-playwright/chromium-<build>/chrome-linux64/chrome npm run test:world
```
