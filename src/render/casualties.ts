/**
 * The people who have been hit, drawn (spec sections 11.6, 13.1, 20.3).
 *
 * Every casualty in view is one instance of the crowd's own body and material
 * (`crowd-instances.ts`, `pedestrian-material.ts`), so they all cost one draw,
 * and one more for each shadow pass. The walking crowd reads its bones from
 * walk cycles baked once; these read theirs from a texture written every
 * frame, one row per person, posed by `casualty-pose.ts`. The shader reads row
 * `motion.x` and blends it with the row after by how far `motion.y` is through
 * a cycle, so each instance's `motion.y` is zero and the texture keeps one
 * spare row at the end for the last instance's second read.
 *
 * The medics of an ambulance working a scene kneel at the body nearest to it,
 * one each side, in the same mesh. The cash on a dead body is a small green
 * bundle beside it, all of them one more instanced draw. A police officer who
 * has been put down lies in the same mesh, in their uniform (`uniform.ts`).
 */
import {
  BoxGeometry,
  DataTexture,
  FloatType,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  Quaternion,
  RGBAFormat,
  Vector3,
} from 'three';
import { casualtyPose, emptyCasualtyPose, type Casualty, type CasualtyPose } from '../sim/casualty-motion.ts';
import { dead } from '../sim/casualty.ts';
import { SKIN_TONES } from '../sim/character.ts';
import { COLLECT_RANGE, type EmergencyUnit } from '../sim/emergency.ts';
import { STRIDE_HEIGHT, type PedestrianLook } from '../sim/pedestrian-look.ts';
import type { AmbientPedestrians } from '../sim/pedestrians.ts';
import type { FallenOfficer, OfficerKind } from '../sim/officer.ts';
import type { SimState } from '../sim/simulation.ts';
import { BODY_FLOATS, CasualtyPoser, ragdollMatrices, vary } from './casualty-pose.ts';
import { CrowdInstances } from './crowd-instances.ts';
import { createPedestrianMaterial } from './pedestrian-material.ts';
import { PEDESTRIAN_VIEW } from './pedestrians.ts';
import { officerLook, UNIFORM_FLAG } from './uniform.ts';
import { BONES } from './pedestrian-rig.ts';

/** People drawn at most, the medics with them. A frame with more leaves the rest out. */
export const CASUALTY_CAP = 48;

/** Metres from the line of a body a medic kneels at, and how far up the body from the hips. */
export const MEDIC_SIDE = 0.95;
const MEDIC_UP = 0.35;

/** What a medic wears: a white or a pale green top, and dark trousers. */
const MEDIC_TOPS = [0xf1f3ef, 0xb6dcc2] as const;
const MEDIC_LEGS = 0x1c2230;
const MEDIC_HAIR = [0x1b1410, 0x3a2716, 0x6b4a2b] as const;
const MEDIC_HEIGHT = 1.78;

/** The bundle of notes on a dead body with cash on it: its size, where it lies from the hips, and its colour. */
const CASH_SIZE: [number, number, number] = [0.3, 0.06, 0.15];
const CASH_SIDE = 0.55;
const CASH_COLOUR = 0x3d8b3d;

const UP = new Vector3(0, 1, 0);

/** One casualty of this frame, with where its hips are and the way its body lies. */
interface Seen {
  record: Casualty;
  pose: CasualtyPose;
  /** The ground under the hips, in the world: the ragdoll's hips where it holds the body. */
  x: number;
  y: number;
  /** The way from the hips to the head, on the map. */
  along: number;
  /** The uniform of a fallen police officer (spec section 14), or null for one of the crowd. */
  officer: OfficerKind | null;
}

export class CasualtyView {
  readonly group = new Group();
  private readonly crowd: AmbientPedestrians;
  private readonly body = new CrowdInstances(CASUALTY_CAP);
  private readonly data = new Float32Array(BODY_FLOATS * (CASUALTY_CAP + 1));
  private readonly bones: DataTexture;
  private readonly mesh: Mesh;
  private readonly cash: InstancedMesh;
  private readonly poser = new CasualtyPoser();
  private readonly seen: Seen[] = [];
  private readonly place = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly one = new Vector3(1, 1, 1);
  private readonly medic: PedestrianLook = { skin: 0, hair: 0, top: 0, legs: MEDIC_LEGS, height: MEDIC_HEIGHT, gait: 'stand', speed: 0 };

