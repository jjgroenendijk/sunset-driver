/**
 * The plants of one chunk, as geometry (spec sections 9.2, 10.4).
 *
 * `vegetation.ts` says where a plant stands and what species it is. This says
 * what it looks like: a handful of models per species, built once for a world,
 * and one placement per plant.
 *
 * A species has {@link SPECIES_MODELS} models and no more. Every plant of a
 * chunk is drawn from them, so a forest costs the geometry of a few trees
 * however many stand in it; the variety comes from the model each plant takes,
 * the way it is turned and how big it grew. That is what keeps a chunk of
 * wilderness inside the draw calls of spec section 9.2.
 *
 * The trunk and branches of a tree are `TreeGenerator` (spec section 10.4),
 * which grows a seeded skeleton and bakes it into one geometry. It produces no
 * foliage, so the crown is clumps laid over it here; a palm, a shrub and a tuft
 * of dune grass are built here from end to end, because a generated skeleton is
 * not what any of them is.
 *
 * A plant never stands on a road or on a building, by construction (spec
 * section 1.1): `vegetation.ts` keeps the whole of its canopy inside one parcel
 * and off the lots on it, and a model is built inside that canopy. Nothing here
 * moves a plant, so nothing here can put one where it may not stand.
 *
 * A plant's own frame has it standing at the origin, `y` up. The matrix of a
 * placement is what puts that frame in the world.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  IcosahedronGeometry,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { TreeGenerator } from 'three/examples/jsm/generators/TreeGenerator.js';
import { hashInts } from '../core/hash.ts';
import { Rng } from '../core/rng.ts';
import type { WorldChunk, WorldLayers } from '../world/chunks.ts';
import { PLANT_RADIUS, type Plant, type PlantSpecies } from '../world/vegetation.ts';
import type { Rgb } from './building-mesh.ts';

/** What a vertex of a plant belongs to. The material shades the two apart. */
export const PLANT_BARK = 0;
export const PLANT_LEAF = 1;

/** The species, in the order their models are built and indexed. */
export const PLANT_SPECIES: readonly PlantSpecies[] = ['broadleaf', 'conifer', 'palm', 'shrub', 'grass'];

/**
 * Models one species is built in. A chunk draws every plant of a species from
 * these, so this is the geometry a species costs however many of it stand
 * there.
 */
export const SPECIES_MODELS = 3;

/** Metres a plant is sunk, so no daylight shows under it on a slope. */
const ROOTING = 0.15;

/** How tall each species stands, as a share of its own canopy radius. */
const SPECIES_RISE: Record<PlantSpecies, number> = {
  broadleaf: 3.1,
  conifer: 4.4,
  palm: 3.8,
  shrub: 1.1,
  grass: 0.5,
};

/** How much bigger or smaller than its model a plant grows, and how much taller. */
const MIN_SPREAD = 0.78;
const MIN_RISE = 0.85;
const MAX_RISE = 1.25;

/** The bark of a trunk, and of the stem of a shrub. */
const BARK: readonly number[] = [0x6b5844, 0x5d4c3b, 0x776450];

