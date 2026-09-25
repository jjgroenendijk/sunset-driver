/**
 * The bodies of the road vehicles, lofted from a side profile (spec sections
 * 10.1, 11.3).
 *
 * A body is a row of stations from the nose to the tail. Each station is a
 * ring round the body: the floor, a chamfer up to the flank, the shoulder, the
 * glass leaning in above it, the roof rail and the roof. Joining the rings
 * gives a hull with a sloping bonnet, a raked windscreen and a tail, which is
 * what makes a car read as a car rather than a stack of boxes.
 *
 * The hull is then cut into parts along the lines a real car is cut along:
 * the bonnet, the boot, each door and its window, the roof and the glass. Each
 * part is one colour and belongs to one panel, so damage still dents and tears
 * off a panel at a time (`vehicle.ts`). Under every panel that can go there is
 * an inset copy in the shell — the engine bay under the bonnet, the trim inside
 * a door — so a lost panel shows the car's insides and not a hole.
 *
 * Every point is in the vehicle's own frame: `+x` forward, `+y` up, `+z` the
 * side the passenger sits on. The driver sits on `-z`.
 */
import type { Panel } from '../sim/damage.ts';
import type { VehicleClass, VehicleSpec } from '../sim/vehicle.ts';
import { partFrom, type Point } from './loft.ts';
import { BONNET, box, GLASS, LAMP, SEAT, TAIL, TRIM_INSIDE, UNDER, type Hinge, type VehicleBox } from './vehicle-parts.ts';

/** What the span from a station to the next one holds above the shoulder. */
type Flag =
  /** Nothing: paint. */
  | ''
  /** A windscreen or rear glass: glass over the whole top. */
  | 'W'
  /** Side windows under a painted roof. */
  | 'S'
  /** A pillar between two side windows. */
  | 'P';

/**
 * One station: where it stands along the body, as a fraction of the half
 * length from the middle; its floor, shoulder and roof, as fractions of the
 * body's height from the bottom; the half width of the body and of the roof,
 * as fractions of the body's half width; and what the span to the next holds.
 */
type Station = readonly [x: number, floor: number, shoulder: number, roof: number, body: number, cabin: number, flag: Flag];

/** A stretch along the body, from its front end to its rear one, in fractions of the half length. */
type Span = readonly [from: number, to: number];

interface Hull {
  stations: readonly Station[];
  /** The front doors, then the rear doors if there are any. A station stands at each end of each. */
  doors: readonly Span[];
  /** The sliding door of a van, down both flanks behind the cab doors. */
  slide?: Span;
  bonnet?: Span;
  boot?: Span;
}

/** The body's half width, as a share of the row's: the wheels stand a little proud of it. */
export const BODY_WIDTH = 0.92;
/** The chamfer along the sill and along the roof, as a share of the body's height. */
const CHAMFER = 0.07;
/** How far the glass steps in from the flank at the shoulder, as a share of the half width. */
const LEDGE = 0.04;
/** The painted band of roof over the glass, as a share of the body's height. */
const ROOF_BAND = 0.1;
/** How much taller than its shoulder a station must be to have glass: a share of the body's height. */
const GREENHOUSE = 0.06;
/** Metres the shell's copy of a panel stands inside the panel. */
const INSET = 0.06;

const SALOON: Hull = {
  stations: [
    [1, 0.18, 0.5, 0.5, 0.8, 0.74, ''],
    [0.93, 0.05, 0.62, 0.62, 0.95, 0.88, ''],
    [0.45, 0, 0.66, 0.66, 1, 0.92, 'W'],
    [0.12, 0, 0.68, 1, 1, 0.74, 'S'],
    [-0.12, 0, 0.68, 1, 1, 0.74, 'P'],
    [-0.18, 0, 0.68, 0.99, 1, 0.74, 'S'],
    [-0.45, 0, 0.68, 0.97, 1, 0.75, 'W'],
    [-0.72, 0, 0.68, 0.7, 1, 0.9, ''],
    [-0.95, 0.06, 0.66, 0.66, 0.96, 0.9, ''],
    [-1, 0.2, 0.58, 0.58, 0.84, 0.8, ''],
  ],
  doors: [
    [0.45, -0.12],
    [-0.18, -0.45],
  ],
  bonnet: [0.93, 0.45],
  boot: [-0.72, -0.95],
};

