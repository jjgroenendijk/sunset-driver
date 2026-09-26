import { expect, it } from 'vitest';
import { pointInRegions } from '../../src/core/geom.ts';
import {
  BEACH_REACH,
  BEACH_RISE,
  isResort,
  MAX_SAND,
  MIN_BEACH,
  MIN_PIER,
  MIN_SAND,
  SHORE_STEP,
} from '../../src/world/terrain/beaches.ts';
import { MIN_BOARDWALK } from '../../src/world/roads/roads.ts';
import { kerbsidePlace, onCarriageway } from '../../src/world/roads/kerbside.ts';
import { nearestRoadPlace } from '../../src/world/terrain/surface.ts';
import { CHAPTERS, chainSides, chapterJob, type Chapter } from '../../src/sim/missions/chain.ts';
import { dealerPlaces, PITCH_LIMIT, type DealerPlace } from '../../src/sim/crime/dealer.ts';
import { giverPlaces } from '../../src/sim/missions/giver.ts';
import { jobSites, type MissionWorld } from '../../src/sim/missions/job.ts';
import type { Place } from '../../src/sim/player/on-foot.ts';
import { createSimState } from '../../src/sim/simulation.ts';
import { type BuildingMap } from '../../src/world/city/buildings.ts';
import { layoutZones, SERVED_BY, zoneAt, zoneFallback } from '../../src/world/terrain/districts.ts';
import { type RoadFootprint } from '../../src/world/city/footprint.ts';
import { GradedLand } from '../../src/world/carve/graded-land.ts';
import { Heightfield } from '../../src/world/terrain/heightfield.ts';
import { LandMasses } from '../../src/world/terrain/landmass.ts';
import { type Parcel } from '../../src/world/city/parcels.ts';
import { buildShops, roomOf, MAX_LICENCE, MIN_LICENCE, SHOP_KINDS, type Shop } from '../../src/world/city/shops.ts';
import { TIERS } from '../../src/world/roads/tiers.ts';
import { type Beach, type Corridor, type Point, type RoadCurve, type WorldDescription } from '../../src/world/types.ts';
import { ringArea } from '../support/helpers.ts';
import {
  FOOTPRINT_COUNT,
  CHAIN_COUNT,
  DEALER_COUNT,
  SAMPLE_STRIDE,
  GUARANTEED_BEACH,
  MIN_SAND_OWNED,
  MIN_SAND_PLACES,
  BEACH_STRIDE,
} from './seed-limits.ts';
import { ParcelIndex } from './seed-index.ts';
import { coverOf, polylineLength } from './seed-probes.ts';
import { buildingsOf, seeds, worlds, footprintOf, parcelsOf } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/** The districts `generateDistricts` names with a culture of their own. */
const FIXED_NAMES = new Set(['The Barrio', 'Little Italy', 'Chinatown', 'The Blocks', 'The Docks', 'Freight Yards', 'Gull Island', 'Roadhouse Strip']);

/** Records the first fault a check finds. */
type Fault = (text: string) => void;
/** What a beach is checked against. */
type Coast = { w: WorldDescription; hf: Heightfield; land: LandMasses; roaded: Uint8Array; sea: number };

/** The beach's own lines: numbered in order, long enough, and wound the right way. */
function checkBeachShape(beach: Beach, i: number, fault: Fault): void {
  const where = `beach ${i}`;
  if (beach.id !== i) fault(`${where} is numbered ${beach.id}`);
  if (beach.shore.length < 2) fault(`${where} has no waterline`);
  if (beach.back.length !== beach.shore.length) fault(`${where} has a dune line of a different length`);
  if (beach.length < MIN_BEACH) fault(`${where} is only ${beach.length.toFixed(0)} m of coast`);
  if (Math.abs(beach.length - polylineLength(beach.shore)) > 1e-6) fault(`${where} misreports its length`);
  if (ringArea(beach.sand) <= 0) fault(`${where} has its sand wound the wrong way`);
  if (ringArea(beach.shallows) <= 0) fault(`${where} has its shallows wound the wrong way`);
}

