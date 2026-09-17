import { describe, expect, it } from 'vitest';
import { pointInRegions } from '../src/core/geom.ts';
import {
  BEACH_REACH,
  BEACH_RISE,
  isResort,
  MAX_SAND,
  MIN_BEACH,
  MIN_PIER,
  MIN_SAND,
  SHORE_STEP,
} from '../src/world/beaches.ts';
import { MIN_BOARDWALK } from '../src/world/roads.ts';
import { nearestRoadPlace } from '../src/world/surface.ts';
import { dealerPlaces, PITCH_LIMIT } from '../src/sim/dealer.ts';
import { layoutZones, zoneAt } from '../src/world/districts.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import { LandMasses } from '../src/world/landmass.ts';
import { type Parcel } from '../src/world/parcels.ts';
import { buildShops, roomOf, MAX_LICENCE, MIN_LICENCE, SHOP_KINDS } from '../src/world/shops.ts';
import { TIERS } from '../src/world/tiers.ts';
import { type Beach, type Corridor, type Point, type RoadCurve, type WorldDescription } from '../src/world/types.ts';
import { ringArea } from './helpers.ts';
import {
  FOOTPRINT_COUNT,
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

/**
 * The seed sweep of spec section 3, on the places a world is given: the tram,
 * the beaches and the districts.
 *
 * `seed-sweep.test.ts` declares these inside the one suite that generates the
 * worlds; a file of its own would generate them all again.
 */
export function placeChecks(): void {
  describe('places', () => {
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
        expect(new Set(tram.stops.map((s) => s.district)).size).toBe(tram.stops.length);

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
        const zones = layoutZones(w.size, w.core, w.water);
        const sea = w.water.seaLevel;
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };

        for (let i = 0; i < w.beaches.length; i++) {
          const beach = w.beaches[i] as Beach;
          const where = `beach ${i}`;
          if (beach.id !== i) fault(`${where} is numbered ${beach.id}`);
          if (beach.shore.length < 2) fault(`${where} has no waterline`);
          if (beach.back.length !== beach.shore.length) fault(`${where} has a dune line of a different length`);
          if (beach.length < MIN_BEACH) fault(`${where} is only ${beach.length.toFixed(0)} m of coast`);
          if (Math.abs(beach.length - polylineLength(beach.shore)) > 1e-6) fault(`${where} misreports its length`);
          if (ringArea(beach.sand) <= 0) fault(`${where} has its sand wound the wrong way`);
          if (ringArea(beach.shallows) <= 0) fault(`${where} has its shallows wound the wrong way`);

          for (let k = 0; k < beach.shore.length; k += BEACH_STRIDE) {
            const p = beach.shore[k] as Point;
            const back = beach.back[k] as Point;
            const at = `${where} at ${k}`;
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

          if (isResort(beach)) {
            if (beach.boardwalk.length !== beach.shore.length) fault(`${where} has a boardwalk line of a different length`);
            if (beach.carParks.length === 0) fault(`${where} is a resort with nowhere to park`);
          } else {
            if (beach.boardwalk.length > 0) fault(`${where} is no resort but carries a boardwalk line`);
            if (beach.pier !== undefined) fault(`${where} is no resort but carries a pier`);
            if (beach.carParks.length > 0) fault(`${where} is no resort but carries a car park`);
            if (beach.boardwalkRoad >= 0) fault(`${where} is no resort but names a boardwalk road`);
          }
          if (beach.boardwalkRoad >= 0) {
            const road = w.roads[beach.boardwalkRoad];
            if (road === undefined) fault(`${where} names a boardwalk road that does not exist`);
            else if (road.tier !== 'street') fault(`${where} has a boardwalk that is a ${road.tier}`);
            else {
              const cover = coverOf(road.points, beach.boardwalk);
              if (cover < MIN_BOARDWALK) fault(`${where} has a boardwalk along only ${cover.toFixed(0)} m of its back`);
            }
          }
          const pier = beach.pier;
          if (pier !== undefined) {
            if (hf.sample(pier.head.x, pier.head.y) >= sea) fault(`${where} has a pier that ends on dry land`);
            if (Math.hypot(pier.head.x - pier.root.x, pier.head.y - pier.root.y) < MIN_PIER) {
              fault(`${where} has a pier that hardly leaves the shore`);
            }
            if (ringArea(pier.polygon) <= 0) fault(`${where} has its pier wound the wrong way`);
          }
        }

        // The one spec section 7.3 asks for: a long beach outside the core, with
        // the boardwalk laid and the pier built.
        const served = w.beaches.filter(
          (b) => isResort(b) && b.boardwalkRoad >= 0 && b.pier !== undefined && zoneAt(zones, (b.shore[0] as Point).x, (b.shore[0] as Point).y) !== 'core',
        );
        const longest = Math.max(0, ...served.map((b) => b.length));
        if (longest < GUARANTEED_BEACH) {
          fault(`has no beach outside the core with a boardwalk and a pier longer than ${longest.toFixed(0)} m`);
        }
        // The districts along it are the beach neighbourhood of spec section 8.3.
        if (!w.districts.some((d) => d.culture === 'beach')) fault('has no beach neighbourhood');
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
        const index = new ParcelIndex(parcels);
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };

        // A beach parcel is a piece of one beach's sand, so every corner of it
        // stands within a beach's width of a waterline. Asking whether its middle
        // is inside the sand would not do: a strip that follows a bay is a
        // crescent, and the middle of a crescent is outside it.
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

        // The guaranteed beach: what the roads left of its sand is the beach's
        // own parcels, and there is enough of it left to be a beach. A through
        // route may still cross a beach — an island link has to reach its bridge
        // head, and a seafront boulevard is a real road — so the sand a road took
        // is not counted against the rest.
        const beach = [...w.beaches].filter((b) => isResort(b) && b.boardwalkRoad >= 0).sort((a, b) => b.length - a.length)[0];
        if (beach === undefined) {
          fault('has no resort with a boardwalk');
        } else {
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
        for (const shop of shops) {
          const row = buildings.buildings[shop.building];
          if (row === undefined) fault(`shop ${shop.id} stands on no building`);
          else if (row.kind !== 'shop-row') fault(`shop ${shop.id} stands on a ${row.kind}`);
          else if (row.district !== shop.district) fault(`shop ${shop.id} is in the wrong district`);
          if (shop.licence < MIN_LICENCE || shop.licence > MAX_LICENCE) fault(`shop ${shop.id} holds licence ${shop.licence}`);
          // The room it holds stands inside the lot the building was given.
          const room = roomOf(shop);
          if (Math.hypot(room.x - shop.x, room.y - shop.y) > shop.depth) fault(`shop ${shop.id} has a room off its lot`);
        }
        if (new Set(shops.map((shop) => shop.building)).size !== shops.length) fault('two trades share one building');
        for (const kind of SHOP_KINDS) {
          if (!shops.some((shop) => shop.kind === kind)) fault(`has no ${kind}`);
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
      }
    });

    it('stands a dealer on the streets of every district that has streets', () => {
      // Spec section 16.2: one dealer to a district, on its own corners. A
      // district with no street near its middle keeps none, which over the
      // seeds is the wilderness and nothing else.
      for (const seed of seeds.slice(0, DEALER_COUNT)) {
        const w = worlds.get(seed) as WorldDescription;
        const dealers = dealerPlaces(seed, w.districts, (x, y) => nearestRoadPlace(w, x, y));
        let complaint: string | undefined;
        const fault = (text: string): void => {
          complaint ??= text;
        };
        const dealt = new Set(dealers.map((dealer) => dealer.district.id));
        for (const district of w.districts) {
          if (district.zone !== 'wilderness' && !dealt.has(district.id)) fault(`${district.name} has no dealer`);
        }
        for (const dealer of dealers) {
          if (dealer.pitches.length === 0) fault(`${dealer.name} works no corner`);
          for (const pitch of dealer.pitches) {
            const away = Math.hypot(pitch.x - dealer.district.x, pitch.y - dealer.district.y);
            if (away > PITCH_LIMIT) fault(`${dealer.name} works a corner ${away.toFixed(0)} m out of their district`);
            if (Math.abs(pitch.x) > w.size / 2 || Math.abs(pitch.y) > w.size / 2) fault(`${dealer.name} works a corner off the map`);
          }
        }
        expect(complaint, `seed ${seed}`).toBeUndefined();
      }
    });

    it('places every district on land in its own zone with the named neighbourhoods present', () => {
      const required = ['Little Italy', 'Chinatown', 'The Blocks', 'The Barrio', 'The Docks', 'Freight Yards', 'Gull Island', 'The Boardwalk', 'Roadhouse Strip'];
      for (const seed of seeds) {
        const w = worlds.get(seed) as WorldDescription;
        const hf = new Heightfield(w.terrain);
        const zones = layoutZones(w.size, w.core, w.water);
        const land = new LandMasses(hf, w.water, w.water.seaLevel + 1);
        const names = new Set(w.districts.map((d) => d.name));
        for (const r of required) expect(names.has(r), `${r} in seed ${seed}`).toBe(true);
        expect(names.size, `duplicate district name in seed ${seed}`).toBe(w.districts.length);
        // The Boardwalk is the neighbourhood of a real boardwalk: the name goes
        // to a district a resort beach runs through (issue #104).
        const boardwalk = w.districts.find((d) => d.name === 'The Boardwalk');
        const onABeach = w.beaches.some((b) => isResort(b) && b.districts.includes(boardwalk?.id ?? -1));
        expect(onABeach, `seed ${seed}: The Boardwalk stands on no resort beach`).toBe(true);
        for (const d of w.districts) {
          expect(hf.sample(d.x, d.y)).toBeGreaterThanOrEqual(w.water.seaLevel);
          // The land it stands on carries an island of the water description, so
          // a crossing leads there and the roads can arrive. A rock in the sea
          // would take a district that could never be reached or built.
          expect(land.reaches(d.x, d.y), `seed ${seed}: ${d.name} stands on land no island site is on`).toBe(true);
          if (d.name !== 'Gull Island') expect(zoneAt(zones, d.x, d.y)).toBe(d.zone);
          expect(d.density).toBeGreaterThanOrEqual(0);
          expect(d.density).toBeLessThanOrEqual(1);
          expect(d.wealth).toBeGreaterThanOrEqual(0);
          expect(d.wealth).toBeLessThanOrEqual(1);
        }
      }
    });
  });
}
