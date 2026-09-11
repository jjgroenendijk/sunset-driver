/**
 * The scene the game is played in (spec sections 9.1, 10.1).
 *
 * A world is generated once and streamed as chunks around the player. The
 * chunks are built in workers (`chunk-pool.ts`) and arrive as plain arrays;
 * this file puts them into the scene, and that upload is the only part of the
 * work the frame is charged for. It is spread over frames against the
 * streaming slice of spec section 2.4: the scene takes what has arrived, adds
 * as much of it as the budget allows, and leaves the rest for the next frame.
 * So a chunk turns up a frame or two late rather than costing the frame it
 * arrives in, which is the trade spec section 9.1 asks for.
 *
 * Two rings stand around the player (`streaming.ts`). The near ring is the
 * city in full. The far ring is the same ground at a simpler detail, so the
 * skyline holds where the near ring ends. A chunk that crosses between them is
 * built again at its new detail and swapped when it lands, so nothing ever
 * disappears while its replacement is being built.
 *
 * The scene reads the world description and never mutates it.
 */
import { Color, DirectionalLight, Fog, HemisphereLight, Mesh, Scene, Vector3 } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { CharacterAppearance } from '../sim/character.ts';
import { buildCarve, type RoadCarve } from '../world/carve.ts';
import { chunkAt, CHUNK_SIZE } from '../world/chunks.ts';
import type { WorldDescription } from '../world/types.ts';
import { BuildingScenery } from './buildings.ts';
import type { ChunkPayload } from './chunk-payload.ts';
import { ChunkPool, type ChunkStream } from './chunk-pool.ts';
import { CharacterModel } from './character.ts';
import { groundGeometry } from './ground.ts';
import { createGroundMaterial } from './ground-material.ts';
import { RoadScenery } from './roads.ts';
import { PlantScenery } from './vegetation.ts';
import {
  detailAt,
  FAR_RADIUS,
  spendBudget,
  STREAM_BUDGET_MS,
  wantedChunks,
  type ChunkDetail,
  type TilePart,
} from './streaming.ts';
import { createWaterSurface, type WaterSurface } from './water-surface.ts';

/** Colour of the sky and of the haze the far chunks fade into. */
const SKY = 0x9ab0c0;

/**
 * The one sun of the scene: where it stands, and the colour it burns. The water
 * takes its highlight from the same two, so the glare on the sea stands where
 * the light on the ground says it should. The day and night cycle of spec
 * section 10.5 is issue #21 and owns them after that.
 */
const SUN_COLOUR = 0xffe2bc;
const SUN_PLACE = new Vector3(120, 200, 60);

/**
 * Metres at which the haze starts, and at which it is complete. It closes at
 * the edge of the far ring, where the ground ends: nothing should be seen to
 * end. It opens where the near ring does, so the far ring is what fades.
 */
const FOG_NEAR = (FAR_RADIUS - 1) * CHUNK_SIZE;
const FOG_FAR = FAR_RADIUS * CHUNK_SIZE;

/** Milliseconds {@link WorldScene.settle} waits before giving up on the workers. */
const SETTLE_TIMEOUT_MS = 120_000;

/** One chunk, as the scene holds it. */
interface ChunkTile {
  cx: number;
  cy: number;
  detail: ChunkDetail;
  parts: TilePart[];
  drawCalls: number;
  /** False while the upload queue still holds pieces of it. */
  whole: boolean;
  /** True once it has been dropped, so any job left for it does nothing. */
  dead: boolean;
  /** The tile it replaces, drawn until the first piece of this one lands. */
  superseded?: ChunkTile;
}

/** The world, drawn. */
export class WorldScene {
  readonly scene = new Scene();
  readonly character: CharacterModel;
  readonly world: WorldDescription;
  private readonly stream: ChunkStream;
  private readonly heights: RoadCarve;
  private readonly material: MeshStandardNodeMaterial;
  private readonly tiles = new Map<string, ChunkTile>();
  private readonly scenery = new RoadScenery();
  private readonly buildings = new BuildingScenery();
  private readonly vegetation = new PlantScenery();
  private readonly water: WaterSurface;
  /** The upload the frames to come are charged for, oldest chunk first. */
  private readonly jobs: (() => void)[] = [];
  /** Draw calls the dearest near chunk built so far costs. */
  private peakDrawCalls = 0;

