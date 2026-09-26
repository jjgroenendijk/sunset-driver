/**
 * How a shop's room looks: the theme it is fitted out in, and the colours,
 * the floor, the walls, the ceiling and the lamps that theme deals it
 * (spec section 16.1).
 *
 * Every room is dealt from the seed and its shop, so the same café of the same
 * city always looks the same, and two cafés of one city rarely do. A theme is
 * a set of choices rather than one look: a pub is always panelled wood under
 * beams and warm lamps, but which wood, which floor, which lamps and which
 * colour the walls take is dealt again for each one, and every colour is moved
 * a little off its swatch.
 *
 * A café and a bar lean to the themes that suit their district's wealth: a
 * dive bar is a poor district's and a cocktail lounge a rich one's. Every
 * theme can turn up anywhere; wealth only weighs the deal.
 *
 * Pure: the same seed and shop give the same style. It is render state, so it
 * takes its numbers from the seed through the shop's own stream rather than
 * from the record.
 */
import { Color } from 'three';
import { genRng, Subsystem, type Rng } from '../../core/rng.ts';
import type { ShopKind } from '../../world/city/shops.ts';

type FloorPattern = 'planks' | 'checker' | 'tiles' | 'concrete' | 'carpet';
type WallPattern = 'paint' | 'wainscot' | 'brick' | 'stripes' | 'tiles' | 'panels';
type CeilingPattern = 'plain' | 'beams' | 'ducts' | 'grid';
type LampKind = 'pendant' | 'globes' | 'bulbs' | 'strips' | 'lanterns' | 'fans';
/** How the floor of a café or a bar is seated. */
export type Seating = 'tables' | 'booths' | 'lounge' | 'high' | 'ledge';
/** What hangs on the walls or stands in the corners. */
export type Decor = 'frames' | 'plants' | 'bookshelf' | 'menu-board' | 'dartboard' | 'screen' | 'neon' | 'rug' | 'clock' | 'mirror';

/** One room's look, dealt. */
export interface RoomStyle {
  theme: string;
  floor: { pattern: FloorPattern; a: number; b: number };
  wall: { pattern: WallPattern; base: number; trim: number; feature: number };
  ceiling: { pattern: CeilingPattern; colour: number; trim: number };
  lamps: { kind: LampKind; shade: number; bulb: number };
  /** The colour of the room's light, which tints everything it gives off. */
  light: number;
  /** How much of its own colour a surface gives off: a bright café, a dim bar. */
  glow: number;
  /** The wood of the furniture and the counter, its metal, its cushions and its one strong colour. */
  wood: number;
  metal: number;
  fabric: number;
  accent: number;
  /** The frames of the shopfront's windows and door. */
  frame: number;
  /** The colour of a neon sign, when the theme hangs one. */
  neon: number | undefined;
  /** The seating a café or a bar is laid out with, in the order it prefers them. */
  seating: Seating[];
  decor: Decor[];
  /** The height of the shopfront's window sills. */
  sill: number;
}

/** A theme: the choices a room of it is dealt from. */
interface Theme {
  name: string;
  /** The district wealth the theme suits best, 0 to 1. */
  wealth: number;
  floors: readonly [FloorPattern, number, number][];
  walls: readonly [WallPattern, number, number][];
  features: readonly number[];
  ceilings: readonly [CeilingPattern, number, number][];
  lamps: readonly [LampKind, number, number][];
  light: readonly number[];
  glow: readonly [number, number];
  wood: readonly number[];
  metal: readonly number[];
  fabric: readonly number[];
  accent: readonly number[];
  frame: readonly number[];
  neon?: readonly number[];
  seating: readonly Seating[];
  decor: readonly Decor[];
}

