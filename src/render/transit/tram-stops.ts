/**
 * The tram stops, drawn (spec sections 9.2, 13.2).
 *
 * A stop is an island platform beside the track, as long as a tram: a kerbed
 * slab with a tactile strip down its edge and a ramp at each end, a shelter in
 * the middle of it with a bench and a lit timetable panel, and a flag on a mast
 * at the end the tram arrives from. Bollards and a keep-left sign stand at each
 * nose, and white hatching on the road ahead of it keeps the traffic off. The traffic gives up the ground the platform stands on
 * (`laneOffset` in `sim/traffic/traffic.ts`), so nobody waits across a live lane.
 *
 * The places are a function of the line and never move, so the view writes them
 * every frame off {@link TramLine.stopPlaces} and takes no moment. Each part is
 * one instanced mesh, so a frame costs three draws however many stops are in
 * view. The people waiting are drawn with the crowd (`pedestrians.ts`).
 *
 * The stop's own frame is the tram's: `+x` along the direction of travel, `+y`
 * up from the road, and `+z` to the left of travel — so the platform, which is
 * to the right of the track, stands at negative `z`.
 */
import { Group, Matrix4, Quaternion, Vector3, type BufferGeometry, type InstancedMesh } from 'three';
import { CAR_HALF_WIDTH, TRAM_LENGTH, type TramLine } from '../../sim/transit/tram.ts';
import { PLATFORM_RAMP, PLATFORM_RISE, SHELTER_LONG, SHELTER_TALL } from '../../sim/transit/tram-stop-place.ts';
import { TRAM_LANE } from '../../world/roads/tiers.ts';
import { boxOf, coloured, instanced, merged, TRAFFIC_VIEW } from '../vehicles/traffic.ts';
import { GLASS, METAL } from '../vehicles/vehicle-mesh.ts';
import { createVehicleTrim, type VehicleTrim } from '../vehicles/vehicle-glow.ts';

/** Metres each way of the point the frame is drawn round that stops are drawn in. */
export const TRAM_STOP_VIEW = TRAFFIC_VIEW;

/** The concrete of the platform, its kerb, and the tactile strip along the edge. */
const PLATFORM = 0xe0d6bb;
const KERB = 0xa1979f;
const TACTILE = 0xf2c81e;
/** The paint of the mast and the flag it carries. */
const POST_PAINT = 0x2f5fc4;
/** The case the timetable panel is set in, behind its lettering. */
const PANEL_CASE = 0x3a3148;
const SIGN_FACE = 0xf2efe6;

/**
 * Metres from the track's centre to the near edge of the platform, and how wide
 * it is. A tram is {@link CAR_HALF_WIDTH} across, so the gap a passenger steps
 * over is 10 cm. The places come off the track (`TramLine.stopPlaces`), so this
 * is measured from there and not from the road's centreline.
 */
const INNER = TRAM_LANE.platformInner;
const WIDTH = TRAM_LANE.platform;
/** Metres the platform stands above the road, and how deep its kerb is. */
const RISE = PLATFORM_RISE;
/** Metres of the painted hatching on the road ahead of each nose, which says the ground is not a lane. */
const HATCH_LONG = 7;
const HATCH = 0xf2efe6;
/** The bollards at each nose, and the keep-left sign between them. */
const BOLLARD = 0xf2efe6;
const REFLECTOR = 0xf2c81e;


/** One box of a stop, in the stop's own frame. */
interface StopBox {
  length: number;
  height: number;
  width: number;
  x: number;
  y: number;
  z: number;
  colour: number;
  /** The faces of a part that is not a box, as `VehicleBox.faces` has them. */
  faces?: readonly (readonly number[])[];
}

function box(length: number, height: number, width: number, x: number, y: number, z: number, colour: number): StopBox {
  return { length, height, width, x, y, z, colour };
}

/** The middle of the platform, across from the track. */
const MIDDLE = -(INNER + WIDTH / 2);

/**
 * The slab itself: the platform, the kerb on the tram's side, the tactile
 * strip on it, a ramp down to the road at each end, and a kerb along the
 * traffic's side so the island reads as one from a car.
 */
