import { describe, expect, it } from 'vitest';
import type { BuildingPlacement } from '../../../src/render/buildings/building-mesh.ts';
import {
  createCanvas,
  drawText,
  fillRect,
  GLYPH_ADVANCE,
  GLYPH_HEIGHT,
  textWidth,
  type PixelCanvas,
} from '../../../src/render/signage/pixel-canvas.ts';
import { POSTER_ART, POSTER_CELL_HEIGHT, POSTER_CELL_WIDTH, posterAtlas } from '../../../src/render/signage/poster-art.ts';
import { posterGeometry, posterParts, postersIn, type Poster } from '../../../src/render/signage/poster-mesh.ts';
import type { BuildingKind } from '../../../src/world/city/buildings.ts';
import type { District } from '../../../src/world/types.ts';
import { districtOf, frontReach, GROUND, lookupOf, placedRow, sameFront, wallTop } from '../../support/building-fixture.ts';

/** Pixels the margin and the band of a poster leave for a line of body text. */
const BODY_ROOM = POSTER_CELL_WIDTH - 16;

/** A row of buildings of one kind, each with its own seed, placed and papered. */
function postersOn(kind: BuildingKind, district: District, count: number): { placed: BuildingPlacement[]; posters: Poster[] } {
  const placed = placedRow(kind, district, count);
  return { placed, posters: postersIn(placed, lookupOf(district)) };
}

/** The colour of one pixel, as `0xrrggbb`. */
function pixelAt(canvas: PixelCanvas, x: number, y: number): number {
  const at = (y * canvas.width + x) * 4;
  return ((canvas.data[at] as number) << 16) | ((canvas.data[at + 1] as number) << 8) | (canvas.data[at + 2] as number);
}

describe('the pixel canvas the posters are printed on', () => {
  it('fills a rectangle and stops at the edge of the picture', () => {
    const canvas = createCanvas(8, 4, 0x000000);
    fillRect(canvas, 6, 2, 10, 10, 0xff8800);
    expect(pixelAt(canvas, 6, 2)).toBe(0xff8800);
    expect(pixelAt(canvas, 7, 3)).toBe(0xff8800);
    expect(pixelAt(canvas, 5, 2)).toBe(0x000000);
    expect(canvas.data).toHaveLength(8 * 4 * 4);
  });

  it('writes a letter inside the box its advance claims, and draws nothing it has no letter for', () => {
    const canvas = createCanvas(GLYPH_ADVANCE * 2, GLYPH_HEIGHT + 2, 0x000000);
    drawText(canvas, 'A', 0, 0, 1, 0xffffff);
    let lit = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (pixelAt(canvas, x, y) === 0x000000) continue;
        lit++;
        expect(x).toBeLessThan(GLYPH_ADVANCE);
        expect(y).toBeLessThan(GLYPH_HEIGHT);
      }
    }
    expect(lit).toBeGreaterThan(0);
    const blank = createCanvas(GLYPH_ADVANCE, GLYPH_HEIGHT, 0x000000);
    drawText(blank, '~', 0, 0, 1, 0xffffff);
    expect([...blank.data].every((byte, i) => (i % 4 === 3 ? byte === 0xff : byte === 0))).toBe(true);
  });
});

describe('the poster atlas', () => {
  it('holds one cell per design, each printed on its own paper', () => {
    const atlas = posterAtlas();
    expect(atlas.width).toBe(POSTER_CELL_WIDTH * POSTER_ART.length);
    expect(atlas.height).toBe(POSTER_CELL_HEIGHT);
    for (let i = 0; i < POSTER_ART.length; i++) {
      expect(pixelAt(atlas, i * POSTER_CELL_WIDTH + 1, 1)).toBe(POSTER_ART[i]?.paper);
    }
  });

  it('sets every line of every poster inside the sheet it is printed on', () => {
    for (const art of POSTER_ART) {
      expect(textWidth(art.headline, 2)).toBeLessThanOrEqual(POSTER_CELL_WIDTH - 12);
      for (const line of [...art.lines, art.from]) expect(textWidth(line, 1)).toBeLessThanOrEqual(BODY_ROOM);
    }
  });

  it('gives each design its own cell of the texture coordinates', () => {
    const cell = 1 / POSTER_ART.length;
    for (let design = 0; design < POSTER_ART.length; design++) {
      const geometry = posterGeometry({ design, x: 0, y: 0, height: 3, outX: 1, outY: 0, tilt: 0, width: 1, tall: 1.4 });
      const uv = geometry.getAttribute('uv').array as Float32Array;
      for (let i = 0; i < uv.length; i += 2) {
        expect(uv[i]).toBeGreaterThanOrEqual(design * cell - 1e-6);
        expect(uv[i]).toBeLessThanOrEqual((design + 1) * cell + 1e-6);
      }
      geometry.dispose();
    }
  });
});

