/**
 * The see-through buildings of spec section 10.7.
 *
 * The camera stands about 30 m over the street, and a tower stands up to 150 m.
 * A building therefore often stands between the camera and the player, and in
 * the core the camera is often inside one. As in GTA Chinatown Wars, such a
 * building turns to a ghost: it keeps a scatter of its pixels, so its shape can
 * still be read, and the player shows through it.
 *
 * Two parts of a building are cut:
 *
 * - every fragment nearer the camera than the player, inside a cone from the
 *   camera around the player, is cut to a ghost. The cone has the same size on
 *   the screen however far back the camera stands;
 * - the building the camera stands inside, whose box `roofs.ts` gives, is cut
 *   away whole. From inside, its walls stand on every side of the view, and
 *   even a ghost of them veils the whole screen.
 *
 * The cut is the ordered dither of `fade.ts`: a fragment is kept or discarded,
 * never blended, so nothing is sorted. The outline hull is cut away whole where
 * the shell is cut to a ghost, or its dark would show through the holes. The
 * shadow pass reads none of this, so a ghost still casts its shadow.
 */
import type { Vector3 } from 'three';
import type { MeshBasicNodeMaterial, NodeMaterial } from 'three/webgpu';
import { bayer4 } from './fade.ts';
import type { RoofBox } from './roofs.ts';
import { float, max, positionWorld, screenCoordinate, smoothstep, step, uniform, vec3, type TslNode } from './tsl.ts';

/** How much of a ghosted building is kept: five of the sixteen dither cells. */
export const GHOST = 0.3;

/**
 * The cone around the player, as the tangent of its half angle. The view is
 * 45 degrees high, so this is about a third of the way from the player to the
 * top of the screen: room for the car and the street around it.
 */
const CONE = 0.16;

/** Metres in front of the player the cut stops, so the ground they stand on is never cut. */
const MARGIN = 2;

/** Metres over which the cut opens at its near end, in front of the player. */
const BAND = 3;

/**
 * Metres the box of a building is grown by when the camera is tested against
 * it and when it is cut: enough to take in its outline and the camera's near
 * plane.
 */
export const CAMERA_ROOF_MARGIN = 1.5;

/** Metres over the player's feet the cone is aimed at: the middle of a car or a person. */
const AIM_HEIGHT = 1;

type Uniform = { value: number } & TslNode;

/** The uniforms every building material reads, and the node that says how much is cut. */
export class BuildingCutaway {
  private readonly on = uniform(1);
  private readonly camera = [uniform(0), uniform(0), uniform(0)] as const;
  private readonly target = [uniform(0), uniform(0), uniform(0)] as const;
  private readonly inside = uniform(0);
  private readonly box: Record<keyof RoofBox, Uniform> = {
    x: uniform(0),
    z: uniform(0),
    ux: uniform(1),
    uz: uniform(0),
    halfAlong: uniform(0),
    halfAcross: uniform(0),
    bottom: uniform(0),
    top: uniform(0),
  };
  private readonly occluding: TslNode = this.buildCone().mul(this.on);
  private readonly inBox: TslNode = this.buildBox().mul(this.on);

  /** Whether buildings are cut at all. Off draws every building whole. */
  get enabled(): boolean {
    return this.on.value > 0;
  }

  set enabled(value: boolean) {
    this.on.value = value ? 1 : 0;
  }

  /**
   * Aim the cut for this frame: where the camera stands, where the player
   * stands, and the building the camera is inside, if any.
   */
  aim(camera: Vector3, x: number, height: number, y: number, inside: RoofBox | undefined): void {
    this.camera[0].value = camera.x;
    this.camera[1].value = camera.y;
    this.camera[2].value = camera.z;
    this.target[0].value = x;
    this.target[1].value = height + AIM_HEIGHT;
    this.target[2].value = y;
    this.inside.value = inside === undefined ? 0 : 1;
    if (inside === undefined) return;
    for (const key of Object.keys(this.box) as (keyof RoofBox)[]) this.box[key].value = inside[key];
  }

  /** Cut a lit shell to a ghost. */
  dressShell(material: NodeMaterial): void {
    material.opacityNode = float(1).sub(max(this.occluding.mul(1 - GHOST), this.inBox));
    material.alphaTestNode = bayer4(screenCoordinate);
  }

  /** Cut an outline hull away whole. */
  dressOutline(material: MeshBasicNodeMaterial): void {
    material.opacityNode = float(1).sub(max(this.occluding, this.inBox));
    material.alphaTestNode = bayer4(screenCoordinate);
  }

  /** How far a fragment stands inside the cone in front of the player, 0 to 1. */
  private buildCone(): TslNode {
    const camera = vec3(this.camera[0], this.camera[1], this.camera[2]);
    const toPoint = positionWorld.sub(camera);
    const toTarget = vec3(this.target[0], this.target[1], this.target[2]).sub(camera);
    const reach = toTarget.length();
    const axis = toTarget.div(reach);
    // How far along the line to the player the fragment stands, and how far off it.
    const depth = toPoint.dot(axis);
    const off = toPoint.sub(axis.mul(depth)).length().div(max(depth, 1));
    const nearer = float(1).sub(smoothstep(reach.sub(MARGIN + BAND), reach.sub(MARGIN), depth));
    const inCone = float(1).sub(smoothstep(CONE * 0.7, CONE, off));
    return nearer.mul(inCone).mul(step(0, depth));
  }

  /** 1 on the building the camera stands inside, 0 everywhere else. */
  private buildBox(): TslNode {
    const b = this.box;
    const dx = positionWorld.x.sub(b.x);
    const dz = positionWorld.z.sub(b.z);
    const along = dx.mul(b.ux).add(dz.mul(b.uz)).abs();
    const across = dz.mul(b.ux).sub(dx.mul(b.uz)).abs();
    return step(along, b.halfAlong.add(CAMERA_ROOF_MARGIN))
      .mul(step(across, b.halfAcross.add(CAMERA_ROOF_MARGIN)))
      .mul(step(positionWorld.y, b.top.add(CAMERA_ROOF_MARGIN)))
      .mul(this.inside);
  }
}
