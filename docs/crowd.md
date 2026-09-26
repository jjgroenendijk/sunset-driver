# The crowd

The gotchas of the people on the pavements of spec sections 5.3, 13.1 and 20.1: how they are put
down, how they walk and wait, how they react, how they make way for the player, the occupied
corners, the beach, and how the crowd is drawn. The code is `src/sim/crowd/pedestrians.ts` and
the files named below. The traffic, the lights and the bus stops are in `docs/city-life.md`, and
the casualties under their own heading there.

## Contents

- Placing the crowd
- The walk plan
- The lights
- Reactions
- Making way for the player
- Off the buses
- The occupied corners
- The beach
- Drawing the crowd

## Placing the crowd

- `AmbientPedestrians` places people per directed edge of a tier with a pavement, from
  `TierSpec.walkers` thinned by `ZONE_PEDESTRIANS` (`pedestrian-place.ts`). A person walks one
  pavement round a loop. The loop starts on the edge they were placed on: `walkOut` walks as the
  traffic does but only `WALK_REACH`, and a loop that closes some way off is walked out to and back
  from. Without that a person spawns up to a loop away from their district, in the wrong clothes.
- Each person has a lane: metres right of the middle of the pavement, mostly on the right of the
  way they walk, so the two ways a pavement is walked pass. `pedestrian-route.ts` samples a route
  with no side of its own; the lane is added to the pose.
- Company walks abreast, `ABREAST` apart. The first of a group is the lead and owns the plan; the
  others read the lead's plan and keep beside it. So a company pose reads `person.lead`, and a test
  of the whole crowd checks only the leads for the stride.
- A bold person jaywalks: their loop slants over the road mid-block and comes back the same way a
  few legs later, so it still closes on the side it started. `bold(id)` is also what `give-way.ts`
  reads as misjudging a gap. A test that holds everyone to the crossings skips the bold.
- How many are out follows the hour: `crowdAtHour(zone, tick)` in `crowd-hours.ts`. The crowd is
  placed once, so the hour picks who is drawn, as `outInThis` does for the weather. It is read in
  the renderer only; the record still holds everyone, which is why a test of what is drawn filters
  by it.
- The candidates `near` answers are every loop through the box: on seed 1 about 1300 people round
  the core for 160 in view. `edgeAt` and `edgeMeets` skip the far ones before a pose is read.
  `edgeAt` starts its search at the leg it last found (`legNear`), and a whole tick's midpoint is
  held in a `PoseMemo`, so giving way reads each pose from the roads once.

## The walk plan

- A lap is a list of steps, as a vehicle's tour is: `WALK`, `KERB`, `PAUSE`, `STEP_IN`, `LINGER`,
  `INSIDE`, `STEP_OUT` and `HURRY` (`pedestrian-walk.ts`). `planAt` finds the step at a tick, so a
  pose is still a pure function of the seed, the tick and the id.
- A lap that waits at a light takes whole `SIGNAL_CYCLE`s. The walk after the last light is slowed
  a little, and what is still missing is spent standing at the end. Change a step's length and a
  test of the lap fails, not the lights.
- The walk cycle is read from the distance, never the tick: it stands still while the person does,
  and comes round with the loop.
- `STEP_IN` and `STEP_OUT` walk sideways to a window or a door, `plan.aside` metres off the lane. A
  door is at `edgeOf + side * 0.45` and a window short of the building line, so both stay on the
  pavement. Company stops beside the lead on the side away from it. `INSIDE` sets `pose.hidden`:
  every reader of a pose has to skip a hidden person — `startle`, `stepMakeWay`, the renderer.
- A change of gait blends. A pose carries `from`, `fromCycle` and `blend`, and the renderer mixes
  the two clips, so a stop is not a snap from walking to standing. A pose written by hand (a queue,
  a corner) sets `blend = 0` and `from = gait`.

## The lights

