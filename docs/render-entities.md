# What the renderer draws

The gotchas of the meshes `src/render` builds for the things standing in the world: buildings,
vehicles, weapons, plants, traffic and the crowd. `spec.md` sections 10, 11 and 13 are the design.
How those meshes reach the screen — batches, cells, quality tiers and the frame budget — is in
`docs/rendering.md`, what lights them after dark is in `docs/lighting.md`, and the one interior the
scene ever holds is in `docs/shops.md`.

## Contents

- Buildings
- The player
- Vehicles and weapons
- Plants
- Posters and hoardings
- Shop signage and billboards
- Traffic, parked cars and the crowd

## Buildings

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
- `building-mesh.ts` is the door onto three files: it generates and places the shell,
  `building-plan.ts` says how big a building is and what ground it may cover, and
  `building-hull.ts` builds the outline. The plan holds no three.js, so a massing is a handful of
  numbers a test can read.
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
  geometry the frame pays for.
- The outline of spec section 10.1 is an inverted hull drawn back-face only, and it is the
  building's massing rather than its facade: it follows the shell band of height by band, so a
  setback is outlined where it stands, and a hull wound the other way would hide the building
  instead of rimming it. `test/building-mesh.test.ts` pins the winding, because nothing else catches
  it before a frame is rendered.
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

## The player

- `character.ts` builds the player of spec section 11.1 from boxes, and hangs them off a rig of
  groups: a hip and a knee each side, a shoulder each side, the torso over the hips, and the body
  itself. The rig stands in its bind pose, so a model nobody animates is a person standing up.
- `character-pose.ts` says what angle every joint takes, and holds no three.js, so the whole of the
  movement is read and tested without a renderer. There are four stances and the record picks
  between them: `stand` breathes, `walk` swings the legs and the arms against each other, `air`
  holds the pose of a jump or a fall, and `swim` lies the body forward and turns the arms. Deep
  water beats the others, because a swimmer is neither on the ground nor falling.
- The cycle is carried by the speed, not by the clock: `advancePhase` turns metres covered into
  radians, so the feet keep pace with the ground at any frame rate and a sprint reads as a run. The
  air has no cycle at all — its pose is read off the speed the body has up.
- A swing of a melee weapon (spec section 11.6) is laid **over** whichever stance is running, so the
  legs keep walking under the blow. `swingOver` writes it: the weapon arm is drawn back, thrown
  through and carried home by `swingAngle`, the torso turns with it, the off arm swings the other
  way, and the body steps into the blow. The turn is about **up** (`yawL`, `yawR`, `twist`), not
  across, because the camera of spec section 10.7 looks straight down: an arm swung forward and back
  reads as nothing from there. How far through the swing the body is comes from `swingOf` in
  `src/sim/melee.ts`, which reads it off the record, so the blow is drawn between two ticks like the
  rest of the frame.
- `HeldWeapon` hangs the weapon off a **hand** group that takes the same `swingAngle`, so the weapon
  sweeps the arc the arm does rather than hanging level through it. Bare fists have no geometry, so
  the arm is the whole of that animation.
- `MeleeFx` (`melee-fx.ts`) throws the burst each blow leaves: one additive batch of discs, drawn
  from `SimState.hits` and coloured by what was struck. It reads the record the way `DamageFx`
  does — every hit newer than the tick it last drew — and `WorldScene.damage` steps both.
- `WorldScene.walkPlayer` is the one door: it stands the model where the frame says and animates it.
  Nothing else writes the player's pose, and a player behind the wheel is not animated at all. The
  model is a handful of meshes rather than a crowd, so it is plain three.js groups and not the baked
  bone texture `pedestrian-rig.ts` needs.

## Vehicles and weapons

