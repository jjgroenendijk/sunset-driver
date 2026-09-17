# Lighting

The gotchas of what lights `src/render`: the sun and the sky through a game day, the shadows they
cast, the street lamps, and the lamps and beams a vehicle carries after dark. `spec.md` sections
10.5 and 13.4 are the design. What is drawn is in `docs/rendering.md` and
`docs/render-entities.md`, and the weather laid over the day's own light in `docs/weather.md`.

## Contents

- Daylight, shadows and the sky
- Street lamps
- Headlights and tail lights

## Daylight, shadows and the sky

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
- `WorldScene.time = tick` sets the weather of spec section 13.4 as well as the light, and `apply`
  lays one over the other. `docs/weather.md` is the whole of that.

## Street lamps

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
- A light at intensity 0 still costs every fragment it reaches: the intensity is a uniform, and the
  shader runs the whole light to multiply it by 0. That was 10 ms of a frame at a pixel ratio of 2,
  by day. Taking the light out of the scene is no better. It rebuilds every shader, and three.js
  frees the old variant as the render objects rebuild, so compiling both states at load does not
  keep both. `LampLight` (`lamp-light.ts`) draws with a node that wraps the light in `If` on a
  uniform, so a light that is off is a branch the fragment skips. `registerLampLight` in
  `renderer.ts` gives the renderer that node. A renderer that is not told draws the lamps unlit.

## Headlights and tail lights

- A vehicle's lamps are boxes like the rest of it, so what makes one a lamp is the colour it is
  painted: `LAMP` at the nose, `TAIL` at the tail (`vehicle-mesh.ts`). `glowOf` (`vehicle-glow.ts`)
  is the one place that reads that and the one place that says how hard each burns. A tail light is
  a dark red and a headlamp near white, so the tail takes the larger multiple to read as lit.
- The traffic and the police draw every vehicle's glass, lamps and tyres as one instanced mesh with
  the colour on the vertices, so a lamp cannot be a material of its own. `coloured` (`traffic.ts`)
  writes a `glow` attribute beside the colour, and `createVehicleTrim` multiplies the two by one
  uniform for the emissive. `main.ts` sets that uniform from `WorldScene.lampsNow`, which is the
  number the street lamps run off, so the traffic lights up with the street it is on. A vehicle
  drawn through a view that never sets it drives the night with its lamps off.
- The player's own model is not instanced, so `VehicleModel.lamps` sets `emissiveIntensity` on the
  lamp boxes instead. That is a uniform of the material, so dusk compiles nothing. A burnt-out
  shell burns nothing at all.
- `Headlights` (`headlights.ts`) is the only vehicle light in the scene: two `LampLight` cones on
  the player's headlamps, aimed `THROW` metres ahead and `DIP` below, which lays the beam on the
  road about 20 m out. Any nearer and the pool is a blown white patch against the bumper. The
  traffic gets lit lenses and no cones, for the reason `lamps.ts` gives about the street lamps: a
  light is paid for by every fragment it can reach.
- `WorldScene.setVehicle` is the door onto the player's model. It places it, burns its lamps and
  aims the beams together, because a caller that reaches past it to `vehicle.set` gets a car with
  its lights off and nothing to say why.
