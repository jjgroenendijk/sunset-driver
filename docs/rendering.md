# Rendering

The gotchas of `src/render`: what three.js 0.186 and WebGPU refuse, what is packed into a batch and
why, and how a chunk, a quality tier and the frame budget fit together. `spec.md` sections 9 and 10
are the design. What the renderer draws on top of the ground — buildings, vehicles, weapons, plants
and the crowd — is in `docs/render-entities.md`, and what lights it — the sun, the sky, the street
lamps and the lights a vehicle carries — in `docs/lighting.md`.

## Contents

- Streaming the city
- Quality tiers
- Warming the shaders
- Smoothing and fading
- TSL and the three.js traps
- Roads and pavement
- Batches and cells
- Water and its mirror
- Post and the colour grade
- The preview page and the ground

## Streaming the city

- The city is streamed in workers (spec section 9.1). `ChunkPool` (`chunk-pool.ts`) sends each
  worker the world description, the worker builds its own layers, and it answers with a
  `ChunkPayload` (`chunk-payload.ts`): typed arrays and no three.js object, handed over rather than
  copied. `chunk-worker.ts` may therefore import only what runs without a DOM, a renderer or a
  material, as `src/world` may.
- The main thread pays only for the upload. `WorldScene.update` runs the queue against `spendBudget`
  (`streaming.ts`) and a batch is filled a step at a time, so a chunk of the core lands over several
  frames. A step is indivisible and is the only thing that overruns the streaming slice,
  by about 0.4 ms on an Apple M1 laptop. A step copies at most `MAX_STEP_VERTICES` (`batch.ts`),
  so that overrun is a number the renderer chose and not the largest tower a seed happens to build —
  a core chunk carries towers of 33 000 vertices, which is sixteen steps. A part larger than a step
  is copied over several of them and is drawn only once its last step is in, because the index is
  what the renderer reads its vertices through. Cutting a part costs nothing: the chunk spends the
  same total either way. The worker also allocates the buffers each batch copies its parts into
  (`PackedBatch.storage`), and `fillOfPacked` merges the batch into them. A batch left to allocate
  its own does it inside its first part: tens of megabytes in one frame, and the piece a collection
  lands in.
- Nothing is built on the frame thread any more, so
  `WorldScene.settle(x, y, radius, timeoutMs, onProgress)` is how the game and the preview wait for
  the ground under the player. `onProgress` is told how many of the wanted chunks are in the scene,
  which is what the loading screen draws; the total is the most ever outstanding, because a chunk
  already in the scene was never outstanding.
- The world itself is built in a worker too (`world-source.ts`, `world-source-worker.ts`). Half a
  second on the frame thread is the title screen frozen mid-swing and a loading screen that cannot
  draw its own progress. `WorldSource` holds one world at a time: asking for the seed being built
  hands back the same promise, and asking for another seed gives up on the one in flight and rejects
  it with `GIVEN_UP`. `warm` starts the seed the title screen opens on, so Start usually finds it
  finished. In Node there is no `Worker` of that kind and it falls back to the calling thread.
- Only the first worker of the pool is asked for the parking bays. Every worker builds the same
  bays from the same layers and the pool keeps one answer, so asking them all cost every worker but
  one a chunk's worth of time before its first chunk.
- WebGPU compiles a pipeline the first time it draws with it, so a session drawing its first frame
  compiles the whole city over that frame and the twenty after it: the street stutters into place
  while the player is already driving on it. `main.ts` calls `renderer.compileAsync(scene, camera)`
  after `settle` and before the first frame, with the camera already standing where the session
  starts, because what is compiled is what the camera can see. `render-profile.ts` throws away the
  same frames for the same reason.
- The far ring is the same chunk at `'far'` detail: the ground, the highways and arterials over it,
  and every building as its outlined massing, with no plants. A chunk that crosses between the
  rings is built again and swapped when it lands, so nothing disappears while its replacement is
  built.
