/**
 * The rain, the puddles and the wind-blown litter of spec section 13.4.
 *
 * Three instanced batches, three draw calls, whatever the sky is doing:
 *
 * - the rain, a curtain of streaks falling through a box carried with the
 *   player and leaning with the wind;
 * - the puddles, flat discs on a lattice of the ground, which grow and clear
 *   with the wetness `src/sim/weather.ts` reports;
 * - the litter, scraps blown along the ground and tumbling as they go.
 *
 * Nothing here holds state between frames. Every piece is placed from its own
 * index and the tick, so a frame drawn at a tick looks the same however the
 * session reached it, and a replay sees the same rain fall.
 *
 * The pieces stand on a lattice in world space rather than at fixed offsets
 * from the player: an offset would slide the whole curtain along with the car
 * and the rain would read as a windscreen rather than as weather.
 * {@link lattice} is what keeps a piece still while the player drives past it.
 */
import {
  CircleGeometry,
  Color,
  Group,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  DoubleSide,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { hashInts } from '../core/hash.ts';
import { rngFor, Subsystem } from '../core/rng.ts';
import { TICK_RATE } from '../sim/clock.ts';
import type { Weather } from '../sim/weather.ts';
import { KERB_RISE, SURFACE_RAISE } from './road-section.ts';
import { tinted } from './tint.ts';

/** Streaks of rain drawn at the hardest downpour. */
const RAIN_CAP = 700;

/** Metres each way of the box the rain falls through, and how tall it is. */
const RAIN_BOX = 46;
const RAIN_HEIGHT = 26;

/** Metres a drop falls per second, and how far it leans per metre fallen at full wind. */
const RAIN_SPEED = 26;
const RAIN_LEAN = 0.55;

/** Metres of one streak: thin and long, so it reads as speed rather than as a drop. */
const RAIN_WIDTH = 0.035;
const RAIN_LENGTH = 0.85;

/** Scraps of litter drawn at the hardest wind, and metres each way of their box. */
const LITTER_CAP = 90;
const LITTER_BOX = 40;

/** Metres a scrap is blown per second at full wind, and how high it rides. */
const LITTER_SPEED = 7;
const LITTER_LIFT = 0.55;

/** Metres of one scrap: a wrapper or a sheet of newspaper. */
const LITTER_WIDTH = 0.24;
const LITTER_HEIGHT = 0.16;

/** The colours the litter comes in: paper, card and a plastic bag. */
const LITTER_COLOURS = [0xd8d2c4, 0xb59a74, 0xe7e9ea, 0xc8b8a0];

/** Puddles on the lattice around the player, and the metres between lattice points. */
const PUDDLE_CAP = 120;
const PUDDLE_SPACING = 13;

/** Metres across the largest puddle, and how far off its lattice point it may sit. */
const PUDDLE_RADIUS = 3.4;
const PUDDLE_JITTER = 5;

/**
 * Metres a puddle stands above the carved ground.
 *
 * A puddle is placed at the height of the carve, and everything it is drawn on
 * stands over that carve: the carriageway by {@link SURFACE_RAISE}, the kerb
 * and the pavement behind it by {@link KERB_RISE} more, and the ribbon the road
 * mesh is lofted along by a centimetre or two of its own. So the lift clears
 * the tallest of them. The first draft lifted a puddle 2.5 cm and it looked
 * exactly like a puddle nobody had built: every disc was inside the road.
 *
 * From the camera of spec section 10.7, 60 m up, this is two pixels.
 */
const PUDDLE_LIFT = SURFACE_RAISE + KERB_RISE + 0.02;

/** The wetness below which no puddle is drawn at all. */
const PUDDLE_FLOOR = 0.12;

/** Random streams of this file, kept apart so one never shifts another. */
const WIND_STREAM = 1;
const RAIN_STREAM = 2;
const LITTER_STREAM = 3;
const PUDDLE_STREAM = 4;

/** Where one piece of the rain or the litter sits in its box, and how far through its cycle. */
interface Speck {
  x: number;
  z: number;
  /** 0 to 1, which staggers the pieces so they do not fall or blow in step. */
  phase: number;
  /** How fast this one turns, for the litter. */
  spin: number;
}

/**
 * Put a piece on the world lattice nearest the viewer. The piece keeps its
 * place in the world as the player drives, and hops a whole box when it falls
 * behind, which happens off screen.
 */
function lattice(offset: number, at: number, box: number): number {
  return offset + box * Math.round((at - offset) / box);
}

/**
 * The way the prevailing wind of a world blows, in radians in the map's axes.
 * The litter leans with it here, and the smoke of `damage-fx.ts` drifts with it.
 */
export function windHeading(seed: number): number {
  return rngFor(seed, 0, Subsystem.Weather, WIND_STREAM).range(0, Math.PI * 2);
}

/** The rain, the puddles and the litter of one world. */
export class WeatherFx {
  readonly group = new Group();
  /** Batches drawn: the rain, the puddles and the litter. */
  readonly drawCalls = 3;

  private readonly rain: InstancedMesh;
  private readonly litter: InstancedMesh;
  private readonly puddles: InstancedMesh;
  private readonly drops: Speck[] = [];
  private readonly scraps: Speck[] = [];
  private readonly seed: number;
  private readonly height: (x: number, y: number) => number;
  /** The prevailing wind of this world, as a unit vector in the map's axes. */
  private readonly windX: number;
  private readonly windY: number;
  private readonly dummy = new Object3D();
  private readonly axis = new Vector3();

  constructor(seed: number, height: (x: number, y: number) => number) {
    this.seed = seed;
    this.height = height;
    const wind = windHeading(seed);
    this.windX = Math.cos(wind);
    this.windY = Math.sin(wind);

    this.drops = specks(seed, RAIN_STREAM, RAIN_CAP, RAIN_BOX);
    this.scraps = specks(seed, LITTER_STREAM, LITTER_CAP, LITTER_BOX);

    // A streak hangs below its own origin, so the instance is placed at the
    // top of the drop and the geometry reaches down from it.
    const streak = new PlaneGeometry(RAIN_WIDTH, RAIN_LENGTH);
    streak.translate(0, -RAIN_LENGTH / 2, 0);
    this.rain = batch(
      streak,
      new MeshBasicMaterial({ color: 0xc9d6e2, transparent: true, opacity: 0.5, depthWrite: false, fog: false }),
      RAIN_CAP,
    );

    // Lit rather than flat, so a scrap of paper is dark at night instead of
    // glowing its own colour across an unlit street.
    const scrap = new PlaneGeometry(LITTER_WIDTH, LITTER_HEIGHT);
    this.litter = tinted(batch(scrap, new MeshStandardNodeMaterial({ roughness: 0.9, side: DoubleSide }), LITTER_CAP));

    // A puddle is the one piece the light touches. The scene carries no
    // environment map, so a metal disc reflects nothing and comes out black on
    // black asphalt: three.js only throws image-based light off an environment,
    // and a hemisphere light is not one. What makes a puddle read from straight
    // above is therefore its colour — a pale blue-grey sheet of sky over a dark
    // road — and not its reflection.
    const disc = new CircleGeometry(0.5, 14);
    disc.rotateX(-Math.PI / 2);
    const water = new MeshStandardNodeMaterial({
      color: 0x6f808e,
      roughness: 0.25,
      metalness: 0,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    });
    this.puddles = batch(disc, water, PUDDLE_CAP);

    this.group.add(this.rain, this.litter, this.puddles);
    this.paintLitter(seed);
  }

  /**
   * Draw the weather as it stands at a tick, around a place. Called once a
   * frame, with the tick the rest of the scene is drawn at.
   */
  update(weather: Weather, tick: number, x: number, y: number): void {
    const seconds = tick / TICK_RATE;
    const ground = this.height(x, y);
    this.fall(weather, seconds, x, y, ground);
    this.blow(weather, seconds, x, y, ground);
    this.pool(weather, x, y);
  }

  dispose(): void {
    for (const mesh of [this.rain, this.litter, this.puddles]) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as { dispose(): void }).dispose();
      mesh.dispose();
    }
  }

  /** The curtain of rain, leaning with the wind. */
  private fall(weather: Weather, seconds: number, x: number, y: number, ground: number): void {
    const count = Math.round(RAIN_CAP * weather.rain);
    this.rain.count = count;
    this.rain.visible = count > 0;
    if (count === 0) return;
    const lean = RAIN_LEAN * weather.wind;
    // The axis a leaning drop turns about: across the wind, on the ground plane.
    this.axis.set(-this.windY, 0, this.windX).normalize();
    const tilt = Math.atan(lean);
    const dropped = RAIN_SPEED * seconds;
    for (let i = 0; i < count; i++) {
      const speck = this.drops[i] as Speck;
      const fallen = wrap(dropped + speck.phase * RAIN_HEIGHT, RAIN_HEIGHT);
      const above = RAIN_HEIGHT - fallen;
      const drift = lean * fallen;
      this.dummy.position.set(
        lattice(speck.x + drift * this.windX, x, RAIN_BOX),
        ground + above,
        lattice(speck.z + drift * this.windY, y, RAIN_BOX),
      );
      this.dummy.quaternion.setFromAxisAngle(this.axis, tilt);
      this.dummy.scale.setScalar(1);
      this.write(this.rain, i);
    }
    this.rain.instanceMatrix.needsUpdate = true;
  }

  /** The scraps blown along the ground. */
  private blow(weather: Weather, seconds: number, x: number, y: number, ground: number): void {
    const count = Math.round(LITTER_CAP * weather.wind);
    this.litter.count = count;
    this.litter.visible = count > 0;
    if (count === 0) return;
    const run = LITTER_SPEED * weather.wind * seconds;
    for (let i = 0; i < count; i++) {
      const speck = this.scraps[i] as Speck;
      const along = run + speck.phase * LITTER_BOX;
      this.dummy.position.set(
        lattice(speck.x + along * this.windX, x, LITTER_BOX),
        // It rides up and down as it tumbles, and never quite touches the road.
        ground + LITTER_LIFT * (0.4 + 0.6 * Math.abs(Math.sin(along * speck.spin))),
        lattice(speck.z + along * this.windY, y, LITTER_BOX),
      );
      this.dummy.rotation.set(along * speck.spin, along * speck.spin * 0.7, speck.phase * Math.PI * 2);
      this.dummy.scale.setScalar(1);
      this.write(this.litter, i);
    }
    this.litter.instanceMatrix.needsUpdate = true;
  }

  /** The puddles, on a lattice of the ground around the player. */
  private pool(weather: Weather, x: number, y: number): void {
    if (weather.wetness <= PUDDLE_FLOOR) {
      this.puddles.count = 0;
      this.puddles.visible = false;
      return;
    }
    // Below the floor there is no water at all, so the discs grow from nothing
    // rather than appearing at half size when the first shower lands.
    const depth = (weather.wetness - PUDDLE_FLOOR) / (1 - PUDDLE_FLOOR);
    const side = Math.floor(Math.sqrt(PUDDLE_CAP));
    const half = Math.floor(side / 2);
    const originX = Math.round(x / PUDDLE_SPACING);
    const originY = Math.round(y / PUDDLE_SPACING);
    let drawn = 0;
    for (let i = -half; i <= half && drawn < PUDDLE_CAP; i++) {
      for (let j = -half; j <= half && drawn < PUDDLE_CAP; j++) {
        const cellX = originX + i;
        const cellY = originY + j;
        const rng = rngFor(this.seed, 0, Subsystem.Weather, hashInts(PUDDLE_STREAM, cellX, cellY));
        // Only some of the lattice holds water, or the road comes out tiled.
        if (rng.float() > 0.55) continue;
        const px = cellX * PUDDLE_SPACING + rng.range(-PUDDLE_JITTER, PUDDLE_JITTER);
        const py = cellY * PUDDLE_SPACING + rng.range(-PUDDLE_JITTER, PUDDLE_JITTER);
        const size = PUDDLE_RADIUS * rng.range(0.45, 1) * depth;
        this.dummy.position.set(px, this.height(px, py) + PUDDLE_LIFT, py);
        this.dummy.rotation.set(0, rng.range(0, Math.PI), 0);
        this.dummy.scale.set(size * 2, 1, size * rng.range(1.2, 2.2));
        this.write(this.puddles, drawn++);
      }
    }
    this.puddles.count = drawn;
    this.puddles.visible = drawn > 0;
    this.puddles.instanceMatrix.needsUpdate = true;
  }

  /** Write the pose the dummy holds into one instance of a batch. */
  private write(mesh: InstancedMesh, index: number): void {
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  /** Give every scrap of litter its colour once, rather than every frame. */
  private paintLitter(seed: number): void {
    const colour = new Color();
    const rng = rngFor(seed, 0, Subsystem.Weather, LITTER_STREAM);
    for (let i = 0; i < LITTER_CAP; i++) {
      colour.setHex(LITTER_COLOURS[rng.int(0, LITTER_COLOURS.length - 1)] as number);
      this.litter.setColorAt(i, colour);
    }
    if (this.litter.instanceColor !== null) this.litter.instanceColor.needsUpdate = true;
  }
}

/** Lay out the pieces of one box: a place, a phase and a rate of turn each. */
function specks(seed: number, stream: number, count: number, box: number): Speck[] {
  const rng = rngFor(seed, 0, Subsystem.Weather, stream);
  const out: Speck[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: rng.range(-box / 2, box / 2),
      z: rng.range(-box / 2, box / 2),
      phase: rng.float(),
      spin: rng.range(0.6, 2.4),
    });
  }
  return out;
}

/** One instanced batch, never culled: its pieces are placed around the camera. */
function batch(geometry: BufferGeometry, material: Material, cap: number): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, cap);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  return mesh;
}

/** A value folded into [0, span). */
function wrap(value: number, span: number): number {
  return value - span * Math.floor(value / span);
}
