import { CARVE_CUT, CARVE_FILL } from '../src/world/carve.ts';
import { type BuildingKind } from '../src/world/buildings.ts';
import { type ParcelOwner } from '../src/world/parcels.ts';
import { type Zone } from '../src/world/types.ts';

/**
 * What the seed sweep holds every world to: the seed counts, the sample counts
 * and the slack each check allows. The numbers are here rather than in the check
 * files so one of them is read and changed in one place.
 */
/**
 * Quick tier by default; CI and `npm run test:full` set SWEEP_SEEDS=500 (spec
 * section 3). The quick tier takes the seeds that fit in its 15 s, and the
 * full tier is the coverage. Every count below reads this one, so the quick
 * tier is a sample of the same checks and never a shorter list of them.
 */
export const SEED_COUNT = Number(process.env.SWEEP_SEEDS ?? 6);

/**
 * Which share of the tier's seeds this run reads. `SWEEP_SHARD=2/4` is the
 * second of four shards, and no variable at all is the whole tier.
 *
 * Generating a world is most of what the sweep costs, and the pool already
 * spreads that over every core of one machine, so the only way further down is
 * more machines. `full-tier.yml` gives the seed sweep four runners and hands
 * each of them one shard. The shards take the seeds in turn — shard 1 takes
 * seed 0, shard 2 seed 1 — so every shard gets the same spread of the space.
 */
const asked = (process.env.SWEEP_SHARD ?? '1/1').split('/');
export const SHARD_COUNT = Math.max(1, Math.trunc(Number(asked[1] ?? 1)) || 1);
export const SHARD_INDEX = Math.min(SHARD_COUNT, Math.max(1, Math.trunc(Number(asked[0])) || 1)) - 1;
/**
 * This shard's share of a count of seeds taken from the front of the tier.
 * The shares add up to the count and never overlap, so the four shards
 * together read the very seeds one unsharded run reads — the split changes
 * which machine does the work and nothing about the coverage.
 */
const perShard = (count: number): number => Math.max(0, Math.ceil((count - SHARD_INDEX) / SHARD_COUNT));
/**
 * Seeds the byte-identical check generates a second time. Generating a world is
 * the most expensive thing this file does, so the quick tier repeats only a few.
 */
export const REPEAT_COUNT = SEED_COUNT > 20 ? perShard(20) : 2;
/**
 * Seeds the road footprint is laid, the parcels are cut and the buildings are
 * laid for. A job that carries them costs about three times a bare world, so
 * both tiers do a few seeds rather than all of them. The pool does that work,
 * next to the world it belongs to. Every chunk check reads these layers, so
 * this count is most of what the file costs in the quick tier.
 */
export const FOOTPRINT_COUNT = SEED_COUNT > 20 ? perShard(16) : 2;
/**
 * Seeds the dealers of spec section 16.2 are placed on. Each corner is snapped
 * by one pass over every road of the world, and a city has about forty
 * districts with four corners each, so a seed costs a tenth of a second.
 */
export const DEALER_COUNT = SEED_COUNT > 20 ? perShard(4) : 1;
/**
 * Seeds the authored chain of spec section 18 is walked on. It costs what the
 * dealers cost, and for the same reason: the contacts and the corners its legs
 * stand on are snapped by a pass over every road.
 */
export const CHAIN_COUNT = SEED_COUNT > 20 ? perShard(4) : 1;
/**
 * The share of the dry land the roads may claim (spec section 6.4). A city
 * gives about a seventh of its ground to the carriageway, the verge and the
 * pavement together, and the wilderness beyond it gives almost none. The bounds
 * are wide: they are here to catch a footprint that has collapsed or run away,
 * not to pin a number down.
 *
 * The ceiling rose with the zone rings of spec section 8.2: the city is now
 * most of the map rather than a twentieth of it, so far more of the land is
 * ground a street runs over. Over the sixteen seeds this check reads, the worst
 * claims 31 %.
 */
export const MIN_FOOTPRINT_SHARE = 0.04;
export const MAX_FOOTPRINT_SHARE = 0.4;
/** Metres from every road that ground has to stand before the footprint may not claim it. */
export const CLEAR_OF_ROADS = 80;
/**
 * Metres a dirt road has to stand from every paved road before the ground under
 * it is asked to read as dirt. Where the two meet, the wider road claims the
 * ground they share, so a made-up junction reads as tarmac.
 */
