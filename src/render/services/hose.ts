/**
 * The hoses of a fire engine's crew and the water they play over a scene
 * (spec section 20.3).
 *
 * `sim/city/emergency.ts` puts out whatever is within `HOSE_RANGE` of an engine
 * while its crew have water on; this is how a player sees it happen. A hose
 * runs from the coupling on the engine's flank, along the road, to the nozzle
 * a firefighter holds (`fire-crew.ts`). Water leaves that nozzle and falls on
 * the scene in an arc, as a stream of drops. A drop is placed from the tick
 * alone — how far along the arc it is, and how far it has spread from the line
 * — so the stream is the same on every machine and in a still frame.
 *
 * The drops of every stream in view are one instanced mesh, and every length
 * of hose another, so a scene with two engines at it costs two draw calls, as
 * one engine does.
 */
import { BoxGeometry, Color, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { HOSE_RANGE } from '../../sim/city/emergency.ts';

/** Drops in one nozzle's stream. */
const DROPS = 72;

/** Ticks a drop takes from the monitor to the ground. */
const FLIGHT_TICKS = 45;

/** Metres the arc rises over the straight line, as a share of how far it throws, and at least. */
const ARC_SHARE = 0.22;
const ARC_LEAST = 1.5;

/** Metres a drop spreads from the line by the time it lands. A nozzle in two hands is a tight jet. */
const SPREAD = 1.2;

/** Metres across a drop leaving the monitor and landing. */
const DROP_START = 0.07;
const DROP_END = 0.3;

/** Metres short of the nozzle a stream never falls: it plays over the scene, not over the firefighter's boots. */
const NEAREST = 2;

/** A number from 0 to 1 for a drop and an axis, the same on every machine. */
function scatter(drop: number, axis: number): number {
  const s = Math.sin(drop * 12.9898 + axis * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Unit boxes drawn as one instanced mesh, filled again every frame: `begin`
 * empties it, the caller adds instances, and `commit` shows them.
 */
abstract class InstancedBoxes {
  readonly mesh: InstancedMesh;
  protected count = 0;
  protected readonly matrix = new Matrix4();
  protected readonly turn = new Quaternion();
  protected readonly size = new Vector3();

  protected constructor(material: MeshStandardMaterial, capacity: number, castShadow: boolean) {
    this.mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Start a frame with nothing drawn. */
  begin(): void {
    this.count = 0;
  }

  /** Show what was added this frame. */
  commit(): void {
    if (this.count === 0 && this.mesh.count === 0) return;
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
    this.mesh.dispose();
  }
}

/** The water in the air: every drop of every stream in view. */
export class HoseSpray extends InstancedBoxes {
  private readonly at = new Vector3();

  /** A spray for up to `nozzles` nozzles with water on at once. */
  constructor(nozzles: number) {
    const material = new MeshStandardMaterial({
      color: new Color(0xd6ecff),
      roughness: 0.15,
      metalness: 0,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    super(material, nozzles * DROPS, false);
  }

  /**
   * One nozzle's stream from `from` to the ground at a place, which is brought
   * inside the hose's reach. `nozzle` keys the stream so two side by side do
   * not spray in step.
   */
  add(nozzle: number, tick: number, from: Vector3, toX: number, toY: number, ground: number): void {
    if (this.count + DROPS > this.mesh.instanceMatrix.count) return;
    let dx = toX - from.x;
    let dy = toY - from.z;
    let reach = Math.hypot(dx, dy);
    // A scene right at the nozzle is hosed a stride ahead, and one past the
    // reach is hosed as far as the water goes.
    if (reach < NEAREST) {
      dx = reach > 0.01 ? (dx / reach) * NEAREST : NEAREST;
      dy = reach > 0.01 ? (dy / reach) * NEAREST : 0;
      reach = NEAREST;
    }
    if (reach > HOSE_RANGE) {
      dx *= HOSE_RANGE / reach;
      dy *= HOSE_RANGE / reach;
      reach = HOSE_RANGE;
    }
    const drop = ground - from.y;
    const rise = Math.max(ARC_LEAST, reach * ARC_SHARE);
    // Across the line, on the ground, for the spread.
    const acrossX = -dy / reach;
    const acrossY = dx / reach;
    for (let i = 0; i < DROPS; i++) {
      const t = ((tick + nozzle * 17) / FLIGHT_TICKS + i / DROPS) % 1;
      const wide = (scatter(i, 0) - 0.5) * SPREAD * t;
      const up = (scatter(i, 1) - 0.5) * SPREAD * 0.5 * t;
      this.at.set(
        from.x + dx * t + acrossX * wide,
        from.y + drop * t + 4 * rise * t * (1 - t) + up,
        from.z + dy * t + acrossY * wide,
      );
      const s = DROP_START + (DROP_END - DROP_START) * t;
      this.size.set(s, s, s);
      this.matrix.compose(this.at, this.turn, this.size);
      this.mesh.setMatrixAt(this.count++, this.matrix);
    }
  }

}

/** Metres across a hose. */
const HOSE_THICK = 0.13;

/** The colour of a hose: the pale canvas of a lay-flat line, which reads on dark tarmac. */
const HOSE_COLOUR = 0xd8c9a0;

/** The axis a stretch of hose is built along before it is turned. */
const X_AXIS = new Vector3(1, 0, 0);

/**
 * The hoses in view, each a chain of points (`fire-crew.ts`) drawn as a run of
 * thin boxes, one per stretch between two points. Every stretch is one
 * instance of one mesh.
 */
export class HoseLines extends InstancedBoxes {
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly mid = new Vector3();

  /** Lines for up to `stretches` stretches of hose at once. */
  constructor(stretches: number) {
    const material = new MeshStandardMaterial({ color: new Color(HOSE_COLOUR), roughness: 0.85, metalness: 0 });
    super(material, stretches, true);
  }

  /** One hose, as points of x, height and the map's y. */
  add(points: readonly number[]): void {
    for (let i = 3; i + 2 < points.length; i += 3) {
      if (this.count >= this.mesh.instanceMatrix.count) return;
      this.from.set(points[i - 3] as number, points[i - 2] as number, points[i - 1] as number);
      this.to.set(points[i] as number, points[i + 1] as number, points[i + 2] as number);
      this.mid.subVectors(this.to, this.from);
      const length = this.mid.length();
      if (length < 1e-3) continue;
      this.turn.setFromUnitVectors(X_AXIS, this.mid.divideScalar(length));
      this.mid.addVectors(this.from, this.to).multiplyScalar(0.5);
      // A little longer than the stretch, so two stretches at an angle meet without a gap.
      this.size.set(length + HOSE_THICK, HOSE_THICK, HOSE_THICK);
      this.mesh.setMatrixAt(this.count++, this.matrix.compose(this.mid, this.turn, this.size));
    }
  }

}