const CAFE_THEMES: readonly Theme[] = [
  {
    name: 'scandi',
    wealth: 0.6,
    floors: [['planks', 0xd8c4a0, 0xcab48e], ['planks', 0xe6dccb, 0xd6c8b0], ['concrete', 0xc8c4bc, 0xb8b4ac]],
    walls: [['paint', 0xf2efe8, 0xe0dcd4], ['paint', 0xe6e8e4, 0xd0d4d0], ['panels', 0xece4d6, 0xd8ccb8]],
    features: [0xd8b86a, 0x9ab0a0, 0xe0c0b0, 0x8aa0b8],
    ceilings: [['plain', 0xf4f2ee, 0xe0ddd6], ['beams', 0xf4f2ee, 0xd0b890]],
    lamps: [['pendant', 0x222222, 0xfff0d0], ['pendant', 0xf2f2f2, 0xfff0d0], ['globes', 0xffffff, 0xfff4e0]],
    light: [0xfff4e4, 0xfff0dc],
    glow: [0.3, 0.38],
    wood: [0xd8bc8c, 0xc8a878, 0xe0caa0],
    metal: [0x2a2a2a, 0xd8d8d8],
    fabric: [0x9a9a96, 0xd8a840, 0x6a8a8a],
    accent: [0xd8a840, 0x6a9a8a, 0xe08a6a],
    frame: [0x2a2a2a, 0xf0f0f0],
    seating: ['tables', 'ledge', 'lounge'],
    decor: ['plants', 'frames', 'menu-board', 'rug'],
  },
  {
    name: 'parisian',
    wealth: 0.8,
    floors: [['checker', 0xf0ece4, 0x2a2a2a], ['tiles', 0xe8e0d0, 0xb8a888], ['planks', 0x8a5a38, 0x7a4c2e]],
    walls: [['wainscot', 0xf0e6d0, 0x1f4a3a], ['wainscot', 0xf0e0d0, 0x6a1f2a], ['stripes', 0xf0e6d0, 0xd8c8a8]],
    features: [0x1f4a3a, 0x6a1f2a, 0x2a3a5a],
    ceilings: [['plain', 0xf0e8d8, 0xc8a860], ['grid', 0xf0e8d8, 0xc8a860]],
    lamps: [['globes', 0xc8a860, 0xfff0c8], ['pendant', 0xc8a860, 0xffe8b8]],
    light: [0xffe8c0, 0xffe4b8],
    glow: [0.28, 0.36],
    wood: [0x4a2a1a, 0x5a3420],
    metal: [0xc8a860, 0xb89048],
    fabric: [0x8a1f2a, 0x1f5a3a, 0xc8a870],
    accent: [0xc8a860, 0x8a1f2a],
    frame: [0x1f3a2a, 0x2a2a2a, 0x6a1f2a],
    seating: ['tables', 'booths', 'ledge'],
    decor: ['mirror', 'frames', 'menu-board', 'plants', 'clock'],
  },
  {
    name: 'industrial',
    wealth: 0.4,
    floors: [['concrete', 0x8a8884, 0x7a7874], ['planks', 0x5a4030, 0x4a3426]],
    walls: [['brick', 0x9a4a38, 0xb8b0a8], ['brick', 0x7a7470, 0xa8a09a], ['paint', 0x5a605a, 0x40443e]],
    features: [0x2a2e30, 0x9a4a38, 0x3a4a52],
    ceilings: [['ducts', 0x2a2a2c, 0x7a7c80], ['plain', 0x3a3a3c, 0x2a2a2a]],
    lamps: [['bulbs', 0x1a1a1a, 0xffc070], ['pendant', 0x1a1a1a, 0xffd090]],
    light: [0xffd8a8, 0xffe0b8],
    glow: [0.3, 0.38],
    wood: [0x5a3a24, 0x6a4a30],
    metal: [0x1a1a1a, 0x3a3a3a],
    fabric: [0x8a5a30, 0x3a3a3a],
    accent: [0xe0a040, 0x3a8a9a],
    frame: [0x1a1a1a],
    seating: ['tables', 'high', 'ledge'],
    decor: ['menu-board', 'frames', 'plants', 'clock'],
  },
  {
    name: 'diner',
    wealth: 0.3,
    floors: [['checker', 0xf0f0f0, 0xc02a2a], ['checker', 0xf0f0f0, 0x1a1a1a], ['tiles', 0xe0e8e8, 0x40a0a0]],
    walls: [['tiles', 0xf4f4f0, 0xc02a2a], ['tiles', 0xf0f0ea, 0x40a0a0], ['stripes', 0xf0e0c0, 0xc02a2a]],
    features: [0xc02a2a, 0x40a0a0, 0xf0c040],
    ceilings: [['plain', 0xf4f4f4, 0xc0c0c0], ['grid', 0xf0f0f0, 0xb0b0b0]],
    lamps: [['strips', 0xd0d0d0, 0xf4f8ff], ['globes', 0xd0d0d0, 0xf8f8ff]],
    light: [0xf4f8ff, 0xfaf8f0],
    glow: [0.3, 0.38],
    wood: [0xd0d4d8, 0xc02a2a],
    metal: [0xd0d4d8, 0xb8bcc0],
    fabric: [0xc02a2a, 0x40a0a0, 0xf0c040],
    accent: [0xc02a2a, 0x40a0a0],
    frame: [0xc0c4c8],
    neon: [0xff4050, 0x40e0ff],
    seating: ['booths', 'high', 'tables'],
    decor: ['menu-board', 'neon', 'clock', 'frames'],
  },
  {
    name: 'tropical',
    wealth: 0.5,
    floors: [['tiles', 0xc87850, 0xb86840], ['planks', 0xd8b890, 0xc8a880], ['tiles', 0xe8e0d0, 0x5aa0a0]],
    walls: [['paint', 0xa8e0c8, 0x80c0a8], ['paint', 0xf8b8a0, 0xe89880], ['paint', 0xf8e8a8, 0xe0c880], ['stripes', 0xf0f0e0, 0x80c8c0]],
    features: [0xf08a6a, 0x3aa08a, 0xf0c050, 0xe06a90],
    ceilings: [['beams', 0xf0ece0, 0xb89868], ['plain', 0xf8f4ea, 0xd0c8b0]],
    lamps: [['fans', 0xb89868, 0xfff4d8], ['lanterns', 0xd8b880, 0xffe0a0]],
    light: [0xfff0d8, 0xfff4e0],
    glow: [0.32, 0.4],
    wood: [0xc8a070, 0xd8b888],
    metal: [0xe8e8e0, 0xc8a070],
    fabric: [0xf08a6a, 0x3aa08a, 0xf0e0b0],
    accent: [0xf08a6a, 0x3aa08a, 0xe06a90],
    frame: [0xf0f0e8, 0x3aa08a],
    seating: ['tables', 'lounge', 'ledge'],
    decor: ['plants', 'plants', 'frames', 'rug', 'menu-board'],
  },
  {
    name: 'botanical',
    wealth: 0.7,
    floors: [['planks', 0x9a7050, 0x8a6244], ['tiles', 0xe0dcd0, 0xc8c0b0]],
    walls: [['paint', 0x2a4a38, 0x1f3a2c], ['paint', 0xe8e4d8, 0xc8d0b8], ['wainscot', 0xe8e4d8, 0x2a4a38]],
    features: [0x2a4a38, 0xc8a870, 0x6a3a4a],
    ceilings: [['plain', 0xf0ece4, 0xd8d0c0], ['beams', 0xece8dc, 0x6a4a30]],
    lamps: [['globes', 0xe0e0d0, 0xfff0d0], ['pendant', 0xc8a870, 0xfff0d0]],
    light: [0xfff4e0],
    glow: [0.3, 0.38],
    wood: [0x7a5030, 0x9a6a40],
    metal: [0xc8a870, 0x2a2a2a],
    fabric: [0xc8a870, 0x6a3a4a, 0x3a6a4a],
    accent: [0xe0a0a0, 0xc8a870],
    frame: [0x2a4a38, 0x2a2a2a],
    seating: ['tables', 'lounge', 'booths'],
    decor: ['plants', 'plants', 'plants', 'bookshelf', 'frames'],
  },
];

