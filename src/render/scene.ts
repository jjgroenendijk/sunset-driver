import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
} from 'three';

/** Placeholder scene until world generation feeds the renderer. */
export function createPlaceholderScene(): { scene: Scene; player: Mesh } {
  const scene = new Scene();
  scene.background = new Color(0x1a0b16);

  const ground = new Mesh(new PlaneGeometry(400, 400), new MeshStandardMaterial({ color: 0x2b1f2a }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new GridHelper(400, 40, 0x5a3a55, 0x3a2438));

  const player = new Mesh(new BoxGeometry(1.8, 1.2, 4), new MeshStandardMaterial({ color: 0xff8a5c }));
  player.position.y = 0.6;
  scene.add(player);

  const sun = new DirectionalLight(0xffd7b0, 2.2);
  sun.position.set(40, 80, 20);
  scene.add(sun);
  scene.add(new AmbientLight(0x6a4a70, 0.8));

  return { scene, player };
}