describe('where a poster hangs', () => {
  it('hangs the same posters on the same buildings every time', () => {
    const district = districtOf('inner', 0.2);
    const once = postersOn('shop-row', district, 40).posters;
    const again = postersOn('shop-row', district, 40).posters;
    expect(once.length).toBeGreaterThan(0);
    expect(again).toEqual(once);
  });

  it('faces the board out of the front of the building, clear of its wall', () => {
    const { placed, posters } = postersOn('shop-row', districtOf('inner', 0.2), 40);
    expect(posters.length).toBeGreaterThan(0);
    for (const poster of posters) {
      const building = placed.find((one) => one.building.id >= 0 && sameFront(one, poster)) as BuildingPlacement;
      const facing = building.building.facing;
      expect(poster.outX).toBeCloseTo(Math.cos(facing), 6);
      expect(poster.outY).toBeCloseTo(Math.sin(facing), 6);
      // Proud of the wall that was really built, and off the ground. The wall
      // stands in from the front edge of the lot by its margin, so the lot is
      // not what a board is measured against.
      const front = building.building.front;
      const away = (poster.x - front.x) * Math.cos(facing) + (poster.y - front.y) * Math.sin(facing);
      const wall = frontReach(building);
      expect(away).toBeGreaterThanOrEqual(wall);
      expect(away).toBeLessThan(wall + 0.2);
      expect(poster.height - GROUND).toBeGreaterThan(poster.tall / 2);
      // Inside the frontage: a sheet never hangs off the end of the wall.
      const across = -(poster.x - front.x) * Math.sin(facing) + (poster.y - front.y) * Math.cos(facing);
      expect(Math.abs(across) + poster.width / 2).toBeLessThanOrEqual(building.building.width / 2);
    }
  });

  it('papers a poor district harder than a rich one, and a suburb not at all', () => {
    const poor = postersOn('shop-row', districtOf('inner', 0.05), 120).posters.length;
    const rich = postersOn('shop-row', districtOf('inner', 0.95), 120).posters.length;
    expect(poor).toBeGreaterThan(rich);
    expect(postersOn('shop-row', districtOf('suburban', 0.3), 120).posters).toEqual([]);
    expect(postersOn('shop-row', districtOf('wilderness', 0.3), 120).posters).toEqual([]);
  });

  it('stands a hoarding on the roof, leaning back, and keeps a sheet flat on the wall', () => {
    const boards = postersOn('warehouse', districtOf('industrial', 0.2), 60);
    const sheets = postersOn('house', districtOf('inner', 0.2), 60);
    expect(boards.posters.length).toBeGreaterThan(0);
    expect(sheets.posters.length).toBeGreaterThan(0);
    for (const poster of boards.posters) {
      expect(poster.width).toBeGreaterThan((sheets.posters[0] as Poster).width);
      expect(poster.tilt).toBeGreaterThan(0.2);
      // Its foot is the top of the wall it stands on, so nothing floats.
      const on = boards.placed.find((one) => sameFront(one, poster)) as BuildingPlacement;
      const foot = poster.height - (Math.cos(poster.tilt) * poster.tall) / 2;
      expect(foot).toBeCloseTo(wallTop(on), 4);
    }
    for (const poster of sheets.posters) expect(poster.tilt).toBe(0);
  });

  it('turns the lean into a face that looks up as well as out', () => {
    const { posters } = postersOn('warehouse', districtOf('industrial', 0.2), 60);
    const parts = posterParts(posters);
    for (let i = 0; i < parts.length; i++) {
      const poster = posters[i] as Poster;
      const at = (parts[i] as { matrix: { elements: number[] } }).matrix.elements;
      // The third column is the way the print faces: still out over the street,
      // and now lifted towards the camera.
      expect((at[8] as number) * poster.outX + (at[10] as number) * poster.outY).toBeCloseTo(Math.cos(poster.tilt), 6);
      expect(at[9]).toBeCloseTo(Math.sin(poster.tilt), 6);
    }
  });

  it('builds one quad per board, hung where the poster says', () => {
    const { posters } = postersOn('shop-row', districtOf('inner', 0.2), 40);
    const parts = posterParts(posters);
    expect(parts).toHaveLength(posters.length);
    for (let i = 0; i < parts.length; i++) {
      const poster = posters[i] as Poster;
      const at = (parts[i] as { matrix: { elements: number[] } }).matrix.elements;
      expect(at[12]).toBeCloseTo(poster.x, 6);
      expect(at[13]).toBeCloseTo(poster.height, 6);
      expect(at[14]).toBeCloseTo(poster.y, 6);
    }
  });
});
