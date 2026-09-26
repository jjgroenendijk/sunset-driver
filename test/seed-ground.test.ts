import { expect, it } from 'vitest';
import { pointInRegions, type Region } from '../src/core/geom.ts';
import { type RoadBeds } from '../src/world/bed.ts';
import { benchHalfWidth, CARVE_BLEND, type RoadCarve } from '../src/world/carve.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { deckPiers, RoadGround, type DeckPier } from '../src/world/piers.ts';
import { CHUNK_TERRAIN_CELL } from '../src/world/terrain.ts';
import { nearestRoadPlace, SurfaceIndex } from '../src/world/surface.ts';
import { type Corridor, type Point, type RoadCurve, type WorldDescription } from '../src/world/types.ts';
import { landPoints, pointInRing, ringArea, ringsOverlap } from './helpers.ts';
import {
  FOOTPRINT_COUNT,
  MIN_FOOTPRINT_SHARE,
  MAX_FOOTPRINT_SHARE,
  CLEAR_OF_ROADS,
  PAVED_CLEAR,
  BY_HAND_COUNT,
  BY_HAND_SAMPLES,
  MIN_SAND_READ,
  SAMPLE_STRIDE,
  CLEAR_SAMPLES,
  BEACH_STRIDE,
  CARVE_CLEARANCE,
  CARVE_STAND_OFF_SHARE,
  CARVE_STAND_OFF,
  LEVEL_AT,
  LEVEL_STRIDE,
  LEVEL_PERCENTILE,
  LEVEL_WITHIN,
  LEVEL_GAIN,
} from './seed-limits.ts';
import { PointGrid } from './seed-index.ts';
import {
  chunkGroundAt,
  surfaceByHand,
  passesUnder,
  polylineLength,
  wetFraction,
  percentile,
  landArea,
} from './seed-probes.ts';
import { seeds, worlds, footprintOf, carveOf, bedsOf, graphOf, junctionsOf } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/** Reports a fault; only the first one of a seed is kept. */
type Fault = (text: string) => void;

/** The first fault a check finds for one seed. */
class Complaint {
  first: string | undefined = undefined;
  readonly fault: Fault = (text) => {
    this.first ??= text;
  };
}

/** One segment of a road, with its ends and its middle. */
interface Segment {
  road: RoadCurve;
  i: number;
  a: Point;
  b: Point;
  mid: Point;
  where: string;
}

/** Every SAMPLE_STRIDE-th segment of the network, counted across all roads. */
function* sampledSegments(w: WorldDescription): Generator<Segment> {
  let step = 0;
  for (const road of w.roads) {
    for (let i = 0; i + 1 < road.points.length; i++) {
      if (step++ % SAMPLE_STRIDE !== 0) continue;
      const a = road.points[i] as Point;
      const b = road.points[i + 1] as Point;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      yield { road, i, a, b, mid, where: `${road.tier} ${road.id} segment ${i}` };
    }
  }
}

// --- The carve --------------------------------------------------------------

/** What the carve test reads for one seed. */
interface CarveProbe {
  carve: RoadCarve;
  beds: RoadBeds;
  natural: Heightfield;
  carved: { sample: (x: number, y: number) => number };
  /** `curve:point` of every curve end that stands on a junction. */
  atJunction: Set<string>;
}

/** What the carve test counts over every road of one seed. */
interface CarveTally {
  points: number;
  standingOff: number;
  /** How far the ground beside a road stood off the road bed before the carve. */
  wasLevel: number[];
  /** The same after the carve. */
  isLevel: number[];
}

/**
 * The nodes of this seed's junctions. A bore or a deck that starts on one is
 * not carving its own ground: the junction is levelled to its plane, and the
 * plane reaches further along the curve than the portal or the abutment at
 * that end does.
 */
function junctionEnds(seed: number): Set<string> {
  const junctionNodes = new Set(junctionsOf(seed).junctions.map((j) => j.node));
  const atJunction = new Set<string>();
  for (const edge of graphOf(seed).edges) {
    if (junctionNodes.has(edge.from)) atJunction.add(`${edge.curve}:${edge.start}`);
    if (junctionNodes.has(edge.to)) atJunction.add(`${edge.curve}:${edge.end}`);
  }
  return atJunction;
}

