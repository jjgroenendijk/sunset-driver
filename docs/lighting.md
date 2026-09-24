# Lighting

The gotchas of what lights `src/render`: the sun and the sky through a game day, the shadows they
cast, the street lamps, the neon over the shops, and the lamps and beams a vehicle carries after
dark. `spec.md` sections 10.5 and 13.4 are the design. What is drawn is in `docs/rendering.md` and
`docs/render-entities.md`, and the weather laid over the day's own light in `docs/weather.md`.

## Contents

- Daylight, shadows and the sky
- The buildings after dark
- Street lamps
- Neon
- Headlights and tail lights
- The light budget

## Daylight, shadows and the sky

- `daylightAt(tick)` (`daylight.ts`) is the day and night cycle of spec section 10.5: the sun's
  place, its colour and strength, the sky fill, the haze, how lit the windows are and how far on the
  street lamps are, all read off how high the sun stands. It is pure, so the tests run it headless.
  `SkyLighting` (`sky.ts`) turns it into the `SkyMesh` dome, one directional light with
  `SHADOW_CASCADES` cascades and the fog; `WorldScene.time = tick` is the only way in, and one game
  day is 24 real minutes.
- The day is a summer one: sunrise at `SUNRISE_HOUR` (05:30), sunset at `SUNSET_HOUR` (20:30).
  `sunFraction` stretches the clock onto the sun's circle; the clock the player reads is not
  changed. A sun on the plain 24-hour circle set at 18:00, and the frame was dark by 18:20.
- The night fill (`FILL_NIGHT`, `SKY_FILL_NIGHT`) is moonlight, and `NIGHT_GRADE` keeps its
  contrast low. Together they keep a street away from the lamps readable at midnight. With a
  weaker fill or a steeper grade, a night frame was black.
- A shadow map is drawn again for every camera a frame renders with, and the water's mirror is a
  second camera. The cascades are fitted to the player's camera whichever camera asks, so the second
  draw is the same map twice: `sun.shadow.autoUpdate` is off and `SkyLighting.drawShadowOnce`,
  called once a frame from `WorldScene.look`, is what asks for them. A sun with no strength asks for
  nothing, so a night frame draws no shadow at all. `SHADOW_DISTANCE` is view depth, and it is what
  the camera can see rather than what the haze reaches: past it a cascade draws every building again
  for ground nobody looks at.
- A shadow camera that names layer 0 alone is given the layers of whichever camera asks for the map
  (`ShadowNode.updateShadow`), and the mirror's camera names the mirror layer alone. Since the map
  is drawn for the first pass of a frame that asks, a frame the water opened lit the whole view from
  a map only the buildings and the lamps had cast into: no tree, no vehicle and no sign threw a
  shadow while the sea was in view, and the shadow pass of each mask is a program of its own, so the
  warm-up met one of the two. `SkyLighting` therefore names both layers on `sun.shadow.camera`,
  which pins the mask. It costs no frame time: the map is still drawn once a frame.
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
- `CSMShadowNode` draws into a cascade only what stands within `lightMargin` of the view it covers,
  back along the light, and the addon's fixed 200 m is short of a 150 m tower once the sun is under
  50 degrees. The near cascade covers the least and loses the tower first, so the street under the
  camera came out sunlit and the same street further up the screen in shadow, with the line moving
  as the camera moved. `shadowReach` in `sky.ts` sizes the margin to the snapped sun and deepens
  every cascade's camera by as much. At noon it is shorter than 200 m.
- The shadow pass skips a cell of road paved on the ground (`raisedPartsOf`, `road-mesh.ts`): it
  could shade only itself. A deck, a portal or a pier in the cell makes it cast.
- The daytime sky fill (`FILL_DAY`, `daylight.ts`) leaves a street in shade about half as bright as
  one in the sun. That is more light than the sky really gives, because the frame is tone mapped:
  the curve's toe pulls a dark pixel down further than its share of the light says. At a third of
  the sun the street under a tower still read as dusk at noon.