- `vehicle-mesh.ts` tells each box of a vehicle which panel it stands on, read off where the box
  sits: above the waist is the roof, either end is the nose or the tail, and out at the flank is a
  door. A box in the middle is the shell and belongs to no panel. `vehicle.ts` then draws the damage
  off the record: a dent pushes in the vertices of every face the blow landed on, the shell's
  included, and only the panel's own boxes can be torn off — a vehicle with no middle is not a
  vehicle. The vertices are moved rather than the geometry rebuilt, and only when the record's
  damage changes.
- `weapon-mesh.ts` is the one place that says what shape each weapon is, and each attachment on it,
  as boxes in the weapon's own frame with the muzzle along `+x`. It holds no three.js.
  `test/weapon-mesh.test.ts` draws every weapon from above on a 5 mm grid and fails when two share a
  silhouette or an attachment changes nothing the camera sees. An extended magazine, a laser and a
  foregrip each carry a part that stands out to the side, because a camera above sees nothing that
  only hangs down.
- `WeaponArt` (`weapon.ts`) merges a weapon's boxes into one geometry with a colour per vertex, and
  keeps one per weapon and attachment list, so the weapon in the hands and every pickup of the same
  kind share it. A pickup (`pickups.ts`) is drawn larger than life over a pale disc: a pistol at the
  scale of a rifle is a speck from the game camera, so a short weapon is scaled up to a metre long.
  The disc writes no depth and stands 15 cm up, or the road surface swallows it. The pickup under
  the mouse grows by `HOVER_GROW`: `frame.ts` casts a ray from the pointer each frame, and
  `PickupModels.pick` walks up from the mesh it hits to the group that carries the pickup's id.
  Nothing caps how many pickups lie at once; a pickup off screen is culled and costs no draw.
- `DamageFx` (`damage-fx.ts`) is the smoke, the flames and the blast of spec section 11.3, as two
  batches of puffs (`puffs.ts`): one blended the ordinary way and one additively. A puff is a square
  turned to the camera of the last frame, which `onBeforeRender` records; `puff-material.ts` cuts a
  soft, ragged shape out of it with noise. Each instance carries a `puff` attribute of fade,
  variant, age and glow, which the batch rewrites every frame. Smoke is lit by the scene, so it goes
  dark at night except where the `glow` of the fire under it lights it. Flame is drawn after smoke
  (`renderOrder`), so it shows through its own plume. A puff is placed and faded from its age alone
  and jittered from `rngFor(seed, tick, Subsystem.Damage, n)`, so a replay burns the way the drive
  did. The pools are fixed, so a fire that burns all day costs what one that burns for a second
  does. The blazes of spec section 20.3 — what a wreck leaves burning on the ground — draw from the
  same two batches, so every fire in a scene costs those two draw calls and no more. `watch` is how
  they are handed in, with the ground under them: a blaze on the record is a place and not a height.
  A blaze throws embers and a column of smoke as well as flame, which is how a fire on the ground
  reads as one rather than as a car alight. Smoke leans with `windHeading(seed)` of `weather-fx.ts`,
  the wind the litter blows in.
- `ShotFx` (`shot-fx.ts`) draws the rounds of `SimState.tracers`: a flash at the muzzle, a glow on
  the ground, a streak per pellet and the spark batch of `melee-fx.ts` where each landed. It is
  three additive batches. The glow is a disc, not a light: a point light turns the clustered path
  on for every fragment in the city (`docs/lighting.md`). `render-preview.ts --shots` shows it.
- `EmergencyView` (`emergency.ts`) draws the fire engines and the ambulances of spec section 20.3
  the way `police.ts` draws the police: instanced bodies off a row of the roster, an outline, and a
  light bar whose colour flips on a beat of the tick. Neither service has a row of its own, so an
  engine is a truck repainted red and an ambulance a van repainted white. They are stepped once a
  tick like the police, so nothing here is evaluated between two ticks.
  `node scripts/render-preview.ts <seed> out.png --emergency` is how a still frame of them is
  taken.
