/**
 * The water a fire engine plays over a scene (spec section 20.3).
 *
 * `sim/emergency.ts` puts out whatever is within `HOSE_RANGE` of an engine at
 * work; this is how a player sees it happen. Water leaves a monitor on the
 * engine and falls on the scene in an arc, as a stream of drops. A drop
 * is placed from the tick alone — how far along the arc it is, and how far it
 * has spread from the line — so the stream is the same on every machine and in
 * a still frame.
 *
 * The drops of every engine in view are one instanced mesh, so a scene with
 * two engines at it costs one draw call, as one engine does.
 */
import { BoxGeometry, Color, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { HOSE_RANGE } from '../sim/emergency.ts';

/** Drops in one engine's stream. */
const DROPS = 72;

/** Ticks a drop takes from the monitor to the ground. */
const FLIGHT_TICKS = 45;

/** Metres the arc rises over the straight line, as a share of how far it throws, and at least. */
const ARC_SHARE = 0.22;
const ARC_LEAST = 1.5;

/** Metres a drop spreads from the line by the time it lands. */
const SPREAD = 2.2;

/** Metres across a drop leaving the monitor and landing. */
const DROP_START = 0.07;
const DROP_END = 0.3;

/** Metres short of the engine a stream never falls: it plays over the scene, not over its own roof. */
const NEAREST = 4;

/** A number from 0 to 1 for a drop and an axis, the same on every machine. */
function scatter(drop: number, axis: number): number {
  const s = Math.sin(drop * 12.9898 + axis * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export class HoseSpray {
  readonly mesh: InstancedMesh;
  private count = 0;
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly size = new Vector3();

  /** A spray for up to `engines` engines at work at once. */
  constructor(engines: number) {
    const material = new MeshStandardMaterial({
      color: new Color(0xd6ecff),
      roughness: 0.15,
      metalness: 0,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    this.mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material, engines * DROPS);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Start a frame with no water in the air. */
  begin(): void {
    this.count = 0;
  }

  /**
   * One engine's stream from a monitor at `from` to the ground at a place,
   * which is brought inside the hose's reach. `engine` keys the stream so two
   * engines side by side do not spray in step.
   */
  add(engine: number, tick: number, from: Vector3, toX: number, toY: number, ground: number): void {
    if (this.count + DROPS > this.mesh.instanceMatrix.count) return;
    let dx = toX - from.x;
    let dy = toY - from.z;
    let reach = Math.hypot(dx, dy);
    // A scene right under the engine is hosed from the side, and one past the
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
      const t = ((tick + engine * 17) / FLIGHT_TICKS + i / DROPS) % 1;
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