/**
 * Nothing under a deck or over a bore is this road's to carve. Only a long one
 * is asked: the ground beside a short one is within reach of the abutment or
 * the portal at either end, which is on the ground and does carve. The ground
 * may still belong to another road, one the deck flies over — or to another
 * run of this same road, where a hairpin brings it back under its own deck,
 * and then the ground under it really is a road bed.
 */
function checkStructure(road: RoadCurve, i: number, probe: CarveProbe, fault: Fault): void {
  const a = road.points[i] as Point;
  const b = road.points[i + 1] as Point;
  const reach = benchHalfWidth(road.tier) + CARVE_BLEND;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (
    Math.hypot(b.x - a.x, b.y - a.y) > 2 * reach &&
    probe.carve.roadAt(mid.x, mid.y) === road.id &&
    !probe.atJunction.has(`${road.id}:${i}`) &&
    !probe.atJunction.has(`${road.id}:${i + 1}`) &&
    !passesUnder(road, i, mid, reach)
  ) {
    fault(`${road.tier} ${road.id} segment ${i} stands off the ground but carves it`);
  }
}

/** A point between two segments on the ground stands on the carved ground. */
function checkOnGround(road: RoadCurve, i: number, probe: CarveProbe, tally: CarveTally, fault: Fault): void {
  const a = road.points[i] as Point;
  const stand = Math.abs(probe.beds.pointHeight(road.id, i) - probe.carved.sample(a.x, a.y));
  tally.points++;
  if (stand > CARVE_CLEARANCE) tally.standingOff++;
  // The bound holds for the ground one road carves on its own. Ground
  // two of them claim is the crowded case above: it is carved to the
  // lower of the beds asked for, so the road standing over it stands
  // as far off as the two beds differ, which is the road network's to
  // answer for and not the carve's.
  if (stand > CARVE_STAND_OFF && !probe.carve.crowdedAt(a.x, a.y)) {
    fault(`${road.tier} ${road.id} point ${i} stands ${stand.toFixed(1)} m off the ground`);
  }
}

/**
 * Level across the carriageway: the bed at the middle of the segment, against
 * the ground a few metres either side of it.
 */
function measureLevel(road: RoadCurve, i: number, probe: CarveProbe, tally: CarveTally): void {
  const a = road.points[i] as Point;
  const b = road.points[i + 1] as Point;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0 || i % LEVEL_STRIDE !== 0) return;
  if (benchHalfWidth(road.tier) < LEVEL_AT + CHUNK_TERRAIN_CELL) return;
  const bed = probe.beds.heightAt(road.id, i, 0.5);
  const nx = (-(b.y - a.y) / length) * LEVEL_AT;
  const ny = ((b.x - a.x) / length) * LEVEL_AT;
  for (const side of [1, -1]) {
    const x = (a.x + b.x) / 2 + nx * side;
    const y = (a.y + b.y) / 2 + ny * side;
    // Crowded ground is carved to the lowest bed asked for, which is
    // not this road's, so it says nothing about how level this road
    // left the hillside. Ground no road claims at all is still asked: a
    // road that carved nothing beside it is the fault this looks for.
    if (probe.carve.crowdedAt(x, y)) continue;
    tally.wasLevel.push(Math.abs(probe.natural.sample(x, y) - bed));
    tally.isLevel.push(Math.abs(probe.carved.sample(x, y) - bed));
  }
}

function checkRoadCarve(road: RoadCurve, probe: CarveProbe, tally: CarveTally, fault: Fault): void {
  const structures = new Set([...road.bridges, ...road.tunnels]);
  for (let i = 0; i + 1 < road.points.length; i++) {
    if (structures.has(i)) {
      checkStructure(road, i, probe, fault);
      continue;
    }
    // One beside a deck or a bore does not stand on the carved ground: the
    // ground there is the ground the road leaves, which is why it leaves it.
    if (i > 0 && !structures.has(i - 1)) checkOnGround(road, i, probe, tally, fault);
    measureLevel(road, i, probe, tally);
  }
}

