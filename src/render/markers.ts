/**
 * The beam and the marker over a mission contact (spec section 18).
 *
 * A contact stands in the crowd's own mesh like a dealer does (`ui/givers.ts`),
 * so nothing about their body says they hand out work. This is what says it: a
 * column of light standing off the road they stand on, with a diamond turning
 * over their head, both in the amber the map marks them with — so the person a
 * flag on the map points at is the person on the street, and the corner reads
 * from the far end of it.
 *
 * Both turn amber while the contact will talk and dull grey while they will
 * not, which is the refusal of `giver.ts` read before the player has walked
 * over to hear it: a player who has a job in hand, who is driving, or whom the
 * faction has crossed off sees every marker go dull.
 *
 * Each is one instanced mesh, so the whole city's contacts cost two draw calls
 * however many of them are in view. The beam is added over the scene rather
 * than lit, as the light of a police bar is (`beacons.ts`): a point light turns
 * the clustered path on for every fragment in the city.
 */
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  OctahedronGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import { TICK_RATE } from '../sim/clock.ts';
import { tinted } from './tint.ts';

/** Metres each way of the point the frame is drawn round that a contact is marked in. */
const MARKER_VIEW = 110;

/** Metres across the diamond, and metres over the head it hangs. */
const MARKER_SIZE = 0.4;
const MARKER_LIFT = 0.6;

/** Metres the diamond rises and falls, and how many times a second it does it. */
const BOB_RISE = 0.12;
const BOB_RATE = 0.6;

/** Radians a second the diamond turns. */
const MARKER_SPIN = 1.3;

/**
 * Metres across the beam and metres it stands. It is wider than a person, so
 * the body is inside the light rather than beside it, and tall enough to read
 * over a parked van from the camera of spec section 10.7.
 */
const BEAM_WIDE = 1.5;
const BEAM_TALL = 9;

/** Metres over the road the beam starts, so its foot is not buried in a slope. */
const BEAM_FOOT = 0.05;

/** How hard the beam is added over the scene, which is far less than the diamond burns. */
const BEAM_GLOW = 0.5;

/**
 * The amber `map.ts` marks a contact with, how hard the diamond burns while
 * they will talk, and how dull both go when they will not. Open, the diamond is
 * just over the bloom threshold of `post.ts`, so it glows after dark without
 * washing white.
 */
const MARKER_COLOUR = 0xffb03a;
const MARKER_OPEN = 1.35;
const MARKER_SHUT = 0.3;

/** A contact, as the frame marks them. */
export interface ContactMark {
  x: number;
  y: number;
  /** Metres the road under them stands at, which is where the beam starts. */
  ground: number;
  /** Metres the diamond hangs at, which is the ground under them plus their height. */
  top: number;
  /** Whether they will talk to the player as they stand now. */
  open: boolean;
}

/** A column bright at the foot and black at the head, which added over the scene is a beam of light. */
function beamColumn(): BufferGeometry {
  const geometry = new CylinderGeometry(0.5, 0.5, 1, 16, 1, true);
  geometry.translate(0, 0.5, 0);
  const position = geometry.getAttribute('position');
  const shade = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    // The column is a unit tall, so the height of a vertex is how far up it is.
    const fade = 1 - position.getY(i);
    shade.set([fade, fade, fade], i * 3);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(shade, 3));
  return geometry;
}

export class ContactMarkers {
  readonly group = new Group();
  /** The contacts this marks. Whoever owns them writes the list; it is never replaced. */
  marks: readonly ContactMark[] = [];
  private readonly diamonds: InstancedMesh;
  private readonly beams: InstancedMesh;
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly flat = new Quaternion();
  private readonly axis = new Vector3(0, 1, 0);
  private readonly size = new Vector3(MARKER_SIZE, MARKER_SIZE * 1.8, MARKER_SIZE);
  private readonly column = new Vector3(BEAM_WIDE, BEAM_TALL, BEAM_WIDE);
  private readonly colour = new Color();

  /** A pool for up to `cap` contacts in view at once. */
  constructor(cap: number) {
    const room = Math.max(1, cap);
    // Past the tone map, so the amber is the amber of the map at any exposure.
    const solid = new MeshBasicMaterial({ color: MARKER_COLOUR, toneMapped: false });
    this.diamonds = tinted(new InstancedMesh(new OctahedronGeometry(1, 0), solid, room));
    const glow = new MeshBasicMaterial({
      color: MARKER_COLOUR,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    this.beams = tinted(new InstancedMesh(beamColumn(), glow, room));
    for (const mesh of [this.diamonds, this.beams]) {
      // The markers are spread over the view; one marker's own bounds say
      // nothing about the rest.
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      this.group.add(mesh);
    }
  }

  /**
   * Turn the markers of the contacts round a place, at a moment that may fall
   * between two ticks. Called once a frame.
   */
  update(moment: number, x: number, y: number): void {
    const seconds = moment / TICK_RATE;
    const bob = Math.sin(seconds * BOB_RATE * Math.PI * 2) * BOB_RISE;
    this.turn.setFromAxisAngle(this.axis, seconds * MARKER_SPIN);
    let count = 0;
    for (const mark of this.marks) {
      if (count >= this.diamonds.instanceMatrix.count) break;
      if (Math.abs(mark.x - x) > MARKER_VIEW || Math.abs(mark.y - y) > MARKER_VIEW) continue;
      const burn = mark.open ? MARKER_OPEN : MARKER_SHUT;
      this.at.set(mark.x, mark.top + MARKER_LIFT + bob, mark.y);
      this.matrix.compose(this.at, this.turn, this.size);
      this.diamonds.setMatrixAt(count, this.matrix);
      this.diamonds.setColorAt(count, this.colour.setRGB(burn, burn, burn));
      this.at.set(mark.x, mark.ground + BEAM_FOOT, mark.y);
      this.matrix.compose(this.at, this.flat, this.column);
      this.beams.setMatrixAt(count, this.matrix);
      const lit = burn * BEAM_GLOW;
      this.beams.setColorAt(count, this.colour.setRGB(lit, lit, lit));
      count++;
    }
    for (const mesh of [this.diamonds, this.beams]) {
      if (count === 0 && mesh.count === 0) continue;
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of [this.diamonds, this.beams]) {
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
      mesh.dispose();
    }
    this.group.clear();
  }
}
