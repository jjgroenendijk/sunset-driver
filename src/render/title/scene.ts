import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { CharacterAppearance } from '../../sim/player/character.ts';
import { createVehicleState, rideHeight, specOf } from '../../sim/vehicles/vehicle.ts';
import { tickAtHour } from '../environment/daylight.ts';
import { PostChain, type PostQuality } from '../look/post.ts';
import { CharacterModel } from '../people/character.ts';
import { LampLight } from '../roads/lamp-light.ts';
import { createLampMaterials } from '../roads/lamp-material.ts';
import { LAMP_BY_TIER, lampGeometry } from '../roads/lamp-mesh.ts';
import { VehicleModel } from '../vehicles/vehicle.ts';
import { createBackdrop, HORIZON, KERB_Z, PAVEMENT_RISE, SUN_DIRECTION } from './backdrop.ts';

/** What the title screen shows, the camera it is seen through, and how to release it. */
export interface TitleScene {
  scene: Scene;
  camera: PerspectiveCamera;
  character: CharacterModel;
  /** Move the camera on by `seconds` of wall clock. The title screen is not simulation. */
  update(seconds: number): void;
  /** Draw the frame through the game's own post chain: the ink, the bloom and the grade. */
  render(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** The car on the title screen, and the paint it wears: the game's own rosso. */
const CAR = 'sports';
const PAINT = 0xc43a2c;

/**
 * The hour the grade and the ink are taken at: the golden hour, when the ink
 * is still plum and the grade is at its warmest.
 */
const HOUR = 19.6;

/** Where the camera circles: its radius, its height and the point it looks at, in metres. */
const ORBIT_RADIUS = 11;
const ORBIT_HEIGHT = 2.1;
const LOOK_HEIGHT = 0.95;

/**
 * The camera swings to and fro about the front three quarters of the car, the
 * sun low over the sea behind it. Round the back it would show the boot, and on
 * the pavement side it would pass through the lamp post.
 */
const ORBIT_MIDDLE = 0.62;
/** Radians either side of the middle the camera swings, and seconds for one swing there and back. */
const ORBIT_SWING = 0.22;
const ORBIT_PERIOD = 70;

/**
 * Degrees the camera sees across, and the most it may see top to bottom. A
 * window held upright is narrow, so the car is fitted to its width and the
 * sunset fills the height above it.
 */
const ACROSS = 58;
const MAX_FOV = 88;

/**
 * Where on the screen the car stands, as a share of the width and the height.
 * The main menu stands at the left of a wide screen and at the bottom of an
 * upright one (`title.css`), so the car stands in the space it leaves.
 */
const FOCUS_WIDE = { x: 0.64, y: 0.6 };
const FOCUS_TALL = { x: 0.5, y: 0.38 };

/** The post chain on a phone: fewer pixels, the same look. */
const PHONE_POST: PostQuality = { renderScale: 0.85, bloom: true, smaa: true, grade: true };

/**
 * The scene behind the title screen: a red sports car parked on a seafront
 * promenade at sunset, the driver leaning on it, palms and a lit street lamp
 * along the wall, and a town on the headland across the bay.
 *
 * There is no world yet, because the seed the world is generated from is what
 * the title screen asks for, so the seafront is a few boxes (`backdrop.ts`).
 * The car, the driver, the lamp and the post chain are the game's own, so the
 * menu shows what the game draws, ink lines and all. `WorldScene` takes over
 * once there is a seed.
 */
export function createTitleScene(
  renderer: WebGPURenderer,
  appearance: CharacterAppearance,
  size: { width: number; height: number },
  options: { still: boolean; touch: boolean },
): TitleScene {
  const scene = new Scene();
  scene.background = new Color(HORIZON);
  scene.fog = new Fog(HORIZON, 90, 420);

  const backdrop = createBackdrop();
  scene.add(backdrop.group);

  // The car faces along +x with its right side to the kerb, as a car parks in
  // Italy. The driver's door stands open, as if they have just got out.
  const spec = specOf(CAR);
  const vehicle = new VehicleModel(spec.cls);
  const state = createVehicleState(spec, 0, 0, rideHeight(spec), 0);
  state.paint = PAINT;
  vehicle.set(state);
  vehicle.lamps = 1;
  vehicle.openDoor(1, 1.05);
  for (const part of meshes(vehicle.group)) part.castShadow = part.receiveShadow = true;
  scene.add(vehicle.group);

  const character = new CharacterModel(appearance);
  character.group.position.set(-0.1, 0, spec.halfWidth + 1.25);
  character.group.rotation.y = -0.3;
  for (const part of meshes(character.group)) part.castShadow = true;
  scene.add(character.group);

  // The game's street lamps along the promenade, their arms over the road, lit.
  const lampSpec = LAMP_BY_TIER.street!;
  const lampMaterials = createLampMaterials();
  lampMaterials.lamps.value = 1;
  const lampShape = lampGeometry(lampSpec);
  const lights: LampLight[] = [];
  const mastZ = KERB_Z - 0.6;
  for (const mastX of [-13, -41, 15]) {
    const lamp = new Mesh(lampShape, lampMaterials.lamp);
    lamp.position.set(mastX, PAVEMENT_RISE, mastZ);
    // The arm is built along +x; a quarter turn points it across the road, toward +z.
    lamp.rotation.y = -Math.PI / 2;
    lamp.castShadow = true;
    scene.add(lamp);
    const light = new LampLight(0xffd9a0, 120, 26, 0.9, 0, 2);
    light.position.set(mastX, PAVEMENT_RISE + lampSpec.mast - 0.3, mastZ + lampSpec.arm);
    const target = new Object3D();
    target.position.set(mastX + 1, 0, mastZ + lampSpec.arm);
    light.target = target;
    scene.add(light, target);
    lights.push(light);
  }

  // The low sun behind the car, over the sea: it rims the roof and throws the
  // shadows long toward the camera. It is set against the exposure of
  // `renderer.ts`, since the chain tone maps the frame as a lit street is.
  const sun = new DirectionalLight(0xffa860, 5.5);
  sun.position.set(SUN_DIRECTION.x * 30, SUN_DIRECTION.y * 30 + 4, SUN_DIRECTION.z * 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(options.touch ? 1024 : 2048, options.touch ? 1024 : 2048);
  sun.shadow.camera.left = -14;
  sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 10;
  sun.shadow.camera.bottom = -10;
  sun.shadow.camera.far = 70;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  // The sky's glow on the side of the car turned from the sun: rose from above, warm off the road.
  const glow = new DirectionalLight(0xff8f86, 1.6);
  glow.position.set(10, 6, 12);
  scene.add(glow);
  scene.add(new HemisphereLight(0xb58ad8, 0xe0906a, 1.5));

  const camera = new PerspectiveCamera(50, size.width / size.height, 0.1, 400);
  let seconds = 0;
  const place = (): void => {
    const angle = ORBIT_MIDDLE + ORBIT_SWING * Math.sin((seconds / ORBIT_PERIOD) * Math.PI * 2);
    camera.position.set(Math.cos(angle) * ORBIT_RADIUS, ORBIT_HEIGHT, Math.sin(angle) * ORBIT_RADIUS);
    camera.lookAt(0.3, LOOK_HEIGHT, 0);
  };
  const frame = (width: number, height: number): void => {
    frameCamera(camera, width, height);
  };
  frame(size.width, size.height);
  place();

  const post = new PostChain(renderer, scene, camera, options.touch ? PHONE_POST : undefined);
  post.time = tickAtHour(HOUR);

  return {
    scene,
    camera,
    character,
    update(elapsed: number): void {
      if (options.still) return;
      seconds += elapsed;
      place();
    },
    render(): void {
      post.render();
    },
    resize: frame,
    dispose(): void {
      post.dispose();
      character.dispose();
      vehicle.dispose();
      lampMaterials.dispose();
      lampShape.dispose();
      for (const light of lights) light.dispose();
      backdrop.dispose();
    },
  };
}

/**
 * Fit the camera to the window: the car fills {@link ACROSS} degrees of the
 * width, and the view is shifted so the car stands where the menu leaves room.
 */
function frameCamera(camera: PerspectiveCamera, width: number, height: number): void {
  const aspect = width / height;
  const halfAcross = Math.tan(((ACROSS / 2) * Math.PI) / 180);
  const fov = (Math.atan(halfAcross / aspect) * 360) / Math.PI;
  camera.aspect = aspect;
  camera.fov = Math.min(MAX_FOV, fov);
  const focus = aspect >= 1 ? FOCUS_WIDE : FOCUS_TALL;
  camera.setViewOffset(width, height, (0.5 - focus.x) * width, (0.5 - focus.y) * height, width, height);
  camera.updateProjectionMatrix();
}

/** Every mesh under an object. */
function meshes(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(object);
  });
  return found;
}