/** One place along the waterline, where `k` indexes the shore and the dune line. */
function checkShoreSample(beach: Beach, k: number, at: string, coast: Coast, fault: Fault): void {
  const { w, hf, sea } = coast;
  const p = beach.shore[k] as Point;
  const back = beach.back[k] as Point;
  // The dune line stands inland of the waterline, on dry ground: that
  // is the whole of what says which way is inland here.
  const sand = Math.hypot(back.x - p.x, back.y - p.y);
  if (sand < MIN_SAND - 1e-6) fault(`${at} has only ${sand.toFixed(1)} m of sand`);
  if (hf.sample(back.x, back.y) <= sea) fault(`${at} has its dune line under water`);
  // The coast is gentle, which is what made it a beach: the ground
  // stands above the sea a beach's reach inland, but not far above it.
  const nx = (back.x - p.x) / sand;
  const ny = (back.y - p.y) / sand;
  const rise = hf.sample(p.x + nx * BEACH_REACH, p.y + ny * BEACH_REACH) - sea;
  if (rise <= 0) fault(`${at} has water behind it`);
  if (rise > BEACH_RISE) fault(`${at} stands below a cliff`);
  // The harbour is quay and the river mouth is bank, never beach.
  const harbour = Math.hypot(p.x - w.water.harbour.x, p.y - w.water.harbour.y);
  if (harbour < w.water.harbour.radius) fault(`${at} is inside the harbour`);
}

/** A resort carries a boardwalk line, car parks and a laid boardwalk road, on land a road reaches. */
function checkResort(beach: Beach, where: string, coast: Coast, fault: Fault): void {
  if (beach.boardwalk.length !== beach.shore.length) fault(`${where} has a boardwalk line of a different length`);
  if (beach.carParks.length === 0) fault(`${where} is a resort with nowhere to park`);
  // A resort carries a boardwalk, a pier and two car parks, so it is
  // worth building only where a road is really laid. The network
  // bridges to an island that carries a district and to the islands
  // on the way there, and to nothing else (issue #367).
  const mid = beach.back[Math.floor(beach.back.length / 2)] as Point;
  const mass = coast.land.massAt(mid.x, mid.y);
  if (mass < 0 || coast.roaded[mass] !== 1) fault(`${where} is a resort on land no road is laid on`);
  // A resort is a beach with a boardwalk on it. One whose boardwalk
  // was never laid keeps a pier and two car parks that no road
  // reaches, so spec section 7.3 is not kept (issue #374).
  if (beach.boardwalkRoad < 0) fault(`${where} is a resort whose boardwalk was never laid`);
}

/** A beach that is no resort carries none of what a resort does. */
function checkPlainBeach(beach: Beach, where: string, fault: Fault): void {
  if (beach.boardwalk.length > 0) fault(`${where} is no resort but carries a boardwalk line`);
  if (beach.pier !== undefined) fault(`${where} is no resort but carries a pier`);
  if (beach.carParks.length > 0) fault(`${where} is no resort but carries a car park`);
  if (beach.boardwalkRoad >= 0) fault(`${where} is no resort but names a boardwalk road`);
}

/** The boardwalk road a beach names is a street that runs along its back. */
function checkBoardwalkRoad(beach: Beach, where: string, w: WorldDescription, fault: Fault): void {
  if (beach.boardwalkRoad < 0) return;
  const road = w.roads[beach.boardwalkRoad];
  if (road === undefined) fault(`${where} names a boardwalk road that does not exist`);
  else if (road.tier !== 'street') fault(`${where} has a boardwalk that is a ${road.tier}`);
  else {
    const cover = coverOf(road.points, beach.boardwalk);
    if (cover < MIN_BOARDWALK) fault(`${where} has a boardwalk along only ${cover.toFixed(0)} m of its back`);
  }
}

function checkPier(beach: Beach, where: string, coast: Coast, fault: Fault): void {
  const pier = beach.pier;
  if (pier === undefined) return;
  if (coast.hf.sample(pier.head.x, pier.head.y) >= coast.sea) fault(`${where} has a pier that ends on dry land`);
  if (Math.hypot(pier.head.x - pier.root.x, pier.head.y - pier.root.y) < MIN_PIER) {
    fault(`${where} has a pier that hardly leaves the shore`);
  }
  if (ringArea(pier.polygon) <= 0) fault(`${where} has its pier wound the wrong way`);
}

