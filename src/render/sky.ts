/**
 * The sky, the sun and the shadows they cast (spec section 10.5).
 *
 * Three things, driven by one {@link Daylight}:
 *
 * - the dome, which is the Preetham sky of the `SkyMesh` addon. It is the one
 *   three.js sky that runs on `WebGPURenderer`;
 * - the sun, one directional light with cascaded shadow maps sized to the
 *   top-down view;
 * - the fill, one hemisphere light standing for the sky and the bounce off the
 *   ground, so a shadow is dark rather than black.
 *
 * The dome is a box of {@link DOME_SIZE} metres carried with the player rather
 * than a sphere around the map. The camera's far plane is 2 km, so a dome the
 * size of the sky would be clipped away; one that is always around the player
 * and beyond every chunk it can see reads the same and costs one draw.
 *
 * {@link SCENE_LIGHT_CAP} and {@link SHADOW_CASCADES} are the counts the HUD
 * shows and the budget test enforces. A count over either is a regression, not
 * a cap to raise.
 */
import { Color, Fog, HemisphereLight, DirectionalLight, Object3D, Vector3, type Scene } from 'three';
import { CSMShadowNode } from 'three/examples/jsm/csm/CSMShadowNode.js';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import type { Daylight } from './daylight.ts';
import { reflected } from './mirror.ts';

/** Metres each way of the box the sky is drawn on. Inside the camera's far plane. */
const DOME_SIZE = 1600;

/**
 * Cascades the sun's shadow is split into, and the map each one is drawn at.
 * Two is what a fixed top-down camera needs: one for the ground under the
 * player, one for the rest of the draw distance. A third would cost a pass and
 * cover ground this camera never looks at.
 */
export const SHADOW_CASCADES = 2;

/**
 * Pixels each way of one cascade at full quality. The quality tiers of spec
 * section 9.2 step this down and nothing else about the shadows: the cascade
 * count is fixed, because changing it rebuilds the shader of every material in
 * the scene and that is the hitch the tiers exist to avoid.
 */
export const SHADOW_MAP_SIZE = 1024;

/**
 * Metres of view depth the shadow follows at full quality. The camera of
 * `camera.ts` looks down at 58 degrees and pulls back with speed. At the top
 * speed of the roster, the far edge of its view stands about 130 m from it on
 * flat ground, and nothing past that is ever on screen. Past this, a cascade
 * would draw every building and tree again for ground nobody sees. A quality
 * tier of spec section 9.2 may pull it in, never out.
 */
export const SHADOW_DISTANCE = 160;

/** Depth bias, in metres of surface, that keeps a lit surface from shadowing itself. */
const SHADOW_BIAS = -0.0006;
/**
 * How far along its own normal a surface is moved before it is looked up in
 * the shadow map. It has to cover a shadow texel, or a surface the sun grazes
 * shadows itself in stripes that crawl as the view moves. The near cascade of
 * {@link SHADOW_DISTANCE} covers about 80 m across, so a texel of a
 * {@link SHADOW_MAP_SIZE} map is about 8 cm; this is two of them.
 */
const SHADOW_NORMAL_BIAS = 0.16;

/**
 * Radians the sun may turn before the shadow follows it.
 *
 * `CSMShadowNode` holds a shadow still by snapping each cascade's centre to
 * its own texel grid, and it builds that grid in the light's frame. So the
 * snap only holds while the light stands still. A game day is 24 real minutes,
 * which turns the sun a quarter of a degree a second: moved every frame, the
 * grid turns under the snap and every shadow edge crawls.
 *
 * The sun the shadow is cast from therefore moves in steps, and the dome, the
 * colours and the haze keep following the true sun. A step of this size moves
 * the tip of a 20 m shadow by about 9 cm, once a second.
 */
export const SUN_SHADOW_STEP = (0.25 * Math.PI) / 180;

/**
 * How thick the air is and how blue it scatters, as the Preetham model reads
 * them. A coastal city: clear enough to see the far headland, hazy enough that
 * the low sun burns orange.
 */