- The buildings have three details of their own (spec section 9.2). Only the chunks within
  `FACADE_RADIUS` of the player generate facades. The rest of the near ring is `'mid'` detail: the
  chunk in full, but every building a block from `block-mesh.ts`. The far ring is one box per
  building (`buildMassingGeometry`). Every detail keeps the outline. On the dearest core chunk of
  24 seeds the buildings cost 1 240 000 vertices near, 87 000 mid and 7 300 far.
  `CHUNK_VERTEX_CAP` (`chunk-cost.ts`) holds each detail, and the sweep counts it with
  `buildingVertices`. A coarser bay and floor on the generated facade is not a middle detail: twice
  the bay and twice the floor still costs 45 % of the full facade, because the cornices, piers and
  finials do not scale with the bays.

## Quality tiers

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
- A tier moves six things at once, because stepping one at a time takes six windows to reach the
  tier one window away: the render scale and the effects (`post.ts`), the two streaming rings, how
  far the sun's shadow reaches and what it is drawn at (`sky.ts`; the cascade count is fixed,
  because changing it rebuilds every shader), what the water's mirror is rendered at
  (`water-surface.ts`), and how much of `ENTITY_CAPS` a chunk places. The mirror steps at medium and
  goes no lower: at the low tier the render scale has already halved the frame, and the reflection
  is small on screen and broken up by the waves, so a cheaper mirror there wrecks the look of the
  sea for almost nothing. The near ring gives way before the far one, so the city never visibly ends
  nearer. Nothing already in the scene is rebuilt on a change: chunks past the new far ring are
  dropped and chunks that cross between the details are asked for again, and a chunk still standing
  keeps the plants it was built with.
- **A tier change must compile nothing.** three.js builds a WGSL program on the frame thread, which
  takes about a quarter of a second each, so a tier change that rebuilt the post chain held the game
  still for half a second — and it never got cheaper, because a rebuilt node is a fresh cache key
  however often the same effects have been compiled before. `PostChain` therefore builds a graph
  once and keeps it, one per set of effects, and a tier change swaps the pipeline's output node to
  a chain the renderer has already compiled. The first tier to ask for a set of effects still builds
  it, once: measured with `--tier-at`, a change that turns bloom off builds four nodes and one
  pipeline and holds the frame for 35 ms, and nothing after that.
- **The render scale moves the buffer, and the cluster grid must not follow it.** Every tier carries
  its own `renderScale`, and `setRenderScale` hands it to `renderer.setPixelRatio`, which changes
  the drawing buffer size. `ClusteredLightsNode.updateProgram` builds its cluster grid from that
  size and rebuilds the whole compute program when it moves, and the lights node hashes that
  program into its cache key, so every render object in the scene is thrown away and every shader
  in the city is built again: about two seconds, on every tier change of a drive, and a machine
  near a boundary changes tier twice a second. The renderer frees a program as its render objects
  are discarded, so the scale that is not standing cannot be warmed either. `clustered-lights.ts`
  therefore stands the addon's node on its head: the grid is pinned to the largest buffer the
  renderer draws at — the display at the full pixel ratio, before the render scale — and grows past
  the pin only when the window is enlarged. That is safe only because the fragment lookup is built
  with it: the addon finds a fragment's cluster from its pixel coordinate divided by the tile size,
  which names another cluster at every scale, and `create` replaces it with the fragment's share of
  the target (`screenUV`) against the grid's dimensions — the compute cuts every cluster's bounds
  from that same share of the frame (NDC), so lookup and bounds agree at whatever resolution the
  frame is drawn at. Measured with `--tier-at` on a full-high-full round trip: the frames either
  side of each change build nothing, against about two seconds a change before. Issue #323 carries
  the measurements.

## Warming the shaders

- `warm.ts` compiles the session's shaders behind the loading screen. three.js keys a WGSL program
  on the material, the geometry layout it is drawn over, the object itself and the pass, and builds
  it on the frame thread the first time it meets that combination. Met while driving, that is a
  frame of about a quarter of a second per program, and they come in batches.
