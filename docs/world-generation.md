# World generation

The gotchas of `src/world`: what a generator refuses, what is built on demand, and what is already
in the world description. `spec.md` sections 6, 7, 9 and 10 are the design; this is what a session
gets wrong without it.


- `generateWorld(seed)` builds the whole-map skeleton; chunk-level content will hang off it. The
  land is a power diagram of island sites shrunk by half a channel and domain-warped, so straits
  bend but never close. The main site is the core at the origin.
- Every number of that layout comes from the seed's `TerrainArchetype` (`archetype.ts`, spec
  section 7.2), and the six tables are in `archetypes.ts`. `layoutTerrain` reads it and passes it on
  to `sites.ts`, which places the sites by the archetype's pattern, and to `rivers.ts`, which plans
  the rivers and the harbour. `coastNoise(seed)` returns a `CoastNoise` that carries the coast
  profile, so a caller of `islandAt` gets the right warp without knowing archetypes exist. The draw
  uses stream 3 of `Subsystem.Water`; streams 1 and 2 are the layout's and the render's. Never
  reorder `ARCHETYPES`: the draw picks by index.
- An island can be several cells (`Island.cells`), and the layout's `seas` are cells of open water.
  No channel runs between two cells of one island, so a landmass need not be convex. The layout
  draws from stream 1 in the order sites, channel, rivers; the archipelago kept its old order.
- A river that runs close to a shore above its mouth cuts the land in two, and no road crosses a
  river, so `rivers.ts` drops it. A harbour at the river mouth needs its river and keeps the first
  try. A harbour on the waterfront already cuts the highway ring, so its rivers keep `RING_CLEAR`
  off the core: a river across the ring as well leaves no arc long enough to lay.
- `findCrossings` (`crossings.ts`) searches between the nearest pairs of cells of two islands. A
  chord that lands on ground an arterial can climb to from the core ranks above one that lands in a
  pocket closed off by steep slopes, up to `GRADED_SPAN`. No arterial reaches a bridge head in such
  a pocket, so the roads never build that bridge.
- `water.industry` is the direction of the industrial wedge. It points at the harbour, and turns
  along the shore until the wedge is mostly dry, gentle land. A wedge in the sea puts the industrial
  districts on the core, since `sampleSiteInZone` falls back there.
- three.js `TerrainGenerator` needs `valleyBias: 1`; fractional values produce NaN.
- `new LandMasses(hf, water, minHeight)` (`landmass.ts`) labels the connected pieces of dry land and
  says which of them a road can arrive at: the piece the main island stands on, and every piece a
  chain of the water description's crossings leads to from there. A cell of the power diagram can
  hold a rock in the sea, and it can hold several pieces of land that no crossing joins, so anything
  that places ground content asks `reaches` first. District sites and beaches do.
- Ask `islandAt(islands, size, coastNoise(seed), x, y)` which island a point stands on.
  `islandIndexAt` reads the raw power cells, and the coastline is cut from those cells after a
  domain warp that moves them by up to 6 % of the map.
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
- A zone has two spacings, so its blocks are long strips and not lozenges (spec section 6.1). The
  fill reads `field.majorAt` at the seed to know which of the two a road is being laid at: `across`
  for a road running across the major direction, `along` for one running with it. Two things follow
  that are easy to get wrong. A road's clearance — the ground it needs free to be laid at all — is
  half the *tighter* of the two, never half its own spacing, because an avenue crosses a street
  every 90 m and would otherwise refuse itself. And `MINOR_BY_ZONE.along` in the city is set far
  wider than a block, because the arterial fill has already laid a road every `ARTERIAL_SPACING`;
  what bounds a downtown block the long way is the arterial, which is why the alley reads that
  figure rather than the table's. `MINOR_BY_ZONE` and the seed and plan types live in `fill.ts`,
  which is the vocabulary both fills are written in.
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
- `RoadNetwork.add` decides every crossing of a road as it adds it (`crossing-plan.ts`, spec
  section 6.2); nothing decides one afterwards. Where the two roads are on the ground and `mayJoin`
  allows it, the crossing is a junction: both take a point there, and a laid road takes its point
  through `insertPoint`, which moves every index the curve holds. The place is the nearest point
  either road has within `CROSSING_SNAP`, else the crossing itself. `crossing-rules.ts` refuses a
  place a road standing on it may not be joined at, a half of a segment the ground refuses
  (`groundRule`), a bend that folds a road, buries a free end or crosses a road it did not cross
  before, and two roads leaving a place under `MIN_MEET`. Otherwise a crossing is apart where one
  road stands a `CLEARANCE` lift over the other on the ground, a highway slot or the top of a raise,
  or where a deck or a bore puts the two beds that far apart. Otherwise the new road is raised over
  the other (`overpass.ts` is the lift profile): the reach may hold no junction, no deck or bore of
  its own and no place it passes under a road, and the road has to land again. A highway is never
  raised and never raised over. A crossing none of these decide shortens the road back to the
  longest piece that still meets the network, cut where it may end; with no such piece the road is
  refused. Nothing is written to a laid road until the whole plan holds. A raised point takes no
  junction later, and the ramp of a raise is crossed nowhere.
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
  and the corridor strips join them. Only the runs a road stands on are claimed: the ground under a
  deck belongs to that road's elevated corridor, or is not land at all. The holes of the union are
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
- `landRegions(hf, seaLevel)` (`land.ts`) traces the coastline off the heightfield as regions wound
  with the land on their left. Everything else about the land is a grid; the parcel subtraction is
  the one thing that needs it as a polygon.
