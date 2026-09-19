/**
 * The chunks the scene holds, and the queue that puts them into it (spec
 * sections 2.4, 9.1).
 *
 * The chunks are built in workers (`chunk-pool.ts`) and arrive as plain
 * arrays; this file puts them into the scene, and that upload is the only part
 * of the work the frame is charged for. It is spread over frames against the
 * streaming slice of spec section 2.4: the tiles take what has arrived, add as
 * much of it as the budget allows, and leave the rest for the next frame. So a
 * chunk turns up a frame or two late rather than costing the frame it arrives
 * in, which is the trade spec section 9.1 asks for.
 *
 * A chunk that crosses between the two rings is built again at its new detail
 * and swapped when it lands, so nothing ever disappears while its replacement
 * is being built. The pipeline holds no game state: `world-scene.ts` owns the
 * sceneries it builds with and hands them in.
 */
import type { Scene } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import { chunkAt } from '../world/chunks.ts';
import { Batch } from './batch.ts';
import type { BuildingScenery } from './buildings.ts';
import { cellGrid } from './cells.ts';
import type { ChunkPayload } from './chunk-payload.ts';
import type { ChunkStream } from './chunk-pool.ts';
import { groundPart } from './ground.ts';
import type { Lamp } from './lamp-mesh.ts';
import type { LampLights, LampScenery } from './lamps.ts';
import { reflected } from './mirror.ts';
import type { Poster } from './poster-mesh.ts';
import type { PosterScenery } from './posters.ts';
import { entityBudget, thinned, type QualityTier } from './quality.ts';
import type { RoadScenery } from './roads.ts';
import type { SignScenery } from './signs.ts';
import { detailAt, spendBudget, wantedChunks, type ChunkDetail, type TilePart } from './streaming.ts';
import type { PlantScenery } from './vegetation.ts';

/** What a chunk is built with: the ground's material and a scenery for each batch. */
export interface TileSceneries {
  ground: MeshStandardNodeMaterial;
  roads: RoadScenery;
  buildings: BuildingScenery;
  vegetation: PlantScenery;
  lamps: LampScenery;
  posters: PosterScenery;
  signs: SignScenery;
  /** The light pool, told when the lamps in reach change. */
  lampLights: LampLights;
}

/** One chunk, as the scene holds it. */
interface ChunkTile {
  cx: number;
  cy: number;
  detail: ChunkDetail;
  parts: TilePart[];
  /** Where every lamp of the chunk stands, so the light pool can be aimed at them. */
  lamps: Lamp[];
  /** The box of every building of the chunk, as `roofs.ts` packs them. */
  roofs: Float32Array;
  /** Where every poster of the chunk hangs, once they are in the scene. */
  posters: Poster[];
  drawCalls: number;
  /** False while the upload queue still holds pieces of it. */
  whole: boolean;
  /** True once it has been dropped, so any job left for it does nothing. */
  dead: boolean;
  /** The tile it replaces, drawn until the first piece of this one lands. */
  superseded?: ChunkTile;
}

/** The streamed chunks of the world, and the upload of them spread over frames. */
export class ChunkTiles {
  private readonly scene: Scene;
  private readonly kit: TileSceneries;
  /** The quality tier of the moment, read when a job runs rather than when it is queued. */
  private readonly tier: () => QualityTier;
  private readonly tiles = new Map<string, ChunkTile>();
  /** The upload the frames to come are charged for, oldest chunk first. */
  private readonly jobs: (() => void)[] = [];
  /** Draw calls the dearest near chunk built so far costs. */
  private peakDrawCalls = 0;

  constructor(scene: Scene, kit: TileSceneries, tier: () => QualityTier) {
    this.scene = scene;
    this.kit = kit;
    this.tier = tier;
  }

  /**
   * Drop the chunks that are out of reach of a player at `x`, `y`, queue what
   * `stream` has delivered, ask it for the ones that are missing, and put as
   * much of the queue into the scene as `budgetMs` allows.
   */
  follow(stream: ChunkStream, x: number, y: number, budgetMs: number, now: () => number): void {
    const here = chunkAt(x, y);
    const rings = this.tier().rings;
    for (const tile of [...this.tiles.values()]) {
      if (detailAt(tile.cx, tile.cy, here.cx, here.cy, rings) === undefined) this.drop(tile);
    }
    for (let payload = stream.take(); payload !== undefined; payload = stream.take()) {
      this.queueUpload(payload);
    }
    stream.want(wantedChunks(here.cx, here.cy, rings).filter((want) => this.missing(want.cx, want.cy, want.detail)));
    spendBudget(this.jobs, budgetMs, now);
  }

