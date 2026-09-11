/**
 * The scene a session plays in: the ground of a whole seed, lit, with the
 * player standing on it (spec sections 10.1 and 10.7).
 *
 * The world description says where everything is; this reads it and never
 * changes it. Every chunk of the map becomes one tile, and the tiles are cut
 * once at the start. Cutting them as the camera reaches them, on a worker and
 * inside a frame budget, is the streaming of spec section 9.1 and comes later;
 * until then a seed costs a few seconds at the door and nothing after that.
 *
 * Only the ground is here. Road surfaces, water, buildings, vegetation and the
 * real lighting rig each have their own spec section and their own issue, so
 * the light below is a placeholder: one sun and one fill, enough to read the
 * relief the carve leaves.
 */
import { AmbientLight, Color, DirectionalLight, Fog, Mesh, Scene } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { CharacterAppearance } from '../sim/character.ts';
import { buildLayers, ChunkSource, CHUNK_SIZE } from '../world/chunks.ts';
import { carvedTerrain } from '../world/carve.ts';
import { layoutZones } from '../world/districts.ts';
import type { Heightfield } from '../world/heightfield.ts';
import type { WorldDescription } from '../world/types.ts';
import { CharacterModel } from './character.ts';
import { buildTerrainTile } from './terrain.ts';
import { createTerrainMaterial } from './terrain-material.ts';

/** The sky, and the haze the far hills fade into. Both are placeholders until spec section 10.5. */
const SKY = 0x9fb6c8;
const FOG_NEAR = 300;
const FOG_FAR = 1400;
/** The sun: warm, low and bright enough to throw the relief into relief. */
const SUN_COLOUR = 0xffe7c4;
const SUN_STRENGTH = 2.4;
const SUN_AT: readonly [number, number, number] = [0.5, 1, 0.35];
const FILL_COLOUR = 0x8fa8c0;
const FILL_STRENGTH = 0.9;

/** Metres the player's feet stand above the ground, so they never sink into it. */
const FOOT_CLEARANCE = 0.02;

/**
 * The scene of one seed. Build it once the title screen has handed over a seed
 * and a look; `dispose` gives the GPU its buffers back.
 */
export class WorldView {
  readonly scene: Scene;
  readonly character: CharacterModel;
  /** The ground the roads leave, which is what the tiles are cut from. */
  private readonly ground: Heightfield;
  private readonly material: MeshStandardNodeMaterial;
  private readonly tiles: Mesh[] = [];

  constructor(world: WorldDescription, appearance: CharacterAppearance) {
    this.scene = new Scene();
    this.scene.background = new Color(SKY);
    this.scene.fog = new Fog(SKY, FOG_NEAR, FOG_FAR);

    const layers = buildLayers(world);
    this.ground = carvedTerrain(world.terrain, layers.carve);
    const zones = layoutZones(world.size, world.core, world.water);
    const source = new ChunkSource(world, layers);
    const groundAt = (x: number, y: number): number => this.ground.sample(x, y);
    this.material = createTerrainMaterial();

    // The chunk grid is anchored on the origin, so the map runs from the chunk
    // holding one corner to the chunk holding the other.
    const reach = Math.ceil(world.size / 2 / CHUNK_SIZE);
    for (let cx = -reach; cx < reach; cx++) {
      for (let cy = -reach; cy < reach; cy++) {
        const tile = buildTerrainTile(source.chunk(cx, cy), zones, groundAt);
        const mesh = new Mesh(tile.geometry, this.material);
        // The tile never moves, and its own bounds are what the camera culls by.
        mesh.matrixAutoUpdate = false;
        tile.geometry.computeBoundingSphere();
        this.tiles.push(mesh);
        this.scene.add(mesh);
      }
    }

    const sun = new DirectionalLight(SUN_COLOUR, SUN_STRENGTH);
    sun.position.set(SUN_AT[0], SUN_AT[1], SUN_AT[2]);
    this.scene.add(sun);
    this.scene.add(new AmbientLight(FILL_COLOUR, FILL_STRENGTH));

    this.character = new CharacterModel(appearance);
    this.scene.add(this.character.group);
  }

  /** The height of the ground the roads leave, at one place. */
  heightAt(x: number, y: number): number {
    return this.ground.sample(x, y);
  }

  /** Stand the player on the ground at their simulated place. */
  placeCharacter(x: number, y: number, heading: number): void {
    this.character.group.position.set(x, this.heightAt(x, y) + FOOT_CLEARANCE, y);
    this.character.group.rotation.y = -heading;
  }

  dispose(): void {
    for (const tile of this.tiles) tile.geometry.dispose();
    this.tiles.length = 0;
    this.material.dispose();
  }
}