- `renderer.shadowMap.enabled` is false by default on `WebGPURenderer`. Without the line in
  `renderer.ts` the cascades are built every frame and never drawn, and the city is flat with
  nothing to say why.
- The dome is the addon's Preetham sky with three things laid over it in `sky.ts`. `SKY_GAIN`
  dims it, or a clear sky tone maps to a flat white-blue. The addon's clouds follow the weather
  through `SkyLighting.clouds`: a few in clear weather, a full grey cover from steady rain on. The
  Preetham model has no night, so `NIGHT_HORIZON` and `NIGHT_ZENITH` are added as the night comes
  on; without them the sky after dusk was black, and the grade turned it brown.
- The Preetham sky answers in real sky brightness, so the frame is tone mapped and `EXPOSURE` in
  `renderer.ts` is the one number every light in the game is set against. Change a light's strength
  only against a rendered frame.
- A colour in a material is the colour on screen where the noon sun falls on it
  (`docs/art-style.md`). three.js divides diffuse light by π, so the sun and the sky fill at
  `SUN_INTENSITY` and `FILL_DAY`, times `EXPOSURE`, come to about 1 on a lit flat surface. The
  tone map is `NeutralToneMapping`, which keeps hue and saturation up to near white. ACES washed
  every pale colour to white and pulled it toward blue.
- The sky fill decides the tint of the lit sum. `SKY_FILL_DAY` is a pale lavender, so the sum with
  the warm sun is a warm white. A blue fill, stronger on blue than the sun is on red, turned cream
  into grey.
- `WorldScene.time = tick` sets the weather of spec section 13.4 as well as the light, and `apply`
  lays one over the other. `docs/weather.md` is the whole of that.

## The buildings after dark

- Each building lights in its own way (spec section 10.5). `building-finish.ts` gives it the colour
  of its window light — warm, neutral, cool or fluorescent — and the share of its windows that are
  lit, both off its kind and its seed, and writes them on its vertices; `night-material.ts` draws
  them. An office is the fluorescent one, and it is the one that lights **whole floors**: its
  columns are run together before the field is read.
- `daylightAt(tick).late` is how deep into the night it is, 0 at dusk and 1 in the small hours. It
  is read off the clock rather than the sun, because what it drives is people: an office empties at
  midnight, a home turns in, and a shop stays lit. `LATE_DIM` (`night-material.ts`) is how much
  each kind of light loses.
- A roof over `CROWN_HEIGHT` carries a floodlit band around its rim and one over `BEACON_HEIGHT` a
  red aircraft beacon (`roof-dress.ts`). Both are laid **before** the detail is read, so the mid
  ring keeps them where every other piece of rooftop plant is dropped: a skyline at night is what
  they are for. Both stand inside the rim of the deck, never proud of it — a terrace deck is
  measured off the box of the shape and already stands a few centimetres outside the walls, so a
  band proud of that reaches past the lot and `test/seed-chunks.test.ts` fails.
- The beacons blink off the tick alone: `beaconPhase(tick)` is one `BEACON_CYCLE`, and each tower
  offsets it by the draw of the ground it stands on, so a skyline blinks out of step. Nothing here
  reads a frame time, so two machines blink together.
- None of it is a light. A lit window, a neon strip, a floodlit crown and a beacon are all emissive
  surfaces read by the bloom, for the reason the light budget below gives.

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
  the clustered lighting does not cover these cones and the cap is what keeps them affordable. With
  no point light in the scene, the clustered path is not built at all (`docs/rendering.md`).
