# The traffic, the parked cars and the crowd, drawn

The gotchas of the views that draw the ambient life of spec sections 13.1 and 20: the traffic, the
parked cars, the crowd, the bus stops and the contacts' markers. The simulation behind them is in
`docs/city-life.md` and `docs/giving-way.md`, the rig of a person in `docs/crowd.md`, and the other
things standing in the world in `docs/render-entities.md`.

## Contents

- The views

## The views

- `src/render/vehicles/traffic.ts` draws the traffic of spec section 13.1 as four pools per class
  (`Pool`, `look/pool.ts`, made by `instanced()`): the parts in the row's paint, the trim with its
  colours per vertex, the glass and the tyres. A part whose colour is `VehicleSpec.paint` goes into
  the paint pool, and the instance colour replaces it, so one pool draws a saloon in every paint. A
  class with nothing in view is hidden, so it costs no draw. The traffic is evaluated at
  `tick - 1 + alpha`, the moment `smooth.ts` draws the player at, and a promoted vehicle is drawn
  from its record.
- The body of an ambient car moves on its springs (`src/render/vehicles/suspension.ts`). It pitches
  with the car's change of speed and rolls with its turn, and rocks back once when either stops. The
  tyres are a mesh of their own so they stay on the road. A bike leans into a turn instead, tyres
  and all. The springs are drawing state kept per car id, and a gap of more than `GAP` between
  frames resets them. A promoted car takes its turn from the physics.
- A bike is ridden, so `src/render/vehicles/bike-rider.ts` puts a figure of boxes on it: a fourth
  instanced mesh for the one ambient class with a saddle, written only for the bikes still driving
  their tours. A promoted bike has nobody driving it and a parked one nobody on it, so neither takes
  an instance. The figure cannot be the `CharacterModel` the player rides with (`rider.ts`), since
  the whole class is one geometry, but it sits on the same `saddleOf` seat, grips and pegs and takes
  the same `RIDE.lean`, so both riders move when the bike does. A strut is a box run between two
  points, and `strutOf` in `traffic.ts` pitches and turns it into place.
- `src/render/roads/signals.ts` draws the traffic lights, and `TrafficView` owns it, so the game and
  the render preview draw them with no wiring of their own. Every head in view is one instance of
  the frame and three of the lens mesh, so the lights cost two draws. The lens colour is set each
  frame from `TrafficSignals.light`. The lenses stand proud of the housing, because the camera sees
  a head from above and would not see a lens set flush in its face.
- `src/render/vehicles/parked.ts` draws the parked cars with the traffic's own parts, three meshes
  per class. A parked car does not move, so `ParkedView` writes its instances only when the view has
  moved `MOVE` metres, `REFRESH` ticks have passed, or a car was promoted. A frame between those
  uploads nothing. `needsUpdate` on an instance matrix uploads the whole buffer, and at `PARKED_CAP`
  that is about a megabyte a frame.
- The traffic, the parked cars and the crowd each fade out at the edge of what they draw, with an
  `EntityFade` of their own (`fade.ts`): 180 m, 160 m and 110 m round the player. A chase view sees
  those edges (`pop-in.ts`), where a car used to appear whole. They fade through `mask`, which sets
  the material's `maskNode`, not through `dress`: the glass is seen through, and an alpha test
  against the dither would discard most of it at any distance. The shadow pass reads a mask, so
  the shadow fades with the car. The parked cars fade `MOVE` short of `PARKED_VIEW`, because their
  instances are written round where the view last moved.
- `src/render/people/pedestrians.ts` draws the crowd as one `Mesh` over an
  `InstancedBufferGeometry`, not an `InstancedMesh`. An `InstancedMesh` applies its instance matrix
  before `positionNode` runs, so a shader that skins the body has to do the placing too.
  `pedestrian-material.ts` reads each vertex's bone matrix from the texture `bakeWalks` fills, at
  two frames of the gait's cycle, blends them, and then scales, turns and places the body. It
  assigns `normalLocal` in the same `Fn`, or the lighting sees the bind pose.
- A WebGPU pipeline reads at most eight vertex buffers, and a `BufferAttribute` is a buffer each.
  Over eight, the pipeline fails and nothing is drawn, with only a console error to say so. The
  crowd packs its bone and colour part into one `rig` attribute and its eight instance attributes
  into one `InstancedInterleavedBuffer`, and it uploads only the `CROWD_STRIDE` floats of each
  person written. The rig, the props and the blends are in `docs/crowd.md`. A `Pool` packs its
  matrix and its tint into one buffer for the same reason: the trim of a vehicle reads six.
- `src/render/transit/bus-stops.ts` stands a post at each kerb the buses of spec section 20.2 call
  at, and a shelter at the busy ones: two instanced meshes, so every stop in view costs two draws. A
  stop never moves, so `BusStopView.update` takes no moment, only the place the frame is drawn
  round. The stops come from `src/sim/transit/bus-stops.ts` rather than from a chunk, because where
  a bus calls is a function of the route it walked and the chunk worker has only the world.
- `src/render/crime/markers.ts` marks each mission contact of spec section 18 twice: a beam of light
  standing on the road they stand on, and a diamond turning over their head. Each is one instanced
  mesh, so the whole city's contacts cost two draws. Who stands where is `src/ui/hud/givers.ts`;
  this only turns and bobs them off the frame's own moment, so two machines at the same tick draw
  the same frame. The colour is per instance — amber while the contact will talk, dull while they
  will not — so both pools pass through `tinted`, or the warm-up compiles a program that never reads
  it.
- The beam is added over the scene and writes no depth, as the light a police bar throws is
  (`beacons.ts`): a real light would turn the clustered path on for every fragment in the city. Its
  column fades to black at the head on its own vertices, so the top of it has no edge.
- `AnimationClipCreator` makes no clip that swings a limb, so `walkClip` builds its keyframe tracks
  itself. A test reads the baked texture on the processor with `bakedPoint`: the legs swing against
  each other, and each arm against its leg.
- A gait is a row of the baked texture, so a new one goes at the **end** of `GAITS`. `raise` in
  `SWINGS` holds both arms at a fixed angle over the swing: the `aim` gait of the police on foot has
  them straight out in front. The fourth value of `pedMotion` is free for a flag, and
  `render/services/uniform.ts` uses it for the police uniform (`docs/police.md`).
