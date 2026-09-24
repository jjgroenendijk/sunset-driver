/**
 * The plants of one chunk, as geometry (spec sections 9.2, 10.4).
 *
 * `vegetation.ts` says where a plant stands, what species it is and how much
 * canopy it claims. This says what it looks like: a handful of models per
 * species, built once for a world, and one placement per plant. The shapes the
 * models are built out of live in `plant-shell.ts`, which this re-exports.
 *
 * A species has {@link SPECIES_MODELS} models and no more. Every plant of a
 * chunk is drawn from them, so a forest costs the geometry of a few trees
 * however many stand in it; the variety comes from the model each plant takes,
 * the way it is turned and how big it grew. That is what keeps a chunk of
 * wilderness inside the draw calls of spec section 9.2.
 *
 * A crown is one faceted shell rather than a heap of balls (`plant-shell.ts`
 * says why). The trunk and branches under it are `TreeGenerator` (spec section
 * 10.4), which grows a seeded skeleton and bakes it into one geometry. It
 * produces no foliage, so the crown is laid over it here; a palm, a rosette, a
 * hedge and a tuft of dune grass are built here from end to end, because a
 * generated skeleton is not what any of them is.
 *
 * A plant never stands on a road or on a building, by construction (spec
 * section 1.1): `vegetation.ts` keeps the whole of its canopy inside one parcel
 * and off the lots on it, a model is built inside the canopy its species claims
 * at its ordinary size, and {@link buildChunkVegetation} scales that model by
 * exactly the share of it this plant grew to. Nothing here moves a plant, so
 * nothing here can put one where it may not stand.
 *
 * A plant's own frame has it standing at the origin, `y` up. The matrix of a
 * placement is what puts that frame in the world.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferGeometry, Color, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { TreeGenerator } from 'three/examples/jsm/generators/TreeGenerator.js';
import { hashInts } from '../core/hash.ts';
import { Rng } from '../core/rng.ts';
import type { WorldChunk, WorldLayers } from '../world/chunks.ts';
import { PLANT_RADIUS, type Plant, type PlantSpecies } from '../world/vegetation.ts';
import type { Rgb } from './building-mesh.ts';
import { PlantShell, PLANT_BARK, PLANT_LEAF } from './plant-shell.ts';

export { PLANT_BARK, PLANT_LEAF } from './plant-shell.ts';
export type { Canopy, Local } from './plant-shell.ts';

/** The species, in the order their models are built and indexed. */
export const PLANT_SPECIES: readonly PlantSpecies[] = [
  'broadleaf',
  'conifer',
  'palm',
  'shrub',
  'grass',
  'columnar',
  'blossom',
  'dead',
  'agave',
  'hedge',
];

/** The one species that carries no foliage at all, because it is not alive. */
export const BARE_SPECIES: PlantSpecies = 'dead';

/**
 * Models one species is built in. A chunk draws every plant of a species from
 * these, so this is the geometry a species costs however many of it stand
 * there.
 */
export const SPECIES_MODELS = 4;

/**
 * The last model of every species is its accent: an autumn canopy where the
 * species turns, and another ordinary tone where it does not. This is how often
 * a plant takes it, so a street of green carries the odd rust tree rather than
 * a quarter of them.
 */
export const ACCENT_CHANCE = 0.14;

/** Metres a plant is sunk, so no daylight shows under it on a slope. */
const ROOTING = 0.15;

/** How tall each species stands, as a share of its own canopy radius. */
const SPECIES_RISE: Record<PlantSpecies, number> = {
  broadleaf: 2.7,
  conifer: 4.4,
  palm: 3.8,
  shrub: 1.5,
  grass: 0.95,
  columnar: 6.5,
  blossom: 1.9,
  dead: 4,
  agave: 1.8,
  hedge: 1,
};

/** How much taller than its spread a plant grows, on top of the size it grew to. */
const MIN_RISE = 0.85;
const MAX_RISE = 1.25;

