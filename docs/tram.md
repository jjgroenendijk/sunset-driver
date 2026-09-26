# The tram

The gotchas of the tram of spec section 13.2: the loop and how it keeps to the lights, the short
runs a tram does not fit, the track, and the traffic that waits while a tram crosses its turn. The
code is `src/sim/transit/tram.ts`, `tram-timing.ts`, `tram-motion.ts`, `tram-bodies.ts` and
`tram-guard.ts`. The traffic and the lights themselves are in `docs/city-life.md`.

## Contents

- The loop and its lights
- How the tram drives
- Short runs
- The track and the stops
- Where a stop stands
- The platform
- The people at a stop
- The turns a tram crosses

## The loop and its lights

- `src/sim/transit/tram.ts` is the tram of spec section 13.2, a function of the tick like the
  traffic. `tram-timing.ts` lays the loop down as the steps of a traffic tour: it halts short of
  every stop, light and level crossing, stands `DWELL` at a stop, and goes on at a light only with
  `TRAM_CLEAR` of its green left. So a level crossing is obeyed through the lights: the tram never
  crosses on the green of the road across it. The loop takes whole `SIGNAL_CYCLE`s, and each further
  tram runs it whole cycles behind, for the reason a traffic tour does.
- The pedestrians wait at the lights (`docs/crowd.md`), so they keep to the tram too: it only
  crosses on their red.

## How the tram drives

- `tram-motion.ts` gives the tram its own rate, `TRAM_ACCEL` 1.3 m/s², half a car's. `timeTram`
  asks `tramDriveTicks` how long each drive takes with its ramps. `TramMotion` then drives each
  step along a trapezoid that covers its metres in its ticks, as `traffic-motion.ts` does for a car.
  The guard reads the front through `TramMotion.tickAt`, so the two agree.
- A drive may not leave faster than the tram can reach from its entry speed. `TramMotion` also runs
  a backward pass, twice round the loop, that caps each exit at what the tram can brake from before
  the next halt. Without both, a short drive between two halts ramped at about 10 m/s².
- The tram slows for a corner: `tramJoins` reads the bend at each node over 8 m, since the bogies
  are 7 m apart.
- At a light the tram does not always stop. `toLine` tries to run past at `passOf`, then slower in
  steps of `ROLL_STEP` down to `ROLL`, for a speed that meets the green. Only when none does, it
  brakes to the line and waits. `TRAM_CLEAR` is 7 s of green left.
- The bell rings on every drive that starts from rest, not only at the stop line.

## Short runs

- A tram is 32 m long, and many arterial runs are shorter than that and a junction. A tram waiting
  at such a light leaves its tail across the junction behind. That is harmless until the traffic
  across that junction gets its green, and then the traffic drives through the tail.
- Downtown a chain of such runs is often 7 to 19 lights long, so one wait before it cannot fit all
  their greens. `settle` chooses the wait at every light instead: it lays each wait out over the
  chain ahead, measures the time the tail stands in a junction on the green across it, and takes
  the steps back. `toLine` weighs running past a green against halting there the same way. Inside
  such a trial the tram only keeps to its own lights, so trials never nest.
- Most of what is left is forced by the offsets: where the light at the end of a short run turns
  green only after the green across the junction behind it starts, no timing helps.
  `scripts/tram-tail.ts` measures the tail's time in the junctions for a list of seeds.

## The track and the stops

- The loop is read from `TramDescription.edges`, which are graph ids: the graph is rebuilt from the
  roads on demand and the same roads give the same ids. A car is read at its two bogies on the
  track, `TRAM_TRACK` right of the centreline. On a run the tram drives, `laneOffset` moves the
  traffic lanes out of the middle `TRAM_HALF`, so no car drives through a tram.
- `tram-bodies.ts` stands each car in the physics box as a kinematic box, under `TrafficBodies`, so
  a ground without traffic has no tram. A touch does not take a tram off its loop.
  `TramLine.bells` is the hook the tram bells of spec section 15 ring: a tram pulling away from a
  halt on that tick.

## Where a stop stands

- The world names a stop by the junction nearest its district, and the tram used to halt on the
  run into it. Many of those runs are shorter than a tram, so the platform reached back into the
  junction behind, and the cars drove straight through it.