const BAR_THEMES: readonly Theme[] = [
  {
    name: 'dive',
    wealth: 0.15,
    floors: [['concrete', 0x4a4644, 0x3a3634], ['checker', 0x2a2a2a, 0x6a2020]],
    walls: [['paint', 0x5a1f1f, 0x3a1414], ['panels', 0x4a3020, 0x3a2418], ['brick', 0x5a3a30, 0x4a4040]],
    features: [0x5a1f1f, 0x1f2a3a, 0x2a2a2a],
    ceilings: [['plain', 0x2a2624, 0x1a1a1a], ['ducts', 0x2a2a2a, 0x4a4a4a]],
    lamps: [['bulbs', 0x1a1a1a, 0xffb060], ['strips', 0x2a2a2a, 0xff5050]],
    light: [0xffc890, 0xffb8a0],
    glow: [0.2, 0.27],
    wood: [0x3a2418, 0x2a1a10],
    metal: [0x5a5a5a, 0x2a2a2a],
    fabric: [0x6a1a1a, 0x2a2a2a],
    accent: [0xe04040, 0x40a0e0],
    frame: [0x1a1a1a, 0x3a2418],
    neon: [0xff3040, 0x3080ff, 0xffa020],
    seating: ['booths', 'high', 'tables'],
    decor: ['neon', 'dartboard', 'screen', 'frames'],
  },
  {
    name: 'pub',
    wealth: 0.45,
    floors: [['planks', 0x5a3a24, 0x4a3020], ['carpet', 0x5a1f28, 0x3a1a1a], ['tiles', 0x8a5a3a, 0x3a2a20]],
    walls: [['wainscot', 0xe0c898, 0x4a2a18], ['wainscot', 0x2a4030, 0x3a2418], ['panels', 0x5a3a24, 0x3a2418]],
    features: [0x3a2418, 0x2a4030, 0x6a1f28],
    ceilings: [['beams', 0xe8dcc0, 0x3a2418], ['plain', 0xd8c8a0, 0x3a2418]],
    lamps: [['lanterns', 0xb89048, 0xffc070], ['globes', 0xb89048, 0xffd090]],
    light: [0xffc880, 0xffd090],
    glow: [0.26, 0.33],
    wood: [0x4a2a18, 0x5a3420],
    metal: [0xc8a060, 0xb89048],
    fabric: [0x6a1f28, 0x2a4a30, 0x4a2a18],
    accent: [0xc8a060, 0x2a4a30],
    frame: [0x2a2418, 0x1f3a2a],
    seating: ['booths', 'tables', 'high'],
    decor: ['dartboard', 'frames', 'mirror', 'screen', 'clock'],
  },
  {
    name: 'cocktail',
    wealth: 0.85,
    floors: [['checker', 0xe8e4dc, 0x2a2a2a], ['tiles', 0x2a2a2e, 0x3a3a40], ['planks', 0x3a2418, 0x2a1a10]],
    walls: [['paint', 0x1f3a40, 0x162a30], ['paint', 0x1a1a2a, 0x121220], ['wainscot', 0x2a1f3a, 0x0a0a10], ['stripes', 0x1a2a2a, 0x2a3a3a]],
    features: [0x1f3a40, 0x3a1f2a, 0x1a1a2a],
    ceilings: [['plain', 0x1a1a1e, 0xc8a060], ['grid', 0x1a1a1e, 0xc8a060]],
    lamps: [['globes', 0xc8a060, 0xffd8a0], ['pendant', 0xc8a060, 0xffd8a0]],
    light: [0xffd0a0, 0xffc8b0],
    glow: [0.26, 0.32],
    wood: [0x2a1a10, 0x1a1a1a],
    metal: [0xc8a060, 0xd8b870],
    fabric: [0x1f5a4a, 0x8a2a4a, 0x2a3a6a],
    accent: [0xc8a060, 0xf08ab0],
    frame: [0xc8a060, 0x1a1a1a],
    neon: [0xff70c0, 0x80e0ff],
    seating: ['lounge', 'high', 'booths'],
    decor: ['mirror', 'neon', 'frames', 'plants', 'rug'],
  },
  {
    name: 'tiki',
    wealth: 0.5,
    floors: [['planks', 0x8a6040, 0x7a5236], ['tiles', 0x6a4a30, 0x4a3420]],
    walls: [['stripes', 0xc8a060, 0x8a6030], ['paint', 0x3a6a4a, 0x2a4a38], ['stripes', 0xb89050, 0x5a3a20]],
    features: [0x3a6a4a, 0xc05a30, 0x2a5a6a],
    ceilings: [['beams', 0xc8a060, 0x6a4a28], ['plain', 0xb89050, 0x6a4a28]],
    lamps: [['lanterns', 0xe08030, 0xffa040], ['fans', 0x6a4a28, 0xffc070]],
    light: [0xffa860, 0xffb070],
    glow: [0.28, 0.34],
    wood: [0x8a6040, 0x6a4a28],
    metal: [0xc8a060],
    fabric: [0xe06a40, 0x3a8a6a, 0xe0c060],
    accent: [0xe06a40, 0x3a8a6a],
    frame: [0x5a3a20],
    neon: [0x40ffb0, 0xff8040],
    seating: ['tables', 'lounge', 'high'],
    decor: ['plants', 'plants', 'neon', 'frames'],
  },
  {
    name: 'neon',
    wealth: 0.35,
    floors: [['checker', 0x1a1a2a, 0x3a1a4a], ['concrete', 0x2a2a30, 0x1a1a20], ['tiles', 0x101018, 0x2a2a3a]],
    walls: [['paint', 0x1a1428, 0x100c18], ['paint', 0x0e1a24, 0x081018], ['tiles', 0x141420, 0x2a2a40]],
    features: [0x2a1440, 0x0a2a3a, 0x3a0a2a],
    ceilings: [['plain', 0x0a0a10, 0x2a2a3a], ['grid', 0x0a0a10, 0x3a3a5a]],
    lamps: [['strips', 0x202030, 0xff40c0], ['strips', 0x202030, 0x40e0ff], ['strips', 0x202030, 0xa060ff]],
    light: [0xd0a0ff, 0xa0d0ff, 0xffa0e0],
    glow: [0.2, 0.26],
    wood: [0x1a1a22, 0x2a2a34],
    metal: [0xc0c4d0, 0x3a3a48],
    fabric: [0x6a2a8a, 0x1a6a8a, 0x8a1a4a],
    accent: [0xff40c0, 0x40e0ff],
    frame: [0x1a1a22],
    neon: [0xff40c0, 0x40e0ff, 0xa060ff, 0x60ff80],
    seating: ['high', 'booths', 'lounge'],
    decor: ['neon', 'neon', 'screen', 'mirror'],
  },
  {
    name: 'speakeasy',
    wealth: 0.75,
    floors: [['planks', 0x3a2418, 0x2e1c12], ['checker', 0x1a1a1a, 0x8a7a5a]],
    walls: [['brick', 0x5a2e24, 0x3a3030], ['panels', 0x3a2418, 0x241810], ['wainscot', 0x3a1f24, 0x241810]],
    features: [0x3a1f24, 0x1f2a24, 0x2a2418],
    ceilings: [['plain', 0x1a1410, 0x8a6a3a], ['beams', 0x241a12, 0x120c08]],
    lamps: [['pendant', 0x8a6a3a, 0xffb060], ['bulbs', 0x2a2018, 0xffa850]],
    light: [0xffb878, 0xffc080],
    glow: [0.2, 0.26],
    wood: [0x3a2418, 0x2a1810],
    metal: [0xb08a48, 0x8a6a3a],
    fabric: [0x5a1a1a, 0x3a2418, 0x1f3a2a],
    accent: [0xb08a48, 0x5a1a1a],
    frame: [0x2a1810],
    seating: ['lounge', 'booths', 'tables'],
    decor: ['bookshelf', 'frames', 'mirror', 'clock', 'rug'],
  },
  {
    name: 'sports',
    wealth: 0.35,
    floors: [['planks', 0x8a6a48, 0x7a5c3c], ['concrete', 0x6a6864, 0x5a5854]],
    walls: [['paint', 0x2a3a5a, 0x1f2a44], ['stripes', 0xe8e8e8, 0x2a5a3a], ['brick', 0x7a3a2a, 0x9a9088]],
    features: [0x2a5a3a, 0x2a3a5a, 0xa02a2a],
    ceilings: [['ducts', 0x2a2a2e, 0x5a5a60], ['grid', 0xd8d8d8, 0x9a9a9a]],
    lamps: [['strips', 0xa0a0a0, 0xf0f4ff], ['pendant', 0x2a5a3a, 0xffe0b0]],
    light: [0xf0f0ff, 0xffe8d0],
    glow: [0.28, 0.36],
    wood: [0x5a3a24, 0x2a2a2a],
    metal: [0x9a9a9a, 0x2a2a2a],
    fabric: [0xa02a2a, 0x2a3a6a, 0x2a2a2a],
    accent: [0xf0c030, 0xa02a2a],
    frame: [0x2a2a2a],
    neon: [0xffe040, 0x40a0ff],
    seating: ['high', 'booths', 'tables'],
    decor: ['screen', 'screen', 'dartboard', 'frames', 'neon'],
  },
];

