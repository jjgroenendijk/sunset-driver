import { Scene } from 'three';
import { describe, expect, it } from 'vitest';
import type { BuildingPlacement } from '../src/render/building-mesh.ts';
import { HEADLIGHT_CAP } from '../src/render/headlights.ts';
import { LAMP_LIGHT_CAP } from '../src/render/lamps.ts';
import type { PixelCanvas } from '../src/render/pixel-canvas.ts';
import { textWidth } from '../src/render/pixel-canvas.ts';
import { postersIn } from '../src/render/poster-mesh.ts';
import {
  adDesign,
  AD_WORDS,
  CULTURE_LOOKS,
  cultureRow,
  signAtlas,
  SIGN_CELL_HEIGHT,
  SIGN_CELL_WIDTH,
  SIGN_CULTURES,
  SIGN_DESIGNS,
  tradeDesign,
  type CultureLook,
} from '../src/render/sign-art.ts';
import {
  signDrawCalls,
  signGeometry,
  signParts,
  signsIn,
  shopTrades,
  type Sign,
  type TradeLookup,
} from '../src/render/sign-mesh.ts';
import { cellGrid } from '../src/render/cells.ts';
import { EntityFade } from '../src/render/fade.ts';
import { NeonLight } from '../src/render/sign-light.ts';
import { NEON_LIGHT_CAP, SignScenery } from '../src/render/signs.ts';
import { SCENE_LIGHT_CAP } from '../src/render/sky.ts';
import type { BuildingKind } from '../src/world/buildings.ts';
import { chunkBounds } from '../src/world/chunks.ts';
import { SHOP_KINDS, type Shop } from '../src/world/shops.ts';
import type { Culture, District } from '../src/world/types.ts';
import { districtOf, frontReach, GROUND, lookupOf, placedRow, sameFront, wallTop } from './building-fixture.ts';

/** Pixels the frame round a board leaves for a line of lettering. */
const LINE_ROOM = SIGN_CELL_WIDTH - 8;

/** No shop landed on any of these buildings, which is the common case on a high street. */
const NO_TRADES: TradeLookup = () => undefined;

/** A row of buildings of one kind, each with its own seed, placed and lettered. */
function signsOn(
  kind: BuildingKind,
  district: District,
  count: number,
  tradeOf: TradeLookup = NO_TRADES,
): { placed: BuildingPlacement[]; signs: Sign[] } {
  const placed = placedRow(kind, district, count);
  return { placed, signs: signsIn(placed, lookupOf(district), tradeOf) };
}

/** The colour of one pixel, as `0xrrggbb`. */
function pixelAt(canvas: PixelCanvas, x: number, y: number): number {
  const at = (y * canvas.width + x) * 4;
  return ((canvas.data[at] as number) << 16) | ((canvas.data[at + 1] as number) << 8) | (canvas.data[at + 2] as number);
}

