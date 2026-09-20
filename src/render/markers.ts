/**
 * The marker over a mission contact's head (spec section 18).
 *
 * A contact stands in the crowd's own mesh like a dealer does (`ui/givers.ts`),
 * so nothing about their body says they hand out work. This is what says it: a
 * small diamond turning over their head, in the amber the map marks them with,
 * so the person a flag on the map points at is the person on the street.
 *
 * It turns amber while the contact will talk and dull grey while they will not,
 * which is the refusal of `giver.ts` read before the player has walked over to
 * hear it: a player who has a job in hand, who is driving, or whom the faction
 * has crossed off sees every marker go dull.
 *
 * Every marker in view is one instance of one mesh, so the whole city's
 * contacts cost one draw call.
 */
import { Color, InstancedMesh, Matrix4, MeshBasicMaterial, OctahedronGeometry, Quaternion, Vector3 } from 'three';
import { TICK_RATE } from '../sim/clock.ts';
import { tinted } from './tint.ts';

/** Metres each way of the point the frame is drawn round that a marker is drawn in. */
export const MARKER_VIEW = 110;

/** Metres across a marker, and metres over the head it hangs. */
const MARKER_SIZE = 0.4;
const MARKER_LIFT = 0.6;

/** Metres a marker rises and falls, and how many times a second it does it. */
const BOB_RISE = 0.12;
const BOB_RATE = 0.6;

/** Radians a second a marker turns. */
const MARKER_SPIN = 1.3;

/**
 * The amber `map.ts` marks a contact with, how hard it burns while they will
 * talk, and how dull it goes when they will not. Open, it is just over the
 * bloom threshold of `post.ts`, so it glows after dark without washing white.
 */
const MARKER_COLOUR = 0xffb03a;
const MARKER_OPEN = 1.35;
const MARKER_SHUT = 0.3;

/** A contact, as the frame draws the marker over them. */
export interface ContactMark {
  x: number;
  y: number;
  /** Metres the marker hangs at, which is the ground under them plus their height. */
  top: number;
  /** Whether they will talk to the player as they stand now. */
  open: boolean;
}

export class ContactMarkers {
  readonly mesh: InstancedMesh;
  /** The contacts this draws. Whoever owns them writes the list; it is never replaced. */
  marks: readonly ContactMark[] = [];
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly axis = new Vector3(0, 1, 0);
  private readonly size = new Vector3(MARKER_SIZE, MARKER_SIZE * 1.8, MARKER_SIZE);
  private readonly colour = new Color();

  /** A pool for up to `cap` contacts in view at once. */
  constructor(cap: number) {
    // Past the tone map, so the amber is the amber of the map at any exposure.
    const material = new MeshBasicMaterial({ color: MARKER_COLOUR, toneMapped: false });
    this.mesh = tinted(new InstancedMesh(new OctahedronGeometry(1, 0), material, Math.max(1, cap)));
    // The markers are spread over the view; the diamond's own bounds say nothing about them.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /**
   * Turn the markers of the contacts round a place, at a moment that may fall
   * between two ticks. Called once a frame.
   */
  update(moment: number, x: number, y: number): void {
    const seconds = moment / TICK_RATE;
    const angle = seconds * MARKER_SPIN;
    const bob = Math.sin(seconds * BOB_RATE * Math.PI * 2) * BOB_RISE;
    this.turn.setFromAxisAngle(this.axis, angle);
    let count = 0;
    for (const mark of this.marks) {
      if (count >= this.mesh.instanceMatrix.count) break;
      if (Math.abs(mark.x - x) > MARKER_VIEW || Math.abs(mark.y - y) > MARKER_VIEW) continue;
      this.at.set(mark.x, mark.top + MARKER_LIFT + bob, mark.y);
      this.matrix.compose(this.at, this.turn, this.size);
      this.mesh.setMatrixAt(count, this.matrix);
      const k = mark.open ? MARKER_OPEN : MARKER_SHUT;
      this.mesh.setColorAt(count, this.colour.setRGB(k, k, k));
      count++;
    }
    if (count === 0 && this.mesh.count === 0) return;
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}