- `SkidMarks` (`skid.ts`) is the rubber a sliding tyre leaves (spec section 11.3): a `DecalGeometry`
  per `SKID_STEP` metres of ground, all of them in one buffer with one material, so a whole drive of
  marks is one draw call. The decal is not cut from the chunk — a chunk's ground is twenty thousand
  triangles and a decal is clipped against every one of them. It is cut from a patch of a few cells
  sampled from the same carve on the same grid, and lifted `SKID_LIFT` clear so the road does not
  hide it. The buffer is a ring: a long drive writes over its own oldest marks.
- Only tarmac takes a mark. `update` is given the same surface the physics grips through — the
  session's `surfaceAt`, which is the city's one `SurfaceIndex` — and a tyre sliding on dirt, sand
  or open ground lays nothing, because none of them holds rubber. A tyre that slides off the road
  and back on leaves two stripes rather than one arc across the verge.
- A mark fades before it goes. Each vertex carries a `rubber` attribute, from 1 when it is laid to 0
  as the ring comes round to it, and the material's `opacityNode` reads it, so the oldest rubber
  thins away over the last `FADE_SHARE` of the buffer instead of going out between two frames. It is
  worked out in `refade` on the processor, once per mark laid, over the whole buffer: that is a few
  thousand floats a few times a second, and it keeps the fade something a test can read back.

## Plants

- `buildPlantModels()` (`plant-mesh.ts`) grows a few models per species once for a world, and
  `PlantScenery` (`vegetation.ts`) packs a chunk's plants into one batch, so a wood costs one draw
  call however many trees stand in it. The trunk and branches of a tree are `TreeGenerator`, which
  grows branches only, so the crown is clumps laid over it; a palm, a shrub and a tuft of dune grass
  are built from end to end there. `ForestGenerator` is not used: it places its own trees by
  altitude and slope, which would stand them on the roads and the lots the parcel model keeps them
  off. A model stands inside the canopy its species claims and a placement never scales one up,
  which is what carries the parcel model's rule through to the frame; `test/plant-mesh.test.ts` pins
  both.

## Posters and hoardings

- The harm-reduction posters of spec section 19. `poster-art.ts` draws all six of them into one
  picture in code, `pixel-canvas.ts` is the buffer and the 5 by 7 font that writes on it, and
  `poster-material.ts` uploads that picture as the one `DataTexture` the whole city shares. There
  are no asset files (spec section 1.2), so the letters are a table of pixel rows.
- `poster-mesh.ts` says which building carries one, from the building's own seed and its district:
  a poorer district carries more, a suburb and the wilderness none. It runs over the placements
  `buildChunkBuildings` answers, before the shells are packed into their batches, because it
  measures the shell that was really built rather than the massing that was asked for.
- A hoarding stands on the front of the roof and leans `BOARD_TILT` back over it. The camera looks
  down at `CAMERA_PITCH`, so a board upright against a wall is a line to it and cannot be read at
  all; leaning it back is what puts its face where the camera is. The small sheet by a door stays
  flat on the wall, where a player on foot reads it.
- `DataTexture` holds its first row at `v` 0 and the art is drawn top row first, so `posterGeometry`
  turns `v` over. Without that the board reads upside down — which the tests cannot see and a
  frame can.
- The atlas is a row of cells with no gutter, so the material carries no mipmaps and the texture
  coordinates stop half a texel inside the cell. Both are there to keep one poster's paper out of
  the next one's edge.
- Looking at one in `render-preview.ts` takes some aiming: the camera's heading is fixed, so only a
  board with open ground to the south of it is in view at all, and a building between the camera
  and the player is cut away unless `--buildings=whole` is passed.

## Shop signage and billboards

- The advertising of spec section 13.1. `sign-art.ts` draws the whole of it into one picture in
  code: a grid with a column per design — the six trades of spec section 16.1, then three
  advertisements — and a row per culture of spec section 8.3. A cell is the pair, so a board says
  what is sold and whose neighbourhood it stands in at once, and every board of a city is one
  texture and one batch.