/** The bus: one long greenhouse, a pillar every couple of metres. */
function busStations(): Station[] {
  const glazed = (x: number, flag: Flag): Station => [x, 0.03, 0.34, 0.94, 1, 0.93, flag];
  const out: Station[] = [[1, 0.05, 0.3, 0.3, 0.97, 0.95, 'W'], glazed(0.985, 'S')];
  for (let i = 0; i < 7; i++) {
    const x = 0.72 - i * 0.24;
    out.push(glazed(x, 'P'), glazed(x - 0.03, 'S'));
  }
  out.push(glazed(-0.985, ''), [-1, 0.05, 0.34, 0.9, 0.97, 0.93, '']);
  return out;
}

const HULLS: Partial<Record<VehicleClass, Hull>> = {
  // A hatchback: a short bonnet, a tall cabin and a steep hatch.
  compact: {
    stations: [
      [1, 0.2, 0.48, 0.48, 0.82, 0.8, ''],
      [0.9, 0.05, 0.58, 0.58, 0.96, 0.9, ''],
      [0.52, 0, 0.62, 0.62, 1, 0.92, 'W'],
      [0.12, 0, 0.64, 1, 1, 0.78, 'S'],
      [-0.1, 0, 0.64, 1, 1, 0.78, 'P'],
      [-0.17, 0, 0.64, 1, 1, 0.78, 'S'],
      [-0.5, 0, 0.64, 0.99, 1, 0.78, 'S'],
      [-0.8, 0, 0.64, 0.97, 1, 0.78, 'W'],
      [-0.96, 0.04, 0.6, 0.72, 0.96, 0.86, ''],
      [-1, 0.14, 0.56, 0.66, 0.9, 0.84, ''],
    ],
    doors: [
      [0.52, -0.1],
      [-0.17, -0.5],
    ],
    bonnet: [0.9, 0.52],
  },
  saloon: SALOON,
  emergency: SALOON,
  // A long nose, a low wedge and a fastback.
  sports: {
    stations: [
      [1, 0.25, 0.36, 0.36, 0.78, 0.7, ''],
      [0.9, 0.07, 0.5, 0.5, 0.95, 0.88, ''],
      [0.46, 0.01, 0.56, 0.56, 1, 0.9, ''],
      [0.28, 0, 0.58, 0.58, 1, 0.9, 'W'],
      [-0.06, 0, 0.6, 1, 1, 0.7, 'S'],
      [-0.36, 0, 0.62, 0.96, 1, 0.7, 'W'],
      [-0.82, 0, 0.66, 0.72, 1, 0.86, ''],
      [-1, 0.14, 0.66, 0.66, 0.92, 0.86, ''],
    ],
    doors: [[0.46, -0.06]],
    bonnet: [0.9, 0.28],
    boot: [-0.82, -1],
  },
  // Upright and square-shouldered, high off the ground.
  offroad: {
    stations: [
      [1, 0.22, 0.52, 0.52, 0.9, 0.86, ''],
      [0.92, 0.12, 0.56, 0.56, 1, 0.95, ''],
      [0.52, 0.1, 0.58, 0.6, 1, 0.95, 'W'],
      [0.44, 0.1, 0.59, 0.8, 1, 0.9, 'W'],
      [0.36, 0.1, 0.6, 1, 1, 0.86, 'S'],
      [-0.04, 0.1, 0.6, 1, 1, 0.86, 'P'],
      [-0.1, 0.1, 0.6, 1, 1, 0.86, 'S'],
      [-0.5, 0.1, 0.6, 1, 1, 0.86, 'S'],
      [-0.9, 0.1, 0.6, 1, 1, 0.86, ''],
      [-1, 0.14, 0.58, 0.97, 0.98, 0.84, ''],
    ],
    doors: [
      [0.44, -0.04],
      [-0.1, -0.5],
    ],
    bonnet: [0.92, 0.52],
  },
  // A short nose, a raked windscreen and a tall blind box behind the cab.
  van: {
    stations: [
      [1, 0.12, 0.38, 0.38, 0.9, 0.86, ''],
      [0.9, 0.06, 0.45, 0.45, 1, 0.96, ''],
      [0.7, 0.04, 0.5, 0.52, 1, 0.96, 'W'],
      [0.48, 0.04, 0.54, 1, 1, 0.92, 'S'],
      [0.3, 0.04, 0.54, 1, 1, 0.92, ''],
      [-0.3, 0.04, 0.54, 1, 1, 0.92, ''],
      [-1, 0.04, 0.54, 1, 1, 0.92, ''],
    ],
    doors: [[0.7, 0.3]],
    slide: [0.3, -0.3],
    bonnet: [0.9, 0.7],
  },
  // The cab alone: the deck behind it is boxes (`vehicle-mesh.ts`).
  truck: {
    stations: [
      [1, 0.14, 0.42, 0.42, 0.94, 0.9, ''],
      [0.97, 0.1, 0.46, 0.48, 1, 0.95, 'W'],
      [0.9, 0.1, 0.56, 1, 1, 0.9, 'S'],
      [0.72, 0.1, 0.56, 1, 1, 0.9, ''],
      [0.66, 0.1, 0.56, 1, 1, 0.9, ''],
      [0.58, 0.1, 0.56, 1, 1, 0.9, ''],
    ],
    doors: [[0.9, 0.66]],
  },
  bus: { stations: busStations(), doors: [] },
};


