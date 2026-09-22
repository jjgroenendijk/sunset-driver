---
name: previewing-changes
description: Take a picture of Sunset Driver — the rendered frame, a vehicle, a weapon, a person, a shop interior, the map, the terrain or the land use — compare seeds on one sheet, and time frames with the profiler. Use when asked to look at, show, preview, screenshot or compare what the game draws, and before judging any layout, rendering or performance change — the answer is the image or the frame times, not the code.
---

# Looking at what the game draws

Judging a change from the code is how a session ships something that looks wrong. Look at the
image before judging a layout change, the frame before judging a rendering change, and the frame
times before judging a performance change.

## The loop

1. Pick the tool from the table below.
2. Run it. Every tool writes a PNG or prints numbers.
3. **Read the PNG back with the Read tool.** A run that writes a picture nobody opens has
   answered nothing.
4. Say what the picture shows. Where it disagrees with the code, the picture is right.

## Which tool

| The question | The tool |
| --- | --- |
| Is the road network, the terrain or the land use right? | `node scripts/world-preview.ts <seed> out.png` |
| Do the seeds differ from each other? | `node scripts/terrain-sheet.ts 24 sheet.png` |
| How does one city use its land, close up? | `node scripts/landuse-preview.ts <seed> out.png` |
| Does the frame the player sees look right? | `node scripts/render-preview.ts <seed> out.png` |
| Do several seeds look right, in one image? | `node scripts/render-sheet.ts 4 sheet.png` |
| Do the vehicles, the people or the shop goods look right? | `node scripts/render-preview.ts <seed> out.png --gallery=vehicles` |
| Did that change cost frame time? | `node scripts/render-profile.ts <seed>` |
| Is the map or the minimap right? | `node scripts/map-preview.ts <seed> out.png` |
| Do the map icons read at the size they are drawn? | `node scripts/icon-sheet.ts out.png` |
| Whose turf is whose, and how it spreads? | `node scripts/map-preview.ts <seed> out.png --turf --day=8` |
| Does the renderer draw anything at all? | `npm run test:render` |
| Does the browser build the city Node builds? | `npm run test:world` |
| What does it sound like? | `node scripts/audio-check.ts` |

## Framing a subject

`render-preview.ts` takes the picture of one thing — a vehicle, a weapon in the hands, the crowd,
the police, a shop interior, a tram, the sky, a crash and its services. Which flags frame which
subject is in [references/subjects.md](references/subjects.md). Read it before guessing a flag.

`docs/dev-tooling.md` is the full list of every tool and every flag, including the free camera and
the Chrome DevTools MCP server. Read it when the recipe you need is in neither file, and
`docs/browser-checks.md` for what `test:render` and `test:world` measure.

## What to expect

`scripts/chromium.ts` finds the browser on its own, so `CHROMIUM_PATH` needs no setting; set it only
to force a particular Chrome.

A rendered frame draws on the graphics card, through a preview server the first run starts. The
first frame of a seed takes about 10 seconds. The next frame of the same seed takes a quarter of a
second, or 1 to 3 seconds at a new place, so ask for many frames rather than one careful one. A
source file saved in between is picked up. The line each run prints names the adapter: where it
says `swiftshader`, as in a cloud container, a frame takes minutes. `render-sheet.ts` draws every
tile in one browser.

Each run also prints what was in the frame — draw calls, lights, cascades, and the count of
vehicles, pedestrians, buildings, lamps and posters. A thing missing from the picture looks like a
thing never built; a count of zero tells the two apart.

`test:render` draws on SwiftShader, as CI does, and takes about 90 seconds. It answers only
whether the renderer drew a world, not whether it looks right. Run it when a frame looks wrong, to
tell a broken renderer from a broken change.

A black picture used to mean issue #339 rather than your change: the colour grade's table never
reached the GPU on some Chromium builds. That is fixed, and a grade that cannot be uploaded is now
dropped with a warning instead of blackening the frame, so believe a black picture and read the
console the run collected.

`render-profile.ts` needs a real GPU and SwiftShader will not do. GPU timings move by several
milliseconds between runs, so compare two builds by running each more than once.
