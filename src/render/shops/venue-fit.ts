/**
 * The layout of a café or a bar (spec section 16.1): where the counter
 * stands, what is behind it, how the floor is seated, what hangs on the walls
 * and who is in.
 *
 * The counter stands against the back wall or down one side. Behind a bar it
 * has shelves of bottles under a lit mirror; behind a café, the coffee machine
 * and a board of the day's menu. The rest of the floor is cut into strips
 * either side of a clear way from the door to the counter, and each strip is
 * seated in the way the style prefers that it has room for: booths or a sofa
 * against a wall, tables and chairs, high tables and stools, or a ledge along
 * the window. What is left over takes plants, and the walls take pictures,
 * mirrors, a clock, a dartboard, a screen or a neon sign.
 *
 * Every choice is dealt from the room's own stream, so the same café is laid
 * out the same way every time the player walks in.
 */
import type { Rng } from '../../core/rng.ts';
import { DEFAULT_APPEARANCE, HAIR_COLOURS, HAIR_STYLES, OUTFITS, SKIN_TONES, BODY_TYPES } from '../../sim/player/character.ts';
import type { CharacterAppearance } from '../../sim/player/character.ts';
import { SHOP_ROOM_HEIGHT } from '../../world/city/shops.ts';
import {
  armchair,
  bench,
  bookshelf,
  bottles,
  chair,
  clock,
  cup,
  dartboard,
  hangingPlant,
  highTable,
  lowTable,
  menuBoard,
  mirror,
  neonSign,
  picture,
  plant,
  rug,
  screen,
  sofa,
  Spot,
  stool,
  table,
  type Materials,
} from './furniture.ts';
import type { RoomKit } from './room-kit.ts';
import type { Shell } from './room-shell.ts';
import { shade, type Decor, type RoomStyle, type Seating } from './room-style.ts';

/** Someone standing in the room: where, which way they face, and how they look. */
export interface Figure {
  x: number;
  z: number;
  /** The model's turn about the vertical, as `CharacterModel` takes it. */
  turn: number;
  appearance: CharacterAppearance;
}

/** A strip of floor to be seated, and which of its edges stand against a wall. */
interface Strip {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** -1 where its `x0` edge is the left wall, 1 where its `x1` edge is the right wall, 0 for neither. */
  wall: number;
}

/** Metres behind the counter the staff stand in, and the depth of the counter. */
const STAFF = 0.9;
const COUNTER_DEPTH = 0.6;
/** Metres in front of the counter left for the customers. */
const CUSTOMERS = 0.9;
/** Half the width of the clear way from the door to the counter. */
const AISLE = 0.6;

/** Lay out a café or a bar in its shell, and answer who is in it. */
export function fitVenue(kit: RoomKit, rng: Rng, style: RoomStyle, shell: Shell, bar: boolean): Figure[] {
  const m: Materials = { wood: style.wood, metal: style.metal, fabric: style.fabric };
  const figures: Figure[] = [];
  const w = shell.halfWidth;
  const d = shell.halfDepth;
  const side = counterSide(rng, w, d);
  const strips = side === 0 ? counterAtBack(kit, rng, style, m, shell, bar, figures) : counterOnSide(kit, rng, style, m, shell, bar, side, figures);
  const round = rng.float() < 0.5;
  const seating = style.seating.length > 0 ? style.seating : (['tables'] as Seating[]);
  let next = 0;
  // Bookshelves go down one wall at most, and not in every room that could have them.
  let shelved = style.decor.includes('bookshelf') && rng.float() < 0.6;
  for (const strip of strips) {
    if (strip.x1 - strip.x0 < 0.8 || strip.z1 - strip.z0 < 0.8) continue;
    if (shelved && strip.wall !== 0) {
      shelveAgainst(kit, rng, style, strip);
      shelved = false;
    }
    if (seating.includes('ledge') && strip.z1 > d - 0.3 && strip.z1 - strip.z0 > 2.4) {
      ledge(kit, m, strip, figures, rng);
      strip.z1 -= 0.9;
    }
    const scheme = pickScheme(seating, next, strip);
    next++;
    seat(kit, rng, m, style, strip, scheme, round, figures);
  }
  walls(kit, rng, style, shell, side, bar);
  greenery(kit, rng, style, shell, side);
  return figures;
}

