/**
 * The water, drawn (spec section 7.2).
 *
 * Spec section 7.2 asks for the three.js water addon, and `WaterMesh` is the one
 * that runs on `WebGPURenderer`: it reads a tiling normal map at four scales to
 * make a moving surface, lights it from the sun, and mirrors the scene in it.
 * The mirror is a second pass over the scene, so there is one water mesh for the
 * whole world rather than one per chunk, and it renders at
 * {@link REFLECTION_SCALE} of the frame.
 *
 * The addon adds its own colour to what the mirror shows, and it takes that
 * colour as it is: nothing lights it. The mirror, though, shows the sky dome of
 * `sky.ts`, which answers in real sky brightness. An unlit colour is lost under
 * it, and by day the sea reads as a grey sheet of sky. So the colour is lit here,
 * each time the light of the day changes, by the same sun and sky fill that
 * light the ground, and it is in the units of the mirror.
 *
 * The addon owns the rest of the surface. What is added here is the shore:
 * every vertex of `water.ts` carries the depth of the water under it, and the
 * surface fades out over the last {@link SHORE_FADE} metres of it. So the sea
 * thins into the sand of a beach rather than ending on a line across it, and the
 * shallows keep the colour of the ground below them.
 *
 * The addon imports `three/tsl` itself; spec Appendix A is about the game's own
 * shading, which still goes through `tsl.ts`.
 */
import {
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  Vector3,
  type Object3D,
} from 'three';
import { WaterMesh } from 'three/examples/jsm/objects/WaterMesh.js';
import type { WorldDescription } from '../world/types.ts';
import type { Daylight } from './daylight.ts';
import { attribute, smoothstep } from './tsl.ts';
import { buildWaterAttributes, waterGeometry, waveNormalData, WAVE_TEXTURE_SIZE } from './water.ts';

/** Metres of depth over which the surface fades in at a shore. */
const SHORE_FADE = 3;

/** How solid the water is where it is deep. Short of opaque, so the seabed reads through it. */
const DEEP_ALPHA = 0.93;

/**
 * The share of the frame the mirror is rendered at. The reflection of a top-down
 * camera is small on screen and broken up by the waves, so it costs a quarter of
 * the pass and reads the same.
 */
const REFLECTION_SCALE = 0.35;

/**
 * How tightly the wave pattern is laid. The addon spreads its normal map over
 * 103 metres divided by this, so one tile is about 10 metres and the ripples in
 * it are a metre or two across. Seen from the camera of `camera.ts`, a looser
 * pattern shows soft blotches and no ripples.
 */
const WAVE_TILING = 10;

/**
 * How far the mirrored scene is pushed about by the waves, in screen widths per
 * metre of distance. The offset is applied to the mirror's own screen place, so
 * a camera this close to the water needs a small number: the ocean example of
 * three.js looks down from hundreds of metres and asks for twenty.
 */
const DISTORTION = 1.2;

/**
 * The colour of the water itself, as an albedo: what it gives back of the light
 * that falls on it, before the mirror is mixed in. It is lit like the ground.
 */
const WATER_COLOUR = 0x174a5a;

/**
 * The colour the water keeps when no light falls on it. By day it is lost under
 * the lit colour. At night it is what keeps the sea a dark blue, with its waves
 * in relief, rather than as black as the land.
 */
const NIGHT_WATER = 0x10323c;

/** The water of one world: one mesh, and the texture and geometry it owns. */
export interface WaterSurface {
  /** Add this to the scene. It is the whole map's water, not a chunk's. */
  object: Object3D;
  /**
   * Light the water as one moment of the day (spec section 10.5): the glare
   * follows the sun, and the colour takes the light that falls on the ground.
   */
  setDaylight(light: Daylight): void;
  dispose(): void;
}

/** Build the water of a world. */
export function createWaterSurface(world: WorldDescription): WaterSurface {
  const waves = new DataTexture(waveNormalData(world.seed), WAVE_TEXTURE_SIZE, WAVE_TEXTURE_SIZE);
  waves.wrapS = RepeatWrapping;
  waves.wrapT = RepeatWrapping;
  waves.magFilter = LinearFilter;
  waves.minFilter = LinearMipmapLinearFilter;
  waves.generateMipmaps = true;
  waves.needsUpdate = true;

  const geometry = waterGeometry(buildWaterAttributes(world));
  const mesh = new WaterMesh(geometry, {
    waterNormals: waves,
    alpha: DEEP_ALPHA,
    resolutionScale: REFLECTION_SCALE,
    size: WAVE_TILING,
    sunDirection: new Vector3(0, 1, 0),
    sunColor: new Color(0xffffff),
    waterColor: new Color(),
    distortionScale: DISTORTION,
  });
  // The sheet is built flat in the local plane; the quarter turn lays it down
  // and puts its normal up, which is what the mirror takes its plane from.
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = world.water.seaLevel;
  // One mesh covers the whole map, so a culling test can only ever answer yes.
  mesh.frustumCulled = false;

  // The addon's own opacity is one number for the whole surface. This is the
  // shoreline blend: that number, faded to nothing over the last of the depth
  // each vertex carries, as the ground rises to the waterline.
  const depth = attribute('depth', 'float');
  mesh.material.opacityNode = smoothstep(0, SHORE_FADE, depth).mul(mesh.alpha);

  const albedo = new Color(WATER_COLOUR);
  const night = new Color(NIGHT_WATER);
  const sky = new Color();

  return {
    object: mesh,
    setDaylight(light: Daylight): void {
      mesh.sunDirection.value.copy(light.sun).normalize();
      mesh.sunColor.value.copy(light.sunColour);
      // The light on a level surface: the sun by how high it stands, and the
      // sky fill from above. The water gives back its albedo of that, over the
      // colour it keeps in the dark.
      const sun = light.sunIntensity * Math.max(light.altitude, 0);
      sky.copy(light.fillSky).multiplyScalar(light.fillIntensity);
      const lit = mesh.waterColor.value.copy(light.sunColour).multiplyScalar(sun).add(sky);
      lit.multiply(albedo).add(night);
    },
    dispose(): void {
      geometry.dispose();
      mesh.material.dispose();
      waves.dispose();
    },
  };
}