describe('the sign atlas', () => {
  it('holds a cell for every design of every culture', () => {
    const atlas = signAtlas();
    expect(SIGN_DESIGNS).toHaveLength(SHOP_KINDS.length + AD_WORDS.length);
    expect(CULTURE_LOOKS).toHaveLength(SIGN_CULTURES.length);
    expect(atlas.width).toBe(SIGN_CELL_WIDTH * SIGN_DESIGNS.length);
    expect(atlas.height).toBe(SIGN_CELL_HEIGHT * SIGN_CULTURES.length);
    // The board of each row is its culture's, which is what a player reads a
    // neighbourhood by before they read a word of it.
    for (let row = 0; row < SIGN_CULTURES.length; row++) {
      const look = CULTURE_LOOKS[row] as CultureLook;
      expect(pixelAt(atlas, 3, row * SIGN_CELL_HEIGHT + SIGN_CELL_HEIGHT / 2)).toBe(look.board);
      expect(pixelAt(atlas, SIGN_CELL_WIDTH / 2, row * SIGN_CELL_HEIGHT)).toBe(look.ink);
    }
  });

  it('gives every culture its own colours, so no two neighbourhoods read alike', () => {
    const boards = new Set(CULTURE_LOOKS.map((look) => look.board));
    const tubes = new Set(CULTURE_LOOKS.map((look) => look.neon));
    expect(boards.size).toBe(CULTURE_LOOKS.length);
    expect(tubes.size).toBe(CULTURE_LOOKS.length);
  });

  it('sets every line of every sign inside the board it is painted on', () => {
    for (const look of CULTURE_LOOKS) {
      for (const name of look.names) expect(textWidth(name, 2)).toBeLessThanOrEqual(LINE_ROOM);
    }
    for (const design of SIGN_DESIGNS) expect(textWidth(design, 1)).toBeLessThanOrEqual(LINE_ROOM);
  });

  it('names a row for every culture the world hands out', () => {
    const cultures: Culture[] = [
      'none',
      'italian',
      'chinese',
      'east-european',
      'latin',
      'african-american',
      'outlaw',
      'irish',
      'beach',
    ];
    for (const culture of cultures) expect(SIGN_CULTURES[cultureRow(culture)]).toBe(culture);
  });

  it('gives each design and each culture its own cell of the texture coordinates', () => {
    const column = 1 / SIGN_DESIGNS.length;
    const row = 1 / SIGN_CULTURES.length;
    for (const culture of [0, SIGN_CULTURES.length - 1]) {
      for (const design of [0, SIGN_DESIGNS.length - 1]) {
        const geometry = signGeometry(signAt({ design, culture }));
        const uv = geometry.getAttribute('uv').array as Float32Array;
        for (let i = 0; i < uv.length; i += 2) {
          expect(uv[i]).toBeGreaterThanOrEqual(design * column - 1e-6);
          expect(uv[i]).toBeLessThanOrEqual((design + 1) * column + 1e-6);
          expect(uv[i + 1]).toBeGreaterThanOrEqual(culture * row - 1e-6);
          expect(uv[i + 1]).toBeLessThanOrEqual((culture + 1) * row + 1e-6);
        }
        geometry.dispose();
      }
    }
  });

  it('reads the right way up, whatever the cell', () => {
    // A `DataTexture` holds its first row at `v` 0 and the art is drawn top row
    // first, so the top of the board must take the top of its cell. Without the
    // turn the lettering is upside down, which no test of the cell bounds sees
    // and every frame does.
    const geometry = signGeometry(signAt({ culture: 4 }));
    const position = geometry.getAttribute('position').array as Float32Array;
    const uv = geometry.getAttribute('uv').array as Float32Array;
    let top = { y: -Infinity, v: 0 };
    let foot = { y: Infinity, v: 0 };
    for (let i = 0; i < uv.length / 2; i++) {
      const at = { y: position[i * 3 + 1] as number, v: uv[i * 2 + 1] as number };
      if (at.y > top.y) top = at;
      if (at.y < foot.y) foot = at;
    }
    expect(top.v).toBeLessThan(foot.v);
    geometry.dispose();
  });
});