/** A station in metres. */
interface Ring {
  x: number;
  floor: number;
  shoulder: number;
  roof: number;
  body: number;
  cabin: number;
  flag: Flag;
  glazed: boolean;
}

/**
 * The fourteen points round one station: up the right flank from the middle of
 * the floor to the middle of the roof, then down the left. A station with no
 * glass folds the glass and the rail into its roof edge, so every ring has the
 * same count and the loft joins them point for point.
 */
function pointsOf(r: Ring, height: number, width: number): Point[] {
  const low = Math.min(CHAMFER * height, (r.shoulder - r.floor) * 0.45, r.body * 0.35);
  const half: [number, number][] = [
    [0, r.floor],
    [r.body - low, r.floor],
    [r.body, r.floor + low],
  ];
  if (r.glazed) {
    const glassTop = Math.max(r.shoulder, r.roof - ROOF_BAND * height);
    const rail = Math.min(CHAMFER * height, r.cabin * 0.45, (r.roof - r.shoulder) * 0.6);
    const ledge = Math.max(r.cabin, r.body - LEDGE * width);
    half.push([r.body, r.shoulder], [ledge, r.shoulder], [r.cabin, glassTop], [r.cabin - rail, r.roof]);
  } else {
    const edge = Math.min(CHAMFER * height * 0.7, (r.roof - r.floor) * 0.4, r.body * 0.3);
    const top: [number, number] = [r.body - edge, r.roof];
    half.push([r.body, r.roof - edge], top, top, top);
  }
  half.push([0, r.roof]);
  const ring: Point[] = half.map(([z, y]) => [r.x, y, z]);
  for (let i = 6; i >= 1; i--) {
    const [z, y] = half[i] as [number, number];
    ring.push([r.x, y, -z]);
  }
  return ring;
}

/** What the k-th side of a ring is: 0 floor, 1 sill, 2 flank, 3 shoulder, 4 glass, 5 rail, 6 roof. */
const sideOf = (k: number): number => (k <= 6 ? k : 13 - k);

/** One colour on one panel, and the polygons it is drawn with. */
interface Bucket {
  key: string;
  colour: number;
  on: Panel | 'shell';
  hinge?: Hinge;
  glass?: boolean;
  faces: Point[][];
}

/**
 * The body of a road class as parts, or undefined for a class that is not
 * lofted. `paint` and `trim` are the row's two colours; a patrol car wears
 * its trim at both ends and its paint in the middle.
 */
