/**
 * A row of made-up buildings on flat ground, for the tests about the things
 * hung on a building that is already standing: the harm-reduction posters of
 * spec section 19 and the advertising of spec section 13.1.
 *
 * Nothing here generates a world. The buildings stand in a line 40 m apart,
 * each with its own seed and neither side wall shared, so a test reads one
 * placement rule at a time rather than a whole city.
 */
import { Vector3, type BufferAttribute } from 'three';
import type { Point } from '../src/core/geom.ts';
import { buildChunkBuildings, type BuildingLookup, type BuildingPlacement } from '../src/render/building-mesh.ts';
import type { Building, BuildingKind } from '../src/world/buildings.ts';
import { chunkBounds, CHUNK_SIZE, type WorldChunk } from '../src/world/chunks.ts';
import type { Culture, District, Zone } from '../src/world/types.ts';

/** The flat ground the made-up chunks below stand on. */
export const GROUND = 8;

export function districtOf(zone: Zone, wealth: number, culture: Culture = 'none', density = 0.5): District {
  return { id: 0, name: zone, zone, x: 0, y: 0, density, wealth, culture };
}

/** A lot as `buildings.ts` lays one: the two front corners first, then the back two. */
export function lotOf(front: Point, width: number, depth: number, facing: number): Point[] {
  const n = { x: -Math.cos(facing), y: -Math.sin(facing) };
  const t = { x: n.y, y: -n.x };
  const f0 = { x: front.x - (t.x * width) / 2, y: front.y - (t.y * width) / 2 };
  const f1 = { x: front.x + (t.x * width) / 2, y: front.y + (t.y * width) / 2 };
  return [f0, f1, { x: f1.x + n.x * depth, y: f1.y + n.y * depth }, { x: f0.x + n.x * depth, y: f0.y + n.y * depth }];
}

export function buildingOf(id: number, kind: BuildingKind, seed: number): Building {
  const facing = -Math.PI / 2;
  const front = { x: id * 40, y: 0 };
  const width = 26;
  const depth = 24;
  return {
    id,
    parcel: 0,
    kind,
    seed,
    lot: lotOf(front, width, depth, facing),
    area: width * depth,
    width,
    depth,
    front,
    facing,
    road: 0,
    district: 0,
    zone: 'inner',
    // Low, so a mid-rise is a few storeys and the test is not spent generating
    // a hundred metres of facade.
    skyline: 0,
    // A lot with nothing against either side, so the shell keeps its margins.
    shared: { left: false, right: false },
  };
}

export function chunkOf(buildings: Building[]): WorldChunk {
  return {
    seed: 1,
    cx: 0,
    cy: 0,
    bounds: chunkBounds(0, 0),
    terrain: { gridSize: 2, cellSize: CHUNK_SIZE, originX: 0, originY: 0, heights: new Float32Array(4).fill(GROUND) },
    seaLevel: 0,
    roads: [],
    junctions: [],
    pavement: [],
    parcels: [],
    buildings,
    plants: [],
    piers: [],
    tram: [],
    tramCrossings: [],
  };
}

export function lookupOf(district: District): BuildingLookup {
  return { heightAt: () => GROUND, districtOf: () => district, chamferOf: () => 0 };
}

/** A row of buildings of one kind, each with its own seed, placed on flat ground. */
export function placedRow(kind: BuildingKind, district: District, count: number): BuildingPlacement[] {
  const buildings: Building[] = [];
  for (let i = 0; i < count; i++) buildings.push(buildingOf(i, kind, 1000 + i * 7919));
  return buildChunkBuildings(chunkOf(buildings), lookupOf(district));
}

/** Whether something hangs on this building, by the frontage it stands on. */
export function sameFront(placed: BuildingPlacement, at: { x: number; y: number }): boolean {
  return Math.hypot(placed.building.front.x - at.x, placed.building.front.y - at.y) < placed.building.width;
}

/** The height of the top of the built shell, in the world. */
export function wallTop(placed: BuildingPlacement): number {
  const position = placed.shell.getAttribute('position');
  const at = new Vector3();
  let top = -Infinity;
  for (let v = 0; v < position.count; v++) {
    top = Math.max(top, at.fromBufferAttribute(position as BufferAttribute, v).applyMatrix4(placed.matrix).y);
  }
  return top;
}

/** How far the built shell reaches past the front edge of its lot, in metres. */
export function frontReach(placed: BuildingPlacement): number {
  const position = placed.shell.getAttribute('position');
  const facing = placed.building.facing;
  const front = placed.building.front;
  const at = new Vector3();
  let reach = -Infinity;
  for (let v = 0; v < position.count; v++) {
    at.fromBufferAttribute(position as BufferAttribute, v).applyMatrix4(placed.matrix);
    reach = Math.max(reach, (at.x - front.x) * Math.cos(facing) + (at.z - front.y) * Math.sin(facing));
  }
  return reach;
}
