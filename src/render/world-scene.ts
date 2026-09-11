/**
 * The scene the game is played in (spec sections 9.1, 10.1).
 *
 * A world is generated once, cut into chunks, and the chunks near the player are
 * drawn: the ground, the roads over it, the buildings that stand on it and the
 * plants that grow on what is left.
 * Chunks outside that reach are dropped and rebuilt if the player comes back,
 * which costs nothing beyond the clip and the geometry: the layers a chunk is
 * cut from are built once and never written to.
 *
 * The scene reads the world description and never mutates it.
 */
import { Color, DirectionalLight, Fog, HemisphereLight, Mesh, Scene, Vector3, type BufferGeometry } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { CharacterAppearance } from '../sim/character.ts';
import { buildLayers, chunkAt, ChunkSource, CHUNK_SIZE, type WorldLayers } from '../world/chunks.ts';
import type { WorldDescription } from '../world/types.ts';
import { RoadRibbons } from '../world/ribbon.ts';
import { buildingLookup, type BuildingLookup } from './building-mesh.ts';
import { BuildingScenery, type BuildingTile } from './buildings.ts';
import { plantLookup, type PlantLookup } from './plant-mesh.ts';
import { PlantScenery, type VegetationTile } from './vegetation.ts';
import { CharacterModel } from './character.ts';
import { buildGroundAttributes, groundGeometry, groundLookup, type GroundLookup } from './ground.ts';
import { createGroundMaterial } from './ground-material.ts';
import { RoadScenery, type RoadTile } from './roads.ts';
import { createWaterSurface, type WaterSurface } from './water-surface.ts';

/** Chunks each way of the player that carry ground. One chunk is 250 m. */
const CHUNK_RADIUS = 2;

/**
 * Chunks built per update. Cutting one costs several milliseconds and
 * generating its buildings costs tens of them in the core, both well over the
 * streaming slice of spec section 2.4; the `WorkerPool` and the frame budget
 * that fix it are issue #23. One at a time keeps the stall to a frame.
 */
const BUILDS_PER_UPDATE = 1;

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

/** Metres at which the haze starts, and at which it is complete. */
const FOG_NEAR = CHUNK_RADIUS * CHUNK_SIZE * 0.45;
const FOG_FAR = CHUNK_RADIUS * CHUNK_SIZE;

/** One chunk, as the scene holds it: the ground, the roads over it, and what stands on it. */
interface ChunkTile {
  mesh: Mesh;
  geometry: BufferGeometry;
  roads: RoadTile;
  buildings: BuildingTile;
  plants: VegetationTile;
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
  private readonly tiles = new Map<string, ChunkTile>();
  private readonly ribbons: RoadRibbons;
  private readonly scenery = new RoadScenery();
  private readonly buildings = new BuildingScenery();
  private readonly standing: BuildingLookup;
  private readonly vegetation = new PlantScenery();
  private readonly growing: PlantLookup;
  private readonly water: WaterSurface;
  /** Draw calls the dearest chunk built so far costs: ground, roads and buildings. */
  private peakDrawCalls = 0;

  constructor(world: WorldDescription, appearance: CharacterAppearance, layers: WorldLayers = buildLayers(world)) {
    this.world = world;
    this.source = new ChunkSource(world, layers);
    this.lookup = groundLookup(world, layers);
    this.standing = buildingLookup(world, layers);
    this.growing = plantLookup(layers);
    this.material = createGroundMaterial(world.water.seaLevel);
    this.ribbons = new RoadRibbons(world.terrain, world.roads);

    // The sea, the straits, the river and the harbour are one surface at sea
    // level (spec section 7.2), laid over the whole map rather than cut per
    // chunk: its reflection is a second pass over the scene, and one is enough.
    this.water = createWaterSurface(world, { direction: SUN_PLACE, colour: SUN_COLOUR });
    this.scene.add(this.water.object);

    this.scene.background = new Color(SKY);
    // The ground stops at the last chunk built. The haze is what stands there
    // until the draw distance of spec section 9.2 does.
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

  /**
   * Draw calls the dearest chunk built so far costs. Spec section 9.2 caps the
   * city at a small number of draws, and `CHUNK_DRAW_CALL_CAP` is what a chunk
   * may spend of it; the HUD shows this so a regression is visible while
   * playing rather than only in the test that enforces the cap.
   */
  get drawCallsPerChunk(): number {
    return this.peakDrawCalls;
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

  /** Release every chunk and the materials they share. */
  dispose(): void {
    for (const tile of [...this.tiles.values()]) this.drop(tile);
    this.scene.remove(this.water.object);
    this.water.dispose();
    this.material.dispose();
    this.scenery.dispose();
    this.buildings.dispose();
    this.vegetation.dispose();
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
    // The road geometry is already in world places, so its meshes stand at the
    // origin rather than at the chunk's corner.
    const roads = this.scenery.build(chunk, this.ribbons);
    for (const object of roads.objects) this.scene.add(object);
    const buildings = this.buildings.build(chunk, this.standing);
    for (const object of buildings.objects) this.scene.add(object);
    const plants = this.vegetation.build(chunk, this.growing);
    for (const object of plants.objects) this.scene.add(object);
    this.peakDrawCalls = Math.max(
      this.peakDrawCalls,
      1 + roads.drawCalls + buildings.drawCalls + plants.drawCalls,
    );
    this.tiles.set(key, { mesh, geometry, roads, buildings, plants, cx, cy });
  }

  private drop(tile: ChunkTile): void {
    this.scene.remove(tile.mesh);
    tile.geometry.dispose();
    for (const object of tile.roads.objects) this.scene.remove(object);
    tile.roads.dispose();
    for (const object of tile.buildings.objects) this.scene.remove(object);
    tile.buildings.dispose();
    for (const object of tile.plants.objects) this.scene.remove(object);
    tile.plants.dispose();
    this.tiles.delete(keyOf(tile.cx, tile.cy));
  }
}

function keyOf(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
