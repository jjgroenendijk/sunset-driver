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
 */
import { Vector2 } from 'three';
import ClusteredLightsNode from 'three/examples/jsm/tsl/lighting/ClusteredLightsNode.js';
import { Lighting, type LightsNode, type WebGPURenderer } from 'three/webgpu';
import type { Light } from 'three';
import { clamp, float, Fn, int, log, positionView, screenUV, type TslNode } from './tsl.ts';

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
