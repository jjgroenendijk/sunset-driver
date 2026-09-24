import { Vector3, type BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import {
  BARE_SPECIES,
  buildChunkVegetation,
  buildPlantModels,
  modelIndex,
  PLANT_BARK,
  PLANT_LEAF,
  PLANT_SPECIES,
  SPECIES_MODELS,
  WOOD_MODELS,
  woodModelIndex,
  vegetationDrawCalls,
  type PlantLookup,
} from '../src/render/plant-mesh.ts';
import { chunkBounds, CHUNK_SIZE, type WorldChunk } from '../src/world/chunks.ts';
import { PLANT_RADIUS, type Plant, type PlantSpecies } from '../src/world/vegetation.ts';

/** The height of the ground the fixture stands on: sloped, so a plant has to read it. */
function groundAt(x: number, y: number): number {
  return 10 + x * 0.05 + y * 0.02;
}

const LOOKUP: PlantLookup = { heightAt: groundAt };

/** The same ground, with every parcel a park: the broadleaf takes the crowns of a wood. */
const WOODED: PlantLookup = { heightAt: groundAt, wooded: () => true };

/**
 * Triangles one model may cost. A plant is drawn a few hundred times in a
 * chunk of woodland, so a model over this is a geometry regression rather than
 * a cap to raise: detail belongs in the crown the camera sees, not in the twigs
 * under it.
 */
const MAX_MODEL_TRIANGLES = 320;

/** Metres a plant may be sunk into the ground it stands on. */
const ROOTING = 0.2;

/**
 * Metres a model may dip below the ground of its own frame. The ring at the
 * foot of a leaning trunk is cut across the trunk, so one side of it tips under
 * the foot; the plant is rooted deeper than this, so none of it shows.
 */
const MODEL_UNDERCUT = 0.05;

function plantOf(species: PlantSpecies, x: number, y: number, seed: number): Plant {
  return { parcel: 0, species, seed, at: { x, y }, radius: PLANT_RADIUS[species] };
}

/** A chunk holding nothing but the plants a test cares about. */
function chunkOf(plants: Plant[]): WorldChunk {
  return {
    seed: 1,
    cx: 0,
    cy: 0,
    bounds: chunkBounds(0, 0),
    terrain: { gridSize: 2, cellSize: CHUNK_SIZE, originX: 0, originY: 0, heights: new Float32Array(4) },
    seaLevel: 0,
    roads: [],
    junctions: [],
    pavement: [],
    parcels: [],
    buildings: [],
    plants,
    piers: [],
    tram: [],
    tramCrossings: [],
    tramPaved: [],
  };
}

/** The models of a world, grown once for every test that reads them. */
const models = buildPlantModels();

describe('plant models', () => {
  it('builds one model of every species and variant, and nothing else', () => {
    expect(models.length).toBe(PLANT_SPECIES.length * SPECIES_MODELS + WOOD_MODELS);
    for (const species of PLANT_SPECIES) {
      for (let variant = 0; variant < SPECIES_MODELS; variant++) {
        expect(models[modelIndex(species, variant)]).toBeDefined();
      }
    }
    // A variant past the last one wraps round rather than naming a model that
    // does not exist, so a plant's own seed can pick one without knowing how
    // many there are.
    expect(modelIndex('grass', SPECIES_MODELS + 1)).toBe(modelIndex('grass', 1));
  });

  it('stands every model on the ground, inside the canopy its species claims', () => {
    // Spec section 10.4: the placement keeps a canopy inside one parcel, and
    // that only holds if the model itself stays inside the canopy.
    const all = PLANT_SPECIES.flatMap((species) =>
      Array.from({ length: SPECIES_MODELS }, (_, variant) => ({ species, variant, model: modelIndex(species, variant) })),
    );
    for (let variant = 0; variant < WOOD_MODELS; variant++) {
      all.push({ species: 'broadleaf', variant, model: woodModelIndex(variant) });
    }
    for (const { species, variant, model } of all) {
      const geometry = models[model] as (typeof models)[number];
      const position = geometry.getAttribute('position').array as Float32Array;
      expect(geometry.getIndex(), `${species} ${variant}`).toBeNull();
      expect(position.length % 9, `${species} ${variant}`).toBe(0);
      expect(position.length / 9, `${species} ${variant}`).toBeLessThanOrEqual(MAX_MODEL_TRIANGLES);
      let reach = 0;
      let low = Infinity;
      let high = -Infinity;
      for (let v = 0; v < position.length; v += 3) {
        reach = Math.max(reach, Math.hypot(position[v] as number, position[v + 2] as number));
        low = Math.min(low, position[v + 1] as number);
        high = Math.max(high, position[v + 1] as number);
      }
      expect(reach, `${species} ${variant} reaches out`).toBeLessThanOrEqual(PLANT_RADIUS[species]);
      expect(low, `${species} ${variant} digs down`).toBeGreaterThanOrEqual(-MODEL_UNDERCUT);
      expect(high, `${species} ${variant} is flat`).toBeGreaterThan(0.3);
    }
  });

  it('turns the faces of a canopy outwards', () => {
    // The material draws front faces alone, so a shell wound the wrong way
    // round is lit on the inside: the crown comes out flat and dark, and the
    // trunk shows through it. These three species carry one shell standing on
    // the plant's own axis, so every leaf face of them has to look away from it.
    // A crown of a wood is a ball, so its faces look away from its middle.
    const shells: { name: string; model: number; ball: boolean }[] = [];
    for (const species of ['conifer', 'columnar', 'hedge'] as const) {
      for (let variant = 0; variant < SPECIES_MODELS; variant++) {
        shells.push({ name: `${species} ${variant}`, model: modelIndex(species, variant), ball: false });
      }
    }
    for (let variant = 0; variant < WOOD_MODELS; variant++) {
      shells.push({ name: `wood ${variant}`, model: woodModelIndex(variant), ball: true });
    }
    for (const { name, model, ball } of shells) {
      const geometry = models[model] as (typeof models)[number];
      const position = geometry.getAttribute('position').array as Float32Array;
      const normal = geometry.getAttribute('normal').array as Float32Array;
      const part = geometry.getAttribute('part').array as Float32Array;
      let low = Infinity;
      let high = -Infinity;
      for (let v = 0; v * 3 < position.length; v++) {
        if (part[v] !== PLANT_LEAF) continue;
        low = Math.min(low, position[v * 3 + 1] as number);
        high = Math.max(high, position[v * 3 + 1] as number);
      }
      const middle = (low + high) / 2;
      for (let t = 0; t * 9 < position.length; t++) {
        const v = t * 9;
        if (part[t * 3] !== PLANT_LEAF) continue;
        const mid = [0, 1, 2].map((k) => ((position[v + k] as number) + (position[v + 3 + k] as number) + (position[v + 6 + k] as number)) / 3);
        const up = ball ? ((mid[1] as number) - middle) * (normal[v + 1] as number) : 0;
        const out = (mid[0] as number) * (normal[v] as number) + (mid[2] as number) * (normal[v + 2] as number) + up;
        expect(out, `${name} face ${t} looks inwards`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('runs the foliage from 0 at its foot to 1 at its top, and leaves the bark at 0', () => {
    // The material runs the hue of a crown along `rise` (`plant-material.ts`).
    for (const geometry of models) {
      const rise = geometry.getAttribute('rise').array as Float32Array;
      const part = geometry.getAttribute('part').array as Float32Array;
      const y = geometry.getAttribute('position');
      let low = 1;
      let high = 0;
      for (let v = 0; v < rise.length; v++) {
        const value = rise[v] as number;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        if (part[v] === PLANT_BARK) expect(value).toBe(0);
        else {
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      }
      if (high > 0) {
        expect(low).toBe(0);
        expect(high).toBe(1);
      }
      expect(rise.length).toBe(y.count);
    }
  });

  it('dresses every vertex as bark or as leaf, and nothing else', () => {
    for (const species of PLANT_SPECIES) {
      for (let variant = 0; variant < SPECIES_MODELS; variant++) {
        const geometry = models[modelIndex(species, variant)] as (typeof models)[number];
        const part = geometry.getAttribute('part').array as Float32Array;
        const tint = geometry.getAttribute('tint');
        const normal = geometry.getAttribute('normal');
        expect(tint.count).toBe(geometry.getAttribute('position').count);
        expect(normal.count).toBe(geometry.getAttribute('position').count);
        let leaves = 0;
        for (const value of part) {
          expect(value === PLANT_BARK || value === PLANT_LEAF).toBe(true);
          if (value === PLANT_LEAF) leaves++;
        }
        // Every plant carries foliage, but for the one species that is a bare
        // skeleton on purpose.
        if (species === BARE_SPECIES) expect(leaves, `${species} ${variant}`).toBe(0);
        else expect(leaves, `${species} ${variant}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the plants of a chunk', () => {
  it('costs one batch whatever grows there, and nothing where nothing does', () => {
    expect(vegetationDrawCalls(chunkOf([]))).toBe(0);
    expect(vegetationDrawCalls(chunkOf([plantOf('broadleaf', 40, 40, 7)]))).toBe(1);
    expect(
      vegetationDrawCalls(chunkOf(PLANT_SPECIES.map((species, i) => plantOf(species, 40 + i * 9, 40, i + 1)))),
    ).toBe(1);
  });

  it('stands every plant on the ground it grows on, inside the canopy it claims', () => {
    // The last link of the chain: `vegetation.ts` keeps the canopy inside the
    // parcel, so a plant that stands inside its canopy stands off the road.
    const plants: Plant[] = [];
    for (let i = 0; i < PLANT_SPECIES.length * 6; i++) {
      const species = PLANT_SPECIES[i % PLANT_SPECIES.length] as PlantSpecies;
      plants.push(plantOf(species, 20 + (i % 12) * 9, 20 + Math.floor(i / 12) * 9, 0x1000 + i * 7919));
    }
    const wood = woodModelIndex(0);
    for (const lookup of [LOOKUP, WOODED]) {
      const placed = buildChunkVegetation(chunkOf(plants), lookup);
      expect(placed.length).toBe(plants.length);
      const takes = new Set<number>();
      const at = new Vector3();
      for (const one of placed) {
        const plant = one.plant;
        const where = `${plant.species} at ${plant.at.x}, ${plant.at.y}`;
        // In a wood the broadleaf takes the crowns of a wood, and nothing else does.
        const woody = lookup === WOODED && plant.species === 'broadleaf';
        expect(one.model >= wood, where).toBe(woody);
        const species = woody ? 'broadleaf' : PLANT_SPECIES[Math.floor(one.model / SPECIES_MODELS)];
        expect(species, where).toBe(plant.species);
        takes.add(one.model);
        const geometry = models[one.model] as (typeof models)[number];
        const position = geometry.getAttribute('position') as BufferAttribute;
        let sunk = 0;
        for (let v = 0; v < position.count; v++) {
          at.fromBufferAttribute(position, v).applyMatrix4(one.matrix);
          expect(Number.isFinite(at.x + at.y + at.z), where).toBe(true);
          const out = Math.hypot(at.x - plant.at.x, at.z - plant.at.y);
          expect(out, `${where} reaches out of its canopy`).toBeLessThanOrEqual(plant.radius);
          sunk = Math.max(sunk, groundAt(plant.at.x, plant.at.y) - at.y);
        }
        // It is rooted in the ground rather than hovering over it or buried in it.
        expect(sunk, `${where} stands off the ground`).toBeGreaterThan(0);
        expect(sunk, `${where} is buried`).toBeLessThanOrEqual(ROOTING);
      }
      // The plants of a chunk take more than one model, so a wood is not one tree
      // stamped over and over.
      expect(takes.size).toBeGreaterThan(PLANT_SPECIES.length);
    }
  });
});