/** Which wall the counter stands against: 0 the back, -1 the left, 1 the right. A narrow room keeps it at the back. */
function counterSide(rng: Rng, w: number, d: number): number {
  if (w < 2.6 || d < 3.2) return 0;
  const roll = rng.float();
  if (roll < 0.5) return 0;
  return roll < 0.75 ? -1 : 1;
}

/** The counter across the back of the room, and the strips of floor either side of the way in. */
function counterAtBack(kit: RoomKit, rng: Rng, style: RoomStyle, m: Materials, shell: Shell, bar: boolean, figures: Figure[]): Strip[] {
  const w = shell.halfWidth;
  const d = shell.halfDepth;
  const length = 2 * w * (0.55 + rng.float() * 0.3);
  const offset = (rng.float() < 0.5 ? -1 : 1) * (w - length / 2 - 0.1) * rng.float();
  counter(rng, style, m, new Spot(kit, offset, -d, 0), length, 2 * w - 0.1, bar, figures, offset);
  const front = -d + STAFF + 0.3 + COUNTER_DEPTH + CUSTOMERS + (bar ? 0.3 : 0);
  return aisleSplit(shell.door.x, -w + 0.05, w - 0.05, front, d - 0.2, w);
}

/** The counter down one side wall, and the strips of the floor across from it. */
function counterOnSide(kit: RoomKit, rng: Rng, style: RoomStyle, m: Materials, shell: Shell, bar: boolean, side: number, figures: Figure[]): Strip[] {
  const w = shell.halfWidth;
  const d = shell.halfDepth;
  const length = 2 * d * (0.5 + rng.float() * 0.25);
  const along = -d + 0.15 + length / 2;
  // Down the right wall the counter's own `dx` runs towards the door, and down the left towards the back.
  const spot = side > 0 ? new Spot(kit, w, along, -Math.PI / 2) : new Spot(kit, -w, along, Math.PI / 2);
  counter(rng, style, m, spot, length, length + 0.2, bar, figures, 0);
  const reach = STAFF + 0.3 + COUNTER_DEPTH + CUSTOMERS + (bar ? 0.3 : 0);
  const inner = w - reach;
  const x0 = side > 0 ? -w + 0.05 : -inner;
  const x1 = side > 0 ? inner : w - 0.05;
  // Past the end of the counter the floor runs to the side wall again.
  const strips = aisleSplit(shell.door.x, x0, x1, -d + 0.2, d - 0.2, w);
  const past = -d + 0.15 + length + 0.6;
  const beyond: Strip = side > 0 ? { x0: inner + 0.2, x1: w - 0.05, z0: past, z1: d - 0.2, wall: 1 } : { x0: -w + 0.05, x1: -inner - 0.2, z0: past, z1: d - 0.2, wall: -1 };
  // The way in from the door is kept clear.
  if (shell.door.x + AISLE > beyond.x0 && shell.door.x - AISLE < beyond.x1) beyond.z1 = d - 1.6;
  if (beyond.z1 - beyond.z0 > 1.2) strips.push(beyond);
  return strips;
}

/**
 * Cut a stretch of floor in two about a clear way from the door. `w` is the
 * room's half width: a strip's edge is a wall only where it reaches one.
 */
function aisleSplit(door: number, x0: number, x1: number, z0: number, z1: number, w: number): Strip[] {
  const strips: Strip[] = [];
  const left = door - AISLE;
  const right = door + AISLE;
  if (left - x0 > 0.8) strips.push({ x0, x1: Math.min(left, x1), z0, z1, wall: x0 <= -w + 0.1 ? -1 : 0 });
  if (x1 - right > 0.8) strips.push({ x0: Math.max(right, x0), x1, z0, z1, wall: x1 >= w - 0.1 ? 1 : 0 });
  return strips;
}

/**
 * The counter, the back bar behind it and the one who serves, laid from a
 * spot on the wall: `dx` along the wall, `dz` out into the room. `length` is
 * the counter's and `back` the back bar's.
 */
