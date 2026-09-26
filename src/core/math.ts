export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  return v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

/** Metres below which two points are the same place. */
const EPSILON = 1e-6;

/** The unit vector from one point to another; the x axis where they are the same place. */
export function direction(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  const len = dist(a.x, a.y, b.x, b.y);
  return len < EPSILON ? { x: 1, y: 0 } : { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

/**
 * `count` distinct indices into a list of `total` things, spread down it from
 * `offset`. They step by the share of the list one pick gets, so a few picks
 * out of many stand far apart rather than in a run, and the step is small
 * enough that no two of them meet. Asking for more than the list holds gives
 * every index once.
 */
export function spread(total: number, count: number, offset: number): number[] {
  const take = Math.min(count, total);
  if (take <= 0) return [];
  const stride = Math.floor(total / take);
  const out: number[] = [];
  for (let i = 0; i < take; i++) out.push((offset + i * stride) % total);
  return out;
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** Wrap an undirected direction to (-π/2, π/2]: θ and θ + π are the same line. */
export function wrapDirection(a: number): number {
  const half = Math.PI / 2;
  let r = a % Math.PI;
  if (r <= -half) r += Math.PI;
  if (r > half) r -= Math.PI;
  return r;
}

/** Angle between two undirected directions, in [0, π/2]. */
export function directionDelta(a: number, b: number): number {
  return Math.abs(wrapDirection(a - b));
}
