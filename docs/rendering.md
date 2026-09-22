# Rendering

The gotchas of `src/render`: what three.js 0.186 and WebGPU refuse, what a quality tier moves, and
how a frame is smoothed, lofted and reflected. `spec.md` sections 9 and 10 are the design. How a
chunk reaches the screen — the workers, the frame budget, the batches and the cells — is in
`docs/streaming.md`. What the renderer draws on top of the ground — vehicles, weapons, plants and
the crowd — is in `docs/render-entities.md`, the buildings in `docs/buildings.md`, what lights it —
the sun, the sky, the street lamps and the lights a vehicle carries — in `docs/lighting.md`, and the
post chain and the colour grade in `docs/post.md`.

## Contents

- Quality tiers
- Warming the shaders
- Smoothing and fading
- TSL and the three.js traps
- Roads and pavement
- Water and its mirror
- The preview page and the ground

## Quality tiers

- `quality.ts` is the quality-tier system of spec section 9.2: `QUALITY_TIERS` is the table, dearest
  first. `QualityMonitor` (`quality-monitor.ts`) is the frame-time monitor that walks it while the
  Graphics setting is Auto. It is pure — it takes a frame length and answers a tier when it changes
  one — so the policy is tested headless. `frame.ts` hands the tier to `WorldScene.quality` and
  `PostChain.quality` and logs the change.
- The monitor judges the median frame of a 500 ms window, so one dear frame counts for nothing. A
  window is missed when its median runs a quarter over the budget: a 60 Hz display that makes every
  refresh measures 16.7 ms against a 16 ms budget. A tier drops only after three missed windows in
  a row. One missed window used to drop it, and a streaming burst after load walked the city down
  to low. The first two seconds of a session and the second after a change are not judged.
- **A synced display never shows headroom.** It measures 16.7 ms a frame however little of it the
  game spent, so a rule that raises a tier only under 70 % of the budget never raises one there:
  the city stayed on low for good. The monitor therefore tries the tier above after ten steady
  seconds. A try that misses one window in its first two seconds drops back at once, and the next
  try at that tier waits twice as long, up to eighty seconds. Real headroom — four windows under
  70 % of the budget, on a fast or unsynced display — still raises a tier at once.
- `graphics.ts` is the Graphics menu's model. With Auto off, `tierOf` builds a tier from the
  player's knobs; it answers the preset's own tier object when the knobs match one. A knob is kept
  as an index into its table, so `readGraphics` can check it. A custom tier can ask for bloom
  without SMAA, a graph `warm.ts` does not build, so that one choice compiles a graph on the frame.
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
  a chain the renderer has already compiled. `warm.ts` draws one frame through the graph of every
  tier behind the loading screen, so no tier builds one while driving. Built there instead, the
  graph of the low tier held the frame for 1.4 s (issue #436).
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
- **The clustered path runs only while there is a light to cluster.** The addon clusters shadowless
  point lights, and the game has none. Yet it runs a compute over every cluster each frame and puts
  its cluster loop in every fragment: 43 ms of a 93 ms frame at a pixel ratio of 2 (issue #435).
  `PinnedClusterLightsNode` draws as a plain `LightsNode` until a point light arrives. Its cache key
  then carries a mark, because before the first grid the addon's key equals the plain one, and the
  first point light would rebuild no shader.

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
- The program key does not say whether the mesh has instance colours. `setColorAt` makes that
  buffer on its first call, so a pool the warm-up drew before it is drawn white for the whole
  session. Every pool that colours its instances is made through `tinted` (`tint.ts`), which gives
  it the buffer at once (issue #457).
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
  the player moves on some frames and not on others while the camera slides on every one. `frame.ts`
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
- **A material that writes `positionNode` reports no velocity.** three.js builds screen-space
  velocity from `positionLocal` against `positionPrevious`, and fills `positionPrevious` only for an
  `InstancedMesh`, a `BatchedMesh` or a real `SkinnedMesh`. The crowd places its own vertices in
  `pedestrian-material.ts`, so it hands back the velocity of a mesh standing still at the origin.
  That is what turned down `TRAANode` and `TAAUNode` in spec section 22.2, and anything temporal
  meets it again.

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
- The paint is flat triangles lying in the plane of the carriageway, lit and shadowed as the road
  is. It was once a `LineSegments2` fat line, which is a box turned to face the camera: from a low
  camera it stood up off the road like a fence, showed over the roads behind a rise and read as
  white and yellow lines across the picture. A long segment also missed the paint at its ends and
  flashed. The strip stands `MARK_RAISE` over the road, and the material's depth offset keeps it
  in front of the road far off without lifting it in the world.
- `RoadScenery` (`roads.ts`) packs each tier of a chunk into one batch, and that tier's markings
  into one flat mesh. `batch.ts` is the one place geometry is packed into a batch, and a batch
  is one merged `Mesh`, never a `BatchedMesh`: it merges the parts into the storage the worker
  allocated, each at its place in the world, releases each as it goes, and hands the copies back as
  the steps the frame budget runs. A batch is not drawn until its first part is in, because an empty
  one has no attributes and the renderer would compile a shader for that shape of geometry.

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
- Where water is on screen the pass still runs, so it draws less of the scene than the view does.
  The mirror's camera is held to a layer of its own (`mirror.ts`), and only the sky dome, the
  building shells, the lamp masts and the lights are put on it. What a grazing eye sees in water is
  the sky and what stands tall behind it; the ground, the roads, their markings, the plants, the
  traffic and the crowd lie flat along the shore, where the surface gives back two per cent of what
  falls on it. The outline hulls stay out too: a hull is a rim 0.35 m wide around a shell the mirror
  draws anyway, and it is a third of a chunk's building batches. On seed `1`, on the road beside the
  river at (-295, 115), that takes the second pass from 68 draw calls and 1.38 M triangles to 19 and
  1.22 M. The layer is added to an object, never set on it, so nothing is ever in the mirror alone
  and a new object that says nothing is simply left out of it. The lights are the exception that has
  to be carried: a pass lit by a different set of lights than the view builds every material's
  shader a second time.
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
- The top-down camera (`docs/camera.md`) never sees the sky, so the dome is drawn after the ground
  and the buildings and the depth buffer throws most of it away. It is still worth its draw:
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
