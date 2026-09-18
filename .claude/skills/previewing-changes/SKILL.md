---
name: previewing-changes
description: Take a picture of the world, the map or a rendered frame in Sunset Driver, compare seeds on one sheet, or time frames with the profiler. Use when asked to look at, show, preview, screenshot or compare what the game draws, and before judging any layout, rendering or performance change — the answer is the image or the frame times, not the code.
---

# Looking at what the game draws

Judging a change from the code is how a session ships something that looks wrong. Look at the
image before judging a layout change, the frame before judging a rendering change, and the frame
times before judging a performance change.

`docs/dev-tooling.md` has every flag. This is which tool answers which question.

## Which tool

| The question | The tool |
| --- | --- |
| Is the road network, the terrain or the land use right? | `node scripts/world-preview.ts <seed> out.png` |
| Do the seeds differ from each other? | `node scripts/terrain-sheet.ts 24 sheet.png` |
| Does the renderer draw anything at all? | `npm run test:render` |
| Does the frame the player sees look right? | `node scripts/render-preview.ts <seed> out.png` |
| Do several seeds look right, in one image? | `node scripts/render-sheet.ts 4 sheet.png` |
| Did that change cost frame time? | `node scripts/render-profile.ts <seed>` |
| Is the map or the minimap right? | `node scripts/map-preview.ts <seed> out.png` |
| Whose turf is whose, and how it spreads? | `node scripts/map-preview.ts <seed> out.png --turf --day=8` |

Then read the image back with the Read tool. A run that writes a PNG nobody opens has answered
nothing.

## What to expect

`scripts/chromium.ts` finds the browser on its own, so `CHROMIUM_PATH` needs no setting; set it only
to force a particular Chrome.

A rendered frame takes 50 to 135 seconds on a laptop, because SwiftShader draws on the processor.
Run one at a time — two at once fail. `render-sheet.ts` draws every tile in one browser, so four
seeds cost about one render rather than four.

`test:render` costs one such frame and answers only whether the renderer drew a world, not whether
it looks right. Run it when a frame looks wrong, to tell a broken renderer from a broken change.

A black picture is often issue #339 and not your change: on some Chromium builds the colour grade's
table never reaches the GPU, and every frame comes out black. Cloud containers hit it; CI does not.
`test:render` says so plainly — `1 colours, under 64` — where a picture only looks broken.

`render-profile.ts` needs a real GPU and SwiftShader will not do. GPU timings move by several
milliseconds between runs, so compare two builds by running each more than once.