- `pedestrian-crossing.ts` reads the walk round each junction with lights and cuts every run that
  stands on a carriageway into a crossing of one axis (#286). `crossingWait` in `signals.ts` says
  how long a person at the kerb waits. Nobody starts once the crossing has closed, or so late that
  the traffic gets its green with them halfway over. A crossing too long to walk in the whole
  green is started in its first moments only.
- They wait `KERB_BACK` short of the carriageway, and up to `KERB_SPREAD` further back at a depth
  of their own (`kerbDepth`). Without it the people who meet at one corner stand on one spot
  (#721). A jaywalker's slant is skipped: it waits for no light, and the bold take it at
  `HURRY_PACE`.
- `AmbientPedestrians` takes the traffic's `signals` as its fourth argument. Without them nobody
  waits, which is how a test builds a crowd on its own.

## Reactions

- `startle` takes everyone in a radius off their loops into `SimState.pedestrians.startled`, and
  `startledPose` moves them off and stands them still. `releaseFar` gives them back where the player
  cannot see the jump. A person is startled once, which is why the crash writes its fleeing ring
  before its watching one.
- `crowd-reaction.ts` holds the reach of each reaction and nothing else. `gunfire.ts` calls
  `crowdHearsShot` and `crowdFeelsBlast`; `physics.ts` calls `stepCrowdReactions` once a tick. The
  release runs every tick: without it the startled list only grows, and the city stands still.
- A car that misses somebody makes them `dodge`: they jump aside, then turn and shout after it
  (#411). The shout is a cry in `audio/hurt.ts`, `REACTIONS.dodge.ticks` after the jump.
- A reaction moves a person off the place, except `gather`, whose `toward` walks them to it. Add
  one to `REACTIONS` rather than to the callers.

## Making way for the player

- The step aside is the one part of the crowd that depends on the player, so it is stored:
  `PedestrianState.aside`, sorted by id, read with `asideOf` (`crowd-aside.ts`). `stepMakeWay` in
  `make-way.ts` steps it once a tick from `physics.ts`, after giving way.
- Only people within `MAKE_WAY_REACH` of the player on foot are held. A person keeps the side they
  chose until they are back on their lane, so nobody dithers in front of the player. A sprint into
  somebody within `BARGE_REACH` startles them with `scatter`.
- A save carries the list. Adding it raised `SAVE_VERSION` to 21; change the record and
  `save.test.ts` asks for the next version and a new pin.

## Off the buses

- `bus-alight.ts` puts up to `ALIGHT_MOST` people off each bus at the back door, `BACK_DOOR` metres
  behind the call. How many is hashed from the stop, the call and the lap, and where each is comes
  from the ticks since the bus stopped, so nothing is stepped. They walk `WALK_OFF` away from the
  queue and turn in at the building line.
- `BusStops` reads a call for `ALIGHT_SPAN` ticks after it and writes the alighters after the
  queue, through the same `WaitingCrowd` door.

## The occupied corners

- `StreetCorners` (`sim/crime/corners.ts`) lays spots on long runs of pavement, by zone: a busker
  and listeners, a food cart, a stall, a club queue, smokers, a dog walker, a stoop (#409). Each
  kind keeps `HOURS`, and a spot is out on `OUT_CHANCE` of the days, hashed from the seed, the spot
  and the day. A night that runs past midnight counts as the day it began on.
- The people stand in the crowd's mesh through `WaitingCrowd`, like a stop queue. The props — amp,
  cart, stall, dog — are four instanced meshes in `render/crime/corners.ts`. A prop's frame has `+x`
  at the road.
- A busker is heard: `audio/busking.ts` draws a `pluck` per tick from a pentatonic scale, for the
  two nearest, and pushes them last so a full frame drops a note before a gunshot.
- `Subsystem.Corners` is the stream the spots and their people are drawn from.

## The beach

- `BeachLife` (`sim/city/beach-life.ts`) tries one spot at each sample of a waterline, 12 m apart:
  towels, swimmers, a volleyball court, surfers, a bonfire or a party, drawn from `SPOT_ODDS`. A
  lifeguard tower stands every `TOWER_EVERY` samples and a stand every `STAND_EVERY`. The joggers
  and the skaters go to and fro along the dune line (`beach-path.ts`), read from the metres covered.
- Who is out is a function of the seed, the tick and the weather (`beach-hours.ts`). The hour gives
  each kind a fill, the weather a share, and a person is out while a draw fixed for the day is under
  the two multiplied. A falling share sends people home one at a time and never brings one back.
- The beach does not read `Weather.crowd`. `beachShare` falls to 0 at `BEACH_RAIN`, a drizzle the
  pavement carries on through. Surfers follow `surfShare`: the wind is the swell, so a calm day
  has none and a storm brings them in. The lifeguard and the vendors stay while anybody is out.
- `BeachLife.weather` is set every frame by `frame.ts` through `BeachPropView.weather`. A test sets
  it by hand; left alone, it is clear.
- The people stand in the crowd's mesh through `WaitingCrowd`. The gaits `lie`, `sit`, `swim`,
  `surf`, `volley` and `dance` drop the hips or tip the torso in the clip; a skater is `surf` in
  motion. A swimmer stands `SWIM_DEPTH` under the surface, so the water hides all but the head.
- The props are eight instanced meshes in `render/environment/beach.ts`, with `+x` at the sea.
  Towels, parasols and boards take a colour per instance. The flames of a fire are a ninth mesh,
  unlit, so a fire shows after dark.

## Drawing the crowd

- The rig has 13 bones: the ragdoll's nine and then the forearms and the feet. A new bone goes at
  the end, and `CARRIER` names the ragdoll bone it rides on, or `ragdollMatrices` leaves it behind.
- A gait is a row of the baked texture, so a new one goes at the **end** of `GAITS`, with a row in
  `SWINGS` and, for a stand, a pose in `POSES` (`pedestrian-clips.ts`). Frame 0 of `stand` is the
  bind pose; the rig test checks it.
- A phone, a cigarette, an umbrella and a guitar are parts of the one body, from `PART_PROP` up.
  The shader folds a prop to a point unless `pedStyle.y` names it, so a prop costs no draw.
  `cornersOf` in `casualty-pose.ts` skips them, or a body lies on its umbrella.
- The instance is 28 floats (`CROWD_STRIDE`): place, motion, blend (the gait left, its cycle, the
  weight, the head's turn), style (lean, prop) and the colours from 16. That is 11 vertex
  attributes of the 16 WebGPU allows, in few enough buffers — see `docs/render-entities.md`.
- The head turns in bind space, before skinning, on bone 2 only. The lean turns the upper bones
  about `HIP_HEIGHT` after skinning.
- Rain changes the gait in the renderer: an umbrella by `look.umbrella`, or a hunch. A walker's
  gait is blended a little towards `GAIT_NEIGHBOUR` by `look.blend`, so two people of one gait walk
  differently.
- `CrowdPass` (`render/people/crowd-pass.ts`) steps two people walking at each other apart, at most
  `PASS_STEP`, and keeps the room until they are past. It is drawing only: the record never moves
  them. Each steps away from the side the other stands on. A fixed side walks a person who keeps
  left straight into the other one, and the two looked stuck. A walker steps round a person who
  stands or walks slower alone. Company, which shares a lead, never makes room for itself.
- The people drawn beside the crowd go into the pass with `addFixed`: the player on foot, the
  startled, the queues at the stops, and the `standing` list of the police and the dealers. The
  crowd steps round them and takes the whole step. Before, a walker went through them.
- Heads turn to a car that passes fast and near (`WATCH_REACH`, `WATCH_SPEED`), in the renderer.
