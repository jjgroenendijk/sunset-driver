/**
 * Where the frame shows an edge of what is drawn (spec section 9.2).
 *
 * Everything the game draws stops somewhere: the traffic at a square round the
 * player, the facades at the first ring of chunks, the city at the far ring. An
 * edge off the screen costs the player nothing. An edge on the screen is where
 * things pop in, and how far from the camera it stands is how badly they pop.
 *
 * This answers that as a number rather than by eye. The ground round the camera
 * is sampled, and each point that falls on the screen inside the haze is a
 * ground point in sight. The nearest one past an edge is where that edge shows.
 * The profiler (`scripts/render-profile.ts`) and the frame watch of
 * `frame-watch.ts` both read it.
 *
 * The ground is taken as flat, at the height of the player's feet. A hill
 * moves a point by a few metres, and the question is tens of metres.
 */
import { Vector3, type PerspectiveCamera } from 'three';
import { CHUNK_SIZE, chunkAt } from '../../world/chunks.ts';

/** One ground point the camera sees: where it is, and metres from the camera. */
export interface GroundPoint {
  x: number;
  y: number;
  range: number;
}

/**
 * The ground is sampled on a polar grid round the foot of the camera: a spoke
 * every two degrees, and along each spoke a step that grows with the distance.
 * A grid of rays spread evenly over the screen would not do: near the horizon
 * one row of pixels spans hundreds of metres, and the edges stand there.
 */
const SPOKES = 180;
const FIRST_STEP = 2;
const GROWTH = 0.03;

const point = new Vector3();

/**
 * The ground points the camera sees, out to `reach` metres from it. A point past
 * `reach` is left out: the haze has closed there, so nothing past it shows.
 * What stands between the camera and a point is not asked about; the city is
 * taken as seen through, which is the worst case for an edge.
 */
export function groundInSight(camera: PerspectiveCamera, groundY: number, reach: number): GroundPoint[] {
  camera.updateMatrixWorld();
  const eye = camera.position;
  const drop = eye.y - groundY;
  const out: GroundPoint[] = [];
  for (let s = 0; s < SPOKES; s++) {
    const angle = (s / SPOKES) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let d = FIRST_STEP; ; d += Math.max(FIRST_STEP, d * GROWTH)) {
      const range = Math.hypot(d, drop);
      if (range > reach) break;
      const x = eye.x + cos * d;
      const y = eye.z + sin * d;
      point.set(x, groundY, y).applyMatrix4(camera.matrixWorldInverse);
      if (point.z > -camera.near) continue;
      point.applyMatrix4(camera.projectionMatrix);
      if (Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
      out.push({ x, y, range });
    }
  }
  return out;
}

/**
 * Metres from the camera to the nearest ground point in sight that `beyond`
 * says lies past an edge, or `Infinity` when the edge is off the screen.
 */
export function edgeInSight(sight: readonly GroundPoint[], beyond: (x: number, y: number) => boolean): number {
  let nearest = Infinity;
  for (const point of sight) if (point.range < nearest && beyond(point.x, point.y)) nearest = point.range;
  return nearest;
}

/** Past a square `metres` each way of `(atX, atY)`: how the traffic, the parked cars and the crowd are cut. */
export function pastSquare(atX: number, atY: number, metres: number): (x: number, y: number) => boolean {
  return (x, y) => Math.max(Math.abs(x - atX), Math.abs(y - atY)) > metres;
}

/** Past a circle of `metres` round `(atX, atY)`: how the fade of `fade.ts` ends the plants and the lamps. */
export function pastCircle(atX: number, atY: number, metres: number): (x: number, y: number) => boolean {
  return (x, y) => (x - atX) ** 2 + (y - atY) ** 2 > metres * metres;
}

/** Past `rings` rings of chunks round the chunk `(atX, atY)` stands in: how the streaming rings are cut. */
export function pastRing(atX: number, atY: number, rings: number): (x: number, y: number) => boolean {
  const here = chunkAt(atX, atY);
  return (x, y) => {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    return Math.max(Math.abs(cx - here.cx), Math.abs(cy - here.cy)) > rings;
  };
}
