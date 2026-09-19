# Development tools

The one list of what there is to look at the game with. Everything added later goes here.

None of it is part of the game. A tool may read the world, the scene and the record, and none of
them may change the simulation: `src/sim` knows about none of this, and a save carries no trace of
it.

## Contents

- The free camera
- `node scripts/world-preview.ts <seed> out.png [--tiers=highway]`
- `node scripts/terrain-sheet.ts [count] out.png [--cols=6] [--tile=160]`
- `node scripts/landuse-preview.ts <seed> out.png`
- `node scripts/render-preview.ts <seed> out.png`
- `node scripts/render-sheet.ts <count> out.png [--cols=3] [--tile=480]`
- `node scripts/render-profile.ts <seed>`
- `node scripts/audio-check.ts`
- `npm run test:render`
- `npm run test:world`
- The browser the previews need
- The Chrome DevTools MCP server

## The free camera

A camera that flies anywhere on the map while the simulation carries on behind it. It is how a
layout, a junction or a tower is looked at from any side without driving there. The game camera of
spec section 10.7 does not change: this writes into the same camera while it is detached, and hands
it back where the player stands.

| Key | What it does |
|---|---|
| `` ` `` | Detach the camera, or give it back. It is the only key that ends the flight. |
| Mouse click | Ask for the pointer lock again after Escape took it. |
| Mouse | Look, under pointer lock. |
| `W A S D` | Move across the camera's own plane. `W` follows the view, pitch included. |
| `R`, `F` | Rise and fall, whatever the pitch. |
| `Shift` | Fly six times as fast. |
| Wheel | Set the speed, between 2 and 600 metres a second. |

On a touch browser the camera is flown with the pad of `src/ui/touch-fly.ts` instead. There is no
pointer lock to ask for — iOS Safari has never had one — so the view is turned by dragging anywhere
on the screen, the stick under the left thumb moves the camera, a pinch sets the speed, and the keys
down the right edge rise, fall and go fast. The flight is started and ended from the bar of
`src/ui/touch-bar.ts` rather than from `` ` ``. `docs/menus.md` holds the rest of what a phone
changes.

While the camera is detached the keys drive the camera alone: the simulation is stepped with an
empty input frame, so the car left behind is not also driven. The streaming rings and the entity
fade are measured from the camera, so the ground under it is built rather than left empty; nothing
waits for it, and a chunk lands when it is built. The sun's cascades are fitted to it as they are to
the game camera.

A frame drawn with the free camera is never a performance measurement. The quality monitor counts
none of those frames.

Escape does not give the camera back. The browser takes the pointer lock away on Escape and whenever
the window loses focus, and the flight carries on without it: the keys still fly the camera, the
mouse does nothing, and a click on the canvas asks for the lock again. A hint over the canvas says
which of the two states the camera is in and which key ends the flight.

`src/render/free-camera.ts` is where it stands and where it looks. `src/ui/free-camera.ts` is the
pointer lock, the mouse, the wheel and the touch pad, and `Keyboard.freeCamera` samples the keys.

## `node scripts/world-preview.ts <seed> out.png [--tiers=highway]`

The world description, drawn flat. Look at the image before judging a layout change.

It draws one colour per road tier — highways black, arterials red, streets blue, alleys green, dirt
roads tan — with bridge decks orange, bores through the ground cyan, the slots of the highways pale
yellow and their interchanges lime. It strokes the field's major direction, dark where the field is
decided and pale where influences cancel. Corridors are outlined too: the ground under a deck in
amber with its pillars as dark dots, the tram's lane and route in magenta, its stops pink and its
level crossings white. Beaches show their waterline in pale blue and their dune line in sand, with a
resort's boardwalk line and car parks in violet and its pier in brown. The footprint of the roads is
filled in dark grey under all of it, each parcel in the colour of its owner, and each building's lot
in the colour of what stands on it: towers white, mid-rise pale blue, shop rows orange, houses red,
warehouses grey, roadhouses violet.

`--tiers=highway+arterial` draws those tiers and nothing of the others: their roads, their
interchanges and the corridors along them. The footprint, the parcels and the buildings are left
out, because they are cut from every tier at once.

The relief is shaded off the carved ground, not the natural one. The line it prints says how much of
the grid the roads moved and what the deepest cut and the highest fill came to.

## `node scripts/terrain-sheet.ts [count] out.png [--cols=6] [--tile=160]`

The terrain of many seeds on one sheet: sea in blue, land shaded by height, one small map per seed.
Judge a change to the terrain archetypes here, not seed by seed in the world preview. One preview
at a time hides that the maps all look alike.

The seeds are the sweep's, in order. It builds the terrain alone, without roads, so 80 seeds take
about 20 s. The console lists each tile with its seed, its archetype, its island count and the share
of the map that is dry land. `test/layout-bands.ts` holds that share to `LAND_FRACTION`, and each
archetype holds it to its own `landFraction`.