/** The looks a room of every other trade is dealt from; its back wall keeps the trade's colour. */
const TRADE_THEMES: readonly Theme[] = [
  {
    name: 'clean',
    wealth: 0.7,
    floors: [['tiles', 0xe0e0dc, 0xc8c8c4], ['tiles', 0xd8dce0, 0xb8bcc0]],
    walls: [['paint', 0xeceae4, 0xd0cec8], ['tiles', 0xf0f0ec, 0xd8d8d4]],
    features: [],
    ceilings: [['grid', 0xf0f0f0, 0xc0c0c0], ['plain', 0xf2f2f2, 0xd0d0d0]],
    lamps: [['strips', 0xd0d0d0, 0xf4f8ff]],
    light: [0xf4f8ff, 0xfaf8f0],
    glow: [0.3, 0.36],
    wood: [0xb8b0a0, 0xd0c8b8, 0x8a8a8a],
    metal: [0xb8bcc0],
    fabric: [0x5a6a7a],
    accent: [0x3a7ab0],
    frame: [0xb8bcc0, 0x2a2a2a],
    seating: [],
    decor: [],
  },
  {
    name: 'worn',
    wealth: 0.2,
    floors: [['concrete', 0x5a5854, 0x4a4844], ['checker', 0x9a968c, 0x5a5650]],
    walls: [['paint', 0xb8b89a, 0x9a9a80], ['brick', 0x8a5a48, 0x9a948c], ['panels', 0x8a7a60, 0x6a5a44]],
    features: [],
    ceilings: [['plain', 0xc8c4b8, 0xa8a498], ['ducts', 0x4a4a4c, 0x6a6a6c]],
    lamps: [['bulbs', 0x2a2a2a, 0xffe0a0], ['strips', 0xa0a0a0, 0xf0f8e8]],
    light: [0xfff0d0, 0xf0f8e8],
    glow: [0.3, 0.38],
    wood: [0x6b5a44, 0x5a4a38],
    metal: [0x6a6a6a],
    fabric: [0x5a4a3a],
    accent: [0xc0a040],
    frame: [0x3a3a3a, 0x6a5a44],
    seating: [],
    decor: [],
  },
  {
    name: 'warm',
    wealth: 0.5,
    floors: [['planks', 0x8a6a48, 0x7a5c3c], ['planks', 0xb89a70, 0xa88a60]],
    walls: [['paint', 0xe8dcc4, 0xd0c4a8], ['wainscot', 0xe8dcc4, 0x6a4a30]],
    features: [],
    ceilings: [['plain', 0xf0e8d8, 0xd8ccb8], ['beams', 0xf0e8d8, 0x6a4a30]],
    lamps: [['pendant', 0x2a2a2a, 0xfff0d0], ['globes', 0xe0e0d0, 0xfff0d0]],
    light: [0xfff0dc],
    glow: [0.3, 0.36],
    wood: [0x6b5a44, 0x8a6a48],
    metal: [0x2a2a2a],
    fabric: [0x6a3a2a],
    accent: [0x3a6a5a],
    frame: [0x3a2a1a, 0x2a2a2a],
    seating: [],
    decor: [],
  },
];

