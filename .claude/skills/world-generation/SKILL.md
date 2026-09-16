---
name: world-generation
description: The gotchas of src/world in Sunset Driver — terrain, islands, rivers, the road network, beaches, parcels, buildings, junctions, the carve, ribbons, vegetation and chunked generation. Use before editing anything under src/world, and when a seed produces a broken map, a road that will not trace, a parcel with no frontage or a sweep that fails on one seed.
---

# Changing world generation

`src/world` must run headless in Node, because the seed sweeps import it: three.js math and the
generators are fine, the renderer, Rapier and the DOM are not. It produces a plain world
description. `spec.md` sections 6 and 7 are the design.

It is also under the determinism rules: no `Math.random()`, no iteration over a `Set`, a `Map`,
`for-in` or `Object.keys`. Use `rngFor` and the helpers in `src/core/sort.ts`. The lint hook catches
a slip at the edit.

## The gotchas

- `docs/world-generation.md` — the map skeleton, beaches, parcels and buildings, junctions and road
  beds and the carve, ribbons and vegetation, chunks and the sweeps.
- `docs/roads.md` — the tensor field, tracing, highways, the tiers and the fill, interchanges and
  crossings, the graph and the footprint.
- `docs/corridors.md` — the corridors, the piers under the decks and the tram track.

Each opens with a contents list. Read the section the work touches, not the file.

## Look at the map

A layout change is judged from the picture, never from the code:

```
node scripts/world-preview.ts <seed> out.png
node scripts/terrain-sheet.ts 24 sheet.png
```

One preview hides that every seed looks alike; the sheet is what shows it. `docs/dev-tooling.md` has
the rest.

## The sweep

A change here is measured across seeds. `npm test` runs the quick tier and `SWEEP_SEEDS=200
npm run test:full` the full one. Never make a test slower to make it pass.
