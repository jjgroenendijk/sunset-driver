import { describe, expect, it } from 'vitest';
import { pointInRing, ringArea, type Point } from '../../../src/core/geom.ts';
import { buildRoadGraph } from '../../../src/world/roads/graph.ts';
import { buildJunctions } from '../../../src/world/junctions/junctions.ts';
import { insideRegion } from '../../../src/world/city/lot-geom.ts';
import type { Parcel } from '../../../src/world/city/parcels.ts';
import { BAY_USES, bayRing, layBays, STREET_BAY_LENGTH } from '../../../src/world/city/parking.ts';
import { STREET_REACH } from '../../../src/world/terrain/vegetation.ts';
import { bayFaults } from '../../support/parking-checks.ts';
import { gridHeight, gridRoads, GRID_SPACING } from '../../support/traffic-grid.ts';
import { withNodes } from '../../support/helpers.ts';

describe('parking bays (spec section 13.1)', () => {
  const roads = gridRoads();
  withNodes(roads);
  const junctions = buildJunctions(roads, buildRoadGraph(roads));

  it('lines both kerbs of every street, and nothing else, clear of every lane and of each other', () => {
    const bays = layBays(roads, junctions, [], () => 'suburban', gridHeight);
    expect(bayFaults(bays, roads)).toEqual([]);
    // Six streets of 480 m, less a junction every 120 m: most of each kerb is bays.
    const streets = roads.filter((road) => road.tier === 'street').length;
    expect(bays.count).toBeGreaterThan((0.6 * streets * 2 * 4 * GRID_SPACING) / STREET_BAY_LENGTH);
    for (let bay = 0; bay < bays.count; bay++) {
      expect(bays.street[bay]).toBe(1);
      expect(BAY_USES[bays.use[bay] as number]).toBe('home');
      expect(bays.height[bay]).toBeCloseTo(gridHeight(bays.x[bay] as number, bays.y[bay] as number), 4);
    }
  });

  it('stands a bay clear of the ground every junction covers', () => {
    const bays = layBays(roads, junctions, [], () => 'core', gridHeight);
    expect(junctions.junctions.length).toBeGreaterThan(0);
    for (const junction of junctions.junctions) {
      for (let bay = 0; bay < bays.count; bay++) {
        // The grid's junctions are 120 m apart and none reaches 40 m from its node.
        if (Math.hypot((bays.x[bay] as number) - junction.x, (bays.y[bay] as number) - junction.y) > 40) continue;
        const ring = bayRing(bays, bay);
        for (const corner of ring) expect(pointInRing(corner, junction.outline), `bay ${bay}`).toBe(false);
        const nearest = Math.min(...junction.outline.map((p) => Math.hypot(p.x - (bays.x[bay] as number), p.y - (bays.y[bay] as number))));
        expect(nearest, `bay ${bay}`).toBeGreaterThan(STREET_BAY_LENGTH);
      }
    }
  });

  it('lays a car park out in rows inside the planted rim along its edge', () => {
    const outer = [
      { x: 1000, y: 1000 },
      { x: 1090, y: 1010 },
      { x: 1080, y: 1070 },
      { x: 995, y: 1060 },
    ];
    expect(ringArea(outer)).toBeGreaterThan(0);
    const parcel: Parcel = { id: 0, region: { outer, holes: [] }, area: ringArea(outer), owner: 'car-park', district: 0, zone: 'industrial', roads: [0] };
    const bays = layBays([], junctions, [parcel], () => 'industrial', () => 3);
    expect(bayFaults(bays, [], [parcel])).toEqual([]);
    expect(bays.count).toBeGreaterThan(40);
    for (let bay = 0; bay < bays.count; bay++) {
      expect(bays.street[bay]).toBe(0);
      expect(BAY_USES[bays.use[bay] as number]).toBe('work');
      expect(insideRegion(grown(bayRing(bays, bay), STREET_REACH - 0.01), parcel.region), `bay ${bay}`).toBe(true);
    }
  });

});

/** A rectangle grown outward by a margin on every side, about its own middle. */
function grown(ring: readonly Point[], by: number): Point[] {
  const cx = ring.reduce((sum, p) => sum + p.x, 0) / ring.length;
  const cy = ring.reduce((sum, p) => sum + p.y, 0) / ring.length;
  const a = ring[0] as Point;
  const b = ring[1] as Point;
  const d = ring[3] as Point;
  const ul = Math.hypot(b.x - a.x, b.y - a.y);
  const vl = Math.hypot(d.x - a.x, d.y - a.y);
  const ux = (b.x - a.x) / ul;
  const uy = (b.y - a.y) / ul;
  const vx = (d.x - a.x) / vl;
  const vy = (d.y - a.y) / vl;
  const hu = ul / 2 + by;
  const hv = vl / 2 + by;
  return [
    { x: cx - ux * hu - vx * hv, y: cy - uy * hu - vy * hv },
    { x: cx + ux * hu - vx * hv, y: cy + uy * hu - vy * hv },
    { x: cx + ux * hu + vx * hv, y: cy + uy * hu + vy * hv },
    { x: cx - ux * hu + vx * hv, y: cy - uy * hu + vy * hv },
  ];
}
