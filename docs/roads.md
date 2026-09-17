# The road network

The gotchas of the road half of `src/world`: the field a road follows, what a trace refuses, and
how the tiers, the interchanges and the crossings are decided. `spec.md` section 6 is the design.
The ground the roads are laid on is in `docs/world-generation.md`.

## Contents

- The tensor field
- Tracing a road
- Highways and the ring
- The tiers and the fill
- Interchanges and crossings
- The graph, the footprint and the polygon arithmetic

## The tensor field

- `buildTensorField(world)` (`tensor.ts`) is the seeded field road direction follows (spec section
  6.1). Influences blend as tensors, so ones facing opposite ways reinforce instead of cancelling;
  `sample(x, y)` returns both directions and a `strength` saying how decided the field is, and
  `majorAt(x, y)` is the allocation-free hot path.
- Over the core and the inner ring the city's plan sets the weights of that field, and how firmly a
  city holds a plan is `field.plannedness`, drawn from the seed (spec section 6.1). Near 1 the grid
  outweighs everything, so avenues run straight and stop at the water. Near 0 the coast, the river
  and the rings around the middle decide. Both ends cut the wander to nothing: what the range is
  for is two kinds of coherent city, not a dial between order and noise. `planHolds(x, y)` says how
  much of that reaches a point, and outside it the streamline field of the suburbs returns
  unchanged. The three core districts share one grid direction, so no jitter breaks a long street
  into three; the suburbs and the outskirts keep theirs.

## Tracing a road

- `roads.ts` is the plan of the road network and `road-trace.ts` the trace it runs on: the step
  along the field, the ground that refuses it, the reroute and the structures. `RoadTracer` extends
  `RoadTrace`, which extends `RoadRoute` (`road-route.ts`): the state every trace runs on, the
  ground rules and the reroute over the terrain grid. `road-params.ts` holds the numbers each tier
  traces by, and `road-ground.ts` the rule a span asks the ground. The network laid so far is one
  planar graph, `RoadNetwork` (`road-network.ts`), and every road goes into it through `add`. A
  point that stands on a point of the network joins its node, or splits that edge into a new one,
  and both ends of a road are nodes. The result is `RoadCurve.nodes`, which `graph.ts` and the
  sweeps read. Nothing finds a node by comparing coordinates.
  The segments and their rules are `NetworkClearance` (`network-clearance.ts`), which the network
  extends.
- A test that builds curves by hand gives them `nodes: []` and passes the list through `withNodes`
  (`test/helpers.ts`). Without it every curve is an island of its own and no junction is found.
- No road lies over its own carriageway (`self-overlap.ts`): two places closer than the width,
  with more than `π / 2` times the width of curve between them. Every place of a segment is tried,
  so a point added on a straight stretch never changes the answer. `RoadNetwork.add` refuses such a
  road. The trace stops before a step that would fold, and `before` names the road a trace carries
  on from: the other half of a fill road, or the deck of a bridge. The reroute never turns more than
  a right angle in one grid cell, `straighten` keeps no node that folds, and `untangle` cuts a fold
  out of a proposed route where the straight cut may be driven. A bridge head whose approach folds
  under the deck gives way to the next pair of heads.
- A road's width has to enter the trace, not only the carve: a trace that sees points alone runs
  along another road's carriageway or stops inside it, and nothing downstream can repair that.
  `NetworkClearance` (`network-clearance.ts`) holds three rules. A step near another road crosses it
  or leaves it at `MIN_MEET` (30°) or more, keeps a footprint's reach from the end of any road, and
  does not cross two roads, or one road twice, within a junction's reach. A merge leaves every road
  at the shared point at `MIN_MEET` or more, and not beside a crossing the trace has just made. A
  road ends only where its footprint stands on no other road's. A trace that stops for any other
  reason is walked back to its last clear point, and `trimTo` cuts a cul-de-sac on a clear point
  too. A step that fails is first turned by up to three of the tier's turns, so a road coming in too
  shallow meets the road at an angle instead of stopping. A merge tries the four nearest points
  before it gives up. The tracer asks 5° more than `MIN_MEET`, because a junction snap bends a road
  as it is added. The reroute, the bridge anchors and the boardwalk line are vetted by the same
  rules; a reroute that fails is searched again with every grid step vetted, since the grid meets a
  road at only eight headings. Each resort's boardwalk line is reserved right after the highways and
  released once it is laid; without that an island link can take the line, and the beach gets no
  boardwalk. While its two ends reach for the network the line is held again, so neither end runs
  back along it.

## Highways and the ring

- The highways are a ring just outside the core and up to `MAX_RADIALS` radials out of its free
  interchanges, the longest first, each with a branch (`highways.ts`). The seed picks the ring's
  shape: a circle, or a square with rounded corners whose sides follow the field at the core. Where
  that shape does not fit, the other is tried. A ring broken by water keeps its longest arc. Only
  where no arc runs `MIN_HIGHWAY` do the two old trunks cross the core, and where both of those come
  up short the longer is laid whatever its length. Without that a seed has no highway, and then no
  road at all.
