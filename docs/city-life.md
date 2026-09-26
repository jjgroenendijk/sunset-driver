# Baseline city life

The gotchas of the city that lives around the player: the ambient traffic and the lights it stops
at, the parked cars, the tram, the crowd on the pavements, the metro under them, the animals, and
the events and the street crime the city runs on its own. `spec.md` section 13 is the design of the
first half and section 20 of the second. The rest of `src/sim` and `src/ui` — the player, the HUD,
the map, the physics and the vehicles the player drives — is in `docs/sim-and-ui.md`.

## Contents

- Ambient traffic
- How a vehicle moves
- Giving way (in `docs/giving-way.md`)
- The drivers
- The buses
- The bus stops
- The vehicles at work
- The wrecks the city tows
- Traffic lights
- Parked cars
- The tram (in `docs/tram.md`)
- Pedestrians (in `docs/crowd.md`)
- Casualties
- The metro
- Wildlife
- What the city puts on
- The crime the city commits

## Ambient traffic

- `src/sim/traffic/traffic.ts` is the ambient traffic of spec sections 5.3 and 13.1.
  `AmbientTraffic` places the vehicles once for a world: per directed edge, the tier's
  `TierSpec.density` thinned by `ZONE_TRAFFIC` and the district's density, in a lane on the right of
  the carriageway that `laneOffset` divides as `road-section.ts` paints it. A vehicle keeps a share
  of the carriageway, not a lane index: `laneOn` turns it into a lane of each run, so a narrow run
  spreads the vehicles of a wide one over all its lanes. Each vehicle drives the closed tour
  `traffic-tour.ts` walks for it, at `CRUISE` of the speed limit of each edge. No tour reads
  another, so two tours can put two vehicles on the same ground. Near the player, giving way (below)
  keeps them apart. A ramp is one way, so a tour that drives one is closed by a route back to its
  start rather than by driving its legs in reverse (`docs/interchanges.md`).
- A tour is steps, not legs: `traffic-timing.ts` lays each one down as a drive over part of a leg or
  a wait in one place, in a whole number of ticks. That is why `cursorAt` (evaluated) and `advance`
  (stepped) agree exactly rather than to a rounding, and why `test/sim/traffic/traffic.test.ts` and
  `test/sim/traffic/sim-traffic.test.ts` can compare them with `toEqual`. `poseAt` takes a
  fractional tick, which is what the renderer draws between two ticks. How a vehicle moves inside a
  step is the next section.

## How a vehicle moves

- `src/sim/traffic/traffic-motion.ts` drives each step along a speed profile, not at one even speed.
  The vehicle pulls away from rest, brakes into a halt, and slows for a turn. A step still starts
  and ends on the same metre and tick, so the lights and the queues are kept. Read a vehicle's metre
  in its step through `metresOf`, never as `into / ticks` of the step: the two differ.
- The timing pays for the profile. `share` in `traffic-timing.ts` adds `rampTicks` for the speed at
  each end of a drive, and `endSpeeds` gives the profile the same speeds. If the two disagree, the
  profile makes up the time on the straight, above the speed limit. The worst of seed 1 was once
  1.65 times the limit.
- A drive is split at its stop line (`overLine`) when the vehicle pulls away from a queue. The line
  is then crossed on the tick the timing read the light at, not later.
- The speed through a join is the tighter of the two roads' cruise and `tour.turns`. `turnsOf` in
  `traffic.ts` reads the turn from the centreline `SMOOTH` metres either side of the node.
  `throughSpeed` then caps it at what the drives on either side can reach.
