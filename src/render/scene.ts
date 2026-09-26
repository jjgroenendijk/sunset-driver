import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';
import type { CharacterAppearance } from '../sim/player/character.ts';
import { createVehicleState, rideHeight, specOf } from '../sim/vehicles/vehicle.ts';
import { CharacterModel } from './people/character.ts';
import { LampLight } from './roads/lamp-light.ts';
import { createLampMaterials } from './roads/lamp-material.ts';
import { LAMP_BY_TIER, lampGeometry } from './roads/lamp-mesh.ts';
import { VehicleModel } from './vehicles/vehicle.ts';

/** What the title screen shows, the camera it is seen through, and how to release it. */
export interface TitleScene {
  scene: Scene;
  camera: PerspectiveCamera;
  character: CharacterModel;
  /** Move the camera on by `seconds` of wall clock. The title screen is not simulation. */
  update(seconds: number): void;
  resize(aspect: number): void;
  dispose(): void;
}

/** The sky at the horizon and overhead. The fog is the horizon colour, so the street fades into it. */
const HORIZON = 0xd8784a;
const ZENITH = 0x1d1620;

/** Asphalt, the pavement and its kerb, in the warm greys of an old town. */
const ROAD = 0x2b2724;
const PAVEMENT = 0x6b5e52;
const KERB = 0x8d8074;

/** Metres from the middle of the car to the kerb, and how high the pavement stands. */
const KERB_OFFSET = 1.25;
const PAVEMENT_RISE = 0.14;
const PAVEMENT_WIDTH = 4;

/** Where the camera circles: its radius, its height and the point it looks at, in metres. */
const ORBIT_RADIUS = 10;
const ORBIT_HEIGHT = 3.2;
const LOOK_HEIGHT = 1.1;

/**
 * The camera swings to and fro about three quarters of the car from the road
 * side, rather than all the way round: behind the car it would show the boot,
 * and on the pavement side it would pass through the lamp post.
 */
const ORBIT_MIDDLE = 0.7;
/** Radians either side of the middle the camera swings, and seconds for one swing there and back. */
const ORBIT_SWING = 0.4;
const ORBIT_PERIOD = 80;

/** Degrees the camera sees top to bottom, and the narrowest shape that still shows the whole car at that. */
const FOV = 45;
const WIDE_ASPECT = 1.4;

/**
 * The scene behind the title screen: a saloon parked at a kerb at dusk, a lit
 * street lamp behind it and the driver standing beside it. The camera swings
 * slowly about the car.
 *
 * There is no world yet, because the seed the world is generated from is what
 * the title screen asks for, so the street is a few boxes. The car, the lamp and
 * its light are the game's own, so the menu shows what the game draws.
 * `WorldScene` takes over once there is a seed.
 */
