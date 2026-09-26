import { expect, it } from 'vitest';
import { pointInRegion, pointInRegions, regionArea } from '../../src/core/geom.ts';
import { hypot } from '../../src/core/libm.ts';
import { ENTRANCE_REACH } from '../../src/sim/transit/metro.ts';
import {
  FRONT_REACH,
  lotMiddle,
  MAX_LOT_FALL,
  MIN_LOT_AREA,
  ZONE_BUILDINGS,
  ZONE_LOTS,
  type Building,
  type BuildingKind,
} from '../../src/world/city/buildings.ts';
import { layoutZones, skylineAt } from '../../src/world/terrain/districts.ts';
import { type RoadFootprint } from '../../src/world/city/footprint.ts';
import { type RoadEdge, type RoadGraph } from '../../src/world/roads/graph.ts';
import { Heightfield } from '../../src/world/terrain/heightfield.ts';
import { metroDistricts, metroEntrances } from '../../src/world/transit/metro.ts';
import { ownerMaxArea, type Parcel, type ParcelMap } from '../../src/world/city/parcels.ts';
import { dryDeckLines } from '../../src/world/decks/piers.ts';
import { nearestRoadSpot } from '../../src/world/terrain/surface.ts';
import { footprintHalfWidth, TIERS } from '../../src/world/roads/tiers.ts';
import { type Point, type WorldDescription, type Zone } from '../../src/world/types.ts';
import { landPoints, pointInRing, ringArea, ringsOverlap, sharedArea } from '../support/helpers.ts';
import {
  FOOTPRINT_COUNT,
  SAMPLE_STRIDE,
  PARCEL_SAMPLES,
  MIN_PARCELS,
  MAX_UNREACHED_SHARE,
  ASSIGNED_OWNERS,
  MIN_BUILDINGS,
  SIGNATURE_KIND,
  MIN_SIGNATURE_SHARE,
  MIN_KIND_SAMPLES,
  FRONT_SLACK,
  FRONT_DRIFT,
  FACING_DRIFT,
  SHARED_LOT_AREA,
  MIN_WALLED_SHARE,
  MIN_CORE_BUILT_SHARE,
  MIN_TOWER_SKYLINE_LEAD,
} from './seed-limits.ts';
import { ParcelIndex } from './seed-index.ts';
import { distanceToLine, middleOf } from './seed-probes.ts';
import { seeds, worlds, footprintOf, parcelsOf, buildingsOf, graphOf } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/** Records the first fault a check finds. */
type Fault = (text: string) => void;
type PoliceStation = ParcelMap['stations'][number];
type MetroStation = ParcelMap['metro'][number];
/** Lots of an attached zone, and how many of them share a wall. */
type WallTally = { of: number; walled: number };
/** How many buildings of each kind every zone laid. */
type KindTally = Record<Zone, Partial<Record<BuildingKind, number>>>;
/** The summed skyline of the inner towers and mid-rise blocks, and their counts. */
type SkylineLead = { tower: number; towers: number; midRise: number; midRises: number };
/** What a building is checked against. */
type Lay = { w: WorldDescription; graph: RoadGraph; parcels: Parcel[]; terrain: Heightfield };

/** A parcel's outer ring winds forward, and each hole winds back and lies inside it. */
function checkParcelRings(parcel: Parcel, where: string, fault: Fault): void {
  if (ringArea(parcel.region.outer) <= 0) fault(`${where} is wound the wrong way`);
  for (const hole of parcel.region.holes) {
    if (ringArea(hole) >= 0) fault(`${where} has a hole wound the wrong way`);
    if (!pointInRing(hole[0] as Point, parcel.region.outer)) fault(`${where} has a hole outside it`);
  }
}

/** Every parcel has a road along it: ground no road reaches is not a parcel. */
function checkParcelRoads(parcel: Parcel, where: string, graph: RoadGraph, fault: Fault): void {
  if (parcel.roads.length === 0) fault(`${where} stands on no road`);
  for (let k = 0; k < parcel.roads.length; k++) {
    const edge = parcel.roads[k] as number;
    if (graph.edges[edge] === undefined) fault(`${where} names edge ${edge}, which does not exist`);
    if (k > 0 && edge <= (parcel.roads[k - 1] as number)) fault(`${where} lists its roads out of order`);
  }
}