export const PAVED_CLEAR = 40;
/**
 * Seeds the surface index is checked against a measurement of every road
 * segment on the map, and places each of them is asked about. Measuring one
 * place costs a walk of the whole network, so this is a handful rather than
 * every seed; what the index answers is a pure function of the place, so a
 * handful of maps is enough to catch a bucket grid that files a segment wrong.
 */
export const BY_HAND_COUNT = SEED_COUNT > 20 ? perShard(16) : 3;
export const BY_HAND_SAMPLES = 12;
/**
 * The share of the places sampled on a beach's sand that have to read as sand.
 * The rest is road: a boardwalk, an island link or a seafront road may cross a
 * beach, and the road claims the ground where it does. Three seeds in four read
 * above 0.8; this is a floor, not a measurement.
 */
export const MIN_SAND_READ = 0.5;
/** One road segment in this many is asked whether the footprint covers it. */
export const SAMPLE_STRIDE = 40;
/** Places a seed is asked about that stand clear of every road. */
export const CLEAR_SAMPLES = 200;
/** Places a seed is asked which parcels claim them. */
export const PARCEL_SAMPLES = 250;
/** Parcels a world has to be cut into; a map that comes back with fewer has collapsed. */
export const MIN_PARCELS = 40;
/**
 * How much of the dry land may be neither road nor parcel. What is left over is
 * land the road network never reaches — an outer island with no road laid on it,
 * or a hilly arm of the mainland no road climbs — and nothing can be placed
 * there, so it is no parcel. A seed with much more than this has lost ground the
 * roads do reach.
 *
 * This rose with the zone rings of spec section 8.2: the rings now reach that
 * ground rather than leaving it in the wilderness, and reaching it with a ring
 * is not the same as reaching it with a road. Over the sixteen seeds this check
 * reads, the worst leaves 18.2 %.
 */
export const MAX_UNREACHED_SHARE = 0.25;
/**
 * The owners spec section 6.4 step 4 names that are handed out today. A body of
 * water inside the land comes later; until then no parcel carries it.
 */
export const ASSIGNED_OWNERS = new Set<ParcelOwner>([
  'building',
  'park',
  'car-park',
  'plaza',
  'under-structure',
  'beach',
  'ground',
]);
/** Buildings a world has to be given; a map that comes back with fewer has collapsed. */
export const MIN_BUILDINGS = 200;
/**
 * The kind spec section 8.2 gives each zone its character from. The sweep asks
 * that it is the commonest one the zone builds, so the core reads as towers and
 * the suburbs as houses however the district weights fall.
 */
export const SIGNATURE_KIND: Record<Zone, BuildingKind> = {
  core: 'tower',
  inner: 'mid-rise',
  industrial: 'warehouse',
  suburban: 'house',
  outskirts: 'house',
  wilderness: 'house',
};
/**
 * The least share of a zone's buildings the signature kind may be, over all the
 * seeds the test reads together. The figures are what the generator gives today
 * with room for a seed whose districts are poor or thin: the pooled shares are
 * about 48 % in the core, 50 % inner, 100 % industrial, 83 % suburban, 64 %
 * outskirts and 64 % wilderness.
 */
export const MIN_SIGNATURE_SHARE: Record<Zone, number> = {
  core: 0.3,
  inner: 0.35,
  industrial: 0.95,
  suburban: 0.6,
  outskirts: 0.4,
  wilderness: 0.4,
};
/** Buildings a zone needs before its distribution is asked about at all. */
export const MIN_KIND_SAMPLES = 60;
/**
 * The least share of a seed's core blocks a building group may own (issue
 * #193). A beach is not a block and is not counted. Over the first 80 seeds the
 * worst seed gives 80 % and most give over 90 %; before the issue the core gave
 * about 74 %.
 */
export const MIN_CORE_BUILT_SHARE = 0.75;
/**
 * How much higher the skyline stands, on average, over the towers of the inner
 * ring than over its mid-rise blocks, pooled over the seeds (issue #193). Over
 * the first 80 seeds it is 0.30 against 0.22, and no seed gives less than 0.03.
 */
