# Buildings

The gotchas of the meshes `src/render` builds for the buildings of the city: how a building is
massed, how its shell is generated, how it is stood on its lot and how it is outlined. `spec.md`
section 10.3 is the design. What else stands in the world is in `docs/render-entities.md`, how the
meshes reach the screen in `docs/rendering.md`, and what lights them in `docs/lighting.md`.

## Contents

- The shape a building is massed in
- The style a tall building is dressed in
- Building geometry

## The shape a building is massed in

- `shapeOf(seed, kind, massing, shared)` (`building-shape.ts`) says what stands inside a tall
  building's box: a plain extrusion, a step across the frontage, an L, a U, a ring around a
  courtyard, a slim tower on a wider podium, or a stack of setbacks. Every other kind is its
  footprint, extruded. The shape is a list of rectangles, and `building-mesh.ts` builds one
  `SkyscraperGenerator` call per rectangle and stands them together.
- A shape is drawn in **fractions** of the footprint and of the height, never in metres, because
  the same building is laid out on three different rectangles: a generated facade is given the
  massing less its cornices, a block is given the whole massing, and far detail runs the boxes that
  stand to the same height together. `boxesOf(shape, rect, height, chamfer)` is what turns the
  fractions into metres. Keeping the fractions shared is what stops the skyline jumping where the
  detail steps.
- Two rules hold the street wall of spec section 10.3 together, and `test/building-shape.test.ts`
  pins both. The first box covers the whole frontage and stands on the ground, so a row of
  buildings has no daylight between its walls. Every side edge carries a wall from the front of the
  lot to the back of it — except an L's, which cuts its notch out of one back corner, so `planOf`
  draws an L only where that corner has no neighbour against it. A lot walled on both sides is
  built as a box. The seed sweep checks this at mid detail and will fail on a plan that forgets it.
- A plan a lot has no room for falls back to the box. The lots of the core are wide and shallow —
  about 22 m by 16 m at the median — so the plans that split along the depth are rare and `step`,
  which splits along the frontage, is what varies most of the inner ring.
- The podium's tower is built **from the ground**, not from the podium roof, even though the podium
  covers its first storeys. The generator gives every building it builds a ground floor of shops,
  and awnings fifteen metres up read as a mistake; built from the ground, that shopfront is buried
  inside the podium and the two share one wall down to the pavement. A tier of a setback tower has
  nowhere to hide its ground floor, so it is asked for `LEDGE_TIER` and the generator's grand
  arcade instead, which reads as the loggia a setback ledge carries.
- A tier of a setback tower stands on the ledge the tier below caps itself with, and that ledge is
  **measured** off the built geometry with `roofDeckOf` rather than predicted: the generator rounds
  a height to whole floors and a whole floor is four metres. `TIER_OVERLAP` sinks each tier a little
  into the one below, so a measurement that lands low leaves no daylight in the joint.
- Every box offers its roof to the dresser, cut down to the rectangle no other box stands on: a
  podium offers the strip in front of its tower, and a setback tier another tier stands on offers
  nothing, because the ledge it leaves is a ring and the dresser lays out rectangles.
- Neighbours in one row differ in storey height and in bay width, drawn from the building's own
  seed. Both run **upward** from the plainest: a narrower bay is another pier and another window on
  every floor of every tower of the core, and a generated facade is the dearest thing a chunk
  builds. Widening them is what paid for the extra boxes — the quick tier costs a fifth less CPU
  than it did, and the dearest chunk of five seeds costs fewer vertices at near detail than before.

## The style a tall building is dressed in

- `styleOf(building, district, ground, height)` (`building-style.ts`) picks one of the five styles
  of spec section 10.3: classical masonry, a glass curtain wall, a Brutalist slab, an Art Deco stack
  or a Miami pastel block. Each carries a weight drawn from the zone, the district's wealth and
  density and the skyline over the lot, and the building's seed draws from the weights. No style is
  banned anywhere: one glass tower in a poor district is a landlord.
- **Only masonry is generated.** The other four are built from the box kit of `block-shell.ts` by
  `tall-mesh.ts`, so a styled tower joins the **block** batch its cell already draws and costs no
  draw call — `batchOf` says a lot has room for a generated facade, and `buildChunkBuildings` then
  gives that facade only to masonry. `buildingDrawCalls` still counts a facade batch for every such
  lot, because it answers off the chunk alone and cannot know the district.
- Colour follows the style, not the district. `styleColour` holds a palette for each style;
  `tintOf` gives masonry the generator's `pickBuildingColor` as before.