- A light at intensity 0 still costs every fragment it reaches: the intensity is a uniform, and the
  shader runs the whole light to multiply it by 0. That was 10 ms of a frame at a pixel ratio of 2,
  by day. Taking the light out of the scene is no better. It rebuilds every shader, and three.js
  frees the old variant as the render objects rebuild, so compiling both states at load does not
  keep both. `LampLight` (`lamp-light.ts`) draws with a node that wraps the light in `If` on a
  uniform, so a light that is off is a branch the fragment skips. `registerLampLight` in
  `renderer.ts` gives the renderer that node. A renderer that is not told draws the lamps unlit.

## Neon

- A neon sign is the one thing in the city that really is a lit rectangle, so it is the one
  `RectAreaLight` of spec section 10.5. `NeonLights` (`signs.ts`) is a fixed pool of
  `NEON_LIGHT_CAP` of them, handed to the neon nearest the player, exactly as the street lamps
  are handed their cones. Every other lit sign is a glowing board and no light.
- **A rect area light needs its BRDF tables before any material that reaches one is built.** The
  tables are about 300 kB of numbers in `three/examples/jsm/lights/RectAreaLightTexturesLib.js`
  and the node reads them through a static: `registerNeonLight` (`sign-light.ts`) calls
  `RectAreaLightNode.setLTC` with them, from `renderer.ts`, beside the lamps' registration. A
  renderer that is not told fails to build the first material a sign reaches, and the error names
  a texture rather than a light.
- The same node wraps the light in `If` on a `lit` uniform, for the reason the street lamps do: a
  light at 0 is still evaluated by every fragment it can reach, and taking it out of the scene
  rebuilds every shader. three.js 0.186 clusters shadowless point lights alone, so a rect area
  light goes down the direct path like the cones.
- Only a fascia is handed a light. A billboard leans back over its roof so the camera can read it
  (spec section 10.7), which means what it lights is the sky; it glows and throws nothing.
- The glow itself is not a light at all. `sign-material.ts` makes the board's own printed colours
  emissive, off one uniform for the whole city, so a high street lights together at dusk. A tube
  that has failed stutters on its own phase, written on the board's vertices by `sign-mesh.ts`,
  because a batch has merged a chunk's boards into one mesh before the material runs.

## Headlights and tail lights

- A vehicle's lamps are boxes like the rest of it, so what makes one a lamp is the colour it is
  painted: `LAMP` at the nose, `TAIL` at the tail (`vehicle-mesh.ts`). `glowOf` (`vehicle-glow.ts`)
  is the one place that reads that and the one place that says how hard each burns. A tail light is
  a dark red and a headlamp near white, so the tail takes the larger multiple to read as lit.
- The traffic and the police draw every vehicle's glass, lamps and tyres as one instanced mesh with
  the colour on the vertices, so a lamp cannot be a material of its own. `coloured` (`traffic.ts`)
  writes a `glow` attribute beside the colour, and `createVehicleTrim` multiplies the two by one
  uniform for the emissive. `frame.ts` sets that uniform from `WorldScene.lampsNow`, which is the
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

## The light budget

- A light source glows only if it clears `BLOOM_THRESHOLD` (`post.ts`) after the exposure of 0.56.
  A window, a siren or a flame at colour 1 stays under it, so each burns at a gain of its own
  (`WINDOW_GAIN`, `BAR_GLOW`, `FLAME_GAIN`). The bloom reads only the light over the threshold.
  The addon's own pass reads the whole pixel, and a tower of lit windows seen from the street
  washed the night frame beige.
- `SCENE_LIGHT_CAP` (`sky.ts`) is every light the scene may hold at once, and the pools that make
  it up are each a fixed size so the sum can be checked: the sun and the sky fill, `LAMP_LIGHT_CAP`
  street lamps, `HEADLIGHT_CAP` beams and `NEON_LIGHT_CAP` signs. `WorldScene.lightCount` adds them
  and the HUD shows it, so a leak is visible while playing.
- A count over the cap is a regression, not a number to raise. A system that brings lighting of its
  own raises it together with the pool it brings, and adds that pool to the check in
  `test/signs.test.ts`.