export function createTitleScene(appearance: CharacterAppearance, aspect: number, still: boolean): TitleScene {
  const scene = new Scene();
  scene.background = new Color(ZENITH);
  scene.fog = new Fog(HORIZON, 18, 60);

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const add = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number): Mesh => {
    geometries.push(geometry);
    materials.push(material);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };

  const sky = add(skyDome(), new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false }), 0, 0, 0);
  sky.receiveShadow = false;

  const road = add(new CircleGeometry(70, 64), new MeshStandardMaterial({ color: ROAD, roughness: 0.95 }), 0, 0, 0);
  road.rotation.x = -Math.PI / 2;
  const pavementMaterial = new MeshStandardMaterial({ color: PAVEMENT, roughness: 0.9 });
  const pavementZ = -KERB_OFFSET - PAVEMENT_WIDTH / 2;
  add(new BoxGeometry(120, PAVEMENT_RISE, PAVEMENT_WIDTH), pavementMaterial, 0, PAVEMENT_RISE / 2, pavementZ);
  const kerb = new MeshStandardMaterial({ color: KERB, roughness: 0.8 });
  add(new BoxGeometry(120, PAVEMENT_RISE + 0.02, 0.2), kerb, 0, (PAVEMENT_RISE + 0.02) / 2, -KERB_OFFSET - 0.1);

  // The car faces along +x with its right side to the kerb, as a car parks in Italy.
  const spec = specOf('saloon');
  const vehicle = new VehicleModel(spec.cls);
  vehicle.set(createVehicleState(spec, 0, 0, rideHeight(spec), 0));
  scene.add(vehicle.group);

  const character = new CharacterModel(appearance);
  character.group.position.set(0.5, 0, spec.halfWidth + 0.75);
  character.group.rotation.y = 0.6;
  scene.add(character.group);

  // A street lamp of the game on the pavement behind the car, its arm over the road.
  const lampSpec = LAMP_BY_TIER.street!;
  const lampMaterials = createLampMaterials();
  lampMaterials.lamps.value = 1;
  const mastX = -12;
  const mastZ = -KERB_OFFSET - 0.6;
  const lamp = new Mesh(lampGeometry(lampSpec), lampMaterials.lamp);
  geometries.push(lamp.geometry);
  lamp.position.set(mastX, PAVEMENT_RISE, mastZ);
  // The arm is built along +x; a quarter turn points it across the road, toward +z.
  lamp.rotation.y = -Math.PI / 2;
  lamp.castShadow = true;
  scene.add(lamp);

  const light = new LampLight(0xffd9a0, 160, 30, 0.9, 0, 2);
  light.position.set(mastX, PAVEMENT_RISE + lampSpec.mast - 0.3, mastZ + lampSpec.arm);
  const target = new Object3D();
  target.position.set(-10, 0, 0.8);
  light.target = target;
  scene.add(light, target);

  // A low evening sun behind the camera's start, set against the exposure of
  // `renderer.ts`: the frame is tone mapped, as a lit street is.
  const sun = new DirectionalLight(0xffb27a, 4);
  sun.position.set(-14, 5, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -8;
  sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8;
  sun.shadow.camera.bottom = -8;
  sun.shadow.camera.far = 40;
  scene.add(sun);
  scene.add(new AmbientLight(0x8a6070, 1.6));

  const camera = new PerspectiveCamera(fovFor(aspect), aspect, 0.1, 200);
  let seconds = 0;
  const place = (): void => {
    const angle = ORBIT_MIDDLE + ORBIT_SWING * Math.sin((seconds / ORBIT_PERIOD) * Math.PI * 2);
    camera.position.set(Math.cos(angle) * ORBIT_RADIUS, ORBIT_HEIGHT, Math.sin(angle) * ORBIT_RADIUS);
    camera.lookAt(0, LOOK_HEIGHT, 0);
  };
  place();

  return {
    scene,
    camera,
    character,
    update(elapsed: number): void {
      if (still) return;
      seconds += elapsed;
      place();
    },
    resize(next: number): void {
      camera.aspect = next;
      camera.fov = fovFor(next);
      camera.updateProjectionMatrix();
    },
    dispose(): void {
      character.dispose();
      vehicle.dispose();
      lampMaterials.dispose();
      light.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

/** A window narrower than {@link WIDE_ASPECT} sees further top to bottom, so the sides of the car stay in. */
function fovFor(aspect: number): number {
  if (aspect >= WIDE_ASPECT) return FOV;
  const half = Math.tan(((FOV / 2) * Math.PI) / 180) * (WIDE_ASPECT / aspect);
  return (Math.atan(half) * 360) / Math.PI;
}

/** A dome coloured from the horizon up, so the sky reads as an evening and not as a wall. */
function skyDome(): BufferGeometry {
  const dome = new SphereGeometry(150, 32, 16);
  const position = dome.getAttribute('position');
  const low = new Color(HORIZON);
  const high = new Color(ZENITH);
  const colour = new Color();
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const up = Math.max(0, position.getY(i) / 150);
    colour.lerpColors(low, high, Math.min(1, up * 2.5));
    colour.toArray(colours, i * 3);
  }
  dome.setAttribute('color', new Float32BufferAttribute(colours, 3));
  return dome;
}
