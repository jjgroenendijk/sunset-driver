/**
 * The water, drawn (spec section 7.2).
 *
 * Spec section 7.2 asks for the three.js water addon, and `WaterMesh` is the one
 * that runs on `WebGPURenderer`. Its material is kept: the uniforms the addon
 * holds, the transparent blend, the offset it looks its shadow up at. Its
 * colour graph is not. The addon bakes its mirror into that graph as a function
 * the renderer only runs while it builds the shader, so no handle on the mirror
 * ever reaches the outside — and the quality tiers of `quality.ts` need one, to
 * render the mirror smaller than the frame below the top tier. The graph is
 * rebuilt here, ported from the addon, around a reflector this file holds.
 *
 * The mirror is a second pass over the scene, and the dearest single thing a
 * frame with water in view pays for. It runs wherever the sheet is drawn, and
 * the sheet spans the map, so frustum culling cannot answer for it. Instead the
 * sheet is drawn only where the camera can see it: the camera of `camera.ts`
 * looks down from a few tens of metres and its view ends on the ground a couple
 * of hundred metres out, and {@link WaterSurface.follow} asks, once a frame,
 * whether any water stands in that patch. Where none does, the sheet is out of
 * the frame and the mirror with it, and a frame inland pays nothing for the sea
 * it cannot see.
 *
 * The colour under the mirror is lit here rather than by the addon, which adds
 * its own colour to the mirror unlit. The mirror shows the sky dome of
 * `sky.ts`, which answers in real sky brightness. An unlit colour is lost under
 * it, and by day the sea reads as a grey sheet of sky. So the colour is lit,
 * each time the light of the day changes, by the same sun and sky fill that
 * light the ground, and it is in the units of the mirror.
 *
 * The addon imports `three/tsl` itself; spec Appendix A is about the game's own
 * shading, which still goes through `tsl.ts` — and the colour graph here is the
 * game's own shading now.
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
import { SHADOW_DISTANCE } from './sky.ts';
import {
  attribute,
  cameraPosition,
  float,
  mix,
  positionWorld,
  reflector,
  smoothstep,
  texture,
  time,
  vec2,
  type TslNode,
} from './tsl.ts';
import {
  buildWaterAttributes,
  waterGeometry,
  waterNear,
  waveNormalData,
  WAVE_TEXTURE_SIZE,
} from './water.ts';

/** Metres of depth over which the surface fades in at a shore. */
const SHORE_FADE = 3;

/** How solid the water is where it is deep. Short of opaque, so the seabed reads through it. */
const DEEP_ALPHA = 0.93;

/**
 * The share of the frame the mirror is rendered at. The reflection of a top-down
 * camera is small on screen and broken up by the waves, so it costs a fraction
 * of the pass and reads the same. The quality tiers of `quality.ts` hold this as
 * their top step and render it smaller below.
 */
export const REFLECTION_SCALE = 0.35;

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
   * False holds the sheet out of the frame whatever stands near it. The frame
   * profiler's `--no-water` is the one caller: it needs the sheet gone for
   * good, not until the camera has moved somewhere wet.
   */
  shown: boolean;
  /**
   * The share of the frame the mirror is rendered at. The quality tiers of
   * `quality.ts` step this down; the mirror answers at the new size the next
   * frame, and nothing is rebuilt.
   */
  set mirror(scale: number);
  /**
   * Light the water as one moment of the day (spec section 10.5): the glare
   * follows the sun, and the colour takes the light that falls on the ground.
   */
  setDaylight(light: Daylight): void;
  /**
   * Show the sheet only where water stands within reach of a place, and hide it
   * where none does. The reach is {@link SHADOW_DISTANCE}: the sun's shadow is
   * sized from the same view, whose far edge stands about 130 m from the player,
   * so the patch is the ground the camera covers with room to spare. Called
   * once a frame, wherever the view is centred.
   */
  follow(x: number, y: number): void;
  dispose(): void;
}

/**
 * Build the water of a world.
 */