describe('where a sign hangs', () => {
  it('letters the same buildings the same way every time', () => {
    const district = districtOf('inner', 0.4, 'italian');
    const once = signsOn('shop-row', district, 40).signs;
    const again = signsOn('shop-row', district, 40).signs;
    expect(once.length).toBeGreaterThan(0);
    expect(again).toEqual(once);
  });

  it('puts a fascia flat on the wall over the door, inside the frontage', () => {
    const { placed, signs } = signsOn('shop-row', districtOf('inner', 0.4, 'chinese'), 40);
    expect(signs).toHaveLength(placed.length);
    for (const sign of signs) {
      const on = placed.find((one) => sameFront(one, sign)) as BuildingPlacement;
      const facing = on.building.facing;
      expect(sign.tilt).toBe(0);
      expect(sign.outX).toBeCloseTo(Math.cos(facing), 6);
      expect(sign.outY).toBeCloseTo(Math.sin(facing), 6);
      // Proud of the wall that was really built, over head height, and under
      // the roof.
      const front = on.building.front;
      const away = (sign.x - front.x) * Math.cos(facing) + (sign.y - front.y) * Math.sin(facing);
      expect(away).toBeGreaterThanOrEqual(frontReach(on));
      expect(away).toBeLessThan(frontReach(on) + 0.2);
      expect(sign.height - sign.tall / 2).toBeGreaterThanOrEqual(GROUND + 2.1 - 1e-6);
      expect(sign.height + sign.tall / 2).toBeLessThan(wallTop(on));
      expect(Math.abs(acrossOf(on, sign)) + sign.width / 2).toBeLessThanOrEqual(on.building.width / 2);
    }
  });

  it('stands a billboard on the roof, leaning back, at the end the poster left', () => {
    // A poor inner district papers hardest and buys the most hoardings, which
    // is where the two land on one roof often enough to check the rule.
    const district = districtOf('inner', 0, 'none');
    const { placed, signs } = signsOn('parking-garage', district, 300);
    expect(signs.length).toBeGreaterThan(0);
    const posters = postersIn(placed, lookupOf(district));
    let shared = 0;
    for (const sign of signs) {
      expect(sign.tilt).toBeGreaterThan(0.2);
      const on = placed.find((one) => sameFront(one, sign)) as BuildingPlacement;
      // Its foot is the top of the wall it stands on, so nothing floats.
      const foot = sign.height - (Math.cos(sign.tilt) * sign.tall) / 2;
      expect(foot).toBeCloseTo(wallTop(on), 4);
      // A roof that carries both takes them at opposite ends of its frontage.
      const poster = posters.find((one) => sameFront(on, one));
      if (poster === undefined) continue;
      shared++;
      expect(Math.sign(acrossOf(on, sign))).toBe(-Math.sign(acrossOf(on, poster)));
    }
    expect(shared).toBeGreaterThan(2);
  });

  it('advertises on a roof and names a trade over a shopfront', () => {
    const ads = signsOn('warehouse', districtOf('industrial', 0.4), 80).signs;
    for (const sign of ads) expect(sign.design).toBeGreaterThanOrEqual(SHOP_KINDS.length);
    const fascias = signsOn('shop-row', districtOf('inner', 0.4), 40).signs;
    for (const sign of fascias) expect(sign.design).toBeLessThan(SHOP_KINDS.length);
    expect(adDesign(0)).toBe(SHOP_KINDS.length);
    expect(tradeDesign('clinic')).toBe(SHOP_KINDS.indexOf('clinic'));
  });

  it('letters a shop with the trade that is really behind it', () => {
    const district = districtOf('inner', 0.4);
    const placed = placedRow('shop-row', district, 12);
    // The third building of the row holds the gun shop of spec section 16.1.
    const shops = [{ id: 0, kind: 'weapons', building: 2, district: 0 } as Shop];
    const signs = signsIn(placed, lookupOf(district), shopTrades(shops));
    const on = placed[2] as BuildingPlacement;
    const its = signs.find((sign) => sameFront(on, sign)) as Sign;
    expect(its.design).toBe(tradeDesign('weapons'));
    // A storefront the shops never landed on still carries a sign of its own.
    expect(signs).toHaveLength(placed.length);
  });

  it('reads a neighbourhood off the row every one of its signs takes', () => {
    for (const culture of ['chinese', 'irish', 'beach'] as Culture[]) {
      const signs = signsOn('shop-row', districtOf('inner', 0.4, culture), 20).signs;
      expect(signs.length).toBeGreaterThan(0);
      for (const sign of signs) expect(SIGN_CULTURES[sign.culture]).toBe(culture);
    }
  });

  it('carries no sign on a tower or a house, whose walls are not shopfronts', () => {
    expect(signsOn('tower', districtOf('core', 0.6), 20).signs).toEqual([]);
    expect(signsOn('house', districtOf('suburban', 0.4), 20).signs).toEqual([]);
  });

  it('hangs no billboard where nobody drives past one', () => {
    expect(signsOn('mid-rise', districtOf('suburban', 0.4), 40).signs).toEqual([]);
    expect(signsOn('mid-rise', districtOf('wilderness', 0.4), 40).signs).toEqual([]);
    // A dense inner district is where a hoarding is bought, and carries more
    // than an empty one of the same zone.
    const busy = signsOn('mid-rise', districtOf('inner', 0.4, 'none', 1), 120).signs.length;
    const quiet = signsOn('mid-rise', districtOf('inner', 0.4, 'none', 0), 120).signs.length;
    expect(busy).toBeGreaterThan(quiet);
    expect(quiet).toBeGreaterThan(0);
  });
});

describe('the neon after dark', () => {
  it('burns the inner districts harder than the suburbs', () => {
    const inner = lit(signsOn('shop-row', districtOf('inner', 0.4), 120).signs);
    const suburb = lit(signsOn('shop-row', districtOf('suburban', 0.4), 120).signs);
    expect(inner).toBeGreaterThan(suburb);
    expect(suburb).toBeGreaterThan(0);
  });

  it('burns a sign in the colour of its own neighbourhood', () => {
    for (const culture of ['chinese', 'latin'] as Culture[]) {
      const signs = signsOn('shop-row', districtOf('core', 0.4, culture), 60).signs.filter((sign) => sign.neon !== 0);
      expect(signs.length).toBeGreaterThan(0);
      const tube = (CULTURE_LOOKS[cultureRow(culture)] as CultureLook).neon;
      for (const sign of signs) expect(sign.neon).toBe(tube);
    }
  });

  it('flickers a few tubes and only tubes', () => {
    const signs = signsOn('shop-row', districtOf('core', 0.4), 300).signs;
    const failing = signs.filter((sign) => sign.flicker > 0);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.length).toBeLessThan(signs.filter((sign) => sign.neon !== 0).length / 2);
    for (const sign of signs) {
      if (sign.neon === 0) expect(sign.flicker).toBe(0);
      expect(sign.flicker).toBeLessThanOrEqual(1);
    }
    // More than one phase, or the whole street blinks together.
    expect(new Set(failing.map((sign) => sign.flicker)).size).toBeGreaterThan(1);
  });

  it('writes the tube and its phase on every vertex of the board', () => {
    const steady = signGeometry(signAt({ neon: 0xff0000, flicker: 0 }));
    const failing = signGeometry(signAt({ neon: 0xff0000, flicker: 0.5 }));
    const painted = signGeometry(signAt({ neon: 0, flicker: 0 }));
    expect([...(steady.getAttribute('neon').array as Float32Array)].every((v) => v === 1)).toBe(true);
    expect([...(painted.getAttribute('neon').array as Float32Array)].every((v) => v === 0)).toBe(true);
    expect([...(steady.getAttribute('flicker').array as Float32Array)].every((v) => v === 0)).toBe(true);
    expect([...(failing.getAttribute('flicker').array as Float32Array)].every((v) => v === 0.5)).toBe(true);
    for (const geometry of [steady, failing, painted]) geometry.dispose();
  });

  it('fits every pool of lights the scene holds inside its cap', () => {
    // The sun and the sky fill are the other two (spec section 10.5).
    expect(2 + LAMP_LIGHT_CAP + HEADLIGHT_CAP + NEON_LIGHT_CAP).toBeLessThanOrEqual(SCENE_LIGHT_CAP);
  });
});

