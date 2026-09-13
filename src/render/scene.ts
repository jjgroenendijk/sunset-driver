import { AmbientLight, CircleGeometry, Color, DirectionalLight, Mesh, MeshStandardMaterial, Scene } from 'three';
import type { CharacterAppearance } from '../sim/character.ts';
import { CharacterModel } from './character.ts';

/** What the title screen shows and how to release it. */
export interface PreviewScene {
  scene: Scene;
  character: CharacterModel;
  dispose(): void;
}

/**
 * The scene behind the title screen: the character on a plinth, lit so the
 * creator can be read. There is no world yet, because the seed the world is
 * generated from is what the title screen is asking for; `WorldScene` takes
 * over once it has one.
 */
export function createPreviewScene(appearance: CharacterAppearance): PreviewScene {
  const scene = new Scene();
  scene.background = new Color(0x17110d);

  const geometry = new CircleGeometry(1.6, 48);
  const material = new MeshStandardMaterial({ color: 0x3a2e25, roughness: 0.9 });
  const plinth = new Mesh(geometry, material);
  plinth.rotation.x = -Math.PI / 2;
  scene.add(plinth);

  const character = new CharacterModel(appearance);
  scene.add(character.group);

  // Set against the exposure of `renderer.ts`: the frame is tone mapped, so the
  // title screen needs the same light a lit street does.
  const key = new DirectionalLight(0xffd7b0, 4.5);
  key.position.set(3, 6, 2);
  scene.add(key);
  scene.add(new AmbientLight(0x6a4a70, 1.6));

  return {
    scene,
    character,
    dispose(): void {
      character.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
