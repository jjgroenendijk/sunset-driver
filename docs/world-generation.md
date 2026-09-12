# World generation

The gotchas of `src/world`: what a generator refuses, what is built on demand, and what is already
in the world description. `spec.md` sections 6, 7, 9 and 10 are the design; this is what a session
gets wrong without it.


- `generateWorld(seed)` builds the whole-map skeleton; chunk-level content will hang off it. The
  archipelago is a power diagram of island sites shrunk by half a channel and domain-warped, so
  straits bend but never close. The main site is the core at the origin.
- three.js `TerrainGenerator` needs `valleyBias: 1`; fractional values produce NaN.
- `new LandMasses(hf, islands, minHeight)` (`landmass.ts`) labels the connected pieces of dry land
  and says which carry an island site. A cell of the power diagram can hold a rock in the sea that
  no crossing reaches, so anything that places ground content asks `carriesIsland` first. District
  sites do.
- Ask `islandAt(islands, size, coastNoise(seed), x, y)` which island a point stands on.
  `islandIndexAt` reads the raw power cells, and the coastline is cut from those cells after a
  domain warp that moves them by up to 6 % of the map.
- `buildTensorField(world)` (`tensor.ts`) is the seeded field road direction follows (spec section
  6.1). Influences blend as tensors, so ones facing opposite ways reinforce instead of cancelling;
  `sample(x, y)` returns both directions and a `strength` saying how decided the field is, and
  `majorAt(x, y)` is the allocation-free hot path.
- `roads.ts` is the plan of the road network and `road-trace.ts` the trace it runs on: the step
  along the field, the ground that refuses it, the reroute and the structures. `RoadTracer` extends
  `RoadTrace`, and `road-index.ts` is the network laid so far, which every step is vetted against.
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
- A highway takes a junction only at an interchange (spec section 6.2). `interchangesOf` places them
  along the curve, `RoadCurve.interchanges` lists the point indices, and `mayJoin` (`tiers.ts`) is
  the rule: a highway or an arterial ramp joins one there, and a street, alley or dirt road never
  joins a highway anywhere. Where a minor road crosses a highway instead, `graph.crossings` makes it
  an overpass.
- `connectCrossings(roads, canRun)` (`connect.ts`) runs after the minor fill, before
  `raiseOverpasses`: two roads that cross on the ground meet there (spec section 6.2). The trace
  only ever ends a road on a *point* of another one, so a road crossing another between its points
  met nothing and the two were drawn through each other. The pass gives both curves a point at the
  crossing, which the graph turns into a node and `junctions.ts` into a junction. A crossing within
  `CROSSING_SNAP` of a point one curve already has takes that point instead, because two junctions a
  metre apart stand inside each other. It leaves a crossing alone where `mayJoin` refuses the pair,
  where either road is on a deck or in a bore, where the place stands on a road one of the tiers may
  not join, and where the ground refuses the two halves the point cuts a segment into — `groundRule`
  (`roads.ts`) is the one rule for that, the same one the trace ran on.
- `raiseOverpasses(roads)` (`overpass.ts`) is the last step of `traceRoads`: where two roads cross
  without meeting, one is carried over the other (spec section 6.2). The narrower road climbs — a
  highway holds its line, since its grade limit is the gentlest and its ramps would be the longest —
  and the wider one climbs only where the narrow one cannot. The lift is `CLEARANCE` over the
  crossing, held level past the ground the road below claims, and ramped back down no harder than
  the tier's `maxGrade`. `RoadCurve.lift` carries the height and every raised segment goes in
  `bridges`, so the carve leaves that ground alone, `road-mesh.ts` lofts the deck and the physics
  stands on it. A ramp ends on a point the curve already had: one ending between two points would
  cut the segment there in two, and half a segment can climb harder than the whole. The raise is
  refused where a junction of the road stands inside the reach, where the road is already bored or
  decked there, and where it would run out before it is down again; those crossings stay flat.
- `buildRoadGraph(roads)` (`graph.ts`) is the queryable road graph of spec section 6.5. It is built
  on demand from the curves, not stored in the world description. A node is a point two curves
  share, so two roads that only cross on the map stay grade separated. `graph.crossings` lists those
  crossings and says which road is carried over the other; both runs of both roads carry the index.
  `shortestPath(from, to, allow?)` narrows the network to the edges `allow` accepts, which is how
  the tram is routed over the arterials alone. `tiers.ts` holds the width, verge, pavement, lanes,
  speed limit, permitted traffic and maximum grade of each tier; nothing else should carry those
  numbers.
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
  crossing reaches are cut out first. `isResort` says which beaches carry a boardwalk line, a pier
  and car parks: the long ones, plus the best two outside the core whatever their length, which is
  what gives every seed the beach the spec asks for. The dune line is offset off a coastline that
  marching squares draws in cell steps, so the normal is taken across several samples and capped
  short of the centre of a bend; both keep it from folding over itself.
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
  one piece rather than becoming strips no road touches. An owner comes in a size:
  `ownerMaxArea(zone, owner)` is the most a park, a car park, a plaza or a building group may hold
  there, and a parcel the roll gives to an owner too small for it stays ground cover.
