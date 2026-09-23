/**
 * The instanced body the crowd is drawn with, shared by the walking crowd
 * (`pedestrians.ts`) and the people who have been hit (`casualties.ts`).
 *
 * The body is one geometry, and each person is one instance of it. A WebGPU
 * pipeline may read only eight vertex buffers, and a `BufferAttribute` is a
 * buffer each, so the bone and colour part of each vertex are one attribute,
 * and the eight instance attributes share one interleaved buffer. An instance
 * nobody writes a blend or a style for, as a casualty, has neither: zeros
 * leave the body as its bones put it.
 */
import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
} from 'three';
import type { PedestrianLook } from '../sim/pedestrian-look.ts';
import { pedestrianBody } from './pedestrian-rig.ts';

/** Floats one person takes in the instance buffer: place, motion, blend, style and four colours. */
export const CROWD_STRIDE = 28;

/** The body as an instanced geometry for `cap` people, and the attributes each is written through. */
export class CrowdInstances {
  readonly geometry = new InstancedBufferGeometry();
  readonly buffer: InstancedInterleavedBuffer;
  /** Where a person stands, x, height and the map's y, and their heading. */
  readonly place: InterleavedBufferAttribute;
  /** The first row of their bones in the texture, how far through its frames, and their size against the rig. */
  readonly motion: InterleavedBufferAttribute;
  /** The gait they are leaving: its first row, how far through, and how much is left; then the turn of their head. */
  readonly blend: InterleavedBufferAttribute;
  /** How far they stoop, and the prop they hold. */
  readonly style: InterleavedBufferAttribute;
  private readonly colours: InterleavedBufferAttribute[];
  private readonly colour = new Color();

  constructor(cap: number) {
    const body = pedestrianBody();
    this.geometry.setAttribute('position', body.getAttribute('position'));
    this.geometry.setAttribute('normal', body.getAttribute('normal'));
    const bone = body.getAttribute('bone');
    const part = body.getAttribute('part');
    const rig = new Float32Array(bone.count * 2);
    for (let i = 0; i < bone.count; i++) rig.set([bone.getX(i), part.getX(i)], i * 2);
    this.geometry.setAttribute('rig', new BufferAttribute(rig, 2));
    body.dispose();
    this.buffer = new InstancedInterleavedBuffer(new Float32Array(cap * CROWD_STRIDE), CROWD_STRIDE);
    this.buffer.setUsage(DynamicDrawUsage);
    this.place = this.attribute('pedPlace', 4, 0);
    this.motion = this.attribute('pedMotion', 4, 4);
    this.blend = this.attribute('pedBlend', 4, 8);
    this.style = this.attribute('pedStyle', 4, 12);
    this.colours = ['pedSkin', 'pedHair', 'pedTop', 'pedLegs'].map((name, i) => this.attribute(name, 3, 16 + 3 * i));
    this.geometry.instanceCount = 0;
  }

  /** Write the four colours of a look into instance `index`. */
  paint(index: number, look: Pick<PedestrianLook, 'skin' | 'hair' | 'top' | 'legs'>): void {
    const [skin, hair, top, legs] = this.colours as [
      InterleavedBufferAttribute,
      InterleavedBufferAttribute,
      InterleavedBufferAttribute,
      InterleavedBufferAttribute,
    ];
    this.setColour(skin, index, look.skin);
    this.setColour(hair, index, look.hair);
    this.setColour(top, index, look.top);
    this.setColour(legs, index, look.legs);
  }

  /** Draw the first `count` instances, and upload only those. */
  commit(count: number): void {
    this.geometry.instanceCount = count;
    if (count === 0) return;
    this.buffer.clearUpdateRanges();
    this.buffer.addUpdateRange(0, count * CROWD_STRIDE);
    this.buffer.needsUpdate = true;
  }

  private setColour(attribute: InterleavedBufferAttribute, index: number, hex: number): void {
    this.colour.set(hex);
    attribute.setXYZ(index, this.colour.r, this.colour.g, this.colour.b);
  }

  private attribute(name: string, size: number, offset: number): InterleavedBufferAttribute {
    const attribute = new InterleavedBufferAttribute(this.buffer, size, offset);
    this.geometry.setAttribute(name, attribute);
    return attribute;
  }
}