const TURBIDITY = 3.4;
const RAYLEIGH = 2.1;
const MIE_COEFFICIENT = 0.006;
const MIE_DIRECTIONAL_G = 0.82;

/**
 * Lights the scene may hold at once (spec section 10.5): the sun and the sky
 * fill here, the street lamps of `lamps.ts`, the player's headlights
 * (`headlights.ts`) and the neon of `signs.ts`. Every light is evaluated by
 * every fragment it can reach, so this is a hard cap rather than a target: a
 * system that needs more raises it together with the lighting it brings, and
 * every pool that makes it up is a fixed size so the sum can be checked.
 * `WorldScene.lightCount` is what it is checked against.
 */
export const SCENE_LIGHT_CAP = 16;

/** The sky of one world: the dome, the sun and the fill, and the fog under them. */
export class SkyLighting {
  /** Lights this holds. The rest of {@link SCENE_LIGHT_CAP} is the lamps', the headlights' and the neon's. */
  readonly lightCount = 2;
  readonly shadowCascades = SHADOW_CASCADES;

  private readonly dome = new SkyMesh();
  private readonly sun = new DirectionalLight(0xffffff, 1);
  private readonly fill = new HemisphereLight(0xffffff, 0x000000, 1);
  private readonly cascades: CSMShadowNode;
  private readonly fog: Fog;
  private readonly background = new Color();
  private readonly scene: Scene;
  /** The direction the shadow is cast from: the true sun, snapped to {@link SUN_SHADOW_STEP}. */
  private readonly shadowSun = new Vector3();

  constructor(scene: Scene, fogNear: number, fogFar: number) {
    this.scene = scene;
    this.dome.scale.setScalar(DOME_SIZE);
    // Drawn after the ground and the buildings, so the depth buffer throws away
    // every fragment they already cover. The camera of spec section 10.7 looks
    // down and rarely sees the sky at all; shading it first would pay for a
    // whole screen of atmosphere behind a city that hides it.
    this.dome.renderOrder = 1;
    this.dome.turbidity.value = TURBIDITY;
    this.dome.rayleigh.value = RAYLEIGH;
    this.dome.mieCoefficient.value = MIE_COEFFICIENT;
    this.dome.mieDirectionalG.value = MIE_DIRECTIONAL_G;
    // The sky is most of what the water gives back, so the dome is one of the
    // few things the mirror of `mirror.ts` draws.
    scene.add(reflected(this.dome));

    // The shadow settings are read when the cascades are first built, so they
    // are set before the node is made rather than after.
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.bias = SHADOW_BIAS;
    this.sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
    // The cascades copy this when they are built. Left on, a shadow map is
    // drawn again for every camera the frame renders with, and the water's
    // mirror is a second camera: the same map, fitted to the same view, drawn
    // twice. `drawShadowOnce` asks for it once a frame instead.
    this.sun.shadow.autoUpdate = false;
    this.cascades = new CSMShadowNode(this.sun, {
      cascades: SHADOW_CASCADES,
      maxFar: SHADOW_DISTANCE,
      mode: 'practical',
    });
    this.sun.shadow.shadowNode = this.cascades;
    // Only the direction from the light to its target is read, so both stand
    // at the origin of the scene and the sun never has to follow the player.
    this.sun.target = new Object3D();
    scene.add(this.sun, this.sun.target, this.fill);

    this.fog = new Fog(0x000000, fogNear, fogFar);
    scene.fog = this.fog;
    scene.background = this.background;
  }

