import { describe, expect, it } from 'vitest';
import { Vector3, type BufferAttribute } from 'three';
import { buildChunkBuildings, buildingLookup, buildingVertices, standingGround } from '../src/render/building-mesh.ts';
import { CHUNK_DRAW_CALL_CAP, CHUNK_VERTEX_CAP, chunkDrawCalls } from '../src/render/chunk-cost.ts';
import type { ChunkDetail } from '../src/render/streaming.ts';
import { LAMP_BY_TIER, lampsIn } from '../src/render/lamp-mesh.ts';
import { buildChunkRoads, partsOf, roadSection, structureSection, type SectionPoint } from '../src/render/road-mesh.ts';
import { pointInRegions, regionArea } from '../src/core/geom.ts';
import { ChunkSource, chunkBounds, CHUNK_SIZE, type ChunkParcel, type WorldChunk } from '../src/world/chunks.ts';
import { buildCarve } from '../src/world/carve.ts';
import { buildRoadGraph } from '../src/world/graph.ts';
import { buildJunctions } from '../src/world/junctions.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { type Parcel } from '../src/world/parcels.ts';
import { MITRE_SHIFT, RoadRibbons } from '../src/world/ribbon.ts';
import { footprintHalfWidth, TIERS } from '../src/world/tiers.ts';
import { type Point, type RoadCurve, type WorldDescription } from '../src/world/types.ts';
import { mixFor, MAX_PLANT_RADIUS, PLANT_RADIUS, Vegetation, type Plant } from '../src/world/vegetation.ts';
import { pointInRing, ringArea, sideReach, stableJson } from './helpers.ts';
import { type WorldParts } from './world-pool.ts';
import {
  FOOTPRINT_COUNT,
  CHUNK_BLOCK,
  ROAD_MESH_CHUNKS,
  BEYOND_MAP,
  ISOLATED_COUNT,
  BUILDING_MESH_COUNT,
  CHUNK_SAMPLES,
  VEGETATION_CHUNKS,
  VEGETATION_SAMPLES,
  CANOPY_POINTS,
  MIN_PLANTS,
  VEGETATION_COUNT,
  CUT_SLACK,
  BOUNDARY_SLACK,
  WALL_REACH,
} from './seed-limits.ts';
import { ParcelIndex } from './seed-index.ts';
import { chunkKeys, handovers, perimeterOf, insideBounds, distanceToBoundary, quadOf } from './seed-probes.ts';
import {
  seeds,
  worlds,
  repeats,
  parcelsOf,
  repeatParts,
  sourceOf,
  chunkOf,
  junctionsOf,
  carveOf,
  buildingsOf,
} from './seed-fixture.ts';

/**
 * The seed sweep of spec section 3, on the chunks a world is cut into, and the
 * meshes built from one.
 *
 * `seed-sweep.test.ts` declares these inside the one suite that generates the
 * worlds; a file of its own would generate them all again.
 */