function counter(rng: Rng, style: RoomStyle, m: Materials, s: Spot, length: number, back: number, bar: boolean, figures: Figure[], shift: number): void {
  const high = bar ? 1.08 : 0.98;
  const z = STAFF + 0.3 + COUNTER_DEPTH / 2;
  const front = rng.float() < 0.5 ? style.wood : style.accent;
  const top = rng.pick([shade(style.wood, -0.15), style.metal, 0xe8e4dc, 0x2a2a2a]);
  s.block(length, high - 0.05, COUNTER_DEPTH - 0.08, 0, 0, z, front);
  s.block(length + 0.1, 0.05, COUNTER_DEPTH + 0.06, 0, high - 0.05, z + 0.03, top);
  // Panels on the counter's front, and a rail to put a foot on at a bar.
  for (let u = -length / 2 + 0.5; u < length / 2 - 0.2; u += 0.6) s.block(0.04, high - 0.2, 0.02, u, 0.08, z + COUNTER_DEPTH / 2 - 0.03, shade(front, -0.12));
  if (bar) s.block(length, 0.04, 0.04, 0, 0.2, z + COUNTER_DEPTH / 2 + 0.1, style.metal);
  if (style.neon !== undefined) s.block(length, 0.02, 0.02, 0, high - 0.09, z + COUNTER_DEPTH / 2 + 0.03, style.neon, 'lamp');
  // The back bar: a cupboard along the wall, and what stands on it and over it.
  const backShift = -shift;
  s.block(back, 0.9, 0.45, backShift, 0, 0.23, shade(style.wood, -0.08));
  s.block(back + 0.04, 0.04, 0.5, backShift, 0.9, 0.25, top);
  if (bar) backBar(s, rng, style, back, backShift);
  else coffeeBar(s, rng, style, back, backShift);
  // What stands on the counter.
  if (bar) taps(s, rng, style, length, high, z);
  else cakes(s, rng, style, length, high, z);
  // The register at one end.
  s.block(0.32, 0.18, 0.3, length / 2 - 0.3, high, z, 0x2a2a2a);
  s.block(0.28, 0.14, 0.04, length / 2 - 0.3, high + 0.16, z - 0.08, 0x3a3a3a);
  // The one who serves, behind the counter and facing the room.
  const [kx, kz] = s.at((rng.float() - 0.5) * length * 0.5, STAFF * 0.6);
  figures.push({ x: kx, z: kz, turn: facing(s, 0, 1), appearance: dealt(rng) });
  customers(rng, m, s, length, z, bar, figures);
}

/** Stools along the counter's front with a customer or two at them, or one customer waiting to order. */
function customers(rng: Rng, m: Materials, s: Spot, length: number, z: number, bar: boolean, figures: Figure[]): void {
  const front = z + COUNTER_DEPTH / 2;
  if (!bar && rng.float() >= 0.35) {
    const [px, pz] = s.at(0, front + 0.55);
    figures.push({ x: px, z: pz, turn: facing(s, 0, -1), appearance: dealt(rng) });
    return;
  }
  const count = Math.floor((length - 0.4) / 0.62);
  for (let i = 0; i < count; i++) {
    const u = -length / 2 + 0.3 + (i + 0.5) * ((length - 0.6) / count);
    stool(s.child(u, front + 0.35), m, bar ? 0.78 : 0.72, i);
    if (rng.float() >= (bar ? 0.3 : 0.15)) continue;
    const [px, pz] = s.at(u + 0.3, front + 0.5);
    figures.push({ x: px, z: pz, turn: facing(s, 0, -1), appearance: dealt(rng) });
  }
}

/** Behind a bar: shelves of bottles in front of a lit mirror, and glasses hung over them. */
function backBar(s: Spot, rng: Rng, style: RoomStyle, back: number, shift: number): void {
  const width = Math.min(back, 2.6 + rng.float() * 1.4);
  if (rng.float() < 0.6) s.block(width, 1.25, 0.03, shift, 1.0, 0.02, 0xb8c4cc);
  else s.block(width, 1.25, 0.03, shift, 1.0, 0.02, shade(style.wood, -0.2));
  const shelves = 2 + Math.floor(rng.float() * 2);
  for (let i = 0; i < shelves; i++) {
    const y = 1.2 + i * 0.4;
    s.block(width, 0.03, 0.24, shift, y, 0.14, style.metal);
    bottles(s.child(shift, 0), rng, width, y + 0.03, 0.14);
  }
  // The strip that lights the bottles from above.
  s.block(width, 0.03, 0.05, shift, 1.2 + shelves * 0.4 - 0.02, 0.08, style.lamps.bulb, 'lamp');
  // Glasses and a few bottles on the back counter.
  for (let u = -back / 2 + 0.3; u < back / 2 - 0.3; u += 0.45 + rng.float() * 0.4) {
    if (rng.float() < 0.5) cup(s, shift + u, 0.94, 0.25, 0xdfeef2);
  }
  // The counter's spot faces the room, so a thing hung on its wall is turned to face out of the wall.
  if (style.neon !== undefined && rng.float() < 0.7) neonSign(s.child(shift + (rng.float() - 0.5) * 0.8, 0.02, Math.PI), rng, style.neon, 2.95);
}