- `planBeaches` (`beaches.ts`) is spec section 7.3. It runs before `traceRoads`, because a boardwalk
  is a road, so `world.beaches` is in the skeleton the tracer reads. A beach is a run of coastline
  the ground behind rises slowly from; the harbour, the river mouth and the rock in the sea that no
  crossing reaches and the ends of the crossings are cut out first. `isResort` says which beaches
  carry a boardwalk line, a pier and car parks: the long ones, plus two more outside the core
  whatever their length, which is what gives every seed the beach the spec asks for. Those two rank
  a beach of `LONG_BEACH` first, then one that runs past a district The Boardwalk can be named for.
  The dune line is offset off a coastline that marching squares draws in cell steps, so the normal
  is taken across several samples and capped short of the centre of a bend; both keep it from
  folding over itself.
- `nameBoardwalk` and `withBeachCulture` (`beaches.ts`) finish the districts once the beaches are
  known. The districts are placed first, because a beach reads their sites, so the beach
  neighbourhood can only be found afterwards. `nameBoardwalk` gives the name "The Boardwalk" to the
  district holding most of the waterline of the longest resort outside the core; a district with a
  fixed name of its own, such as Gull Island, keeps it and the beach takes another district.
  `withBeachCulture` then gives that beach's districts the beach culture.
- The beach owns no ground of its own: `beach.sand` is the sand the terrain draws, and the ground is
  claimed once, as the parcels `buildParcels` cuts out of it. The minor fill and the arterial fill
  keep off a resort's sand, so the boardwalk is what reaches it; every other beach is left to
  whatever road runs behind it, because sand no road reaches is not a parcel at all. A highway or an
  island link may still cross a beach, and a seafront road is not a fault.
- `traceRoads` returns the roads and the boardwalk each beach was given. A boardwalk is the one road
  not traced from the field: the line comes from the beach, the ground decides how much of it
  survives, and each end reaches on to the network.
- `buildParcels(world, footprint, graph, field)` (`parcels.ts`) is the parcel model of spec section
  6.4. It is built on demand like the graph and the footprint, not stored in the world description.
  A parcel is a piece of the land the footprint leaves, and every one of them has a road running
  along it: ground no road reaches is dropped, because nothing can be driven to it. Only a block the
  roads enclose is cut down to the size its zone builds in, so open country past the last road stays
  one piece rather than becoming strips no road touches. A cut runs across the block's long side,
  which `cutLine` finds by measuring the block along the field's two directions: cutting the other
  way gives two strips too thin to build on. The core and the inner ring keep a `maxArea` above the
  block their own street spacing makes, so a block the size of a real one is never cut at all. An
  owner comes in a size:
  `ownerMaxArea(zone, owner)` is the most a park, a car park, a plaza or a building group may hold
  there, and a parcel the roll gives to an owner too small for it stays ground cover. The core and
  the inner ring roll no open car park at all: they park in a `parking-garage`, which is a building
  kind. An open car park there is a beach car park. `ParcelMap.stations` are the police stations of
  spec section 11.7: in each district, the building parcel whose centre stands nearest the site. A
  station keeps the `building` owner. The chunk worker sends them to the main thread on its first
  `ready` reply, because the main thread never builds the parcels.