- The warm-up draws frames through the post chain itself, never `renderer.compileAsync`. The chain
  draws the city into a render target of its own format, and the program a material draws with
  there is not the one `compileAsync` builds for the canvas — a set the game never draws with at
  all. Measured in WebKit, that set cost about 15 s behind the loading screen and was thrown away
  by the first frame through the chain; on a phone it is the difference between a city that loads
  and one that never does.
- One frame is drawn for each material, with the rest of the scene held hidden, so a frame costs
  one material's programs whatever the city around it weighs. Hidden objects are shown, frustum
  culling comes off and an empty instanced pool is given one instance for the frame: the ambient
  traffic, the parked cars, the police and the crowd each hold a pool per class that is empty until
  the first one of that class comes near, and three hashes the mesh's own `uuid` into the program
  key, so an empty pool is a program nobody has built. The sun's cascades and the water's mirror
  run over the frame the same way, and `showWater` holds the sheet in it so an inland session
  compiles the mirror too.
- A slice of the warm-up holds the frame for at most 40 ms and an animation frame is waited for
  between slices, so the loading screen keeps painting its own progress — which it counts out, one
  material at a time — and no browser is handed a block minutes long. The whole warm-up on an M1
  laptop is about 2 s in WebKit and about 1 s in Chromium, against 20 s to 35 s and about 12 s when
  it drew the whole city at once.
- It therefore runs last of everything the loading screen covers, after every view is in the scene.
  A view added after it would compile on the frame it first draws.
- An object that streams or spawns afterwards costs nothing: a chunk worker builds every batch of a
  kind the same way, and an entity is drawn out of a pool made before the session started. The
  warm-up takes the drive's worst frame from about 2 s to about 20 ms.

## Smoothing and fading

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

## TSL and the three.js traps

- Chained TSL expressions do not satisfy `tsc`, so `src/render/tsl.ts` is the one door onto
  `three/tsl` (spec Appendix A). Add the helper you need there and import `three/tsl` nowhere else.
  The post-processing nodes of `three/examples/jsm/tsl/display/` come through the same door.
- three.js 0.186 sends `GPUTextureViewDescriptor.swizzle` as a string, and a browser that has made
  it a dictionary throws on every `createView`, so nothing is ever drawn. `renderer.ts` drops the
  field where the browser refuses it. Delete that shim once three.js sends the dictionary.

## Roads and pavement

- `buildChunkRoads(chunk, ribbons, surfaceAt)` (`road-mesh.ts`) lofts a chunk's roads (spec section
  10), with the cross sections and the markings table in `road-section.ts` and the junction surfaces
  in `junction-mesh.ts`: one `LoftGeometry` per piece of a run, one bevel per turn too sharp to
  mitre and all of a run's bevels in one part, a deck and parapets under each bridged stretch, and a
  portal at each mouth of a bore. On the ground the section is the carriageway alone; on a deck or
  in a bore it is the whole width the tier claims (`structureSection`), since no block stands
  beside it. `trimRun` first cuts every run at its curve's gaps, and each junction the chunk owns is
  drawn as one carriageway polygon fanned from the node, paved as its widest road. The ring comes
  from `junction-shape.ts`, which the carve levels as well. Its mouth vertices are the very sections
  the lofts end on, so the two meet without a seam whichever chunk built each. The far ring draws
  neither junctions nor gaps, and only the pavement of its own tiers. The piers and the tram track
  go into the same tier batches; `docs/corridors.md` has them.
- `pavement-mesh.ts` draws each pavement piece of the chunk in its tier's batch: a surface on
  `RoadCarve.surfaceAt` lifted by `vergeRise`, and a face down every edge that is not on the chunk
  boundary, which is the kerb where the edge meets a carriageway. The triangulation drops a vertex
  in line with its neighbours and fans a band into triangles tens of metres long, which cut under
  the ground on a crest. So an edge is split, in both triangles that hold it, where the surface
  stands more than `PAVEMENT_SAG` off its middle or it runs past `PAVEMENT_EDGE`.