/** Behind a café's counter: the coffee machine, a grinder, cups and jars, and the menu over them. */
function coffeeBar(s: Spot, rng: Rng, style: RoomStyle, back: number, shift: number): void {
  const at = shift + (rng.float() - 0.5) * (back - 1.4);
  const body = rng.pick([style.metal, 0xc02a2a, 0x2a2a2a, 0xd8d8d8, style.accent]);
  s.block(0.75, 0.42, 0.42, at, 0.94, 0.25, body);
  s.block(0.75, 0.05, 0.44, at, 1.36, 0.25, 0xb8bcc2);
  for (const u of [-0.2, 0.2]) {
    s.block(0.06, 0.08, 0.06, at + u, 1.06, 0.48, 0x2a2a2a);
    cup(s, at + u, 0.94, 0.5, 0xf2ede6);
  }
  for (let i = 0; i < 6; i++) cup(s, at - 0.25 + (i % 3) * 0.1, 1.41 + Math.floor(i / 3) * 0.09, 0.2, 0xf2ede6);
  // The grinder.
  s.block(0.18, 0.3, 0.2, at + 0.6, 0.94, 0.25, 0x2a2a2a);
  s.cylinder(0.08, 0.05, 0.18, at + 0.6, 1.24, 0.25, 0x5a3a24, 'matte', 10);
  // Shelves of jars and cups on the wall.
  const shelf = Math.min(back - 0.4, 2.4);
  for (const y of [1.55, 1.95]) {
    s.block(shelf, 0.03, 0.22, shift, y, 0.12, style.wood);
    for (let u = -shelf / 2 + 0.15; u < shelf / 2 - 0.1; u += 0.2 + rng.float() * 0.12) {
      const jar = rng.float() < 0.5;
      if (jar) s.cylinder(0.06, 0.06, 0.16, u + shift, y + 0.03, 0.12, rng.pick([0x7a4a2a, 0xe0c080, 0x3a2a1a, 0xc8a060]), 'matte', 10);
      else cup(s, u + shift, y + 0.03, 0.12, rng.pick([0xf2ede6, style.accent, 0x2a2a2a]));
    }
  }
  menuBoard(s.child(shift, 0.02, Math.PI), rng, style.wood, Math.min(back - 0.4, 2.2), 0.62, 2.95);
}

/** The beer taps along a bar's counter, and a few glasses. */
function taps(s: Spot, rng: Rng, style: RoomStyle, length: number, high: number, z: number): void {
  const count = 3 + Math.floor(rng.float() * 4);
  const at = -length / 2 + 0.6 + rng.float() * Math.max(0, length - 1.6 - count * 0.14);
  s.block(count * 0.14 + 0.1, 0.4, 0.1, at + (count * 0.14) / 2, high, z - 0.12, style.metal);
  for (let i = 0; i < count; i++) {
    const u = at + 0.07 + i * 0.14;
    s.block(0.03, 0.2, 0.03, u, high + 0.4, z - 0.12, rng.pick([0xe0a030, 0x2a2a2a, 0xc02a2a, 0x2a6a3a, 0xf0f0f0, 0x3a5ab0]));
  }
  for (let i = 0; i < 3; i++) {
    if (rng.float() < 0.6) cup(s, -length / 2 + 0.3 + rng.float() * (length - 0.9), high, z + 0.1, rng.pick([0xe8c040, 0x2a1a10, 0xdfeef2]));
  }
}

/** A glass case of cakes on a café's counter. */
function cakes(s: Spot, rng: Rng, style: RoomStyle, length: number, high: number, z: number): void {
  const width = Math.min(1.4, length * 0.45);
  const at = -length / 2 + width / 2 + 0.15;
  s.block(width, 0.04, 0.5, at, high, z, style.metal);
  s.block(width, 0.36, 0.5, at, high + 0.04, z, 0xcfe4ec, 'glass');
  for (const level of [0.06, 0.24]) {
    for (let u = -width / 2 + 0.15; u < width / 2 - 0.1; u += 0.26) {
      const cake = rng.pick([0xf0e0c0, 0x5a3020, 0xd08040, 0xf0d040, 0xe890b0, 0xd9a45a]);
      s.cylinder(0.1, 0.1, 0.09, at + u, high + level, z, cake, 'matte', 12);
      s.cylinder(0.1, 0.1, 0.015, at + u, high + level + 0.09, z, shade(cake, 0.15), 'matte', 12);
    }
  }
}

