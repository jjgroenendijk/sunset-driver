# Baseline city life

The gotchas of the city that lives around the player: the ambient traffic and the lights it stops
at, the parked cars, the tram, the crowd on the pavements and the metro under them. `spec.md`
section 13 is the design. The rest of `src/sim` and `src/ui` — the player, the HUD, the map, the
physics and the vehicles the player drives — is in `docs/sim-and-ui.md`.

## Contents

- Ambient traffic
- The drivers
- The buses
- The wrecks the city tows
- Traffic lights
- Parked cars
- The tram
- Pedestrians
- The metro

## Ambient traffic

- `src/sim/traffic.ts` is the ambient traffic of spec sections 5.3 and 13.1. `AmbientTraffic`
  places the vehicles once for a world: per directed edge, the tier's `TierSpec.density` thinned by
  `ZONE_TRAFFIC` and the district's density, in a lane on the right of the carriageway that
  `laneOffset` divides as `road-section.ts` paints it. Each vehicle drives the closed tour
  `traffic-tour.ts` walks for it, at `CRUISE` of the speed limit of each edge. Vehicles meet at
  junctions and can overlap in a lane, because no vehicle reads another.
- A tour is steps, not legs: `traffic-timing.ts` lays each one down as a drive over part of a leg or
  a wait in one place, in a whole number of ticks. That is why `cursorAt` (evaluated) and `advance`
  (stepped) agree exactly rather than to a rounding, and why `test/traffic.test.ts` and
  `test/sim-traffic.test.ts` can compare them with `toEqual`. A pose is read `SMOOTH` metres behind
  and ahead of the vehicle and stands between the two readings, which is how a vehicle rounds a
  corner. `poseAt` takes a fractional tick, which is what the renderer draws between two ticks.

## The drivers

- `src/sim/driver.ts` is who is at the wheel of each ambient vehicle (spec section 20.2): a
  `Personality` drawn once from the vehicle's own stream, and four numbers. `cruise` is the share
  of the speed limit they drive at, `gap` the metres they leave for each car ahead of them at a
  red, `react` the ticks they stand after their green before pulling away, and `runsAmber` whether
  they take an amber or wait the cycle out. Nothing else is a driver: add a row to `PERSONALITIES`
  rather than a branch to a caller.
- `traffic-timing.ts` reads those four while it lays the tour down, so a personality is a lap timed
  the way that driver would have driven it, not a vehicle reacting to the road. That is what keeps
  a vehicle a pure function of the tick. It also means tailgating is a shorter gap in the queue the
  driver takes their own place in, and hesitation a wait of their own after a green — never a car
  reading the one in front, which no ambient vehicle ever does.
- The place in the queue is counted in cars at the steady driver's gap, so a `place` is the same
  car of the queue whoever is driving; the driver's own gap then says how many metres back that car
  stands, capped at the room the approach has. Counting it at the driver's own gap instead makes
  every place land at about the same metre and the personality stops showing.
- The spread of `cruise` is narrow on purpose. Two vehicles on one stretch pass through each other
  rather than queue, and `test/seed-traffic.ts` caps the pairs that stand on the same ground at
  `TRAFFIC_OVERLAP`. The roster as it stands reads about 0.21 pairs a vehicle on the worst of the
  first 24 sweep seeds, against 0.24 before there were drivers and a cap of 0.3: the varied speeds
  and gaps spread the city out rather than pile it up.
- `test/signal-lap.ts` is what holds a driver honest over a whole lap. It allows standing still on
  a green only within that driver's own `react` of the green starting, and crossing on an amber
  only for a driver who takes ambers. Nobody crosses on red.

## The buses

- `src/sim/bus.ts` says where a bus calls. A bus of the ambient traffic drives the same closed
  route every other vehicle does, and that route is its line. `busCalls` walks the route and takes a
  stop on the first leg that can hold one and on every leg after `STOP_SPACING` metres of route
  since the last call, so a line has stops every few blocks rather than at every corner.
- A stop stands `STOP_IN` metres past the junction the bus came in through. That has to stay under
  `QUEUE_CLEAR`, the least road a signalled approach keeps clear behind its queue: a stop further in
  could fall inside the queue for the lights, and the halt for the light would land on the same
  metre as the halt at the kerb. `test/bus.test.ts` holds the two constants to that.
- `traffic-timing.ts` lays a call down with `driveLeg`, which splits the drive over a leg in two
  around a halt of `BUS_DWELL`. `legTicks` is the same arithmetic before anything is laid down,
  which is how the tick a bus reaches a stop line already carries the dwell it spent at the kerb;
  reading the light without it would read the wrong colour.
- `Tour.stepCall` is 1 on each of those halts. Without it nothing downstream can tell a bus at a
  kerb from a vehicle the timing forgot to send on: `test/signal-lap.ts` reads it to allow the one
  and still fault the other, and it has to allow the step behind the cursor as well, since the tick
  a call ends on is the first tick of the drive out of it and the bus has not moved yet.
- `Steps.stretch` never grows a wait, for the same reason. The stretch that brings a lap round to
  its anchor may only slow drives; growing a dwell would stand the bus at the kerb for longer than
  its own stop.
