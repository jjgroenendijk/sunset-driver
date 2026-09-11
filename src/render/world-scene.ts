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
import { BatchedMesh, Mesh, Object3D, Scene, type BufferGeometry } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { CharacterAppearance } from '../sim/character.ts';
import { START_TICK } from '../sim/simulation.ts';
import { buildLayers, chunkAt, ChunkSource, CHUNK_SIZE, type WorldLayers } from '../world/chunks.ts';
import type { WorldDescription } from '../world/types.ts';
import { RoadRibbons } from '../world/ribbon.ts';
import { buildingLookup, type BuildingLookup } from './building-mesh.ts';
import { BuildingScenery, type BuildingTile } from './buildings.ts';
import { daylightAt, type Daylight } from './daylight.ts';
import type { Lamp } from './lamp-mesh.ts';
import { LampLights, LampScenery, type LampTile } from './lamps.ts';
import { plantLookup, type PlantLookup } from './plant-mesh.ts';
import { PlantScenery, type VegetationTile } from './vegetation.ts';
import { CharacterModel } from './character.ts';
import { buildGroundAttributes, groundGeometry, groundLookup, type GroundLookup } from './ground.ts';
import { createGroundMaterial } from './ground-material.ts';
import { RoadScenery, type RoadTile } from './roads.ts';
import { SkyLighting } from './sky.ts';
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
  lamps: LampTile;
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
  private readonly sky: SkyLighting;
  private readonly lamps = new LampScenery();
  private readonly lampLights: LampLights;
  /** The light of the tick the scene was last set to. */
  private light: Daylight;
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
    this.water = createWaterSurface(world);
    this.scene.add(this.water.object);

    // The sky, the sun and the shadows it casts. The ground stops at the last
    // chunk built, and the haze is what stands there until the draw distance of
    // spec section 9.2 does.
    this.sky = new SkyLighting(this.scene, FOG_NEAR, FOG_FAR);
    this.lampLights = new LampLights(this.scene);

    this.character = new CharacterModel(appearance);
    this.character.group.traverse((object) => {
      object.castShadow = true;
    });
    this.scene.add(this.character.group);

    // A session starts at 08:00, so the first frame is already lit.
    this.light = daylightAt(START_TICK);
    this.apply();
  }

  /**
   * Light the scene as it stands at a tick (spec section 10.5). One in-game day
   * is 86 400 ticks, so the whole cycle runs in 24 real minutes. Everything the
   * hour decides is set here: the sky, the sun, the haze, the lit windows and
   * the street lamps.
   */
  set time(tick: number) {
    this.light = daylightAt(tick);
    this.apply();
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
      if (next === undefined) break;
      this.build(next.cx, next.cy);
    }
    this.look(x, y);
  }

  /**
   * Point what is lit at the player without building anything: the dome is
   * carried rather than laid around the map, and the light pool is handed to
   * the lamps the player has come nearest to.
   */
  look(x: number, y: number): void {
    this.sky.follow(x, y);
    this.lampLights.aim(x, y, this.lampsInReach(), this.light.lamps);
  }

  /** Refit the sun's shadow cascades after the camera's shape changes. */
  resize(): void {
    this.sky.resize();
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

  /** How far into the night it is, 0 by day and 1 at midnight, at the tick last set. */
  get night(): number {
    return this.light.night;
  }

  /**
   * Lights the scene holds (spec section 10.5): the sun, the sky fill and the
   * street lamps that are throwing light. The HUD shows this beside the draw
   * calls, so a light leak is visible while playing.
   */
  get lightCount(): number {
    return this.sky.lightCount + this.lampLights.count;
  }

  /** Shadow maps the sun is split into. The lamps cast none. */
  get shadowCascades(): number {
    return this.sky.shadowCascades;
  }

  /** Release every chunk and the materials they share. */
  dispose(): void {
    for (const tile of [...this.tiles.values()]) this.drop(tile);
    this.scene.remove(this.water.object);
    this.water.dispose();
    this.sky.dispose();
    this.lampLights.dispose();
    this.material.dispose();
    this.scenery.dispose();
    this.buildings.dispose();
    this.vegetation.dispose();
    this.lamps.dispose();
    this.character.dispose();
  }

  /** Hand the light of the moment to everything that reads it. */
  private apply(): void {
    this.sky.set(this.light);
    this.water.setSun(this.light.sun, this.light.sunColour);
    this.buildings.night = this.light.night;
    this.lamps.lamps = this.light.lamps;
  }

  /** The lamps of every chunk in reach, a chunk at a time. */
  private lampsInReach(): Lamp[][] {
    const out: Lamp[][] = [];
    for (const tile of [...this.tiles.values()]) if (tile.lamps.lamps.length > 0) out.push(tile.lamps.lamps);
    return out;
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
    // The ground takes the shadows of everything standing on it and casts none
    // of its own: the relief the sun shades is already in the carve.
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    // The road geometry is already in world places, so its meshes stand at the
    // origin rather than at the chunk's corner.
    const roads = this.scenery.build(chunk, this.ribbons);
    this.add(roads.objects);
    const buildings = this.buildings.build(chunk, this.standing);
    this.add(buildings.objects);
    const plants = this.vegetation.build(chunk, this.growing);
    this.add(plants.objects);
    const lamps = this.lamps.build(chunk, this.ribbons);
    this.add(lamps.objects);
    this.lampLights.invalidate();
    this.peakDrawCalls = Math.max(
      this.peakDrawCalls,
      1 + roads.drawCalls + buildings.drawCalls + plants.drawCalls + lamps.drawCalls,
    );
    this.tiles.set(key, { mesh, geometry, roads, buildings, plants, lamps, cx, cy });
  }

  /**
   * Add a tile's objects to the scene, casting and taking the sun's shadow.
   * Every batch of a chunk is solid geometry standing on the ground; the road
   * markings are lines painted on the surface and neither cast nor take one.
   */
  private add(objects: readonly Object3D[]): void {
    for (const object of objects) {
      if (object instanceof BatchedMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
      this.scene.add(object);
    }
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
    for (const object of tile.lamps.objects) this.scene.remove(object);
    tile.lamps.dispose();
    this.lampLights.invalidate();
    this.tiles.delete(keyOf(tile.cx, tile.cy));
  }
}

function keyOf(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
