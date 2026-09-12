import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectPois,
  fitWorldView,
  MapPois,
  POI_STYLES,
  project,
  RoadSegmentIndex,
  rotationForHeading,
  SEGMENT_STRIDE,
  tierPen,
  unproject,
  viewBounds,
  viewRadius,
  zoomBy,
  ZOOM_STEPS,
  type MapView,
  type PoiType,
} from '../src/ui/map.ts';
import { heatLine, HEAT_STARS } from '../src/ui/hud.ts';
import type { RoadCurve, RoadTier, WorldDescription } from '../src/world/types.ts';
import { worldsFor } from './world-pool.ts';

/** A hand-built curve, so the index can be checked without generating a world. */
function curve(id: number, tier: RoadTier, coords: readonly [number, number][]): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [] };
}

const VIEW: MapView = { x: 120, y: -40, metresPerPixel: 2, rotation: 0.7 };

describe('POI icon table (spec section 12)', () => {
  const types = Object.keys(POI_STYLES) as PoiType[];

  it('gives every type an icon of its own', () => {
    // The spec asks for distinct, recognisable icons per POI type. A shape no
    // other type uses is what makes a minimap readable at icon size, and a
    // colour no other type uses is what makes it readable at a glance.
    const shapes = new Map<string, PoiType>();
    const colours = new Map<string, PoiType>();
    let complaint = '';
    for (const type of types) {
      const style = POI_STYLES[type];
      const shapeOwner = shapes.get(style.shape);
      if (shapeOwner !== undefined && complaint === '') {
        complaint = `${type} and ${shapeOwner} are both drawn as a ${style.shape}`;
      }
      shapes.set(style.shape, type);
      const colourOwner = colours.get(style.colour);
      if (colourOwner !== undefined && complaint === '') {
        complaint = `${type} and ${colourOwner} are both ${style.colour}`;
      }
      colours.set(style.colour, type);
      if (style.label === '' && complaint === '') complaint = `${type} has no label`;
    }
    expect(complaint).toBe('');
  });

  it('always draws the player and their waypoint, however far the map is pulled back', () => {
    const furthest = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;
    expect(POI_STYLES.player.maxScale).toBeGreaterThanOrEqual(furthest);
    expect(POI_STYLES.waypoint.maxScale).toBeGreaterThanOrEqual(furthest);
    expect(POI_STYLES.objective.maxScale).toBeGreaterThanOrEqual(furthest);
  });
});

describe('whole-world view', () => {
  it('holds every corner of the world on the canvas', () => {
    const size = 6000;
    const view = fitWorldView(size, 320, 240);
    for (const x of [-size / 2, size / 2]) {
      for (const y of [-size / 2, size / 2]) {
        const p = project(view, 320, 240, x, y);
        expect(p.x).toBeGreaterThanOrEqual(-0.001);
        expect(p.x).toBeLessThanOrEqual(320.001);
        expect(p.y).toBeGreaterThanOrEqual(-0.001);
        expect(p.y).toBeLessThanOrEqual(240.001);
      }
    }
  });

  it('fills the smaller side of the canvas, north up', () => {
    const view = fitWorldView(6000, 300, 300);
    expect(view.metresPerPixel).toBeCloseTo(20, 9);
    expect(view.rotation).toBe(0);
    expect(project(view, 300, 300, 0, -3000).y).toBeCloseTo(0, 6);
  });
});