- Nothing here knows about passengers, and the dwell is the same at every stop. A bus that stood for
  as long as its passengers took would have to be stepped, and the traffic is never stepped.

## The wrecks the city tows

- `src/sim/tow.ts` is the one thing that ever takes a vehicle back out of the record. Everything the
  player touches goes into `TrafficState.promoted` and stays there, so a session spent crashing
  into traffic leaves a growing trail of burnt-out shells behind it.
- A shell that has stood `TOW_WAIT` ticks since it went up, with the player `TOW_REACH` metres away
  or further, is taken. Only a shell: a car abandoned in one piece is still there on the player's
  return, which is what spec section 20.2 asks for. `TOW_REACH` is wider than `TRAFFIC_VIEW`, so a
  wreck is never taken while it is on the screen, and wider than the physics box, so a towed record
  never leaves a Rapier body behind it.
- The tow truck is not on the road. Driving one to the wreck needs the routing spec section 20.3
  brings for the police, the ambulances and the fire engines; until then this is the parked cars'
  bargain, where the city turns over while nobody is looking at it.
- A burnt-out parked car is promoted under `PARKED_ID` plus its bay, and the bay stays empty while
  that record lasts, so towing it also gives the kerb back to `parked.ts`.

## Traffic lights

- `src/sim/signals.ts` is the traffic lights. A junction takes one where an arterial meets a street
  or another arterial on the ground, and never with a highway. Its roads split into the arterial's
  axis and the one across it, and a light is a function of the tick and the junction's seeded
  offset alone. `crossingOpen` is the phase the pedestrians of spec section 13.1 will wait for.
  `TrafficRoads.junctions` is what turns the lights on; a test that leaves it out gets none. A
  level crossing of the tram takes a light whatever joins it, an alley included.
- A light and a tour only agree for ever when the tour takes whole `SIGNAL_CYCLE`s. So a tour that
  meets a light is timed from one stop line, its `sync`: tick 0 is that line's green. The drive back
  to it is stretched to arrive on red, and `phaseOf` moves the vehicle by up to half a cycle so its
  tick 0 falls on that green. `test/signal-lap.ts` steps a lap and holds a vehicle to the lights.
