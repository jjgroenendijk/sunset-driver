/**
 * Frame timing of the game's scene, for finding what a frame spends.
 *
 * `scripts/render-profile.ts` loads this in a browser with a real GPU. It builds
 * the scene and the post chain the game builds, and settles the chunks around
 * the nearest road to the origin. Then it draws frames: first standing still,
 * then driving in a straight line, so the streaming runs as it does in play.
 * Each frame is timed on the main thread, and again once the GPU has finished
 * the work it was handed; `renderer.info` says how many draws that work was.
 *
 * The switches each take one part of the frame away. The difference between a
 * run with a switch and a run without it is what that part costs.
 */
import { Mesh, type Material } from 'three';
import { Lighting } from 'three/webgpu';
import { DEFAULT_APPEARANCE } from '../sim/character.ts';
import { nearestRoadPlace } from '../world/surface.ts';
import { namedWeather } from '../sim/weather.ts';
import { generateWorld } from '../world/world.ts';
import { FollowCamera } from './camera.ts';
import { PassTimer, type PassTimes } from './gpu-passes.ts';
import { tickAtHour } from './daylight.ts';
import { PostChain } from './post.ts';
import { geometryBytes, gpuMemory, gpuPeak, installGpuLedger, type GpuMemory } from './memory.ts';
import { FULL_TIER, QUALITY_TIERS } from './quality.ts';
import { createRenderer, disposeRenderer } from './renderer.ts';
import { warmPasses } from './warm.ts';
import { WorldScene } from './world-scene.ts';

/** What to draw, for how long, and what to leave out. */
export interface ProfileRequest {
  seed: number;
  width: number;
  height: number;
  hour: number;
  /** The quality tier to draw at, by name. Left out, full quality. */
  quality?: string;
  /** Where to stand, in metres. The nearest road to it is what the drive starts on. */
  x: number;
  y: number;
  /** Frames drawn standing still, then frames drawn driving. */
  still: number;
  drive: number;
  /** Metres per second the drive goes at. */
  speed: number;
  noWater?: boolean;
  noShadows?: boolean;
  noClustered?: boolean;
  noPost?: boolean;
  /** Take the street lamps' projector lights out of the scene. */
  noLamps?: boolean;
  /** Kinds of batch that cast no shadow: road, facade, block, plant, lamp. */
  noCast?: string[];
  /**
   * Quality changes during the drive, as `frame:tier` pairs: at each drive
   * frame named, the tier is applied the way the game applies one. This is how
   * a tier change is timed rather than guessed at: the frames around it say
   * whether it compiled anything.
   */
  tierAt?: string[];
  /** Wait for `window.startDrive()` before the drive, so a profiler can be started on it alone. */
  gate?: boolean;
  /** Count what the GPU and the scene's geometry hold (`memory.ts`). */
  memory?: boolean;
  /** Time every pass of every frame on the GPU (`gpu-passes.ts`). */
  passes?: boolean;
  /** `clear`, `rain`, `fog`, `storm`, or `seed` for the seed's own. Left out, clear. */
  weather?: string;
  /** Return the WGSL of every program the frames built, to read what a shader does. */
  shaders?: boolean;
}

/** One frame, timed. */
export interface FrameSample {
  /** Milliseconds of the scene update on the main thread. */
  updateMs: number;
  /** Milliseconds the render held the main thread. */
  cpuMs: number;
  /** Milliseconds from the start of the frame until the GPU finished it. */
  totalMs: number;
  draws: number;
  triangles: number;
  /** Render pipelines the renderer holds after the frame; a rise is a compile. */
  pipelines: number;
  /** Shader node builds the renderer holds after the frame; a rise is a build. */
  builds: number;
  /** Chunks asked for and not yet in the scene after the frame. */
  streaming: number;
  /** Milliseconds of GPU time by pass, when the passes are timed. */
  passes?: PassTimes;
}

/** What the batches of one kind hold, over every chunk in the scene. */
export interface BatchKind {
  batches: number;
  parts: number;
  vertices: number;
}

/** What the frame held, standing still and at the most over the drive. */
export interface MemorySample {
  /** What the GPU holds once the still frames are drawn. */
  settled: GpuMemory;
  /** The most the GPU held over the drive. */
  drivePeak: number;
  /** Bytes of typed arrays the scene's geometry holds in the page, settled. */
  geometry: number;
}