export const MIN_TOWER_SKYLINE_LEAD = 0.04;
/**
 * Metres past the ground its road claims, the slack `buildings.ts` allows a
 * frontage and the setback its zone lays it at, that the nearer corner of a
 * building's front edge may stand. The metre is for the parcel boundary being
 * sampled rather than followed; over 200 seeds the worst is 1.5 m inside it.
 */
export const FRONT_SLACK = 1;
/** Metres a building's front may stand from the middle of its own front edge. */
export const FRONT_DRIFT = 0.01;
/**
 * Square metres two attached lots of one parcel may share. They touch along the
 * wall between them, so the corners they share are equal to the millimetre and
 * the ground between them is nil; this is the rounding of a 24 m edge and
 * nothing more.
 */
export const SHARED_LOT_AREA = 0.05;
/**
 * The share of the lots of an attached zone that have to share a wall with
 * another lot of the same parcel, over every parcel with more than one lot on
 * it (issue #192). It is not 1 because the two ends of a row have one neighbour
 * each and a lot the corner rule moved off its neighbour has none; the six
 * seeds of the quick tier read 0.81 today.
 */
export const MIN_WALLED_SHARE = 0.7;
/**
 * Radians a building may face away from the normal of its own front edge. Both
 * come off the same two corners, so the only room here is the rounding of them
 * onto the millimetre grid.
 */
export const FACING_DRIFT = 1e-3;
/**
 * Metres of beach outside the core that every seed has to carry, with a
 * boardwalk along it and a pier off it (spec section 7.3). The rule is that the
 * best beaches outside the core are developed however long they are, so this is
 * what the coastlines give today with room for a seed that gives less — not a
 * target the generator aims at. Over 200 seeds the worst is 311 m and the
 * median is about 970 m.
 */
export const GUARANTEED_BEACH = 250;
/**
 * How much of that beach's free sand — the sand no road took — has to come back
 * as a parcel the beach owns, and how many places along it at the least. The
 * ends of a beach are cut off by the road that reaches its boardwalk, so it is
 * never the whole of it.
 */
export const MIN_SAND_OWNED = 0.8;
export const MIN_SAND_PLACES = 4;
/** Shore samples between the places along a beach the tests ask about. */
export const BEACH_STRIDE = 3;
/**
 * Metres a boardwalk may stand off the line the beach laid for it. The road
 * covers only as much of that line as the ground allows a street, so what it
 * has to cover is the metres `roads.ts` insists on and not the whole of it.
 */
export const BOARDWALK_DRIFT = 3;
/**
 * Metres a road point may stand off the carved ground (spec section 7.1). The
 * ground the game draws is a grid of {@link CHUNK_TERRAIN_CELL} cells, so a
 * bench a few cells wide comes back a little rounded; this is the room that
 * rounding needs.
 */
export const CARVE_CLEARANCE = 0.5;
/**
 * The share of a seed's road points on the ground that may stand further off
 * than that. Two roads within a bench of each other at different heights — a
 * street beside a highway embankment, two hairpins on a cliff — ask for two beds
 * in one grid cell, and only one of them can have it. A seed of steep ground
 * carries a few per cent of those; the worst of the sixteen seeds checked
 * carries 7.9 %.
 *
 * That figure rose with the zone rings of spec section 8.2. The dense fill of
 * the core and the inner ring now runs over ground that used to be suburb and
 * outskirt, and hills are what most of that ground is. Two streets a bench
 * apart on a hillside are exactly the case below, so there are many more of
 * them: the count on the worst seed went from 275 to about 2,000 while the
 * points on the ground went from 8,400 to 20,600.
 *
 * It is a share of the points on the ground, so it moves with how many of them
 * there are. `overpass.ts` took about a sixth of them off the ground and onto
 * decks, and the count of points standing off fell with it on every seed — 152
 * to 136 on the worst one — while the share rose from 4.7 % to 5.0 %, because
 * the population it is measured against shrank faster. The number to watch is
 * that count.
 *
 * The strip blocks of issue #190 did the same thing again, and harder. A core
 * block is now 90 m by 230 m rather than 80 m square, so a third of the street
 * length is gone and with it a third of the points. The count fell on all
 * sixteen seeds — 858 to 686 on the seed that was worst before — while the
 * worst share rose from 7.9 % to 10.1 %.
 */