/** The themes of the trades that have their own; every other trade takes {@link TRADE_THEMES}. */
const THEMES_OF: Readonly<Partial<Record<ShopKind, readonly Theme[]>>> = { cafe: CAFE_THEMES, bar: BAR_THEMES };

/** How far a colour is moved off its swatch, in hue, saturation and lightness. */
const HUE_SHIFT = 0.025;
const SAT_SHIFT = 0.08;
const LIGHT_SHIFT = 0.05;

const scratch = new Color();
const hsl = { h: 0, s: 0, l: 0 };

/**
 * The look of one room. `feature` is the colour its back wall takes: the
 * trade's for a store, and none for a café or a bar, which paints its own.
 */
export function roomStyleOf(seed: number, shopId: number, kind: ShopKind, wealth: number, feature?: number): RoomStyle {
  const rng = genRng(seed, Subsystem.Venues, shopId + 0x20000);
  const themes = THEMES_OF[kind] ?? TRADE_THEMES;
  const theme = weighted(rng, themes, wealth);
  const [floorPattern, floorA, floorB] = rng.pick(theme.floors);
  const [wallPattern, wallBase, wallTrim] = rng.pick(theme.walls);
  const [ceilingPattern, ceilingColour, ceilingTrim] = rng.pick(theme.ceilings);
  const [lampKind, shade, bulb] = rng.pick(theme.lamps);
  const base = vary(rng, wallBase);
  return {
    theme: theme.name,
    floor: { pattern: floorPattern, a: vary(rng, floorA), b: vary(rng, floorB) },
    wall: {
      pattern: wallPattern,
      base,
      trim: vary(rng, wallTrim),
      feature: feature ?? (theme.features.length > 0 && rng.float() < 0.7 ? vary(rng, rng.pick(theme.features)) : base),
    },
    ceiling: { pattern: ceilingPattern, colour: vary(rng, ceilingColour), trim: vary(rng, ceilingTrim) },
    lamps: { kind: lampKind, shade: vary(rng, shade), bulb },
    light: rng.pick(theme.light),
    glow: theme.glow[0] + rng.float() * (theme.glow[1] - theme.glow[0]),
    wood: vary(rng, rng.pick(theme.wood)),
    metal: rng.pick(theme.metal),
    fabric: vary(rng, rng.pick(theme.fabric)),
    accent: vary(rng, rng.pick(theme.accent)),
    frame: rng.pick(theme.frame),
    neon: theme.neon === undefined ? undefined : rng.pick(theme.neon),
    seating: dealOrder(rng, theme.seating),
    decor: dealOrder(rng, theme.decor),
    sill: 0.45 + rng.float() * 0.5,
  };
}

