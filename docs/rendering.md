# Rendering

The gotchas of `src/render`: what three.js 0.186 and WebGPU refuse, what is packed into a batch and
why, and how a chunk, a quality tier and the frame budget fit together. `spec.md` sections 9 and 10
are the design.


- The city is streamed in workers (spec section 9.1). `ChunkPool` (`chunk-pool.ts`) sends each
  worker the world description, the worker builds its own layers, and it answers with a
  `ChunkPayload` (`chunk-payload.ts`): typed arrays and no three.js object, handed over rather than
  copied. `chunk-worker.ts` may therefore import only what runs without a DOM, a renderer or a
  material, as `src/world` may.
- The main thread pays only for the upload. `WorldScene.update` runs the queue against `spendBudget`
  (`streaming.ts`) and a batch is filled a step at a time, so a chunk of the core lands over several
  frames. A step is indivisible and is the only thing that overruns the streaming slice;
  `BUDGET_MS.chunkUpload` is how far it may. A step copies at most `MAX_STEP_VERTICES` (`batch.ts`),
  so that overrun is a number the renderer chose and not the largest tower a seed happens to build —
  a core chunk carries towers of 33 000 vertices, which is sixteen steps. A part larger than a step
  is copied over several of them and is drawn only once its last step is in, because the index is
  what the renderer reads its vertices through. Cutting a part costs nothing: the chunk spends the
  same total either way. The worker also allocates the buffers each batch copies its parts into
  (`PackedBatch.storage`), and `fillOfPacked` merges the batch into them. A batch left to allocate
  its own does it inside its first part: tens of megabytes in one frame, and the piece a collection
  lands in.
- Nothing is built on the frame thread any more, so `WorldScene.settle(x, y, radius)` is how the
  game and the preview wait for the ground under the player.
- The far ring is the same chunk at `'far'` detail: the ground, the highways and arterials over it,
  and every building as a block, with no outline and no plants. A chunk that crosses between the
  rings is built again and swapped when it lands, so nothing disappears while its replacement is
  built.
- `quality.ts` is the quality-tier system of spec section 9.2: `QUALITY_TIERS` is the table, dearest
  first, and `QualityMonitor` the frame-time monitor that walks it. The monitor is pure — it takes a
  frame length and answers a tier when it changes one — so the policy is tested headless; `main.ts`
  hands the tier to `WorldScene.quality` and `PostChain.quality` and logs the change. The judgement
  is the median of a window of 30 frames, so one dear frame cannot step the city down, a tier is
  dropped on one bad window and raised only after four good ones, and the window after a change is
  thrown away. A window is missed when its median runs a quarter over the budget, never when it
  merely passes it: a frame is timed from one animation frame to the next, so a 60 Hz display that
  makes every refresh measures 16.7 ms against a 16 ms budget, and judged without that room every
  such display walked down to the lowest tier. `?budget=6` holds a session to a frame no machine
  makes, which is how a tier change is watched. `FRAME_BUDGET_MS` is the whole 16 ms frame, not a
  slice of it.
- A tier moves five things at once, because stepping one at a time takes five windows to reach the
  tier one window away: the render scale and the effects (`post.ts`), the two streaming rings, how
  far the sun's shadow reaches and what it is drawn at (`sky.ts`; the cascade count is fixed,
  because changing it rebuilds every shader), and how much of `ENTITY_CAPS` a chunk places. The near
  ring gives way before the far one, so the city never visibly ends nearer. Nothing already in the
  scene is rebuilt on a change: chunks past the new far ring are dropped and chunks that cross
  between the details are asked for again, and a chunk still standing keeps the plants it was built
  with.
- `RenderSmoother` (`smooth.ts`) is what makes the motion smooth. The simulation is a fixed 60 Hz
  and a display refreshes at its own rate, so a frame takes 0, 1 or 2 steps: drawn on the last tick,
  the player moves on some frames and not on others while the camera slides on every one. `main.ts`
  captures the pose before each step and draws the blend of the last two ticks at
  `FixedStepClock.alpha`. The frame is therefore one tick behind the record, which is 16.7 ms and
  the price of a frame that holds still. Nothing is written back, so a replay is unchanged. The
  camera smooths its focus exponentially rather than by a factor linear in the frame length, or the
  millisecond a frame varies by becomes camera movement.
