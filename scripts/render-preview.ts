/**
 * Take a picture of what the renderer draws, for eyeballing from a session.
 *
 * `world-preview.ts` draws the world description; this draws the game. It needs
 * a real WebGPU device, so it serves the project with Vite, opens the page in a
 * headless Chromium, and asks `src/render/preview.ts` for one frame.
 *
 * The first run starts the preview server of `preview-server.ts` and leaves it
 * running; each run after that asks it for the frame. The server keeps the
 * scene of the last seed, so a second picture of the same seed builds only the
 * chunks round a new place. A source file saved in between is picked up.
 *
 * Usage: node scripts/render-preview.ts [seed] [out.png] [--option=value]
 *   --x, --y         where the player stands, in metres. Default the spawn.
 *   --junction       stand at the N-th junction out from the core instead, and
 *                    say where it is and which roads meet there. `--tiers`
 *                    narrows the count to junctions of that mix, for example
 *                    `--tiers=arterial+street` or `--tiers=alley`.
 *   --distance       how far back the camera sits. Default the game's.
 *   --heading        which way the player faces, in degrees.
 *   --speed          how fast the player moves, in metres per second.
 *   --width,--height the size of the picture.
 *   --hour           the hour of the day to light the frame at, 0 to 24.
 *   --buildings      what a building in the way does (spec section 10.7):
 *                    see-through, pull-back, turn or whole. Default see-through.
 *   --view           the view to draw from (spec section 10.7): top-down,
 *                    third-person or first-person. Default top-down.
 *   --look-at        x,y,height: a place to frame instead of the player, in
 *                    metres, the height over the ground there. The camera keeps
 *                    its pitch, heading and distance; the player stays put.
 *   --look-up        degrees to tilt a chase view up from where it looks, to see
 *                    the sky. Ignored top down.
 *   --quality        the quality tier to draw at (spec section 9.2): full,
 *                    high, medium or low. Default full.
 *   --vehicle        the class of vehicle to stand the player in (spec section
 *                    11.3): compact, saloon, sports, van, truck, bus,
 *                    motorcycle, offroad, buggy, emergency or boat.
 *   --on-foot        stand the player beside the vehicle rather than in it,
 *                    which is how the character is looked at (spec section
 *                    11.5).
 *   --swing          how far through a swing of a melee weapon to hold the
 *                    player, 0 to 1 (spec section 11.6). Needs --on-foot, and
 *                    reads best with --weapon.
 *   --stance         the stance to hold the player in for the picture (spec
 *                    sections 11.2, 11.5): stand, walk, air or swim. Drawn with
 *                    --on-foot.
 *   --damage         the damage state to show the vehicle in (spec section
 *                    11.3): dented, smoking, burning or burnt.
 *   --skid           lay a drift's worth of skid marks into the road behind
 *                    the vehicle (spec section 11.3).
 *   --emergency      put a blaze in the road ahead, with a fire engine at it
 *                    and an ambulance behind the player (spec section 20.3).
 *   --shots          put a shotgun blast and a pistol round in the air, with
 *                    their flash, streaks and impacts (spec section 11.6).
 *   --bodies         lay casualties in the road ahead: two dead, and one each
 *                    falling, rising, crawling, limping and thrown (spec
 *                    section 11.6). With --emergency, medics kneel at one.
 *   --police         lay police on foot in the road ahead: a patrol pair and
 *                    a SWAT officer aiming, one on a beat and one fallen
 *                    (spec section 14).
 *   --contacts       stand the mission contacts of spec section 18 on their
 *                    corners, each under their marker, and take the picture at
 *                    the one nearest the place asked for.
 *   --weapon         the weapon in the player's hands, by id, for example
 *                    `ak-47` (spec section 11.6). Drawn with --on-foot.
 *   --attachments    what is fitted to it and to the pickups, for example
 *                    `suppressor+optic`.
 *   --aim            hold the weapon at the shoulder.
 *   --pickups        lay every weapon of the arsenal in rows ahead of the
 *                    player, to compare the silhouettes.
 *   --hover          the index of the laid pickup to draw grown, as the one
 *                    under the mouse.
 *   --gallery        lay the models of one subject in rows ahead of the player
 *                    and frame them: `vehicles` for the roster of spec section
 *                    11.3, `people` for the looks of 11.1, `props` for the
 *                    goods the counters of 16.1 sell. `--pickups` is the same
 *                    picture of the arsenal.
 *   --shop           stand inside the nearest shop of a trade (spec section
 *                    16.1): weapons, workshop, convenience, clothing, clinic,
 *                    broker, or `any`. The vehicle waits at the kerb.
 *   --tram           stand beside the first tram at the hour of the picture
 *                    (spec section 13.2), and --stop=N at the N-th tram stop.
 *                    Either one overrides --x, --y and --junction.
 *   --bus-stop       stand at the N-th kerb the buses call at (spec section
 *                    20.2), where the post and the queue are. Overrides --x,
 *                    --y and --junction.
 *   --fast           wait for the near ring of chunks only. About half the
 *                    chunk time; the far edge of the view may be missing.
 *   --software       draw on SwiftShader, as CI does, in a browser of its own.
 *   --no-server      draw in a browser of its own, and stop it afterwards.
 *   --stop-server    stop the preview server of this checkout, and draw nothing.
 *
 * The browser comes from `chromium.ts`, and draws on the graphics card where
 * there is one (`preview-host.ts`).
 */