- Two shapes, both the 4:1 of that cell, which is what lets one atlas serve both. A **fascia** is
  flat on the wall over a shopfront; a **billboard** stands on the front of a roof and leans back
  by `BILLBOARD_TILT`, for the reason the harm-reduction hoardings do. A fascia slides down a low
  wall until it fits under the roof and is dropped where the fit would put it in the doorway, which
  is what keeps a 4 m roadhouse from wearing its sign as a hat.
- A roof may carry a harm-reduction hoarding and a billboard at once, so they take opposite ends of
  it: `posterSide` (`poster-mesh.ts`) is exported for that, and `sign-mesh.ts` takes its negation.
  Neither asks the other what it did.
- Both read the wall through `wallFaceOf` (`wall-face.ts`), which measures the shell that was
  really built rather than the massing that was asked for, and `boardFrame` is the one place a
  lean is turned into a frame. That file is the whole of the arithmetic both of them share.
- A fascia names the trade really behind it wherever the shops landed on that building. The trades
  come from `ChunkLookups.tradeOf`, which the chunk worker fills from the same `buildShops` answer
  it sends the main thread — dealt once, because dealing them walks every building of the map. A
  storefront the shops never landed on still carries a sign: a shop row is a row of storefronts and
  only one of them is enterable.
- Whether a board lights after dark is its zone's business and is carried on the board's own
  vertices, not in a second material. `docs/lighting.md` has the neon.

## Traffic, parked cars and the crowd

- `src/render/traffic.ts` draws the traffic of spec section 13.1 as three `InstancedMesh`es per
  class: the boxes in the row's paint, the trim with its colours per vertex, and the outline. A box
  whose colour is `VehicleSpec.paint` goes into the paint mesh, and the instance colour replaces
  it, so one mesh draws a saloon in every paint. A class with nothing in view is hidden, so it costs
  no draw. The traffic is evaluated at `tick - 1 + alpha`, the moment `smooth.ts` draws the player
  at, and a promoted vehicle is drawn from its record.
- `src/render/signals.ts` draws the traffic lights, and `TrafficView` owns it, so the game and the
  render preview draw them with no wiring of their own. Every head in view is one instance of the
  frame and three of the lens mesh, so the lights cost two draws. The lens colour is set each frame
  from `TrafficSignals.light`. The lenses stand proud of the housing, because the camera sees a head
  from above and would not see a lens set flush in its face.
- `src/render/parked.ts` draws the parked cars with the traffic's own parts, three meshes per class.
  A parked car does not move, so `ParkedView` writes its instances only when the view has moved
  `MOVE` metres, `REFRESH` ticks have passed, or a car was promoted. A frame between those uploads
  nothing. `needsUpdate` on an instance matrix uploads the whole buffer, and at `PARKED_CAP` that is
  about a megabyte a frame.
- `src/render/pedestrians.ts` draws the crowd as one `Mesh` over an `InstancedBufferGeometry`, not
  an `InstancedMesh`. An `InstancedMesh` applies its instance matrix before `positionNode` runs, so
  a shader that skins the body has to do the placing too. `pedestrian-material.ts` reads each
  vertex's bone matrix from the texture `bakeWalks` fills, at two frames of the gait's cycle, blends
  them, and then scales, turns and places the body. It assigns `normalLocal` in the same `Fn`, or
  the lighting sees the bind pose.
- A WebGPU pipeline reads at most eight vertex buffers, and a `BufferAttribute` is a buffer each.
  Over eight, the pipeline fails and nothing is drawn, with only a console error to say so. The
  crowd packs its bone and colour part into one `rig` attribute and its six instance attributes into
  one `InstancedInterleavedBuffer`, and it uploads only the `STRIDE` floats of each person written.
- `AnimationClipCreator` makes no clip that swings a limb, so `walkClip` builds its keyframe tracks
  itself. A test reads the baked texture on the processor with `bakedPoint`: the legs swing against
  each other, and each arm against its leg.