  /** Jobs still waiting in the upload queue. */
  get queued(): number {
    return this.jobs.length;
  }

  /** Draw calls the dearest chunk of the near ring built so far costs. */
  get drawCallsPerChunk(): number {
    return this.peakDrawCalls;
  }

  /** The packed building boxes of the chunk under a ground point and the eight around it. */
  roofsNear(x: number, z: number): Float32Array[] {
    const here = chunkAt(x, z);
    const near: Float32Array[] = [];
    for (let cy = here.cy - 1; cy <= here.cy + 1; cy++) {
      for (let cx = here.cx - 1; cx <= here.cx + 1; cx++) {
        const tile = this.tiles.get(keyOf(cx, cy));
        if (tile !== undefined) near.push(tile.roofs);
      }
    }
    return near;
  }

  /** The lamps of every chunk in reach, a chunk at a time. */
  lampsInReach(): Lamp[][] {
    const out: Lamp[][] = [];
    for (const tile of [...this.tiles.values()]) if (tile.lamps.length > 0) out.push(tile.lamps);
    return out;
  }

  /**
   * What every chunk in the scene holds: its building boxes, and the lamps and
   * posters drawn. A preview counts from these what its frame shows.
   */
  contents(): { roofs: Float32Array; lamps: readonly Lamp[]; posters: readonly Poster[] }[] {
    return [...this.tiles.values()].map((tile) => ({ roofs: tile.roofs, lamps: tile.lamps, posters: tile.posters }));
  }

  /** Chunks within `radius` of the player that are not yet whole. */
  outstanding(x: number, y: number, radius: number): number {
    const here = chunkAt(x, y);
    let waiting = 0;
    for (const want of wantedChunks(here.cx, here.cy, this.tier().rings)) {
      if (Math.max(Math.abs(want.cx - here.cx), Math.abs(want.cy - here.cy)) > radius) continue;
      const tile = this.tiles.get(keyOf(want.cx, want.cy));
      if (tile === undefined || tile.detail !== want.detail || !tile.whole) waiting++;
    }
    return waiting;
  }

  /** Forget the queue and take every tile out of the scene. */
  dispose(): void {
    this.jobs.length = 0;
    for (const tile of [...this.tiles.values()]) this.drop(tile);
  }

  /** True when the scene holds neither that chunk at that detail nor a build of it. */
  private missing(cx: number, cy: number, detail: ChunkDetail): boolean {
    const tile = this.tiles.get(keyOf(cx, cy));
    return tile === undefined || tile.detail !== detail;
  }

  /**
   * Cut a payload into the jobs that put it into the scene, one batch at a
   * time: the ground, then each tier of road, then each batch of buildings,
   * then the plants, the lamps and the posters. Each spreads again into a step per
   * part of its batch as it runs, so a chunk of the core is dozens of small
   * jobs and a chunk of open country is one.
   */
  private queueUpload(payload: ChunkPayload): void {
    const key = keyOf(payload.cx, payload.cy);
    const grid = cellGrid(payload.bounds, payload.detail);
    const kit = this.kit;
    const tile: ChunkTile = {
      cx: payload.cx,
      cy: payload.cy,
      detail: payload.detail,
      parts: [],
      lamps: [],
      roofs: payload.roofs,
      posters: [],
      drawCalls: 0,
      whole: false,
      dead: false,
    };
    const standing = this.tiles.get(key);
    if (standing !== undefined) tile.superseded = standing;
    this.tiles.set(key, tile);

    const { ground, bounds } = payload;
    this.queueJob(tile, () => this.add(tile, groundPart(ground, bounds.minX, bounds.minY, kit.ground)));
    for (const roads of payload.roads) {
      this.queueJob(tile, () => this.add(tile, kit.roads.build(roads)));
    }
    if (payload.outlines.length > 0) {
      this.queueJob(tile, () => this.add(tile, kit.buildings.build('outline', payload.outlines)));
    }
    if (payload.facades.length > 0) {
      this.queueJob(tile, () => this.add(tile, kit.buildings.build('facade', payload.facades)));
    }
    if (payload.blocks.length > 0) {
      this.queueJob(tile, () => this.add(tile, kit.buildings.build('block', payload.blocks)));
    }
    // A chunk places only what its category's cap and the tier's density allow
    // (spec section 9.2). The thinning is done here rather than in the worker
    // because the tier can change between a chunk being asked for and it
    // arriving, and it is a walk over a list against a whole chunk built.
    if (payload.plants.models.length > 0) {
      this.queueJob(tile, () => {
        const limit = entityBudget(this.tier(), 'plants', payload.plants.models.length);
        this.add(tile, kit.vegetation.build(grid, payload.plants, limit));
      });
    }
    if (payload.lamps.length > 0) {
      this.queueJob(tile, () => {
        const lamps = thinned(payload.lamps, entityBudget(this.tier(), 'lamps', payload.lamps.length));
        this.add(tile, kit.lamps.build(grid, lamps));
        // The pool is aimed at the lamps nearest the player, and a chunk that
        // has just landed may hold some of them. It aims at the masts drawn,
        // so a thinned lamp throws no light either.
        tile.lamps = [...lamps];
        kit.lampLights.invalidate();
      });
    }
    // The posters are not thinned by the tier: a chunk carries a handful, and
    // the information of spec section 19 is not what a low tier drops.
    if (payload.posters.length > 0) {
      this.queueJob(tile, () => {
        this.add(tile, kit.posters.build(grid, payload.posters));
        tile.posters = payload.posters;
      });
    }
    // Nor are the signs: a high street with its lettering thinned away is a
    // district the player can no longer read (spec section 13.1).
    if (payload.signs.length > 0) {
      this.queueJob(tile, () => this.add(tile, kit.signs.build(grid, payload.signs)));
    }
    this.queueJob(tile, () => {
      tile.whole = true;
      if (tile.detail !== 'far') this.peakDrawCalls = Math.max(this.peakDrawCalls, tile.drawCalls);
    });
  }