/** Judges the counts of the whole network against the limits. */
function checkTally(tally: CarveTally, fault: Fault): void {
  const { points, standingOff } = tally;
  if (points === 0) fault('has no road on the ground at all');
  if (standingOff > points * CARVE_STAND_OFF_SHARE) {
    // The count is what to compare against another run: the share moves
    // with how many road points there are as well (see the limit).
    fault(`leaves ${standingOff} of its ${points} road points more than ${CARVE_CLEARANCE} m off the ground`);
  }
  // The ground a few metres off a road is level with the road bed, and it
  // was not before: a road that took the hillside as it found it would come
  // back with the two numbers about equal.
  const before = percentile(tally.wasLevel, LEVEL_PERCENTILE);
  const after = percentile(tally.isLevel, LEVEL_PERCENTILE);
  if (after > LEVEL_WITHIN) fault(`leaves the ground ${LEVEL_AT} m off a road ${after.toFixed(2)} m off the road bed`);
  if (after * LEVEL_GAIN > before) fault(`levels the ground ${LEVEL_AT} m off a road from ${before.toFixed(2)} m to only ${after.toFixed(2)} m`);
}

/** Ground well clear of every road is the ground the world was given. */
function checkUncarved(w: WorldDescription, probe: CarveProbe, fault: Fault): void {
  const grid = new PointGrid(w.size, 40, w.roads);
  for (const p of landPoints(w, CLEAR_SAMPLES, 0xca4e)) {
    if (grid.nearest(p.x, p.y) < CLEAR_OF_ROADS) continue;
    if (probe.carve.roadAt(p.x, p.y) !== -1) fault(`carves ground ${CLEAR_OF_ROADS} m clear of every road`);
    // The chunk grid samples the natural ground between the skeleton's own
    // samples, so the two agree to rounding rather than to the last bit.
    if (Math.abs(probe.carved.sample(p.x, p.y) - probe.natural.sample(p.x, p.y)) > 1e-6) {
      fault(`moves ground ${CLEAR_OF_ROADS} m clear of every road`);
    }
  }
}

// --- Corridors and piers ----------------------------------------------------

/** A ring wound anticlockwise, about as wide as the corridor says it is. */
function checkStrip(corridor: Corridor, where: string, fault: Fault): void {
  const area = ringArea(corridor.polygon);
  if (area <= 0) fault(`${where} is wound the wrong way`);
  const length = polylineLength(corridor.points);
  if (Math.abs(area - 2 * corridor.halfWidth * length) > 0.2 * area) {
    fault(`${where} claims ${area.toFixed(0)} m², not the ${(2 * corridor.halfWidth * length).toFixed(0)} m² of its strip`);
  }
}

function checkCorridor(w: WorldDescription, i: number, fault: Fault): void {
  const corridor = w.corridors[i] as Corridor;
  const where = `${corridor.kind} corridor ${i}`;
  if (corridor.id !== i) fault(`${where} is numbered ${corridor.id}`);
  if (corridor.points.length < 2) fault(`${where} has no centreline`);
  if (corridor.polygon.length < 4) fault(`${where} has no strip`);
  if (corridor.roads.length === 0) fault(`${where} runs along no road`);
  for (const road of corridor.roads) {
    if (w.roads[road] === undefined) fault(`${where} runs along road ${road}, which does not exist`);
  }
  checkStrip(corridor, where, fault);
  // Nothing carries a deck from outside the ground under it.
  for (const foot of corridor.pillars) {
    if (!pointInRing(foot, corridor.polygon)) fault(`${where} stands a pillar outside its own ground`);
  }
  if (corridor.kind === 'tram' && corridor.pillars.length > 0) fault(`${where} stands on pillars`);
  for (let j = 0; j < i; j++) {
    const other = w.corridors[j] as Corridor;
    if (ringsOverlap(corridor.polygon, other.polygon)) fault(`${where} overlaps ${other.kind} corridor ${j}`);
  }
}

