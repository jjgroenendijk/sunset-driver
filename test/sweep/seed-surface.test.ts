import { expect, it } from 'vitest';
import { SURFACE_RAISE, roadSection } from '../../src/render/roads/road-section.ts';
import { junctionShape, type JunctionVertex } from '../../src/world/junctions/junction-shape.ts';
import type { JunctionMap, RoadGap } from '../../src/world/junctions/junctions.ts';
import { RoadRibbons, type RoadFrame } from '../../src/world/carve/ribbon.ts';
import type { Point, WorldDescription } from '../../src/world/types.ts';
import { FOOTPRINT_COUNT, SURFACE_ABOVE, SURFACE_STRIDE } from './seed-limits.ts';
import { chunkCrowdedAt, chunkGroundAt } from './seed-probes.ts';
import { bedsOf, carveOf, junctionsOf, seeds, worlds } from './seed-fixture.ts';
import { sweepSuite } from './seed-suite.ts';

/**
 * The seed sweep of spec sections 6.2 and 7.1 on the surface the roads draw:
 * the ground never stands through it.
 *
 * The road loft, the junction mesh and the carve all read one surface height
 * function (`bed.ts`). This asks the ground as a chunk draws it — off the grid
 * anchored on the origin — against the surface at every vertex a road or a
 * junction draws, and at the middle of the triangles between them.
 *
 * Ground two claimants ask different heights of is left out, as the carve check
 * of `seed-ground.test.ts` leaves it out: one grid holds one height there, and the
 * road network put the two roads in one place. The ground is read off the four
 * samples around a place, so one crowded sample is enough to leave it out.
 */
sweepSuite('road surface', () => {
  it('never has the ground stand through a road or a junction', () => {
    for (const seed of seeds.slice(0, FOOTPRINT_COUNT)) {
      const w = worlds.get(seed) as WorldDescription;
      const carve = carveOf(seed);
      const junctions = junctionsOf(seed);
      const ribbons = new RoadRibbons(bedsOf(seed), w.roads);
      let complaint: string | undefined;
      let faults = 0;
      let asked = 0;
      /** Ask one place: the surface drawn there, against the ground under it. */
      const ask = (x: number, y: number, surface: number, where: string): void => {
        if (chunkCrowdedAt(carve, x, y)) return;
        asked++;
        const above = chunkGroundAt(carve, x, y) - surface;
        if (above <= SURFACE_ABOVE) return;
        faults++;
        complaint ??= `${where} at ${x.toFixed(1)},${y.toFixed(1)} has the ground ${above.toFixed(2)} m above it`;
      };

      askJunctions(junctions, ribbons, ask);
      askRoads(w, junctions, ribbons, ask);
      expect(asked, `seed ${seed}`).toBeGreaterThan(0);
      if (faults > 0) complaint = `${faults} of ${asked} places: ${complaint}`;
      expect(complaint, `seed ${seed}`).toBeUndefined();
    }
  });
});

/** Asks one place: the surface drawn there, against the ground under it. */
type Ask = (x: number, y: number, surface: number, where: string) => void;

/** Asks every corner of one junction in `SURFACE_STRIDE`, and the middle of each triangle of its fan. */
function askJunctions(junctions: JunctionMap, ribbons: RoadRibbons, ask: Ask): void {
  for (let j = 0; j < junctions.junctions.length; j += SURFACE_STRIDE) {
    const junction = junctions.junctions[j] as JunctionMap['junctions'][number];
    const shape = junctionShape(junction, ribbons);
    if (shape.centre === undefined) continue;
    const where = `junction ${junction.node}`;
    const drawn = (v: JunctionVertex): number => (v.bed as number) + SURFACE_RAISE;
    // The carriageway is a fan from the node, so each triangle's middle
    // stands at the mean of its three corners.
    const centre = shape.centre + SURFACE_RAISE;
    const fan = shape.carriageway;
    for (let i = 0; i < fan.length; i++) {
      const a = fan[i] as JunctionVertex;
      const b = fan[(i + 1) % fan.length] as JunctionVertex;
      ask(a.x, a.y, drawn(a), where);
      const x = (junction.x + a.x + b.x) / 3;
      const y = (junction.y + a.y + b.y) / 3;
      ask(x, y, (centre + drawn(a) + drawn(b)) / 3, `${where} carriageway`);
    }
  }
}

/** Asks the cross section of one road segment on the ground in `SURFACE_STRIDE`, at both ends and between. */
function askRoads(w: WorldDescription, junctions: JunctionMap, ribbons: RoadRibbons, ask: Ask): void {
  let step = 0;
  for (const road of w.roads) {
    const section = roadSection(road.tier).filter((s) => s.rise >= 0);
    const gaps = junctions.gaps[road.id] ?? [];
    const structures = new Set([...road.bridges, ...road.tunnels]);
    for (let i = 0; i + 1 < road.points.length; i++) {
      if (structures.has(i) || step++ % SURFACE_STRIDE !== 0) continue;
      const a = road.points[i] as Point;
      const b = road.points[i + 1] as Point;
      // The frames a loft of this segment starts and ends on.
      const from = ribbons.frameAt(road.id, i, a.x, a.y);
      const to = ribbons.frameAt(road.id, i, b.x, b.y);
      // A segment a junction takes any of is drawn from the gap's cut,
      // which the junction checks already ask.
      if (gaps.some((gap) => overlaps(gap, from.distance, to.distance))) continue;
      const where = `${road.tier} ${road.id} segment ${i}`;
      for (const s of section) {
        const p = vertex(a, from, s.across, s.rise);
        const q = vertex(b, to, s.across, s.rise);
        ask(p.x, p.y, p.h, where);
        ask(q.x, q.y, q.h, where);
        // The loft is straight between the two sections.
        ask((p.x + q.x) / 2, (p.y + q.y) / 2, (p.h + q.h) / 2, `${where} between its sections`);
      }
    }
  }
}

/** Where one point of a road's cross section is drawn: as `place` in `road-section.ts` puts it. */
function vertex(point: Point, frame: RoadFrame, across: number, rise: number): { x: number; y: number; h: number } {
  const off = across * frame.mitre;
  return { x: point.x + frame.acrossX * off, y: point.y + frame.acrossY * off, h: frame.height + frame.bank * off + rise };
}

/** True where a gap takes any of the stretch between two distances along its curve. */
function overlaps(gap: RoadGap, from: number, to: number): boolean {
  return gap.from.distance < Math.max(from, to) && gap.to.distance > Math.min(from, to);
}
