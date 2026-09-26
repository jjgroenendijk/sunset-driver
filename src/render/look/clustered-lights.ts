/**
 * The clustered lighting of spec section 10.5, held still across a render-scale
 * change.
 *
 * `ClusteredLightsNode` sizes its grid of clusters from the renderer's drawing
 * buffer, and rebuilds the compute that fills the grid whenever that size
 * moves. A rebuilt compute is a fresh cache key in the lights node, and the
 * lights node's key is in every render object's, so one size change discards
 * every render object in the scene and builds every shader in the city again:
 * about two seconds, on every quality change that moves the render scale
 * (issue #323). A machine near a tier boundary changes tier twice a second.
 *
 * Two changes keep the grid still without breaking the culling:
 *
 * - **The grid is pinned to the largest buffer the renderer draws at** — the
 *   display at the full pixel ratio, before the render scale — and grows past
 *   that pin only when the window is enlarged. A tier change shrinks the
 *   buffer, never the grid.
 * - **A fragment finds its cluster by its share of the target, not its pixel.**
 *   The addon divides the fragment's pixel coordinate by the tile size, which
 *   names a different cluster at every render scale. The lookup built here
 *   (`create` below) multiplies its `screenUV` share by the grid's dimensions
 *   instead. The compute cuts every cluster's bounds from that same share of
 *   the frame (NDC), so the lookup lands on the cluster that holds the
 *   fragment at whatever resolution the frame is drawn at.
 *
 * The node also **runs the clustered path only while there is a light to
 * cluster** (issue #435). The addon clusters shadowless point lights, and the
 * game has none: its lamps are projector cones and its neon is rect area
 * lights. Yet the addon runs its compute over every cluster each frame and puts
 * its cluster loop in every fragment, which cost 43 ms of a 93 ms frame at a
 * pixel ratio of 2. With no light to cluster, the node draws as a plain
 * `LightsNode`, and its cache key says which of the two shaders it built.
 */
import { Vector2 } from 'three';
import ClusteredLightsNode from 'three/examples/jsm/tsl/lighting/ClusteredLightsNode.js';
import { Lighting, LightsNode, NodeUtils, type LightingNode, type NodeBuilder, type NodeFrame, type WebGPURenderer } from 'three/webgpu';
import type { Light } from 'three';
import { clamp, float, Fn, int, log, positionView, screenUV, type TslNode } from '../tsl.ts';
import { LampLightNode } from '../roads/lamp-light.ts';
import { NeonLightNode } from '../signage/sign-light.ts';

/** Whether a light builds its term inside a branch that skips it while it is off. */
function isBranched(node: LightingNode): boolean {
  return node instanceof LampLightNode || node instanceof NeonLightNode;
}

/** A size in whole pixels. */
export interface GridSize {
  width: number;
  height: number;
}

/**
 * The half of the addon's node its own types leave out (`lamp-light.ts` reads
 * the renderer's node library the same way).
 */
interface ClusteredInternals {
  /** The grid standing, in tiles-fitted pixels; null before the first frame. */
  _bufferSize: GridSize | null;
  /** How many clusters the grid holds across and down, as a uniform the lookup reads. */
  _gridDimensions: TslNode & { value: Vector2 };
  /** The node that finds the cluster a fragment shades in. */
  _screenClusterIndex: TslNode;
  /** The camera the clusters are cut by, as uniforms. */
  _cameraNear: TslNode & { value: number };
  _cameraFar: TslNode & { value: number };
  /** Build the compute and the lookup for a grid of tiles-fitted pixels. */
  create(width: number, height: number): void;
}

/** The addon's own grid builder, which its types leave out but the node needs. */
const buildAddonGrid = (ClusteredLightsNode.prototype as unknown as ClusteredInternals).create;

/** The mark hashed into the key of the clustered shader. */
const CLUSTERED = 1;

/** Where `updateProgram` reads the drawing buffer into. */
const drawn = new Vector2();

/**
 * The cluster grid to build for the sizes in play, or `null` to keep the one
 * standing. The addon builds a grid of whole tiles over the buffer it is given,
 * so every size is measured in tiles-fitted pixels before it is compared.
 *
 * The first grid is the pin. After that the grid only grows, and only when the
 * buffer drawn at outgrows it — a window made larger, the one size change a
 * session makes that the pin did not cover. Everything smaller keeps the grid:
 * a smaller buffer is a render scale, and the cluster bounds are shares of the
 * frame rather than pixels, so the standing grid serves it exactly as well.
 */
export function gridToBuild(standing: GridSize | null, pinned: GridSize, buffer: GridSize, tileSize: number): GridSize | null {
  if (standing === null) return fittedSize(pinned, tileSize);
  const wanted = fittedSize(buffer, tileSize);
  if (wanted.width > standing.width || wanted.height > standing.height) return wanted;
  return null;
}