export function hullOf(spec: VehicleSpec, patrol = false): VehicleBox[] | undefined {
  const hull = HULLS[spec.cls];
  if (hull === undefined) return undefined;
  const height = spec.halfHeight * 2;
  const width = spec.halfWidth * BODY_WIDTH;
  const hl = spec.halfLength;
  const up = (f: number): number => -spec.halfHeight + f * height;
  const rings: Ring[] = hull.stations.map(([x, floor, shoulder, roof, body, cabin, flag]) => ({
    x: x * hl,
    floor: up(floor),
    shoulder: up(shoulder),
    roof: up(roof),
    body: body * width,
    cabin: cabin * width,
    flag,
    glazed: roof - shoulder > GREENHOUSE,
  }));
  const points = rings.map((r) => pointsOf(r, height, width));
  const first = rings.findIndex((r) => r.glazed);
  const last = rings.length - 1 - [...rings].reverse().findIndex((r) => r.glazed);

  const buckets: Bucket[] = [];
  const add = (face: Point[], colour: number, on: Panel | 'shell', extra: Partial<Bucket> = {}): void => {
    const key = `${colour}|${on}|${extra.hinge?.leaf ?? ''}|${extra.glass === true}`;
    let bucket = buckets.find((b) => b.key === key);
    if (bucket === undefined) {
      bucket = { key, colour, on, faces: [], ...extra };
      buckets.push(bucket);
    }
    bucket.faces.push(face);
  };
  const within = (span: Span | undefined, x: number): boolean => span !== undefined && x < span[0] * hl && x > span[1] * hl;
  const paintAt = (x: number): number => (patrol && (x > hl * 0.5 || x < -hl * 0.45) ? spec.trim : spec.paint);
  const hingeOf = (leaf: number, axis: Hinge['axis'], x: number, y: number, z: number): Hinge => ({ leaf, axis, x, y, z });

  for (let i = 0; i < rings.length - 1; i++) {
    const ring = rings[i] as Ring;
    const mid = (ring.x + (rings[i + 1] as Ring).x) / 2;
    const a = points[i] as Point[];
    const b = points[i + 1] as Point[];
    const door = hull.doors.findIndex((span) => within(span, mid));
    const sliding = within(hull.slide, mid);
    if (i >= first - 1 && i < last) tub(a, b, add);
    for (let k = 0; k < 14; k++) {
      const face: Point[] = [a[k] as Point, a[(k + 1) % 14] as Point, b[(k + 1) % 14] as Point, b[k] as Point];
      const side = sideOf(k);
      const z = k <= 6 ? 1 : -1;
      // The driver's door is leaf 0 and stands on -z; the one across is 1.
      const leaf = (d: number): number => d * 2 + (z < 0 ? 0 : 1);
      if (side === 0) {
        add(face, UNDER, 'shell');
        continue;
      }
      const glass = (ring.flag === 'W' && side >= 4) || (ring.flag === 'S' && side === 4);
      if (glass) {
        const hinged = door >= 0 && ring.flag === 'S';
        const hinge = hinged ? hingeOf(leaf(door), 'y', (hull.doors[door] as Span)[0] * hl, 0, z * width) : undefined;
        add(face, GLASS, hinged ? (z > 0 ? 'left' : 'right') : 'roof', { glass: true, ...(hinge && { hinge }) });
        continue;
      }
      const colour = paintAt(mid);
      if ((door >= 0 || sliding) && (side === 2 || side === 3)) {
        const hinge =
          door >= 0
            ? hingeOf(leaf(door), 'y', (hull.doors[door] as Span)[0] * hl, 0, z * width)
            : hingeOf(leaf(1), 'slide', (hull.slide as Span)[0] * hl, 0, z * width);
        add(face, colour, z > 0 ? 'left' : 'right', { hinge });
        add(inset(face, 0, -z), TRIM_INSIDE, 'shell');
        continue;
      }
      if (side >= 3 && within(hull.bonnet, mid)) {
        const back = (hull.bonnet as Span)[1] * hl;
        const top = (rings.find((r) => Math.abs(r.x - back) < 1e-9) as Ring).roof;
        add(face, colour, 'front', { hinge: hingeOf(BONNET, 'z', back, top, 0) });
        add(inset(face, -1.5, 0), UNDER, 'shell');
        continue;
      }
      if (side >= 3 && within(hull.boot, mid)) {
        add(face, colour, 'rear');
        add(inset(face, -1.5, 0), UNDER, 'shell');
        continue;
      }
      add(face, colour, side >= 4 && i >= first - 1 && i < last ? 'roof' : 'shell');
    }
  }
  // The nose and the tail close the ends; each ring winds the same way, so the
  // nose is read backwards to face forwards.
  const nose = points[0] as Point[];
  const tail = points[points.length - 1] as Point[];
  add([...nose].reverse(), paintAt(hl), 'shell');
  add(tail, paintAt(-hl), 'shell');

  return [...buckets.map(partOf), ...cabinOf(hull, rings, spec, width), ...lampsOf(rings)];
}

/** A lamp at each front corner of the nose and a tail light at each rear one. */
function lampsOf(rings: Ring[]): VehicleBox[] {
  const out: VehicleBox[] = [];
  for (const [ring, colour, x] of [
    [rings[0] as Ring, LAMP, -0.04],
    [rings[rings.length - 1] as Ring, TAIL, 0.04],
  ] as const) {
    const y = (ring.floor + (ring.glazed ? ring.shoulder : ring.roof)) / 2;
    const across = Math.min(0.4, ring.body * 0.44);
    for (const side of [1, -1]) out.push(box(0.1, 0.12, across, colour, ring.x + x, y, side * ring.body * 0.6));
  }
  return out;
}