## `node scripts/landuse-preview.ts <seed> out.png`

How a city uses its land, close up. The world preview draws the whole map, where a downtown block is
a few pixels; this draws a few hundred metres of it, so a block reads as ground rather than as a
dot. It runs headless, like the world preview, and needs no browser.

- `--half` is how much ground to draw, in metres from the middle to each edge. The default 350 is a
  readable seven hundred metres across.
- `--x` and `--y` are where to centre it. The default is the core.
- `--width` is the side of the picture in pixels, which is what sets how many metres a pixel covers.

It draws three layers, each over the one before: the road footprint in dark grey, then each parcel
in the colour of its owner, then each building lot in the colour of what stands on it. The colours
are the ones the world preview uses. What the picture is for is the three shares — how much of it is
road, how much is parcel with nothing on it, and how much is building.

Under the picture it prints those shares as numbers, for every zone of the whole map and not only
for the part it drew: the ground the roads claim, the ground the parcels claim, the ground the lots
cover, the ground a junction apron or a corridor takes on top of the carriageways, the buildings per
hectare and the middle parcel size. `test/layout-bands.ts` pins each of them to a band per zone and
`test/seed-layout.test.ts` fails when a seed falls outside it, so a layout change is judged by the
picture and the numbers together.

The shares are sampled off a grid, one reading per cell, and never added up from polygon areas: the
pieces of the footprint overlap at every junction, so their areas together count an apron once per
road that meets there. `scripts/land-use.ts` is that grid and `scripts/layout-metrics.ts` the
numbers read off it; the sweep reads the same two files.

## `node scripts/render-preview.ts <seed> out.png`

What the game draws, as one frame. Look at the frame before judging a rendering change.

- `--quality` draws it at a quality tier of spec section 9.2 — `full`, `high`, `medium` or `low` —
  which is the one way to see what a tier does.
- `--x` and `--y` say where the player stands; `--junction=N` stands them at the N-th junction out
  from the core instead and prints what meets there, and `--tiers=arterial+street` narrows that
  count to junctions of that mix.
- `--distance` is how far back the camera sits, `--heading` and `--speed` which way it leads, and
  `--hour` what time of day to light the frame at.
- `--vehicle=<class>` is the class of the roster to stand the player in, `--on-foot` stands them
  beside it rather than in it, `--damage=<stage>` shows the vehicle dented, smoking, burning or
  burnt out, and `--skid` lays a drift's worth of marks into the road behind it. The arc it
  drives is laid over the real ground, so the marks stop where the tarmac does.
- `--emergency` puts the services of spec section 20.3 in the frame: a blaze in the road ahead, a
  fire engine standing at it and an ambulance behind. They are put down rather than driven to,
  because a preview is one frame and a call takes the best part of a minute.
- `--stance=<name>` holds the player in one stance for the picture — `stand`, `walk`, `air` or
  `swim` — which is the one way to look at the movement of spec sections 11.2 and 11.5 in a still
  frame. The frame is taken a quarter of the way through the cycle, where the swing is widest.
- `--swing=<share>` holds the player part way through a swing of a melee weapon, 0 to 1 (spec
  section 11.6). The blow is thrown and over in a fifth of a second, so a still is the only way to
  look at it; `--swing=0.4` is the moment it lands. It reads best with `--weapon` and `--on-foot`,
  and it lays over whatever `--stance` asks for.
- `--weapon=<id>` puts a weapon of the arsenal in the hands, drawn with `--on-foot`, and
  `--attachments=suppressor+optic` fits to it what it takes. `--aim` holds it at the shoulder.
  `--pickups` lays every weapon in rows below the player, fitted with the same attachments, which is
  how the silhouettes are compared from the game camera. `--hover=N` draws the N-th of them grown,
  as the pickup under the mouse is.
- `--tram` stands the player beside the first tram at the hour of the picture, and `--stop=N` at
  the N-th tram stop, where its queue waits.
- `--shop=<trade>` stands the player inside the nearest shop of that trade — `weapons`, `workshop`,
  `convenience`, `clothing`, `clinic`, `broker`, or `any` — with the vehicle left at the kerb. It is
  the one way to look at an interior (spec section 16.1), and it moves the frame off `--x` and
  `--y`: the line the run prints says where it ended up. A room is about 7 m across, so
  `--distance=22` is the frame that holds it.
- `--width` and `--height` are the size of the picture.

It prints the lights and shadow cascades the frame cost beside the draw calls, and how many
vehicles of the traffic, parked cars and pedestrians it drew.

## `node scripts/render-sheet.ts <count> out.png [--cols=3] [--tile=480]`