/** The bark of a trunk, and of the stem of a shrub. One per model. */
const BARK: readonly number[] = [0x9a6a4a, 0x8a5e46, 0xa87a54, 0x7e5a4c];

/** The bark of a dead tree, which is weathered lavender grey rather than brown. */
const DEAD_BARK: readonly number[] = [0xb3a7ae, 0xa396a4, 0xbfb2b0, 0x978b9e];

/**
 * The leaf colours of each species, one per model, between the lime of lit
 * foliage and the olive of its shade (`docs/art-style.md`). The last of each
 * four is the accent of {@link ACCENT_CHANCE}.
 */
const LEAF: Record<PlantSpecies, readonly number[]> = {
  broadleaf: [0x9cbc45, 0xb0cc48, 0x86a843, 0xe8923a],
  conifer: [0x5f9a55, 0x6a8d41, 0x4f8a5c, 0x3f8a7a],
  palm: [0xa8c84c, 0xbcd54c, 0x8fb048, 0xd9c24a],
  shrub: [0x8fb046, 0xa3c24a, 0x7a9c44, 0xdabe40],
  grass: [0xc2cc4a, 0xd0d24c, 0xafc048, 0xdabe40],
  columnar: [0x6a8d41, 0x78a045, 0x5f8a45, 0x4f7f4a],
  blossom: [0xc21966, 0xd8407a, 0xe8923a, 0xf0a8c8],
  dead: [0xb3a7ae, 0xa396a4, 0xbfb2b0, 0x978b9e],
  agave: [0x7fb89a, 0x8fc4a4, 0x6aa88c, 0xa6c88a],
  hedge: [0x7fa845, 0x8cb44a, 0x6a8d41, 0x9cbc45],
};

/** One plant, ready for a batch. */
export interface PlantPlacement {
  plant: Plant;
  /** Which model it takes, as {@link modelIndex} numbers them. */
  model: number;
  /** The plant's frame in the world. */
  matrix: Matrix4;
}

/** What a plant's geometry asks about the world under it. */
export interface PlantLookup {
  /** The carved height at a place: the ground a plant stands on. */
  heightAt(x: number, y: number): number;
}

/** The lookup a world answers with, built once and shared by every chunk of it. */
export function plantLookup(layers: WorldLayers): PlantLookup {
  return { heightAt: (x, y) => layers.carve.heightAt(x, y) };
}

/** Which of the models of a world a species and a variant name. */
export function modelIndex(species: PlantSpecies, variant: number): number {
  return PLANT_SPECIES.indexOf(species) * SPECIES_MODELS + (variant % SPECIES_MODELS);
}

/**
 * Every model of every species, in the order {@link modelIndex} numbers them.
 * Built once for a world; a chunk copies the ones it uses into its own batch.
 */
export function buildPlantModels(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const species of PLANT_SPECIES) {
    for (let variant = 0; variant < SPECIES_MODELS; variant++) out.push(modelOf(species, variant));
  }
  return out;
}

/**
 * The plants of one chunk, in the order the chunk lists them. A placement names
 * a model rather than carrying geometry, so a chunk of forest crosses the
 * worker boundary as a matrix per tree.
 *
 * The spread is the share of its species' ordinary canopy this plant grew to.
 * A model reaches exactly that species' radius and no further, so the scaled
 * model reaches exactly `plant.radius` — which is the ground `vegetation.ts`
 * has already kept clear of the road and of the buildings.
 */
export function buildChunkVegetation(chunk: WorldChunk, lookup: PlantLookup): PlantPlacement[] {
  const out: PlantPlacement[] = [];
  for (const plant of chunk.plants) {
    const rng = new Rng(plant.seed);
    const variant = rng.float() < ACCENT_CHANCE ? SPECIES_MODELS - 1 : rng.int(0, SPECIES_MODELS - 2);
    const turn = rng.range(0, Math.PI * 2);
    const spread = plant.radius / PLANT_RADIUS[plant.species];
    const rise = spread * rng.range(MIN_RISE, MAX_RISE);
    const ground = lookup.heightAt(plant.at.x, plant.at.y) - ROOTING;
    const matrix = new Matrix4().compose(
      new Vector3(plant.at.x, ground, plant.at.y),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), turn),
      new Vector3(spread, rise, spread),
    );
    out.push({ plant, model: modelIndex(plant.species, variant), matrix });
  }
  return out;
}