export function chunkChecks(): void {
  describe('chunks', () => {
    it('cuts a block of chunks around the origin and a handful far from it', () => {
      // Spec section 9.1: a chunk holds the roads, the parcels and the heights
      // inside it, cut from the whole-map skeleton. Every metre of a curve and
      // every square metre of a parcel belongs to exactly one chunk, and two
      // neighbours meet on the same heights and hand a road over at one place.
      for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
        const w = worlds.get(seed) as WorldDescription;
        const parcels = parcelsOf(seed).parcels;
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };

        const cut = new Map<string, WorldChunk>();
        for (const [cx, cy] of chunkKeys()) {
          const chunk = chunkOf(seed, cx, cy);
          cut.set(`${cx}:${cy}`, chunk);
          const where = `chunk ${cx}, ${cy}`;
          if (chunk.seed !== seed) fault(`${where} carries seed ${chunk.seed}`);
          if (stableJson(chunk.bounds) !== stableJson(chunkBounds(cx, cy))) fault(`${where} covers the wrong ground`);
          if (chunk.terrain.heights.length !== chunk.terrain.gridSize ** 2) fault(`${where} is missing heights`);
          if (chunk.terrain.originX !== chunk.bounds.minX) fault(`${where} samples its heights from elsewhere`);

          for (const run of chunk.roads) {
            const road = w.roads[run.curve] as RoadCurve;
            const name = `${where}: run of ${road.tier} ${road.id}`;
            if (run.points.length < 2) fault(`${name} is a single point`);
            if (run.tier !== road.tier) fault(`${name} changes tier`);
            if (!insideBounds(run.points, chunk, CUT_SLACK)) fault(`${name} leaves the chunk`);
            // The run is the curve where it stands inside the chunk: only the
            // ends of it are cut, and the points between them are the curve's own.
            for (let k = 1; k + 1 < run.points.length; k++) {
              const mine = run.points[k] as Point;
              const theirs = road.points[run.from + k] as Point;
              if (theirs === undefined || mine.x !== theirs.x || mine.y !== theirs.y) fault(`${name} strays off it`);
            }
            for (let k = 0; k + 1 < run.points.length; k++) {
              const segment = run.from + k;
              if (run.bridges.includes(k) !== road.bridges.includes(segment)) fault(`${name} disagrees about its decks`);
              if (run.tunnels.includes(k) !== road.tunnels.includes(segment)) fault(`${name} disagrees about its bores`);
            }
          }

          for (const piece of chunk.parcels) {
            const parcel = parcels[piece.parcel] as Parcel | undefined;
            const name = `${where}: piece of parcel ${piece.parcel}`;
            if (parcel === undefined) {
              fault(`${name}, which does not exist`);
              continue;
            }
            if (piece.owner !== parcel.owner || piece.zone !== parcel.zone) fault(`${name} disowns it`);
            if (piece.district !== parcel.district) fault(`${name} stands in another district`);
            if (Math.abs(piece.area - regionArea(piece.region)) > 1e-6) fault(`${name} misreports its ground`);
            if (piece.area > parcel.area + CUT_SLACK * perimeterOf(piece.region)) fault(`${name} is bigger than the parcel`);
            if (ringArea(piece.region.outer) <= 0) fault(`${name} is wound the wrong way`);
            if (!insideBounds(piece.region.outer, chunk, CUT_SLACK)) fault(`${name} leaves the chunk`);
          }
        }

        const home = cut.get('0:0') as WorldChunk;
        if (home.roads.length === 0) fault('cuts no road into the chunk on the core');
        const far = cut.get(`${BEYOND_MAP[0]}:${BEYOND_MAP[1]}`) as WorldChunk;
        if (far.roads.length > 0 || far.parcels.length > 0) fault('finds a city past the edge of the map');

        // Two neighbours share an edge: the same heights along it, and the same
        // places where a road crosses it.
        for (let cx = -CHUNK_BLOCK; cx <= CHUNK_BLOCK; cx++) {
          for (let cy = -CHUNK_BLOCK; cy <= CHUNK_BLOCK; cy++) {
            const here = cut.get(`${cx}:${cy}`) as WorldChunk;
            const east = cut.get(`${cx + 1}:${cy}`);
            if (east === undefined) continue;
            const mine = new Heightfield(here.terrain);
            const theirs = new Heightfield(east.terrain);
            for (let iy = 0; iy < mine.gridSize; iy++) {
              if (theirs.at(0, iy) !== mine.at(mine.gridSize - 1, iy)) fault(`chunks ${cx} and ${cx + 1} disagree about the ground between them`);
            }
            const handed = handovers(here, w.roads, 'x', here.bounds.maxX);
            const taken = handovers(east, w.roads, 'x', east.bounds.minX);
            if (handed.join('|') !== taken.join('|')) fault(`chunk ${cx}, ${cy} hands a road over to ${cx + 1}, ${cy} nowhere it is taken`);
          }
        }

        // A place in the block belongs to the parcel the whole map gives it, cut
        // to the chunk that covers it and to no other.
        const index = new ParcelIndex(parcels);
        const step = ((2 * CHUNK_BLOCK + 1) * CHUNK_SIZE) / CHUNK_SAMPLES;
        const corner = -CHUNK_BLOCK * CHUNK_SIZE;
        for (let ix = 0; ix < CHUNK_SAMPLES; ix++) {
          for (let iy = 0; iy < CHUNK_SAMPLES; iy++) {
            const p = { x: corner + (ix + 0.5) * step, y: corner + (iy + 0.5) * step };
            const chunk = cut.get(`${Math.floor(p.x / CHUNK_SIZE)}:${Math.floor(p.y / CHUNK_SIZE)}`) as WorldChunk;
            const claims = chunk.parcels.filter((piece: ChunkParcel) => pointInRegions(p, [piece.region]));
            if (claims.length > 1) fault(`two pieces of chunk ${chunk.cx}, ${chunk.cy} claim the same ground`);
            const whole = index.at(p);
            if (claims.map((piece) => piece.parcel).join(',') === whole.join(',')) continue;
            // A place beside the edge of a parcel may fall on either side of it,
            // because the cut moves that edge by a fraction of a millimetre. Only
            // a place well inside or well outside the parcel says anything.
            const edge = Math.min(
              ...claims.map((piece) => distanceToBoundary(p, piece.region)),
              ...whole.map((id) => distanceToBoundary(p, (parcels[id] as Parcel).region)),
            );
            if (edge > BOUNDARY_SLACK) {
              fault(`chunk ${chunk.cx}, ${chunk.cy} gives ground the map gives to parcel ${whole.join(' and ') || 'nothing'}`);
            }
          }
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
      }
    });

    it('lofts the roads of a chunk inside the draw-call cap', () => {
      // Spec sections 9.2 and 10.2: a chunk's roads are batched by tier, so a
      // chunk costs a small fixed number of draws however many roads run through
      // it. The geometry itself is built on the chunks around the core, where the
      // tiers, the bends and the structures all appear, because a loft that comes
      // out inside out or full of NaN only shows on real ground.
      for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
        const w = worlds.get(seed) as WorldDescription;
        const ribbons = new RoadRibbons(w.terrain, w.roads, junctionsOf(seed));
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };

        for (const [cx, cy] of chunkKeys()) {
          const calls = chunkDrawCalls(chunkOf(seed, cx, cy));
          if (calls > CHUNK_DRAW_CALL_CAP) fault(`chunk ${cx}, ${cy} costs ${calls} draw calls`);
        }

        let carriageways = 0;
        for (const [cx, cy] of ROAD_MESH_CHUNKS) {
          const chunk = chunkOf(seed, cx, cy);
          for (const tier of buildChunkRoads(chunk, ribbons, (x, y, tier) => carveOf(seed).surfaceAt(x, y, tier))) {
            const where = `chunk ${cx}, ${cy}: ${tier.tier}`;
            for (const part of partsOf(tier)) {
              const position = part.getAttribute('position');
              const normal = part.getAttribute('normal');
              for (let v = 0; v < position.count; v++) {
                if (!Number.isFinite(position.getX(v) + position.getY(v) + position.getZ(v))) {
                  fault(`${where} places a vertex nowhere`);
                }
                const length = Math.hypot(normal.getX(v), normal.getY(v), normal.getZ(v));
                // A vertex two faces that cancel meet at has no normal at all;
                // everywhere else the normal is a unit vector.
                if (length > 1e-3 && Math.abs(length - 1) > 1e-3) fault(`${where} leaves a normal of ${length}`);
              }
            }
            // The carriageway is the span between the two kerbs, and it is lofted
            // face up: the camera looks down on a road, never through it. The
            // column it starts at is the last one at the left kerb, because a
            // deck of a tier with a pavement stands a kerb face there first. A
            // surface on the ground starts at the kerb, and one on a structure
            // at the outer edge of the whole section.
            const half = -TIERS[tier.tier].width / 2;
            for (const { surfaces } of tier.runs) {
              for (const surface of surfaces) {
                const ground = surface.getAttribute('across').getX(0) === half;
                const section = ground ? roadSection(tier.tier) : structureSection(tier.tier);
                let kerb = 0;
                for (let i = 0; i < section.length; i++) if ((section[i] as SectionPoint).across === half) kerb = i;
                const rows = surface.getAttribute('position').count / section.length;
                for (let row = 0; row + 1 < rows; row++) {
                  const quad = quadOf(surface, section.length, row, kerb);
                  // A mitre moves a corner along the road by up to MITRE_SHIFT,
                  // so a quad shorter than that can reach past itself. A chunk
                  // boundary leaves one wherever it cuts a segment just short of
                  // a bend, and a sliver that size is below anything the camera
                  // resolves.
                  if (quad.along <= MITRE_SHIFT) continue;
                  if (quad.up) carriageways++;
                  else fault(`${where} lofts a carriageway the camera looks through`);
                }
              }
            }
            for (let i = 0; i < tier.markings.length; i++) {
              if (!Number.isFinite(tier.markings[i] as number)) fault(`${where} paints a line nowhere`);
            }
            for (const part of partsOf(tier)) part.dispose();
          }
        }
        if (carriageways === 0) fault('carries no carriageway at all');
        expect(complaint, `seed ${seed}`).toBeUndefined();
      }
    });

    it('lights the streets of a chunk once each, on the verge of the road they stand beside', () => {
      // Spec sections 10.5 and 13.4: a lamp is placed from the curve alone, at a
      // whole multiple of its tier's spacing from the start of it. So two chunks
      // that share a road place the same lamps and neither places one twice,
      // whichever of them the run was cut into.
      for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
        const w = worlds.get(seed) as WorldDescription;
        const ribbons = new RoadRibbons(w.terrain, w.roads, junctionsOf(seed));
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };

        const seen = new Set<string>();
        let lit = 0;
        for (const [cx, cy] of chunkKeys()) {
          const chunk = chunkOf(seed, cx, cy);
          for (const lamp of lampsIn(chunk, ribbons)) {
            lit++;
            const where = `${lamp.tier} lamp at ${lamp.x.toFixed(1)}, ${lamp.y.toFixed(1)}`;
            if (LAMP_BY_TIER[lamp.tier] === undefined) fault(`${where} stands on an unlit tier`);
            if (!Number.isFinite(lamp.height + lamp.headHeight + lamp.roadHeight)) {
              fault(`${where} stands nowhere`);
            }
            // The mast stands on the verge of its own road: off the carriageway,
            // and inside the ground that road claims.
            const across = Math.hypot(lamp.x - lamp.roadX, lamp.y - lamp.roadY);
            if (across <= TIERS[lamp.tier].width / 2) fault(`${where} stands on the carriageway`);
            if (across > footprintHalfWidth(lamp.tier)) fault(`${where} stands off the ground the road claims`);
            // The arm reaches toward the road, so the lantern hangs nearer its
            // middle than the mast stands.
            const head = Math.hypot(lamp.headX - lamp.roadX, lamp.headY - lamp.roadY);
            if (head >= across) fault(`${where} reaches its arm away from the road`);
            if (lamp.headHeight <= lamp.height) fault(`${where} hangs its lantern below its own foot`);

            const key = `${lamp.x.toFixed(3)},${lamp.y.toFixed(3)}`;
            if (seen.has(key)) fault(`${where} is placed twice`);
            seen.add(key);
            if (complaint !== undefined) break;
          }
          if (complaint !== undefined) break;
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
        expect(lit, `seed ${seed}`).toBeGreaterThan(0);
      }
    });

    it('builds every building of a chunk on its own lot, inside the vertex cap of each detail', () => {
      // Spec section 10.3: a building stands on the ground its lot claims and
      // never on the road beside it. The lot is already inside the parcel and the
      // parcel is what the road footprint left, so this is the last link of the
      // chain — and the one that is fitted rather than laid out, because a
      // generated facade overhangs whatever footprint it is given. Where the lot
      // shares a side edge the ground past it carries the neighbour's wall, so
      // the question is `standingGround` and not the lot alone.
      for (const seed of seeds.slice(0, BUILDING_MESH_COUNT)) {
        const w = worlds.get(seed) as WorldDescription;
        const source = sourceOf(seed);
        const lookup = buildingLookup(w, source.layers);
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };
        let built = 0;
        // One chunk of the core is enough: it is where the towers stand, and
        // building the geometry of a whole map would cost more than the world.
        const [cx, cy] = ROAD_MESH_CHUNKS[0] as [number, number];
        // Spec section 9.2: each detail of the building LOD costs a fraction of
        // the one before it, and none passes its cap.
        const vertices: Record<ChunkDetail, number> = { near: 0, mid: 0, far: 0 };
        for (const detail of ['near', 'mid', 'far'] as const) {
          const placements = buildChunkBuildings(chunkOf(seed, cx, cy), lookup, detail);
          vertices[detail] = buildingVertices(placements);
          if (vertices[detail] > CHUNK_VERTEX_CAP[detail]) {
            fault(`chunk ${cx}, ${cy} costs ${vertices[detail]} vertices at ${detail} detail`);
          }
          for (const one of placements) {
            if (detail === 'near') built++;
            const where = `${one.building.kind} ${one.building.id} at ${detail} detail`;
            const position = one.shell.getAttribute('position');
            const at = new Vector3();
            for (let v = 0; v < position.count; v++) {
              at.fromBufferAttribute(position as BufferAttribute, v).applyMatrix4(one.matrix);
              if (!Number.isFinite(at.x + at.y + at.z)) fault(`${where} places a vertex nowhere`);
              else if (!pointInRing({ x: at.x, y: at.z }, standingGround(one.building)))
                fault(`${where} stands off its lot`);
              if (complaint !== undefined) break;
            }
            // A block fills its massing, so at mid detail every wall a lot shares
            // stands on that edge from its front to its back, however the edge
            // leans. A generated facade is measured at its widest instead.
            for (const side of detail === 'mid' ? (['left', 'right'] as const) : []) {
              if (!one.building.shared[side]) continue;
              const reach = sideReach(one.building.lot, side, (visit) => {
                for (let v = 0; v < position.count; v++) {
                  at.fromBufferAttribute(position as BufferAttribute, v).applyMatrix4(one.matrix);
                  visit({ x: at.x, y: at.z });
                }
              });
              if (Math.min(reach.front, reach.back) < -WALL_REACH) fault(`${where} stops short of its ${side} wall`);
            }
            one.shell.dispose();
            one.hull.dispose();
            if (complaint !== undefined) break;
          }
        }
        if (vertices.mid * 10 > vertices.near) fault(`mid detail costs ${vertices.mid} of ${vertices.near} vertices`);
        if (vertices.far * 4 > vertices.mid) fault(`far detail costs ${vertices.far} of ${vertices.mid} vertices`);
        expect(complaint, `seed ${seed}`).toBeUndefined();
        expect(built, `seed ${seed}`).toBeGreaterThan(0);
      }
    });

    it('plants every chunk on the ground its parcels leave, off the roads and off the lots', () => {
      // Spec section 10.4: placement is by parcel polygon, so no plant reaches
      // over a road or over a building. The whole rim of a canopy is checked, not
      // just the point the plant stands on, because it is the canopy that
      // overhangs and the trunk never does.
      for (const seed of seeds.slice(0, VEGETATION_COUNT)) {
        const parcels = parcelsOf(seed).parcels;
        const index = new ParcelIndex(parcels);
        const lots = new Map<number, Point[][]>();
        for (const building of buildingsOf(seed).buildings) {
          const here = lots.get(building.parcel);
          if (here === undefined) lots.set(building.parcel, [building.lot]);
          else here.push(building.lot);
        }
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };
        let planted = 0;
        for (const [cx, cy] of VEGETATION_CHUNKS) {
          const chunk = chunkOf(seed, cx, cy);
          planted += chunk.plants.length;
          for (const plant of chunk.plants) {
            const where = `${plant.species} at ${plant.at.x.toFixed(1)}, ${plant.at.y.toFixed(1)}`;
            const bounds = chunk.bounds;
            if (plant.at.x < bounds.minX || plant.at.x >= bounds.maxX || plant.at.y < bounds.minY || plant.at.y >= bounds.maxY) {
              fault(`${where} stands outside the chunk that carries it`);
            }
            if (plant.radius !== PLANT_RADIUS[plant.species]) fault(`${where} claims ${plant.radius} m of canopy`);
            if (plant.radius > MAX_PLANT_RADIUS) fault(`${where} claims more canopy than a cell has room for`);
            const parcel = parcels[plant.parcel];
            if (parcel === undefined) {
              fault(`${where} stands on parcel ${plant.parcel}, which does not exist`);
              break;
            }
            const mix = mixFor(parcel.owner, parcel.zone);
            if (mix === undefined) fault(`${where} stands on a ${parcel.owner} parcel, which plants nothing`);
            else if (!mix.species.some((entry) => entry.kind === plant.species)) {
              fault(`${where} is not planted in the ${parcel.zone} on a ${parcel.owner} parcel`);
            }
            if (complaint !== undefined) break;
          }

          // The whole canopy of a sample of them: every point of the rim stands
          // on the same parcel, and none of it over a lot of that parcel.
          const step = Math.max(1, Math.floor(chunk.plants.length / VEGETATION_SAMPLES));
          for (let i = 0; i < chunk.plants.length && complaint === undefined; i += step) {
            const plant = chunk.plants[i] as Plant;
            const where = `${plant.species} at ${plant.at.x.toFixed(1)}, ${plant.at.y.toFixed(1)}`;
            // The rim is pulled in by the slack the cut allows, so a canopy that
            // ends exactly on the boundary is not read as crossing it.
            const reach = plant.radius - BOUNDARY_SLACK;
            for (let k = 0; k < CANOPY_POINTS; k++) {
              const angle = (k / CANOPY_POINTS) * Math.PI * 2;
              const at = { x: plant.at.x + Math.cos(angle) * reach, y: plant.at.y + Math.sin(angle) * reach };
              if (!index.at(at).includes(plant.parcel)) fault(`${where} reaches off its own parcel`);
              for (const lot of lots.get(plant.parcel) ?? []) {
                if (pointInRing(at, lot)) fault(`${where} reaches over a building on its parcel`);
              }
              if (complaint !== undefined) break;
            }
          }

          // No two canopies share any ground. `vegetation.ts` makes that
          // unrepresentable; this is the check on a whole map of it.
          for (let i = 0; i < chunk.plants.length && complaint === undefined; i++) {
            for (let j = i + 1; j < chunk.plants.length; j++) {
              const a = chunk.plants[i] as Plant;
              const b = chunk.plants[j] as Plant;
              const apart = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
              if (apart + 1e-9 < a.radius + b.radius) {
                fault(`two canopies overlap at ${a.at.x.toFixed(1)}, ${a.at.y.toFixed(1)}`);
                break;
              }
            }
          }
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
        expect(planted, `seed ${seed}`).toBeGreaterThan(MIN_PLANTS);
      }
    });

    it('cuts a chunk in isolation exactly as it cuts it with every neighbour loaded', () => {
      // Spec section 3 and section 9.1: a chunk is the same whether it is cut on
      // its own or after the whole block around it. The loaded side is the
      // block the fixture already cut, in order. The isolated side stands on a
      // world the pool generated a second time and on the layers that worker
      // built for it, so this is the byte-identical check of a chunk as well.
      for (const seed of seeds.slice(0, ISOLATED_COUNT)) {
        for (const [cx, cy] of chunkKeys()) chunkOf(seed, cx, cy);
        const world = repeats.get(seed) as WorldDescription;
        const parts = repeatParts.get(seed) as WorldParts;
        const aloneGraph = buildRoadGraph(world.roads);
        const aloneJunctions = buildJunctions(world.roads, aloneGraph);
        const aloneBuildings = parts.buildings;
        const alone = new ChunkSource(world, {
          graph: aloneGraph,
          junctions: aloneJunctions,
          footprint: parts.footprint,
          parcels: parts.parcels,
          buildings: aloneBuildings,
          carve: buildCarve(world.terrain, world.roads, aloneJunctions),
          vegetation: new Vegetation(world.seed, parts.parcels, aloneBuildings),
        });
        // The far chunk first, before this source has cut anything at all.
        for (const [cx, cy] of [...chunkKeys()].reverse()) {
          expect(stableJson(alone.chunk(cx, cy)), `seed ${seed}: chunk ${cx}, ${cy}`).toBe(
            stableJson(chunkOf(seed, cx, cy)),
          );
        }
      }
    });
  });
}
