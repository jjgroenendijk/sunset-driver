---
name: rendering
description: The gotchas of src/render in Sunset Driver — streaming, batches, cells, quality tiers, TSL, WebGPU, and the meshes of buildings, vehicles, weapons, plants and the crowd. Use before editing anything under src/render, and when a frame looks wrong, a draw call count is too high, a shader fails to compile or a mesh comes back sheared, rotated or invisible.
---

# Changing the renderer

`src/render` reads the world description and never mutates it. `spec.md` sections 9 and 10 are the
design; read the section the issue names before the code.

## The gotchas

Two docs hold what costs a session:

- `docs/rendering.md` — how a frame is put together: streaming, batches and cells, quality tiers,
  smoothing and fading, water, daylight and shadows, post and the colour grade, street lamps.
- `docs/render-entities.md` — what stands in the world: buildings, vehicles, weapons, plants,
  traffic, parked cars and the crowd.

Each opens with a contents list. Read the section the work touches, not the file: `grep -n '^## '`
the doc, then read that range. Both are long, and reading either in full is usually waste.

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