/** Draw calls a chunk spends on its plants: one batch, or none where nothing grows. */
export function vegetationDrawCalls(chunk: WorldChunk): number {
  return chunk.plants.length > 0 ? 1 : 0;
}

/** One model of one species, grown from a seed of its own. */
function modelOf(species: PlantSpecies, variant: number): BufferGeometry {
  const rng = new Rng(hashInts(PLANT_SPECIES.indexOf(species), variant));
  const shell = new PlantShell();
  const radius = PLANT_RADIUS[species];
  const height = radius * SPECIES_RISE[species];
  const bark = rgbOf((species === BARE_SPECIES ? DEAD_BARK : BARK)[variant % BARK.length] as number);
  const leaf = rgbOf(LEAF[species][variant % LEAF[species].length] as number);
  switch (species) {
    case 'broadleaf':
      shell.add(branches(rng, radius * 0.13, height * 0.5, height, 34), PLANT_BARK, bark);
      crown(shell, rng, radius, height, leaf, { seat: 0.26, waist: 0.6, tip: 0.17 });
      break;
    case 'blossom':
      // A cherry is broad and flat over a short bole, not a tall mass: it is
      // the one tree in the city that is meant to be looked at.
      shell.add(branches(rng, radius * 0.11, height * 0.42, height, 46), PLANT_BARK, bark);
      crown(shell, rng, radius, height, leaf, { seat: 0.34, waist: 0.88, tip: 0.3 });
      break;
    case 'columnar':
      column(shell, rng, radius, height, bark, leaf);
      break;
    case 'conifer':
      shell.add(branches(rng, radius * 0.1, height * 0.62, height, 34), PLANT_BARK, bark);
      spire(shell, rng, radius, height, leaf);
      break;
    case 'dead':
      shell.add(branches(rng, radius * 0.14, height * 0.7, height, 46), PLANT_BARK, bark);
      break;
    case 'palm':
      palm(shell, rng, radius, height, bark, leaf);
      break;
    case 'shrub':
      bush(shell, rng, radius, height, bark, leaf);
      break;
    case 'agave':
      rosette(shell, rng, radius, height, leaf);
      break;
    case 'hedge':
      shell.canopy(rng, { base: 0, top: height, radius, sides: 4, rings: 2, lumps: 0.08, waist: 0.96, tip: 0.44 }, leaf);
      break;
    default:
      tuft(shell, rng, radius, height, leaf);
      break;
  }
  return shell.geometry();
}

/**
 * The trunk and branches of a tree, from `TreeGenerator`. The skeleton is kept
 * coarse on purpose: the camera looks down from 60 m, so what carries a tree is
 * its crown, and every ring of a twig under it is geometry the frame pays for.
 */
function branches(rng: Rng, thickness: number, bole: number, height: number, angle: number): BufferGeometry {
  // The generator dresses its mesh in a material of its own unless it is given
  // one. The models are dressed by the batch they are packed into, so it is
  // handed the cheapest material there is and the mesh is thrown away.
  const spare = new MeshBasicMaterial();
  const mesh = new TreeGenerator(spare)
    .setSeed(rng.nextU32())
    .setLevels(2)
    .setChildren([rng.int(3, 5)])
    .setBranchAngle([angle])
    // The branches stay under the crown laid over them: a limb that reached
    // past the leaves would read as a dead tree from above.
    .setLengthRatio(0.32)
    .setTrunkLength(bole)
    .setTrunkRadius(thickness)
    .setRadialSegments(4)
    .setSectionLength(height / 4)
    .setTrunkClear(0.4)
    .build();
  spare.dispose();
  const geometry = mesh.geometry.index === null ? mesh.geometry : mesh.geometry.toNonIndexed();
  if (geometry !== mesh.geometry) mesh.geometry.dispose();
  return geometry;
}

