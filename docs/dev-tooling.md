# Development tools

The one list of what there is to look at the game with. Everything added later goes here.

None of it is part of the game. A tool may read the world, the scene and the record, and none of them may change the simulation: `src/sim` knows about none of this, and a save carries no trace of it.

## The free camera

A camera that flies anywhere on the map while the simulation carries on behind it. It is how a layout, a junction or a tower is looked at from any side without driving there. The game camera of spec section 10.7 does not change: this writes into the same camera while it is detached, and hands it back where the player stands.

| Key | What it does |
|---|---|
| `` ` `` | Detach the camera, or give it back. It is the only key that ends the flight. |
| Mouse click | Ask for the pointer lock again after Escape took it. |
| Mouse | Look, under pointer lock. |
| `W A S D` | Move across the camera's own plane. `W` follows the view, pitch included. |
| `R`, `F` | Rise and fall, whatever the pitch. |
| `Shift` | Fly six times as fast. |
| Wheel | Set the speed, between 2 and 600 metres a second. |

While the camera is detached the keys drive the camera alone: the simulation is stepped with an empty input frame, so the car left behind is not also driven. The streaming rings and the entity fade are measured from the camera, so the ground under it is built rather than left empty; nothing waits for it, and a chunk lands when it is built. The sun's cascades are fitted to it as they are to the game camera.

A frame drawn with the free camera is never a performance measurement. The quality monitor counts none of those frames, and nothing about the camera belongs in `test/budgets.ts`.

Escape does not give the camera back. The browser takes the pointer lock away on Escape and whenever the window loses focus, and the flight carries on without it: the keys still fly the camera, the mouse does nothing, and a click on the canvas asks for the lock again. A hint over the canvas says which of the two states the camera is in and which key ends the flight.

`src/render/free-camera.ts` is where it stands and where it looks. `src/ui/free-camera.ts` is the pointer lock, the mouse and the wheel, and `Keyboard.freeCamera` samples the keys.

## `node scripts/world-preview.ts <seed> out.png`

The world description, drawn flat. Look at the image before judging a layout change.

It draws one colour per road tier — highways black, arterials red, streets blue, alleys green, dirt roads tan — with bridge decks orange, bores through the ground cyan and the interchanges of the highways lime, and strokes the field's major direction, dark where the field is decided and pale where influences cancel. Corridors are outlined too: the ground under a deck in amber with its pillars as dark dots, the tram's lane and route in magenta, its stops pink and its level crossings white. Beaches show their waterline in pale blue and their dune line in sand, with a resort's boardwalk line and car parks in violet and its pier in brown. The footprint of the roads is filled in dark grey under all of it, each parcel in the colour of its owner, and each building's lot in the colour of what stands on it: towers white, mid-rise pale blue, shop rows orange, houses red, warehouses grey, roadhouses violet.

The relief is shaded off the carved ground, not the natural one. The line it prints says how much of the grid the roads moved and what the deepest cut and the highest fill came to.

## `node scripts/render-preview.ts <seed> out.png`

What the game draws, as one frame. Look at the frame before judging a rendering change.

- `--quality` draws it at a quality tier of spec section 9.2 — `full`, `high`, `medium` or `low` — which is the one way to see what a tier does.
- `--x` and `--y` say where the player stands; `--junction=N` stands them at the N-th junction out from the core instead and prints what meets there, and `--tiers=arterial+street` narrows that count to junctions of that mix.
- `--distance` is how far back the camera sits, `--heading` and `--speed` which way it leads, and `--hour` what time of day to light the frame at.
- `--vehicle=<class>` is the class of the roster to stand the player in, `--on-foot` stands them beside it rather than in it, `--damage=<stage>` shows the vehicle dented, smoking, burning or burnt out, and `--skid` lays a drift's worth of marks into the road behind it.
- `--width` and `--height` are the size of the picture.

It prints the lights and shadow cascades the frame cost beside the draw calls.

## `node scripts/render-profile.ts <seed>`

What the frame costs. Measure the frame before judging a performance change.

It draws a few hundred frames, standing still and then driving, and prints the frame times, the draws, and what each long frame compiled or built. Its switches take one part of the frame away — `--no-water`, `--no-shadows`, `--no-lamps`, `--no-post` — so two runs say what that part costs, and `--dpr=2` is what a Retina display draws.

GPU times move by several milliseconds between runs, so compare two builds by running them in turn, more than once each.

## The browser the previews need

Both previews serve the project with Vite and drive a headless Chromium from `playwright-core`, because the renderer needs a real WebGPU device and Node has none. A machine without that browser runs `npx playwright install chromium` once, or points `CHROMIUM_PATH` at a binary.

The profiler needs a hardware WebGPU adapter, so point `CHROMIUM_PATH` at an installed Chrome: SwiftShader draws on the processor and says nothing about a frame.