export interface ProfileResult {
  /** Whether the adapter could time the passes; false leaves `passes` out of every frame. */
  timed: boolean;
  still: FrameSample[];
  drive: FrameSample[];
  kinds: Record<string, BatchKind>;
  memory?: MemorySample;
  /** The WGSL of every program the renderer built, when asked for. */
  shaders?: BuiltShaders;
}

/** The WGSL of every stage the renderer compiled, as three.js generated it. */
export interface BuiltShaders {
  vertex: string[];
  fragment: string[];
}

/** The renderer's caches, which say when a frame compiled or built something. */
interface RendererCaches {
  _pipelines: {
    caches: Map<string, unknown>;
    /** Each stage the renderer compiled, keyed by its WGSL. */
    programs: { vertex: Map<string, unknown>; fragment: Map<string, unknown> };
  };
  _nodes: { nodeBuilderCache: Map<string, unknown> };
}

/** The materials the sceneries own, which say what kind of batch a mesh is. */
interface SceneOwners {
  buildings: { materials: Record<string, unknown> };
  vegetation: { material: Material };
  lamps: { materials: { lamp: Material } };
  scenery: { surfaces: Record<string, Material> };
  /** The water sheet, which `look` shows or hides every frame. */
  water: { shown: boolean };
  /** The sun's shadow cascades, built on the first frame that draws them. */
  sky: { cascades: { lights: { name: string }[] } };
}

export async function runProfile(request: ProfileRequest): Promise<ProfileResult> {
  const tier = QUALITY_TIERS.find((entry) => entry.name === request.quality) ?? FULL_TIER;
  if (request.memory === true) installGpuLedger();
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const renderer = await createRenderer(canvas, request.passes === true);
  if (request.noClustered === true) renderer.lighting = new Lighting();
  if (request.noShadows === true) renderer.shadowMap.enabled = false;
  renderer.setSize(request.width, request.height, false);
  renderer.info.autoReset = false;
  const caches = renderer as unknown as RendererCaches;

  const world = generateWorld(request.seed);
  const scene = new WorldScene(world, DEFAULT_APPEARANCE);
  scene.quality = tier;
  const tick = tickAtHour(request.hour);
  const weather = namedWeather(request.weather);
  scene.fixedWeather = weather;
  scene.time = tick;
  const start = nearestRoadPlace(world, request.x, request.y) ?? { x: request.x, y: request.y, heading: 0 };
  await scene.settle(start.x, start.y);
  // The sheet is shown or hidden every frame by where the camera stands, so
  // `--no-water` holds it out through the surface itself rather than writing
  // `visible`, which the next frame would write back.
  if (request.noWater === true) (scene as unknown as SceneOwners).water.shown = false;
  scene.scene.traverse((object) => {
    if (request.noLamps === true && (object as { isSpotLight?: boolean }).isSpotLight === true) object.visible = false;
  });

  const camera = new FollowCamera(request.width / request.height);
  const post = new PostChain(renderer, scene.scene, camera.camera, tier.post, scene.world.seed, scene.cutaway);
  post.fixedWeather = weather;
  post.regrade();
  post.time = tick;
  await post.ready();
  const device = (renderer.backend as unknown as { device: GPUDevice }).device;
  // The same warm-up the game runs behind its loading screen (`warm.ts`), so
  // the frames timed here are the frames a session draws rather than a session
  // that skipped it.
  await warmPasses(scene, post);
  const timer = request.passes === true ? new PassTimer(renderer) : undefined;
  // A shadow pass is named for its light, and a cascade has no name of its own.
  (scene as unknown as SceneOwners).sky.cascades.lights.forEach((light, i) => {
    light.name = `sun cascade ${i + 1}`;
  });

  const frame = async (x: number, y: number, heading: number, speed: number): Promise<FrameSample> => {
    renderer.info.reset();
    const t0 = performance.now();
    scene.update(x, y);
    const t1 = performance.now();
    camera.update(1 / 60, { x, y, height: scene.heightAt(x, y), heading, speed });
    if (request.noPost === true) {
      // The post chain brings the world matrices up to date, and the renderer does not.
      scene.scene.updateMatrixWorld();
      void renderer.render(scene.scene, camera.camera);
    } else post.render();
    const t2 = performance.now();
    await device.queue.onSubmittedWorkDone();
    const t3 = performance.now();
    // Read after the frame is timed, so the readback is not counted in it.
    const passes = await timer?.read();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      ...(passes === undefined ? {} : { passes }),
      updateMs: t1 - t0,
      cpuMs: t2 - t1,
      totalMs: t3 - t0,
      draws: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
      pipelines: caches._pipelines.caches.size,
      builds: caches._nodes.nodeBuilderCache.size,
      streaming: scene.streaming,
    };
  };

  // Frames first, so the pipelines are compiled before anything is timed.
  for (let i = 0; i < 20; i++) await frame(start.x, start.y, start.heading, 0);

  const kinds = batchKinds(scene, new Set(request.noCast ?? []));

  const still: FrameSample[] = [];
  for (let i = 0; i < request.still; i++) still.push(await frame(start.x, start.y, start.heading, 0));

  let memory: MemorySample | undefined;
  if (request.memory === true) memory = { settled: gpuMemory(), drivePeak: 0, geometry: geometryBytes(scene.scene) };
  if (request.gate === true) {
    const gate = window as unknown as { driveReady: boolean; startDrive: () => void };
    await new Promise<void>((resolve) => {
      gate.startDrive = resolve;
      gate.driveReady = true;
    });
  }
  const drive: FrameSample[] = [];
  const dx = Math.cos(start.heading);
  const dy = Math.sin(start.heading);
  // The quality changes asked for, by the drive frame they land on. The tier is
  // put to the two halves that draw at it exactly as `applyQuality` puts it.
  const changes = new Map(
    (request.tierAt ?? []).map((pair) => {
      const [at, name] = pair.split(':');
      const to = QUALITY_TIERS.find((entry) => entry.name === name);
      if (to === undefined) throw new Error(`No quality tier named '${name}'.`);
      return [Number(at), to] as const;
    }),
  );
  gpuPeak();
  for (let i = 0; i < request.drive; i++) {
    const to = changes.get(i);
    if (to !== undefined) {
      scene.quality = to;
      post.quality = to.post;
    }
    const s = (i / 60) * request.speed;
    drive.push(await frame(start.x + dx * s, start.y + dy * s, start.heading, request.speed));
  }

  if (memory !== undefined) memory.drivePeak = gpuPeak();

  // Read before the dispose below, which empties the renderer's caches.
  const shaders = request.shaders === true ? builtShaders(caches) : undefined;
  post.dispose();
  scene.dispose();
  disposeRenderer(renderer);
  canvas.remove();
  return {
    timed: timer?.available ?? false,
    still,
    drive,
    kinds,
    ...(memory === undefined ? {} : { memory }),
    ...(shaders === undefined ? {} : { shaders }),
  };
}