export const CARVE_STAND_OFF_SHARE = 0.12;
/**
 * Metres no road point may stand off the carved ground where the ground is not
 * crowded. On a bench the ground is the road's own surface, and past it the
 * carve moves no sample further than its cut and fill limit. The ground between
 * two samples is the line between them, so a point further off than this is a
 * carve that has gone wrong, not a grid that ran out of room.
 */
export const CARVE_STAND_OFF = Math.max(CARVE_CUT, CARVE_FILL);
/**
 * Metres each side of a road centreline that the carriageway is asked to be
 * level at. Only a tier whose bench reaches that far, with a chunk cell to
 * spare for the grid to sample it, is asked: an alley's bench is narrower than
 * this, and the ground beside it is the hillside blending back.
 */
export const LEVEL_AT = 6;
/** One road segment in this many is asked how level the ground beside it is. */
export const LEVEL_STRIDE = 4;
/**
 * Metres the ground may stand above a road or junction surface where it is
 * drawn (spec section 7.1, issue #265). The surface and the carve read one
 * height function, so this is only the rounding of the chunk grid.
 */
export const SURFACE_ABOVE = 0.05;
/**
 * One junction and one road segment in this many are asked whether the ground
 * stands through their surface. Asking every one costs about a second a seed.
 */
export const SURFACE_STRIDE = SEED_COUNT > 20 ? 1 : 4;
/**
 * Metres a place of the pavement may stand inside a carriageway before it lies
 * over it (issue #266). The pavement is cut on the millimetre grid, and the
 * carriageway the sweep asks is the roads' own, so this is rounding.
 */
export const PAVEMENT_SLACK = 0.01;
/**
 * Where in the spread of those places the levelness is read, and what it has to
 * come to. The median says nothing — most roads run over gentle ground, which
 * was near enough level already — so this reads the tail, where the carve does
 * its work.
 */
export const LEVEL_PERCENTILE = 0.9;
/**
 * This rose with the zone rings of spec section 8.2 as well, and for the same
 * reason as {@link CARVE_STAND_OFF_SHARE}: the city now stands on hills. The
 * natural ground at these places used to be 0.38 m to 0.60 m off the road bed
 * and is now 0.82 m to 1.23 m. The carve still halves it — the gain below is
 * 1.79 at worst, against 1.38 before — but half of twice as much is more. The
 * worst of the sixteen seeds reads 0.61 m.
 */
export const LEVEL_WITHIN = 0.75;
/**
 * How much closer to the road bed the carve has to bring that ground.
 *
 * The ground two roads crowd is left out of both numbers, because it is carved
 * to the lower of the beds they ask for and so says nothing about either road.
 * What is left is the ground one road has to itself, which is the gentler part
 * of the map: over 40 seeds the natural ground there is 0.38 m to 0.60 m off
 * the bed and the carved ground 0.21 m to 0.31 m, a gain of 1.38 to 2.57. So
 * this is what the tail of the gentle ground shows, not what the carve does to
 * a hillside; {@link LEVEL_WITHIN} is what pins how level it leaves the ground.
 */
export const LEVEL_GAIN = 1.25;
/** Chunks each way of the origin in the block every seed is cut into (spec section 3). */
export const CHUNK_BLOCK = 1;
/**
 * The chunks whose roads are lofted into real geometry. Building one is far
 * dearer than cutting one, so this is a corner of the core, where every tier,
 * the bends and the structures all appear.
 */
export const ROAD_MESH_CHUNKS: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
];
/**
 * The far offsets every seed is cut at, in chunks. All four stand inside a 3 km
 * map, which is the smallest a seed draws.
 */
export const FAR_CHUNKS: readonly (readonly [number, number])[] = [
  [5, 0],
  [0, -5],
  [-4, 4],
  [3, -5],
];
/** A chunk past the edge of every map, which holds nothing at all. */
export const BEYOND_MAP: readonly [number, number] = [40, 40];
/**
 * Seeds whose chunks are cut a second time, from a world generated
 * independently, to check a chunk in isolation. Each one builds its own layers
 * — the footprint and the parcels of a whole map — so both tiers take a few.
 */
