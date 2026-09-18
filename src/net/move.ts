/**
 * One player on the wire (spec section 21.5): where they are, what they are
 * driving, and what they are pressing.
 *
 * Every peer has final authority over its own vehicle and character, so this is
 * the whole of what a peer says about itself. It goes out at a fixed rate as a
 * compact typed array rather than as JSON: a frame is 25 numbers, which is 100
 * bytes, against about four times that written out as text.
 *
 * The inputs ride along with the pose because a reader predicts between two
 * frames: a car under throttle is still accelerating when the next frame is
 * late, and a walker holding sprint is still running. `replica.ts` is what does
 * the predicting.
 *
 * Nothing here is trusted. A frame arrives from another browser, so it is read
 * out of the array field by field and refused whole where a number is not a
 * number. The reader never throws: a peer that sends rubbish goes still, which
 * is what a peer that stopped sending looks like anyway.
 */
import { normaliseAppearance, type CharacterAppearance } from '../sim/character.ts';
import type { InputFrame } from '../sim/input.ts';
import type { SimState } from '../sim/simulation.ts';
import { VEHICLE_CLASSES, type VehicleClass } from '../sim/vehicle.ts';

/** Numbers in one packed frame. */
export const FRAME_LENGTH = 25;

/**
 * The tick is split across two slots, because a `Float32Array` holds a whole
 * number exactly only up to 2^24 and a session passes that in 77 hours of play.
 * Both halves are well inside it, so the tick is exact for as long as anybody
 * plays.
 */
const TICK_SPLIT = 1 << 16;

/** The bits of slot 2: what the player is holding, and which state they are in. */
const DRIVING = 1;
const GROUNDED = 2;
const HANDBRAKE = 4;
const SPRINT = 8;
const FIRE = 16;

/** A player as another peer sees them, at one tick of their own clock. */
export interface PlayerFrame {
  /** The sender's tick when it was packed. A reader draws it against its own. */
  tick: number;
  /** True while they are in their vehicle, which is what decides what is drawn. */
  driving: boolean;
  grounded: boolean;
  health: number;
  /** Their place on the map, their height above sea level, and which way they face. */
  x: number;
  y: number;
  height: number;
  heading: number;
  /** Metres per second over the ground, and up. Both are what a prediction runs on. */
  speed: number;
  vy: number;
  /** The row of the roster they are driving, and the colour it is painted. */
  cls: VehicleClass;
  paint: number;
  /** The middle of their vehicle, in metres. `vy` here is up; `vz` is the map's `y`. */
  carX: number;
  carY: number;
  carZ: number;
  /** Its orientation, as a unit quaternion. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Its forward speed, and its velocity, which is what carries it on between frames. */
  carSpeed: number;
  velX: number;
  velY: number;
  velZ: number;
  /** What they are pressing, so a reader predicts rather than waits. */
  throttle: number;
  steer: number;
  handbrake: boolean;
  sprint: boolean;
  fire: boolean;
}

/** Pack a frame for the wire. */
export function packFrame(frame: PlayerFrame): Float32Array {
  const out = new Float32Array(FRAME_LENGTH);
  out[0] = Math.floor(frame.tick / TICK_SPLIT);
  out[1] = frame.tick % TICK_SPLIT;
  out[2] =
    (frame.driving ? DRIVING : 0) |
    (frame.grounded ? GROUNDED : 0) |
    (frame.handbrake ? HANDBRAKE : 0) |
    (frame.sprint ? SPRINT : 0) |
    (frame.fire ? FIRE : 0);
  out[3] = frame.health;
  out[4] = Math.max(0, VEHICLE_CLASSES.indexOf(frame.cls));
  out[5] = frame.paint;
  out[6] = frame.x;
  out[7] = frame.y;
  out[8] = frame.height;
  out[9] = frame.heading;
  out[10] = frame.speed;
  out[11] = frame.vy;
  out[12] = frame.carX;
  out[13] = frame.carY;
  out[14] = frame.carZ;
  out[15] = frame.qx;
  out[16] = frame.qy;
  out[17] = frame.qz;
  out[18] = frame.qw;
  out[19] = frame.carSpeed;
  out[20] = frame.velX;
  out[21] = frame.velY;
  out[22] = frame.velZ;
  out[23] = frame.throttle;
  out[24] = frame.steer;
  return out;
}

/**
 * A frame as it arrived, or null where what arrived is not one. Trystero hands
 * a binary payload back as an `ArrayBuffer` on some strategies and as a typed
 * array on others, so both are read.
 */
export function readFrame(value: unknown): PlayerFrame | null {
  const numbers = asFloats(value);
  if (numbers === null) return null;
  for (const number of numbers) if (!Number.isFinite(number)) return null;
  // The length was checked as the payload was read, so every slot is there.
  const at = (index: number): number => numbers[index] as number;
  const tick = at(0) * TICK_SPLIT + at(1);
  if (!Number.isSafeInteger(tick) || tick < 0) return null;
  const flags = at(2);
  return {
    tick,
    driving: (flags & DRIVING) !== 0,
    grounded: (flags & GROUNDED) !== 0,
    handbrake: (flags & HANDBRAKE) !== 0,
    sprint: (flags & SPRINT) !== 0,
    fire: (flags & FIRE) !== 0,
    health: at(3),
    cls: readClass(at(4)),
    paint: at(5),
    x: at(6),
    y: at(7),
    height: at(8),
    heading: at(9),
    speed: at(10),
    vy: at(11),
    carX: at(12),
    carY: at(13),
    carZ: at(14),
    qx: at(15),
    qy: at(16),
    qz: at(17),
    qw: at(18),
    carSpeed: at(19),
    velX: at(20),
    velY: at(21),
    velZ: at(22),
    throttle: at(23),
    steer: at(24),
  };
}

/** The roster row a slot names, or the first row where it names none. */
function readClass(index: number): VehicleClass {
  return VEHICLE_CLASSES[Math.round(index)] ?? (VEHICLE_CLASSES[0] as VehicleClass);
}

/** The payload as the numbers it claims to be, or null where it is not that many. */
function asFloats(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) return value.length === FRAME_LENGTH ? value : null;
  if (value instanceof ArrayBuffer) {
    return value.byteLength === FRAME_LENGTH * 4 ? new Float32Array(value) : null;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    if (view.byteLength !== FRAME_LENGTH * 4) return null;
    return new Float32Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return null;
}

/**
 * The local player as the room will see them. It reads the record and writes
 * nothing, which is the whole of `src/net`'s contact with the simulation.
 */
export function frameOf(state: SimState, input: InputFrame): PlayerFrame {
  const player = state.player;
  const car = state.vehicle;
  return {
    tick: state.tick,
    driving: player.driving,
    grounded: player.grounded,
    health: player.health,
    x: player.x,
    y: player.y,
    height: player.height,
    heading: player.heading,
    speed: player.speed,
    vy: player.vy,
    cls: car.cls,
    paint: car.paint,
    carX: car.x,
    carY: car.y,
    carZ: car.z,
    qx: car.qx,
    qy: car.qy,
    qz: car.qz,
    qw: car.qw,
    carSpeed: car.speed,
    velX: car.vx,
    velY: car.vy,
    velZ: car.vz,
    throttle: input.throttle,
    steer: input.steer,
    handbrake: input.handbrake,
    sprint: input.sprint,
    fire: input.fire,
  };
}

/** A look as it arrived, wrapped into the choices the creator offers. */
export function readAppearance(value: unknown): CharacterAppearance {
  if (typeof value !== 'object' || value === null) return normaliseAppearance(null);
  return normaliseAppearance(value as Partial<CharacterAppearance>);
}
