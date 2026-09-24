# Interchanges

The gotchas of the diamond interchanges of spec section 6.2: where an arterial reaches a highway,
the ramps that link the two, and how the graph, the traffic and the picture read a one-way road.
`docs/roads.md` has the rest of the network: the trace, the crossings and the highway plan.

## Contents

- The diamond
- The ramp line
- The landings
- Keeping off a ramp
- The slots of a stretch
- One-way roads in the graph and the sim
- Drawing a ramp

## The diamond

- An arterial never meets a highway at grade. `RoadNetwork.add` looks for an interchange of a laid
  highway on the arterial's line (`interchangesOn`). One goes to `addWithDiamond`. A line with two
  or more is cut halfway between each two, and each piece is added with its own diamond
  (`addPieces`). Refusing that line lost seed 1578463448 18 arterials and its tram. The ramps are
  laid in the same `add`, never afterwards (spec section 1.2).
- `add` returns one curve, but a diamond can lay an arterial in two halves, and `addPieces` in
  more. `takeLaid` gives every curve committed since the last call, and the fill seeds the next
  generation from all of them. Seeding from the returned curve alone left a half with no seeds.
- An arterial that ends on the interchange is cut back to a foot on the ground (`cutBack`,
  `HALF_FEET` along the arterial), and two ramps link the foot to the highway. That is half a
  diamond. The cut-away piece has to lie plainly on the ground and meet nothing. The segments on
  each side of a foot must be inside the arterial's grade (`footRuns`). A foot is a junction, so
  its plane is levelled, and a segment beside it that climbs too hard makes a step there.
- An arterial that runs through the interchange is carried over the highway (`overpassDiamond`).
  Its point on the interchange is taken out, so the arterial crosses the highway inside a segment.
  A line straight through the interchange crosses exactly on a highway point, which is no crossing
  inside either road, so the point is nudged along the highway instead (`nudgeOff`). The draft is
  settled with `overHighway`, the one case where the crossing plan raises a road over a highway.
  Each foot of the overpass, `FOOT_MARGIN` further out, takes two ramps: four in all.
- Where the whole diamond does not fit, the arterial is split at the interchange into two half
  diamonds. Over the first 12 sweep seeds that leaves 8 whole diamonds and 70 halves, 172 ramps.
- A road asked for `whole` is never split. Only an island link asks. A link that ends on a
  coastal interchange leaves it for its deck at once, and the few metres of shore hold no foot.
  There the link meets the highway at grade, the one arterial that does. The sweep allows it
  (`linkEnd` in `test/seed-roads.test.ts`); without it the island has no arterial.
- A ramp is a curve of its own tier, `ramp` (`tiers.ts`): one lane, no pavement, no pedestrians,
  no trams, and the arterial's `maxGrade`. `RoadCurve.ramp` names its highway and its arterial and
  says whether it is an exit. It is driven from its first point to its last.
- Traffic keeps to the right. The ramps on the right of the highway's own direction serve the
  carriageway that runs that way: the exit leaves before the interchange and the entry joins after.
  The ramps of the other side land on the same two places for the other carriageway.
- `interchangeInfields` (`diamonds.ts`) gives the ground each ramp encloses with the arterial and
  the highway. `parcels.ts` cuts it out before the blocks and keeps it as open ground, so no sliver
  of a lot is built between a ramp and the roads it links.

## The ramp line

- A ramp is a quadratic curve from the foot to its landing, cut into pieces of at most `PIECE`.
  Its control point stands on the line that meets the highway at the landing angle, halfway back.
  The ramp leaves the foot towards the control point and meets the highway along the line.
- The landing lies a share of the foot's distance from the highway further along (`SPREADS`), and
  the angle is tried at 40°, then 55°, then 70° (`LANDING_ANGLES`). The geometry forces the
  steep ones. The foot of an overpass stands about 120 m from the highway, since the arterial
  climbs a clearance at 8%. The highway is on the ground only `INTERCHANGE_CLEAR` (80 m) each side
  of the interchange. A ramp that leaves the arterial at `TRACE_MEET` or more and lands inside
  those 80 m cannot also meet the highway at 40°. Over 12 seeds the half diamonds land at 40° to
  60°, and the whole ones mostly at 60° to 80°.
- A wider clear zone does not help. At 120 m the highway loses decks it needs: seed 4007327102
  then has a highway segment on the ground steeper than the 6% of its tier. Only 3 whole diamonds
  are built instead of 8.