/** The leaf colours of each species, one per model. */
const LEAF: Record<PlantSpecies, readonly number[]> = {
  broadleaf: [0x4f7a34, 0x628a3c, 0x43682c],
  conifer: [0x35573a, 0x2c4a32, 0x3d6140],
  palm: [0x5c8a42, 0x6d9a4a, 0x4f7a3a],
  shrub: [0x54702f, 0x63803a, 0x475f2a],
  grass: [0x8d9a52, 0x9aa65e, 0x7d8a48],
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
 * a model rather than carrying geometry, so the batch holds one copy of each
 * model however many plants stand on it.
 */
export function buildChunkVegetation(chunk: WorldChunk, lookup: PlantLookup): PlantPlacement[] {
  const out: PlantPlacement[] = [];
  for (const plant of chunk.plants) {
    const rng = new Rng(plant.seed);
    const variant = rng.int(0, SPECIES_MODELS - 1);
    const turn = rng.range(0, Math.PI * 2);
    const spread = rng.range(MIN_SPREAD, 1);
    const rise = spread * rng.range(MIN_RISE, MAX_RISE);
    const ground = lookup.heightAt(plant.at.x, plant.at.y) - ROOTING;
    const matrix = new Matrix4().compose(
      new Vector3(plant.at.x, ground, plant.at.y),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), turn),
      // The spread is never over 1, so a canopy stays inside the ground the
      // plant claims and cannot reach over the road beside it.
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
  const bark = rgbOf(BARK[variant % BARK.length] as number);
  const leaf = rgbOf(LEAF[species][variant % LEAF[species].length] as number);
  switch (species) {
    case 'broadleaf':
      shell.add(branches(rng, radius, height, 0.13, 34), PLANT_BARK, bark);
      crown(shell, rng, radius, height, leaf);
      break;
    case 'conifer':
      shell.add(branches(rng, radius, height, 0.1, 34), PLANT_BARK, bark);
      spire(shell, rng, radius, height, leaf);
      break;
    case 'palm':
      palm(shell, rng, radius, height, bark, leaf);
      break;
    case 'shrub':
      bush(shell, rng, radius, height, bark, leaf);
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
function branches(rng: Rng, radius: number, height: number, thickness: number, angle: number): BufferGeometry {
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
    .setTrunkLength(height * 0.62)
    .setTrunkRadius(radius * thickness)
    .setRadialSegments(4)
    .setSectionLength(height / 4)
    .setTrunkClear(0.4)
    .build();
  spare.dispose();
  const geometry = mesh.geometry.index === null ? mesh.geometry : mesh.geometry.toNonIndexed();
  if (geometry !== mesh.geometry) mesh.geometry.dispose();
  return geometry;
}

/** The crown of a broadleaf: clumps of leaf laid over the top of the skeleton. */
function crown(shell: PlantShell, rng: Rng, radius: number, height: number, leaf: Rgb): void {
  const count = rng.int(6, 8);
  // The crown seats low on the trunk: a tall bare bole under a small crown
  // reads as a stick from a camera that looks down on it.
  const seat = height * 0.36;
  for (let i = 0; i < count; i++) {
    // The clumps ride an ellipsoid around the crown, spread by the golden angle
    // so no two of them sit on top of each other.
    const around = i * 2.399963 + rng.range(-0.4, 0.4);
    const up = i / Math.max(1, count - 1);
    const reach = radius * (0.26 + 0.16 * Math.sin(Math.PI * up));
    const size = radius * rng.range(0.44, 0.56);
    shell.blob(
      Math.cos(around) * reach,
      seat + (height - seat - size) * up + rng.range(-0.08, 0.08) * radius,
      Math.sin(around) * reach,
      size,
      0.78,
      leaf,
    );
  }
}

/** The crown of a conifer: cones stacked up the trunk, narrowing to the top. */
function spire(shell: PlantShell, rng: Rng, radius: number, height: number, leaf: Rgb): void {
  const tiers = rng.int(3, 4);
  const seat = height * 0.28;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const base = seat + (height - seat) * t;
    const top = base + (height - seat) / tiers + height * 0.12;
    shell.cone(base, Math.min(height, top), radius * (0.95 - 0.22 * t), 6, leaf);
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
  const fronds = rng.int(6, 8);
  for (let i = 0; i < fronds; i++) {
    const around = (i / fronds) * Math.PI * 2 + rng.range(-0.2, 0.2);
    shell.frond(lastX, lastY, lastZ, around, radius * rng.range(0.68, 0.8), height * 0.2, radius * 0.26, leaf);
  }
}

/** A shrub: a low stem under two or three clumps of leaf. */
function bush(shell: PlantShell, rng: Rng, radius: number, height: number, bark: Rgb, leaf: Rgb): void {
  shell.tube(0, 0, 0, 0, height * 0.4, 0, radius * 0.14, radius * 0.1, 4, PLANT_BARK, bark);
  const count = rng.int(2, 3);
  for (let i = 0; i < count; i++) {
    const around = (i / count) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const reach = radius * rng.range(0.1, 0.3);
    shell.blob(
      Math.cos(around) * reach,
      height * rng.range(0.5, 0.8),
      Math.sin(around) * reach,
      radius * rng.range(0.5, 0.68),
      0.72,
      leaf,
    );
  }
}

/** A tuft of dune grass: crossed blades, which is what a patch of it reads as. */
function tuft(shell: PlantShell, rng: Rng, radius: number, height: number, leaf: Rgb): void {
  const blades = rng.int(5, 7);
  for (let i = 0; i < blades; i++) {
    const around = rng.range(0, Math.PI * 2);
    const reach = radius * rng.range(0, 0.7);
    shell.blade(
      Math.cos(around) * reach,
      Math.sin(around) * reach,
      rng.range(0, Math.PI),
      height * rng.range(0.7, 1.3),
      radius * rng.range(0.16, 0.26),
      leaf,
    );
  }
}

/** A colour as the renderer wants it. */
function rgbOf(hex: number): Rgb {
  const colour = new Color(hex);
  return [colour.r, colour.g, colour.b];
}

/**
 * The triangles of one plant model, with what each of them belongs to and the
 * colour it is dressed in. Non-indexed, as the building shells are, so a batch
 * can hold either.
 */
class PlantShell {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly parts: number[] = [];
  private readonly tints: number[] = [];

  /** Take in the triangles of a geometry built elsewhere, and release it. */
  add(geometry: BufferGeometry, part: number, tint: Rgb): void {
    const position = geometry.getAttribute('position').array as ArrayLike<number>;
    const normal = geometry.getAttribute('normal').array as ArrayLike<number>;
    for (let i = 0; i + 2 < position.length; i += 3) {
      this.positions.push(position[i] as number, position[i + 1] as number, position[i + 2] as number);
      this.normals.push(normal[i] as number, normal[i + 1] as number, normal[i + 2] as number);
      this.parts.push(part);
      this.tints.push(tint[0], tint[1], tint[2]);
    }
    geometry.dispose();
  }

  /** A clump of leaf: a squashed icosahedron, which reads as a mass from above. */
  blob(x: number, y: number, z: number, radius: number, squash: number, tint: Rgb): void {
    const ball = new IcosahedronGeometry(radius, 0);
    const position = ball.getAttribute('position').array as ArrayLike<number>;
    const normal = ball.getAttribute('normal').array as ArrayLike<number>;
    for (let i = 0; i + 2 < position.length; i += 3) {
      const up = (position[i + 1] as number) * squash + y;
      this.positions.push((position[i] as number) + x, up, (position[i + 2] as number) + z);
      this.normals.push(normal[i] as number, normal[i + 1] as number, normal[i + 2] as number);
      this.parts.push(PLANT_LEAF);
      this.tints.push(tint[0], tint[1], tint[2]);
    }
    ball.dispose();
  }

  /** A cone standing on its own base, open underneath: one tier of a conifer. */
  cone(baseY: number, topY: number, radius: number, sides: number, tint: Rgb): void {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const b = ((i + 1) / sides) * Math.PI * 2;
      this.triangle(
        [Math.cos(a) * radius, baseY, Math.sin(a) * radius],
        [Math.cos(b) * radius, baseY, Math.sin(b) * radius],
        [0, topY, 0],
        PLANT_LEAF,
        tint,
      );
    }
  }

  /** A tapered tube between two points, open at both ends: a trunk or a stem. */
  tube(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    r0: number,
    r1: number,
    sides: number,
    part: number,
    tint: Rgb,
  ): void {
    const axis = new Vector3(x1 - x0, y1 - y0, z1 - z0);
    const across = perpendicular(axis);
    const along = new Vector3().crossVectors(axis.clone().normalize(), across);
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const b = ((i + 1) / sides) * Math.PI * 2;
      const ringA = ringPoint(across, along, a);
      const ringB = ringPoint(across, along, b);
      const p0: Local = [x0 + ringA.x * r0, y0 + ringA.y * r0, z0 + ringA.z * r0];
      const p1: Local = [x0 + ringB.x * r0, y0 + ringB.y * r0, z0 + ringB.z * r0];
      const p2: Local = [x1 + ringB.x * r1, y1 + ringB.y * r1, z1 + ringB.z * r1];
      const p3: Local = [x1 + ringA.x * r1, y1 + ringA.y * r1, z1 + ringA.z * r1];
      this.triangle(p0, p1, p2, part, tint);
      this.triangle(p0, p2, p3, part, tint);
    }
  }

  /**
   * One frond of a palm: a tapered strip drooping away from the crown, drawn
   * from both sides so it reads from under the tree as well as from over it.
   */
  frond(x: number, y: number, z: number, around: number, reach: number, rise: number, width: number, tint: Rgb): void {
    const dx = Math.cos(around);
    const dz = Math.sin(around);
    const steps = 3;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const w0 = width * (1 - t0) * (t0 < 0.2 ? t0 / 0.2 : 1);
      const w1 = width * (1 - t1) * (t1 < 0.2 ? t1 / 0.2 : 1);
      // The frond rises out of the crown and then falls away under its own weight.
      const y0 = y + rise * (t0 - t0 * t0 * 2.2);
      const y1 = y + rise * (t1 - t1 * t1 * 2.2);
      const a: Local = [x + dx * reach * t0 - dz * w0, y0, z + dz * reach * t0 + dx * w0];
      const b: Local = [x + dx * reach * t0 + dz * w0, y0, z + dz * reach * t0 - dx * w0];
      const c: Local = [x + dx * reach * t1 + dz * w1, y1, z + dz * reach * t1 - dx * w1];
      const d: Local = [x + dx * reach * t1 - dz * w1, y1, z + dz * reach * t1 + dx * w1];
      this.triangle(a, b, c, PLANT_LEAF, tint);
      this.triangle(a, c, d, PLANT_LEAF, tint);
      this.triangle(a, c, b, PLANT_LEAF, tint);
      this.triangle(a, d, c, PLANT_LEAF, tint);
    }
  }

  /** One blade of grass: an upright fan, drawn from both sides. */
  blade(x: number, z: number, around: number, rise: number, width: number, tint: Rgb): void {
    const dx = Math.cos(around) * width;
    const dz = Math.sin(around) * width;
    const tipX = x + dx * 0.6;
    const tipZ = z + dz * 0.6;
    const a: Local = [x - dx, 0, z - dz];
    const b: Local = [x + dx, 0, z + dz];
    const c: Local = [tipX, rise, tipZ];
    this.triangle(a, b, c, PLANT_LEAF, tint);
    this.triangle(a, c, b, PLANT_LEAF, tint);
  }

  /** One triangle, with the normal of the face it belongs to. */
  triangle(a: Local, b: Local, c: Local, part: number, tint: Rgb): void {
    const n = normalOf(a, b, c);
    for (const p of [a, b, c]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.parts.push(part);
      this.tints.push(tint[0], tint[1], tint[2]);
    }
  }

  /** The triangles as a geometry. */
  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('part', new BufferAttribute(new Float32Array(this.parts), 1));
    geometry.setAttribute('tint', new BufferAttribute(new Float32Array(this.tints), 3));
    return geometry;
  }
}

/** A point in a plant's own frame. */
type Local = [number, number, number];

/** The unit normal of a triangle, which is the way the face it belongs to looks. */
function normalOf(a: Local, b: Local, c: Local): Local {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const span = Math.hypot(nx, ny, nz) || 1;
  return [nx / span, ny / span, nz / span];
}

/** A unit vector across an axis, whichever way the axis points. */
function perpendicular(axis: Vector3): Vector3 {
  const up = Math.abs(axis.y) > Math.abs(axis.x) ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  return new Vector3().crossVectors(axis, up).normalize();
}

/** A point on the unit ring of a tube, in the plane the two vectors span. */
function ringPoint(across: Vector3, along: Vector3, angle: number): Vector3 {
  return new Vector3(
    across.x * Math.cos(angle) + along.x * Math.sin(angle),
    across.y * Math.cos(angle) + along.y * Math.sin(angle),
    across.z * Math.cos(angle) + along.z * Math.sin(angle),
  );
}
