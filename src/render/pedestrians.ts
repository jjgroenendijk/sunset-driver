/**
 * The crowd, drawn (spec sections 9.2, 13.1).
 *
 * Every person in view is one instance of one mesh, so the whole crowd costs
 * one draw, and one more for each shadow pass. The body and its walk cycles
 * are `pedestrian-rig.ts`; the shader that moves the body is
 * `pedestrian-material.ts`. Each frame writes, per person, where they stand,
 * which gait they move in, how far through its cycle, how tall they are and
 * their four colours, and uploads only the instances it wrote.
 *
 * The crowd is evaluated where the frame stands in time, between two ticks,
 * as the traffic is. A person who has left their loop is drawn from their
 * record in `SimState.pedestrians` instead.
 */
import {
  Color,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Group,
  BufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NearestFilter,
  RGBAFormat,
} from 'three';
import { GAITS, STRIDE_HEIGHT } from '../sim/pedestrian-look.ts';
import { startledOf, startledPose, type AmbientPedestrians, type PedestrianPose } from '../sim/pedestrians.ts';
import type { SimState } from '../sim/simulation.ts';
import { createPedestrianMaterial } from './pedestrian-material.ts';
import { bakeWalks, BONES, FRAMES, pedestrianBody } from './pedestrian-rig.ts';

/** Metres each way of the point the frame is drawn round that people are drawn in. */
export const PEDESTRIAN_VIEW = 110;

/** People drawn at most. A frame with more leaves the rest out. */
export const PEDESTRIAN_CAP = 1024;

/**
 * Floats one person takes in the instance buffer: place, motion and four
 * colours. They share one buffer because a WebGPU pipeline may read only
 * eight, and a buffer per attribute would take ten.
 */
const STRIDE = 20;

export class PedestrianView {
  readonly group = new Group();
  private readonly crowd: AmbientPedestrians;
  private readonly mesh: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly bones: DataTexture;
  private readonly instances: InstancedInterleavedBuffer;
  private readonly place: InterleavedBufferAttribute;
  private readonly motion: InterleavedBufferAttribute;
  private readonly colours: InterleavedBufferAttribute[];
  private readonly ids: number[] = [];
  private readonly pose: PedestrianPose = { x: 0, y: 0, height: 0, heading: 0, speed: 0, cycle: 0, gait: 'stand' };
  private readonly colour = new Color();

  constructor(crowd: AmbientPedestrians) {
    this.crowd = crowd;
    this.bones = new DataTexture(bakeWalks(), BONES.length * 4, GAITS.length * FRAMES, RGBAFormat, FloatType);
    this.bones.minFilter = NearestFilter;
    this.bones.magFilter = NearestFilter;
    this.bones.generateMipmaps = false;
    this.bones.needsUpdate = true;

    const body = pedestrianBody();
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setAttribute('position', body.getAttribute('position'));
    this.geometry.setAttribute('normal', body.getAttribute('normal'));
    // The bone and the colour part of each vertex, as one attribute for the same reason.
    const bone = body.getAttribute('bone');
    const part = body.getAttribute('part');
    const rig = new Float32Array(bone.count * 2);
    for (let i = 0; i < bone.count; i++) rig.set([bone.getX(i), part.getX(i)], i * 2);
    this.geometry.setAttribute('rig', new BufferAttribute(rig, 2));
    body.dispose();
    this.instances = new InstancedInterleavedBuffer(new Float32Array(PEDESTRIAN_CAP * STRIDE), STRIDE);
    this.instances.setUsage(DynamicDrawUsage);
    this.place = this.instanceAttribute('pedPlace', 4, 0);
    this.motion = this.instanceAttribute('pedMotion', 4, 4);
    this.colours = ['pedSkin', 'pedHair', 'pedTop', 'pedLegs'].map((name, i) => this.instanceAttribute(name, 3, 8 + 3 * i));
    this.geometry.instanceCount = 0;

    this.mesh = new Mesh(this.geometry, createPedestrianMaterial(this.bones));
    // The instances are spread over the view; the body's own bounds say nothing about them.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  /** How many people the last frame drew. */
  get drawn(): number {
    return this.geometry.instanceCount;
  }

  /**
   * Draw the crowd round a place as it stands at a moment, which may fall
   * between two ticks. Called once a frame.
   */
  update(state: SimState, time: number, x: number, y: number): void {
    const crowd = this.crowd;
    const minX = x - PEDESTRIAN_VIEW;
    const minY = y - PEDESTRIAN_VIEW;
    const maxX = x + PEDESTRIAN_VIEW;
    const maxY = y + PEDESTRIAN_VIEW;
    const startled = state.pedestrians.startled;
    let count = 0;
    for (const id of crowd.near(minX, minY, maxX, maxY, this.ids)) {
      if (count >= PEDESTRIAN_CAP) break;
      if (!crowd.edgeMeets(crowd.edgeAt(id, time), minX, minY, maxX, maxY)) continue;
      if (startled.length > 0 && startledOf(state.pedestrians, id) !== undefined) continue;
      const pose = crowd.poseAt(id, time, this.pose);
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      this.write(count++, id, pose);
    }
    for (const record of startled) {
      if (count >= PEDESTRIAN_CAP) break;
      const pose = startledPose(record, time, this.pose);
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      this.write(count++, record.id, pose);
    }
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    if (count === 0) return;
    this.instances.clearUpdateRanges();
    this.instances.addUpdateRange(0, count * STRIDE);
    this.instances.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as { dispose(): void }).dispose();
    this.bones.dispose();
    this.group.clear();
  }

  /** Write one person into instance `index`. */
  private write(index: number, id: number, pose: PedestrianPose): void {
    const look = (this.crowd.people[id] as AmbientPedestrians['people'][number]).look;
    this.place.setXYZW(index, pose.x, pose.height, pose.y, pose.heading);
    this.motion.setXYZW(index, GAITS.indexOf(pose.gait) * FRAMES, pose.cycle, look.height / STRIDE_HEIGHT, 0);
    const [skin, hair, top, legs] = this.colours as [InterleavedBufferAttribute, InterleavedBufferAttribute, InterleavedBufferAttribute, InterleavedBufferAttribute];
    this.setColour(skin, index, look.skin);
    this.setColour(hair, index, look.hair);
    this.setColour(top, index, look.top);
    this.setColour(legs, index, look.legs);
  }

  private setColour(attribute: InterleavedBufferAttribute, index: number, hex: number): void {
    this.colour.set(hex);
    attribute.setXYZ(index, this.colour.r, this.colour.g, this.colour.b);
  }

  private instanceAttribute(name: string, size: number, offset: number): InterleavedBufferAttribute {
    const attribute = new InterleavedBufferAttribute(this.instances, size, offset);
    this.geometry.setAttribute(name, attribute);
    return attribute;
  }
}