function checkParcel(parcel: Parcel, i: number, w: WorldDescription, graph: RoadGraph, fault: Fault): void {
  const where = `parcel ${i}`;
  if (parcel.id !== i) fault(`${where} is numbered ${parcel.id}`);
  if (!ASSIGNED_OWNERS.has(parcel.owner)) fault(`${where} is owned by a ${parcel.owner}`);
  // An owner comes in a size: a car park is the size of a car park in
  // every zone, however much ground the roads there leave.
  const most = ownerMaxArea(parcel.zone, parcel.owner);
  if (most !== undefined && parcel.area > most) {
    fault(`${where} is a ${parcel.owner} of ${parcel.area.toFixed(0)} m² in the ${parcel.zone}, over its ${most} m²`);
  }
  if (Math.abs(parcel.area - regionArea(parcel.region)) > 1e-6) fault(`${where} misreports its ground`);
  if (parcel.area <= 0) fault(`${where} owns no ground`);
  checkParcelRings(parcel, where, fault);
  if (w.districts[parcel.district] === undefined) fault(`${where} is in district ${parcel.district}, which does not exist`);
  checkParcelRoads(parcel, where, graph, fault);
}

/**
 * Nothing stands on anything else. Point in polygon over every parcel is too
 * dear to run over the whole map, so this asks about a spread of places: this
 * helper the open ground, the ones after it the roads and the corridors.
 */
function checkLandSamples(w: WorldDescription, parcels: Parcel[], index: ParcelIndex, footprint: RoadFootprint, fault: Fault): void {
  const decks = w.corridors.filter((corridor) => corridor.kind === 'elevated');
  for (const p of landPoints(w, PARCEL_SAMPLES, 0x9a4c)) {
    const owners = index.at(p);
    if (owners.length > 1) fault(`parcels ${owners.join(' and ')} both claim the same ground`);
    if (owners.length === 1 && pointInRegions(p, footprint.regions)) {
      fault(`parcel ${owners[0] as number} stands on the ground the roads claim`);
    }
    // Spec section 6.3: the ground under a deck is the one place an
    // under-structure parcel stands.
    const owner = owners.length === 1 ? (parcels[owners[0] as number] as Parcel).owner : undefined;
    if (owner === 'under-structure' && !decks.some((deck) => pointInRing(p, deck.polygon))) {
      fault(`under-structure parcel ${owners[0] as number} stands outside every elevated corridor`);
    }
  }
}

/** No parcel stands on a road, read at the middle of every so many segments. */
function checkRoadsClear(w: WorldDescription, index: ParcelIndex, fault: Fault): void {
  let step = 0;
  for (const road of w.roads) {
    for (let i = 0; i + 1 < road.points.length; i++) {
      if (step++ % SAMPLE_STRIDE !== 0) continue;
      if (road.bridges.includes(i) || road.tunnels.includes(i)) continue;
      const a = road.points[i] as Point;
      const b = road.points[i + 1] as Point;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const owners = index.at(mid);
      if (owners.length > 0) fault(`parcel ${owners[0] as number} stands on ${road.tier} ${road.id}`);
    }
  }
}

/**
 * Spec section 6.3: the ground under a deck over land is the deck's own
 * elevated corridor, or the footprint where another corridor cut that claim
 * short. A parcel there would stand a building under the deck. The decks are
 * cut at the waterline, so the dry end of the segment that leaves the shore is
 * read too (issue #531).
 */
function checkUnderDecks(w: WorldDescription, parcels: Parcel[], index: ParcelIndex, fault: Fault): void {
  const hf = new Heightfield(w.terrain);
  for (const road of w.roads) {
    for (const line of dryDeckLines(road, hf, w.water.seaLevel)) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i] as Point;
        const b = line[i + 1] as Point;
        for (const id of index.at({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })) {
          const owner = (parcels[id] as Parcel).owner;
          if (owner !== 'under-structure') fault(`${owner} parcel ${id} stands under ${road.tier} ${road.id}`);
        }
      }
    }
  }
}