  constructor(crowd: AmbientPedestrians) {
    this.crowd = crowd;
    this.bones = new DataTexture(this.data, BONES.length * 4, CASUALTY_CAP + 1, RGBAFormat, FloatType);
    this.bones.minFilter = NearestFilter;
    this.bones.magFilter = NearestFilter;
    this.bones.generateMipmaps = false;
    this.bones.needsUpdate = true;
    this.mesh = new Mesh(this.body.geometry, createPedestrianMaterial(this.bones));
    // The instances are spread over the view; the body's own bounds say nothing about them.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.cash = new InstancedMesh(new BoxGeometry(...CASH_SIZE), new MeshStandardMaterial({ color: CASH_COLOUR, roughness: 0.9 }), CASUALTY_CAP);
    this.cash.frustumCulled = false;
    this.cash.count = 0;
    this.cash.visible = false;
    this.group.add(this.mesh, this.cash);
  }

  /** How many people the last frame drew, medics and all. */
  get drawn(): number {
    return this.body.geometry.instanceCount;
  }

  /** How many bundles of cash the last frame drew. */
  get notes(): number {
    return this.cash.count;
  }

  /**
   * Draw the casualties round a place at a moment, which may fall between two
   * ticks: the crowd's own moment. Called once a frame.
   */
  update(state: SimState, time: number, x: number, y: number): void {
    const seen = this.seen;
    const n = this.gather(state, time, x, y);
    let count = 0;
    let notes = 0;
    for (let i = 0; i < n && count < CASUALTY_CAP; i++) {
      const s = seen[i] as Seen;
      const look = s.officer === null ? (this.crowd.people[s.record.id] as AmbientPedestrians['people'][number]).look : officerLook(state.seed, s.record.id, s.officer);
      const scale = look.height / STRIDE_HEIGHT;
      const ragdoll = s.record.ragdoll;
      if (ragdoll !== null) {
        this.place.set(s.x, ragdoll[1] as number, s.y);
        ragdollMatrices(ragdoll, this.place, scale, this.data, count * BODY_FLOATS);
      } else {
        this.place.set(s.pose.x, s.pose.height, s.pose.y);
        this.poser.write(s.record, s.pose, this.data, count * BODY_FLOATS);
      }
      this.writeInstance(count++, look, scale, s.officer === null ? 0 : UNIFORM_FLAG[s.officer]);
      if (dead(s.record) && s.record.cash > 0) this.writeCash(notes++, s);
    }
    for (const unit of state.emergency.units) {
      if (count + 2 > CASUALTY_CAP) break;
      const at = medicsAt(unit, seen, n);
      if (at === undefined) continue;
      count = this.writeMedics(count, unit, at);
    }
    this.body.commit(count);
    this.mesh.visible = count > 0;
    if (count > 0) this.bones.needsUpdate = true;
    this.cash.count = notes;
    this.cash.visible = notes > 0;
    if (notes > 0) this.cash.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.body.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
    this.bones.dispose();
    this.cash.geometry.dispose();
    (this.cash.material as MeshStandardMaterial).dispose();
    this.group.clear();
  }