  /** Light the scene as one moment of the day (spec section 10.5). */
  set(light: Daylight): void {
    this.dome.sunPosition.value.copy(light.sun);
    // The sun keeps casting at night, at no strength. Turning the shadow off
    // and on again would rebuild every material's shader at dusk and at dawn.
    // Only the direction is read, so the position is the snapped sun carried
    // out to the dome rather than the true one.
    if (this.shadowSun.lengthSq() === 0 || this.shadowSun.angleTo(light.sun) >= SUN_SHADOW_STEP) {
      this.shadowSun.copy(light.sun);
      this.sun.position.copy(this.shadowSun).multiplyScalar(DOME_SIZE);
    }
    this.sun.color.copy(light.sunColour);
    this.sun.intensity = light.sunIntensity;
    this.fill.color.copy(light.fillSky);
    this.fill.groundColor.copy(light.fillGround);
    this.fill.intensity = light.fillIntensity;
    this.fog.color.copy(light.haze);
    this.background.copy(light.haze);
  }

  /**
   * Ask for the sun's shadow maps for the frame about to be drawn. The first
   * render of the frame draws them and every later one reuses them: the
   * cascades are fitted to the player's camera whichever camera asks. A sun
   * with no strength throws no shadow, so at night the maps are not drawn.
   */
  drawShadowOnce(): void {
    if (this.sun.intensity <= 0) return;
    // A cascade is built at the first render, and each one clones the sun's own
    // shadow as it is built. Asking on that clone template is what draws the
    // shadow of a frame rendered before there is a cascade to ask: the first
    // frame of a session, and the one frame a preview draws.
    this.sun.shadow.needsUpdate = true;
    for (const light of this.cascades.lights) if (light.shadow !== undefined) light.shadow.needsUpdate = true;
  }

  /**
   * The direction the shadow is cast from: the true sun snapped to
   * {@link SUN_SHADOW_STEP}. Read it; writing it moves the sun without moving
   * the sky, and the two would drift apart over a day.
   */
  get shadowSunDirection(): Vector3 {
    return this.shadowSun;
  }

  /** Carry the dome with the player, so it is always the far side of every chunk. */
  follow(x: number, y: number): void {
    this.dome.position.set(x, 0, y);
  }

  /**
   * Close the haze where the ground now ends (spec section 9.2). A quality tier
   * that pulls the draw distance in moves the fog with it, or the player would
   * see the last chunk stop in clear air.
   */
  setFog(near: number, far: number): void {
    this.fog.near = near;
    this.fog.far = far;
  }

  /**
   * Draw the sun's cascades at this many pixels each way (spec section 9.2).
   * The map is resized before the next shadow pass; the frustums are refitted
   * because the snapping that keeps a shadow edge from crawling is measured in
   * texels of it.
   */
  set shadowMapSize(pixels: number) {
    if (this.sun.shadow.mapSize.width === pixels) return;
    this.sun.shadow.mapSize.set(pixels, pixels);
    // Each cascade cloned the sun's shadow when it was built, so the size has
    // to be written onto the clones as well. Written only on the sun, a tier
    // that asks for a smaller map draws every cascade at the old one and pays
    // the same for its shadow as the tier above.
    for (const cascade of this.cascades.lights) {
      if (cascade.shadow !== undefined) cascade.shadow.mapSize.set(pixels, pixels);
    }
    if (this.cascades.camera !== null) this.cascades.updateFrustums();
  }

  get shadowMapSize(): number {
    return this.sun.shadow.mapSize.width;
  }

  /**
   * Follow the shadow this far and no further (spec section 9.2). The same two
   * cascades are cut to the shorter range, so a tier that pulls this in pays
   * less for the shadow and draws what is left of it sharper.
   */
  set shadowDistance(metres: number) {
    if (this.cascades.maxFar === metres) return;
    this.cascades.maxFar = metres;
    if (this.cascades.camera !== null) this.cascades.updateFrustums();
  }

  get shadowDistance(): number {
    return this.cascades.maxFar;
  }

  /** Refit the cascades after the camera's shape changes. */
  resize(): void {
    if (this.cascades.camera !== null) this.cascades.updateFrustums();
  }

  dispose(): void {
    this.scene.remove(this.dome, this.sun, this.sun.target, this.fill);
    this.scene.fog = null;
    this.scene.background = null;
    this.cascades.dispose();
    this.dome.geometry.dispose();
    this.dome.material.dispose();
    this.sun.dispose();
    this.fill.dispose();
  }
}