/** A shelf along the front window with stools, the length of a strip. */
function ledge(kit: RoomKit, m: Materials, strip: Strip, figures: Figure[], rng: Rng): void {
  const length = strip.x1 - strip.x0 - 0.1;
  const s = new Spot(kit, (strip.x0 + strip.x1) / 2, strip.z1, Math.PI);
  s.block(length, 0.04, 0.34, 0, 1.02, 0.12, m.wood);
  for (const u of [-length / 2 + 0.05, length / 2 - 0.05]) s.block(0.04, 1.02, 0.04, u, 0, 0.2, m.metal);
  const count = Math.floor(length / 0.62);
  for (let i = 0; i < count; i++) {
    const u = -length / 2 + (i + 0.5) * (length / count);
    stool(s.child(u, 0.62), m, 0.76, i + 1);
    if (rng.float() < 0.12) {
      const [px, pz] = s.at(u, 0.8);
      figures.push({ x: px, z: pz, turn: facing(s, 0, -1), appearance: dealt(rng) });
    }
  }
}

/** The first seating the style prefers, from the `next`th on, that the strip has room for. */
function pickScheme(seating: readonly Seating[], next: number, strip: Strip): Seating {
  const width = strip.x1 - strip.x0;
  const depth = strip.z1 - strip.z0;
  for (let i = 0; i < seating.length; i++) {
    const scheme = seating[(next + i) % seating.length] as Seating;
    if (scheme === 'ledge') continue;
    if ((scheme === 'booths' || scheme === 'lounge') && (strip.wall === 0 || width < 1.4 || depth < 2)) continue;
    if (scheme === 'tables' && (width < 1.1 || depth < 1.3)) continue;
    return scheme;
  }
  return 'high';
}

/** Seat one strip of floor in the way asked. */
function seat(kit: RoomKit, rng: Rng, m: Materials, style: RoomStyle, strip: Strip, scheme: Seating, round: boolean, figures: Figure[]): void {
  if (scheme === 'booths') booths(kit, m, strip);
  else if (scheme === 'lounge') lounge(kit, rng, m, style, strip);
  else if (scheme === 'high') highTables(kit, rng, m, strip, figures);
  else tables(kit, rng, m, strip, round);
}

/** Booths down the wall: two benches facing over a table, one after another. */
function booths(kit: RoomKit, m: Materials, strip: Strip): void {
  const reach = Math.min(1.25, strip.x1 - strip.x0 - 0.1);
  const wallX = strip.wall < 0 ? strip.x0 : strip.x1;
  const mid = wallX - strip.wall * (reach / 2 + 0.02);
  const count = Math.floor((strip.z1 - strip.z0) / 1.9);
  const start = (strip.z0 + strip.z1) / 2 - (count * 1.9) / 2;
  const back = 0.62;
  for (let i = 0; i < count; i++) {
    const z0 = start + i * 1.9;
    bench(new Spot(kit, mid, z0 + 0.28, Math.PI), m, reach, back);
    bench(new Spot(kit, mid, z0 + 1.62, 0), m, reach, back);
    table(new Spot(kit, mid - strip.wall * 0.05, z0 + 0.95, 0), m, reach - 0.15, 0.7, false);
  }
}

