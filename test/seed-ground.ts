import { describe, expect, it } from 'vitest';
import { pointInRegions, type Region } from '../src/core/geom.ts';
import { benchHalfWidth, CARVE_BLEND } from '../src/world/carve.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { CHUNK_TERRAIN_CELL } from '../src/world/terrain.ts';
import { nearestRoadPlace, SurfaceIndex } from '../src/world/surface.ts';
import { type Corridor, type Point, type WorldDescription } from '../src/world/types.ts';
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
import { seeds, worlds, footprintOf, carves, carveOf, bedsOf } from './seed-fixture.ts';

/**
 * The seed sweep of spec section 3, on the ground the roads leave: the carve,
 * the corridors, the footprint and what a surface is made of.
 *
 * `seed-sweep.test.ts` declares these inside the one suite that generates the
 * worlds; a file of its own would generate them all again.
 */
export function groundChecks(): void {
  describe('ground', () => {
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
        const beds = bedsOf(seed);
        const natural = new Heightfield(w.terrain);
        const carved = { sample: (x: number, y: number): number => chunkGroundAt(carve, x, y) };
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };

        let points = 0;
        let standingOff = 0;
        // How far the ground beside a road stands off the road bed, before the
        // carve and after it, at every place the pair is measured.
        const wasLevel: number[] = [];
        const isLevel: number[] = [];
        for (const road of w.roads) {
          const structures = new Set([...road.bridges, ...road.tunnels]);
          for (let i = 0; i + 1 < road.points.length; i++) {
            const a = road.points[i] as Point;
            const b = road.points[i + 1] as Point;
            const where = `${road.tier} ${road.id} segment ${i}`;
            if (structures.has(i)) {
              // Nothing under a deck or over a bore is this road's to carve. Only
              // a long one is asked: the ground beside a short one is within reach
              // of the abutment or the portal at either end, which is on the
              // ground and does carve. The ground may still belong to another
              // road, one the deck flies over — or to another run of this same
              // road, where a hairpin brings it back under its own deck, and then
              // the ground under it really is a road bed.
              const reach = benchHalfWidth(road.tier) + CARVE_BLEND;
              const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
              if (
                Math.hypot(b.x - a.x, b.y - a.y) > 2 * reach &&
                carve.roadAt(mid.x, mid.y) === road.id &&
                !passesUnder(road, i, mid, reach)
              ) {
                fault(`${where} stands off the ground but carves it`);
              }
              continue;
            }
            // A point between two segments on the ground stands on the carved
            // ground. One beside a deck or a bore does not: the ground there is
            // the ground the road leaves, which is why it leaves it.
            if (i > 0 && !structures.has(i - 1)) {
              const stand = Math.abs(beds.pointHeight(road.id, i) - carved.sample(a.x, a.y));
              points++;
              if (stand > CARVE_CLEARANCE) standingOff++;
              // The bound holds for the ground one road carves on its own. Ground
              // two of them claim is the crowded case above: it is carved to the
              // lower of the beds asked for, so the road standing over it stands
              // as far off as the two beds differ, which is the road network's to
              // answer for and not the carve's.
              if (stand > CARVE_STAND_OFF && !carve.crowdedAt(a.x, a.y)) {
                fault(`${road.tier} ${road.id} point ${i} stands ${stand.toFixed(1)} m off the ground`);
              }
            }
            // Level across the carriageway: the bed at the middle of the segment,
            // against the ground a few metres either side of it.
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            if (length === 0 || i % LEVEL_STRIDE !== 0) continue;
            if (benchHalfWidth(road.tier) < LEVEL_AT + CHUNK_TERRAIN_CELL) continue;
            const bed = beds.heightAt(road.id, i, 0.5);
            const nx = (-(b.y - a.y) / length) * LEVEL_AT;
            const ny = ((b.x - a.x) / length) * LEVEL_AT;
            for (const side of [1, -1]) {
              const x = (a.x + b.x) / 2 + nx * side;
              const y = (a.y + b.y) / 2 + ny * side;
              // Crowded ground is carved to the lowest bed asked for, which is
              // not this road's, so it says nothing about how level this road
              // left the hillside. Ground no road claims at all is still asked: a
              // road that carved nothing beside it is the fault this looks for.
              if (carve.crowdedAt(x, y)) continue;
              wasLevel.push(Math.abs(natural.sample(x, y) - bed));
              isLevel.push(Math.abs(carved.sample(x, y) - bed));
            }
          }
        }

        if (points === 0) fault('has no road on the ground at all');
        if (standingOff > points * CARVE_STAND_OFF_SHARE) {
          fault(`leaves ${((standingOff / points) * 100).toFixed(1)} % of its road points more than ${CARVE_CLEARANCE} m off the ground`);
        }
        // The ground a few metres off a road is level with the road bed, and it
        // was not before: a road that took the hillside as it found it would come
        // back with the two numbers about equal.
        const before = percentile(wasLevel, LEVEL_PERCENTILE);
        const after = percentile(isLevel, LEVEL_PERCENTILE);
        if (after > LEVEL_WITHIN) fault(`leaves the ground ${LEVEL_AT} m off a road ${after.toFixed(2)} m off the road bed`);
        if (after * LEVEL_GAIN > before) fault(`levels the ground ${LEVEL_AT} m off a road from ${before.toFixed(2)} m to only ${after.toFixed(2)} m`);

        // Ground well clear of every road is the ground the world was given.
        const grid = new PointGrid(w.size, 40, w.roads);
        for (const p of landPoints(w, CLEAR_SAMPLES, 0xca4e)) {
          if (grid.nearest(p.x, p.y) < CLEAR_OF_ROADS) continue;
          if (carve.roadAt(p.x, p.y) !== -1) fault(`carves ground ${CLEAR_OF_ROADS} m clear of every road`);
          // The chunk grid samples the natural ground between the skeleton's own
          // samples, so the two agree to rounding rather than to the last bit.
          if (Math.abs(carved.sample(p.x, p.y) - natural.sample(p.x, p.y)) > 1e-6) {
            fault(`moves ground ${CLEAR_OF_ROADS} m clear of every road`);
          }
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
      }
    });

    it('gives every corridor a strip of ground that no other corridor stands on', () => {
      // Spec sections 1.1 and 6.3: a corridor claims its ground at the moment it
      // is laid, so two of them cannot share any. The claim makes that true; this
      // is what confirms it.
      for (const seed of seeds) {
        const w = worlds.get(seed) as WorldDescription;
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };
        for (let i = 0; i < w.corridors.length; i++) {
          const corridor = w.corridors[i] as Corridor;
          const where = `${corridor.kind} corridor ${i}`;
          if (corridor.id !== i) fault(`${where} is numbered ${corridor.id}`);
          if (corridor.points.length < 2) fault(`${where} has no centreline`);
          if (corridor.polygon.length < 4) fault(`${where} has no strip`);
          if (corridor.roads.length === 0) fault(`${where} runs along no road`);
          for (const road of corridor.roads) {
            if (w.roads[road] === undefined) fault(`${where} runs along road ${road}, which does not exist`);
          }
          // A ring wound anticlockwise, about as wide as the corridor says it is.
          const area = ringArea(corridor.polygon);
          if (area <= 0) fault(`${where} is wound the wrong way`);
          const length = polylineLength(corridor.points);
          if (Math.abs(area - 2 * corridor.halfWidth * length) > 0.2 * area) {
            fault(`${where} claims ${area.toFixed(0)} m², not the ${(2 * corridor.halfWidth * length).toFixed(0)} m² of its strip`);
          }
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
        expect(complaint, `seed ${seed}`).toBeUndefined();
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
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };
        if (footprint.regions.length === 0) fault('claims no ground at all');
        let holes = 0;
        for (let i = 0; i < footprint.regions.length; i++) {
          const region = footprint.regions[i] as Region;
          const where = `piece ${i}`;
          if (region.outer.length < 3) fault(`${where} has no outline`);
          if (ringArea(region.outer) <= 0) fault(`${where} is wound the wrong way`);
          for (const hole of region.holes) {
            if (hole.length < 3) fault(`${where} has a hole with no outline`);
            if (ringArea(hole) >= 0) fault(`${where} has a hole wound the wrong way`);
            if (!pointInRing(hole[0] as Point, region.outer)) fault(`${where} has a hole outside it`);
            holes++;
          }
        }
        // The network is one connected thing (see the test above), so it encloses
        // every block of the city between its roads.
        if (holes < 20) fault(`encloses only ${holes} blocks`);
        const share = footprint.area / landArea(w);
        if (share <= MIN_FOOTPRINT_SHARE || share >= MAX_FOOTPRINT_SHARE) {
          fault(`claims ${(share * 100).toFixed(1)} % of the dry land`);
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
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
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };
        // Point in polygon costs a walk of the whole outline, so this samples the
        // network rather than walking every one of its hundred thousand segments.
        let step = 0;
        for (const road of w.roads) {
          for (let i = 0; i + 1 < road.points.length; i++) {
            if (step++ % SAMPLE_STRIDE !== 0) continue;
            const a = road.points[i] as Point;
            const b = road.points[i + 1] as Point;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const where = `${road.tier} ${road.id} segment ${i}`;
            if (road.tunnels.includes(i)) continue;
            if (road.bridges.includes(i)) {
              // A deck over land has the corridor under it, which is claimed; a
              // deck over water stands over no ground at all.
              if (wetFraction(hf, a, b, w.water.seaLevel) > 0.5 && pointInRegions(mid, regions)) {
                fault(`${where} claims the water it bridges`);
              }
              continue;
            }
            if (!pointInRegions(mid, regions)) fault(`${where} is on the ground but claims none`);
          }
        }
        const grid = new PointGrid(w.size, 40, w.roads);
        for (const p of landPoints(w, CLEAR_SAMPLES, 0xf007)) {
          if (grid.nearest(p.x, p.y) < CLEAR_OF_ROADS) continue;
          if (pointInRegions(p, regions)) fault(`claims ground ${CLEAR_OF_ROADS} m clear of every road`);
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
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
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };

        let step = 0;
        for (const road of w.roads) {
          for (let i = 0; i + 1 < road.points.length; i++) {
            if (step++ % SAMPLE_STRIDE !== 0) continue;
            if (road.tunnels.includes(i) || road.bridges.includes(i)) continue;
            const a = road.points[i] as Point;
            const b = road.points[i + 1] as Point;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const surface = surfaces.at(mid.x, mid.y);
            const where = `${road.tier} ${road.id} segment ${i}`;
            if (surface !== 'asphalt' && surface !== 'dirt') fault(`${where} is ${surface}, not a road`);
            // A dirt road reads as dirt unless a paved road runs close enough to
            // claim the same ground, which is what a made-up junction is.
            if (road.tier === 'dirt' && surface !== 'dirt' && paved.nearest(mid.x, mid.y) > PAVED_CLEAR) {
              fault(`${where} is ${surface} with no paved road within ${PAVED_CLEAR} m`);
            }
          }
        }

        // The index is a bucket grid over the segments, so a few places are asked
        // the slow and obvious way as well: every segment of every road measured,
        // then every beach. The two have to agree exactly.
        if (byHand.includes(seed)) {
          for (const p of landPoints(w, BY_HAND_SAMPLES, 0x5a4d)) {
            const want = surfaceByHand(w, p.x, p.y);
            const got = surfaces.at(p.x, p.y);
            if (got !== want) fault(`${p.x.toFixed(1)},${p.y.toFixed(1)} reads as ${got} and measures as ${want}`);
          }
        }

        // The sand of a beach is sand, or the road that crosses it: a resort's
        // boardwalk, an island link and a seafront road all may, and the road
        // claims the ground where they do. What it is never is open ground.
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

        // A session starts on the nearest road to the core, and every world has one.
        const place = nearestRoadPlace(w, w.core.x, w.core.y);
        if (place === undefined) fault('no road for a car to start on');
        else if (surfaces.at(place.x, place.y) === 'ground') fault('the nearest road place is not on a road');

        expect(complaint, `seed ${seed}`).toBeUndefined();
      }
    });
  });
}