  constructor(world: WorldDescription, appearance: CharacterAppearance, stream: ChunkStream = new ChunkPool(world)) {
    this.world = world;
    this.stream = stream;
    // The carved ground the player and the camera stand on. The chunks carry
    // their own heights from the workers; this is the one place the main
    // thread asks the world itself, and it is the cheapest of the layers.
    this.heights = buildCarve(world.terrain, world.roads);
    this.material = createGroundMaterial(world.water.seaLevel);

    // The sea, the straits, the river and the harbour are one surface at sea
    // level (spec section 7.2), laid over the whole map rather than cut per
    // chunk: its reflection is a second pass over the scene, and one is enough.
    this.water = createWaterSurface(world, { direction: SUN_PLACE, colour: SUN_COLOUR });
    this.scene.add(this.water.object);

    this.scene.background = new Color(SKY);
    // The ground stops at the last chunk of the far ring. The haze is what
    // stands there until the draw distance of spec section 9.2 does.
    this.scene.fog = new Fog(SKY, FOG_NEAR, FOG_FAR);

    const sun = new DirectionalLight(SUN_COLOUR, 2.4);
    sun.position.copy(SUN_PLACE);
    this.scene.add(sun);
    this.scene.add(new HemisphereLight(0xc6dcf2, 0x3b342a, 1));

    this.character = new CharacterModel(appearance);
    this.scene.add(this.character.group);
  }

  /** The carved height of the ground at a place, so things stand on it. */
  heightAt(x: number, y: number): number {
    return this.heights.heightAt(x, y);
  }

  /**
   * Follow the player: drop the chunks that are out of reach, ask for the ones
   * that are missing, and put as much of what has arrived into the scene as
   * `budgetMs` allows. Called once a frame.
   */
  update(x: number, y: number, budgetMs = STREAM_BUDGET_MS, now: () => number = performance.now.bind(performance)): void {
    const here = chunkAt(x, y);
    for (const tile of [...this.tiles.values()]) {
      if (detailAt(tile.cx, tile.cy, here.cx, here.cy) === undefined) this.drop(tile);
    }
    for (let payload = this.stream.take(); payload !== undefined; payload = this.stream.take()) {
      this.queueUpload(payload);
    }
    this.stream.want(wantedChunks(here.cx, here.cy).filter((want) => this.missing(want.cx, want.cy, want.detail)));
    spendBudget(this.jobs, budgetMs, now);
  }