- A ring trace (`TraceOptions.around`) aims along the ring's tangent and turns back towards it by up
  to `RING_TURN`, so the ground can still bend it. It stops once it has swept the whole ring, or the
  part the other half left.
- The islands are linked twice: once after the highways, and once after the arterial fill, for an
  island that carries a district and still has no road on it. A bridge is refused where its near
  shore reaches no road. Both bridge heads are vetted by `stepOk`, so a link never crosses a
  highway away from a slot. `bridgeHeads` tries several anchors on each shore, then points of the
  network near the shore, because a shore highway often takes the first anchor.
- `linkIsland` runs over the two shores twice. The first round gives a shore up as soon as its best
  pair of heads reaches no road, since the other shore is usually the one that can. Where neither
  shore has a way on at its best pair, the second round routes every head of both. An island that
  carries a district has to have a road, so the cheap round is an ordering and never the end of the
  search.

## The tiers and the fill

- `traceRoads(world, field)` (`roads.ts`) traces every tier as streamlines of that field: highways,
  then arterials, then the minor fill of streets, alleys and dirt roads. Three invariants hold by
  construction, and the sweep checks them: every curve shares a point with another curve, so the
  network is one component; no segment stands over water unless its index is in the curve's
  `bridges` and it spans a crossing of the water description; and no segment on the ground climbs
  harder than `TIERS[tier].maxGrade`. A curve that reaches neither the network nor its target is
  dropped, never left dangling.
- A step too steep for its tier is refused, so the trace turns along the contour. Where no turn is
  left, the road holds its line and spans several steps at once, and the ground it may not climb is
  bored through or carried over. `bridges` and `tunnels` hold the indices of the segments that stand
  off the ground: the ground under a bridge falls more than `FILL` below the road, and the ground
  over a tunnel stands more than `CUT` above it.
- The minor fill takes its tier and its block size from the ground under each seed: `MINOR_BY_ZONE`
  gives the zone's spacing range, and the density of the district there says where in that range the
  spacing lands. A road that met nothing on one side is trimmed to a cul-de-sac rather than left
  running into nothing.
- Both fills have two spacings, so their blocks are long strips and not lozenges (spec section
  6.1). A fill reads `field.majorAt` at the seed to know which of the two a road is being laid at:
  `across` for a road running across the major direction, `along` for one running with it. Two
  things follow that are easy to get wrong. A road's clearance — the ground it needs free to be laid
  at all — is half the *tighter* of the two, never half its own spacing, because an avenue crosses a
  street every 90 m and would otherwise refuse itself. And `MINOR_BY_ZONE.along` in the city is set
  far wider than a block, because the arterial fill has already laid an avenue every
  `ARTERIAL_SPACING`; what bounds a downtown block the long way is the arterial, which is why the
  alley reads that figure rather than the table's. `MINOR_BY_ZONE` and the seed and plan types live
  in `fill.ts`, which is the vocabulary both fills are written in.
- In the city the arterials are the avenue family and the streets are the cross streets between
  them. The arterial fill lays its avenues — the arterials running with the major direction — every
  `ARTERIAL_SPACING`, and the arterials that cross them `ARTERIAL_CROSS_BY_ZONE` times wider, which
  in the core and the inner ring is four. A real city ties two avenues together with a street and
  not with another arterial, and one spacing both ways laid a mesh of 230 m arterial squares over
  downtown, where an arterial is 26 m wide with its verge and its pavement. Outside the city the
  multiple is one: the suburbs have no avenue grid, and out there an arterial is the road that
  reaches the next district.
- An alley is one service lane inside one block (`alleys.ts`), never a fill generation of its own.
  `alleySeeds` walks each street and measures the ground to each side out to the next road; that
  distance is the block's depth, and the lane goes down the middle of it. So the lane stands between
  the two streets that are really there, not at a spacing read off the table. A block takes no lane
  where nothing stands within `PROBE_REACH` of the street, which is open ground and not a block, and
  none where the strip each side would come out shallower than the zone's own lot depth or smaller
  than its `minBuilt`. Downtown that asks for about sixty metres of block. The candidates are sorted
  shallowest block first, so the lane runs down the block's long axis; every later candidate in the
  same block is then refused by the clearance of the lane already laid. Laying alleys as a second
  streamline fill is what once gave downtown a road every 40 m and left every block in strips.

## Interchanges and crossings

- A highway takes a junction only at an interchange (spec section 6.2). `interchangesOf` places them
  along the curve, `RoadCurve.interchanges` lists the point indices, and `mayJoin` (`tiers.ts`) is
  the rule: a highway or an arterial ramp joins one there, and a street, alley or dirt road never
  joins a highway anywhere.
