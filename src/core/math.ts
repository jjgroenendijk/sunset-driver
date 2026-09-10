export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