export function createWaterSurface(world: WorldDescription): WaterSurface {
  const waves = new DataTexture(waveNormalData(world.seed), WAVE_TEXTURE_SIZE, WAVE_TEXTURE_SIZE);
  waves.wrapS = RepeatWrapping;
  waves.wrapT = RepeatWrapping;
  waves.magFilter = LinearFilter;
  waves.minFilter = LinearMipmapLinearFilter;
  waves.generateMipmaps = true;
  waves.needsUpdate = true;

  const sheet = buildWaterAttributes(world);
  const geometry = waterGeometry(sheet);
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
  // `follow` is what shows and hides it, off the water the sheet itself holds.
  mesh.frustumCulled = false;
  const mirror = drawWater(mesh, waves);

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
    shown: true,
    set mirror(scale: number) {
      mirror.resolutionScale = scale;
    },
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
    follow(x: number, y: number): void {
      mesh.visible = this.shown && waterNear(sheet, x, y, SHADOW_DISTANCE);
    },
    dispose(): void {
      geometry.dispose();
      mesh.material.dispose();
      waves.dispose();
    },
  };
}

/**
 * Replace the addon's colour graph with the same shading built here, around a
 * mirror this file can hold, and answer that mirror. Everything the graph
 * computes is ported from the addon as it stands in three.js 0.186: the moving
 * surface off the wave tile, the sun's glare and diffuse light on it, and the
 * Fresnel mix of the water's own colour with what the mirror shows. The addon's
 * graph, left in place, would sample the waves a second time for the shadow
 * lookup and offer no way to the mirror at all, so the lookup is rewritten over
 * this graph's distortion too.
 */
function drawWater(mesh: WaterMesh, waves: DataTexture): { resolutionScale: number } {
  const mirror = reflector();
  const tile = texture(waves);
  // The uniforms the addon holds, taken as the loose nodes they are used as:
  // the operators of a typed node reject the chained graphs built below, which
  // is the trap `tsl.ts` is the door for.
  const sunDirection = mesh.sunDirection as TslNode;
  const sunColor = mesh.sunColor as TslNode;
  const waterColor = mesh.waterColor as TslNode;

  // The moving surface: the wave tile of `water.ts`, sampled at four scales and
  // speeds and summed, each sample a normal in its own frame with the surface's
  // up in blue.
  const laid = positionWorld.xz.mul(mesh.size);
  const drift = [17, 29, -19, 31, 101, 97, -109, -113].map((step) => time.div(step));
  const noise = tile
    .sample(laid.div(103).add(vec2(drift[0], drift[1])))
    .add(tile.sample(laid.div(107).sub(vec2(drift[2], drift[3]))))
    .add(tile.sample(laid.div(vec2(8907, 9803)).add(vec2(drift[4], drift[5]))))
    .add(tile.sample(laid.div(vec2(1091, 1027)).sub(vec2(drift[6], drift[7]))))
    .mul(0.5)
    .sub(1);
  const surfaceNormal = noise.xzy.mul(1.5, 1, 1.5).normalize();
  const worldToEye = cameraPosition.sub(positionWorld);
  const eyeDirection = worldToEye.normalize();

  // The sun on the surface: the glare of it reflected into the eye, and the
  // diffuse light of how squarely it falls on the waves.
  const glare = sunDirection
    .negate()
    .reflect(surfaceNormal)
    .normalize()
    .dot(eyeDirection)
    .max(0)
    .pow(100)
    .mul(sunColor)
    .mul(2);
  const diffuse = sunDirection.dot(surfaceNormal).max(0).mul(sunColor).mul(0.5);

  // The mirror is read through the waves: pushed about by the surface the more,
  // the closer the water stands to the eye.
  const distortion = surfaceNormal.xz
    .mul(float(0.001).add(float(1).div(worldToEye.length())))
    .mul(mesh.distortionScale);
  mesh.material.receivedShadowPositionNode = positionWorld.add(distortion);
  mirror.uvNode = mirror.uvNode.add(distortion);
  mirror.reflector.resolutionScale = REFLECTION_SCALE;
  // The mirror takes its plane from the mesh's own facing, through the place of
  // this target in the world.
  mesh.add(mirror.target);

  // What the sea is made of: the lit colour of the water itself where the eye
  // stands squarely on it, and what the mirror shows where it grazes it.
  const theta = eyeDirection.dot(surfaceNormal).max(0);
  const reflectance = float(1).sub(theta).pow(5).mul(0.98).add(0.02);
  const scatter = surfaceNormal.dot(eyeDirection).max(0).mul(waterColor);
  mesh.material.colorNode = mix(sunColor.mul(diffuse).mul(0.3).add(scatter), mirror.rgb.add(glare), reflectance);
  return mirror.reflector;
}