- `buildParkingBays` (`parking.ts`) lays out the bays of spec section 13.1, and the worker sends
  them on the same reply. A street bay is a length of the `TierSpec.parking` strip inside each kerb,
  and `laneOffset` shares only what is left between the lanes. A bay is refused where it would
  reach the ground another road claims, its own street's lanes, or its neighbour on a bend. A car
  park is laid in rows `STREET_REACH` inside its edge, because that rim is where its trees stand.
  Its bays keep off the ground every road claims as well: a deck whose elevated corridor another
  corridor cut short leaves the ground under its ramp to a parcel.
- `buildBuildings(world, parcels, graph)` (`buildings.ts`) places the buildings of spec section
  10.3. It is built on demand like the parcels, not stored in the world description.
  `ZONE_BUILDINGS` says what a zone builds at all — a suburban parcel has no tower on its list —
  and `MIN_LOT_AREA` what each kind needs, so a lot too small for the kind it rolled takes the next
  smaller kind the zone allows. `lots.ts` cuts the ground it stands on and `lot-geom.ts` is the
  arithmetic of that cut.
  `skylineAt` (`districts.ts`) is a smooth field that falls from 1 at the core to 0 at the outer
  edge of the inner ring. Each building carries it as `Building.skyline`. It gathers the towers
  towards the middle, and the renderer reads it for height, so the skyline has no edge at a ring.
- `lotsOf(parcel, graph)` (`lots.ts`) cuts a parcel into lots along its frontage: the run of its
  boundary that stands on the ground a road claims. Four rules decide the shape of a block, and the
  first three are what stop a street being a row of boxes with daylight between them.
  - A lot reaches half way across the block where the boundary opposite it fronts a road of its
    own, so two rows back to back each get half of it. A block too narrow for two rows of the
    zone's least depth is not shared, because one deep row is worth more there than two the zone
    would drop.
  - `LotSpec.attached` says the zone builds a street wall: the core and the inner ring keep no gap
    between one lot and the next, and the side edge between two of them is the bisector of the two
    frontages, so a wall along a bend has neither a wedge nor an overlap in it. A lot is therefore
    a quadrilateral and not always a rectangle, and `Building.width` is the widest building that
    stands inside it rather than the length of its frontage.
  - Where two runs of one parcel meet at a corner, the run laid first takes the corner and the
    second starts behind the building on it. Neither street then has a notch at the corner.
  - A lot is shortened until it stands wholly inside the parcel and clear of the lots already laid,
    and dropped only where even its zone's least depth overhangs. Nothing is laid and then pushed
    off its neighbour (spec section 1.2). Two lots of an attached zone touch along the wall between
    them and two of any other zone keep `LOT_CLEARANCE`, so the sweep asks an attached zone for no
    shared ground and every other one for daylight.
  - `Lot.shared` says which of a lot's two side edges another lot of the row lies against, and a
    lot the row dropped leaves its neighbour's edge bare. The renderer reads it to know where it
    may reach the edge and where it has to keep a margin; see `docs/rendering.md`.
- `buildCorridors(world, roads, graph)` (`corridors.ts`) lays the corridors of spec section 6.3 and
  the tram route of spec section 13.2. It is the last step of `generateWorld`, and the only place
  that builds the graph during generation. A corridor claims its ground at the moment it is laid: a
  strip is claimed segment by segment, ground within `CLAIM_CLEARANCE` of a claimed strip is not
  free, and a run that meets claimed ground is cut and continues past it. Two corridors therefore
  cannot overlap, and the sweep only confirms it. The tram claims first, so a deck over its lane
  gives way. A line that turns more than `MAX_BEND` is cut at the turn, because a strip carried
  round a corner that sharp folds over itself.
- A corridor claims no ground where its centreline stands over water, whatever its kind: there is
  nothing under it to claim. The tram is what needs that rule, since its lane runs down the middle
  of an arterial and an arterial crosses a strait on a deck.
- An elevated corridor is the ground under a deck that stands over land, with the pillar feet that
  carry it; a deck over water owns nothing, for the same reason. A tram corridor is
  the reserved lane, down the middle of an arterial from one stop to the next. `world.tram` holds
  the line the tram drives, its stops, and the level crossings where another road meets it.