- A pose is the mean of five readings of the lane over `SMOOTH` metres either side, and faces from
  the first reading to the last. The old mean of two readings moved the car along a straight
  diagonal while it turned, so it slid through the corner. At every corner of the road the lane
  swings round over `SWING` metres (`RouteSampler`'s `around`), both where two edges meet and inside
  one. Without that swing the lane point jumps by up to a lane width.
- `SMOOTH` is 5 on purpose. At 6, a right turn cuts across the pavement corner, and giving way no
  longer keeps the people out of the cars (`test/sim/traffic/give-way.test.ts`, seed 4).
- A bend inside one edge has no turn speed, because the timing splits drives only at joins and at
  lines. A vehicle takes such a bend at its cruise (issue #727).

## The drivers

- `src/sim/traffic/driver.ts` is who is at the wheel of each ambient vehicle (spec section 20.2): a
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
  rather than queue, and `test/sweep/seed-traffic.test.ts` caps the pairs that stand on the same
  ground at `TRAFFIC_OVERLAP`. The roster as it stands reads about 0.21 pairs a vehicle on the worst
  of the first 24 sweep seeds, against 0.24 before there were drivers and a cap of 0.3: the varied
  speeds and gaps spread the city out rather than pile it up.
- `test/support/signal-lap.ts` is what holds a driver honest over a whole lap. It allows standing
  still on a green only within that driver's own `react` of the green starting, and crossing on an
  amber only for a driver who takes ambers. Nobody crosses on red.
- The indicators (`indicator.ts`) are a pure function of the tour, like the pose. `turnSides`
  reads the side of the turn at the end of each leg off `RoadGraph.bend`; only a node of degree 3
  or more counts, so a driver does not indicate round a bend in one road. `sideOn` turns it on
  `Driver.indicates` metres before the node and keeps it `THROUGH` metres into the next road. A
  driver with 0 there never indicates. `bend` is above 0 for a right turn: the map's `y` runs down
  the screen, so the right of a driver heading along `(x, y)` is `(-y, x)`, as in `swerveOnto`.

## The buses

- `src/sim/transit/bus.ts` says where a bus calls. A bus of the ambient traffic drives the same
  closed route every other vehicle does, and that route is its line. `busCalls` walks the route and
  takes a stop on the first leg that can hold one and on every leg after `STOP_SPACING` metres of
  route since the last call, so a line has stops every few blocks rather than at every corner.
- A stop stands `STOP_IN` metres past the junction the bus came in through. That has to stay under
  `QUEUE_CLEAR`, the least road a signalled approach keeps clear behind its queue: a stop further in
  could fall inside the queue for the lights, and the halt for the light would land on the same
  metre as the halt at the kerb. `test/sim/transit/bus.test.ts` holds the two constants to that.
- A stop also needs a pavement, which a highway has none of, so a bus drives a motorway leg
  through without calling. On the grid of `traffic-grid.ts` about half the buses walk a route of
  nothing but highway and so never call at all.
- `traffic-timing.ts` lays a call down with `driveLeg`, which splits the drive over a leg in two
  around a halt of `busDwell`. `legTicks` is the same arithmetic before anything is laid down,
  which is how the tick a bus reaches a stop line already carries the dwell it spent at the kerb;
  reading the light without it would read the wrong colour.
- `Tour.stepCall` is 1 on each of those halts. Without it nothing downstream can tell a bus at a
  kerb from a vehicle the timing forgot to send on: `test/support/signal-lap.ts` reads it to allow
  the one and still fault the other, and it has to allow the step behind the cursor as well, since
  the tick a call ends on is the first tick of the drive out of it and the bus has not moved yet.
- `Steps.stretch` never grows a wait, for the same reason. The stretch that brings a lap round to
  its anchor may only slow drives; growing a dwell would stand the bus at the kerb for longer than
  its own stop.
- The dwell is the stop's, not the line's: `BusDemand.riders` draws how many people a kerb gathers
  from how busy `traffic.ts` reads that road, and `busDwell` is the doors plus the time that many
  take to board. `AmbientTraffic.demand` holds the one copy of it, because the timing and the
  drawing must agree on the number or a bus pulls away from a queue it never took.
- Which bus calls at which kerb is not the dwell's to decide, and it cannot be: the tours are timed
  one at a time and none reads another, so at timing time no bus knows what else serves its stops.
  A bus therefore stands its stop's full dwell even where the bus in front has just emptied the
  kerb.

## The bus stops

- `src/sim/transit/bus-stops.ts` gathers the stops of a world once the tours are timed. A call
  always stands `STOP_IN` metres into its leg, so the stops are the directed edges the buses call
  on, and two buses on one line share one record. A stop is not in the world description and cannot
  be: where a bus calls is a function of the route it walked.
- Nothing is stepped. Each call is kept as `arrive` and `depart` in the ticks of the world —
  `stepStart - phase` over the tour's period, the way `cursorAt` reads a vehicle — so the ticks
  since the kerb was last free is the smallest of those residues, over every bus that calls there.
  That is what fills the queue, exactly as the ticks since the last tram left fill a tram stop's.
- `src/sim/transit/stop-queue.ts` is the half the tram and the buses share: `layQueue` stands people
  along the pavement to the right of the direction of travel, `waitingAt` says how many of the
  places are filled on a tick, and `writeQueue` writes them into a caller's list without allocating.
  Both stops keep their own caps and rates; only the arithmetic is shared.
- `src/render/transit/bus-stops.ts` draws the post and, at a stop of `SHELTER_RIDERS` or more, the
  shelter. It is not chunk furniture for the same reason the record is not in the world: the chunk
  worker has the world and not the traffic. `BusStopView` stands them round the player as `TramView`
  does, two draws for every stop in view. The people are drawn with the crowd (`PedestrianView`).
- A stop is drawn in its own frame with `+x` at the road and the origin on the middle of the
  pavement, so nothing may reach further than half the narrowest pavement a bus route runs along.
  `test/sim/transit/bus-stops.test.ts` holds every box to that. A flag sits on top of the mast
  rather than across it: a face the mast runs through reads as two white bars.

## The vehicles at work

- `src/sim/traffic/jobs.ts` gives a vehicle of the traffic a job: a taxi, a delivery van, a
  garbage truck or a street sweeper. `drawJob` takes one draw from a stream of its own
  (`JOB_STREAM`), so no other vehicle's class, paint, route or driver moves. A job is not a class:
  a taxi is a saloon and a sweeper a van. Only a garbage truck changes the class drawn, to a truck.
- A job changes three things before the tour is timed: the kerbs it calls at, the roads it may
  take and the driver's cruise. The calls go through `TourPlan.calls`, the same door a bus uses, so
  `stepCall` is 1 on a taxi at a kerb as well. `bus-stops.ts` therefore reads the buses alone.
- Every call stands `STOP_IN` into a leg that `holdsStop` accepts, as a bus stop does. That keeps
  a job's halt out of the queue for a light. A call further along a leg would need the same care.
- A taxi picks up at the first kerb and sets down at the first kerb a third of the route further
  on. `fareOf` reads the two back off the tour, and `hiredAt` says when the fare is on board: the
  roof sign is dark from pulling away at the pick up to pulling away at the set down.
- A delivery van stands `UNLOAD` at one kerb. `Indicators.sideAt` returns `HAZARDS` (2) on that
  step, and the trim shader of `vehicle-glow.ts` lights both sides on a signal above 1.5.
- A garbage truck and a sweeper keep to streets and alleys (`jobPermit`, which lets the truck onto
  roads that bar trucks) and cruise at `CRAWL` of the limit. The truck also stops `BINS` at every
  kerb. They work at every hour, since the tour has no time of day (issue #766).
- `src/render/vehicles/job-tops.ts` draws the taxi signs and the beacons as one instanced unit
  box, stretched onto the roof by the instance matrix. The roof stands at `spec.halfHeight`. A
  truck of the roster has an open deck, so a garbage truck gets a bin body on it: a second box, in
  a lit material. Without it the truck reads as a flatbed with a green cab.

## The wrecks the city tows

- `src/sim/traffic/tow.ts` takes a vehicle back out of the record, and `rejoin.ts` puts a bumped
  car near the player back on its tour (`docs/giving-way.md`). Everything else the player touches
  stays in `TrafficState.promoted`, so a session spent crashing into traffic leaves shells behind.
- A shell that has stood `TOW_WAIT` ticks since it went up, with the player `TOW_REACH` metres away
  or further, is taken. A car of the city that was only bumped, and is not on fire, is taken as
  soon as the player is that far. The player's own car, left where they took another, carries
  `left` and is never taken: it is still there on their return, as spec section 20.2 asks.
  `TOW_REACH` is wider than `TRAFFIC_VIEW`, so a wreck is never taken while it is on the screen,
  and wider than the physics box, so a towed record never leaves a Rapier body behind it.
- The tow truck is not on the road. Driving one to the wreck needs the routing spec section 20.3
  brings for the police, the ambulances and the fire engines; until then this is the parked cars'
  bargain, where the city turns over while nobody is looking at it.
- A burnt-out parked car is promoted under `PARKED_ID` plus its bay, and the bay stays empty while
  that record lasts, so towing it also gives the kerb back to `parked.ts`.

## Traffic lights

- `src/sim/traffic/signals.ts` is the traffic lights. A junction takes one where an arterial meets a
  street or another arterial on the ground, and never with a highway. Its roads split into the
  arterial's axis and the one across it, and a light is a function of the tick and the junction's
  seeded offset alone. `crossingOpen` is the phase the pedestrians of spec section 13.1 will wait
  for. `TrafficRoads.junctions` is what turns the lights on; a test that leaves it out gets none. A
  level crossing of the tram takes a light whatever joins it, an alley included, and a highway at
  its interchange too: without one nothing holds the traffic while the tram crosses, so the tram
  halted and rang at a crossing nobody obeyed (issue #302).
- A light and a tour only agree for ever when the tour takes whole `SIGNAL_CYCLE`s. So a tour that
  meets a light is timed from one stop line, its `sync`: tick 0 is that line's green. The drive back
  to it is stretched to arrive on red, and `phaseOf` moves the vehicle by up to half a cycle so its
  tick 0 falls on that green. `test/support/signal-lap.ts` steps a lap and holds a vehicle to the
  lights.
- That snap leaves a lap only `period / SIGNAL_CYCLE` ticks a vehicle may stand at, so the slot
  placement drew for it is gone and nothing in the phase keeps two vehicles apart (issue #356). What
  does is the vehicle's own place in the queue, drawn once and passed to `timeTour`: it waits that
  many whole cars back from every line it meets, the anchor's included, so it also pulls away that
  much later and stays behind for the rest of the lap. `queueBack` bounds the queue two ways: its
  back still reaches the line within half the green, and it stops `QUEUE_CLEAR` short of a node
  that `TrafficSignals.keepsClear` — a junction with lights, or a level crossing of the tram. It
  does not depend on when the vehicle arrives: a halt reached while the light is still green is
  met by slowing the drive to it instead. The sweep caps overlapping pairs at `TRAFFIC_OVERLAP`
  and stopped ones at `TRAFFIC_STACKED`.
- A queue that does not fit its road runs back onto the leg before, through any node that does not
  keep clear (issue #357). Without that, every place on a short approach maps to the same car, and
  a whole red's worth of vehicles stands on one spot. `test/support/signal-lap.ts` holds a vehicle
  standing there to the light of the next leg. A bus never spills back, so its halt never lands
  on its own call. What still stacks is a short block between two junctions with lights: the
  queue may not run into the junction behind, and holding the overflow at the light before is
  issue #488.
- A leg with a light is driven in two at the stop line even when the light is green, so the drive
  over the line starts on the tick the colour was read at. One drive over the whole leg rounds the
  crossing a tick early, and on the first tick of a green that tick is still red.
- On seed 1 about three vehicles in four meet a light, they spend about a third of the time
  standing, and timing the tours takes the traffic from about 35 ms to about 180 ms to place.
- `src/sim/traffic/traffic-bodies.ts` is the Rapier half. Inside the box of ground tiles, each
  vehicle is a kinematic body aimed at its pose on the next tick. A vehicle entering the box is
  evaluated on that tick and stepped after it. The player touches a vehicle when `footprintsTouch`
  finds their car or their capsule within `TOUCH_MARGIN` of it. The touched vehicle leaves its tour
  until it rejoins it or is towed: its record goes into `SimState.traffic.promoted`, ascending by
  id, and it becomes a dynamic box with its speed. A touch is a 2D box test and not a Rapier
  contact: Rapier makes no contact between two kinematic bodies by default, and the player's
  capsule is one.
- A shot, a swing or a blast promotes a car as a touch does (`docs/sim-and-ui.md`, Weapons). A
  promoted car takes crash damage from the speed its body lost over one tick, as the player's does.

## Parked cars

- `src/sim/traffic/parked.ts` says which bay holds a car at a tick. Each bay has its own stay length
  and offset; a stay rolls once, keyed on its first tick, against `FILL` at the middle of the stay.
  So a car stays put for the whole stay, and a street fills and empties by the hour with nothing
  stepped. A touched parked car is promoted like the traffic, under `PARKED_ID` plus its bay, and
  the bay stays empty while that record lasts. `PromotedVehicle.paint` is kept because a parked
  car's paint depends on the stay it was taken in.
- `parked-bodies.ts` stands a fixed body in each full bay of the physics box. It asks a bay again
  only when its stay ends, so a tick costs nothing for the bays that did not turn over. The bays
  come from the chunk workers, so `main.ts` sets `Ground.parked` after `settle`, and the physics
  reads it on every step rather than once when it is built.
- The ground of the game hands the physics the traffic as `Ground.traffic`. A test that is not about
  traffic leaves it out. `test/support/traffic-grid.ts` is a grid of every tier for the tests that
  need it.

## The tram

- The tram of spec section 13.2 has a doc of its own, `docs/tram.md`: the loop and its lights, the
  short runs, the track, and the turns the traffic holds while a tram is in the junction.

## Pedestrians

- The crowd has a doc of its own, `docs/crowd.md`: how it is placed, the walk plan, the lights,
  the reactions, making way for the player, the people off the buses, the occupied corners, and
  how it is drawn.

## Casualties

- `src/sim/crowd/casualty.ts` holds the rules for hurting a person, and `casualty-motion.ts` holds
  the record and where it puts them. A person has no health until the first hit writes them into
  `SimState.pedestrians.casualties`. A hit takes them out of `startled`, so nobody is in both lists.
  `startle` skips a casualty, and `crowdPoseOf` answers undefined for one: every caller that walks
  the crowd has to pose a casualty through `casualtyPose` instead.
- The motion is a closed form of the record and the tick, like a fright's. A new hit replaces the
  record and starts a new motion from wherever the old one had got to. The record's `reach` is how
  far the physics said the push could go before a wall. The motion never passes it, and a
  wounded person with less than `WALL_ROOM` to go moves off along the wall instead.
- Nobody on foot stands in the physics world, so `crowd-contact.ts` finds them by geometry: an
  upright cylinder for someone standing, three balls for a body. `gunfire.ts` measures a round
  against the crowd only up to what the Rapier cast met, so a person behind a wall is safe.
- `car-strike.ts` runs after the step. What it answers is put into the chassis by `physics.ts`,
  and the velocity is read back into the record at once. Without that, the next tick reads the
  speed a person took off the car as a crash.
- A body taken away is marked `gone` and not removed. Removing it would put the person back on
  their loop at once, where the player could see them walk off. The record is dropped only past
  `RELEASE_FAR`, as a fright is.
- `hurtPerson` is the one place a hit on a person costs the player: the crime, the fright, the
  ambulance and the cash. Every cause — a round, a blow, a blast, a car — goes through it.

## The metro

- `src/sim/transit/metro.ts` is the fast travel of spec section 13.3, and nothing of the line itself
  is simulated: what the player meets is a station entrance on the street.
  `src/world/transit/metro.ts` picks the parcels, out of the same pass that picks the police
  stations, and `metroEntrances` in the same file stands each one on the middle of the pavement
  beside it. A player on foot within `ENTRANCE_REACH` of one has visited it, so a station is earned
  by walking to it and never by driving past.
- That one answer is where the stairs are drawn as well (`src/render/transit/metro-mesh.ts`),
  because the reach is measured from it: a station snapped to the road centreline instead puts an
  arterial's stairs 10 m outside the reach of the panel they belong to. The road it is found from is
  one with a pavement, since a tier without one claims no ground beside its carriageway to stand a
  stair on.
- A trip is `TRAVEL_TICKS` of fade, teleport and arrival, and those ticks are stepped like any
  others: the clock never skips, which is what makes the trip safe in the shared session of spec
  section 19. `stepMetro` runs before the physics, and while a trip is in the record the physics is
  stepped with an empty frame, so nothing the player presses steers the walk under the fade.
- The destination is `InputFrame.travel`: a place in the list the panel shows, counted from 1, not a
  station id. A recorded stream therefore replays the trip the player picked.
  `src/ui/panels/travel.ts` draws that list and the black sheet over the frame; the number keys are
  read as an edge in `Keyboard`, or a held key would ride the line back and forth.

## Wildlife

- `src/sim/city/wildlife.ts` is spec section 20.4. `AmbientWildlife` places each species on anchors
  of its own habitat — the waterline of a beach, a run of pavement, an alley, a wilderness track —
  and each animal then works a small patch around its anchor for ever. Nothing is stepped and
  nothing is on the record: `poseAt` evaluates one at any moment, whole tick or between two.
- A patch is a circle with a wander laid over it, so an animal never stands more than
  `1 + 0.3 * √2` radii from its anchor. `wildlifeReach()` is that bound over the whole table, and
  it is what the `EdgeIndex` is built with: build the index with a smaller reach and the animals at
  the edge of a view are simply never found.
- `SPECIES` is the one table. A row holds the habitat, the hours the species keeps, its pace, its
  patch, how many share an anchor, and how far it gives way. Adding an animal is a row there and a
  row in `LOOKS` in `src/render/environment/wildlife.ts`; nothing else branches on a species.
- Giving way is a pure displacement off whoever is nearest, so a flock parts as the player walks
  into it and closes again behind them with no byte written down. `lift` is what makes that a flock
  of pigeons taking off rather than sidling.
- `src/render/environment/wildlife.ts` draws them as two instanced models, a bird and a beast, so
  seven species cost two draws. There is no rig: the camera stands 36 m up, so a wing beat is the
  bird drawn narrower and wider and a stride is the beast bobbing, both off the tick.

## What the city puts on

- `src/sim/city/city-events.ts` is the diary of spec section 20.5. A venue is picked once for a
  world the way a dealer's corners are — a point in a district of the right character, snapped to
  the nearest street — and whether an event runs at all is drawn from the day it would run on. A
  kind whose ground is missing on a seed simply never runs, which is how a seed with no beach holds
  no beach party.
- An hour past 24 in `EVENTS` closes an event on the next day, and `eventsAt` therefore reads
  yesterday's diary as well as today's. Read only today's and a party that runs to two in the
  morning disappears at midnight.
- The rush hour is the one event with no ground of its own, so it carries radius 0 and is asked
  through `rushHourAt` rather than found through `eventAt`. It does not yet thin or thicken the
  traffic: the tours are laid out once for a world (#424).
- `eventPeople` is the crowd an event has drawn, as a function of the seed and the tick. A parade
  is ranks marching along its own street, which is what closing the street looks like from above;
  everything else stands and sways. Both kinds draw the same three numbers per person, so the
  stream stays in step whichever branch is taken.

## The crime the city commits

- `src/sim/city/street-crime.ts` is the other half of spec section 20.5. The day is cut into
  `SLOT_TICKS`, and each district draws at most one incident per slot from `(seed, slot)`: one roll
  over every kind at once, so the weights hold against each other and no district ever holds two.
  The corners are picked once for a world, exactly as the dealers' pitches are.
- `crimesAt` reads the slot the tick falls in and the one before it, because an incident runs
  longer than a slot. Reading one slot loses every incident a few minutes after it starts.
- The record holds only what the player settled (`SimState.crimes`), because everything else is
  already a function of the tick. `settledOf` is a binary search, so the list is kept in id order:
  `addSettled` is the only thing that writes it.
- Breaking one up is `INTERRUPT_RANGE` and nothing else. A kind that is not `breakable` — the
  traffic stop — is the police's own business and breaks up for nobody. Robbing a deal pays and
  raises the heat, and every raise goes through `report` in `police.ts` like all the others.
- `src/ui/hud/street-life.ts` is the screen half of both: the event crowd and the two people of each
  incident, written into the same list of standing people the dealers and the enforcers stand in,
  and the marks both put on the map. It is the last link of that chain, so `MissionMarks` is
  written after it. Only what is within `STREET_LIFE_NEAR` is built at all.
- The list of people runs from `ui/hud/givers.ts` through the dealers, the enforcers, this, the
  police on foot and the emergency crews, and what the last of them holds is what the crowd mesh
  draws. A link with nobody of its own still copies what it was handed: it may skip its own work on
  a quiet frame, never the copy, or everybody before it leaves the street.