function checkPier(w: WorldDescription, hf: Heightfield, ground: RoadGround, pier: DeckPier, fault: Fault): void {
  const road = w.roads[pier.curve] as RoadCurve;
  const where = `pier at ${pier.x.toFixed(1)}, ${pier.y.toFixed(1)} under ${road.tier} ${road.id}`;
  if (!road.bridges.includes(pier.segment)) fault(`${where} carries segment ${pier.segment}, which is no deck`);
  if (ground.covers(pier, road.id)) fault(`${where} stands on a road`);
  const wet = hf.sample(pier.x, pier.y) < w.water.seaLevel;
  const under = w.corridors.some(
    (c) => c.kind === 'elevated' && c.roads.includes(road.id) && pointInRing(pier, c.polygon),
  );
  if (!wet && !under) fault(`${where} stands on dry ground outside its corridor`);
}

/** A deck whose both ends of a segment stand over deep water carries a pier on that curve. */
function checkWaterCrossings(w: WorldDescription, hf: Heightfield, piers: readonly DeckPier[], fault: Fault): void {
  const sea = w.water.seaLevel;
  for (const road of w.roads) {
    const crosses = road.bridges.some((i) => {
      const a = road.points[i] as Point;
      const b = road.points[i + 1] as Point;
      return hf.sample(a.x, a.y) < sea && hf.sample(b.x, b.y) < sea && Math.hypot(b.x - a.x, b.y - a.y) > 50;
    });
    if (crosses && !piers.some((pier) => pier.curve === road.id)) fault(`${road.tier} ${road.id} crosses water on no pier`);
  }
}

// --- The footprint ----------------------------------------------------------

/** Checks one piece of the footprint and returns how many holes it has. */
function checkRegion(region: Region, where: string, fault: Fault): number {
  if (region.outer.length < 3) fault(`${where} has no outline`);
  if (ringArea(region.outer) <= 0) fault(`${where} is wound the wrong way`);
  for (const hole of region.holes) {
    if (hole.length < 3) fault(`${where} has a hole with no outline`);
    if (ringArea(hole) >= 0) fault(`${where} has a hole wound the wrong way`);
    if (!pointInRing(hole[0] as Point, region.outer)) fault(`${where} has a hole outside it`);
  }
  return region.holes.length;
}

/** The footprint claims the ground a segment stands on, and never the water a deck spans. */
function checkFootprintSegment(segment: Segment, hf: Heightfield, w: WorldDescription, regions: readonly Region[], fault: Fault): void {
  const { road, i, a, b, mid, where } = segment;
  if (road.tunnels.includes(i)) return;
  if (road.bridges.includes(i)) {
    // A deck over land has the corridor under it, which is claimed; a
    // deck over water stands over no ground at all.
    if (wetFraction(hf, a, b, w.water.seaLevel) > 0.5 && pointInRegions(mid, regions)) {
      fault(`${where} claims the water it bridges`);
    }
    return;
  }
  if (!pointInRegions(mid, regions)) fault(`${where} is on the ground but claims none`);
}

// --- The surface ------------------------------------------------------------

/** A sampled segment on the ground reads as a road, and a dirt road as dirt. */
function checkRoadSurface(segment: Segment, surfaces: SurfaceIndex, paved: PointGrid, fault: Fault): void {
  const { road, i, mid, where } = segment;
  if (road.tunnels.includes(i) || road.bridges.includes(i)) return;
  const surface = surfaces.at(mid.x, mid.y);
  if (surface !== 'asphalt' && surface !== 'dirt') fault(`${where} is ${surface}, not a road`);
  // A dirt road reads as dirt unless a paved road runs close enough to
  // claim the same ground, which is what a made-up junction is.
  if (road.tier === 'dirt' && surface !== 'dirt' && paved.nearest(mid.x, mid.y) > PAVED_CLEAR) {
    fault(`${where} is ${surface} with no paved road within ${PAVED_CLEAR} m`);
  }
}