function checkBeach(beach: Beach, i: number, coast: Coast, fault: Fault): void {
  const where = `beach ${i}`;
  checkBeachShape(beach, i, fault);
  for (let k = 0; k < beach.shore.length; k += BEACH_STRIDE) checkShoreSample(beach, k, `${where} at ${k}`, coast, fault);
  if (isResort(beach)) checkResort(beach, where, coast, fault);
  else checkPlainBeach(beach, where, fault);
  checkBoardwalkRoad(beach, where, coast.w, fault);
  checkPier(beach, where, coast, fault);
}

/**
 * The one beach spec section 7.3 asks for: a long beach outside the core, with
 * the boardwalk laid and the pier built.
 */
function checkGuaranteedBeach(w: WorldDescription, fault: Fault): void {
  const zones = layoutZones(w.size, w.core, w.water);
  const served = w.beaches.filter(
    (b) => isResort(b) && b.boardwalkRoad >= 0 && b.pier !== undefined && zoneAt(zones, (b.shore[0] as Point).x, (b.shore[0] as Point).y) !== 'core',
  );
  const longest = Math.max(0, ...served.map((b) => b.length));
  if (longest < GUARANTEED_BEACH) {
    fault(`has no beach outside the core with a boardwalk and a pier longer than ${longest.toFixed(0)} m`);
  }
  // The districts along it are the beach neighbourhood of spec section 8.3.
  if (!w.districts.some((d) => d.culture === 'beach')) fault('has no beach neighbourhood');
  // It never takes a named neighbourhood: that culture is a faction's home turf (issue #348).
  for (const d of w.districts) {
    if (d.culture === 'beach' && FIXED_NAMES.has(d.name)) fault(`turns ${d.name} into a beach neighbourhood`);
  }
}

/**
 * A beach parcel is a piece of one beach's sand, so every corner of it stands
 * within a beach's width of a waterline. Asking whether its middle is inside
 * the sand would not do: a strip that follows a bay is a crescent, and the
 * middle of a crescent is outside it.
 */
function checkBeachParcels(w: WorldDescription, parcels: Parcel[], fault: Fault): void {
  const waterline: Point[] = w.beaches.flatMap((b) => b.shore);
  for (const parcel of parcels) {
    if (parcel.owner !== 'beach') continue;
    for (let k = 0; k < parcel.region.outer.length; k += SAMPLE_STRIDE) {
      const p = parcel.region.outer[k] as Point;
      let near = Infinity;
      for (const q of waterline) near = Math.min(near, Math.hypot(q.x - p.x, q.y - p.y));
      if (near > MAX_SAND + SHORE_STEP) fault(`parcel ${parcel.id} is a beach ${near.toFixed(0)} m from any waterline`);
    }
  }
}

/**
 * The guaranteed beach: what the roads left of its sand is the beach's own
 * parcels, and there is enough of it left to be a beach. A through route may
 * still cross a beach — an island link has to reach its bridge head, and a
 * seafront boulevard is a real road — so the sand a road took is not counted
 * against the rest.
 */
function checkOwnedSand(w: WorldDescription, footprint: RoadFootprint, parcels: Parcel[], fault: Fault): void {
  const beach = [...w.beaches].filter((b) => isResort(b) && b.boardwalkRoad >= 0).sort((a, b) => b.length - a.length)[0];
  if (beach === undefined) {
    fault('has no resort with a boardwalk');
    return;
  }
  const index = new ParcelIndex(parcels);
  let free = 0;
  let owned = 0;
  for (let k = 0; k < beach.shore.length; k += BEACH_STRIDE) {
    const p = beach.shore[k] as Point;
    const back = beach.back[k] as Point;
    // Halfway between the waterline and the dune line, which is sand
    // wherever the beach has any width at all.
    const at = { x: (p.x + back.x) / 2, y: (p.y + back.y) / 2 };
    if (pointInRegions(at, footprint.regions)) continue;
    // Sand under a deck is the deck's under-structure, as road ground is the road's.
    const owners = index.at(at);
    const owner = owners.length === 1 ? (parcels[owners[0] as number] as Parcel).owner : undefined;
    if (owner === 'under-structure') continue;
    free++;
    if (owner === 'beach') owned++;
  }
  if (owned < free * MIN_SAND_OWNED) fault(`leaves ${free - owned} of ${free} free places on its beach unclaimed`);
  if (owned < MIN_SAND_PLACES) fault(`has only ${owned} places of beach parcel on its longest beach`);
}