/** A sofa against the wall, a low table, two armchairs across it, and a rug under them. */
function lounge(kit: RoomKit, rng: Rng, m: Materials, style: RoomStyle, strip: Strip): void {
  const width = strip.x1 - strip.x0;
  const wallX = strip.wall < 0 ? strip.x0 : strip.x1;
  const into = -strip.wall;
  const count = Math.max(1, Math.floor((strip.z1 - strip.z0) / 2.7));
  const unit = (strip.z1 - strip.z0) / count;
  for (let i = 0; i < count; i++) {
    const z = strip.z0 + (i + 0.5) * unit;
    const length = Math.min(2, unit - 0.5);
    rug(new Spot(kit, wallX + into * Math.min(width / 2, 1.2), z, 0), shade(style.accent, -0.15), Math.min(width - 0.2, 2.2), Math.min(unit - 0.3, 2.4));
    // The sofa's back is its `+dz`, which has to point at the wall.
    sofa(new Spot(kit, wallX + into * 0.45, z, strip.wall < 0 ? -Math.PI / 2 : Math.PI / 2), m, length);
    lowTable(new Spot(kit, wallX + into * 1.25, z, 0), m, 0.5, Math.min(1.1, length - 0.4));
    if (width > 2.4) {
      for (const dz of [-0.5, 0.5]) armchair(new Spot(kit, wallX + into * 2.0, z + dz, strip.wall < 0 ? Math.PI / 2 : -Math.PI / 2), m);
    } else if (rng.float() < 0.5) {
      plant(new Spot(kit, wallX + into * 0.3, z + unit / 2 - 0.2, 0), rng);
    }
  }
}

/** Tables and chairs in a grid over the strip: tables of two where it is narrow, of four where there is room. */
function tables(kit: RoomKit, rng: Rng, m: Materials, strip: Strip, round: boolean): void {
  const width = strip.x1 - strip.x0;
  const depth = strip.z1 - strip.z0;
  const four = width >= 1.7 && rng.float() < 0.6;
  const cellX = four ? 1.75 : 1.2;
  const cellZ = four ? 1.75 : 1.45;
  const cols = Math.max(1, Math.floor(width / cellX));
  const rows = Math.max(1, Math.floor(depth / cellZ));
  const variant = Math.floor(rng.float() * 3);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = strip.x0 + (i + 0.5) * (width / cols);
      const z = strip.z0 + (j + 0.5) * (depth / rows);
      const size = four ? 0.8 : 0.62;
      table(new Spot(kit, x, z, 0), m, size, size, round);
      const seats: [number, number, number][] = four
        ? [[0, -0.62, 0], [0, 0.62, Math.PI], [-0.62, 0, Math.PI / 2], [0.62, 0, -Math.PI / 2]]
        : [[0, -0.5, 0], [0, 0.5, Math.PI]];
      for (const [dx, dz, turn] of seats) {
        // A chair's back is its `+dz`; it faces the table.
        chair(new Spot(kit, x + dx, z + dz, turn + Math.PI), m, variant);
      }
    }
  }
}

/** High tables with stools round them, and now and then someone standing at one. */
function highTables(kit: RoomKit, rng: Rng, m: Materials, strip: Strip, figures: Figure[]): void {
  const width = strip.x1 - strip.x0;
  const depth = strip.z1 - strip.z0;
  const cols = Math.max(1, Math.floor(width / 1.3));
  const rows = Math.max(1, Math.floor(depth / 1.4));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = strip.x0 + (i + 0.5) * (width / cols);
      const z = strip.z0 + (j + 0.5) * (depth / rows);
      highTable(new Spot(kit, x, z, 0), m, 0.3);
      const around = 2 + Math.floor(rng.float() * 2);
      for (let k = 0; k < around; k++) {
        const a = (k / around) * Math.PI * 2 + 0.3;
        stool(new Spot(kit, x + Math.cos(a) * 0.5, z + Math.sin(a) * 0.5, 0), m, 0.72, k);
      }
      if (rng.float() < 0.2) figures.push({ x: x + 0.45, z: z - 0.3, turn: Math.PI, appearance: dealt(rng) });
    }
  }
}

/** Bookshelves along the wall edge of a strip, which the strip then gives up. */
function shelveAgainst(kit: RoomKit, rng: Rng, style: RoomStyle, strip: Strip): void {
  const length = strip.z1 - strip.z0;
  const count = Math.max(1, Math.floor(length / 1.3));
  const wallX = strip.wall < 0 ? strip.x0 - 0.05 : strip.x1 + 0.05;
  for (let i = 0; i < count; i++) {
    const z = strip.z0 + (i + 0.5) * (length / count);
    bookshelf(new Spot(kit, wallX - strip.wall * 0.2, z, strip.wall < 0 ? -Math.PI / 2 : Math.PI / 2), rng, shade(style.wood, -0.05), 1.1, 2.0);
  }
  if (strip.wall < 0) strip.x0 += 0.45;
  else strip.x1 -= 0.45;
}