- `EntityFade` (`fade.ts`) is the Bayer dither fade of spec section 9.2. It is one distance and one
  focus shared by the plants and the lamps, set as uniforms, so a tier change moves every category
  and rebuilds no material. A material is dressed by putting the fade in `opacityNode` and the
  dither in `alphaTestNode`, which is the discard `NodeMaterial` already does; nothing is blended,
  so nothing is sorted. The ring is measured from the player and never from the camera, because the
  streaming rings are. The shadow pass cannot follow the fade and there is no hook that makes it:
  three.js draws the whole scene through one override material shared by every object and copies
  only the numeric `alphaTest` across, and `maskShadowNode` does not help because that material's
  nodes are reassigned per object without its version changing. `shadowDistance(tier)` is what keeps
  the two in step — the sun's cascades stop before the band starts — so a plant thinning out never
  leaves its shadow on empty ground. The 4×4 matrix is built by its own recursion rather than read
  from `three/addons/tsl/math/Bayer.js`, which loads a texture from a data URL; the screen
  coordinate is wrapped to the tile before it is squared, or a coordinate in the thousands leaves no
  fraction in a 32-bit float and the pattern comes out in bands.
- Chained TSL expressions do not satisfy `tsc`, so `src/render/tsl.ts` is the one door onto
  `three/tsl` (spec Appendix A). Add the helper you need there and import `three/tsl` nowhere else.
  The post-processing nodes of `three/examples/jsm/tsl/display/` come through the same door.
- three.js 0.186 sends `GPUTextureViewDescriptor.swizzle` as a string, and a browser that has made
  it a dictionary throws on every `createView`, so nothing is ever drawn. `renderer.ts` drops the
  field where the browser refuses it. Delete that shim once three.js sends the dictionary.
- `buildChunkRoads(chunk, ribbons, heightAt)` (`road-mesh.ts`) lofts a chunk's roads (spec section
  10), with the cross section and the markings table in `road-section.ts` and the junction surfaces
  in `junction-mesh.ts`: one `LoftGeometry` per piece of a run, with carriageway, verge, kerb and
  pavement in one cross section, one bevel per turn too sharp to mitre and all of a run's bevels in
  one part, a deck and parapets under each bridged stretch, and a portal at each mouth of a bore.
  `trimRun` first cuts every run at its curve's gaps, and each junction the chunk owns is drawn as
  one carriageway polygon fanned from the node, paved as its widest road, plus a piece of pavement
  per corner in the batch of the wider of its two roads. The polygon's mouth vertices are the very
  sections the lofts end on, so the two meet without a seam whichever chunk built each; its corners
  stand on the carve, which is the junction's plane. The far ring draws neither junctions nor gaps.
  The whole cross section stands over the bench rather than on it, the verge of a tier without a
  pavement included: a surface laid at exactly the height of the ground under it is one the ground
  shows through wherever the grid samples it. A vertex carries how far across the road it stands;
  `road-material.ts` steps between the bands at the tier's own widths and holds the road colours, as
  `ground.ts` holds the ground's. A dash pattern is measured from the start of the whole curve, so
  it carries on across a boundary.
- `RoadScenery` (`roads.ts`) packs each tier of a chunk into one batch, and that tier's markings
  into one `LineSegments2`. `batch.ts` is the one place geometry is packed into a batch, and a batch
  is one merged `Mesh`, never a `BatchedMesh`: it merges the parts into the storage the worker
  allocated, each at its place in the world, releases each as it goes, and hands the copies back as
  the steps the frame budget runs. A batch is not drawn until its first part is in, because an empty
  one has no attributes and the renderer would compile a shader for that shape of geometry.
- **A `BatchedMesh` is a trap on WebGPU in three.js 0.186.** It is drawn as one draw call per
  instance, after its instances are culled and sorted on the processor, in every pass: the view,
  each shadow cascade and the water's mirror. Its shaders are keyed on the batch itself, so a batch
  that comes into view in a pass for the first time builds them again, at 25 to 35 ms. Neither the
  GPU-side culling nor the single draw that spec section 9.2 asks for is what the class does today.
  A merged mesh shares its shaders with every chunk in the same material and is one draw, and
  per-chunk bounds are what culls it. `chunkDrawCalls(chunk)` (`chunk-cost.ts`) is what a chunk
  costs — the ground, the road batches, the building batches, the one batch of plants and the one
  batch of street lamps — and `CHUNK_DRAW_CALL_CAP` is the most it may; the HUD shows the dearest
  chunk built. A count over the cap is a batching regression, not a cap to raise.
