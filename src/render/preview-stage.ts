/**
 * What the preview keeps between two pictures in one page: the renderer, and
 * for the last seed and tier the world, the scene with its chunks, the views
 * of the traffic, the trams, the crowd, the animals and the parked cars, the
 * camera and the post chain.
 *
 * Almost every picture a session asks for is of the seed it asked for last,
 * from another place, hour or angle. Building the world and its chunks costs
 * several times what drawing the frame does. Drawing a frame costs 20 ms once
 * its shaders are compiled, and a view or a post chain made again compiles
 * them again: about 700 ms of a frame of 800. So all of it is kept for the next request
 * of the same seed and tier, and only the chunks round a new place are built.
 * Everything kept is either read-only after it is built or set again by every
 * request, so a kept scene takes the same picture a new one does.
 *
 * The renderer is made before the scene, so the chunks upload into it as they
 * land (`batch.ts`). A scene built before its renderer keeps every array until
 * the first draw.
 */
import { RenderTarget, SRGBColorSpace, UnsignedByteType } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { DEFAULT_APPEARANCE } from '../sim/character.ts';
import { BusStops } from '../sim/bus-stops.ts';
import { ParkedCars } from '../sim/parked.ts';
import { AmbientPedestrians, crowdDistrictsOf } from '../sim/pedestrians.ts';
import { AmbientTraffic, trafficRoadsOf } from '../sim/traffic.ts';
import { TramLine } from '../sim/tram.ts';
import { AmbientWildlife } from '../sim/wildlife.ts';
import type { WorldDescription } from '../world/types.ts';
import { generateWorld } from '../world/world.ts';
import { FollowCamera } from './camera.ts';
import { ParkedView } from './parked.ts';
import { CasualtyView } from './casualties.ts';
import { ContactMarkers } from './markers.ts';
import { OfficerGunView } from './officer-guns.ts';
import { BusStopView } from './bus-stops.ts';
import { PedestrianView } from './pedestrians.ts';
import { PostChain } from './post.ts';
import type { QualityTier } from './quality.ts';
import { createOffscreenRenderer, resizeOffscreenRenderer } from './renderer.ts';
import { TrafficView } from './traffic.ts';
import { TramView } from './tram.ts';
import { TramSignView } from './tram-signs.ts';
import { TramStopView } from './tram-stops.ts';
import { WildlifeView } from './wildlife.ts';
import { WorldScene } from './world-scene.ts';

/** Mission contacts a preview draws markers over at once, which is every one a world has. */
const CONTACT_CAP = 128;

/** The scene of one seed at one tier, and what is drawn through it. */
export interface PreviewStage {
  renderer: WebGPURenderer;
  world: WorldDescription;
  scene: WorldScene;
  /** Milliseconds generating the world took, 0 when the world was kept. */
  worldMs: number;
  /** True when the scene was kept from an earlier request. */
  kept: boolean;
}

/** The camera, the post chain and the target a frame of one size is drawn through. */
export interface PreviewView {
  camera: FollowCamera;
  post: PostChain;
  target: RenderTarget;
}

/**
 * What moves through the scene, drawn round the player. Each view writes all
 * it draws on every update, so a kept one draws what a new one would.
 */
export interface PreviewPeople {
  traffic: TrafficView;
  trams: TramView;
  tramStops: TramStopView;
  tramSigns: TramSignView;
  /** The posts and the shelters at the kerbs the buses call at (spec section 20.2). */
  busStops: BusStopView;
  crowd: PedestrianView;
  casualties: CasualtyView;
  /** The guns in the hands of the police on foot who aim. */
  guns: OfficerGunView;
  /** The markers over the mission contacts `--contacts` stands (spec section 18). */
  markers: ContactMarkers;
  wildlife: WildlifeView;
  /** Undefined until the chunk workers have laid out the bays. */
  parked?: ParkedView;
}

interface Held {
  seed: number;
  tier: QualityTier;
  world: WorldDescription;
  scene: WorldScene;
  view?: PreviewView & { width: number; height: number };
  people?: PreviewPeople;
}

let renderer: WebGPURenderer | undefined;
let size = { width: 0, height: 0 };
let held: Held | undefined;