/** A theme, weighed by how near the district's wealth is to the one it suits. */
function weighted(rng: Rng, themes: readonly Theme[], wealth: number): Theme {
  const weights = themes.map((theme) => 0.35 + Math.max(0, 1 - Math.abs(theme.wealth - wealth) * 2.2));
  let pick = rng.float() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < themes.length; i++) {
    pick -= weights[i] as number;
    if (pick <= 0) return themes[i] as Theme;
  }
  return themes[themes.length - 1] as Theme;
}

/** A list in the theme's order, with each item swapped with its neighbour at random, so a preference stays a preference. */
function dealOrder<T>(rng: Rng, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = 0; i + 1 < out.length; i++) {
    if (rng.float() < 0.4) [out[i], out[i + 1]] = [out[i + 1] as T, out[i] as T];
  }
  return out;
}

/** A colour moved a little off its swatch. */
function vary(rng: Rng, colour: number): number {
  scratch.setHex(colour).getHSL(hsl);
  const h = hsl.h + (rng.float() * 2 - 1) * HUE_SHIFT;
  const s = Math.min(1, Math.max(0, hsl.s + (rng.float() * 2 - 1) * SAT_SHIFT));
  const l = Math.min(0.95, Math.max(0.03, hsl.l + (rng.float() * 2 - 1) * LIGHT_SHIFT));
  return scratch.setHSL((h + 1) % 1, s, l).getHex();
}

/** A colour made lighter or darker by `by`, -1 to 1 of its lightness. */
export function shade(colour: number, by: number): number {
  scratch.setHex(colour).getHSL(hsl);
  return scratch.setHSL(hsl.h, hsl.s, Math.min(0.97, Math.max(0.02, hsl.l + by))).getHex();
}

/** Every theme's name, per trade, for the tests and the preview. */
export const THEME_NAMES = {
  cafe: CAFE_THEMES.map((theme) => theme.name),
  bar: BAR_THEMES.map((theme) => theme.name),
  trade: TRADE_THEMES.map((theme) => theme.name),
};