function checkShop(shop: Shop, buildings: BuildingMap, fault: Fault): void {
  const row = buildings.buildings[shop.building];
  if (row === undefined) fault(`shop ${shop.id} stands on no building`);
  else if (row.kind !== 'shop-row') fault(`shop ${shop.id} stands on a ${row.kind}`);
  else if (row.district !== shop.district) fault(`shop ${shop.id} is in the wrong district`);
  if (shop.licence < MIN_LICENCE || shop.licence > MAX_LICENCE) fault(`shop ${shop.id} holds licence ${shop.licence}`);
  // The room it holds stands inside the lot the building was given.
  const room = roomOf(shop);
  if (Math.hypot(room.x - shop.x, room.y - shop.y) > shop.depth) fault(`shop ${shop.id} has a room off its lot`);
}

/** Every corner a dealer works is near their district, on the map, and off the carriageway. */
function checkDealer(w: WorldDescription, dealer: DealerPlace, fault: Fault): void {
  if (dealer.pitches.length === 0) fault(`${dealer.name} works no corner`);
  for (const pitch of dealer.pitches) {
    const away = Math.hypot(pitch.x - dealer.district.x, pitch.y - dealer.district.y);
    if (away > PITCH_LIMIT) fault(`${dealer.name} works a corner ${away.toFixed(0)} m out of their district`);
    if (Math.abs(pitch.x) > w.size / 2 || Math.abs(pitch.y) > w.size / 2) fault(`${dealer.name} works a corner off the map`);
    if (onCarriageway(w, pitch.x, pitch.y)) fault(`${dealer.name} stands in the road at ${pitch.x.toFixed(0)}, ${pitch.y.toFixed(0)}`);
  }
}

/** One chapter builds against the world, with every leg on the map and naming a district. */
function checkChapter(job: ReturnType<typeof chapterJob>, chapter: Chapter, w: WorldDescription, fault: Fault): void {
  if (job === undefined) {
    fault(`${chapter.id} could not be built`);
    return;
  }
  if (job.legs.length !== chapter.legs.length) fault(`${chapter.id} lost a leg`);
  if (job.limit <= 0) fault(`${chapter.id} allows no time`);
  for (const leg of job.legs) {
    if (Math.abs(leg.x) > w.size / 2 || Math.abs(leg.y) > w.size / 2) fault(`${chapter.id} sends the player off the map`);
    if (leg.label.includes('{where}')) fault(`${chapter.id} has a leg that names no district`);
  }
}

/** The first thing wrong with the authored chain on one seed. */
function chainComplaint(seed: number): string | undefined {
  const w = worlds.get(seed) as WorldDescription;
  const snap = (x: number, y: number): Place | undefined => nearestRoadPlace(w, x, y);
  const world: MissionWorld = {
    givers: giverPlaces(seed, w.districts, snap),
    sites: jobSites(seed, w.districts, snap),
  };
  const state = createSimState(seed);
  const sides = chainSides(world);
  const { patron, rival } = sides;
  if (patron === undefined || rival === undefined) return 'has nobody to run the chain through';
  let complaint: string | undefined;
  const fault = (text: string): void => {
    complaint ??= text;
  };
  for (const chapter of CHAPTERS) checkChapter(chapterJob(state, world, chapter, sides), chapter, w, fault);
  // The fork is a choice only where the two sides stand apart, which is
  // what the fallback in `chain.ts` is for.
  const fork = CHAPTERS.filter((chapter) => chapter.branch !== '');
  const at = Math.min(...fork.map((chapter) => chapter.step));
  const roles = new Set(fork.filter((chapter) => chapter.step === at).map((chapter) => chapter.role));
  if (roles.size !== 2) fault('offers both sides of the fork from one side');
  if (patron.id === rival.id) fault('runs both sides of the chain through one contact');
  return complaint;
}

/**
 * The seed sweep of spec section 3, on the places a world is given: the tram,
 * the beaches and the districts.
 */