function platformBoxes(): StopBox[] {
  const end = TRAM_LENGTH / 2 + PLATFORM_RAMP / 2;
  return [
    box(TRAM_LENGTH, RISE, WIDTH, 0, RISE / 2, MIDDLE, PLATFORM),
    box(TRAM_LENGTH, RISE + 0.06, 0.16, 0, (RISE + 0.06) / 2, -(INNER + 0.08), KERB),
    box(TRAM_LENGTH, RISE + 0.04, 0.14, 0, (RISE + 0.04) / 2, -(INNER + WIDTH - 0.07), KERB),
    box(TRAM_LENGTH - 0.6, 0.03, 0.4, 0, RISE + 0.015, -(INNER + 0.42), TACTILE),
    { ...wedge(PLATFORM_RAMP, RISE, WIDTH, 1), x: end, y: RISE / 2, z: MIDDLE, colour: PLATFORM },
    { ...wedge(PLATFORM_RAMP, RISE, WIDTH, -1), x: -end, y: RISE / 2, z: MIDDLE, colour: PLATFORM },
    ...hatching(1),
    ...hatching(-1),
  ];
}

/**
 * A ramp `long` metres by `wide`, `tall` at the platform's end and nothing at
 * the road's. `side` is the end it stands at: 1 ahead of the platform, -1
 * behind it. Its faces are wound to face outwards.
 */
function wedge(long: number, tall: number, wide: number, side: 1 | -1): Omit<StopBox, 'x' | 'y' | 'z' | 'colour'> {
  const a = long / 2;
  const h = tall / 2;
  const w = wide / 2;
  const faces = [
    [-a, -h, -w, a, -h, -w, a, -h, w, -a, -h, w],
    [-a, -h, -w, -a, -h, w, -a, h, w, -a, h, -w],
    [-a, h, -w, -a, h, w, a, -h, w, a, -h, -w],
    [-a, -h, w, a, -h, w, -a, h, w],
    [-a, -h, -w, -a, h, -w, a, -h, -w],
  ];
  // The end behind the platform is the same ramp turned about: mirrored, with each face wound back.
  const turned = side === 1 ? faces : faces.map((face) => mirrored(face));
  return { length: long, height: tall, width: wide, faces: turned };
}

/** A face mirrored along `x`, with its corners taken in the other order so it still faces outwards. */
function mirrored(face: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = face.length - 3; i >= 0; i -= 3) out.push(-(face[i] as number), face[i + 1] as number, face[i + 2] as number);
  return out;
}

/**
 * The white bars painted on the road ahead of one nose, slanting across the
 * width of the platform: the ground a car keeps off. Each bar is a flat face
 * facing up, just proud of the road.
 */
function hatching(side: 1 | -1): StopBox[] {
  const bars: StopBox[] = [];
  const start = TRAM_LENGTH / 2 + PLATFORM_RAMP;
  const w = WIDTH / 2;
  for (let along = 0.6; along < HATCH_LONG; along += 1.4) {
    // Each bar narrows with the island it stands for, which tapers to a point.
    const reach = w * (1 - along / HATCH_LONG);
    const a = 0.22;
    const top = [-a + reach * 0.6, 0, reach, a + reach * 0.6, 0, reach, a - reach * 0.6, 0, -reach, -a - reach * 0.6, 0, -reach];
    const face = side === 1 ? top : mirrored(top);
    bars.push({ length: 2 * a + reach * 1.2, height: 0.01, width: 2 * reach, x: side * (start + along), y: 0.03, z: MIDDLE + w - reach, colour: HATCH, faces: [face] });
  }
  return bars;
}

/** The two bollards and the keep-left sign at each nose of the platform, where a car meets it head on. */
function noseBoxes(): StopBox[] {
  const at = TRAM_LENGTH / 2 + 0.35;
  return [1, -1].flatMap((side) => [
    box(0.2, 0.9, 0.2, side * at, RISE + 0.45, -(INNER + 0.35), BOLLARD),
    box(0.22, 0.12, 0.22, side * at, RISE + 0.75, -(INNER + 0.35), REFLECTOR),
    box(0.2, 0.9, 0.2, side * at, RISE + 0.45, -(INNER + WIDTH - 0.3), BOLLARD),
    box(0.22, 0.12, 0.22, side * at, RISE + 0.75, -(INNER + WIDTH - 0.3), REFLECTOR),
    box(0.08, 1.4, 0.08, side * at, RISE + 0.7, MIDDLE, METAL),
    box(0.06, 0.6, 0.6, side * (at + 0.05), RISE + 1.5, MIDDLE, POST_PAINT),
    box(0.07, 0.34, 0.12, side * (at + 0.05), RISE + 1.5, MIDDLE, SIGN_FACE),
  ]);
}

/**
 * The face of the timetable panel on the shelter's back glass, in the stop's
 * own frame: where its middle is and how big it is. The lettering is drawn as
 * two quads just proud of it (`tram-signs.ts`), so both read the one place.
 */
export const TIMETABLE = { x: 1.5, y: RISE + 1.55, z: MIDDLE - WIDTH / 2 + 0.23, width: 1.1, height: 0.62 };