- `buildChunkBuildings(chunk, lookup)` (`building-mesh.ts`) is the geometry of a chunk's buildings
  (spec section 10.3), and `BuildingScenery` (`buildings.ts`) packs it into three batches: the
  generated facades, the blocks, and the hulls that outline both. A tower and a mid-rise block are
  `SkyscraperGenerator`; every other kind, and a tower on a lot too narrow for the generator's bays,
  is boxes from `block-mesh.ts`. Nothing ever stands off its lot: the massing is the lot less a
  margin, a generated facade is asked for `CORNICE` less again because its cornices overhang
  whatever footprint it is given, and the placement is then scaled by what the built shell still
  measures. Look at that number rather than trusting it — the sweep does.
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
- `vehicle-mesh.ts` tells each box of a vehicle which panel it stands on, read off where the box
  sits: above the waist is the roof, either end is the nose or the tail, and out at the flank is a
  door. A box in the middle is the shell and belongs to no panel. `vehicle.ts` then draws the damage
  off the record: a dent pushes in the vertices of every face the blow landed on, the shell's
  included, and only the panel's own boxes can be torn off — a vehicle with no middle is not a
  vehicle. The vertices are moved rather than the geometry rebuilt, and only when the record's
  damage changes.
- `DamageFx` (`damage-fx.ts`) is the smoke, the flames and the blast of spec section 11.3, as two
  batches of flat discs: one blended the ordinary way and one additively. A puff is placed and
  coloured from its age alone and jittered from `rngFor(seed, tick, Subsystem.Damage, n)`, so a
  replay burns the way the drive did. The pools are fixed, so a fire that burns all day costs what
  one that burns for a second does.
- `SkidMarks` (`skid.ts`) is the rubber a sliding tyre leaves (spec section 11.3): a `DecalGeometry`
  per `SKID_STEP` metres of ground, all of them in one buffer with one material, so a whole drive of
  marks is one draw call. The decal is not cut from the chunk — a chunk's ground is twenty thousand
  triangles and a decal is clipped against every one of them. It is cut from a patch of a few cells
  sampled from the same carve on the same grid, and lifted `SKID_LIFT` clear so the road does not
  hide it. The buffer is a ring: a long drive writes over its own oldest marks.
- `buildPlantModels()` (`plant-mesh.ts`) grows a few models per species once for a world, and
  `PlantScenery` (`vegetation.ts`) packs a chunk's plants into one batch, so a wood costs one draw
  call however many trees stand in it. The trunk and branches of a tree are `TreeGenerator`, which
  grows branches only, so the crown is clumps laid over it; a palm, a shrub and a tuft of dune grass
  are built from end to end there. `ForestGenerator` is not used: it places its own trees by
  altitude and slope, which would stand them on the roads and the lots the parcel model keeps them
  off. A model stands inside the canopy its species claims and a placement never scales one up,
  which is what carries the parcel model's rule through to the frame; `test/plant-mesh.test.ts` pins
  both.
- `buildWaterAttributes` (`water.ts`) is one sheet of water for the whole map, not a layer of each
  chunk: the `WaterMesh` addon mirrors the scene in a second pass, and one is all the frame can pay
  for. The sheet is built in the local plane and laid flat by a quarter turn about X, so a local
  point `(x, y)` is the world place `(x, -y)`; the turn is what puts the normal up, and the mirror
  takes its plane from that. A vertex carries the deepest ground within half a cell of it, so a
  channel narrower than the grid is not left dry, and the depth is what fades the surface out at a
  shore.
- `daylightAt(tick)` (`daylight.ts`) is the day and night cycle of spec section 10.5: the sun's
  place, its colour and strength, the sky fill, the haze, how lit the windows are and how far on the
  street lamps are, all read off how high the sun stands. It is pure, so the tests run it headless.
  `SkyLighting` (`sky.ts`) turns it into the `SkyMesh` dome, one directional light with
  `SHADOW_CASCADES` cascades and the fog; `WorldScene.time = tick` is the only way in, and one game
  day is 24 real minutes.
- A shadow map is drawn again for every camera a frame renders with, and the water's mirror is a
  second camera. The cascades are fitted to the player's camera whichever camera asks, so the second
  draw is the same map twice: `sun.shadow.autoUpdate` is off and `SkyLighting.drawShadowOnce`,
  called once a frame from `WorldScene.look`, is what asks for them. A sun with no strength asks for
  nothing, so a night frame draws no shadow at all. `SHADOW_DISTANCE` is view depth, and it is what
  the camera can see rather than what the haze reaches: past it a cascade draws every building again
  for ground nobody looks at.
- `CSMShadowNode` holds a shadow edge still by snapping each cascade's centre to a texel grid, and
  it builds that grid in the light's own frame. So the snap only holds while the light stands still,
  and a game day of 24 real minutes turns the sun a quarter of a degree a second. `SkyLighting.set`
  therefore moves the sun the shadow is cast from in steps of `SUN_SHADOW_STEP`, while the dome, the
  colours and the haze follow the true sun every frame. Moved every frame, the grid turns under the
  snap and every shadow edge crawls.