sweepSuite('places', () => {
  it('runs the tram round one loop of arterials, calling at the core and inner districts', () => {
    // Spec section 13.2: a fixed loop with stops and level crossings. Every
    // stop is a district of the core or the inner ring, the line only uses
    // roads that allow trams, and it comes back to where it started.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const tram = w.tram;
      expect(tram.stops.length, `seed ${seed}: the tram calls nowhere`).toBeGreaterThanOrEqual(3);
      expect(tram.route.length, `seed ${seed}`).toBeGreaterThan(1);
      expect(tram.length, `seed ${seed}`).toBeGreaterThan(0);

      const head = tram.route[0] as Point;
      const tail = tram.route[tram.route.length - 1] as Point;
      expect(Math.hypot(head.x - tail.x, head.y - tail.y), `seed ${seed}: the loop does not close`).toBeLessThan(1e-6);

      const zones = new Set(['core', 'inner']);
      for (const stop of tram.stops) {
        const district = w.districts[stop.district] as (typeof w.districts)[number];
        expect(zones.has(district.zone), `seed ${seed}: stop ${stop.id} serves the ${district.zone}`).toBe(true);
      }
      // No district waits at two stops, and no stop stands on top of another.
      expect(new Set(tram.stops.map((s) => s.district)).size, `seed ${seed}: two stops serve one district`).toBe(tram.stops.length);

      for (const id of tram.corridors) {
        const corridor = w.corridors[id] as Corridor;
        expect(corridor.kind, `seed ${seed}: corridor ${id}`).toBe('tram');
        for (const road of corridor.roads) {
          expect(TIERS[(w.roads[road] as RoadCurve).tier].traffic.trams, `seed ${seed}: road ${road}`).toBe(true);
        }
      }
      for (const crossing of tram.crossings) {
        expect(crossing.roads.length, `seed ${seed}: a level crossing with no road`).toBeGreaterThan(0);
        for (const road of crossing.roads) expect(w.roads[road], `seed ${seed}`).toBeDefined();
      }
    }
  });

  it('gives every seed a beach outside the core with a boardwalk, a pier and car parks', () => {
    // Spec section 7.3: gentle coast becomes beach, steep coast stays cliff and
    // the harbour stays quay. At least one long beach lies outside the core,
    // with a boardwalk street along its back and a pier out over the water.
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const land = new LandMasses(hf, w.water, w.water.seaLevel + 1);
      const coast: Coast = { w, hf, land, roaded: land.servedMasses(w.districts), sea: w.water.seaLevel };
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (let i = 0; i < w.beaches.length; i++) checkBeach(w.beaches[i] as Beach, i, coast, fault);
      checkGuaranteedBeach(w, fault);
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('keeps the roads off the sand and cuts the sand into parcels the beach owns', () => {
    // Spec section 7.3 with spec section 6.4: the sand is claimed once, as
    // parcels. The boardwalk runs behind the dune line, so the ground between
    // it and the sea belongs to the beach and to no road.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const footprint = footprintOf(seed);
      const parcels = parcelsOf(seed).parcels;
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      checkBeachParcels(w, parcels, fault);
      checkOwnedSand(w, footprint, parcels, fault);
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('deals every trade of the shops over the shop rows of its own district', () => {
    // Spec section 16.1: a handful of shop types are enterable, placed by
    // district. Every shop stands on a shop row of the district it belongs to,
    // no building holds two trades, and a city has every trade somewhere.
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const buildings = buildingsOf(seed);
      const shops = buildShops(w, buildings);
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      for (const shop of shops) checkShop(shop, buildings, fault);
      if (new Set(shops.map((shop) => shop.building)).size !== shops.length) fault('two trades share one building');
      for (const kind of SHOP_KINDS) {
        if (!shops.some((shop) => shop.kind === kind)) fault(`has no ${kind}`);
      }
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('stands a dealer beside the streets of every district that has streets', () => {
    // Spec section 16.2: one dealer to a district, on its own corners. A
    // district with no street near its middle keeps none, which over the
    // seeds is the wilderness and nothing else. A corner is on the pavement,
    // never in the traffic.
    for (const seed of seeds.slice(0, DEALER_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const dealers = dealerPlaces(seed, w.districts, (x, y) => kerbsidePlace(w, x, y));
      let complaint: string | undefined;
      const fault = (text: string): void => {
        complaint ??= text;
      };
      const dealt = new Set(dealers.map((dealer) => dealer.district.id));
      for (const district of w.districts) {
        if (district.zone !== 'wilderness' && !dealt.has(district.id)) fault(`${district.name} has no dealer`);
      }
      for (const dealer of dealers) checkDealer(w, dealer, fault);
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });

  it('walks the authored chain from end to end over the corners a real city gave it', () => {
    // Spec section 18: the hand-written spine is anchored to whatever the seed
    // produced. Both of its sides find a contact, every chapter of both
    // branches builds against the world, and every leg of every chapter
    // stands on a street of the map with a clock long enough to reach it.
    for (const seed of seeds.slice(0, CHAIN_COUNT)) {
      expect(chainComplaint(seed), `seed ${seed}`).toBeUndefined();
    }
  });

  it('places every district on land in its own zone with the named neighbourhoods present', () => {
    const required = ['Little Italy', 'Chinatown', 'The Blocks', 'The Barrio', 'The Docks', 'Freight Yards', 'Gull Island', 'The Boardwalk', 'Roadhouse Strip'];
    for (const seed of seeds) {
      const w = worlds.get(seed) as WorldDescription;
      const hf = new Heightfield(w.terrain);
      const zones = layoutZones(w.size, w.core, w.water);
      const land = new LandMasses(hf, w.water, w.water.seaLevel + 1);
      // The land each serving tier can climb to, over the ground and the
      // crossings (issue #399). Two tiers serve the zones, so two floods answer
      // every district of the seed.
      const climbs = {
        street: new GradedLand(hf, w.core, TIERS.street.maxGrade, w.water.crossings),
        dirt: new GradedLand(hf, w.core, TIERS.dirt.maxGrade, w.water.crossings),
      };
      const names = new Set(w.districts.map((d) => d.name));
      for (const r of required) expect(names.has(r), `${r} in seed ${seed}`).toBe(true);
      expect(names.size, `duplicate district name in seed ${seed}`).toBe(w.districts.length);
      // The Boardwalk is the neighbourhood of a real boardwalk: the name goes
      // to a district a resort beach runs through (issue #104).
      const boardwalk = w.districts.find((d) => d.name === 'The Boardwalk');
      const onABeach = w.beaches.some((b) => isResort(b) && b.districts.includes(boardwalk?.id ?? -1));
      expect(onABeach, `seed ${seed}: The Boardwalk stands on no resort beach`).toBe(true);
      for (const d of w.districts) {
        expect(hf.sample(d.x, d.y), `seed ${seed}: ${d.name} stands under the sea`).toBeGreaterThanOrEqual(w.water.seaLevel);
        // The land it stands on carries an island of the water description, so
        // a crossing leads there and the roads can arrive. A rock in the sea
        // would take a district that could never be reached or built.
        expect(land.reaches(d.x, d.y), `seed ${seed}: ${d.name} stands on land no island site is on`).toBe(true);
        // And a road of the tier that serves it can climb to the site. A site
        // on a knoll or a ledge that steep ground closes off is a district
        // nobody can drive to (issue #399).
        //
        // Gull Island is the exception, as it is for the zone below: the island
        // district stands on its island whatever the ground there, and the flood
        // only crosses the water where it has climbed to the bridge head on the
        // near shore. The road that serves it is the island link, which
        // `seed-roads.test.ts` holds every inhabited island to.
        if (d.name !== 'Gull Island') {
          const tier = SERVED_BY[d.zone];
          if (!climbs[tier].at(d.x, d.y)) {
            // The one site allowed off that ground is the one whose zone held
            // none of it, which is what the sampler falls back on.
            const held = zoneFallback(zones, d.zone, hf, land, climbs[tier]).climbed;
            expect(held, `seed ${seed}: no ${tier} climbs to ${d.name}, though its ${d.zone} has ground one can`).toBeUndefined();
          }
          expect(zoneAt(zones, d.x, d.y), `seed ${seed}: ${d.name}`).toBe(d.zone);
        }
        expect(d.density, `seed ${seed}: ${d.name}`).toBeGreaterThanOrEqual(0);
        expect(d.density, `seed ${seed}: ${d.name}`).toBeLessThanOrEqual(1);
        expect(d.wealth, `seed ${seed}: ${d.name}`).toBeGreaterThanOrEqual(0);
        expect(d.wealth, `seed ${seed}: ${d.name}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