What the renderer makes of many seeds, as one grid. Use it to compare seeds, not to judge a
rendering change: a tile is too small to see a shadow edge or a material in, and a full-size frame
from `render-preview.ts` is what that needs.

The seeds are the seeds of the sweep, in order, so a tile is a world the tests read. `--seeds=7,9`
names them instead, for looking at the ones a failure named. `--hour`, `--x`, `--y`, `--distance`
and `--quality` mean what they mean for `render-preview.ts`.

One browser draws every tile, which is most of the saving: starting it costs more than a frame.
Four tiles take about 45 seconds together, against about 50 seconds each on their own.

## `node scripts/render-profile.ts <seed>`

What the frame costs. Measure the frame before judging a performance change.

It draws a few hundred frames, standing still and then driving, and prints the frame times, the
draws, and what each long frame compiled or built. It runs the warm-up of `src/render/warm.ts`
first, as a session does, so a long frame here is a long frame in the game and not one the game
had already paid for behind its loading screen. Its switches take one part of the frame away —
`--no-water`, `--no-shadows`, `--no-lamps`, `--no-post` — so two runs say what that part costs, and
`--dpr=2` is what a Retina display draws. `--tier-at=150:high,300:full` changes quality during the
drive, at the drive frames named, the way the game's own monitor changes it — which is how a tier
change is timed, by what the frames around it compiled. `--memory` adds what the GPU and the page
hold, settled and at the most over the drive; `docs/performance.md` has the numbers it gave.

GPU times move by several milliseconds between runs, so compare two builds by running them in turn,
more than once each.

## `node scripts/audio-check.ts`

What the game sounds like, as numbers. A headless run has no ears, so this is the meter: it renders
a made-up moment of each kind — the engine idling and at speed, the horn, sliding tyres, sirens, a
gunshot, a swing, a collision, an explosion, a footfall, a tram bell, and the lot at once — through
an offline audio context and prints the peak, the loudness and how much of it was silence.

Run it after changing a voice or a level in `src/audio`. It fails on a case that should make a
sound and is silent, which is what a node that was never connected looks like, and on one that
clips. The cases live in `src/audio/offline.ts` and each drives the real planner and the real mixer.

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

**It fails in some cloud sessions, and that is issue #339, not your change.** The colour grade's
table is a 3D texture, and on some Chromium builds the upload is refused: the cube stays as it was
allocated — all zeros — and the grade maps every colour to black. A session that hits it sees this,
and `render-preview.ts` writes a black picture beside it:

```
  1 colours, under 64: the frame is blank or nearly so
```

Which build decides it. The Chromium a cloud container carries at `/opt/pw-browsers` shows it; the
one `playwright-core` installs on `ubuntu-latest` does not, which is why CI is green. Before
believing this check about your own change, read what it printed: the grade failure blanks the
frame completely, so it fails all three measures at once and fills the console with a WebGPU
validation error naming a 16x16x16 `RGBA16Float` texture.

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

## The browser the previews need

Both previews serve the project with Vite and drive a headless Chromium from `playwright-core`,
because the renderer needs a real WebGPU device and Node has none.

`scripts/chromium.ts` finds that browser, and no session should have to set a path by hand.
`playwright-core` ships no browser: it names the build it was released against, and the machine
holds whatever build some earlier install put there. The two disagree after every `playwright-core`
bump, so the named path is only a hint. The resolver searches the whole browser cache for any build,
on every platform layout, and takes an installed Chrome when the cache holds none.

The profiler asks for a hardware WebGPU adapter, so it takes an installed Chrome first and the
cached build second: the cached build falls back to SwiftShader, which draws on the processor and
says nothing about a frame.

A machine with no browser at all runs `npx playwright install chromium` once. `CHROMIUM_PATH`
overrides the search, and the error names every place that was looked in.

## The Chrome DevTools MCP server

`.mcp.json` gives Claude Code the Chrome DevTools MCP server. The agent opens the game in a browser,
reads the console, takes screenshots, runs JavaScript in the page and records performance traces.
Use it to find out why a frame is wrong. Use the scripts above to answer the same question again:
they are seeded and repeatable, and a session with the server is not.

Claude Code asks once before it starts a server from `.mcp.json`. `/mcp` shows whether it runs.

`scripts/devtools-mcp.ts` starts it. The script takes the browser from `scripts/chromium.ts` and
asks for a hardware adapter, so an installed Chrome is used first. Each session gets a temporary
profile, so sessions in parallel worktrees do not share one. On Linux with no display, as in a cloud
container, the browser runs headless and draws WebGPU through SwiftShader.

The game needs a secure context for WebGPU. Open it on `localhost` from `npm run dev`:
`about:blank` and a LAN address have no `navigator.gpu`. Usage statistics and the CrUX lookup of
trace URLs are off. The server version is pinned in the script; raise it there.