- Each cascade clones the sun's shadow when it is built, so a size written on `sun.shadow.mapSize`
  alone reaches none of them: `SkyLighting.shadowMapSize` writes the clones as well, or a quality
  tier draws every cascade at the size of the tier above and pays for it. `SHADOW_NORMAL_BIAS` is
  measured in shadow texels — the near cascade of `SHADOW_DISTANCE` covers about 80 m at
  `SHADOW_MAP_SIZE`, so a texel is about 8 cm — and a bias under a texel lets a grazed surface
  stripe itself.
- `renderer.shadowMap.enabled` is false by default on `WebGPURenderer`. Without the line in
  `renderer.ts` the cascades are built every frame and never drawn, and the city is flat with
  nothing to say why.
- The Preetham sky answers in real sky brightness, so the frame is tone mapped and `EXPOSURE` in
  `renderer.ts` is the one number every light in the game is set against. Change a light's strength
  only against a rendered frame.
- `PostChain` (`post.ts`) is the post chain of spec section 10.6, and it draws the frame:
  `post.render()` replaces `renderer.render`. The order is the design. The scene is drawn in real
  light and multiplied by the exposure; bloom reads that, so `BLOOM_THRESHOLD` is a number about the
  frame the player sees. Tone mapping brings it to 0..1, the grade follows, and SMAA comes last
  because it wants linear colour. The chain therefore tone maps and encodes the frame itself, and
  `outputColorTransform` is off so the pipeline does not do both again. `PostQuality` is the part of
  a quality tier this file owns: `setRenderScale` (`renderer.ts`) and a switch for each effect.
- `gradeAt(light)` (`grade.ts`) is the colour grade, as a table of colours the frame is looked up
  in. It is pure, so the tests run it headless, and it is rebuilt `GRADE_STEPS` times a game day
  rather than every frame. The grade works on display values and the frame is light, so
  `PostChain.lookUp` encodes a colour before the lookup and decodes it after: a lift big enough to
  warm a dusk shadow turns a whole night frame orange if it is added to light instead.
- three.js 0.186 cannot upload a `Data3DTexture`: it writes one slice at a time, WebGPU refuses the
  flat view the upload needs, and the texture samples as zero — so `Lut3DNode` grades every frame
  black. The table is a `DataTexture` strip of the blue slices instead, and `lookUp` blends the two
  nearest by hand. Do not reach for a 3D texture until that is fixed.
- TSL's chained `mix` takes the receiver as the factor: `a.mix(b, t)` compiles to `mix(b, t, a)`. It
  reads like a blend and is not one. Use the free `mix(a, b, t)` from `tsl.ts`. `smoothstep` chains
  the same way.
- The camera of spec section 10.7 looks down and never sees the sky, so the dome is drawn after the
  ground and the buildings and the depth buffer throws most of it away. It is still worth its draw:
  the water mirror looks up, so the sky is what the sea reflects.
- `lampsIn` (`lamp-mesh.ts`) places a street lamp at each whole multiple of its tier's spacing
  measured from the start of the curve, so two chunks that share a road place the same lamps and
  neither places one twice. Only runs on the ground are lit, and the stretches the junctions take
  are left unlit, because a road carries no surface there and a mast would stand in the carriageway;
  `LAMP_BY_TIER` says which tiers carry lamps at all.
- `LampLights` (`lamps.ts`) is a fixed pool of `LAMP_LIGHT_CAP` projector cones, aimed at the lamps
  nearest the player; every other lamp is a lit lens and no light. The pool never grows or shrinks,
  because adding a light to a scene rebuilds the shader of every material in it. A `ProjectorLight`
  throws a rectangle rather than a disc, and its penumbra reads the other way round from a
  spotlight's: 0 is the softest edge. Aim it across the road rather than straight down, or it has no
  orientation to project in. three.js 0.186 clusters shadowless point lights alone, so
  `ClusteredLighting` does not cover these cones and the cap is what keeps them affordable.
- `src/render/preview.ts` is the page half of that tool, and holds everything awkward about taking
  the picture: a headless WebGPU canvas never reaches the compositor, so a screenshot of the page is
  blank and the frame is read back off a render target; a render target set with `setRenderTarget`
  skips the output pass and comes back almost black, so the target is set with
  `setOutputRenderTarget` instead; and WebGPU pads each row of a readback to 256 bytes, so a picture
  read without unpadding the rows comes back sheared, which looks exactly like a broken mesh.
- `buildGroundAttributes` (`ground.ts`) asks the world which parcel and zone each vertex stands on,
  never the chunk it is building. That is what makes two chunks agree along the edge they share;
  reading the chunk's own parcel pieces would put a seam on every boundary. The zone and
  ground-cover colours live there too; nothing else should carry them.