/** What hangs on the walls: along each side wall the counter does not take, and on the back wall when it is free. */
function walls(kit: RoomKit, rng: Rng, style: RoomStyle, shell: Shell, side: number, bar: boolean): void {
  const w = shell.halfWidth;
  const d = shell.halfDepth;
  const decor = style.decor.filter((item) => item !== 'plants' && item !== 'rug' && item !== 'bookshelf' && item !== 'menu-board');
  if (decor.length === 0) decor.push('frames');
  let n = Math.floor(rng.float() * decor.length);
  for (const wall of [-1, 1]) {
    if (wall === side) continue;
    const slots = Math.max(1, Math.floor((2 * d - 1) / 1.7));
    for (let i = 0; i < slots; i++) {
      const z = -d + 0.5 + (i + 0.5) * ((2 * d - 1) / slots);
      // A spot on the wall facing into the room: its `+dz` is the wall.
      hang(new Spot(kit, wall * (w - 0.02), z, wall < 0 ? -Math.PI / 2 : Math.PI / 2), rng, style, decor[n % decor.length] as Decor, bar);
      n++;
    }
  }
  if (side !== 0) {
    const back = new Spot(kit, 0, -d + 0.02, Math.PI);
    hang(back, rng, style, bar ? 'neon' : 'frames', bar);
    if (!bar) menuBoard(new Spot(kit, side * (w - 1.8), -d + 0.02, Math.PI), rng, style.wood, 1.4, 0.8, 2.6);
  }
}

/** One thing on a wall, at a spot whose `+dz` is the wall. */
function hang(s: Spot, rng: Rng, style: RoomStyle, item: Decor, bar: boolean): void {
  if (item === 'mirror') mirror(s, style.metal, 0.9, 1.1, 2.1);
  else if (item === 'clock') clock(s, style.metal, 2.25);
  else if (item === 'dartboard' && bar) dartboard(s, 1.75);
  else if (item === 'screen') screen(s, rng.pick([0x3aa04a, 0x2a6ab0, 0xc0a030]), 1.2, 2.45);
  else if (item === 'neon' && style.neon !== undefined) neonSign(s, rng, style.neon, 2.2);
  else {
    // A picture, or two side by side.
    if (rng.float() < 0.5) picture(s, rng, style.frame, 0.7 + rng.float() * 0.4, 0.55 + rng.float() * 0.4, 1.95);
    else for (const dx of [-0.4, 0.4]) picture(s.child(dx, 0), rng, style.frame, 0.55, 0.7, 1.95);
  }
}

/** Plants in the front corners and, in a green theme, hanging in the windows. */
function greenery(kit: RoomKit, rng: Rng, style: RoomStyle, shell: Shell, side: number): void {
  const count = style.decor.filter((item) => item === 'plants').length;
  if (count === 0) return;
  const w = shell.halfWidth;
  const d = shell.halfDepth;
  for (const corner of [-1, 1]) {
    // A front corner takes a plant unless the door is in it.
    if (Math.abs(shell.door.x - corner * (w - 0.3)) < 1.0) continue;
    plant(new Spot(kit, corner * (w - 0.3), d - 0.3, 0), rng);
  }
  if (side !== 0 && rng.float() < 0.7) plant(new Spot(kit, -side * (w - 0.3), -d + 0.3, 0), rng);
  if (count > 1) {
    for (let x = -w + 0.6; x < w - 0.4; x += 1.1 + rng.float() * 0.6) {
      if (Math.abs(x - shell.door.x) < 0.8) continue;
      hangingPlant(new Spot(kit, x, d - 0.35, 0), rng, SHOP_ROOM_HEIGHT);
    }
  }
}

/** The turn a figure standing at a spot takes to face along the spot's `(dx, dz)`. */
function facing(s: Spot, dx: number, dz: number): number {
  const [x0, z0] = s.at(0, 0);
  const [x1, z1] = s.at(dx, dz);
  return -Math.atan2(z1 - z0, x1 - x0);
}

/** Someone the city might send in: a body, a face and clothes dealt from the room's stream. */
function dealt(rng: Rng): CharacterAppearance {
  return {
    ...DEFAULT_APPEARANCE,
    body: Math.floor(rng.float() * BODY_TYPES.length),
    skin: Math.floor(rng.float() * SKIN_TONES.length),
    hair: Math.floor(rng.float() * HAIR_STYLES.length),
    hairColour: Math.floor(rng.float() * HAIR_COLOURS.length),
    outfit: Math.floor(rng.float() * OUTFITS.length),
  };
}