- `buildJunctions(roads, graph)` (`junctions.ts`) is where roads meet (spec section 6.2). Every node
  with two or more roads on the ground is a junction unless the two carry straight on into each
  other. Each road is a mouth, cut back along its curve to where its kerbs leave its neighbours'
  kerbs plus the fillet that rounds the corner; `MAX_CUT` caps it, and a mouth that bends inside its
  cut is cut where it leaves the straight line, because the corners are found on straight kerb
  lines. Two mouths at a shallow angle get a short cut and overlap beyond it. `gaps` lists per curve
  the stretches the junctions take, as curve distances with the exact cut points, so a chunk that
  holds a road but not its junction cuts the road where the junction expects. A chunk carries the
  junctions whose node stands in it and every run carries its curve's gaps.
- `new RoadBeds(terrain, roads, junctions)` (`bed.ts`) is the one definition of the line a road
  drives. Away from a junction the bed is the natural ground under the curve's points, straight
  between them. A junction is one plane: through the node at ground height, tilted by a
  least-squares fit of the grades its mouths leave at, solved along the axes the mouths span so a
  shallow pair cannot tilt it across them and never steeper than the steepest mouth. Every mouth
  follows the plane to its cut and blends back onto its own line over one cut more, ending on the
  next point of its curve: a loft has a section at every point and none between, so a knot inside a
  segment stands off the surface drawn over it. The beds and the planes are the one surface height
  function of spec section 6.1. A bed knot carries a tilt as well as a height, so a road's section
  tilts across the road as the plane does inside a mouth and levels out over the blend
  (`surfaceHeight`). The loft, the junction rings and the carve all read it, so the ground and the
  road agree by construction.
- `junctionShape(junction, ribbons)` (`junction-shape.ts`) gives the ring a junction's carriageway
  is drawn on, fanned from the node. A junction holds no pavement. Every vertex carries its height
  from the one surface: a mouth's banked section, and the plane everywhere else. `junction-mesh.ts`
  draws it and the carve levels the ground under it. The carve levels the `outline` and the fan
  (`JunctionCover`), not the outline alone. A mouth is drawn on its curve but the outline is cut on
  a straight line, and a fan from the node reaches past a ring that is not convex.
- `ChunkSource` cuts the pavement and the verges of each chunk (`pavement.ts`, spec section 6.4) as
  the inset of each block: the ground the roads claim, without the corridors, less the carriageway
  as the lofts and the fans draw it. One pass takes the carriageway and the ground outside the chunk
  away, and each tier then takes what it claims, the widest first. So no pavement lies on a
  carriageway, no ring of it crosses itself, and a corner with no room has none. The carriageway
  holds every segment a junction takes, because the fan of two mouths at a shallow angle leaves
  some of a road's own carriageway out; that ground is left bare. Each claimed stretch ends on the
  loft's frame, or a sliver of verge lies on the deck it runs onto.
- `buildCarve(terrain, roads, junctions)` (`carve.ts`) is the terrain the roads leave (spec section
  7.1). It is built on demand like the graph, the footprint and the parcels: `world.terrain` stays
  the natural ground the roads were traced on, and the carved ground is what a chunk carries and
  what the renderer and the physics read. `heightAt(x, y)` answers one place at a time from the
  roads alone, so two chunks agree along the edge they share without being cut together. The bench
  each side of a bed is `benchHalfWidth(tier)`: the ground the tier claims, or one
  `CHUNK_TERRAIN_CELL` where that is narrower, and `BENCH_MARGIN` — one cell diagonal — past either.
  That margin is what keeps the hillside out of the road: a grid cell holding the edge of a road has
  corners each side of it, and a corner off the bench stands higher than the road on an uphill side,
  so the triangle between them cuts up through the verge. On the bench the ground is the road's
  surface whatever the hillside asks; only past it do `CARVE_CUT` and `CARVE_FILL` hold, and the cut
  and fill blend back into the hillside over `CARVE_BLEND`. Where a road leaves the ground — the end
  of its curve, a deck or a bore — the bench carries on at the road's grade: a level disc past a
  steep end is a kink the grid lifts through the last section. Ground a road claims — the bench it
  draws its surface on — belongs to it before ground it merely reaches, and where two roads claim
  one place the ground takes the lower of the beds they ask for, so the other road stands over the
  ground rather than buried under it, and two junctions claiming one place take the lower plane;
  `crowdedAt(x, y)` is how the sweeps ask whether a place is one of those. A place inside a
  junction's outline is the junction's whatever else reaches it, but the scan carries on past it all
  the same, because a street crossing under a junction of a wider road is one of those crowded
  places and only asking every claimant sees it. A segment on a deck or in a bore carves nothing at
  all. `surfaceAt(x, y, tier)` is the surface drawn at a place rather than the ground: a junction's
  plane, or the bed of the nearest road of the tier. The pavement stands on it, because on the
  ground it would sink to the lowest bed that claims the place.