/** The renderer at this size, and the scene of this seed and tier, built only if the last request had another. */
export async function stageFor(seed: number, tier: QualityTier, width: number, height: number): Promise<PreviewStage> {
  if (renderer === undefined) {
    renderer = await createOffscreenRenderer(width, height);
  } else if (size.width !== width || size.height !== height) {
    resizeOffscreenRenderer(renderer, width, height);
  }
  size = { width, height };

  if (held !== undefined && held.seed === seed && held.tier.name === tier.name) {
    return { renderer, world: held.world, scene: held.scene, worldMs: 0, kept: true };
  }
  dropHeld();

  const t0 = performance.now();
  const world = generateWorld(seed);
  const worldMs = performance.now() - t0;
  const scene = new WorldScene(world, DEFAULT_APPEARANCE);
  // The tier is set before anything is built, so the chunks the picture holds
  // are the ones that tier asks for and are thinned as it asks.
  scene.quality = tier;
  held = { seed, tier, world, scene };
  return { renderer, world, scene, worldMs, kept: false };
}

/**
 * The views of what moves through the stage, in its scene. Call once the
 * scene has settled: the parked cars stand in bays the chunk workers lay out.
 */
export function peopleFor(): PreviewPeople {
  if (held === undefined) throw new Error('peopleFor before stageFor');
  const { seed, world, scene } = held;
  if (held.people === undefined) {
    // The traffic of spec section 13.1, the trams of 13.2 on the traffic's own
    // lights, the crowd on the pavements and at the tram and bus stops, and
    // the animals of 20.4, which keep their own hours.
    const roads = trafficRoadsOf(world);
    const ambient = new AmbientTraffic(seed, roads);
    const line = new TramLine(seed, roads, world.tram, world.districts, ambient.signals);
    const districtAt = crowdDistrictsOf(world);
    const walkers = new AmbientPedestrians(seed, roads, districtAt);
    const stops = new BusStops(seed, ambient, districtAt);
    held.people = {
      traffic: new TrafficView(ambient),
      trams: new TramView(line),
      tramStops: new TramStopView(line),
      tramSigns: new TramSignView(line),
      busStops: new BusStopView(stops),
      crowd: new PedestrianView(walkers, line, stops),
      casualties: new CasualtyView(walkers),
      guns: new OfficerGunView(),
      markers: new ContactMarkers(CONTACT_CAP),
      wildlife: new WildlifeView(
        new AmbientWildlife(seed, { roads, beaches: world.beaches, seaLevel: world.water.seaLevel, districtAt }),
      ),
    };
    const { traffic, trams, tramStops, tramSigns, busStops, crowd, casualties, guns, markers, wildlife } = held.people;
    scene.scene.add(traffic.group, trams.group, tramStops.group, tramSigns.group, busStops.group, crowd.group, casualties.group, guns.group, markers.group, wildlife.group);
  }
  if (held.people.parked === undefined && scene.bays !== undefined) {
    held.people.parked = new ParkedView(new ParkedCars(seed, scene.bays));
    scene.scene.add(held.people.parked.group);
  }
  return held.people;
}

/**
 * The camera and the post chain of the stage at this size, snapped so the next
 * update puts the camera straight on its target as a new camera would be.
 * Call after {@link stageFor}.
 */
export function viewFor(width: number, height: number): PreviewView {
  if (renderer === undefined || held === undefined) throw new Error('viewFor before stageFor');
  const kept = held.view;
  if (kept !== undefined && kept.width === width && kept.height === height) {
    kept.camera.snap();
    return kept;
  }
  dropView(held);
  const camera = new FollowCamera(width / height);
  const target = new RenderTarget(width, height, { type: UnsignedByteType, colorSpace: SRGBColorSpace });
  // Not `setRenderTarget`: a target set as the output of the frame is what the
  // tone mapping and the colour space conversion are written into.
  renderer.setOutputRenderTarget(target);
  // The effects of spec section 10.6 are part of what the game draws, so the
  // picture is taken through them. The chain tone maps and encodes the frame
  // itself, which is what the output target is written with.
  const post = new PostChain(renderer, held.scene.scene, camera.camera, held.tier.post, held.seed);
  held.view = { camera, post, target, width, height };
  return held.view;
}

function dropView(from: Held): void {
  from.view?.post.dispose();
  from.view?.target.dispose();
  from.view = undefined;
}

/** Let go of the scene of the last seed, so the next request builds it again. The renderer is kept. */
export function forgetStage(): void {
  dropHeld();
}

function dropHeld(): void {
  if (held === undefined) return;
  dropView(held);
  const people = held.people;
  if (people !== undefined) {
    for (const view of [people.traffic, people.trams, people.tramStops, people.tramSigns, people.busStops, people.crowd, people.casualties, people.guns, people.wildlife, people.parked]) {
      if (view === undefined) continue;
      held.scene.scene.remove(view.group);
      view.dispose();
    }
    held.scene.scene.remove(people.markers.group);
    people.markers.dispose();
  }
  held.scene.dispose();
  held = undefined;
}