export const ISOLATED_COUNT = SEED_COUNT > 20 ? perShard(2) : 1;
/**
 * Seeds whose buildings are built into real geometry. A tower costs more to
 * generate than the chunk it stands in costs to cut, so the quick tier builds
 * one seed and the full tier spreads the check.
 */
export const BUILDING_MESH_COUNT = SEED_COUNT > 20 ? perShard(4) : 1;
/** Places in the block of chunks each way that are asked which parcel claims them. */
export const CHUNK_SAMPLES = 18;
/**
 * The chunks each seed is planted in: one on the core, where the trees stand
 * along the pavement, and one far out, where the woods are. Cutting one is
 * cheap next to the layers behind it, but not free, so two is the sample.
 */
export const VEGETATION_CHUNKS: readonly (readonly [number, number])[] = [[0, 0], FAR_CHUNKS[0] as readonly [number, number]];
/** Plants of a chunk whose whole canopy is walked, rather than only the point they stand on. */
export const VEGETATION_SAMPLES = 24;
/** Points round the rim of a canopy that are asked which parcel they stand on. */
export const CANOPY_POINTS = 8;
/** Plants the two chunks of a seed carry between them, at least. A map with none is a fault. */
export const MIN_PLANTS = 20;
/**
 * Seeds whose plants are checked. Walking the rim of a canopy asks the parcels
 * of a whole map which of them claims a place, so the quick tier takes a few
 * and the full tier spreads the check.
 */
export const VEGETATION_COUNT = SEED_COUNT > 20 ? perShard(8) : 2;
/**
 * Metres a corner may move when a parcel is cut to a chunk. The polygon engine
 * rounds every corner onto its millimetre grid and snaps one that lands beside
 * an edge onto it, so a piece is bounded within about a millimetre of the
 * ground it was cut from, and a long boundary gains or loses a little area.
 */
export const CUT_SLACK = 2e-3;
/**
 * Metres from the edge of a parcel that a place is too close to the edge to ask
 * about. The cut moves that edge by up to {@link CUT_SLACK}, so a place any
 * nearer than this may fall on either side of it and proves nothing.
 */
export const BOUNDARY_SLACK = 0.01;
/**
 * Metres a block may stand short of a side edge its lot shares, at either end
 * of that edge. A centimetre is float error; more is daylight in the street wall.
 */
export const WALL_REACH = 0.01;
/**
 * Hectares of dry land a zone needs before the layout check reads its shares.
 * The water cuts the industrial wedge of a thin seed down to a few blocks, and
 * one block either way moves every share of a zone that small.
 */
export const MIN_ZONE_HECTARES = 8;
/**
 * Parcels a zone needs before its middle parcel is asked about. The wilderness
 * of a seed whose rings cover almost the whole map is a handful of rocks in the
 * sea, and the middle of three parcels says nothing about how land is cut.
 */
export const MIN_ZONE_PARCELS = 5;
/**
 * Seeds the traffic of spec section 13.1 is placed on and checked for. Placing
 * it costs a few tens of milliseconds a seed on top of the road beds, so the
 * full tier checks a sample rather than every seed.
 */
export const TRAFFIC_COUNT = SEED_COUNT > 20 ? perShard(24) : 2;
/** Metres of a tier a world must carry before the sweep expects traffic on it. */
export const TRAFFIC_TIER_MIN = 1000;
/**
 * Pairs of ambient vehicles that may stand on the same ground at one tick, per
 * vehicle in the city. No vehicle reads another, so some overlap is the price
 * of spec section 5.3 and the number is a ceiling, not a target: two vehicles
 * that meet at a junction or share a lane through a corner are expected. It
 * catches the failure where the signal timing stands a whole platoon on one
 * spot, which reads about twice this.
 */
export const TRAFFIC_OVERLAP = 0.3;
/**
 * The share of the tram's level crossings that must take a light (spec section
 * 13.2). The rest stand where a run is too short for a stop line or a highway
 * meets the arterial on the flat, and the tram only halts and rings there.
 */
export const TRAM_LIT_SHARE = 0.85;