- That snap leaves a lap only `period / SIGNAL_CYCLE` ticks a vehicle may stand at, so the slot
  placement drew for it is gone and nothing in the phase keeps two vehicles apart (issue #356). What
  does is the vehicle's own place in the queue, drawn once and passed to `timeTour`: it waits that
  many whole cars back from every line it meets, the anchor's included, so it also pulls away that
  much later and stays behind for the rest of the lap. `queueBack` bounds the queue three ways — it
  stops `QUEUE_CLEAR` short of the junction behind, where a tram may cross; its back still reaches
  the line within half the green; and it is no longer than the road that has filled since the light
  stopped being green, which is what keeps a vehicle from standing still on a green. The sweep holds
  the city to `TRAFFIC_OVERLAP` pairs of vehicles a vehicle standing on the same ground; before the
  fix the first sweep seeds read about twice that.
- On seed 1 about three vehicles in four meet a light, they spend about a third of the time
  standing, and timing the tours takes the traffic from about 35 ms to about 180 ms to place.
- `src/sim/traffic-bodies.ts` is the Rapier half. Inside the box of ground tiles, each vehicle is a
  kinematic body aimed at its pose on the next tick. A vehicle entering the box is evaluated on that
  tick and stepped after it. The player touches a vehicle when `footprintsTouch` finds their car or
  their capsule within `TOUCH_MARGIN` of it. The touched vehicle leaves its tour for good: its
  record goes into `SimState.traffic.promoted`, ascending by id, and it becomes a dynamic box with
  its speed. A touch is a 2D box test and not a Rapier contact: Rapier makes no contact between
  two kinematic bodies by default, and the player's capsule is one.

## Parked cars

- `src/sim/parked.ts` says which bay holds a car at a tick. Each bay has its own stay length and
  offset; a stay rolls once, keyed on its first tick, against `FILL` at the middle of the stay. So
  a car stays put for the whole stay, and a street fills and empties by the hour with nothing
  stepped. A touched parked car is promoted like the traffic, under `PARKED_ID` plus its bay, and
  the bay stays empty while that record lasts. `PromotedVehicle.paint` is kept because a parked
  car's paint depends on the stay it was taken in.
- `parked-bodies.ts` stands a fixed body in each full bay of the physics box. It asks a bay again
  only when its stay ends, so a tick costs nothing for the bays that did not turn over. The bays
  come from the chunk workers, so `main.ts` sets `Ground.parked` after `settle`, and the physics
  reads it on every step rather than once when it is built.
- The ground of the game hands the physics the traffic as `Ground.traffic`. A test that is not about
  traffic leaves it out. `test/traffic-grid.ts` is a grid of every tier for the tests that need it.

## The tram

- `src/sim/tram.ts` is the tram of spec section 13.2, a function of the tick like the traffic.
  `tram-timing.ts` lays the loop down as the steps of a traffic tour: it halts short of every stop,
  light and level crossing, stands `DWELL` at a stop, and goes on at a light only with `TRAM_CLEAR`
  of its green left. So a level crossing is obeyed through the lights: the tram never crosses on the
  green of the road across it. The loop takes whole `SIGNAL_CYCLE`s, and each further tram runs it
  whole cycles behind, for the reason a traffic tour does.
- A tram is 32 m long, and many arterial runs are shorter than that and a junction. A tram waiting
  at such a light leaves its tail across the junction behind. `hold` waits at the light before
  instead, for a start that meets the short lights ahead on green. One wait seldom fits more than
  two of them, so on seed 1 about a third of the tram's waits are still on a short run.
- The loop is read from `TramDescription.edges`, which are graph ids: the graph is rebuilt from the
  roads on demand and the same roads give the same ids. A car is read at its two bogies on the
  track, `TRAM_TRACK` right of the centreline. On a run the tram drives, `laneOffset` moves the
  traffic lanes out of the middle `TRAM_HALF`, so no car drives through a tram.
- `tram-bodies.ts` stands each car in the physics box as a kinematic box, under `TrafficBodies`, so
  a ground without traffic has no tram. A touch does not take a tram off its loop. The people at a
  stop are a count of the ticks since the last tram left, and fall to none while one boards them;
  `PedestrianView` draws them standing. `TramLine.bells` is the hook the tram bells of spec section
  15 will ring: a tram pulling away from a halt on that tick.
- The pedestrians do not wait at a level crossing yet, as they wait at no light (#286). Once they
  keep to `crossingOpen`, they keep to the tram too, since it only crosses on their red.

## Pedestrians

- `src/sim/pedestrians.ts` is the crowd of spec sections 5.3 and 13.1. `AmbientPedestrians` places
  people per directed edge of a tier with a pavement, from `TierSpec.walkers` thinned by
  `ZONE_PEDESTRIANS`. A person walks one pavement round a loop, at a pace of their gait. The loop
  starts on the edge they were placed on: `walkOut` walks as the traffic does but only
  `WALK_REACH`, and a loop that closes some way off is walked out to and back from. Without that a
  person spawns up to a loop away from their district, and wears its clothes in the wrong zone.
- A loop takes a whole number of ticks and a whole number of strides, so `cursorAt` and `advance`
  agree exactly and the walk cycle comes round without a jump. `pedestrian-route.ts` cuts two
  pavement lines where they cross, which is how a turn one way keeps to the kerb and a turn the
  other way crosses both roads. A pose within `NODE_REACH` of a node checks `onCarriageway` too:
  a pavement that runs straight over a junction crosses the side road, and stands lower there.
- The candidates `near` answers are every loop through the box, and on seed 1 that is about 1300
  people round the core for 160 in view. `edgeAt` and `edgeMeets` skip the far ones before a pose
  is read. Reading the rest costs about 0.6 ms a frame on an M-series core.
- `startle` takes everyone in a radius off their loops into `SimState.pedestrians.startled`, and
  `startledPose` moves them off and stands them still. `releaseFar` gives them back to their loops
  where the player cannot see the jump. A person is startled once: a second fright over the same
  people does nothing, which is why the crash writes its fleeing ring before its watching one.
- `src/sim/crowd-reaction.ts` is what calls those: the reactions of spec section 20.1. It holds the
  reach of each — a gunshot, a blast, a car, a crash — and nothing else. `gunfire.ts` calls
  `crowdHearsShot` on the tick a loud weapon goes off and `crowdFeelsBlast` when a projectile
  bursts; `physics.ts` calls `stepCrowdReactions` once a tick with the severity its `crash` answers,
  which scatters the people the player's car is about to reach, rings a crash, and releases whoever
  the player has driven away from. The release runs every tick: without it the startled list only
  ever grows, and the whole city ends up standing still.
- A reaction moves a person off the place, except `gather`, whose `toward` walks them to it and
  stands them facing it. Add one to `REACTIONS` rather than to the callers, so what it costs a
  reader is one row of a table.

## The metro

- `src/sim/metro.ts` is the fast travel of spec section 13.3, and nothing of the line itself is
  simulated: what the player meets is a station entrance on the street. `src/world/metro.ts` picks
  the parcels, out of the same pass that picks the police stations, and `main.ts` turns each one
  into the road place beside it. A player on foot within `ENTRANCE_REACH` of one has visited it, so
  a station is earned by walking to it and never by driving past.
- A trip is `TRAVEL_TICKS` of fade, teleport and arrival, and those ticks are stepped like any
  others: the clock never skips, which is what makes the trip safe in the shared session of spec
  section 19. `stepMetro` runs before the physics, and while a trip is in the record the physics is
  stepped with an empty frame, so nothing the player presses steers the walk under the fade.
- The destination is `InputFrame.travel`: a place in the list the panel shows, counted from 1, not
  a station id. A recorded stream therefore replays the trip the player picked. `src/ui/travel.ts`
  draws that list and the black sheet over the frame; the number keys are read as an edge in
  `Keyboard`, or a held key would ride the line back and forth.
