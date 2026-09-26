/**
 * The shapes a plant model is built out of (spec section 10.4).
 *
 * `plant-mesh.ts` says what each species is; this says how to draw the pieces.
 * It was cut out of that file when the species outgrew it, and `plant-mesh.ts`
 * re-exports what callers used to import from there.
 *
 * Every piece is flat-shaded and non-indexed, as the buildings and the vehicles
 * are: a face carries one normal, so the light breaks on the edges rather than
 * rolling over them. That is what makes a canopy read as the same object as the
 * city under it.
 *
 * The canopy itself is one closed faceted shell rather than a heap of balls.
 * A heap of balls reads as a bunch of grapes from every angle the game's camera
 * takes, and costs three times the triangles.
 *
 * Nothing here touches the renderer or TSL, so it runs headless and the tests
 * read it directly.
 */
import { BufferAttribute, BufferGeometry, IcosahedronGeometry, Vector3 } from 'three';
import { hashInts } from '../../core/hash.ts';
import { Rng } from '../../core/rng.ts';
import type { Rgb } from '../buildings/building-mesh.ts';

/** What a vertex of a plant belongs to. The material shades the two apart. */
export const PLANT_BARK = 0;
export const PLANT_LEAF = 1;

/** A point in a plant's own frame, which stands at the origin with `y` up. */
export type Local = [number, number, number];

/**
 * One faceted mass of foliage: the shape of a crown, of a clump of a shrub or
 * of a clipped hedge.
 *
 * It is a shell of revolution, eaten into face by face. `waist` bends the
 * profile between a ball and an egg standing on its point, and `lumps` says how
 * deeply each face is pulled in towards the middle. Nothing is ever pushed out,
 * so the widest the shell reaches is `radius` and no more — which is the rule
 * `vegetation.ts` relies on to keep a canopy off the road.
 */
export interface Canopy {
  /** Where the middle of the mass stands, off the plant's own axis. */
  x?: number;
  z?: number;
  /** The height it starts at and the height it reaches, in the plant's frame. */
  base: number;
  top: number;
  /** The widest it gets, measured from `x`, `z`. */
  radius: number;
  /** Faces round it. Six or seven reads as foliage; four reads as a box. */
  sides?: number;
  /** Bands of faces up it. */
  rings?: number;
  /** How deeply a face may be pulled in, as a share of the radius. */
  lumps?: number;
  /** 0 is an egg standing on its point, 1 a ball. */
  waist?: number;
  /**
   * How blunt the two ends are, from 0 for a point to 0.5 for a flat cut. A
   * crown is blunt at both: a canopy that tapers to a point at the top and the
   * bottom reads as a diamond, which is the one shape no tree is.
   */
  tip?: number;
}

/**
 * The triangles of one plant model, with what each of them belongs to and the
 * colour it is dressed in. Non-indexed, as the building shells are, so a batch
 * can hold either.
 */
export class PlantShell {
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

