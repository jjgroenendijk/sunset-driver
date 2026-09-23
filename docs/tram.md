# The tram

The gotchas of the tram of spec section 13.2: the loop and how it keeps to the lights, the short
runs a tram does not fit, and the track. The code is `src/sim/tram.ts`, `tram-timing.ts` and
`tram-bodies.ts`. The traffic and the lights themselves are in `docs/city-life.md`.

## Contents

- The loop and its lights
- Short runs
- The track and the stops

## The loop and its lights

- `src/sim/tram.ts` is the tram of spec section 13.2, a function of the tick like the traffic.
  `tram-timing.ts` lays the loop down as the steps of a traffic tour: it halts short of every stop,
  light and level crossing, stands `DWELL` at a stop, and goes on at a light only with `TRAM_CLEAR`
  of its green left. So a level crossing is obeyed through the lights: the tram never crosses on the
  green of the road across it. The loop takes whole `SIGNAL_CYCLE`s, and each further tram runs it
  whole cycles behind, for the reason a traffic tour does.
- The pedestrians do not wait at a level crossing yet, as they wait at no light (#286). Once they
  keep to `crossingOpen`, they keep to the tram too, since it only crosses on their red.

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