- A chunk samples the carve every `CHUNK_TERRAIN_CELL` (2.5 m), four samples to a cell of the
  skeleton's `TERRAIN_CELL` grid, because the camera looks down at an 11 m street and the hillside
  between two 10 m samples cuts up through it. The far ring reads every fourth sample and lands back
  on the skeleton's grid. The carve still cannot hold two beds in one cell, so where two roads run
  within a bench of each other at different heights — a street beside a highway embankment, two
  hairpins on a cliff — the ground takes the lower bed and the higher road stands off it. The sweep
  pins how far and how often (`CARVE_CLEARANCE`, `CARVE_STAND_OFF`) on the chunk grid; both are a
  property of the grid, not a threshold to relax. The hard bound and the levelness check both leave
  out the ground `crowdedAt` reports, because that ground is carved to a bed that is not the road's
  own.
- `new RoadRibbons(world.terrain, world.roads, junctions)` (`ribbon.ts`) is the frame anything swept
  along a road needs: the bed height at a place on a curve, its `bank` across the road, which way is
  across the road there, and how far along the curve it is. A place `off` metres across stands at
  `height + bank * off`; anything placed beside a road reads both. The bed is the line `carve.ts`
  cuts its bench to. A point two segments meet at takes a mitred frame only where the mitre moves
  its outer corner less than `MITRE_SHIFT`; a sharper turn answers with the frame of the segment
  asked about, so the two sides differ and the caller cuts its geometry there rather than folding it
  over. `road-mesh.ts` then bevels the joint: without it the outside of the turn is a wedge of
  ground showing through the road, and half of every arterial bend asks for one. The rule reads the
  curve and never the chunk, which is what keeps two chunks in step.
- `new Vegetation(seed, parcels, buildings)` (`vegetation.ts`) scatters the plants of spec section
  10.4, and `plantsIn(bounds, ground)` answers one window on the map at a time. The grid is anchored
  on the origin and a cell carries at most one plant, so what grows somewhere is a function of the
  place, and two chunks agree along the edge they share. `ground` is the parcel pieces the chunk
  already holds: asking `ParcelIndex` (`parcels.ts`) instead walks a whole coastline for every cell
  and costs about four times as much. Two canopies never overlap by construction — a cell is
  `PLANT_CELL` across, a plant stands within `PLANT_JITTER` of its middle, and no canopy is wider
  than `MAX_PLANT_RADIUS`, which is half of what that leaves. A plant is kept only where its whole
  canopy stands inside the parcel and clear of every lot on it, so nothing reaches over a road or a
  building. `mixFor(owner, zone)` says what a parcel plants: a wood in a park, scrub on open ground,
  dune grass and palms on a beach, and a row along the pavement where the ground behind the frontage
  is built on.
- `new ChunkSource(world).chunk(cx, cy)` (`chunks.ts`) is the chunked generation of spec section
  9.1. A chunk is a window on the whole-map layers — the graph, the footprint, the parcels, the
  buildings and the carve — so a source pays for those layers once and every chunk after that is a
  clip. `generateChunk(seed, cx, cy)` generates a whole world for one chunk; use it for one chunk
  and no more. The grid is anchored on the origin, and a chunk owns its near edges but not its far
  ones, so a road laid along a boundary is cut into one chunk and not two. A parcel that straddles a
  boundary gives a piece to each side, and each piece carries the id and the owner of the whole
  parcel. A building is never cut: the chunk its lot's middle stands in owns the whole of it, and a
  plant belongs to the chunk it stands in the same way.
- `test/seed-surface.ts` asks the chunk grid's ground against every road and junction vertex drawn,
  and the middle of the triangles between them, and allows `SURFACE_ABOVE` above none of them.
- `test/seed-sweep.test.ts` runs 6 seeds, or 200 under `SWEEP_SEEDS=200`. The quick count is what
  holds `npm test` under its 15 s, since a seed generates a whole world. The checks are grouped by
  subject in `test/seed-*.ts` and declared inside that one suite: they all read the worlds
  `seed-fixture.ts` builds, and a suite per file would run in parallel with the others and generate
  every world again. `seed-limits.ts` holds the numbers, `seed-probes.ts` the readings and
  `seed-index.ts` the two indexes.

