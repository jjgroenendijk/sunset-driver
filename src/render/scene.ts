import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
} from 'three';
import type { CharacterAppearance } from '../sim/character.ts';
import { CharacterModel } from './character.ts';

/**
 * The backdrop the title screen turns the character against. It is not a place
 * in the world: the session's own scene is `world-view.ts`, and it is only
 * built once the title screen has handed over a seed.
 */
export function createTitleScene(appearance: CharacterAppearance): {
  scene: Scene;
  character: CharacterModel;
} {
  const scene = new Scene();
  scene.background = new Color(0x1a0b16);

  const ground = new Mesh(new PlaneGeometry(400, 400), new MeshStandardMaterial({ color: 0x2b1f2a }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new GridHelper(400, 40, 0x5a3a55, 0x3a2438));

  const character = new CharacterModel(appearance);
  scene.add(character.group);

  const sun = new DirectionalLight(0xffd7b0, 2.2);
  sun.position.set(40, 80, 20);
  scene.add(sun);
  scene.add(new AmbientLight(0x6a4a70, 0.8));

  return { scene, character };
}