- Each highway's structure is planned when it is laid (`highway-plan.ts`, called from `addCurve`).
  Between two interchanges it leaves the ground, clear of `INTERCHANGE_CLEAR` each side. In the
  built-up zones it runs on a deck from one to the next; in the country it rises on one
  `COUNTRY_DECK` in the middle of the stretch. The level segments of a deck are its `slots`. A
  highway that passes under an earlier one stays on the ground there. `NetworkClearance` refuses
  every step of a later road that crosses a highway away from a slot, so every highway crossing is
  at a slot or an interchange by construction.
- Those step rules hold for a road on the ground. A deck or a bore is not on the ground, so the
  crossing plan asks it for a clearance and nothing else, and it may cross a highway anywhere. An
  island link is checked twice for that reason: `bridgeHeads` checks the span the bridge is planned
  as, and `structuresAtSlots` checks every segment `markStructures` turned into a deck or a bore,
  which is how a link whose approach ends up elevated is kept off a highway away from its slots.
- `RoadNetwork.add` decides every crossing of a road as it adds it (`crossing-plan.ts`, spec
  section 6.2); nothing decides one afterwards. Where the two roads are on the ground and `mayJoin`
  allows it, the crossing is a junction: both take a point there, and a laid road takes its point
  through `insertPoint`, which moves every index the curve holds. The place is the nearest point
  either road has within `CROSSING_SNAP`, else the crossing itself. `crossing-rules.ts` refuses a
  place a road standing on it may not be joined at, a half of a segment the ground refuses
  (`groundRule`), a bend that folds a road, buries a free end or crosses a road it did not cross
  before, and two roads leaving a place under `MIN_MEET`. Otherwise a crossing is apart where one
  road stands a `CLEARANCE` lift over the other on the ground, a highway slot or the top of a raise,
  or where a deck or a bore puts the two beds that far apart. The foot of a ramp is snapped to the
  ground within half a millimetre: the distances along a line are single precision, so without it a
  point at the foot takes a lift of a micrometre, and a road a micrometre up is not on the ground by
  any rule that reads the lift. Otherwise the new road is raised over the other (`overpass.ts` is
  the lift profile): the reach may hold no junction, no deck or bore of
  its own and no place it passes under a road, and the road has to land again. A highway is never
  raised and never raised over. A crossing none of these decide shortens the road back to the
  longest piece that still meets the network, cut where it may end; with no such piece the road is
  refused. Nothing is written to a laid road until the whole plan holds. A raised point takes no
  junction later, and the ramp of a raise is crossed nowhere.

## The graph, the footprint and the polygon arithmetic

- `buildRoadGraph(roads)` (`graph.ts`) is the queryable road graph of spec section 6.5. It is built
  on demand from the curves' `nodes`, which the tracer stored. Two curves meet only where they carry
  the same node, so two roads that only cross on the map stay grade separated. `graph.crossings`
  lists those crossings and says which road is carried over the other; both runs of both roads carry
  the index. `shortestPath(from, to, allow?)` narrows the network to the edges `allow` accepts,
  which is how the tram is routed over the arterials alone. `tiers.ts` holds the width, verge,
  pavement, lanes, speed limit, permitted traffic and maximum grade of each tier; nothing else
  should carry those numbers.
- `buildFootprint(roads, corridors, graph)` (`footprint.ts`) is the ground the roads claim (spec
  section 6.4). It is built on demand like the graph, not stored in the world description. Each
  curve is offset by `footprintHalfWidth(tier)`, an apron is laid where three roads or more meet,
  and the tram's lane joins them. Only the runs a road stands on are claimed: the ground under a
  deck is an under-structure parcel, or is not land at all. The holes of the union are
  the city blocks, and subtracting it from the land gives the parcels.
- `src/core/geom.ts` is the door onto the polygon arithmetic: `ring.ts` holds the shapes, `edges.ts`
  the edge soup and its spatial index, and `planar.ts` the graph the operations are read off. It is
  the polygon arithmetic the parcel model runs on: `strip`, `disc`, `union`, `difference`, `split`,
  `ringArea`, `pointInRing`. A `Region` is an outer ring wound anticlockwise with its holes wound
  clockwise. They round every coordinate to the millimetre, so the cross products that say which
  side of an edge a point falls on are exact integers and can never contradict one another. Over a
  whole network they cost about a third of a world generation, so a caller keeps the answer instead
  of asking twice. `split` gives both sides of a cut off one pass, so the two sides are bounded by
  the same edges. The engine's spatial index files an edge in the buckets it really crosses, column
  by column, rather than in every bucket of the box around it. So a clip polygon that reaches across
  the map costs what the ground it cuts is worth, and a caller needs no short steps along its sides.