describe('map projection', () => {
  it('puts the view centre at the middle of the canvas', () => {
    const p = project(VIEW, 300, 200, VIEW.x, VIEW.y);
    expect(p.x).toBeCloseTo(150, 9);
    expect(p.y).toBeCloseTo(100, 9);
  });

  it('unprojects back onto the point it projected', () => {
    for (const [x, y] of [
      [0, 0],
      [500, -300],
      [-1200, 900],
    ] as const) {
      const p = project(VIEW, 300, 200, x, y);
      const back = unproject(VIEW, 300, 200, p.x, p.y);
      expect(back.x).toBeCloseTo(x, 6);
      expect(back.y).toBeCloseTo(y, 6);
    }
  });

  it('scales by metres to the pixel', () => {
    const north: MapView = { x: 0, y: 0, metresPerPixel: 4, rotation: 0 };
    const p = project(north, 200, 200, 40, 80);
    expect(p.x).toBeCloseTo(110, 9);
    expect(p.y).toBeCloseTo(120, 9);
  });

  it('puts north up on a fixed-north map', () => {
    // The player walks toward -y, which is up the screen, so a point north of
    // the centre lands above it.
    const north: MapView = { x: 0, y: 0, metresPerPixel: 1, rotation: 0 };
    expect(project(north, 100, 100, 0, -30).y).toBeLessThan(50);
  });

  it('turns a rotating map so the player faces up the screen', () => {
    for (const heading of [0, 0.9, -2.2, Math.PI]) {
      const view: MapView = { x: 0, y: 0, metresPerPixel: 1, rotation: rotationForHeading(heading) };
      // Ten metres ahead of the player, whichever way they face.
      const ahead = project(view, 100, 100, Math.cos(heading) * 10, Math.sin(heading) * 10);
      expect(ahead.x, `heading ${heading}`).toBeCloseTo(50, 6);
      expect(ahead.y, `heading ${heading}`).toBeCloseTo(40, 6);
    }
  });

  it('bounds the canvas by its furthest corner, whatever the rotation', () => {
    const radius = viewRadius(VIEW, 300, 200);
    expect(radius).toBeCloseTo((Math.hypot(300, 200) / 2) * 2, 9);
    // Nothing on the canvas can fall outside the box the radius draws.
    let complaint = '';
    for (let i = 0; i <= 24 && complaint === ''; i++) {
      const view: MapView = { ...VIEW, rotation: (i / 24) * Math.PI * 2 };
      const box = viewBounds(view, 300, 200);
      for (const [px, py] of [
        [0, 0],
        [300, 0],
        [0, 200],
        [300, 200],
      ] as const) {
        const w = unproject(view, 300, 200, px, py);
        if (w.x < box.minX || w.x > box.maxX || w.y < box.minY || w.y > box.maxY) {
          complaint = `corner ${px},${py} at rotation ${view.rotation} falls outside the bounds`;
        }
      }
    }
    expect(complaint).toBe('');
  });
});

describe('zoom steps', () => {
  it('steps through the table and stops at its ends', () => {
    const closest = ZOOM_STEPS[0] as number;
    const furthest = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;
    expect(zoomBy(closest, -1)).toBe(closest);
    expect(zoomBy(furthest, 1)).toBe(furthest);
    expect(zoomBy(closest, 1)).toBe(ZOOM_STEPS[1]);
    expect(zoomBy(furthest, -1)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 2]);
  });

  it('lands on the nearest step from a scale that is not one', () => {
    expect(zoomBy(3.9, 0)).toBe(4);
    expect(zoomBy(3.9, 1)).toBe(8);
  });

  it('rises from close to far', () => {
    let complaint = '';
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      if ((ZOOM_STEPS[i] as number) <= (ZOOM_STEPS[i - 1] as number) && complaint === '') {
        complaint = `step ${i} does not pull further back than the one before it`;
      }
    }
    expect(complaint).toBe('');
  });
});

describe('road pens', () => {
  const tiers: RoadTier[] = ['highway', 'arterial', 'street', 'alley', 'dirt'];

  it('never strokes a road thinner than a hairline while it is drawn at all', () => {
    let complaint = '';
    for (const tier of tiers) {
      for (const scale of ZOOM_STEPS) {
        const pen = tierPen(tier, scale);
        if (pen !== 0 && pen < 0.9 && complaint === '') complaint = `${tier} at ${scale} m/px is ${pen} px`;
      }
    }
    expect(complaint).toBe('');
  });

  it('keeps a highway on the map at every zoom, and drops an alley from the furthest', () => {
    const furthest = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;
    expect(tierPen('highway', furthest)).toBeGreaterThan(0);
    expect(tierPen('alley', furthest)).toBe(0);
    expect(tierPen('alley', 1)).toBeGreaterThan(0);
  });
});