- `buildBuildings(world, parcels, graph)` (`buildings.ts`) places the buildings of spec section
  10.3. It is built on demand like the parcels, not stored in the world description. A parcel the
  zone gave to a building group carries a row of lots along its frontage: the run of its boundary
  that stands on the ground a road claims. A lot is a rectangle set back from that frontage and
  shortened until it stands wholly inside the parcel, so the ground behind it stays garden or yard;
  one too shallow even for its zone's least depth is dropped rather than allowed to overhang. Two
  lots of one parcel never meet, which is what gives a narrow block one row instead of two crossing
  ones. `ZONE_BUILDINGS` says what a zone builds at all — a suburban parcel has no tower on its list
  — and `MIN_LOT_AREA` what each kind needs, so a lot too small for the kind it rolled takes the
  next smaller kind the zone allows.
- `buildCorridors(world, roads, graph)` (`corridors.ts`) lays the corridors of spec section 6.3 and
  the tram route of spec section 13.2. It is the last step of `generateWorld`, and the only place
  that builds the graph during generation. A corridor claims its ground at the moment it is laid: a
  strip is claimed segment by segment, ground within `CLAIM_CLEARANCE` of a claimed strip is not
  free, and a run that meets claimed ground is cut and continues past it. Two corridors therefore
  cannot overlap, and the sweep only confirms it. The tram claims first, so a deck over its lane
  gives way. A line that turns more than `MAX_BEND` is cut at the turn, because a strip carried
  round a corner that sharp folds over itself.
- An elevated corridor is the ground under a deck that stands over land, with the pillar feet that
  carry it; a deck over water owns nothing, because there is no ground under it. A tram corridor is
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
  follows the plane to its cut and blends back onto its own line over one cut more. The carve and
  the ribbons both read the beds, and the carve levels the whole junction `outline` to the plane, so
  the ground and the road agree by construction and no crease can show through a junction.
- `buildCarve(terrain, roads, junctions)` (`carve.ts`) is the terrain the roads leave (spec section
  7.1). It is built on demand like the graph, the footprint and the parcels: `world.terrain` stays
  the natural ground the roads were traced on, and the carved ground is what a chunk carries and
  what the renderer and the physics read. `heightAt(x, y)` answers one place at a time from the
  roads alone, so two chunks agree along the edge they share without being cut together. The bench
  each side of a bed is `benchHalfWidth(tier)`: the ground the tier claims, or one
  `CHUNK_TERRAIN_CELL` where that is narrower, and `BENCH_MARGIN` — one cell diagonal — past either.
  That margin is what keeps the hillside out of the road: a grid cell holding the edge of a road has
  corners each side of it, and a corner off the bench stands higher than the road on an uphill side,
  so the triangle between them cuts up through the verge. Past the bench the cut and fill blend back
  into the hillside over `CARVE_BLEND`. Ground a road claims — the bench it draws its surface on —
  belongs to it before ground it merely reaches, and where two roads claim one place the ground
  takes the lower of the beds they ask for, so the other road stands over the ground rather than
  buried under it; `crowdedAt(x, y)` is how the sweeps ask whether a place is one of those. A
  segment on a deck or in a bore carves nothing at all.
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
  along a road needs: the bed height at a place on a curve, which way is across the road there, and
  how far along the curve it is. The bed is the line `carve.ts` cuts its bench to. A point two
  segments meet at takes a mitred frame only where the mitre moves its outer corner less than
  `MITRE_SHIFT`; a sharper turn answers with the frame of the segment asked about, so the two sides
  differ and the caller cuts its geometry there rather than folding it over. `road-mesh.ts` then
  bevels the joint: without it the outside of the turn is a wedge of ground showing through the
  road, and half of every arterial bend asks for one. The rule reads the curve and never the chunk,
  which is what keeps two chunks in step.
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
- `test/seed-sweep.test.ts` runs 6 seeds, or 200 under `SWEEP_SEEDS=200`. The quick count is what
  holds `npm test` under its 15 s, since a seed generates a whole world. The checks are grouped by
  subject in `test/seed-*.ts` and declared inside that one suite: they all read the worlds
  `seed-fixture.ts` builds, and a suite per file would run in parallel with the others and generate
  every world again. `seed-limits.ts` holds the numbers, `seed-probes.ts` the readings and
  `seed-index.ts` the two indexes.