import { writeFileSync } from 'node:fs';
import { seedFromString } from '../src/core/rng.ts';
import { BASE_DISTANCE } from '../src/render/camera.ts';
import type { PreviewRequest } from '../src/render/preview.ts';
import type { Junction } from '../src/world/junctions.ts';
import { askServer, ensureServer, stopServer } from './preview-client.ts';
import type { HostFrame } from './preview-host.ts';
import { encodePng } from './png.ts';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const options = new Map<string, string>(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);

const seedText = positional[0] ?? 'sunset';
const out = positional[1] ?? `render-${seedText}.png`;

function num(name: string, fallback: number): number {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} wants a number, not ${raw}`);
  return value;
}

/**
 * Where a junction stands, for eyeballing how roads meet. The junctions are
 * counted out from the core, so the low numbers are the ones the player sees
 * first, and `--tiers` counts only the junctions where exactly that mix of
 * tiers meets.
 */
async function junctionAt(seed: number, index: number, tiers: string | undefined): Promise<Junction> {
  const { generateWorld } = await import('../src/world/world.ts');
  const { buildRoadGraph } = await import('../src/world/graph.ts');
  const { buildJunctions } = await import('../src/world/junctions.ts');
  const world = generateWorld(seed);
  const junctions = buildJunctions(world.roads, buildRoadGraph(world.roads)).junctions.filter(
    (junction) => tiers === undefined || mixOf(junction) === tiers,
  );
  junctions.sort(
    (a, b) => Math.hypot(a.x - world.core.x, a.y - world.core.y) - Math.hypot(b.x - world.core.x, b.y - world.core.y),
  );
  const found = junctions[index];
  if (found === undefined) throw new Error(`only ${junctions.length} junctions${tiers === undefined ? '' : ` of ${tiers}`}`);
  return found;
}

/** The tiers that meet at a junction, each named once, as `--tiers` names them. */
function mixOf(junction: Junction): string {
  return [...new Set(junction.mouths.map((mouth) => mouth.tier))].sort().join('+');
}

const seed = seedFromString(seedText);
if (options.has('stop-server')) {
  console.log((await stopServer()) ? 'preview server stopped' : 'no preview server was running');
  process.exit(0);
}

const junction = options.has('junction') ? await junctionAt(seed, num('junction', 0), options.get('tiers')) : undefined;
if (junction !== undefined) {
  const mouths = junction.mouths.map((mouth) => `${mouth.tier} cut ${mouth.cut.toFixed(1)} m`).join(', ');
  console.log(`junction ${options.get('junction')} at ${junction.x.toFixed(1)},${junction.y.toFixed(1)}: ${mouths}`);
}

/** Where `--bus-stop=N` stands the player: on the pavement at the N-th bus stop. */
async function busStopPlace(): Promise<{ x: number; y: number } | undefined> {
  if (!options.has('bus-stop')) return undefined;
  const { generateWorld } = await import('../src/world/world.ts');
  const { BusStops } = await import('../src/sim/bus-stops.ts');
  const { AmbientTraffic, trafficRoadsOf } = await import('../src/sim/traffic.ts');
  const world = generateWorld(seed);
  const roads = trafficRoadsOf(world);
  const stops = new BusStops(seed, new AmbientTraffic(seed, roads));
  const want = num('bus-stop', 0);
  if (want >= stops.count) throw new Error(`only ${stops.count} bus stops on this seed`);
  const stop = stops.stopAt(want);
  console.log(`bus stop ${want} of ${stops.count} at ${stop.x.toFixed(1)},${stop.y.toFixed(1)}, ${stop.riders} waiting at most`);
  return stop;
}

/** Where `--tram` or `--stop` stands the player: beside the first tram at the hour, or at a stop. */
async function tramPlace(): Promise<{ x: number; y: number } | undefined> {
  if (!options.has('tram') && !options.has('stop')) return undefined;
  const { generateWorld } = await import('../src/world/world.ts');
  const { tickAtHour } = await import('../src/render/daylight.ts');
  const { AmbientTraffic, trafficRoadsOf } = await import('../src/sim/traffic.ts');
  const { TramLine } = await import('../src/sim/tram.ts');
  const world = generateWorld(seed);
  if (options.has('stop')) {
    const stop = world.tram.stops[num('stop', 0)];
    if (stop === undefined) throw new Error(`only ${world.tram.stops.length} tram stops`);
    return stop;
  }
  const roads = trafficRoadsOf(world);
  const line = new TramLine(seed, roads, world.tram, world.districts, new AmbientTraffic(seed, roads).signals);
  if (line.trams === 0) throw new Error('no tram runs on this seed');
  const pose = { x: 0, y: 0, height: 0, heading: 0, speed: 0 };
  return line.carPose(0, 1, tickAtHour(num('hour', 12)), pose);
}
const tram = (await busStopPlace()) ?? (await tramPlace());

/** The place `--look-at=x,y,height` names, the height 0 when it is left off. */
function lookAtOf(raw: string | undefined): PreviewRequest['lookAt'] {
  if (raw === undefined) return undefined;
  const [x, y, height = 0] = raw.split(',').map(Number);
  if (x === undefined || y === undefined || ![x, y, height].every(Number.isFinite)) {
    throw new Error(`--look-at wants x,y or x,y,height in metres, not ${raw}`);
  }
  return { x, y, height };
}
const lookAt = lookAtOf(options.get('look-at'));

const request: PreviewRequest = {
  seed,
  x: tram?.x ?? num('x', junction?.x ?? 0),
  y: tram?.y ?? num('y', junction?.y ?? 0),
  // Left out, the preview picks it: the game's own distance, or what it takes
  // to hold a gallery.
  ...(options.has('distance') ? { distance: num('distance', BASE_DISTANCE) } : {}),
  heading: (num('heading', 0) * Math.PI) / 180,
  speed: num('speed', 0),
  width: num('width', 960),
  height: num('height', 540),
  hour: num('hour', 12),
  ...(options.has('quality') ? { quality: options.get('quality') as string } : {}),
  ...(options.has('buildings') ? { buildings: options.get('buildings') as string } : {}),
  ...(options.has('view') ? { view: options.get('view') as string } : {}),
  ...(options.has('look-up') ? { lookUp: num('look-up', 0) } : {}),
  ...(lookAt === undefined ? {} : { lookAt }),
  ...(options.has('vehicle') ? { vehicle: options.get('vehicle') as string } : {}),
  ...(options.has('on-foot') ? { onFoot: true } : {}),
  ...(options.has('stance') ? { stance: options.get('stance') as string } : {}),
  ...(options.has('swing') ? { swing: num('swing', 0.4) } : {}),
  ...(options.has('damage') ? { damage: options.get('damage') as string } : {}),
  ...(options.has('skid') ? { skid: true } : {}),
  ...(options.has('emergency') ? { emergency: true } : {}),
  ...(options.has('shots') ? { shots: true } : {}),
  ...(options.has('bodies') ? { bodies: true } : {}),
  ...(options.has('police') ? { police: true } : {}),
  ...(options.has('contacts') ? { contacts: true } : {}),
  ...(options.has('weapon') ? { weapon: options.get('weapon') as string } : {}),
  ...(options.has('attachments') ? { attachments: (options.get('attachments') as string).split('+') } : {}),
  ...(options.has('aim') ? { aim: true } : {}),
  ...(options.has('pickups') ? { pickups: true } : {}),
  ...(options.has('hover') ? { hover: num('hover', 0) } : {}),
  ...(options.has('shop') ? { shop: (options.get('shop') as string) || 'any' } : {}),
  ...(options.has('gallery') ? { gallery: options.get('gallery') as string } : {}),
  ...(options.has('fast') ? { fast: true } : {}),
};

/** The frame, from the preview server, or from a browser of its own when asked for one. */
async function draw(): Promise<HostFrame & { adapter: string }> {
  const software = options.has('software');
  if (!software && !options.has('no-server')) return askServer(await ensureServer(), request);
  const { PreviewHost } = await import('./preview-host.ts');
  const host = await PreviewHost.open({ software });
  try {
    return { ...(await host.render(request)), adapter: host.adapter };
  } finally {
    await host.close();
  }
}

const { result, failures, adapter } = await draw();
const errors = [...failures.thrown, ...failures.logged];
if (errors.length > 0) console.error(`page errors:\n  ${errors.join('\n  ')}`);

const rgb = new Uint8Array(Buffer.from(result.rgb, 'base64'));
writeFileSync(out, encodePng(result.width, result.height, rgb));
console.log(
  `${out}: ${result.width}x${result.height}, seed ${seedText} at ${result.x.toFixed(0)},${result.y.toFixed(0)}` +
    ` at ${request.hour.toFixed(1)}h on ${adapter}` +
    ` — world ${result.kept ? 'kept' : `${result.worldMs.toFixed(0)} ms`}, chunks ${result.chunkMs.toFixed(0)} ms,` +
    ` frame ${result.frameMs.toFixed(0)} ms, dearest chunk ${result.peakDrawCalls} draw calls,` +
    ` ${result.lights} lights, ${result.shadows} shadow cascades, ${result.quality} quality,` +
    ` ${result.traffic} vehicles of traffic, ${result.parked} parked cars, ${result.pedestrians} pedestrians;` +
    ` in view ${result.holds.buildings} buildings, ${result.holds.lamps} lamps, ${result.holds.posters} posters`,
);
// The gallery is read left to right, near row first, so the picture can be
// named part by part without counting the rows back.
if (result.gallery !== undefined) console.log(`gallery: ${result.gallery.join(', ')}`);