describe('road segment index', () => {
  const roads = [
    curve(0, 'street', [
      [-400, 0],
      [0, 0],
      [400, 0],
    ]),
    curve(1, 'highway', [
      [0, -400],
      [0, 400],
    ]),
  ];
  const index = new RoadSegmentIndex(roads, 2000, 200);

  it('answers the segments a window holds and nothing outside it', () => {
    const keys = index.segmentsIn({ minX: 250, minY: -10, maxX: 350, maxY: 10 });
    const found = Array.from(keys, (key) => [Math.floor(key / SEGMENT_STRIDE), key % SEGMENT_STRIDE]);
    // The second half of the street, and nothing else: the first half and the
    // highway both end at the origin, two cells west of this window. The index
    // answers by cell, so it may over-answer a segment whose cell the window
    // clips; what it may never do is leave out one the window holds.
    expect(found).toEqual([[0, 1]]);
  });

  it('answers ascending and without repeats, whatever cells a window spans', () => {
    const keys = index.segmentsIn({ minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 });
    let complaint = '';
    for (let i = 1; i < keys.length; i++) {
      if ((keys[i] as number) <= (keys[i - 1] as number) && complaint === '') {
        complaint = `key ${i} is ${keys[i]}, after ${keys[i - 1]}`;
      }
    }
    expect(complaint).toBe('');
    // Every segment of both curves, once each.
    expect(keys.length).toBe(3);
  });

  it('finds a segment from any of the cells it crosses', () => {
    // One long segment laid across many cells is filed in all of them, so a
    // window over the middle of it still answers with it.
    const long = [
      curve(0, 'highway', [
        [-900, -900],
        [900, 900],
      ]),
    ];
    const wide = new RoadSegmentIndex(long, 2000, 200);
    expect(wide.segmentsIn({ minX: -10, minY: -10, maxX: 10, maxY: 10 }).length).toBe(1);
  });
});

describe('heat line (spec section 14)', () => {
  it('draws one star a whole point and never more than the table allows', () => {
    expect(heatLine(0.4)).toContain('☆');
    expect(heatLine(1)).toContain('★');
    expect((heatLine(3.2).match(/★/g) ?? []).length).toBe(3);
    expect((heatLine(99).match(/★/g) ?? []).length).toBe(HEAT_STARS);
  });
});

describe('places the world carries (spec section 12)', () => {
  let world: WorldDescription;

  beforeAll(async () => {
    [world] = (await worldsFor([1])) as [WorldDescription];
  });

  it('marks the harbour, every tram stop and every pier', () => {
    const pois = collectPois(world);
    const count = (type: PoiType): number => pois.filter((p) => p.type === type).length;
    expect(count('harbour')).toBe(1);
    expect(count('tram-stop')).toBe(world.tram.stops.length);
    expect(count('pier')).toBe(world.beaches.filter((b) => b.pier !== undefined).length);
    expect(count('car-park')).toBe(world.beaches.reduce((n, b) => n + b.carParks.length, 0));
  });

  it('puts every mark on the map', () => {
    const half = world.size / 2;
    let complaint = '';
    for (const poi of collectPois(world)) {
      if (Math.abs(poi.x) > half || Math.abs(poi.y) > half) {
        complaint = `a ${poi.type} stands at ${poi.x.toFixed(0)},${poi.y.toFixed(0)}, off a ${world.size} m map`;
        break;
      }
    }
    expect(complaint).toBe('');
  });

  it('answers the same places for the same seed', () => {
    expect(collectPois(world)).toEqual(collectPois(world));
  });

  it('shows a system its own places through the extra slot', () => {
    const pois = new MapPois(world);
    const box = { minX: -half(world), minY: -half(world), maxX: half(world), maxY: half(world) };
    const before = pois.visible(box, 1).length;
    pois.extra = [{ type: 'safehouse', x: 0, y: 0, name: 'Home' }];
    const after = pois.visible(box, 1);
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]?.name).toBe('Home');
  });

  it('leaves the small places off a whole-world view', () => {
    const pois = new MapPois(world);
    const box = { minX: -half(world), minY: -half(world), maxX: half(world), maxY: half(world) };
    const furthest = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;
    const far = pois.visible(box, furthest);
    // The harbour is a landmark and stays on a whole-world view; a beach car
    // park is a place you park, and is not.
    expect(far.some((p) => p.type === 'harbour')).toBe(true);
    expect(far.some((p) => p.type === 'car-park')).toBe(false);
    expect(pois.visible(box, 1).some((p) => p.type === 'car-park')).toBe(true);
  });
});

function half(world: WorldDescription): number {
  return world.size / 2;
}
