/**
 * The bus stops, drawn (spec sections 9.2, 20.2).
 *
 * A stop is a post with a flag sign on it, and at the busiest of them a
 * shelter behind the post as well. Both are grown in code from boxes, as the
 * lamps of `lamp-mesh.ts` are, and drawn as instances of one geometry each, so
 * every stop in view costs two draws however many there are.
 *
 * A stop is not chunk furniture, because it is not a function of the world:
 * where the buses of `bus.ts` call is a function of the routes they walk. So
 * the posts are drawn round the player from `BusStops`, the way the traffic
 * and the trams are, rather than built into the chunk they stand in. The
 * people at the stop are drawn with the crowd (`pedestrians.ts`).
 *
 * A stop never moves, so `update` takes the place the frame is drawn round and
 * no moment. It writes its matrices every frame all the same: `needsUpdate` on
 * an instance matrix uploads the whole buffer, which is why `parked.ts` holds
 * its uploads back, but {@link STOP_DRAW_CAP} posts is a few kilobytes rather
 * than the megabyte a full car park costs.
 */
import { Group, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type BufferGeometry, type InstancedMesh } from 'three';
import { SHELTER_RIDERS, type BusStop, type BusStops } from '../sim/bus-stops.ts';
import { boxOf, coloured, instanced, merged, TRAFFIC_VIEW } from './traffic.ts';
import { GLASS, METAL } from './vehicle-mesh.ts';

/** Metres each way of the point the frame is drawn round that stops are drawn in. */
export const STOP_VIEW = TRAFFIC_VIEW;

/** Stops drawn at most. A frame with more in view leaves the rest out. */
export const STOP_DRAW_CAP = 96;

/** The livery of a stop: the post and the sign plate, and the roof over a shelter. */
const POST_PAINT = 0x2e8c8a;
const SIGN_FACE = 0xf2efe6;

/**
 * Metres from the middle of the pavement to the post, towards the road. The
 * frame of a stop has `+x` pointing out of the pavement at the carriageway,
 * so the shelter behind the post is at negative `x`, and everything stays
 * inside the narrowest pavement a bus route runs along.
 */
const POST_X = 1.05;
const POST_HEIGHT = 2.35;
const POST_THICK = 0.12;

/** The flag sign on top of the mast: the plate, and the face that stands proud of it. */
const FLAG_HEIGHT = 0.48;
const FLAG_WIDTH = 0.44;

/** One box of a stop, in the stop's own frame: `+x` at the road, `+y` up from the pavement. */
interface StopBox {
  length: number;
  height: number;
  width: number;
  x: number;
  y: number;
  z: number;
  colour: number;
}

function box(length: number, height: number, width: number, x: number, y: number, z: number, colour: number): StopBox {
  return { length, height, width, x, y, z, colour };
}

/**
 * The post every stop carries. The flag sits on top of the mast rather than
 * across it, because a face the mast runs through reads as two white bars.
 */
export function postBoxes(): StopBox[] {
  const flag = POST_HEIGHT + FLAG_HEIGHT / 2;
  return [
    box(POST_THICK, POST_HEIGHT, POST_THICK, POST_X, POST_HEIGHT / 2, 0, POST_PAINT),
    box(0.06, FLAG_HEIGHT, FLAG_WIDTH, POST_X, flag, 0, POST_PAINT),
    box(0.1, FLAG_HEIGHT - 0.18, FLAG_WIDTH - 0.16, POST_X, flag, 0, SIGN_FACE),
  ];
}

/** The shelter the busiest stops carry, standing behind the post and away from the road. */
export function shelterBoxes(): StopBox[] {
  const glass = 1.85;
  return [
    box(1.75, 0.1, 3.2, -0.35, 2.36, 0, METAL),
    box(0.07, glass, 3.2, -1.15, glass / 2 + 0.35, 0, GLASS),
    box(1.6, glass, 0.06, -0.35, glass / 2 + 0.35, 1.58, GLASS),
    box(1.6, glass, 0.06, -0.35, glass / 2 + 0.35, -1.58, GLASS),
    box(0.1, 2.31, 0.1, 0.42, 1.155, 1.55, METAL),
    box(0.1, 2.31, 0.1, 0.42, 1.155, -1.55, METAL),
    box(0.5, 0.08, 2.4, -0.88, 0.46, 0, METAL),
  ];
}

/** The geometry of one post and of one shelter, each with its colours on its vertices. */
export function busStopParts(): { post: BufferGeometry; shelter: BufferGeometry } {
  const grow = (parts: StopBox[]): BufferGeometry => merged(parts.map((part) => coloured(boxOf(part), part.colour)));
  return { post: grow(postBoxes()), shelter: grow(shelterBoxes()) };
}

export class BusStopView {
  readonly group = new Group();
  private readonly stops: BusStops;
  private readonly post: InstancedMesh;
  private readonly shelter: InstancedMesh;
  private readonly material: MeshStandardMaterial;
  private readonly found: BusStop[] = [];
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor(stops: BusStops) {
    this.stops = stops;
    const parts = busStopParts();
    this.material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 });
    const cap = Math.max(1, Math.min(STOP_DRAW_CAP, stops.count));
    this.post = instanced(parts.post, this.material, true, cap);
    this.shelter = instanced(parts.shelter, this.material, true, cap);
    this.group.add(this.post, this.shelter);
  }

  /** How many posts the last frame drew. */
  get drawn(): number {
    return this.post.count;
  }

  /** Stand a post at every stop round a place, and a shelter at the busy ones. */
  update(x: number, y: number): void {
    const found = this.stops.near(x - STOP_VIEW, y - STOP_VIEW, x + STOP_VIEW, y + STOP_VIEW, this.found);
    let posts = 0;
    let shelters = 0;
    for (let i = 0; i < found && posts < this.post.instanceMatrix.count; i++) {
      const stop = this.found[i] as BusStop;
      this.at.set(stop.x, stop.height, stop.y);
      this.turn.setFromAxisAngle(this.up, -stop.heading);
      this.matrix.compose(this.at, this.turn, this.one);
      this.post.setMatrixAt(posts++, this.matrix);
      if (stop.riders >= SHELTER_RIDERS) this.shelter.setMatrixAt(shelters++, this.matrix);
    }
    this.write(this.post, posts);
    this.write(this.shelter, shelters);
  }

  dispose(): void {
    for (const mesh of [this.post, this.shelter]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
    this.group.clear();
  }

  private write(mesh: InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count > 0) mesh.instanceMatrix.needsUpdate = true;
  }
}