/**
 * The crown of a broadleaf: one faceted mass over the skeleton, with a lobe or
 * two off its flank so the silhouette is not a single dome. Every piece stays
 * inside the radius, lobe and offset together.
 */
function crown(
  shell: PlantShell,
  rng: Rng,
  radius: number,
  height: number,
  leaf: Rgb,
  shape: { seat: number; waist: number; tip: number },
): void {
  const base = height * shape.seat;
  shell.canopy(
    rng,
    { base, top: height, radius, sides: 7, rings: 3, lumps: 0.22, waist: shape.waist, tip: shape.tip },
    leaf,
  );
  const lobes = rng.int(1, 2);
  for (let i = 0; i < lobes; i++) {
    const around = rng.range(0, Math.PI * 2);
    const lobe = radius * rng.range(0.3, 0.42);
    const off = (radius - lobe) * rng.range(0.6, 1);
    shell.canopy(
      rng,
      {
        x: Math.cos(around) * off,
        z: Math.sin(around) * off,
        base: base + (height - base) * rng.range(0.15, 0.4),
        top: base + (height - base) * rng.range(0.7, 0.95),
        radius: lobe,
        sides: 5,
        rings: 2,
        lumps: 0.2,
        waist: 0.8,
        tip: 0.22,
      },
      leaf,
    );
  }
}

/** A poplar or a cypress: a bare stem inside one tall narrow mass. */
function column(shell: PlantShell, rng: Rng, radius: number, height: number, bark: Rgb, leaf: Rgb): void {
  shell.tube(0, 0, 0, 0, height * 0.55, 0, radius * 0.16, radius * 0.1, 5, PLANT_BARK, bark);
  shell.canopy(
    rng,
    { base: height * rng.range(0.1, 0.2), top: height, radius, sides: 6, rings: 4, lumps: 0.2, waist: 0.88, tip: 0.1 },
    leaf,
  );
}

/** The crown of a conifer: cones stacked up the trunk, narrowing to the top. */
function spire(shell: PlantShell, rng: Rng, radius: number, height: number, leaf: Rgb): void {
  const tiers = rng.int(4, 5);
  const seat = height * 0.24;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const base = seat + (height - seat) * t;
    const top = base + (height - seat) / tiers + height * 0.14;
    shell.cone(base, Math.min(height, top), radius * (0.98 - 0.26 * t) * rng.range(0.9, 1), 6, leaf);
  }
}

