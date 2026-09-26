/**
 * A place beside a road rather than on it: the pavement a person stands on to
 * watch the street.
 *
 * `nearestRoadPlace` answers the middle of the carriageway, which is right for
 * a car and wrong for a person. Someone who stands still there stands in the
 * traffic. This moves the answer across the road to the middle of the
 * pavement, on the side the point was asked from, and turns it to face the
 * road. The dealers of spec section 16.2 stand here.
 *
 * A road with a pavement is taken over a nearer one without, while it is
 * no more than {@link PAVED_DETOUR} farther away: a corner is worked from a
 * pavement, not from an alley or the edge of a dirt track. Where the roads
 * near the point have no pavement, the person stands a step off the edge of
 * the carriageway instead.
 *
 * Near a junction the pavement of one road can be the carriageway of the next.
 * A place that lands on any carriageway is refused, the far side is tried, and
 * where both are in a road there is no answer.
 *
 * Pure, and one pass over the roads per call. It is asked a few times per
 * district when a session starts, not every tick.
 */
import { atan2, cos, hypot, sin } from '../../core/libm.ts';
import { nearestRoadSpot, type RoadPlace } from '../terrain/surface.ts';
import { TIERS } from './tiers.ts';
import type { Point, RoadTier, WorldDescription } from '../types.ts';

/** Metres farther a road with a pavement may be than the nearest road, and still be taken. */
const PAVED_DETOUR = 40;

/** Metres off the edge of a carriageway a person stands where the road has no pavement. */
const VERGE_STEP = 1.2;

/** Metres of clear ground a place keeps from the edge of any carriageway. */
const CLEAR = 0.5;

/**
 * The middle of the pavement nearest a point, facing the road, or undefined
 * where there is no road at all or no clear ground beside the one found.
 * `heading` points from the place toward the road.
 */
export function kerbsidePlace(world: WorldDescription, x: number, y: number): RoadPlace | undefined {
  const any = nearestRoadSpot(world, x, y);
  if (any === undefined) return undefined;
  const paved = nearestRoadSpot(world, x, y, (tier) => TIERS[tier].pavement > 0);
  const near = (spot: { x: number; y: number }) => hypot(spot.x - x, spot.y - y);
  const spot = paved !== undefined && near(paved) <= near(any) + PAVED_DETOUR ? paved : any;
  const away = besideRoad(spot.tier);
  const acrossX = -sin(spot.heading);
  const acrossY = cos(spot.heading);
  // The side the point was asked from first, since that is the district's side.
  const first = acrossX * (x - spot.x) + acrossY * (y - spot.y) < 0 ? -1 : 1;
  for (const side of [first, -first]) {
    const px = spot.x + acrossX * side * away;
    const py = spot.y + acrossY * side * away;
    if (onCarriageway(world, px, py)) continue;
    return { x: px, y: py, heading: atan2(-acrossY * side, -acrossX * side) };
  }
  return undefined;
}

/** Metres from a road's centreline to where a person stands beside it. */
function besideRoad(tier: RoadTier): number {
  const spec = TIERS[tier];
  const edge = spec.width / 2 + spec.verge;
  return spec.pavement > 0 ? edge + spec.pavement / 2 : edge + VERGE_STEP;
}

/**
 * True where a point is on the carriageway of any road at ground level, or too
 * close to its edge. A deck overhead and a bore underneath are not in the way.
 */
export function onCarriageway(world: WorldDescription, x: number, y: number): boolean {
  for (const road of world.roads) {
    const reach = TIERS[road.tier].width / 2 + CLEAR;
    for (let i = 0; i + 1 < road.points.length; i++) {
      if (road.bridges.includes(i) || road.tunnels.includes(i)) continue;
      const a = road.points[i] as Point;
      const b = road.points[i + 1] as Point;
      if (distanceToSegment(x, y, a, b) < reach) return true;
    }
  }
  return false;
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const length2 = vx * vx + vy * vy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / length2));
  return hypot(a.x + vx * t - x, a.y + vy * t - y);
}