function checkCorridorsClear(w: WorldDescription, parcels: Parcel[], index: ParcelIndex, fault: Fault): void {
  for (const corridor of w.corridors) {
    // The middle of each run, not its ends: the end of a centreline stands
    // on the edge of its own strip, where inside and outside are the same
    // place and neither answer means anything.
    for (let i = 0; i + 1 < corridor.points.length; i++) {
      const a = corridor.points[i] as Point;
      const b = corridor.points[i + 1] as Point;
      const owners = index.at({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      // The ground under a deck is a parcel of its own; the tram's lane is footprint.
      const owner = owners.length > 0 ? (parcels[owners[0] as number] as Parcel).owner : undefined;
      const allowed = corridor.kind === 'elevated' ? 'under-structure' : undefined;
      if (owner !== undefined && owner !== allowed) {
        fault(`${owner} parcel ${owners[0] as number} stands on ${corridor.kind} corridor ${corridor.id}`);
      }
    }
  }
}

/** The first thing wrong with the parcels of one seed. */
function parcelComplaint(seed: number): string | undefined {
  const w = worlds.get(seed) as WorldDescription;
  const graph = graphOf(seed);
  const footprint = footprintOf(seed);
  const { parcels, area, land } = parcelsOf(seed);
  let complaint: string | undefined;
  const fault = (text: string): void => {
    complaint ??= text;
  };

  if (parcels.length < MIN_PARCELS) fault(`cuts only ${parcels.length} parcels`);
  for (let i = 0; i < parcels.length; i++) checkParcel(parcels[i] as Parcel, i, w, graph, fault);

  // The parcels are the land less the footprint. What is neither of the two
  // is land no road reaches, and there is never much of it.
  if (area > land) fault('the parcels cover more ground than there is land');
  const unreached = (land - area - footprint.area) / land;
  if (unreached > MAX_UNREACHED_SHARE) fault(`leaves ${(unreached * 100).toFixed(1)} % of the land neither road nor parcel`);

  const index = new ParcelIndex(parcels);
  checkLandSamples(w, parcels, index, footprint, fault);
  checkRoadsClear(w, index, fault);
  checkUnderDecks(w, parcels, index, fault);
  checkCorridorsClear(w, parcels, index, fault);
  return complaint;
}

/** Its parcel is a building parcel, in the same district and zone. */
function checkBuildingPlace(building: Building, where: string, parcel: Parcel, w: WorldDescription, fault: Fault): void {
  if (parcel.owner !== 'building') fault(`${where} stands on a ${parcel.owner} parcel`);
  if (building.district !== parcel.district || building.zone !== parcel.zone) {
    fault(`${where} disagrees with its parcel about where it stands`);
  }
  if (w.districts[building.district] === undefined) fault(`${where} is in district ${building.district}, which does not exist`);
}

/** The lot has four corners, winds forward, and is at least the size its zone lays. */
function checkLotShape(building: Building, where: string, fault: Fault): void {
  const spec = ZONE_LOTS[building.zone];
  if (building.lot.length !== 4) fault(`${where} has a lot of ${building.lot.length} corners`);
  if (ringArea(building.lot) <= 0) fault(`${where} has a lot wound the wrong way`);
  if (Math.abs(ringArea(building.lot) - building.area) > 1e-6) fault(`${where} misreports its lot`);
  if (building.width + 1e-6 < spec.minWidth || building.depth + 1e-6 < spec.minDepth) {
    fault(`${where} has a lot ${building.width.toFixed(1)} m by ${building.depth.toFixed(1)} m, under what its zone lays`);
  }
}

/**
 * The kind fits the zone and the lot: a suburban parcel has no tower on its
 * table at all, and no lot carries a kind it is too small for.
 */
function checkKind(building: Building, where: string, fault: Fault): void {
  if (!ZONE_BUILDINGS[building.zone].some((entry) => entry.kind === building.kind)) {
    fault(`${where} is a ${building.kind}, which the ${building.zone} does not build`);
  }
  if (building.area + 1e-6 < MIN_LOT_AREA[building.kind]) {
    fault(`${where} is a ${building.kind} on ${building.area.toFixed(0)} m²`);
  }
}

/**
 * The ground under the lot is level enough to build on: the fall across it is
 * the foundation wall the renderer stands the building on.
 */
function checkLotFall(building: Building, where: string, terrain: Heightfield, fault: Fault): void {
  let low = Infinity;
  let high = -Infinity;
  for (const corner of building.lot) {
    const height = terrain.sample(corner.x, corner.y);
    low = Math.min(low, height);
    high = Math.max(high, height);
  }
  if (high - low > MAX_LOT_FALL + 1e-6) {
    fault(`${where} stands on ground that falls ${(high - low).toFixed(1)} m across its lot`);
  }
}

/**
 * The lot never leaves the parcel. It fronts one of the roads the parcel runs
 * along, and stands on the ground that road claims, plus the setback its zone
 * lays it at.
 */
function checkFrontage(building: Building, where: string, parcel: Parcel, graph: RoadGraph, fault: Fault): void {
  for (const corner of building.lot) {
    if (!pointInRegion(corner, parcel.region)) fault(`${where} has a lot corner outside its parcel`);
  }
  if (!parcel.roads.includes(building.road)) {
    fault(`${where} fronts edge ${building.road}, which does not run along its parcel`);
    return;
  }
  const edge = graph.edges[building.road] as RoadEdge;
  const line = graph.edgePoints(building.road);
  const front = [building.lot[0] as Point, building.lot[1] as Point];
  const gap = Math.min(distanceToLine(front[0] as Point, line), distanceToLine(front[1] as Point, line));
  const reach = footprintHalfWidth(edge.tier) + FRONT_REACH + ZONE_LOTS[building.zone].setback + FRONT_SLACK;
  if (gap > reach) fault(`${where} stands ${gap.toFixed(1)} m from the ${edge.tier} it fronts`);
}

/**
 * The front is the middle of the lot's first edge, and it looks out of the
 * lot, across that edge: the way it faces is the edge's own outward normal. A
 * lot whose side edges lean is a trapezoid, so the line from the middle of its
 * back edge is not the same thing.
 */
function checkFacing(building: Building, where: string, fault: Fault): void {
  const front = middleOf([building.lot[0] as Point, building.lot[1] as Point]);
  if (Math.hypot(front.x - building.front.x, front.y - building.front.y) > FRONT_DRIFT) {
    fault(`${where} puts its front somewhere other than the middle of its front edge`);
  }
  const edgeX = (building.lot[1] as Point).x - (building.lot[0] as Point).x;
  const edgeY = (building.lot[1] as Point).y - (building.lot[0] as Point).y;
  const facing = Math.atan2(-edgeX, edgeY);
  const turned = Math.abs(Math.atan2(Math.sin(building.facing - facing), Math.cos(building.facing - facing)));
  if (turned > FACING_DRIFT) fault(`${where} faces ${turned.toFixed(2)} rad away from its own frontage`);
}

/** Checks one building against its parcel. Returns false when that parcel does not exist. */
function checkBuilding(building: Building, i: number, lay: Lay, fault: Fault): boolean {
  const where = `building ${i}`;
  if (building.id !== i) fault(`${where} is numbered ${building.id}`);
  const parcel = lay.parcels[building.parcel];
  if (parcel === undefined) {
    fault(`${where} stands on parcel ${building.parcel}, which does not exist`);
    return false;
  }
  checkBuildingPlace(building, where, parcel, lay.w, fault);
  checkLotShape(building, where, fault);
  checkKind(building, where, fault);
  checkLotFall(building, where, lay.terrain, fault);
  checkFrontage(building, where, parcel, lay.graph, fault);
  checkFacing(building, where, fault);
  return true;
}

/** Checks each pair of lots on one parcel, and adds its walled lots to the tally. */
function checkParcelLots(parcel: Parcel, lots: Building[], wall: WallTally, fault: Fault): void {
  const attached = ZONE_LOTS[parcel.zone].attached;
  /** Which lots of this parcel share a wall with another one. */
  const walled = new Set<number>();
  for (let i = 0; i < lots.length; i++) {
    for (let k = i + 1; k < lots.length; k++) {
      const a = lots[i] as Building;
      const b = lots[k] as Building;
      if (attached && ringsOverlap(a.lot, b.lot) && sharedArea(a.lot, b.lot) <= SHARED_LOT_AREA) {
        walled.add(a.id);
        walled.add(b.id);
      }
      // Where the zone builds a street wall the lots touch on purpose,
      // so what may not happen there is overlap; elsewhere they may not
      // meet at all (issue #192).
      const shared = attached ? sharedArea(a.lot, b.lot) > SHARED_LOT_AREA : ringsOverlap(a.lot, b.lot);
      if (shared) fault(`buildings ${a.id} and ${b.id} share the ground of parcel ${parcel.id}`);
    }
  }
  // Spec section 10.3 by way of issue #192: a street of the core or the
  // inner ring is one wall of buildings. A parcel with a row on it has
  // its lots touching, so what is counted is the lots that do.
  if (attached && lots.length > 1) {
    wall.of += lots.length;
    wall.walled += walled.size;
  }
}

/** The first thing wrong with the buildings of one seed. Adds to the pooled tallies. */
function buildingComplaint(seed: number, wall: WallTally, tally: KindTally): string | undefined {
  const w = worlds.get(seed) as WorldDescription;
  const graph = graphOf(seed);
  const { parcels } = parcelsOf(seed);
  const { buildings } = buildingsOf(seed);
  const lay: Lay = { w, graph, parcels, terrain: new Heightfield(w.terrain) };
  let complaint: string | undefined;
  const fault = (text: string): void => {
    complaint ??= text;
  };

  if (buildings.length < MIN_BUILDINGS) fault(`lays only ${buildings.length} buildings`);
  /** The lots of each parcel, so the pairs of one parcel are checked and no others. */
  const lotsOn = new Map<number, Building[]>();
  for (let i = 0; i < buildings.length; i++) {
    const building = buildings[i] as Building;
    if (!checkBuilding(building, i, lay, fault)) continue;
    const zoneTally = tally[building.zone];
    zoneTally[building.kind] = (zoneTally[building.kind] ?? 0) + 1;
    const known = lotsOn.get(building.parcel);
    if (known === undefined) lotsOn.set(building.parcel, [building]);
    else known.push(building);
  }
  for (const parcel of parcels) checkParcelLots(parcel, lotsOn.get(parcel.id) ?? [], wall, fault);
  return complaint;
}

/**
 * Spec section 8.2: the zone's character shows in what it builds. Pooled over
 * the seeds, because a zone of one seed can be a handful of buildings.
 */
function expectSignatureKinds(tally: KindTally): void {
  for (const zone of ['core', 'inner', 'industrial', 'suburban', 'outskirts', 'wilderness'] as Zone[]) {
    const row = tally[zone];
    const kinds = ZONE_BUILDINGS[zone];
    let total = 0;
    for (const entry of kinds) total += row[entry.kind] ?? 0;
    if (total < MIN_KIND_SAMPLES) continue;
    const signature = SIGNATURE_KIND[zone];
    const share = (row[signature] ?? 0) / total;
    const spread = kinds.map((entry) => `${entry.kind} ${(((row[entry.kind] ?? 0) / total) * 100).toFixed(0)} %`).join(', ');
    expect(share, `${zone} of ${total} buildings: ${spread}`).toBeGreaterThanOrEqual(MIN_SIGNATURE_SHARE[zone]);
  }
}

function checkPoliceStation(stations: PoliceStation[], i: number, parcels: Parcel[], fault: Fault): void {
  const station = stations[i] as PoliceStation;
  const parcel = parcels[station.parcel];
  if (i > 0 && station.district <= (stations[i - 1] as PoliceStation).district) fault('lists its stations out of order');
  if (parcel?.owner !== 'building') fault(`station ${i} stands on a ${parcel?.owner} parcel`);
  if (parcel?.district !== station.district) fault(`station ${i} is not in its district`);
  // The mark is the centre of the parcel's ground, which is inside the
  // box around it even where the parcel bends round a corner.
  const xs = parcel?.region.outer.map((p) => p.x) ?? [];
  const ys = parcel?.region.outer.map((p) => p.y) ?? [];
  if (station.x < Math.min(...xs) || station.x > Math.max(...xs) || station.y < Math.min(...ys) || station.y > Math.max(...ys)) {
    fault(`station ${i} is marked away from its parcel`);
  }
}

function checkMetroStation(map: ParcelMap, i: number, served: Set<number>, fault: Fault): void {
  const { parcels, stations, metro } = map;
  const station = metro[i] as MetroStation;
  const parcel = parcels[station.parcel];
  if (i > 0 && station.district <= (metro[i - 1] as MetroStation).district) fault('lists its stations out of order');
  if (!served.has(station.district)) fault(`station ${i} is in district ${station.district}, which the line does not call at`);
  if (parcel?.owner !== 'plaza' && parcel?.owner !== 'building') fault(`station ${i} stands on a ${parcel?.owner} parcel`);
  if (parcel?.district !== station.district) fault(`station ${i} is not in its district`);
  if (stations.some((police) => police.parcel === station.parcel)) fault(`station ${i} shares a parcel with a police station`);
  // Every parcel has a road along it, which is the street entrance.
  if ((parcel?.roads.length ?? 0) === 0) fault(`station ${i} has no street entrance`);
}

/**
 * The stairs stand on the pavement of a road that has one: off the
 * carriageway, and inside the ground that road claims, where no building
 * stands (spec section 6.4). The panel opens within `ENTRANCE_REACH` of them,
 * so two entrances never stand within reach of each other either.
 */
function checkMetroEntrances(w: WorldDescription, metro: MetroStation[], fault: Fault): void {
  const entrances = metroEntrances(w, metro);
  if (entrances.length !== metro.length) fault(`has ${entrances.length} entrances for ${metro.length} stations`);
  for (const [i, at] of entrances.entries()) {
    const station = metro[at.station] as MetroStation;
    const spot = nearestRoadSpot(w, station.x, station.y, (tier) => TIERS[tier].pavement > 0);
    const away = hypot(at.x - (spot?.x ?? 0), at.y - (spot?.y ?? 0));
    if (away < TIERS[at.tier].width / 2) fault(`entrance ${i} stands on the carriageway`);
    if (away > footprintHalfWidth(at.tier)) fault(`entrance ${i} stands off the ground its road claims`);
    for (const other of entrances.slice(i + 1)) {
      if (hypot(at.x - other.x, at.y - other.y) <= ENTRANCE_REACH) fault(`entrance ${i} stands on another`);
    }
  }
}

/** A downtown builds on its blocks rather than paving them. */
function checkDowntownBlocks(w: WorldDescription, parcels: Parcel[], fault: Fault): void {
  const core = parcels.filter((parcel) => parcel.zone === 'core' && parcel.owner !== 'beach');
  const built = core.filter((parcel) => parcel.owner === 'building').length / Math.max(1, core.length);
  if (built < MIN_CORE_BUILT_SHARE) fault(`builds on only ${(built * 100).toFixed(0)} % of ${core.length} core blocks`);
  // An open car park in a dense zone is a beach car park, which the beach
  // puts there; the zone itself never hands one out.
  const beachParks = w.beaches.reduce((n, beach) => n + beach.carParks.length, 0);
  const dense = parcels.filter((parcel) => parcel.owner === 'car-park' && (parcel.zone === 'core' || parcel.zone === 'inner'));
  if (dense.length > beachParks) fault(`has ${dense.length} open car parks downtown and only ${beachParks} beach car parks`);
}

/** Every building reads the skyline at the middle of its lot. The inner ones add to the lead. */
function checkSkylines(buildings: Building[], zones: ReturnType<typeof layoutZones>, lead: SkylineLead, fault: Fault): void {
  for (const building of buildings) {
    const middle = lotMiddle(building.lot);
    if (Math.abs(building.skyline - skylineAt(zones, middle.x, middle.y)) > 1e-9 || building.skyline < 0 || building.skyline > 1) {
      fault(`building ${building.id} reads a skyline of ${building.skyline}`);
    }
    if (building.zone !== 'inner') continue;
    if (building.kind === 'tower') {
      lead.tower += building.skyline;
      lead.towers++;
    } else if (building.kind === 'mid-rise') {
      lead.midRise += building.skyline;
      lead.midRises++;
    }
  }
}

/**
 * The seed sweep of spec section 3, on the parcels the footprint leaves and the
 * buildings laid on them.
 */
sweepSuite('parcels', () => {
  it('cuts the land the footprint leaves into parcels, each owned by one thing and each on a road', () => {
    // Spec section 6.4 steps 3 to 5: the parcels are the land less the roads,
    // the corridors and the water. Nothing is nudged apart afterwards, so no
    // parcel may stand on another one, on a road or on a corridor, and every
    // parcel has exactly one owner and a road to reach it by.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      expect(parcelComplaint(seed), `seed ${seed}`).toBeUndefined();
    }
  });

  it('lays every building on a lot inside its parcel, fronting a road that reaches it', () => {
    // Spec section 10.3: a parcel the zone gave to a building group carries a
    // row of buildings along its road frontage. A lot stands wholly inside its
    // parcel; two lots of one parcel share a wall where the zone builds a
    // street wall and stand apart where it does not, so nothing is nudged off
    // its neighbour afterwards here either. Every lot fronts a road its parcel already lists,
    // and those are graph edges, so every building stands on the one road
    // network and can be driven to.
    const wall: WallTally = { of: 0, walled: 0 };
    const tally: KindTally = {
      core: {},
      inner: {},
      industrial: {},
      suburban: {},
      outskirts: {},
      wilderness: {},
    };
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      expect(buildingComplaint(seed, wall, tally), `seed ${seed}`).toBeUndefined();
    }

    // Issue #192: the lots of an attached zone touch, which is what makes a
    // downtown street a canyon. Pooled over the seeds and over the parcels
    // with a row on them, because the far end of a row has one neighbour and
    // a parcel whose frontage takes one lot has none.
    expect(wall.walled / Math.max(1, wall.of), `${wall.walled} of ${wall.of} attached lots share a wall`).toBeGreaterThanOrEqual(
      MIN_WALLED_SHARE,
    );
    expectSignatureKinds(tally);
  });

  it('gives every district with a building parcel one police station, on one of its building parcels', () => {
    // Spec section 11.7: an arrest comes back at the nearest police station,
    // and the parcel owner assignment is what picks them.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const { parcels, stations } = parcelsOf(seed);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      const built = new Set(parcels.filter((parcel) => parcel.owner === 'building').map((parcel) => parcel.district));
      if (stations.length === 0) fault('has no police station');
      if (stations.length !== built.size) fault(`has ${stations.length} stations for ${built.size} built districts`);
      for (let i = 0; i < stations.length; i++) checkPoliceStation(stations, i, parcels, fault);
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('gives the metro a station in the core, the inner districts and the suburb edge', () => {
    // Spec section 13.3: the stations are parcels with a street entrance, and
    // fast travel needs at least two of them to be a journey. A station never
    // shares its parcel with the police station of the same district.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const map = parcelsOf(seed);
      const served = new Set(metroDistricts(w));
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      if (map.metro.length < 2) fault(`has ${map.metro.length} metro stations`);
      for (let i = 0; i < map.metro.length; i++) checkMetroStation(map, i, served, fault);
      checkMetroEntrances(w, map.metro, fault);
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('builds on nearly every downtown block, and gathers the towers where the skyline is high', () => {
    // Issue #193: a downtown builds on its blocks rather than paving them, and
    // parks its cars in a building. The skyline is a smooth field, so every
    // building carries the value `skylineAt` gives at the middle of its lot,
    // and the towers of the inner ring stand nearer the core than its
    // mid-rise blocks do.
    const lead: SkylineLead = { tower: 0, towers: 0, midRise: 0, midRises: 0 };
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const { parcels } = parcelsOf(seed);
      const { buildings } = buildingsOf(seed);
      const zones = layoutZones(w.size, w.core, w.water);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      checkDowntownBlocks(w, parcels, fault);
      checkSkylines(buildings, zones, lead, fault);
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
    const tower = lead.tower / Math.max(1, lead.towers);
    const midRise = lead.midRise / Math.max(1, lead.midRises);
    expect(tower - midRise, `inner towers at ${tower.toFixed(2)}, mid-rise blocks at ${midRise.toFixed(2)}`).toBeGreaterThanOrEqual(
      MIN_TOWER_SKYLINE_LEAD,
    );
  });
});