/** The shelter in the middle of the platform: a roof, glass behind and at both ends, and a bench. */
function shelterBoxes(): StopBox[] {
  const glass = SHELTER_TALL - 0.5;
  const back = MIDDLE - WIDTH / 2 + 0.16;
  const end = SHELTER_LONG / 2 - 0.05;
  return [
    box(SHELTER_LONG, 0.12, WIDTH - 0.3, 0, RISE + SHELTER_TALL, MIDDLE, METAL),
    box(SHELTER_LONG, glass, 0.07, 0, RISE + 0.35 + glass / 2, back, GLASS),
    box(0.07, glass, WIDTH - 0.4, end, RISE + 0.35 + glass / 2, MIDDLE, GLASS),
    box(0.07, glass, WIDTH - 0.4, -end, RISE + 0.35 + glass / 2, MIDDLE, GLASS),
    box(0.1, SHELTER_TALL, 0.1, end, RISE + SHELTER_TALL / 2, MIDDLE + WIDTH / 2 - 0.2, METAL),
    box(0.1, SHELTER_TALL, 0.1, -end, RISE + SHELTER_TALL / 2, MIDDLE + WIDTH / 2 - 0.2, METAL),
    box(SHELTER_LONG - 1.2, 0.08, 0.45, 0, RISE + 0.46, back + 0.32, METAL),
    // The timetable hangs on the glass behind the bench. Its case is dark: what
    // lights after dark is the lettering on it (`tram-signs.ts`).
    box(TIMETABLE.width, TIMETABLE.height, 0.05, TIMETABLE.x, TIMETABLE.y, back + 0.07, PANEL_CASE),
  ];
}

/** The mast at the end the tram arrives from, with the line's flag on top of it. */
function flagBoxes(): StopBox[] {
  const tall = 2.5;
  const at = -(TRAM_LENGTH / 2 - 1.2);
  return [
    box(0.12, tall, 0.12, at, tall / 2 + RISE, MIDDLE, POST_PAINT),
    box(0.07, 0.5, 0.5, at, RISE + tall + 0.2, MIDDLE, POST_PAINT),
    box(0.11, 0.34, 0.34, at, RISE + tall + 0.2, MIDDLE, SIGN_FACE),
    ...noseBoxes(),
  ];
}

/** The three geometries a stop is drawn with, each with its colours on its vertices. */
function tramStopParts(): { platform: BufferGeometry; shelter: BufferGeometry; flag: BufferGeometry } {
  const grow = (parts: StopBox[]): BufferGeometry => merged(parts.map((part) => coloured(boxOf(part), part.colour)));
  return { platform: grow(platformBoxes()), shelter: grow(shelterBoxes()), flag: grow(flagBoxes()) };
}

export class TramStopView {
  readonly group = new Group();
  private readonly line: TramLine;
  private readonly meshes: InstancedMesh[];
  private readonly trim: VehicleTrim;
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);

  constructor(line: TramLine) {
    this.line = line;
    const parts = tramStopParts();
    // A stop carries no lamp of its own: the lettering on its panel is what
    // burns after dark (`tram-signs.ts`). The trim material is still what the
    // parts are drawn with, so a stop and a tram share one shader.
    this.trim = createVehicleTrim();
    const cap = Math.max(1, line.stopPlaces().length);
    this.meshes = [parts.platform, parts.shelter, parts.flag].map((geometry) => instanced(geometry, this.trim.material, true, cap));
    this.group.add(...this.meshes);
  }

  /** How far on the lit panels of the stops are, 0 by day and 1 after dark. */
  set lamps(amount: number) {
    this.trim.lamps.value = amount;
  }

  get lamps(): number {
    return this.trim.lamps.value;
  }

  /** How many stops the last frame drew. */
  get drawn(): number {
    return this.meshes[0]?.count ?? 0;
  }

  /** Stand a platform, a shelter and a flag at every stop round a place. */
  update(x: number, y: number): void {
    let count = 0;
    for (const place of this.line.stopPlaces()) {
      if (Math.abs(place.x - x) > TRAM_STOP_VIEW || Math.abs(place.y - y) > TRAM_STOP_VIEW) continue;
      if (count >= (this.meshes[0]?.instanceMatrix.count ?? 0)) break;
      this.at.set(place.x, place.height, place.y);
      this.turn.setFromAxisAngle(this.up, -place.heading);
      this.matrix.compose(this.at, this.turn, this.one);
      for (const mesh of this.meshes) mesh.setMatrixAt(count, this.matrix);
      count++;
    }
    for (const mesh of this.meshes) {
      mesh.count = count;
      mesh.visible = count > 0;
      if (count > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.trim.dispose();
    this.group.clear();
  }
}
