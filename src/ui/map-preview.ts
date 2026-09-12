/**
 * The page half of `scripts/map-preview.ts`: draw the map of spec section 12
 * into a canvas and hand the pixels back, so a layout change to it can be
 * looked at rather than guessed at.
 *
 * It is the map alone, on a 2D canvas, so it needs no WebGPU device and no
 * chunks: a world description, `MapArt`, and one `draw` call with the same
 * options the minimap and the full map pass.
 */
import { generateWorld } from '../world/world.ts';
import { MapArt } from './map-draw.ts';
import { MapPois, rotationForHeading, type MapView } from './map.ts';

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
}

/** What comes back: the picture, and what it cost to build. */
export interface MapPreviewResult {
  width: number;
  height: number;
  /** RGB rows, base64. The driver turns them into a PNG. */
  rgb: string;
  worldMs: number;
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
  const art = new MapArt(world, new MapPois(world));
  const artMs = performance.now() - t1;

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

  const view: MapView = {
    x: request.x,
    y: request.y,
    metresPerPixel: request.scale,
    rotation: request.rotate ? rotationForHeading(request.heading) : 0,
  };
  const t2 = performance.now();
  art.draw(ctx, view, request.width, request.height, {
    player: { x: request.x, y: request.y, heading: request.heading },
    waypoint: request.waypoint,
    iconSize: request.minimap ? 11 : 16,
    labels: !request.minimap,
  });
  const drawMs = performance.now() - t2;

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
    artMs,
    drawMs,
    pois: art.pois.fixed.length,
  };
}
