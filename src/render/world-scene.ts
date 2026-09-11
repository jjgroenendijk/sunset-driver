/**
 * The scene the game is played in (spec sections 9.1, 10.1).
 *
 * A world is generated once, cut into chunks, and the chunks near the player
 * are drawn as ground meshes. Chunks outside that reach are dropped and rebuilt
 * if the player comes back, which costs nothing beyond the clip: the layers a
 * chunk is cut from are built once and never written to.
 *
 * The scene reads the world description and never mutates it.
 */
import { Color, DirectionalLight, Fog, HemisphereLight, Mesh, Scene, type BufferGeometry } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { CharacterAppearance } from '../sim/character.ts';
import { buildLayers, chunkAt, ChunkSource, CHUNK_SIZE, type WorldLayers } from '../world/chunks.ts';
import type { WorldDescription } from '../world/types.ts';
import { CharacterModel } from './character.ts';
import { buildGroundAttributes, groundGeometry, groundLookup, type GroundLookup } from './ground.ts';
import { createGroundMaterial } from './ground-material.ts';

/** Chunks each way of the player that carry ground. One chunk is 250 m. */
const CHUNK_RADIUS = 2;

/**
 * Chunks built per update. Cutting one costs several milliseconds, which is
 * over the streaming slice of spec section 2.4; the `WorkerPool` and the frame
 * budget that fix it are issue #23. One at a time keeps the stall to a frame.
 */
const BUILDS_PER_UPDATE = 1;

/** Colour of the sky and of the haze the far chunks fade into. */
const SKY = 0x9ab0c0;

/** Metres at which the haze starts, and at which it is complete. */
const FOG_NEAR = CHUNK_RADIUS * CHUNK_SIZE * 0.45;
const FOG_FAR = CHUNK_RADIUS * CHUNK_SIZE;

/** One chunk's ground, as the scene holds it. */
interface GroundTile {
  mesh: Mesh;
  geometry: BufferGeometry;
  cx: number;
  cy: number;
}

/** The world, drawn. */
export class WorldScene {
  readonly scene = new Scene();
  readonly character: CharacterModel;
  readonly world: WorldDescription;
  private readonly source: ChunkSource;
  private readonly lookup: GroundLookup;
  private readonly material: MeshStandardNodeMaterial;
  private readonly tiles = new Map<string, GroundTile>();

  constructor(world: WorldDescription, appearance: CharacterAppearance, layers: WorldLayers = buildLayers(world)) {
    this.world = world;
    this.source = new ChunkSource(world, layers);
    this.lookup = groundLookup(world, layers);
    this.material = createGroundMaterial(world.water.seaLevel);

    this.scene.background = new Color(SKY);
    // The ground stops at the last chunk built. The haze is what stands there
    // until the draw distance of spec section 9.2 does.
    this.scene.fog = new Fog(SKY, FOG_NEAR, FOG_FAR);

    const sun = new DirectionalLight(0xffe2bc, 2.4);
    sun.position.set(120, 200, 60);
    this.scene.add(sun);
    this.scene.add(new HemisphereLight(0xc6dcf2, 0x3b342a, 1));

    this.character = new CharacterModel(appearance);
    this.scene.add(this.character.group);
  }

  /** The carved height of the ground at a place, so things stand on it. */
  heightAt(x: number, y: number): number {
    return this.lookup.heightAt(x, y);
  }

  /** Build every chunk within `radius` at once, so the first frame has ground under the player. */
  prime(x: number, y: number, radius = 1): void {
    const here = chunkAt(x, y);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) this.build(here.cx + dx, here.cy + dy);
    }
  }

  /**
   * Follow the player: drop the chunks that are out of reach and build the
   * nearest missing one. Called once a frame, so the ground fills in over the
   * frames after a long jump rather than in one stall.
   */
  update(x: number, y: number): void {
    const here = chunkAt(x, y);
    for (const tile of [...this.tiles.values()]) {
      if (Math.abs(tile.cx - here.cx) > CHUNK_RADIUS || Math.abs(tile.cy - here.cy) > CHUNK_RADIUS) this.drop(tile);
    }
    for (let built = 0; built < BUILDS_PER_UPDATE; built++) {
      const next = this.nearestMissing(here.cx, here.cy);
      if (next === undefined) return;
      this.build(next.cx, next.cy);
    }
  }

  /** Release every chunk and the material they share. */
  dispose(): void {
    for (const tile of [...this.tiles.values()]) this.drop(tile);
    this.material.dispose();
    this.character.dispose();
  }

  /** The chunk in reach that is not built yet and is nearest the player, if any. */
  private nearestMissing(cx: number, cy: number): { cx: number; cy: number } | undefined {
    let best: { cx: number; cy: number } | undefined;
    let bestDistance = Infinity;
    for (let dy = -CHUNK_RADIUS; dy <= CHUNK_RADIUS; dy++) {
      for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
        if (this.tiles.has(keyOf(cx + dx, cy + dy))) continue;
        const distance = dx * dx + dy * dy;
        if (distance >= bestDistance) continue;
        bestDistance = distance;
        best = { cx: cx + dx, cy: cy + dy };
      }
    }
    return best;
  }

  private build(cx: number, cy: number): void {
    const key = keyOf(cx, cy);
    if (this.tiles.has(key)) return;
    const chunk = this.source.chunk(cx, cy);
    const geometry = groundGeometry(buildGroundAttributes(chunk, this.lookup));
    const mesh = new Mesh(geometry, this.material);
    mesh.position.set(chunk.bounds.minX, 0, chunk.bounds.minY);
    this.scene.add(mesh);
    this.tiles.set(key, { mesh, geometry, cx, cy });
  }

  private drop(tile: GroundTile): void {
    this.scene.remove(tile.mesh);
    tile.geometry.dispose();
    this.tiles.delete(keyOf(tile.cx, tile.cy));
  }
}

function keyOf(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
