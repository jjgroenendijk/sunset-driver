/**
 * The beams the player's vehicle throws (spec sections 10.5, 13.4).
 *
 * One projector cone per headlamp of the class the player is in, aimed down the
 * road ahead of it. They are the only vehicle lights in the scene: a light is
 * paid for by every fragment it can reach, so the traffic gets lit lenses
 * (`vehicle-glow.ts`) and the car the camera sits behind gets the beams.
 *
 * The lights are made once and never added or removed, because changing a
 * scene's light list rebuilds the shader of every material in it. A class with
 * fewer headlamps than the pool holds parks the rest under the map, and by day
 * every cone is at intensity 0, which {@link LampLight} makes a branch the
 * fragment skips rather than a light it still pays for.
 */
import { Object3D, Quaternion, Vector3, type Scene } from 'three';
import type { VehicleSpec, VehicleState } from '../sim/vehicle.ts';
import { LampLight } from './lamp-light.ts';
import { LAMP, vehicleBoxes } from './vehicle-mesh.ts';

/**
 * Headlamps lit at once. No class of the roster carries more than two, and a
 * motorcycle carries one; the rest of the pool parks.
 */
export const HEADLIGHT_CAP = 2;

/** Candela of one beam at full night, and the near-white it burns. */
const HEADLIGHT_INTENSITY = 45;
const HEADLIGHT_COLOUR = 0xfff2d8;

/**
 * The beam: how far it reaches, how wide it opens, how soft its edge is and how
 * fast it dims with distance. A `ProjectorLight` throws a rectangle, which is
 * the shape a pair of dipped beams lays on a road; its penumbra reads the other
 * way round from a spotlight's, so a low number is the softer edge.
 */
const HEADLIGHT_REACH = 45;
const HEADLIGHT_ANGLE = 0.5;
const HEADLIGHT_PENUMBRA = 0.3;
const HEADLIGHT_DECAY = 2;

/**
 * Where the beam is aimed: metres ahead of the lamp, and metres below it. A
 * headlamp stands about half a metre over the road, so this dip lays the axis
 * of the beam on the road about 20 m ahead — dipped, as a car drives at night,
 * and far enough out that the pool is on the road ahead rather than a blown
 * white patch against the bumper. It also gives the cone an orientation to
 * project its rectangle in, which a beam pointing along its own up vector has
 * not got.
 */
const THROW = 20;
const DIP = 1;

/** Where an unused light of the pool is parked: under the map, burning nothing. */
const PARKED = -10000;

/** Where a class carries its headlamps, in the vehicle's own frame. */
export function headlampsOf(spec: VehicleSpec): Vector3[] {
  const out: Vector3[] = [];
  for (const box of vehicleBoxes(spec)) {
    if (box.colour !== LAMP) continue;
    if (out.length >= HEADLIGHT_CAP) break;
    out.push(new Vector3(box.x, box.y, box.z));
  }
  return out;
}

/** The beams of the player's vehicle: a fixed pool, standing on its headlamps. */
export class Headlights {
  readonly count = HEADLIGHT_CAP;
  private readonly lights: LampLight[] = [];
  private readonly targets: Object3D[] = [];
  private readonly scene: Scene;
  /** The class the lamp places were read for, so they are read again only when it changes. */
  private cls = '';
  private lamps: Vector3[] = [];
  private readonly turn = new Quaternion();
  private readonly at = new Vector3();
  private readonly aimed = new Vector3();

  constructor(scene: Scene) {
    this.scene = scene;
    for (let i = 0; i < HEADLIGHT_CAP; i++) {
      const light = new LampLight(
        HEADLIGHT_COLOUR,
        0,
        HEADLIGHT_REACH,
        HEADLIGHT_ANGLE,
        HEADLIGHT_PENUMBRA,
        HEADLIGHT_DECAY,
      );
      light.position.set(PARKED, PARKED, PARKED);
      // A cone that casts is a shadow pass each; the sun's cascades are the
      // shadow budget of spec section 10.5 and these stay out of it.
      light.castShadow = false;
      const target = new Object3D();
      target.position.set(PARKED, PARKED - 1, PARKED);
      light.target = target;
      this.lights.push(light);
      this.targets.push(target);
      scene.add(light, target);
    }
  }

  /**
   * Stand the beams on the vehicle's headlamps and burn them `amount` hard.
   * Called once a frame, off the same record the model is drawn from, so the
   * beams leave the lamps wherever the car is seen to be.
   */
  aim(v: VehicleState, spec: VehicleSpec, amount: number): void {
    if (this.cls !== spec.cls) {
      this.cls = spec.cls;
      this.lamps = headlampsOf(spec);
    }
    this.turn.set(v.qx, v.qy, v.qz, v.qw);
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i] as LampLight;
      const target = this.targets[i] as Object3D;
      const lamp = this.lamps[i];
      if (lamp === undefined || amount <= 0) {
        light.intensity = 0;
        light.position.set(PARKED, PARKED, PARKED);
        target.position.set(PARKED, PARKED - 1, PARKED);
        continue;
      }
      this.at.copy(lamp).applyQuaternion(this.turn);
      light.position.set(v.x + this.at.x, v.y + this.at.y, v.z + this.at.z);
      // Forward is the vehicle's own +x; the dip is straight down in the world,
      // so a beam over a crest still lands on the road rather than on the sky.
      this.aimed.set(THROW, 0, 0).applyQuaternion(this.turn);
      target.position.set(
        light.position.x + this.aimed.x,
        light.position.y + this.aimed.y - DIP,
        light.position.z + this.aimed.z,
      );
      light.intensity = HEADLIGHT_INTENSITY * amount;
    }
  }

  dispose(): void {
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i] as LampLight;
      const target = this.targets[i] as Object3D;
      this.scene.remove(light, target);
      light.dispose();
    }
  }
}