describe('the light a few neon signs throw', () => {
  it('hands the pool to the neon nearest the player, and takes it back with the chunk', () => {
    const scene = new Scene();
    const scenery = new SignScenery(new EntityFade(400), scene);
    const burning = (): NeonLight[] =>
      scene.children.filter((child): child is NeonLight => child instanceof NeonLight && child.intensity > 0);
    // The pool is made once and never grows: every light is in the scene from
    // the start, dimmed to nothing (spec section 10.5).
    expect(scene.children.filter((child) => child instanceof NeonLight)).toHaveLength(NEON_LIGHT_CAP);
    expect(burning()).toHaveLength(0);

    const near = signAt({ x: 10, y: 0, neon: 0xff2040, width: 4, tall: 1 });
    const board = signAt({ x: 12, y: 0, neon: 0xff2040, tilt: 0.7 });
    const painted = signAt({ x: 14, y: 0, neon: 0 });
    const chunk = scenery.build(cellGrid(chunkBounds(0, 0), 'near'), [near, board, painted]);
    scenery.night = 1;
    scenery.aim(0, 0, 1);
    // The fascia alone: a board leaning back over a roof lights the sky, and a
    // painted one lights nothing at all.
    expect(burning()).toHaveLength(1);
    const light = burning()[0] as NeonLight;
    expect(light.position.x).toBe(near.x);
    expect(light.width).toBe(near.width);
    expect(light.height).toBe(near.tall);

    // By day the pool stands where it is and burns nothing.
    scenery.aim(0, 0, 0);
    expect(burning()).toHaveLength(0);

    // A chunk that has gone takes its neon with it.
    chunk.dispose();
    scenery.aim(0, 0, 1);
    expect(burning()).toHaveLength(0);
    scenery.dispose();
    expect(scene.children.filter((child) => child instanceof NeonLight)).toHaveLength(0);
  });
});

describe('what a chunk of signs costs', () => {
  it('spends one batch on a chunk that holds buildings, and none on one that holds none', () => {
    expect(signDrawCalls(0)).toBe(0);
    expect(signDrawCalls(40)).toBe(1);
  });

  it('builds one quad per board, hung where the sign says', () => {
    const { signs } = signsOn('shop-row', districtOf('inner', 0.4), 20);
    const parts = signParts(signs);
    expect(parts).toHaveLength(signs.length);
    for (let i = 0; i < parts.length; i++) {
      const sign = signs[i] as Sign;
      const at = (parts[i] as { matrix: { elements: number[] } }).matrix.elements;
      expect(at[12]).toBeCloseTo(sign.x, 6);
      expect(at[13]).toBeCloseTo(sign.height, 6);
      expect(at[14]).toBeCloseTo(sign.y, 6);
    }
  });
});

/** How far along its frontage a board hangs, positive one way and negative the other. */
function acrossOf(placed: BuildingPlacement, board: { x: number; y: number }): number {
  const facing = placed.building.facing;
  const front = placed.building.front;
  return -(board.x - front.x) * Math.sin(facing) + (board.y - front.y) * Math.cos(facing);
}

/** Signs of a row that light after dark. */
function lit(signs: readonly Sign[]): number {
  return signs.filter((sign) => sign.neon !== 0).length;
}

/** A made-up board, for the tests that read a geometry rather than a placement. */
function signAt(over: Partial<Sign>): Sign {
  return {
    design: 0,
    culture: 0,
    x: 0,
    y: 0,
    height: 4,
    outX: 1,
    outY: 0,
    tilt: 0,
    width: 4,
    tall: 1,
    neon: 0,
    flicker: 0,
    ...over,
  };
}
