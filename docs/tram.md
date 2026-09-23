# The tram

The gotchas of the tram of spec section 13.2: the loop and how it keeps to the lights, the short
runs a tram does not fit, the track, and the traffic that waits while a tram crosses its turn. The
code is `src/sim/tram.ts`, `tram-timing.ts`, `tram-bodies.ts` and `tram-guard.ts`. The traffic and
the lights themselves are in `docs/city-life.md`.

## Contents

- The loop and its lights
- Short runs
- The track and the stops
- The turns a tram crosses

## The loop and its lights

- `src/sim/tram.ts` is the tram of spec section 13.2, a function of the tick like the traffic.
  `tram-timing.ts` lays the loop down as the steps of a traffic tour: it halts short of every stop,
  light and level crossing, stands `DWELL` at a stop, and goes on at a light only with `TRAM_CLEAR`
  of its green left. So a level crossing is obeyed through the lights: the tram never crosses on the
  green of the road across it. The loop takes whole `SIGNAL_CYCLE`s, and each further tram runs it
  whole cycles behind, for the reason a traffic tour does.
- The pedestrians wait at the lights (`docs/crowd.md`), so they keep to the tram too: it only
  crosses on their red.

## Short runs

- A tram is 32 m long, and many arterial runs are shorter than that and a junction. A tram waiting
  at such a light leaves its tail across the junction behind. `hold` waits at the light before
  instead, for a start that meets the short lights ahead on green. One wait seldom fits more than
  two of them, so on seed 1 about a third of the tram's waits are still on a short run.

## The track and the stops

- The loop is read from `TramDescription.edges`, which are graph ids: the graph is rebuilt from the
  roads on demand and the same roads give the same ids. A car is read at its two bogies on the
  track, `TRAM_TRACK` right of the centreline. On a run the tram drives, `laneOffset` moves the
  traffic lanes out of the middle `TRAM_HALF`, so no car drives through a tram.
- `tram-bodies.ts` stands each car in the physics box as a kinematic box, under `TrafficBodies`, so
  a ground without traffic has no tram. A touch does not take a tram off its loop. The people at a
  stop are a count of the ticks since the last tram left, and fall to none while one boards them;
  `PedestrianView` draws them standing. `TramLine.bells` is the hook the tram bells of spec section
  15 will ring: a tram pulling away from a halt on that tick.

## The turns a tram crosses

- `src/sim/tram-guard.ts` holds the traffic on the tram's own green that crosses the tram's path
  (issue #301). The road across is held on red. Three movements share the tram's green: a vehicle
  from the other way that turns left, one beside the tram that turns off, and one beside a tram
  that turns right. The guard holds all three while the tram is in the junction.
- Every tram drives one timing, whole cycles behind the one before, so a tram is in a junction on
  the same ticks of the cycle on every lap. That span, `GUARD_BEFORE` ahead of the nose and
  `GUARD_AFTER` behind the tail, is a window. A turn the tram crosses is held for it on every cycle,
  whether or not a tram comes then. That keeps the traffic a function of the tick.
- `AmbientTraffic` times the loop a second time with `timeTram` to build the guard, since the tram
  line is built after the traffic. `timeTour` reads the guard at every light on the way: a vehicle
  pulls away on the first green tick that brings it to its line clear of every window. An anchor
  whose green sends a vehicle into a tram is taken only where every anchor would.
- A vehicle held by a tram stands on a green, so `test/signal-lap.ts` asks the guard before it
  calls a stop a fault. `test/tram-guard.test.ts` holds the ring free of vehicles that touch a tram
  within 30 m of a light.
- Where the tram stands with its tail in a junction (Short runs, above), a window can outlast the
  green, and no tick is clear. Such a turn is not held, and still meets the tram (#652). On seed
  `sunset` that is most of the tram's contacts with the traffic that are left. The guard adds about
  a sixth to the time the traffic takes to place.