/**
 * The index is a bucket grid over the segments, so a few places are asked the
 * slow and obvious way as well: every segment of every road measured, then
 * every beach. The two have to agree exactly.
 */
function checkByHand(w: WorldDescription, surfaces: SurfaceIndex, fault: Fault): void {
  for (const p of landPoints(w, BY_HAND_SAMPLES, 0x5a4d)) {
    const want = surfaceByHand(w, p.x, p.y);
    const got = surfaces.at(p.x, p.y);
    if (got !== want) fault(`${p.x.toFixed(1)},${p.y.toFixed(1)} reads as ${got} and measures as ${want}`);
  }
}

/**
 * The sand of a beach is sand, or the road that crosses it: a resort's
 * boardwalk, an island link and a seafront road all may, and the road claims
 * the ground where they do. What it is never is open ground.
 */
function checkBeaches(w: WorldDescription, surfaces: SurfaceIndex, fault: Fault): void {
  let sand = 0;
  let sampled = 0;
  for (const beach of w.beaches) {
    const points = Math.min(beach.shore.length, beach.back.length);
    for (let i = 0; i < points; i += BEACH_STRIDE) {
      const shore = beach.shore[i] as Point;
      const back = beach.back[i] as Point;
      const mid = { x: (shore.x + back.x) / 2, y: (shore.y + back.y) / 2 };
      // The dune line is offset off the waterline, so on a tight bend the
      // middle of the two can fall outside the sand they bound.
      if (!pointInRing(mid, beach.sand)) continue;
      sampled++;
      const surface = surfaces.at(mid.x, mid.y);
      if (surface === 'sand') sand++;
      else if (surface === 'ground') fault(`the sand of beach ${beach.id} reads as open ground`);
    }
  }
  if (sampled > 0 && sand < sampled * MIN_SAND_READ) {
    fault(`only ${sand} of ${sampled} places on the sand read as sand`);
  }
}

/**
 * The seed sweep of spec section 3, on the ground the roads leave: the carve,
 * the corridors, the footprint and what a surface is made of.
 */
