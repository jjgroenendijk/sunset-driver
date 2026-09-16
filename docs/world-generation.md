# World generation

The gotchas of `src/world`: what a generator refuses, what is built on demand, and what is already
in the world description. `spec.md` sections 6, 7, 9 and 10 are the design; this is what a session
gets wrong without it. The road network has a page of its own in `docs/roads.md`, and the
corridors in `docs/corridors.md`.

## Contents

- The map skeleton
- Beaches and boardwalks
- Parcels, parking and buildings
- Junctions, road beds and the carve
- Ribbons and vegetation
- Chunks and the sweeps

## The map skeleton

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

## Beaches and boardwalks

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

## Parcels, parking and buildings

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
  station keeps the `building` owner. The metro stations of spec section 13.3 come out of the same
  pass through `MetroPlan` (`metro.ts`): the core and inner districts and the suburb farthest from
  the core each take the plaza nearest their site, or the second nearest building parcel, since the
  police station holds the first. They keep their parcel's owner too. The chunk worker sends both
  lists to the main thread on its first `ready` reply, because the main thread never builds the
  parcels.
- `buildParkingBays` (`parking.ts`) lays out the bays of spec section 13.1, and the worker sends
  them on the same reply. A street bay is a length of the `TierSpec.parking` strip inside each kerb,
  and `laneOffset` shares only what is left between the lanes. A bay is refused where it would
  reach the ground another road claims, its own street's lanes, or its neighbour on a bend. A car
  park is laid in rows `STREET_REACH` inside its edge, because that rim is where its trees stand.
  Its bays keep off the ground every road claims as well.
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
    may reach the edge and where it has to keep a margin; see `docs/render-entities.md`.

## Junctions, road beds and the carve

- The corridors, the piers under the decks and the tram track are in `docs/corridors.md`.
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

## Ribbons and vegetation

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

## Chunks and the sweeps

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