  /** Queue one piece of a tile, and skip it if the tile is dropped before it runs. */
  private queueJob(tile: ChunkTile, job: () => void): void {
    this.jobs.push(this.guarded(tile, job));
  }

  /** A job that does nothing once its tile has been dropped. */
  private guarded(tile: ChunkTile, job: () => void): () => void {
    return () => {
      if (tile.dead) return;
      this.retire(tile);
      job();
    };
  }

  /** Take away the tile this one replaces, once there is something to replace it with. */
  private retire(tile: ChunkTile): void {
    if (tile.superseded === undefined) return;
    const old = tile.superseded;
    tile.superseded = undefined;
    this.remove(old);
  }

  /**
   * Add one piece of a tile to the scene, and put what is left of filling its
   * batches at the front of the queue. The steps go in front so a chunk is
   * finished before the next one is started: a batch half filled is a building
   * still missing, and the frame after should be the one that finishes it.
   *
   * Every batch of a chunk is solid geometry standing on the ground, so it
   * takes the sun's shadow, and casts one unless its piece says otherwise: the
   * outline hulls stand over the roofs they rim and would shade them
   * (`buildings.ts`), and paving and paint on the ground shade only themselves
   * (`roads.ts`). `mirrored` is the same answer for the water's mirror, which
   * draws what stands tall and leaves the ground to the view (`mirror.ts`).
   */
  private add(tile: ChunkTile, part: TilePart): void {
    const casts = part.castsShadow ?? true;
    for (const object of part.objects) {
      if (object instanceof Batch) {
        object.castShadow = casts && part.shadowless?.includes(object) !== true;
        object.receiveShadow = true;
      }
      if (part.mirrored === true) reflected(object);
      this.scene.add(object);
    }
    tile.parts.push(part);
    tile.drawCalls += part.drawCalls;
    if (part.steps.length > 0) this.jobs.unshift(...part.steps.map((step) => this.guarded(tile, step)));
    // The queue holds the steps now. A step holds the worker's arrays it copies
    // from, so a tile that kept them would hold its whole chunk twice.
    part.steps = [];
  }

  /** Drop a tile the player has driven away from. */
  private drop(tile: ChunkTile): void {
    this.tiles.delete(keyOf(tile.cx, tile.cy));
    this.remove(tile);
  }

  /** Take a tile out of the scene and release its geometry, whole or not. */
  private remove(tile: ChunkTile): void {
    tile.dead = true;
    if (tile.superseded !== undefined) {
      this.remove(tile.superseded);
      tile.superseded = undefined;
    }
    for (const part of tile.parts) {
      for (const object of part.objects) this.scene.remove(object);
      part.dispose();
    }
    tile.parts.length = 0;
    tile.posters = [];
    if (tile.lamps.length > 0) {
      tile.lamps = [];
      this.kit.lampLights.invalidate();
    }
  }
}

function keyOf(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
