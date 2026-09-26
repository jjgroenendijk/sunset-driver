/**
 * The traffic lights, drawn (spec section 13.1).
 *
 * Every approach to a signalled junction has one head: a pole on the kerb to
 * the right of the arriving traffic, an arm out over its lanes, and a housing
 * with three lenses facing it. The lenses stand proud of the housing, so a
 * camera above the street sees the lit one from the top.
 *
 * All the heads in view are two instanced meshes: the frames, and the lenses,
 * whose instance colour is lit or dark by what `signals.ts` says the light is
 * at the moment the frame is drawn. Nothing here is state; the lights are read
 * from the tick.
 */
import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Light, SignalApproach, SignalJunction, TrafficSignals } from '../../sim/traffic/signals.ts';
import { tinted } from '../look/tint.ts';

/** Metres each way of the point the frame is drawn round that signal heads are drawn in. */
const SIGNAL_VIEW = 180;

/** Heads drawn at most. A frame with more leaves the rest out. */
const HEAD_CAP = 96;

/** Metres out from the kerb the pole stands, on the pavement. */
export const POLE_OUT = 0.8;
/** Metres the arm reaches from the pole over the carriageway. */
export const ARM_REACH = 4;
const POLE_HEIGHT = 5.6;
const HOUSING_Y = 4.8;

/** The three lenses top to bottom: the light each shows, and its height. */
const LENSES: readonly { light: Light; y: number; lit: number; dark: number }[] = [
  { light: 'red', y: HOUSING_Y + 0.38, lit: 0xff2a1f, dark: 0x3a1210 },
  { light: 'amber', y: HOUSING_Y, lit: 0xffb020, dark: 0x3a2a10 },
  { light: 'green', y: HOUSING_Y - 0.38, lit: 0x30ff70, dark: 0x103a1c },
];

const FRAME_COLOUR = 0x3a3a6a;

/**
 * The pole, the arm and the housing of one head, in the head's own frame: the
 * pole's foot at the origin, `+x` the way the arriving traffic drives, `+z` to
 * its right, `+y` up. Headless: no renderer is needed.
 */
export function signalFrame(): BufferGeometry {
  const parts = [
    box(0.22, POLE_HEIGHT, 0.22, 0, POLE_HEIGHT / 2, 0),
    box(0.16, 0.16, ARM_REACH, 0, POLE_HEIGHT - 0.2, -ARM_REACH / 2),
    box(0.45, 1.25, 0.5, 0, HOUSING_Y, -ARM_REACH),
  ];
  const geometry = mergeGeometries(parts) as BufferGeometry;
  for (const part of parts) part.dispose();
  return geometry;
}

export class SignalView {
  readonly group = new Group();
  private readonly signals: TrafficSignals;
  private readonly frames: InstancedMesh;
  private readonly lenses: InstancedMesh;
  private readonly frameMaterial = new MeshStandardMaterial({ color: FRAME_COLOUR, roughness: 0.6, metalness: 0.3 });
  private readonly lensMaterial = new MeshBasicMaterial({ toneMapped: false });
  private readonly head = new Matrix4();
  private readonly offset = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);
  private readonly colour = new Color();

  constructor(signals: TrafficSignals) {
    this.signals = signals;
    this.frames = new InstancedMesh(signalFrame(), this.frameMaterial, HEAD_CAP);
    this.frames.castShadow = true;
    this.frames.receiveShadow = true;
    this.lenses = tinted(new InstancedMesh(new BoxGeometry(0.34, 0.32, 0.4), this.lensMaterial, HEAD_CAP * LENSES.length));
    for (const mesh of [this.frames, this.lenses]) {
      // The instances are spread over hundreds of metres; the geometry's own bounds say nothing about them.
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
    }
  }

  /** How many heads the last frame drew. */
  get drawn(): number {
    return this.frames.count;
  }

  /** Draw the heads round a place as they stand at a moment, which may fall between two ticks. */
  update(time: number, x: number, y: number): void {
    let count = 0;
    for (const junction of this.signals.junctions) {
      if (Math.abs(junction.x - x) > SIGNAL_VIEW || Math.abs(junction.y - y) > SIGNAL_VIEW) continue;
      count = this.addJunction(junction, time, count);
    }
    this.frames.count = count;
    this.lenses.count = count * LENSES.length;
    for (const mesh of [this.frames, this.lenses]) {
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
    if (count > 0 && this.lenses.instanceColor !== null) this.lenses.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.frames, this.lenses]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.frameMaterial.dispose();
    this.lensMaterial.dispose();
    this.group.clear();
  }

  private addJunction(junction: SignalJunction, time: number, count: number): number {
    for (const index of junction.approaches) {
      if (count >= HEAD_CAP) return count;
      const approach = this.signals.approaches[index] as SignalApproach;
      const light = this.signals.light(approach, time);
      // The right hand of the arriving traffic, which is where the kerb it passes is.
      const out = approach.kerb + POLE_OUT;
      const rx = -Math.sin(approach.heading);
      const ry = Math.cos(approach.heading);
      this.at.set(approach.x + rx * out, approach.height, approach.y + ry * out);
      this.turn.setFromAxisAngle(this.up, -approach.heading);
      this.head.compose(this.at, this.turn, this.one);
      this.frames.setMatrixAt(count, this.head);
      for (let i = 0; i < LENSES.length; i++) {
        const lens = LENSES[i] as (typeof LENSES)[number];
        // On the face the traffic sees, standing proud of the housing.
        this.offset.makeTranslation(-0.25, lens.y, -ARM_REACH);
        this.lenses.setMatrixAt(count * LENSES.length + i, this.offset.premultiply(this.head));
        this.lenses.setColorAt(count * LENSES.length + i, this.colour.set(lens.light === light ? lens.lit : lens.dark));
      }
      count++;
    }
    return count;
  }
}

function box(width: number, height: number, depth: number, x: number, y: number, z: number): BufferGeometry {
  const geometry = new BoxGeometry(width, height, depth).toNonIndexed();
  geometry.translate(x, y, z);
  return geometry;
}
