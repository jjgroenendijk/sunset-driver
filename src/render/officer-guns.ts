/**
 * The guns in the hands of the police on foot who have them out (spec section
 * 14). The officers themselves are drawn in the crowd's mesh (`ui/officers.ts`),
 * arms out in the `aim` gait; this puts the gun where those hands meet.
 *
 * Each of the three police guns is one `InstancedMesh` of the weapon's own
 * model (`weapon-mesh.ts`), so a firefight costs at most three draws, and none
 * while nobody is aiming.
 */
import { Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { heatStars } from '../sim/crime.ts';
import { officerWeapon, type Officer } from '../sim/officer.ts';
import { STRIDE_HEIGHT } from '../sim/pedestrian-look.ts';
import type { SimState } from '../sim/simulation.ts';
import type { WeaponId } from '../sim/weapon.ts';
import { officerLook } from './uniform.ts';
import { weaponGeometry } from './weapon.ts';
import { weaponBoxes } from './weapon-mesh.ts';

/** The guns the police carry, each one mesh. */
const GUNS: readonly WeaponId[] = ['glock-17', 'remington-870', 'm4a1'];

/** Officers with a gun out drawn at most. */
const GUN_CAP = 24;

/** Where the hands meet, on a body {@link STRIDE_HEIGHT} tall: out in front, at the shoulders. */
export const REACH = 0.52;
export const HANDS = 0.8 * STRIDE_HEIGHT - 0.05;

const UP = new Vector3(0, 1, 0);

export class OfficerGunView {
  readonly group = new Group();
  private readonly meshes: InstancedMesh[] = [];
  private readonly material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 });
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly at = new Vector3();
  private readonly scale = new Vector3();

  constructor() {
    for (const id of GUNS) {
      const geometry = weaponGeometry(weaponBoxes(id, []));
      if (geometry === undefined) continue;
      const mesh = new InstancedMesh(geometry, this.material, GUN_CAP);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.count = 0;
      mesh.visible = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** How many guns the last frame drew. */
  get drawn(): number {
    let n = 0;
    for (const mesh of this.meshes) n += mesh.count;
    return n;
  }

  /** Put a gun in the hands of every officer who is aiming, as the record left them. */
  update(state: SimState): void {
    const stars = heatStars(state.heat);
    const counts = GUNS.map(() => 0);
    for (const officer of state.police.officers) {
      if (!officer.aiming) continue;
      const which = GUNS.indexOf(officerWeapon(officer.kind, stars));
      const mesh = this.meshes[which];
      if (mesh === undefined || (counts[which] as number) >= GUN_CAP) continue;
      mesh.setMatrixAt(counts[which] as number, this.place(state.seed, officer));
      counts[which] = (counts[which] as number) + 1;
    }
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i] as InstancedMesh;
      const count = counts[i] as number;
      if (count === 0 && mesh.count === 0) continue;
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }

  /** The matrix of a gun held out in front of an officer, muzzle the way they face. */
  private place(seed: number, officer: Officer): Matrix4 {
    const size = officerLook(seed, officer.id, officer.kind).height / STRIDE_HEIGHT;
    const reach = REACH * size;
    this.at.set(officer.x + Math.cos(officer.heading) * reach, officer.height + HANDS * size, officer.y + Math.sin(officer.heading) * reach);
    // The yaw of -heading, as the crowd's bodies are turned.
    this.q.setFromAxisAngle(UP, -officer.heading);
    this.scale.set(1, 1, 1);
    return this.m.compose(this.at, this.q, this.scale);
  }
}