- Masonry weighs four times any one other style. That is not taste: it is what holds the building
  LOD of spec section 9.2 together. A styled tower costs a fifth of a generated facade at near
  detail, so a core of styled towers alone would make near detail so cheap that mid detail could no
  longer cost a tenth of it, and `test/seed-chunks.test.ts` would fail on the ratio rather than on
  the cap. Change the weight and measure that test.
- **Nothing a style lays on a wall reaches out of the box the shape gave it.** The walls are drawn
  in by whatever the relief stands proud — `REACH` in `tall-mesh.ts` — so the relief lands on the
  edge of the massing. A shell that reached past it would be scaled back by `fitOf`, and scaling
  one building for a 0.2 m eyebrow would move every wall of it off the edge it shares.
- A styled wall carries its windows in its **material** and not in its geometry: the panes of a
  curtain wall, the punched windows of concrete, stone and stucco, and the portholes on the cut
  corners of a Miami block are all drawn from the metres a face carries in its `uv`. That is what
  lets mid detail be the massing and the parapet alone and still read as a building at 200 m, and
  it is what keeps mid detail under a tenth of near.
- Every part of that material is lit off **one** noise field and one grid. A field is by far the
  dearest thing the block material evaluates, and styled towers are drawn with it over most of the
  screen. One field for each part cost 56 ms a frame when this was first written, where the
  whole frame costs 18 ms now. Only the width of a column of windows changes from part to part.
- Art Deco asks `shapeOf` for the `setbacks` plan by name, through `planFor`, and falls back to a
  box where the lot has no room for a stack. Its crown and spire stand over the parapet of the top
  tier, so a Deco tower reaches higher than its massing says — the outline hull follows the shell,
  so the camera knows.
- The neon strips of a Deco and a Miami tower are their own `part`. A shader cannot read a
  building's seed, so their colour is drawn from the ground the strip stands over: one building's
  strips are one colour and its neighbour's another.

## Building geometry

- `buildChunkBuildings(chunk, lookup)` (`building-mesh.ts`) is the geometry of a chunk's buildings
  (spec section 10.3), and `BuildingScenery` (`buildings.ts`) packs it into three batches: the
  generated facades, the blocks, and the hulls that outline both. A tower and a mid-rise block are
  `SkyscraperGenerator`; every other kind, and a tower on a lot too narrow for the generator's bays,
  is boxes from `block-mesh.ts`. Nothing ever stands off its lot: the massing is the lot less a
  margin, a generated facade is asked for `CORNICE` less again because its cornices overhang
  whatever footprint it is given, and the placement is then scaled by what the built shell still
  measures. Look at that number rather than trusting it — the sweep does. A tower and a mid-rise
  take their height from `Building.skyline` first, then from the district, then from their seed;
  see `massingOf` in `building-plan.ts`.
- A building stands on the **highest** ground under its lot, not the lowest, and carries a footing
  down to the lowest: `standOf` reads nine places — the four corners, the middle of each side and
  the middle — and `footingGeometry` builds the boxes of the shape that stand on the ground down
  the rest of the fall. The shell is already sunk `FOUNDATION` into the ground, so a fall smaller
  than that asks for no footing at all. Stood on the lowest corner instead, half the buildings of a
  seed were a metre or more into the hill and a tenth of them deeper than a storey. The footing
  joins the block batch, as the roof dressing does, and the hull is outlined down over it.
- `building-mesh.ts` is the door onto four files: it generates and places the shell,
  `building-plan.ts` says how big a building is and what ground it may cover, `building-shape.ts`
  what stands inside that box, and `building-hull.ts` builds the outline. The plan and the shape
  hold no three.js, so a massing is a handful of numbers a test can read.
- `block-mesh.ts` is the door onto the kinds that are not generated: `block-shell.ts` is the kit
  they share — the `Shell` that collects triangles, the `part` numbers the material shades by, and
  the shapes a building of boxes is made of — and each kind has a file, `house-mesh.ts`,
  `shop-mesh.ts`, `warehouse-mesh.ts` and `roadhouse-mesh.ts`. Every variant is drawn from
  `BlockStyle`: the building's own seed, the wealth of its district, and whether the chunk is at
  near or mid detail. Mid detail builds the massing and the roof shape and nothing smaller, because
  a porch is a metre across and the camera is 200 m away.
- `roof-dress.ts` dresses every flat roof (spec section 10.3): a deck material, the plant, and at
  most one use, which a rich district carries more often. The dressing is a geometry of its own,
  not part of the shell, and it joins the block batch of the cell — so a generated tower's chunk
  pays for the block batch even when it holds no block, which `buildingDrawCalls` counts. Keeping
  it out of the shell is what keeps a six-metre mast out of the outline hull, and so out of the box
  `roofs.ts` writes and the camera climbs. A generated tower has no known deck, so `roofDeckOf`
  measures one off each box of its shape: the highest flat plane that is a slab rather than a ring,
  which is that box's crown slab and not the cornice over it. A building of several boxes is
  dressed on each of them, each from its own draw, so a podium terrace and the tower over it do not
  carry the same water tank in the same corner.