- Every surface stands over the bench rather than on it, the verge of a tier without a pavement
  included: a surface laid at exactly the height of the ground under it is one the ground shows
  through wherever the grid samples it. A vertex carries how far across the road it stands;
  `road-material.ts` steps between the bands at the tier's own widths and holds the road colours, as
  `ground.ts` holds the ground's. A dash pattern is measured from the start of the whole curve, so
  it carries on across a boundary.
- `RoadScenery` (`roads.ts`) packs each tier of a chunk into one batch, and that tier's markings
  into one `LineSegments2`. `batch.ts` is the one place geometry is packed into a batch, and a batch
  is one merged `Mesh`, never a `BatchedMesh`: it merges the parts into the storage the worker
  allocated, each at its place in the world, releases each as it goes, and hands the copies back as
  the steps the frame budget runs. A batch is not drawn until its first part is in, because an empty
  one has no attributes and the renderer would compile a shader for that shape of geometry.

## Batches and cells

- **A `BatchedMesh` is a trap on WebGPU in three.js 0.186.** It is drawn as one draw call per
  instance, after its instances are culled and sorted on the processor, in every pass: the view,
  each shadow cascade and the water's mirror. Its shaders are keyed on the batch itself, so a batch
  that comes into view in a pass for the first time builds them again, at 25 to 35 ms. Neither the
  GPU-side culling nor the single draw that spec section 9.2 asks for is what the class does today.
  A merged mesh shares its shaders with every chunk in the same material and is one draw, and its
  bounds are what culls it. `chunkDrawCalls(chunk)` (`chunk-cost.ts`) is the most a chunk costs —
  the ground, the markings, and each batch in every cell — and `CHUNK_DRAW_CALL_CAP` is the most it
  may; `payloadDrawCalls` counts the cells a built chunk fills, and the HUD shows the dearest chunk
  built. A count over the cap is a batching regression, not a cap to raise.
- A batch is cut into cells (`cells.ts`): a quarter of a chunk at near and mid detail, and the whole
  chunk in the far ring. A mesh is culled whole in the view, in each shadow cascade and in the
  mirror, so a batch that spanned its 250 m chunk was drawn whole wherever a corner of it was seen.
  A part goes into the cell its frame's origin stands in, or the middle of its box when it has no
  frame, so a building's shell and its outline always share a cell. On seed `sunset`, standing on
  the core at full quality on an Apple M1 laptop, cells cut the still frame from 19.7 to 14.4 ms and
  the triangles from 3.42 M to 1.89 M, for 66 more draws and about 1 ms more processor time. At a
  pixel ratio of 2 the frame went from 35 to 28 ms. Cells of a ninth of a chunk drew 1.46 M
  triangles but no faster a frame, with a worse 95th percentile, so the draws cost what they saved.
  The far ring is not cut: its batches are a few thousand vertices each.

## Water and its mirror

- `buildWaterAttributes` (`water.ts`) is one sheet of water for the whole map, not a layer of each
  chunk: the `WaterMesh` addon mirrors the scene in a second pass, and one is all the frame can pay
  for. The sheet is built in the local plane and laid flat by a quarter turn about X, so a local
  point `(x, y)` is the world place `(x, -y)`; the turn is what puts the normal up, and the mirror
  takes its plane from that. A vertex carries the deepest ground within half a cell of it, so a
  channel narrower than the grid is not left dry, and the depth is what fades the surface out at a
  shore.
- That second pass runs wherever the sheet is drawn, and the sheet spans the map, so the mirror ran
  everywhere the player stood — about a quarter of a frame, inland included. The sheet is now drawn
  only where the camera can see water: `waterNear` (`water.ts`) answers, from the depths the sheet
  was built with, whether any drawn cell falls within `SHADOW_DISTANCE` of a place — the patch of
  ground the top-down view covers — and `WorldScene.look` hides the sheet each frame where none
  does. An invisible sheet never becomes a render object, so its reflector never renders and the
  pass costs nothing. The check is the drawn cells exactly, so water is neither hidden where the
  player can see it nor drawn a cell beyond where they can. It is the same at every tier: the tiers
  step the mirror's resolution (`mirror` in `QUALITY_TIERS`), never whether this test runs.
