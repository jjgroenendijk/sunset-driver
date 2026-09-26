/**
 * The animals of spec section 20.4, drawn.
 *
 * `src/sim/city/wildlife.ts` places them and says where each one is at a moment;
 * this draws the ones in view. There are two models and so two draws whatever
 * is about: a bird, which is a body between two wings, and a beast, which is a
 * body on four legs. A species is that model at its own size and colour
 * ({@link LOOKS}), which is why a crab and a deer cost the same to draw.
 *
 * Nothing animates a bone. The game camera of spec section 10.7 stands 36 m
 * up, where a gull is a few pixels across, so a wing beat is the bird drawn
 * narrower and wider along its own body, and a stride is the beast bobbing.
 * Both come off {@link WildlifePose.cycle}, which is a function of the tick.
 *
 * An animal giving way to the player is drawn from the same pose
 * ({@link WildlifePose.startled}): a bird that has taken off beats its wings
 * faster, so a flock scattering reads as a flock scattering.
 */
import { BoxGeometry, Color, Group, InstancedMesh, MeshStandardMaterial, Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { outInThis } from '../../sim/city/weather.ts';
import { activeAt, AmbientWildlife, type Species, type WildlifePose } from '../../sim/city/wildlife.ts';
import type { Point } from '../../world/types.ts';
import { tinted } from '../look/tint.ts';

/** Metres each way of the point the frame is drawn round that animals are drawn in. */
export const WILDLIFE_VIEW = 120;

/** Animals of one model drawn at most. A frame with more leaves the rest out. */
const WILDLIFE_CAP = 512;

/** Which of the two models a species is drawn as. */
export type Model = 'bird' | 'beast';

/** How one species is drawn: its model, its length in metres, and its colour. */
export interface WildlifeLook {
  model: Model;
  /** Metres nose to tail. The model is drawn to it, and its width and height follow. */
  length: number;
  colour: number;
}

/** What each species looks like from 36 m up. */
export const LOOKS: Readonly<Record<Species, WildlifeLook>> = Object.freeze({
  seagull: { model: 'bird', length: 0.55, colour: 0xf2f4f6 },
  pigeon: { model: 'bird', length: 0.32, colour: 0x6d7683 },
  crab: { model: 'beast', length: 0.22, colour: 0xc2563a },
  cat: { model: 'beast', length: 0.5, colour: 0x3c3630 },
  rat: { model: 'beast', length: 0.24, colour: 0x4a4038 },
  deer: { model: 'beast', length: 1.6, colour: 0x8a6a45 },
  hawk: { model: 'bird', length: 0.9, colour: 0x6b4a2c },
});

/** How far the wings close and open over one beat, as a share of the span. */
const FLAP = 0.45;

/** How far a walking beast rises and falls over one stride, as a share of its height. */
const BOB = 0.12;

/** How much faster a bird beats its wings once it has been put up. */
const ALARM_BEAT = 2.5;

/** The animals in view. One draw for the birds and one for the beasts. */
export class WildlifeView {
  readonly group = new Group();
  /**
   * The share of the wildlife that is out, which the weather sets the way it
   * sets the crowd's (spec section 13.4). A storm empties the sky.
   */
  share = 1;
  private readonly wildlife: AmbientWildlife;
  private readonly meshes: Record<Model, InstancedMesh>;
  private readonly counts: Record<Model, number> = { bird: 0, beast: 0 };
  private readonly dummy = new Object3D();
  private readonly colour = new Color();
  private readonly ids: number[] = [];
  private readonly watch: Point = { x: 0, y: 0 };
  private readonly pose: WildlifePose = {
    species: 'pigeon',
    x: 0,
    y: 0,
    height: 0,
    heading: 0,
    speed: 0,
    cycle: 0,
    startled: 0,
  };

  constructor(wildlife: AmbientWildlife, cap = WILDLIFE_CAP) {
    this.wildlife = wildlife;
    this.meshes = { bird: instanced(birdBody(), cap), beast: instanced(beastBody(), cap) };
    this.group.add(this.meshes.bird, this.meshes.beast);
  }

  /** How many animals the last frame drew. */
  get drawn(): number {
    return this.counts.bird + this.counts.beast;
  }

  /**
   * Draw the wildlife round a place as it stands at a moment, which may fall
   * between two ticks. `watch` is where the player stands, which is what the
   * shy ones give way to. Called once a frame.
   */
  update(tick: number, time: number, x: number, y: number, watch: Point = { x, y }): void {
    const minX = x - WILDLIFE_VIEW;
    const minY = y - WILDLIFE_VIEW;
    const maxX = x + WILDLIFE_VIEW;
    const maxY = y + WILDLIFE_VIEW;
    this.watch.x = watch.x;
    this.watch.y = watch.y;
    this.counts.bird = 0;
    this.counts.beast = 0;
    for (const id of this.wildlife.near(minX, minY, maxX, maxY, this.ids)) {
      const animal = this.wildlife.anchorOf(id);
      if (!activeAt(animal.species, tick)) continue;
      if (!outInThis(animal.id, this.share)) continue;
      const look = LOOKS[animal.species];
      if (this.counts[look.model] >= this.meshes[look.model].instanceMatrix.count) continue;
      const pose = this.wildlife.poseAt(id, time, this.pose, this.watch);
      if (pose.x < minX || pose.x > maxX || pose.y < minY || pose.y > maxY) continue;
      this.write(look, pose);
    }
    for (const model of ['bird', 'beast'] as const) {
      const mesh = this.meshes[model];
      mesh.count = this.counts[model];
      mesh.visible = mesh.count > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const model of ['bird', 'beast'] as const) {
      const mesh = this.meshes[model];
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
      mesh.dispose();
    }
    this.group.clear();
  }

  /** Write one animal into its model's next instance. */
  private write(look: WildlifeLook, pose: WildlifePose): void {
    const mesh = this.meshes[look.model];
    const index = this.counts[look.model]++;
    const beat = Math.sin(2 * Math.PI * pose.cycle * (1 + pose.startled * (ALARM_BEAT - 1)));
    this.dummy.position.set(pose.x, pose.height, pose.y);
    // The models are laid out nose along +x and the map's y is the scene's z,
    // so a heading on the map is a turn about the scene's up axis.
    this.dummy.rotation.set(0, -pose.heading, 0);
    const size = look.length;
    if (look.model === 'bird') this.dummy.scale.set(size, size, size * (1 - FLAP * Math.abs(beat)));
    else this.dummy.scale.set(size, size * (1 + BOB * beat), size);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
    mesh.setColorAt(index, this.colour.set(LOOKS[pose.species].colour));
  }
}

/** One instanced model: no frustum culling, since the instances are spread over the view. */
function instanced(geometry: ReturnType<typeof birdBody>, cap: number): InstancedMesh {
  const material = new MeshStandardMaterial({ roughness: 0.75, metalness: 0 });
  const mesh = tinted(new InstancedMesh(geometry, material, cap));
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.count = 0;
  return mesh;
}

/**
 * A bird at unit length: a body along +x between two wings, drawn so the whole
 * model stands on the ground at y = 0 and the wings close along its z.
 */
function birdBody(): ReturnType<typeof mergeGeometries> {
  const body = new BoxGeometry(1, 0.32, 0.3);
  body.translate(0, 0.16, 0);
  const head = new BoxGeometry(0.26, 0.2, 0.2);
  head.translate(0.55, 0.26, 0);
  const left = new BoxGeometry(0.5, 0.06, 0.8);
  left.translate(0, 0.2, 0.5);
  const right = left.clone();
  right.translate(0, 0, -1);
  return mergeGeometries([body, head, left, right]);
}

/** A beast at unit length: a body along +x on four legs, standing on y = 0. */
function beastBody(): ReturnType<typeof mergeGeometries> {
  const parts = [];
  const body = new BoxGeometry(1, 0.34, 0.36);
  body.translate(0, 0.42, 0);
  parts.push(body);
  const head = new BoxGeometry(0.3, 0.26, 0.24);
  head.translate(0.58, 0.5, 0);
  parts.push(head);
  const tail = new BoxGeometry(0.3, 0.08, 0.08);
  tail.translate(-0.6, 0.48, 0);
  parts.push(tail);
  for (const along of [0.34, -0.34]) {
    for (const across of [0.16, -0.16]) {
      const leg = new BoxGeometry(0.1, 0.26, 0.1);
      leg.translate(along, 0.13, across);
      parts.push(leg);
    }
  }
  return mergeGeometries(parts);
}