  /** Pose the casualties in view at a moment into the first entries of `seen`, and answer how many. */
  private gather(state: SimState, time: number, x: number, y: number): number {
    const seen = this.seen;
    let n = 0;
    const fallen = state.police.fallen;
    const crowd = state.pedestrians.casualties;
    for (let i = 0; i < crowd.length + fallen.length; i++) {
      const officer = i < crowd.length ? undefined : (fallen[i - crowd.length] as FallenOfficer);
      const record = officer?.body ?? (crowd[i] as Casualty);
      if (record.gone) continue;
      if (seen[n] === undefined) seen[n] = { record, pose: emptyCasualtyPose(), x: 0, y: 0, along: 0, officer: null };
      const s = seen[n] as Seen;
      s.record = record;
      s.officer = officer?.kind ?? null;
      casualtyPose(record, time, s.pose);
      const ragdoll = record.ragdoll;
      if (ragdoll === null) {
        s.x = s.pose.x;
        s.y = s.pose.y;
        s.along = s.pose.dir;
      } else {
        // The hips are the first bone and the head the third.
        s.x = ragdoll[0] as number;
        s.y = ragdoll[2] as number;
        s.along = Math.atan2((ragdoll[16] as number) - s.y, (ragdoll[14] as number) - s.x);
      }
      if (Math.abs(s.x - x) > PEDESTRIAN_VIEW || Math.abs(s.y - y) > PEDESTRIAN_VIEW) continue;
      n++;
    }
    return n;
  }

  private writeInstance(index: number, look: Pick<PedestrianLook, 'skin' | 'hair' | 'top' | 'legs'>, scale: number, uniform = 0): void {
    // The heading is in the bones, so the instance is drawn unturned; row `index` alone is read.
    this.body.place.setXYZW(index, this.place.x, this.place.y, this.place.z, 0);
    this.body.motion.setXYZW(index, index, 0, scale, uniform);
    this.body.paint(index, look);
  }

  /** Two medics of a unit, one each side of a body, on one knee and facing it. */
  private writeMedics(count: number, unit: EmergencyUnit, at: Seen): number {
    const look = this.medic;
    look.skin = (SKIN_TONES[Math.floor(vary(unit.id, 20) * SKIN_TONES.length)] as { colour: number }).colour;
    const cx = at.x + Math.cos(at.along) * MEDIC_UP;
    const cy = at.y + Math.sin(at.along) * MEDIC_UP;
    for (const side of [1, -1]) {
      const toward = at.along + (side * Math.PI) / 2;
      look.top = MEDIC_TOPS[(unit.id + (side > 0 ? 0 : 1)) % 2] as number;
      look.hair = MEDIC_HAIR[Math.floor(vary(unit.id, 21 + side) * MEDIC_HAIR.length)] as number;
      this.place.set(cx + Math.cos(toward) * MEDIC_SIDE, at.pose.height, cy + Math.sin(toward) * MEDIC_SIDE);
      this.poser.writeKneel(toward + Math.PI, this.data, count * BODY_FLOATS);
      this.writeInstance(count++, look, MEDIC_HEIGHT / STRIDE_HEIGHT);
    }
    return count;
  }

  /** The bundle of notes on the ground beside a dead body, on the side it fell towards. */
  private writeCash(index: number, s: Seen): void {
    const across = s.along + s.record.side * (Math.PI / 2);
    this.v.set(s.x + Math.cos(across) * CASH_SIDE, s.pose.height + CASH_SIZE[1] / 2 + 0.01, s.y + Math.sin(across) * CASH_SIDE);
    this.q.setFromAxisAngle(UP, -(s.along + vary(s.record.id, 30) * 2));
    this.cash.setMatrixAt(index, this.m.compose(this.v, this.q, this.one));
  }
}

/**
 * The body the medics of a unit kneel at: the nearest one within
 * {@link COLLECT_RANGE} of an ambulance standing at a scene, of those lying
 * or crawling. A body still in the air or going over is not knelt at yet.
 * Undefined where the unit is not working one.
 */
function medicsAt(unit: EmergencyUnit, seen: readonly Seen[], n: number): Seen | undefined {
  if (unit.kind !== 'ambulance' || unit.task !== 'work') return undefined;
  let best: Seen | undefined;
  let nearest = COLLECT_RANGE;
  for (let i = 0; i < n; i++) {
    const s = seen[i] as Seen;
    if (s.pose.phase !== 'lie' && s.pose.phase !== 'crawl') continue;
    const d = Math.hypot(s.x - unit.x, s.y - unit.y);
    if (d > nearest) continue;
    nearest = d;
    best = s;
  }
  return best;
}
