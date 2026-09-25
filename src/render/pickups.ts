/**
 * The weapons lying in the world, drawn (spec section 11.6).
 *
 * Each pickup of the record is its weapon's model, turning slowly over a pale
 * disc so it reads from the camera 36 m up by day and by night. A pickup is
 * found by its id from frame to frame, so a model is made when a pickup appears
 * and let go when it is taken. The geometry belongs to the shared
 * {@link WeaponArt}; only the meshes belong to this.
 *
 * The pickup under the mouse grows, so the player can see what lies there
 * before walking to it. `PickupModels.pick` finds it; the growth eases in and
 * out over a few frames rather than jumping.
 */
import { CylinderGeometry, Group, Mesh, MeshBasicMaterial, type BufferGeometry, type Object3D, type Raycaster } from 'three';
import { TICK_RATE } from '../sim/clock.ts';
import type { PickupState } from '../sim/pickup.ts';
import type { WeaponArt } from './weapon.ts';

/**
 * How much larger than life a pickup is drawn, and the length its longest side
 * is drawn at least, up to a limit. From the game camera a rifle at twice its
 * size reads; a pistol at twice its size is a speck, so a short weapon is drawn
 * larger still.
 */
export const PICKUP_SCALE = 1.8;
export const PICKUP_MIN_LENGTH = 1;
const PICKUP_MAX_SCALE = 6;

/** Metres above the ground the model turns at. */
const PICKUP_HOVER = 0.3;

/** Radians a second a pickup turns. */
const PICKUP_SPIN = 1.4;

/** How much larger the pickup under the mouse is drawn, and how fast it grows to that, per second. */
const HOVER_GROW = 1.7;
const HOVER_RATE = 12;

/** Metres across the disc under a pickup, how far it stands off the ground, and its colour. */
const DISC_RADIUS = 0.55;
const DISC_LIFT = 0.15;
const DISC_COLOUR = 0xf2e6a0;

/** One pickup on screen: its model, the disc under it, and what it was built for. */
interface Drawn {
  id: number;
  group: Group;
  model: Mesh;
  disc: Mesh;
  /** The scale the model is drawn at when nothing is over it. */
  scale: number;
  /** How far it has grown toward {@link HOVER_GROW}, 0 to 1. */
  grown: number;
  key: string;
}

export class PickupModels {
  readonly group = new Group();
  /** The id of the pickup under the mouse, or undefined. Set by {@link PickupModels.pick}. */
  hovered: number | undefined;
  private readonly art: WeaponArt;
  private readonly disc = new CylinderGeometry(DISC_RADIUS, DISC_RADIUS, 0.02, 20);
  // It writes no depth, so a disc never hides the model or the road it lies over.
  private readonly discMaterial = new MeshBasicMaterial({ color: DISC_COLOUR, transparent: true, opacity: 0.55, depthWrite: false });
  private readonly drawn = new Map<number, Drawn>();
  /** The ids seen this frame, kept to spend no allocation on the check. */
  private readonly seen = new Set<number>();

  constructor(art: WeaponArt) {
    this.art = art;
  }

  /**
   * Draw the record's pickups as they stand at a tick. Called once a frame;
   * `seconds` is the frame's length, which is what the hover grows over.
   */
  update(pickups: readonly PickupState[], tick: number, seconds = 0): void {
    this.seen.clear();
    const step = Math.min(1, seconds * HOVER_RATE);
    for (const pickup of pickups) {
      this.seen.add(pickup.id);
      const drawn = this.drawnFor(pickup);
      drawn.group.position.set(pickup.x, pickup.h, pickup.y);
      drawn.model.rotation.y = (tick / TICK_RATE) * PICKUP_SPIN + pickup.id;
      const target = pickup.id === this.hovered ? 1 : 0;
      drawn.grown += (target - drawn.grown) * step;
      const grow = 1 + (HOVER_GROW - 1) * drawn.grown;
      drawn.model.scale.setScalar(drawn.scale * grow);
      drawn.disc.scale.set(grow, 1, grow);
    }
    for (const [id, drawn] of this.drawn) {
      if (this.seen.has(id)) continue;
      this.group.remove(drawn.group);
      this.drawn.delete(id);
    }
  }

  /**
   * Find the pickup a ray from the camera meets, and mark it as the one under
   * the mouse. The disc counts as well as the model, so a pistol is as easy to
   * point at as a rifle. Answers its id, or undefined where the ray meets none.
   */
  pick(ray: Raycaster): number | undefined {
    this.hovered = undefined;
    const hits = ray.intersectObject(this.group, true);
    for (const hit of hits) {
      let object: Object3D | null = hit.object;
      while (object !== null && object.parent !== this.group) object = object.parent;
      const id = object?.userData.pickup as number | undefined;
      if (id === undefined) continue;
      this.hovered = id;
      break;
    }
    return this.hovered;
  }

  /** How many pickups are drawn. */
  get count(): number {
    return this.drawn.size;
  }

  /** How far the pickup of an id has grown toward its hover size, 0 to 1, or undefined where none is drawn. */
  grownOf(id: number): number | undefined {
    return this.drawn.get(id)?.grown;
  }

  dispose(): void {
    this.group.clear();
    this.drawn.clear();
    this.disc.dispose();
    this.discMaterial.dispose();
  }

  /** The drawn pickup for a record, made on the frame it first appears. */
  private drawnFor(pickup: PickupState): Drawn {
    const key = `${pickup.weapon}|${pickup.attachments.join(',')}`;
    const known = this.drawn.get(pickup.id);
    if (known !== undefined && known.key === key) return known;
    if (known !== undefined) this.group.remove(known.group);
    const group = new Group();
    group.userData.pickup = pickup.id;
    const disc = new Mesh(this.disc, this.discMaterial);
    // Lifted clear of the ground, or the carve's pavement swallows half of it.
    disc.position.y = DISC_LIFT;
    group.add(disc);
    const geometry = this.art.geometry(pickup.weapon, pickup.attachments);
    const model = new Mesh(geometry, this.art.material);
    model.visible = geometry !== undefined;
    model.castShadow = true;
    model.position.y = PICKUP_HOVER;
    group.add(model);
    this.group.add(group);
    const drawn = { id: pickup.id, group, model, disc, scale: pickupScale(geometry), grown: 0, key };
    model.scale.setScalar(drawn.scale);
    this.drawn.set(pickup.id, drawn);
    return drawn;
  }
}

/** How much larger than life a pickup of this geometry is drawn. */
export function pickupScale(geometry: BufferGeometry | undefined): number {
  if (geometry === undefined) return PICKUP_SCALE;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (box === null) return PICKUP_SCALE;
  const longest = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  return Math.min(PICKUP_MAX_SCALE, Math.max(PICKUP_SCALE, PICKUP_MIN_LENGTH / longest));
}