- The pass a session never runs is a pass it never compiles. An inland session first shows the sheet
  when the player reaches the sea, and that frame compiled every material again for the mirror:
  about 1.4 s, on a frame the player is driving through. `WaterSurface.show`, through
  `WorldScene.showWater`, draws the sheet wherever the camera stands for the warm-up frames of
  `warm.ts`, behind the loading screen; `look` hides it again the frame after.
- `WaterMesh` bakes its mirror into its colour graph inside a shader function the renderer only
  runs while building, so nothing outside ever reaches the mirror to steer it. `water-surface.ts`
  therefore replaces that graph with the same shading built around a reflector it holds: the
  mirror's resolution is then one number written, and a quality tier steps it without rebuilding
  anything. The port also rewrites the addon's shadow-lookup offset over the same wave nodes, or
  the waves would be sampled twice in one shader. The mirror's target goes into the mesh at
  construction, before any frame is drawn, so the first frame no longer reflects from a mirror
  whose place was never computed — the hard line that made `preview.ts` draw one frame and keep
  the next is gone, and it keeps one. The look is unchanged: the preview of a waterside frame is
  byte for byte what the addon's graph drew.
- `WaterMesh` adds its own colour to the mirror unlit, and the mirror shows the `SkyMesh` dome in
  real sky brightness. Even at a reflectance of 2 %, the sky swamps an unlit colour, so the sea by
  day reads as a grey sheet. `setDaylight` (`water-surface.ts`) lights the colour with the sun and
  the fill that light the ground, and adds a dark blue that keeps the sea visible at night. The
  addon's diffuse term is `sunColour` squared with no tint, so a sun colour scaled by its intensity
  turns the sea white.

## Post and the colour grade

- `PostChain` (`post.ts`) is the post chain of spec section 10.6, and it draws the frame:
  `post.render()` replaces `renderer.render`. The order is the design. The scene is drawn in real
  light and multiplied by the exposure; bloom reads that, so `BLOOM_THRESHOLD` is a number about the
  frame the player sees. Tone mapping brings it to 0..1, the grade follows, and SMAA comes last
  because it wants linear colour. The chain therefore tone maps and encodes the frame itself, and
  `outputColorTransform` is off so the pipeline does not do both again. `PostQuality` is the part of
  a quality tier this file owns: `setRenderScale` (`renderer.ts`) and a switch for each effect.
- The graphs are built once and kept, by the effects they draw: `postGraphs` names the distinct ones
  a list of tiers asks for, and the four tiers come to three. Setting `quality` hands the render
  scale to the renderer and swaps the output node, and builds only where no tier has asked for that
  set of effects yet. Hence `ready()` waits for the SMAA tables of every graph built, not only the
  one standing.
- `gradeAt(light)` (`grade.ts`) is the colour grade, as a table of colours the frame is looked up
  in. It is pure, so the tests run it headless, and it is rebuilt `GRADE_STEPS` times a game day
  rather than every frame. The grade works on display values and the frame is light, so
  `PostChain.lookUp` encodes a colour before the lookup and decodes it after: a lift big enough to
  warm a dusk shadow turns a whole night frame orange if it is added to light instead.
- The table is a `Data3DTexture` read by `Lut3DNode`, so the sampler interpolates all three axes
  and the grade costs one texture fetch. `generateMipmaps` must stay off: three.js 0.186 builds
  mipmaps of a 3D texture through 2D views, WebGPU refuses every one of them, and the console fills
  with validation errors. Nothing reads those levels, so turning them off is the whole fix.
- TSL's chained `mix` takes the receiver as the factor: `a.mix(b, t)` compiles to `mix(b, t, a)`. It
  reads like a blend and is not one. Use the free `mix(a, b, t)` from `tsl.ts`. `smoothstep` chains
  the same way.
- The camera of spec section 10.7 looks down and never sees the sky, so the dome is drawn after the
  ground and the buildings and the depth buffer throws most of it away. It is still worth its draw:
  the water mirror looks up, so the sky is what the sea reflects.

## The preview page and the ground

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
