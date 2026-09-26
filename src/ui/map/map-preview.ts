/**
 * The page half of `scripts/map-preview.ts`: draw the map of spec section 12
 * into a canvas and hand the pixels back, so a layout change to it can be
 * looked at rather than guessed at.
 *
 * It is the map alone, on a 2D canvas, so it needs no WebGPU device and no
 * chunks: a world description, `MapArt`, and one `draw` call with the same
 * options the minimap and the full map pass.
 *
 * The marks are the game's own. The places a system owns are found the way
 * `src/places.ts` finds them for a session, from parcels built here rather
 * than in a chunk worker, and marked by `placeMarks` and `DealerMarks` as
 * `src/maps.ts` marks them. The dealers stand where the tick asked for puts
 * them.
 */
import { createSimState } from '../../sim/simulation.ts';
import { TerritoryMap } from '../../sim/crime/territory.ts';
import { findPlaces } from '../../places.ts';
import { buildLayers } from '../../world/chunks.ts';
import { generateWorld } from '../../world/world.ts';
import { buildRoadGraph } from '../../world/roads/graph.ts';
import { buildShops } from '../../world/city/shops.ts';
import { DealerMarks } from '../hud/dealers.ts';
import { MapArt, type MapDrawOptions } from './map-draw.ts';
import { MINIMAP_ICON } from './map-icons.ts';
import { findRoute } from './map-route.ts';
import { MapPois, rotationForHeading, type MapView } from './map.ts';
import { placeMarks } from './place-marks.ts';
import { TerritoryOverlay } from './territory.ts';

/** What the driver asks for. */
export interface MapPreviewRequest {
  seed: number;
  /** The world point at the middle of the picture. */
  x: number;
  y: number;
  /** Metres to the pixel. */
  scale: number;
  /** Which way the player faces, in radians. */
  heading: number;
  /** True to turn the map so the player faces up, as the minimap does. */
  rotate: boolean;
  /** True to draw the round minimap window rather than the full map. */
  minimap: boolean;
  width: number;
  height: number;
  /** A place to mark, or null. */
  waypoint: { x: number; y: number } | null;
  /** True to wash the factions' turf over the land (spec section 17.2). */
  turf: boolean;
  /** The tick the turf and the dealers are read at, since both move over the days. */
  tick: number;
}

/** What comes back: the picture, and what it cost to build. */
export interface MapPreviewResult {
  width: number;
  height: number;
  /** RGB rows, base64. The driver turns them into a PNG. */
  rgb: string;
  worldMs: number;
  /** The parcels and the places on them, which the game builds in a chunk worker. */
  placesMs: number;
  artMs: number;
  drawMs: number;
  /** How many places are marked on it. */
  pois: number;
}

export async function renderMapPreview(request: MapPreviewRequest): Promise<MapPreviewResult> {
  const t0 = performance.now();
  const world = generateWorld(request.seed);
  const worldMs = performance.now() - t0;

  const t1 = performance.now();
  const layers = buildLayers(world);
  const places = findPlaces(request.seed, world, {
    stations: layers.parcels.stations.map((station) => ({ x: station.x, y: station.y })),
    metro: layers.parcels.metro,
    shops: buildShops(world, layers.buildings),
    bays: undefined,
  });
  const pois = new MapPois(world);
  pois.extra = placeMarks(places);
  // A dealer stands on the pavement, and the map reads no height.
  new DealerMarks(request.seed, places.dealers, pois).update(request.tick, { heightAt: () => 0 });
  const placesMs = performance.now() - t1;

  const t2 = performance.now();
  const art = new MapArt(world, pois);
  const artMs = performance.now() - t2;

  const canvas = document.createElement('canvas');
  canvas.width = request.width;
  canvas.height = request.height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#12070f';
  ctx.fillRect(0, 0, request.width, request.height);
  if (request.minimap) {
    ctx.beginPath();
    ctx.arc(request.width / 2, request.height / 2, Math.min(request.width, request.height) / 2, 0, Math.PI * 2);
    ctx.clip();
  }

  // The turf of spec section 17.2 is a function of the seed and the tick, so a
  // fresh record at the tick asked for is the whole of what the overlay needs.
  let overlay: MapDrawOptions['overlay'];
  if (request.turf) {
    const state = createSimState(request.seed, undefined, request.tick);
    overlay = new TerritoryOverlay(new TerritoryMap(world), state).draw;
  }

  const view: MapView = {
    x: request.x,
    y: request.y,
    metresPerPixel: request.scale,
    rotation: request.rotate ? rotationForHeading(request.heading) : 0,
  };
  // The route the game draws to a waypoint, found the way the game finds it.
  const route = request.waypoint
    ? findRoute(buildRoadGraph(world.roads), { x: request.x, y: request.y }, request.waypoint)
    : null;
  const t3 = performance.now();
  art.draw(ctx, view, request.width, request.height, {
    player: { x: request.x, y: request.y, heading: request.heading },
    waypoint: request.waypoint,
    route,
    iconSize: request.minimap ? MINIMAP_ICON : 18,
    labels: !request.minimap,
    scaleBar: !request.minimap,
    ...(overlay ? { overlay } : {}),
  });
  const drawMs = performance.now() - t3;

  const image = ctx.getImageData(0, 0, request.width, request.height);
  const rgb = new Uint8Array(request.width * request.height * 3);
  for (let i = 0, o = 0; i < image.data.length; i += 4, o += 3) {
    rgb[o] = image.data[i]!;
    rgb[o + 1] = image.data[i + 1]!;
    rgb[o + 2] = image.data[i + 2]!;
  }
  let binary = '';
  for (const byte of rgb) binary += String.fromCharCode(byte);
  return {
    width: request.width,
    height: request.height,
    rgb: btoa(binary),
    worldMs,
    placesMs,
    artMs,
    drawMs,
    pois: pois.fixed.length + pois.extra.length,
  };
}