  /**
   * A faceted mass of foliage. The rings are twisted against each other, so the
   * faces do not line up into columns and the silhouette breaks wherever the
   * camera stands.
   */
  canopy(rng: Rng, shape: Canopy, tint: Rgb, part: number = PLANT_LEAF): void {
    const sides = shape.sides ?? 7;
    const rings = shape.rings ?? 3;
    const lumps = shape.lumps ?? 0.2;
    const waist = shape.waist ?? 0.6;
    const tip = shape.tip ?? 0.16;
    const midX = shape.x ?? 0;
    const midZ = shape.z ?? 0;
    // The profile of the shell: a slice of a sine, so both ends are cut off
    // rather than drawn to a point, times a ramp that narrows the foot. It is
    // normalised afterwards, so the widest ring is exactly the radius.
    const wide: number[] = [];
    let widest = 0;
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const span = Math.sin(Math.PI * (tip + (1 - 2 * tip) * t)) * (waist + (1 - waist) * t);
      wide.push(span);
      widest = Math.max(widest, span);
    }
    const scale = widest > 0 ? shape.radius / widest : 0;
    // Each vertex of the shell, ring by ring, with the face under it eaten in.
    const points: Local[][] = [];
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const y = shape.base + (shape.top - shape.base) * t;
      const twist = (r * 0.5 + rng.range(-0.2, 0.2)) * ((Math.PI * 2) / sides);
      const ring: Local[] = [];
      for (let i = 0; i < sides; i++) {
        const angle = (i / sides) * Math.PI * 2 + twist;
        const reach = (wide[r] as number) * scale * (1 - rng.float() * lumps);
        ring.push([midX + Math.cos(angle) * reach, y, midZ + Math.sin(angle) * reach]);
      }
      points.push(ring);
    }
    for (let r = 0; r < rings; r++) {
      const low = points[r] as Local[];
      const high = points[r + 1] as Local[];
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        // Wound the other way round from a tube's ring, because a ring of this
        // shell runs the other way: the faces have to look out of the mass, or
        // the light lands on the inside of it and the crown reads as a shadow.
        this.quad(low[j] as Local, low[i] as Local, high[i] as Local, high[j] as Local, part, tint);
      }
    }
    // The blunt ends are open rings, so each is closed with a fan.
    this.fan(points[0] as Local[], [midX, shape.base, midZ], false, part, tint);
    this.fan(points[rings] as Local[], [midX, shape.top, midZ], true, part, tint);
  }

  /** Close a ring onto one point, wound so the face looks away from it. */
  private fan(ring: readonly Local[], middle: Local, up: boolean, part: number, tint: Rgb): void {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] as Local;
      const b = ring[(i + 1) % ring.length] as Local;
      if (same(a, middle)) continue;
      if (up) this.triangle(b, a, middle, part, tint);
      else this.triangle(a, b, middle, part, tint);
    }
  }

  /** A cone standing on its own base, open underneath: one tier of a conifer. */
  cone(baseY: number, topY: number, radius: number, sides: number, tint: Rgb): void {
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const b = ((i + 1) / sides) * Math.PI * 2;
      this.triangle(
        [Math.cos(b) * radius, baseY, Math.sin(b) * radius],
        [Math.cos(a) * radius, baseY, Math.sin(a) * radius],
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
      this.quad(
        [x0 + ringA.x * r0, y0 + ringA.y * r0, z0 + ringA.z * r0],
        [x0 + ringB.x * r0, y0 + ringB.y * r0, z0 + ringB.z * r0],
        [x1 + ringB.x * r1, y1 + ringB.y * r1, z1 + ringB.z * r1],
        [x1 + ringA.x * r1, y1 + ringA.y * r1, z1 + ringA.z * r1],
        part,
        tint,
      );
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

  /**
   * One leaf of a rosette: a stiff tapered spear leaning out from the middle,
   * drawn from both sides. A ring of them is an agave.
   */
  spear(around: number, reach: number, rise: number, width: number, tint: Rgb): void {
    const dx = Math.cos(around);
    const dz = Math.sin(around);
    const a: Local = [-dz * width, 0, dx * width];
    const b: Local = [dz * width, 0, -dx * width];
    const c: Local = [dx * reach, rise, dz * reach];
    this.triangle(a, b, c, PLANT_LEAF, tint);
    this.triangle(a, c, b, PLANT_LEAF, tint);
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

  /** How far up the foliage each vertex stands, 0 to 1, and 0 on bark. */
  private rises(): Float32Array {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < this.parts.length; i++) {
      if (this.parts[i] !== PLANT_LEAF) continue;
      const y = this.positions[i * 3 + 1] as number;
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    const out = new Float32Array(this.parts.length);
    for (let i = 0; i < this.parts.length; i++) {
      if (this.parts[i] === PLANT_LEAF) out[i] = shareOf(this.positions[i * 3 + 1] as number, low, high);
    }
    return out;
  }

  /**
   * A crown in the form of `ForestGenerator`: an icosphere with lumps, as the
   * trees of a park or the wild are drawn (`docs/art-style.md`). It fills the
   * box from `base` to `top`, `radius` out from the axis. A lump only ever
   * pulls a corner in, so the crown never reaches past the radius. A lump is a
   * function of where the corner stands, so the faces that share a corner
   * still meet there and the shell stays closed.
   */
  blob(seed: number, base: number, top: number, radius: number, lumps: number, tint: Rgb): void {
    const geometry = new IcosahedronGeometry(1, 1);
    const position = geometry.getAttribute('position') as BufferAttribute;
    const half = (top - base) / 2;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      const key = hashInts(seed, Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000));
      const keep = 1 - lumps * ((key >>> 8) / 0x1000000);
      position.setXYZ(i, x * radius * keep, base + half + y * half * keep, z * radius * keep);
    }
    // Non-indexed, so this gives every face its own normal: flat-shaded.
    geometry.computeVertexNormals();
    this.add(geometry, PLANT_LEAF, tint);
  }

  /** Four corners as two triangles. A pair that meets in a point is one triangle. */
  quad(a: Local, b: Local, c: Local, d: Local, part: number, tint: Rgb): void {
    if (!same(a, b)) this.triangle(a, b, c, part, tint);
    if (!same(c, d)) this.triangle(a, c, d, part, tint);
  }

  /**
   * One triangle, with the normal of the face it belongs to. The order of the
   * corners sets the way the face looks, so a caller passes the same three in
   * both orders to draw a leaf from both sides.
   */
  triangle(first: Local, second: Local, third: Local, part: number, tint: Rgb): void {
    const n = normalOf(first, second, third);
    for (const p of [first, second, third]) {
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(n[0], n[1], n[2]);
      this.parts.push(part);
      this.tints.push(tint[0], tint[1], tint[2]);
    }
  }

  /**
   * The triangles as a geometry. Each vertex also carries its `rise`: how far
   * up the foliage of the model it stands, 0 at the lowest leaf and 1 at the
   * highest, and 0 on bark. The material runs the hue of a crown along it
   * (`plant-material.ts`).
   */
  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('rise', new BufferAttribute(this.rises(), 1));
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('part', new BufferAttribute(new Float32Array(this.parts), 1));
    geometry.setAttribute('tint', new BufferAttribute(new Float32Array(this.tints), 3));
    return geometry;
  }
}

/** A share of the way from `low` to `high`, held to 0..1; 0 where the two are one. */
function shareOf(value: number, low: number, high: number): number {
  return high > low ? Math.min(Math.max((value - low) / (high - low), 0), 1) : 0;
}

/** True where two corners stand close enough together to make no triangle. */
function same(a: Local, b: Local): boolean {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5 && Math.abs(a[2] - b[2]) < 1e-5;
}

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