/** Every stage the renderer compiled, each once. Compute programs are left out. */
function builtShaders(caches: RendererCaches): BuiltShaders {
  const { vertex, fragment } = caches._pipelines.programs;
  return { vertex: [...vertex.keys()], fragment: [...fragment.keys()] };
}

/**
 * What the batches in the scene hold, by kind, and the shadows of the kinds
 * named taken away. A batch is known by the material its scenery drew it with.
 */
function batchKinds(scene: WorldScene, noCast: ReadonlySet<string>): Record<string, BatchKind> {
  const owners = scene as unknown as SceneOwners;
  const kindOf = new Map<unknown, string>();
  for (const name of ['facade', 'block']) kindOf.set(owners.buildings.materials[name], name);
  kindOf.set(owners.vegetation.material, 'plant');
  kindOf.set(owners.lamps.materials.lamp, 'lamp');
  for (const material of Object.values(owners.scenery.surfaces)) kindOf.set(material, 'road');

  const kinds: Record<string, BatchKind> = {};
  scene.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const kind = kindOf.get(object.material);
    if (kind === undefined) return;
    if (noCast.has(kind)) object.castShadow = false;
    // A merged batch counts its parts; a `BatchedMesh` counts its instances.
    const inner = object as unknown as { parts?: number; _instanceInfo?: unknown[] };
    const entry = (kinds[kind] ??= { batches: 0, parts: 0, vertices: 0 });
    entry.batches++;
    entry.parts += inner.parts ?? inner._instanceInfo?.length ?? 0;
    entry.vertices += object.geometry.getAttribute('position')?.count ?? 0;
  });
  return kinds;
}