- The margin is not taken on a side edge the lot shares with another lot, which `Building.shared`
  says (spec section 10.3). Past that edge stands the neighbour's wall, and a margin on both sides
  of it is a slot cut through the street wall. A lot walled on one side only is then not centred on
  itself, which is `BuildingMassing.offset`.
- A generated facade comes back narrower than the massing it was asked for, because its cornices
  overhang by less than the whole `CORNICE` they are allowed, so a wall would still stop about a
  metre short of an edge it shares. `fitOf` stretches it along the frontage by what it measures
  short, up to `MAX_STRETCH`. Widening the footprint instead would add a bay to every tower of the
  core: measured on the dearest of four seeds, the whole cornice back costs 8.7 % more vertices in
  that chunk and the stretch costs nothing. `standingGround(building)` is the ground a shell may
  cover — the lot, and a centimetre of float error past each shared edge — and it is what both
  sweeps ask. A shared edge never faces a road, so none of this puts a wall on the carriageway.
- A lot on a bend is a trapezoid or a parallelogram, and a box inside it cannot reach both of its
  side edges. So a lot that shares a side edge has its shell and hull leaned (`leanOf` in
  `building-plan.ts`): each place moves along `x` by an amount linear in `x` at its depth, which
  maps the massing's sides onto the lot's side edges. A shear in the matrix cannot do this, because
  a trapezoid is wider at one end. The normals and the facade's `roomCenter` are leaned with the
  places. `node scripts/wall-gaps.ts <seed> [near|mid|far]` measures the daylight left at each
  shared edge around the core.
- A generated facade carries the room behind each window in its vertices: `roomCenter` and
  `roomSize`, baked by the generator in the building's own frame. The material casts the view ray
  into that box against `positionLocal`, and hashes the room's furniture off `roomCenter`. So a
  batch has to move `roomCenter` with the building as it moves its positions, which `batch.ts` does.
  `BatchNode` never did — it rewrites `positionLocal` and nothing else — so every tower of a seed
  used to look into a room that was not there, and every tower with the same room layout was
  furnished identically.
- A building's own frame has the middle of its lot at the origin, `x` along the frontage, `z`
  towards the road and `y` up from the lowest corner of the lot. The generator's bays and floors are
  wider than a real tower's, because the camera looks down from 60 m and a window it cannot see is
  geometry the frame pays for; `BAY_WIDTH` and `FLOOR_HEIGHT` in `building-shape.ts` are the
  plainest of them.
- The outline of spec section 10.1 is an inverted hull drawn back-face only, and it is the
  building's massing rather than its facade: it follows the shell band of height by band, so a
  setback is outlined where it stands, and a hull wound the other way would hide the building
  instead of rimming it. `test/building-mesh.test.ts` pins the winding, because nothing else catches
  it before a frame is rendered.
- The hull is laid out on the shape's own ring, so an L and a U are outlined round their notch. Two
  things in `building-hull.ts` are what make a ring that is not convex work. Each face is measured
  from the shell that stands **along it** and not from the whole shell, because a face that looks
  into a notch has the far wing as the furthest thing in its direction and the notch would fill in;
  a face with nothing standing along it in a band is pushed out until it binds on nothing, and the
  ring then closes on its neighbours, which is what drops the notch of an L above the wing that
  cuts it. And the caps are triangulated rather than fanned from one corner. A courtyard is given
  its outer rectangle: an outline is the silhouette a building cuts against the ground, and the
  hole in the middle of a block is not one.
- `building-material.ts` holds the three materials and the one `night` uniform they share: the glass
  of every building is picked out, some of it is lit, and the whole of it is multiplied by that
  uniform. It is 0 by daylight, and `WorldScene.time` sets it off the day and night cycle.
- `cutaway.ts` cuts a building that hides the player (spec section 10.7) with the dither of
  `fade.ts`. Inside the cone the shell keeps `GHOST` of its pixels and the outline hull is cut away
  whole, or its dark shows through the holes. The building the camera is inside is cut away whole,
  because even a ghost of walls on every side veils the screen. It is known from `roofs.ts`: each
  chunk payload carries one turned box per building, because the batches cannot say which building a
  triangle belongs to. `WorldScene.roofOver` reads the boxes of the nine chunks around a point. The
  cut sits in `opacityNode` and `alphaTestNode` on every building material, so the Off setting sets
  a uniform to 0 and rebuilds nothing. The shadow pass does not see the cut, so a ghost casts its
  whole shadow.