  /**
   * Build every chunk within `radius` of the player and come back when the
   * last of them is in the scene. The frame loop has not started yet when this
   * is called, so the budget is the whole of the time rather than a slice of
   * it: this is the wait before the first frame, not a frame.
   */
  async settle(x: number, y: number, radius = FAR_RADIUS, timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
    const until = performance.now() + timeoutMs;
    for (;;) {
      this.update(x, y, Infinity);
      const outstanding = this.outstanding(x, y, radius);
      if (outstanding === 0) return;
      if (performance.now() > until) {
        throw new Error(`the chunk workers did not answer: ${outstanding} chunks outstanding`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /**
   * Draw calls the dearest chunk of the near ring costs. Spec section 9.2 caps
   * the city at a small number of draws, and `CHUNK_DRAW_CALL_CAP` is what a
   * chunk may spend of it; the HUD shows this so a regression is visible while
   * playing rather than only in the test that enforces the cap.
   */
  get drawCallsPerChunk(): number {
    return this.peakDrawCalls;
  }

  /** Chunks asked for and not yet drawn, which the HUD shows as the city fills in. */
  get streaming(): number {
    return this.stream.pending + this.jobs.length;
  }

  /**
   * How far into the night it is, 0 by day and 1 at midnight. It lights the
   * windows of every building; the cycle that drives it is spec section 10.5
   * and issue #21.
   */
  get night(): number {
    return this.buildings.night;
  }

  set night(amount: number) {
    this.buildings.night = amount;
  }

  /** Release every chunk, the workers that built them and the materials they share. */
  dispose(): void {
    this.jobs.length = 0;
    for (const tile of [...this.tiles.values()]) this.drop(tile);
    this.stream.dispose();
    this.scene.remove(this.water.object);
    this.water.dispose();
    this.material.dispose();
    this.scenery.dispose();
    this.buildings.dispose();
    this.vegetation.dispose();
    this.character.dispose();
  }

  /** Chunks within `radius` of the player that are not yet whole. */
  private outstanding(x: number, y: number, radius: number): number {
    const here = chunkAt(x, y);
    let waiting = 0;
    for (const want of wantedChunks(here.cx, here.cy)) {
      if (Math.max(Math.abs(want.cx - here.cx), Math.abs(want.cy - here.cy)) > radius) continue;
      const tile = this.tiles.get(keyOf(want.cx, want.cy));
      if (tile === undefined || tile.detail !== want.detail || !tile.whole) waiting++;
    }
    return waiting;
  }

  /** True when the scene holds neither that chunk at that detail nor a build of it. */
  private missing(cx: number, cy: number, detail: ChunkDetail): boolean {
    const tile = this.tiles.get(keyOf(cx, cy));
    return tile === undefined || tile.detail !== detail;
  }

  /**
   * Cut a payload into the jobs that put it into the scene, one batch at a
   * time: the ground, then each tier of road, then each batch of buildings,
   * then the plants. Each of those spreads again into a step per part of its
   * batch as it runs, so a chunk of the core is dozens of small jobs and a
   * chunk of open country is one.
   */
  private queueUpload(payload: ChunkPayload): void {
    const key = keyOf(payload.cx, payload.cy);
    const tile: ChunkTile = {
      cx: payload.cx,
      cy: payload.cy,
      detail: payload.detail,
      parts: [],
      drawCalls: 0,
      whole: false,
      dead: false,
    };
    const standing = this.tiles.get(key);
    if (standing !== undefined) tile.superseded = standing;
    this.tiles.set(key, tile);

    this.queueJob(tile, () => {
      const geometry = groundGeometry(payload.ground);
      const mesh = new Mesh(geometry, this.material);
      mesh.position.set(payload.bounds.minX, 0, payload.bounds.minY);
      this.add(tile, { objects: [mesh], drawCalls: 1, steps: [], dispose: () => geometry.dispose() });
    });
    for (const roads of payload.roads) {
      this.queueJob(tile, () => this.add(tile, this.scenery.build(roads)));
    }
    if (payload.outlines.length > 0) {
      this.queueJob(tile, () => this.add(tile, this.buildings.build('outline', payload.outlines)));
    }
    if (payload.facades.length > 0) {
      this.queueJob(tile, () => this.add(tile, this.buildings.build('facade', payload.facades)));
    }
    if (payload.blocks.length > 0) {
      this.queueJob(tile, () => this.add(tile, this.buildings.build('block', payload.blocks)));
    }
    if (payload.plants.models.length > 0) {
      this.queueJob(tile, () => this.add(tile, this.vegetation.build(payload.plants)));
    }
    this.queueJob(tile, () => {
      tile.whole = true;
      if (tile.detail === 'near') this.peakDrawCalls = Math.max(this.peakDrawCalls, tile.drawCalls);
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
   */
  private add(tile: ChunkTile, part: TilePart): void {
    for (const object of part.objects) this.scene.add(object);
    tile.parts.push(part);
    tile.drawCalls += part.drawCalls;
    if (part.steps.length > 0) this.jobs.unshift(...part.steps.map((step) => this.guarded(tile, step)));
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
  }
}

function keyOf(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
