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
 * A medic of an ambulance who has reached a body kneels at it in the same
 * mesh, which is the only one with a kneel in it; the rest of the walk is the
 * crowd's (`ui/hud/emergency-crews.ts`). The cash on a dead body is a small green
 * bundle beside it, all of them one more instanced draw. A police officer or a
 * member of an emergency crew who has been put down lies in the same mesh, in
 * the uniform they wore (`uniform.ts`, `emergency-crew.ts`).
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
import { casualtyPose, emptyCasualtyPose, type Casualty, type CasualtyPose } from '../../sim/crowd/casualty-motion.ts';
import { dead } from '../../sim/crowd/casualty.ts';

import type { CrewMember, CrewRole, FallenCrew } from '../../sim/city/emergency-crew.ts';
import { crewLook } from '../services/emergency-crew.ts';
import { STRIDE_HEIGHT, type PedestrianLook } from '../../sim/crowd/pedestrian-look.ts';
import type { AmbientPedestrians } from '../../sim/crowd/pedestrians.ts';
import type { FallenOfficer, OfficerKind } from '../../sim/police/officer.ts';
import type { SimState } from '../../sim/simulation.ts';
import { BODY_FLOATS, CasualtyPoser, ragdollMatrices, vary } from './casualty-pose.ts';
import { CrowdInstances } from './crowd-instances.ts';
import { createPedestrianMaterial } from './pedestrian-material.ts';
import { PEDESTRIAN_VIEW } from './pedestrians.ts';
import { officerLook, UNIFORM_FLAG } from '../services/uniform.ts';
import { BONES } from './pedestrian-rig.ts';

/** People drawn at most, the medics with them. A frame with more leaves the rest out. */
export const CASUALTY_CAP = 48;

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
  /** The gear of a fallen member of an emergency crew (spec section 20.3), or null. */
  crew: CrewRole | null;
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
      const look = lookOf(this.crowd, state.seed, s);
      const scale = look.height / STRIDE_HEIGHT;
      this.writeBody(s, scale, count * BODY_FLOATS);
      this.writeInstance(count++, look, scale, s.officer === null ? 0 : UNIFORM_FLAG[s.officer]);
      if (dead(s.record) && s.record.cash > 0) this.writeCash(notes++, s);
    }
    for (const member of state.emergency.crew) {
      if (count >= CASUALTY_CAP) break;
      if (!member.kneeling) continue;
      count = this.writeMedic(count, member);
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

  /**
   * Write the bones of one casualty at `offset` into the bone texture, and
   * set `place` to its hips: the ragdoll's where it holds the body, else the pose's.
   */
  private writeBody(s: Seen, scale: number, offset: number): void {
    const ragdoll = s.record.ragdoll;
    if (ragdoll !== null) {
      this.place.set(s.x, ragdoll[1] as number, s.y);
      ragdollMatrices(ragdoll, this.place, scale, this.data, offset);
    } else {
      this.place.set(s.pose.x, s.pose.height, s.pose.y);
      this.poser.write(s.record, s.pose, this.data, offset);
    }
  }

  /** Pose the casualties in view at a moment into the first entries of `seen`, and answer how many. */
  private gather(state: SimState, time: number, x: number, y: number): number {
    const seen = this.seen;
    let n = 0;
    const fallen = state.police.fallen;
    const crowd = state.pedestrians.casualties;
    const crew = state.emergency.fallen;
    for (let i = 0; i < crowd.length + fallen.length + crew.length; i++) {
      const officer = i >= crowd.length && i < crowd.length + fallen.length ? (fallen[i - crowd.length] as FallenOfficer) : undefined;
      const member = i >= crowd.length + fallen.length ? (crew[i - crowd.length - fallen.length] as FallenCrew) : undefined;
      const record = officer?.body ?? member?.body ?? (crowd[i] as Casualty);
      if (record.gone) continue;
      if (seen[n] === undefined) seen[n] = { record, pose: emptyCasualtyPose(), x: 0, y: 0, along: 0, officer: null, crew: null };
      const s = seen[n] as Seen;
      s.record = record;
      s.officer = officer?.kind ?? null;
      s.crew = member?.role ?? null;
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

  /** One medic knelt where the record has them, facing the body they came to. */
  private writeMedic(count: number, member: CrewMember): number {
    const look = crewLook(member.id, member.role);
    this.place.set(member.x, member.height, member.y);
    this.poser.writeKneel(member.heading, this.data, count * BODY_FLOATS);
    this.writeInstance(count, look, look.height / STRIDE_HEIGHT);
    return count + 1;
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
 * What one of them wears: their own face for a person of the crowd, the
 * uniform of a fallen officer, or the gear of a fallen emergency crew.
 */
function lookOf(crowd: AmbientPedestrians, seed: number, s: Seen): PedestrianLook {
  if (s.officer !== null) return officerLook(seed, s.record.id, s.officer);
  if (s.crew !== null) return crewLook(s.record.id, s.crew);
  return (crowd.people[s.record.id] as AmbientPedestrians['people'][number]).look;
}