/**
 * The inside of the cabin between two stations: a floor facing up and a wall
 * up to the shoulder facing in, each just inside the hull. The hull's own
 * faces face out, so without these a body seen through its glass has no floor
 * and no far side, and shows the road through it.
 */
function tub(a: Point[], b: Point[], add: (face: Point[], colour: number, on: Panel | 'shell') => void): void {
  const lift = (p: Point): Point => [p[0], p[1] + INSET * 0.5, p[2]];
  add([lift(a[1] as Point), lift(a[13] as Point), lift(b[13] as Point), lift(b[1] as Point)], TRIM_INSIDE, 'shell');
  for (const k of [1, 2, 11, 12]) {
    const wall = [b[k], b[k + 1], a[k + 1], a[k]] as Point[];
    add(inset(wall, 0, k < 7 ? -0.5 : 0.5), TRIM_INSIDE, 'shell');
  }
}

/** A face moved `dy` insets down and `dz` insets across, which is how a panel's copy in the shell sits inside it. */
function inset(face: Point[], dy: number, dz: number): Point[] {
  return face.map(([x, y, z]) => [x, y + dy * INSET, z + dz * INSET]);
}

/** The polygons of a bucket as one part, about its own middle. */
function partOf(bucket: Bucket): VehicleBox {
  const part = partFrom(bucket.faces, bucket.colour);
  part.on = bucket.on;
  if (bucket.hinge !== undefined) part.hinge = bucket.hinge;
  if (bucket.glass === true) part.glass = true;
  return part;
}

/** The bus's seats: a pair each side of the aisle, a row every metre and a bit, behind the driver. */
function benches(spec: VehicleSpec, width: number, floor: number, cushion: number): VehicleBox[] {
  const out: VehicleBox[] = [];
  const top = floor + 1.05;
  for (let x = spec.halfLength - 2.2; x > -spec.halfLength + 0.8; x -= 1.25) {
    for (const z of [-1, 1]) {
      out.push({ ...box(0.45, 0.12, width * 0.62, SEAT, x, cushion, z * width * 0.6), on: 'shell' });
      out.push({ ...box(0.1, top - cushion, width * 0.62, SEAT, x - 0.25, (top + cushion) / 2, z * width * 0.6), on: 'shell' });
    }
  }
  return out;
}

/**
 * What is seen through the glass: a dashboard under the windscreen, a seat
 * each side in front, and a bench behind them on a car with rear doors. They
 * belong to the shell, so they stay when the roof goes.
 */
function cabinOf(hull: Hull, rings: Ring[], spec: VehicleSpec, width: number): VehicleBox[] {
  const front = hull.doors[0];
  const screen = rings.find((r) => r.flag === 'W');
  const hl = spec.halfLength;
  const floor = Math.min(...rings.map((r) => r.floor));
  const shoulder = screen?.shoulder ?? floor + spec.halfHeight;
  const cushion = floor + Math.min(0.32, (shoulder - floor) * 0.45);
  if (front === undefined || screen === undefined) return spec.cls === 'bus' ? benches(spec, width, floor, cushion) : [];
  const inside = (length: number, height: number, across: number, colour: number, x: number, y: number, z: number): VehicleBox => ({
    length,
    height,
    width: across,
    x,
    y,
    z,
    colour,
    panel: undefined,
    on: 'shell',
  });
  const seatX = hl * (front[1] + (front[0] - front[1]) * 0.3);
  const back = Math.min(0.55, spec.halfHeight * 2 * 0.45);
  const out: VehicleBox[] = [inside(0.3, 0.16, width * 1.7, TRIM_INSIDE, screen.x - 0.2, shoulder - 0.08, 0)];
  for (const z of [-1, 1]) {
    out.push(inside(0.46, 0.12, width * 0.7, SEAT, seatX, cushion, z * width * 0.45));
    out.push(inside(0.12, back, width * 0.7, SEAT, seatX - 0.26, cushion + back / 2, z * width * 0.45));
  }
  const rear = hull.doors[1];
  if (rear !== undefined) {
    const benchX = hl * (rear[1] + (rear[0] - rear[1]) * 0.35);
    out.push(inside(0.44, 0.12, width * 1.6, SEAT, benchX, cushion, 0));
    out.push(inside(0.12, back, width * 1.6, SEAT, benchX - 0.25, cushion + back / 2, 0));
  }
  return out;
}