- `tram-stop-place.ts` finds each stop a stretch of the loop between two breaks that holds the
  whole platform: `PLATFORM_AHEAD` clear of the break ahead and `PLATFORM_BEHIND` of the one behind.
  A break is a node that is not two runs end to end, or a bend of more than `CORNER`, since a car
  cuts a corner. The same test catches the loop turning back on itself.
- The stretch must also be straight: `LoopLine.straight` rejects one that strays more than
  `STRAIGHT` off its chord. A front slides in steps of `SLIDE` to find straight track.
- The rules relax in `PASSES` until a stop is placed. Downtown the blocks are shorter than a tram,
  so a stop there walks to the nearest longer one. On a tie the stretch before the junction wins.
- Two platforms never overlap, and **no two stops share a run**: `tram-timing.ts` keeps one stop to
  a run and silently drops the other. The seed sweep checks both.

## The platform

- The platform stands on the side of the track away from the kerb, `platformInner` out from it
  and `platform` wide (`TRAM_LANE` in `world/roads/tiers.ts`). `PLATFORM_EDGE` is its outer edge.
- `tram-lanes.ts` holds the lane offsets. On every run a platform reaches, `tramLaneOf` moves the
  traffic lane out to `PLATFORM_EDGE + platformClear`, over the platform's length plus the swing and
  the smoothing either side. `kerbsOf` keeps a swerving car off it too.
- `platform-bodies.ts` gives the slab, the shelter, the mast and the bollards fixed colliders, so a
  car the player drives stops at a platform. It uses the transform `render/transit/tram-stops.ts`
  draws with: `+x` along the platform, the platform at `-z`, a yaw of `−heading`.
- The render adds a ramp at each end, a kerb on the traffic side, hatching on the road before the
  nose, and bollards, reflectors and a keep-left sign on the nose.
- Wide vehicles still clip a ramp end by centimetres on a corner. That is left; the colliders
  stand on the slab, not the ramps.

## The people at a stop

- `stop-crowd.ts` lays the people out. `layCrowd` picks a spot for each one from the stop's own
  random stream: a spread about the shelter that grows with each arrival, at least `APART` from
  anyone else. About a third stand in pairs that talk. Some look up the line for the tram.
- Each person has an idle gait — stand, phone, arms folded, smoke — and sways on a cycle of their
  own. An arrival walks in from the nearer ramp at `WALK`.
- When the doors open, each walks to the nearest door (`tram-doors.ts`, shared with the render)
  and queues there, one every `DOOR_TURN`. Everyone is aboard before the dwell ends.

## The turns a tram crosses

- `src/sim/transit/tram-guard.ts` holds the traffic on the tram's own green that crosses the tram's
  path (issue #301). The road across is held on red. Three movements share the tram's green: a
  vehicle from the other way that turns left, one beside the tram that turns off, and one beside a
  tram that turns right. The guard holds all three while the tram is in the junction.
- Every tram drives one timing, whole cycles behind the one before, so a tram is in a junction on
  the same ticks of the cycle on every lap. That span, `GUARD_BEFORE` ahead of the nose and
  `GUARD_AFTER` behind the tail, is a window. A turn the tram crosses is held for it on every cycle,
  whether or not a tram comes then. That keeps the traffic a function of the tick.
- `AmbientTraffic` times the loop a second time with `timeTram` to build the guard, since the tram
  line is built after the traffic. `timeTour` reads the guard at every light on the way: a vehicle
  pulls away on the first green tick that brings it to its line clear of every window. An anchor
  whose green sends a vehicle into a tram is taken only where every anchor would.
- A vehicle held by a tram stands on a green, so `test/support/signal-lap.ts` asks the guard before
  it calls a stop a fault. `test/sim/transit/tram-guard.test.ts` holds the ring free of vehicles
  that touch a tram within 30 m of a light.
- Where the tram stands with its tail in a junction (Short runs, above), a window can outlast the
  green, and no tick is clear. Such a turn is not held, and still meets the tram (#652). On seed
  `sunset` that is most of the tram's contacts with the traffic that are left. The guard adds about
  a sixth to the time the traffic takes to place.
