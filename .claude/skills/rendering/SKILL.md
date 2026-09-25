---
name: rendering
description: The gotchas of src/render in Sunset Driver — streaming, batches, cells, quality tiers, TSL, WebGPU, and the meshes of buildings, vehicles, weapons, plants and the crowd. Use before editing anything under src/render, and when a frame looks wrong, a draw call count is too high, a shader fails to compile or a mesh comes back sheared, rotated or invisible.
---

# Changing the renderer

`src/render` reads the world description and never mutates it. `spec.md` sections 9 and 10 are the
design; read the section the issue names before the code.

## The gotchas

Seven docs hold what costs a session:

- `docs/streaming.md` — how a chunk reaches the screen: the workers, the frame budget, the batches
  and the cells.
- `docs/rendering.md` — how a frame is put together: quality tiers, warming the shaders, smoothing
  and fading, the roads, and water.
- `docs/post.md` — the post chain, the colour grade and getting its cube to the GPU.
- `docs/buildings.md` — how a building is massed, generated and placed.
- `docs/vehicle-bodies.md` — the lofted road vehicles: the hull, the doors and bonnet that open,
  and the glass that is seen through.
- `docs/render-entities.md` — what stands in the world: vehicles, weapons, plants,
  traffic, parked cars and the crowd.
- `docs/lighting.md` — what lights it: daylight and shadows, the street lamps, and the lamps and
  beams a vehicle carries after dark.

Each opens with a contents list. Read the section the work touches, not the file: `grep -n '^## '`
the doc, then read that range. They are long, and reading one in full is usually waste.

## Look at the frame

Never judge a rendering change from the code. Take the picture:

```
node scripts/render-preview.ts <seed> out.png --hour=20
```

Then open it. `docs/dev-tooling.md` has the flags and the other tools — the sheet that compares
seeds, and the profiler that times frames. A performance claim needs `render-profile.ts` numbers,
not reasoning.

## Before you write TSL

`src/render/tsl.ts` is the one door onto `three/tsl`. A chained `a.mix(b, t)` compiles to
`mix(b, t, a)`, which is not what it reads as, and the chained forms do not satisfy `tsc`.