/** A size rounded out to whole tiles, which is the grid the addon builds for it. */
function fittedSize(size: GridSize, tileSize: number): GridSize {
  return {
    width: Math.ceil(size.width / tileSize) * tileSize,
    height: Math.ceil(size.height / tileSize) * tileSize,
  };
}

/**
 * The addon's lights node with its grid pinned. The cluster count, the light
 * list capacity and the tile size are the addon's own defaults, which is what
 * the game runs at; only where the grid is pinned differs.
 */
export class PinnedClusterLightsNode extends ClusteredLightsNode {
  private readonly pinned: GridSize;

  constructor(pinned: GridSize) {
    super();
    this.pinned = pinned;
  }

  /** Whether the scene holds a light the addon clusters. */
  private get clustering(): boolean {
    return this.clusteredLights.length > 0;
  }

  /**
   * Without a light to cluster the key is the plain lights node's, so a grid
   * that nothing reads rebuilds no shader. With one, the addon's key is hashed
   * with a mark: before its first grid the addon's key equals the plain one,
   * and the first point light would then rebuild nothing and go undrawn.
   */
  override customCacheKey(): number {
    if (!this.clustering) return LightsNode.prototype.customCacheKey.call(this);
    return NodeUtils.hashArray([CLUSTERED, super.customCacheKey()]);
  }

  /**
   * The cluster loop goes into the shader only when it has a light to find.
   *
   * The lights that burn in a branch (`lamp-light.ts`, `sign-light.ts`) are set
   * up after every other light (issue #689). TSL builds a term once and reuses
   * it, and the terms of the direct light, such as the Lambert of the diffuse
   * colour, are shared by every light. Built first inside a lamp's branch, a
   * term is written only while that lamp burns, and the sun read it as nothing
   * all day: the city was lit by the sky fill alone and cast no shadow.
   */
  override setupLights(builder: NodeBuilder, lightNodes: LightingNode[]): void {
    const ordered = [...lightNodes.filter((n) => !isBranched(n)), ...lightNodes.filter(isBranched)];
    if (this.clustering) super.setupLights(builder, ordered);
    else LightsNode.prototype.setupLights.call(this, builder, ordered);
  }

  /** The compute fills the clusters each frame, so it runs only when a shader reads them. */
  override updateBefore(frame: NodeFrame): boolean | undefined {
    return this.clustering ? super.updateBefore(frame) : undefined;
  }

  /**
   * Build the grid only where the sizes ask for one. This runs every frame and
   * from every material's lighting setup, so it is the whole of the fix: a
   * buffer that moved asks for nothing, and the compute — whose identity is in
   * every render object's cache key — is left standing.
   */
  updateProgram(renderer: WebGPURenderer): void {
    renderer.getDrawingBufferSize(drawn);
    const inside = this as unknown as ClusteredInternals;
    const build = gridToBuild(inside._bufferSize, this.pinned, drawn, this.tileSize);
    if (build !== null) inside.create(build.width, build.height);
  }

  /**
   * Build the addon's grid, then rebuild the one node of it that is cut for the
   * buffer rather than the frame: the lookup that finds the cluster a fragment
   * shades in. The addon cuts it from the fragment's pixel coordinate; this
   * cuts it from the fragment's share of the target, so it names the same
   * cluster at every render scale. The depth slice is the addon's own, because
   * the compute's Z bounds are what it must land in.
   */
  create(width: number, height: number): void {
    buildAddonGrid.call(this, width, height);
    const inside = this as unknown as ClusteredInternals;
    inside._screenClusterIndex = Fn(() => {
      const grid = inside._gridDimensions;
      const across = int(grid.x);
      const down = int(grid.y);
      const tile = screenUV.mul(grid).floor();
      const depth = positionView.z.negate();
      const nearToFar = inside._cameraFar.div(inside._cameraNear);
      const slices = log(depth.div(inside._cameraNear))
        .mul(float(1).div(log(nearToFar)))
        .mul(float(this.zSlices));
      const slice = clamp(slices.floor(), float(0), float(this.zSlices - 1));
      return int(tile.x).add(int(tile.y).mul(across)).add(int(slice).mul(across.mul(down)));
    })().toVar();
  }

  /**
   * Nothing to do. The addon's `setSize` builds a grid for whatever it is
   * given, smaller ones included; this node's grid is governed by
   * `updateProgram` alone, so the door that would shrink it is closed.
   */
  override setSize(_width: number, _height: number): this {
    return this;
  }
}

/**
 * The renderer's lighting (spec section 10.5) over the pinned node. The size
 * handed in is the largest drawing buffer the renderer will draw at: the
 * display's size at the full pixel ratio, before any render scale is applied.
 */
export class PinnedClusterLighting extends Lighting {
  private readonly pinned: GridSize;

  constructor(pinnedWidth: number, pinnedHeight: number) {
    super();
    this.pinned = { width: pinnedWidth, height: pinnedHeight };
  }

  override createNode(lights: Light[] = []): LightsNode {
    return new PinnedClusterLightsNode(this.pinned).setLights(lights);
  }
}
