/**
 * The front doors of the patrol cars, swung per car (spec section 14).
 *
 * Every patrol car is one instance of the police meshes, so a door baked into
 * them could not open on one car and stay shut on the next. The two front
 * doors are drawn apart instead, the way the emergency units draw theirs
 * (`emergency.ts`): each door is an instanced mesh built about its hinge, and
 * its instance matrix is the car's own times a turn about that hinge by the
 * record's `doors`. The skin and the glass are a mesh each, so the glass is
 * still seen through.
 */
import { Matrix4, type InstancedMesh, type Material } from 'three';
import type { VehicleSpec } from '../../sim/vehicles/vehicle.ts';
import { boxOf, coloured, instanced, merged } from '../vehicles/traffic.ts';
import { vehicleBoxes, type Hinge } from '../vehicles/vehicle-mesh.ts';

/** The leaves a patrol car's crew get out through: the two front doors. */
export const PATROL_LEAVES: readonly number[] = [0, 1];

/** Radians a patrol car's door stands open at, as the player's does. */
const SWING = 1.15;

/** One door: its hinge, and the two meshes it is drawn with. */
interface Leaf {
  hinge: Hinge;
  meshes: InstancedMesh[];
}

export class PatrolDoors {
  readonly meshes: InstancedMesh[] = [];
  private readonly leaves: Leaf[] = [];
  private readonly turn = new Matrix4();
  private readonly out = new Matrix4();

  constructor(spec: VehicleSpec, trim: Material, glass: Material, cap: number) {
    const parts = vehicleBoxes(spec);
    for (const leaf of PATROL_LEAVES) {
      const own = parts.filter((part) => part.hinge?.leaf === leaf);
      const hinge = own[0]?.hinge;
      if (hinge === undefined) continue;
      const about = (geometry: ReturnType<typeof boxOf>): ReturnType<typeof boxOf> => geometry.translate(-hinge.x, -hinge.y, -hinge.z);
      const skin = own.filter((part) => part.glass !== true).map((part) => about(coloured(boxOf(part), part.colour)));
      const panes = own.filter((part) => part.glass === true).map((part) => about(boxOf(part)));
      const meshes = [instanced(merged(skin), trim, true, cap), instanced(merged(panes), glass, false, cap)];
      this.leaves.push({ hinge, meshes });
      this.meshes.push(...meshes);
    }
  }

  /** Write one car's doors, open by `open` from 0 to 1, at the car's own matrix. */
  set(index: number, car: Matrix4, open: number): void {
    for (const { hinge, meshes } of this.leaves) {
      this.turn.makeRotationY(Math.sign(hinge.z) * open * SWING).setPosition(hinge.x, hinge.y, hinge.z);
      this.out.multiplyMatrices(car, this.turn);
      for (const mesh of meshes) mesh.setMatrixAt(index, this.out);
    }
  }

  /** Show the doors of the first `count` cars and hide the rest. */
  commit(count: number): void {
    for (const mesh of this.meshes) {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
}