/** A palm: a leaning trunk with a ring of fronds at the top of it (spec section 7.3). */
function palm(shell: PlantShell, rng: Rng, radius: number, height: number, bark: Rgb, leaf: Rgb): void {
  const lean = rng.range(0.05, 0.15) * radius;
  const away = rng.range(0, Math.PI * 2);
  const sections = 4;
  let lastX = 0;
  let lastZ = 0;
  let lastY = 0;
  for (let i = 1; i <= sections; i++) {
    const t = i / sections;
    // The trunk bends away from upright as it climbs, so it curves rather than tilts.
    const drift = lean * t * t;
    const x = Math.cos(away) * drift;
    const z = Math.sin(away) * drift;
    const y = height * 0.86 * t;
    const foot = radius * (0.15 - 0.06 * (t - 1 / sections));
    shell.tube(lastX, lastY, lastZ, x, y, z, foot, radius * (0.15 - 0.06 * t), 5, PLANT_BARK, bark);
    lastX = x;
    lastY = y;
    lastZ = z;
  }
  // A small mass where the fronds meet, so the crown is not bald from above.
  shell.canopy(
    rng,
    { x: lastX, z: lastZ, base: lastY - radius * 0.1, top: lastY + radius * 0.3, radius: radius * 0.24, sides: 5, rings: 2 },
    leaf,
  );
  const fronds = rng.int(8, 11);
  const reach = radius - Math.hypot(lastX, lastZ);
  for (let i = 0; i < fronds; i++) {
    const around = (i / fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
    // The last two hang dead against the trunk, which is what a palm does.
    const dying = i >= fronds - 2;
    shell.frond(
      lastX,
      lastY,
      lastZ,
      around,
      reach * rng.range(dying ? 0.3 : 0.78, dying ? 0.45 : 0.98),
      height * (dying ? -0.06 : 0.2),
      radius * 0.24,
      leaf,
    );
  }
}

/** A shrub: a low stem under a few faceted clumps, with sprigs out of the top. */
function bush(shell: PlantShell, rng: Rng, radius: number, height: number, bark: Rgb, leaf: Rgb): void {
  shell.tube(0, 0, 0, 0, height * 0.35, 0, radius * 0.14, radius * 0.1, 4, PLANT_BARK, bark);
  const clumps = rng.int(3, 4);
  for (let i = 0; i < clumps; i++) {
    const around = (i / clumps) * Math.PI * 2 + rng.range(-0.3, 0.3);
    // The clumps differ in size and in how high they sit, so the shrub reads as
    // a few masses rather than as one green boulder.
    const lobe = radius * rng.range(0.38, 0.56);
    const off = (radius - lobe) * rng.range(0.7, 1);
    const top = height * rng.range(0.6, 1);
    shell.canopy(
      rng,
      {
        x: Math.cos(around) * off,
        z: Math.sin(around) * off,
        // Never under the ground it stands on, however low the clump sits.
        base: Math.max(height * 0.06, top - height * rng.range(0.45, 0.7)),
        top,
        radius: lobe,
        sides: 5,
        rings: 2,
        lumps: 0.34,
        waist: 0.7,
        tip: 0.2,
      },
      leaf,
    );
  }
  // Sprigs standing out of the mass, which is what says foliage rather than stone.
  const sprigs = rng.int(4, 6);
  for (let i = 0; i < sprigs; i++) {
    const around = rng.range(0, Math.PI * 2);
    const reach = radius * rng.range(0, 0.5);
    shell.blade(
      Math.cos(around) * reach,
      Math.sin(around) * reach,
      rng.range(0, Math.PI),
      height * rng.range(0.9, 1.25),
      radius * rng.range(0.08, 0.14),
      leaf,
    );
  }
}

/** An agave: a rosette of stiff leaves leaning out of the ground. */
function rosette(shell: PlantShell, rng: Rng, radius: number, height: number, leaf: Rgb): void {
  const leaves = rng.int(7, 9);
  shell.canopy(rng, { base: 0, top: height * 0.22, radius: radius * 0.3, sides: 5, rings: 2, waist: 0.9 }, leaf);
  for (let i = 0; i < leaves; i++) {
    const around = (i / leaves) * Math.PI * 2 + rng.range(-0.15, 0.15);
    const out = rng.range(0.55, 1);
    shell.spear(around, radius * out, height * rng.range(0.6, 1) * (1.1 - out), radius * 0.12, leaf);
  }
}

/**
 * A tuft of dune grass: a low mass with blades standing out of it. The blades
 * alone were flat triangles standing on edge, which catch the sky rather than
 * the sun and read as scraps of paper.
 */
function tuft(shell: PlantShell, rng: Rng, radius: number, height: number, leaf: Rgb): void {
  shell.canopy(
    rng,
    { base: 0, top: height * rng.range(0.3, 0.42), radius: radius * 0.78, sides: 5, rings: 2, lumps: 0.3, waist: 0.9, tip: 0.3 },
    leaf,
  );
  const blades = rng.int(6, 9);
  for (let i = 0; i < blades; i++) {
    const around = rng.range(0, Math.PI * 2);
    const reach = radius * rng.range(0, 0.62);
    shell.blade(
      Math.cos(around) * reach,
      Math.sin(around) * reach,
      rng.range(0, Math.PI),
      height * rng.range(0.7, 1.5),
      radius * rng.range(0.08, 0.16),
      leaf,
    );
  }
}

/** A colour as the renderer wants it. */
function rgbOf(hex: number): Rgb {
  const colour = new Color(hex);
  return [colour.r, colour.g, colour.b];
}