sweepSuite('ground', () => {
  it('carves every road into the ground it stands on and leaves the rest of the hillside alone', () => {
    // Spec section 7.1: the ground under the network is cut to the line the road
    // drives, the cut and fill blend back into the hillside, and a deck or a
    // bore leaves the terrain alone. A road is never draped over the hill.
    //
    // Every point of a curve stands on the line that curve drives — its bed,
    // which is the natural ground under it away from a junction and the
    // junction's plane at one — so the carved ground there should be the same
    // height: nothing floats, nothing sinks. Two things stop that from being
    // exact. The ground the game draws is the grid a chunk samples, of cells
    // CHUNK_TERRAIN_CELL metres across, so a bench comes back rounded at its
    // edges; and where two roads run within a bench of each other at different
    // heights — a street beside a highway embankment, two hairpins on a cliff —
    // one grid cannot hold both beds at once. So this asks for two things:
    // almost every point is within CARVE_CLEARANCE of the ground, and none of
    // them stands further off it than CARVE_STAND_OFF. The ground is read as a
    // chunk reads it, off the grid anchored on the origin, without cutting
    // every chunk of the map.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const carve = carveOf(seed);
      const probe: CarveProbe = {
        carve,
        beds: bedsOf(seed),
        natural: new Heightfield(w.terrain),
        carved: { sample: (x: number, y: number): number => chunkGroundAt(carve, x, y) },
        atJunction: junctionEnds(seed),
      };
      const complaint = new Complaint();
      const tally: CarveTally = { points: 0, standingOff: 0, wasLevel: [], isLevel: [] };
      for (const road of w.roads) checkRoadCarve(road, probe, tally, complaint.fault);
      checkTally(tally, complaint.fault);
      checkUncarved(w, probe, complaint.fault);
      expect(complaint.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('gives every corridor a strip of ground that no other corridor stands on', () => {
    // Spec sections 1.1 and 6.3: a corridor claims its ground at the moment it
    // is laid, so two of them cannot share any. The claim makes that true; this
    // is what confirms it.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const complaint = new Complaint();
      for (let i = 0; i < w.corridors.length; i++) checkCorridor(w, i, complaint.fault);
      expect(complaint.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('stands piers in the water under every deck over water, and never on a road', () => {
    // Spec section 6.3: a pier stands only on the ground its deck's corridor
    // claims, or in the water; issue #267 draws them, so a bridge never floats.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const ground = new RoadGround(w.roads);
      const piers = deckPiers(w);
      const complaint = new Complaint();
      for (const pier of piers) checkPier(w, hf, ground, pier, complaint.fault);
      checkWaterCrossings(w, hf, piers, complaint.fault);
      expect(complaint.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('claims a sane share of the land under the roads, with the blocks between them as holes', () => {
    // Spec section 6.4 steps 1 and 2: the footprint is every road offset by half
    // the width of its tier, the aprons over the junctions, and the corridor
    // strips. What it does not claim are the parcels, so its holes are the city
    // blocks and its share of the land is the share a city gives to its streets.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const footprint = footprintOf(seed);
      const complaint = new Complaint();
      const fault = complaint.fault;
      if (footprint.regions.length === 0) fault('claims no ground at all');
      let holes = 0;
      for (let i = 0; i < footprint.regions.length; i++) {
        holes += checkRegion(footprint.regions[i] as Region, `piece ${i}`, fault);
      }
      // The network is one connected thing (see the test above), so it encloses
      // every block of the city between its roads.
      if (holes < 20) fault(`encloses only ${holes} blocks`);
      const share = footprint.area / landArea(w);
      if (share <= MIN_FOOTPRINT_SHARE || share >= MAX_FOOTPRINT_SHARE) {
        fault(`claims ${(share * 100).toFixed(1)} % of the dry land`);
      }
      expect(complaint.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('lays the footprint under every road on the ground, and nowhere a road does not run', () => {
    // Ground the roads stand on is claimed; water a deck spans is not, because
    // there is no ground under a deck over water; and ground well clear of every
    // road is left to the parcels.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const regions = footprintOf(seed).regions;
      const hf = new Heightfield(w.terrain);
      const complaint = new Complaint();
      const fault = complaint.fault;
      // Point in polygon costs a walk of the whole outline, so this samples the
      // network rather than walking every one of its hundred thousand segments.
      for (const segment of sampledSegments(w)) checkFootprintSegment(segment, hf, w, regions, fault);
      const grid = new PointGrid(w.size, 40, w.roads);
      for (const p of landPoints(w, CLEAR_SAMPLES, 0xf007)) {
        if (grid.nearest(p.x, p.y) < CLEAR_OF_ROADS) continue;
        if (pointInRegions(p, regions)) fault(`claims ground ${CLEAR_OF_ROADS} m clear of every road`);
      }
      expect(complaint.first, `seed ${seed}`).toBeUndefined();
    }
  });

  it('says what the ground under a car is made of, and where the nearest road is', () => {
    // Driving reads the ground through this and nothing else (spec section
    // 11.3): tarmac under a paved road, dirt under a dirt road, sand on a
    // beach and open ground everywhere else.
    const byHand = seeds.slice(0, BY_HAND_COUNT);
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const surfaces = new SurfaceIndex(w);
      const paved = new PointGrid(
        w.size,
        40,
        w.roads.filter((road) => road.tier !== 'dirt'),
      );
      const complaint = new Complaint();
      const fault = complaint.fault;

      for (const segment of sampledSegments(w)) checkRoadSurface(segment, surfaces, paved, fault);
      if (byHand.includes(seed)) checkByHand(w, surfaces, fault);
      checkBeaches(w, surfaces, fault);

      // A session starts on the nearest road to the core, and every world has one.
      const place = nearestRoadPlace(w, w.core.x, w.core.y);
      if (place === undefined) fault('no road for a car to start on');
      else if (surfaces.at(place.x, place.y) === 'ground') fault('the nearest road place is not on a road');

      expect(complaint.first, `seed ${seed}`).toBeUndefined();
    }
  });
});