- A ramp is vetted like a trace: `canRun` and `stepOk` for every piece, no crossing on the way,
  and no part of it within reach of the arterial or another ramp of the same interchange except
  where the two share an end (`keepsOff`).

## The landings

- A landing stands on a segment with no deck, no bore and no lift. Both halves of the segment it
  cuts must be within the highway's grade. A short half can climb harder than the whole segment
  did: seed 4007327102 once had a 10 m half at 7%.
- A landing keeps `LANDING_GAP` along the highway from every other junction on it, and from the
  landings of the ramps planned with it. Those are not laid yet, so they are no points of the
  highway, and the gap once let two ramps land 15 m apart. A landing already made by a ramp is
  taken again. The second foot of a whole diamond tries the first foot's landings before any other.
- `layRamps` inserts each landing into the highway, then commits the ramp onto it.

## Keeping off a ramp

A ramp takes no junction on the way. Nothing may touch its line except at its two ends:

- `joinable` in `road-network.ts` is false on every ramp point, and `open` in
  `network-clearance.ts` makes every ramp segment uncrossable.
- `crossPoint` drops a crossing within `SAME_PLACE` of a segment end, on the grounds that the two
  points merge into one node there. A ramp point merges with nothing, so `stepOk` refuses a step
  that touches a ramp's line anywhere but at its ends. Seed 1329965443 once put an arterial point
  6 mm off a ramp's line, and the two crossed at grade with no node.
- The tracer forces a step when no step fits, and a forced step is not vetted. `RoadNetwork.add`
  therefore refuses a road that comes onto a ramp's carriageway away from its ends (`onRamp`). A
  road beside another road is caught as a crossing; one beside a ramp is not.

## The slots of a stretch

- A road that passes under a highway slot can never turn onto the highway. Spec section 6.2 allows
  it, and issue #676 (A4) chose how many: at most one road passes under the slots of each stretch
  of highway between two interchanges. The next road that reaches the stretch has to reach the
  highway at an interchange.
- `RoadNetwork.takeSlots` records the stretch a crossing takes when the road is committed.
  `slotTaken` answers `stepOk` while a road is traced and `crossing-plan.ts` while it is settled.
- `test/seed-interchanges.test.ts` holds the rule, and a bound of `SLOT_CROSSINGS_PER_KM` over the
  whole world. Over 12 seeds the slot crossings fall from 85 to 76 on 113.5 km of highway, and the
  worst world has 0.97 per km.

## One-way roads in the graph and the sim

- `graph.ts` gives a ramp one edge with `twin: -1`. `RoadNode.runs` lists every edge that starts
  or ends at a node, and `mouthAt` gives the run that leaves the node along a curve. Code that
  walked `edgesFrom` alone missed the ramp that only arrives, so junctions, aprons and corridors
  read `runs`.
- `turnAllowed(from, to)` keeps a car on its carriageway where a ramp lands: a turn between a ramp
  and the highway must go forwards (dot product above zero), and a turn from one ramp to another
  at a node on a highway is refused. `shortestPath` is a Dijkstra over edges rather than nodes, so
  the rule holds on every route: the minimap's, the police's and a tour's.
- A traffic tour that drives a one-way edge cannot drive back the way it came.
  `walkTour` closes such a tour with a route from its end back to its start. `choose` weights the
  next edge by `turnAllowed`.
- `signals.ts` reads each approach off `edgesInto`, so an exit ramp arriving at the foot takes its
  own phase. `laneOffset` puts a car on a ramp in the middle of its single lane.
- `map-route.ts` shortcuts along one run only where that run is two-way, or the mark lies ahead
  on it. A ramp is left only at its last point and joined only at its first.

## Drawing a ramp

- `road-section.ts` paints a ramp with two edge lines and one-way arrows every 30 m. A marking can
  stand off the centreline (`offset`) and taper along its length (`taper`), which is how an arrow
  head is drawn.
- The palette, the map width, the grade-crossing rank, the pier size and the pavement claim order
  all carry a ramp row. `FAR_TIERS` leaves ramps out of the far chunks, as it does streets.
- A ramp is drawn in the highway's batch (`batchOf` in `road-mesh.ts`), with its own section,
  markings and structures per run. A batch of its own put chunk -1,1 of seed 3925451995 over
  `CHUNK_DRAW_CALL_CAP` (49); in the highway's batch it costs 49.
- Look at a diamond with `node scripts/landuse-preview.ts <seed> out.png --x= --y= --half=220`.
  The infields read as open ground. A rendered frame needs the ground height in `--look-at`.
