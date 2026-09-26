/**
 * The seafront behind the title screen: a sunset sky, the sun on the sea, a
 * town on a headland across the bay, and the promenade the car is parked on.
 *
 * Everything here is a few boxes, cones and planes in the colours of
 * `docs/art-style.md`. The ink of `edges.ts` outlines whatever writes depth, so
 * the sky and the sun write none: a line round the sun would be a hole cut in
 * the sky. The lit windows, the lamp lenses and the sun are brighter than white
 * on purpose, so the bloom of `post.ts` makes them glow.
 */
import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** The sky, from the sea up: a hot peach at the horizon, rose, then violet overhead. */
const SKY_STOPS: readonly [number, number][] = [
  [0, 0xffc27a],
  [0.06, 0xf59a6a],
  [0.2, 0xd8708a],
  [0.45, 0x7a4f98],
  [1, 0x2a2350],
];

/** The fog, which is the horizon colour, so the far headland fades into the sky. */
export const HORIZON = 0xf2a27c;

/** The sun's bearing and height over the horizon, as a unit direction from the car. */
export const SUN_DIRECTION = { x: -0.63, y: 0.1, z: -0.78 };

/** Metres from the car to the sky and to the sun's disc on it. */
const SKY_RADIUS = 170;
const SUN_RADIUS = 11;

/** The promenade, in metres across the road from the car's middle. */
export const KERB_Z = -1.25;
export const PAVEMENT_RISE = 0.14;
const SEA_WALL_Z = -7;
const SEA_LEVEL = -1.4;
const ROAD_FAR_Z = 9;

/** The colours of the seafront. */
const ROAD = 0x7c7ba6;
const PAVEMENT = 0xe7dec2;
const KERB = 0xa1979f;
const MARKING = 0xf2c81e;
const SEA_NEAR = 0x1f8f9a;
const SEA_FAR = 0xf0a07a;
const HEADLAND = 0x8a5f8e;
const PALM_TRUNK = 0x9a6a4a;
const PALM_LEAF = 0x6a8d41;
const WALLS = [0xd98b62, 0xd9b84a, 0xe9e3d3, 0x2e8c8a, 0xcc6a3b, 0xe7a79a];
const ROOF = 0xcc6a3b;
/** A lit window, over white so it blooms. */
const WINDOW_GLOW = new Color(0xffc870).multiplyScalar(4);

/** What the backdrop added to the scene, for the scene to release. */
export interface Backdrop {
  group: Group;
  dispose(): void;
}

/** Build the seafront. */
export function createBackdrop(): Backdrop {
  const group = new Group();
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const add = (geometry: BufferGeometry, material: Material, ink = true): Mesh => {
    geometries.push(geometry);
    materials.push(material);
    const mesh = new Mesh(geometry, material);
    mesh.receiveShadow = ink;
    group.add(mesh);
    return mesh;
  };
  const standard = (color: number, flat = false): MeshStandardMaterial =>
    new MeshStandardMaterial({ color, roughness: 0.9, flatShading: flat });

  // The sky and the sun write no depth, so they draw no ink and the bloom reads them as sky.
  const sky = add(skyDome(), new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }), false);
  sky.renderOrder = -2;
  const sunMaterial = new MeshBasicMaterial({ color: new Color(0xfff0c0).multiplyScalar(40), fog: false, depthWrite: false });
  const sun = add(new CircleGeometry(SUN_RADIUS, 48), sunMaterial, false);
  const reach = SKY_RADIUS - 10;
  const d = SUN_DIRECTION;
  const length = Math.hypot(d.x, d.y, d.z);
  sun.position.set((d.x / length) * reach, (d.y / length) * reach, (d.z / length) * reach);
  sun.lookAt(0, 0, 0);
  sun.renderOrder = -1;

  // The sea: turquoise under the wall, the sunset's rose far out.
  const sea = add(seaPlane(), new MeshBasicMaterial({ vertexColors: true, fog: false }));
  sea.position.y = SEA_LEVEL;
  // The sun's road on the water: a strip of glints that point at the sun.
  const glint = add(glintStrip(sun.position.x, sun.position.z), new MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, depthWrite: false }), false);
  glint.position.y = SEA_LEVEL + 0.02;

  // The road, the kerb, the promenade and the wall over the sea.
  const road = add(new PlaneGeometry(400, ROAD_FAR_Z - KERB_Z + 30), standard(ROAD));
  road.rotation.x = -Math.PI / 2;
  road.position.z = (ROAD_FAR_Z + KERB_Z + 30) / 2;
  const pavementWidth = KERB_Z - SEA_WALL_Z;
  add(new BoxGeometry(400, PAVEMENT_RISE, pavementWidth), standard(PAVEMENT)).position.set(0, PAVEMENT_RISE / 2, KERB_Z - pavementWidth / 2);
  add(new BoxGeometry(400, PAVEMENT_RISE + 0.02, 0.22), standard(KERB)).position.set(0, (PAVEMENT_RISE + 0.02) / 2, KERB_Z - 0.11);
  add(new BoxGeometry(400, 0.7, 0.5), standard(PAVEMENT)).position.set(0, PAVEMENT_RISE + 0.35, SEA_WALL_Z + 0.25);
  add(new BoxGeometry(400, 2, 0.5), standard(KERB)).position.set(0, SEA_LEVEL + 0.5, SEA_WALL_Z + 0.25);
  // The centre line, a painted dash every six metres. It stands a centimetre
  // proud of the road, too little for the ink to find.
  add(dashes(), new MeshBasicMaterial({ color: MARKING })).position.set(0, 0.01, 3.4);

  // Palms along the promenade, the car between two of them.
  const palms = palm(standard(PALM_TRUNK, true), standard(PALM_LEAF, true), materials, geometries);
  for (const [x, lean] of [[-7, 0.1], [-19, -0.08], [-31, 0.12], [-43, -0.05], [-55, 0.1], [24, -0.1], [36, 0.08]] as const) {
    const tree = palms.clone();
    tree.position.set(x, PAVEMENT_RISE, SEA_WALL_Z + 1.4);
    tree.rotation.set(0, x * 1.7, lean);
    tree.scale.setScalar(1 + ((x * 7) % 3) * 0.08);
    group.add(tree);
  }

  // The headland across the bay, and its town catching the last of the sun.
  const headland = add(hills(), new MeshStandardMaterial({ color: HEADLAND, roughness: 1, flatShading: true }));
  headland.position.set(-120, SEA_LEVEL, -150);
  headland.scale.set(1.4, 0.55, 1);
  const [walls, windows] = town();
  for (const part of [
    add(walls, new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true })),
    add(windows, new MeshBasicMaterial({ color: WINDOW_GLOW })),
  ]) {
    part.position.copy(headland.position);
    part.scale.copy(headland.scale);
  }

  return {
    group,
    dispose(): void {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

/** A dome coloured from the horizon up through {@link SKY_STOPS}. */
function skyDome(): BufferGeometry {
  const dome = new SphereGeometry(SKY_RADIUS, 48, 24);
  const position = dome.getAttribute('position');
  const colour = new Color();
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const up = Math.max(0, position.getY(i) / SKY_RADIUS);
    // The sky is warmest toward the sun.
    const toward = Math.max(0, (position.getX(i) * SUN_DIRECTION.x - position.getZ(i) * SUN_DIRECTION.z) / SKY_RADIUS / 1.06);
    gradient(Math.pow(up, 0.8) * (1.25 - 0.35 * toward), colour);
    colour.multiplyScalar(1 + 0.5 * toward * Math.max(0, 1 - up * 3));
    colour.toArray(colours, i * 3);
  }
  dome.setAttribute('color', new Float32BufferAttribute(colours, 3));
  return dome;
}

/** The colour of {@link SKY_STOPS} at a height of 0 to 1. */
function gradient(at: number, out: Color): Color {
  const t = Math.min(1, at);
  for (let i = 1; i < SKY_STOPS.length; i++) {
    const [top, high] = SKY_STOPS[i]!;
    const [bottom, low] = SKY_STOPS[i - 1]!;
    if (t > top) continue;
    return out.set(low).lerp(new Color(high), (t - bottom) / (top - bottom));
  }
  return out.set(SKY_STOPS[SKY_STOPS.length - 1]![1]);
}

/** The sea, from the wall out to the horizon, turning from turquoise to the sky's rose. */
function seaPlane(): BufferGeometry {
  const sea = new PlaneGeometry(420, SKY_RADIUS, 1, 16);
  sea.rotateX(-Math.PI / 2);
  sea.translate(0, 0, SEA_WALL_Z - SKY_RADIUS / 2);
  const position = sea.getAttribute('position');
  const near = new Color(SEA_NEAR);
  const far = new Color(SEA_FAR);
  const colour = new Color();
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const out = (SEA_WALL_Z - position.getZ(i)) / SKY_RADIUS;
    colour.lerpColors(near, far, Math.pow(out, 0.8)).toArray(colours, i * 3);
  }
  sea.setAttribute('color', new Float32BufferAttribute(colours, 3));
  return sea;
}

/** Short bright dashes on the water, strewn along the line from the promenade to the sun. */
function glintStrip(sunX: number, sunZ: number): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  const bright = new Color(0xffe2a0).multiplyScalar(3);
  for (let i = 0; i < 90; i++) {
    // A fixed scatter: the title screen is not the simulation, but it is the same every time.
    const along = 0.06 + 0.94 * ((i * 0.618034) % 1);
    const spread = (((i * 0.414214) % 1) - 0.5) * (4 + along * 30);
    const x = sunX * along + spread;
    const z = SEA_WALL_Z - 3 + (sunZ - SEA_WALL_Z) * along;
    const piece = new PlaneGeometry(0.8 + along * 6, 0.12 + along * 0.6);
    piece.rotateX(-Math.PI / 2);
    piece.translate(x, 0, z);
    const alpha = 0.35 + 0.65 * along;
    const colours = new Float32Array(piece.getAttribute('position').count * 4);
    for (let v = 0; v < colours.length; v += 4) {
      colours[v] = bright.r;
      colours[v + 1] = bright.g;
      colours[v + 2] = bright.b;
      colours[v + 3] = alpha;
    }
    piece.setAttribute('color', new Float32BufferAttribute(colours, 4));
    pieces.push(piece);
  }
  const strip = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  return strip;
}

/** The dashes of the centre line, along the road. */
function dashes(): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  for (let x = -150; x <= 150; x += 6) {
    const dash = new PlaneGeometry(3, 0.14);
    dash.rotateX(-Math.PI / 2);
    dash.translate(x, 0, 0);
    pieces.push(dash);
  }
  const line = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  return line;
}

/**
 * A palm: a trunk of leaning segments and a crown of drooping fronds, each
 * merged into one mesh, so a row of palms costs two draws a tree.
 */
function palm(trunk: Material, leaf: Material, materials: Material[], geometries: BufferGeometry[]): Group {
  materials.push(trunk, leaf);
  const segments: BufferGeometry[] = [];
  const fronds: BufferGeometry[] = [];
  const matrix = new Matrix4();
  const turn = new Matrix4();
  let x = 0;
  let y = 0;
  for (let i = 0; i < 6; i++) {
    const segment = new CylinderGeometry(0.16 - i * 0.012, 0.2 - i * 0.012, 1.25, 6);
    segment.applyMatrix4(matrix.makeRotationZ(-0.05 * i).premultiply(turn.makeTranslation(x, y + 0.6, 0)));
    segments.push(segment);
    x += 0.06 * i;
    y += 1.18;
  }
  for (let i = 0; i < 8; i++) {
    const frond = new ConeGeometry(0.55, 3.4, 4);
    frond.scale(1, 1, 0.18);
    frond.translate(0, 1.7, 0);
    frond.rotateZ(1.25 + (i % 2) * 0.35);
    frond.rotateY((i / 8) * Math.PI * 2);
    frond.translate(x, y, 0);
    fronds.push(frond.toNonIndexed());
    frond.dispose();
  }
  const tree = new Group();
  for (const [pieces, material] of [[segments, trunk], [fronds, leaf]] as const) {
    const merged = mergeGeometries(pieces);
    for (const piece of pieces) piece.dispose();
    geometries.push(merged);
    const mesh = new Mesh(merged, material);
    mesh.castShadow = true;
    tree.add(mesh);
  }
  return tree;
}

/** The headland: a few low faceted hills in one long ridge. */
function hills(): BufferGeometry {
  const pieces: BufferGeometry[] = [];
  for (const [x, z, r, h] of [[0, 0, 34, 22], [38, 10, 26, 13], [-36, -6, 30, 17], [70, 22, 18, 7]] as const) {
    const hill = new ConeGeometry(r, h, 7, 1);
    hill.translate(x, h / 2, z);
    pieces.push(hill.toNonIndexed());
    hill.dispose();
  }
  const ridge = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  return ridge;
}

/** The houses stepped up the headland, and their windows, as two merged meshes. */
function town(): [BufferGeometry, BufferGeometry] {
  const walls: BufferGeometry[] = [];
  const windows: BufferGeometry[] = [];
  const matrix = new Matrix4();
  const colour = new Color();
  for (let i = 0; i < 38; i++) {
    const x = -30 + ((i * 0.618034) % 1) * 90;
    const z = 12 + ((i * 0.381966) % 1) * 10;
    // The ground of the ridge under the house, roughly.
    const ground = Math.max(0, 20 - Math.abs(x) * 0.5) * 0.9;
    const width = 3 + ((i * 0.7548) % 1) * 3;
    const height = 3 + ((i * 0.5698) % 1) * 5;
    const house = new BoxGeometry(width, height, 3);
    house.translate(x, ground + height / 2, z);
    const roof = new BoxGeometry(width + 0.4, 0.5, 3.4);
    roof.translate(x, ground + height + 0.25, z);
    for (const [part, hue] of [[house, WALLS[i % WALLS.length]!], [roof, ROOF]] as const) {
      colour.set(hue);
      const count = part.getAttribute('position').count;
      const colours = new Float32Array(count * 3);
      for (let v = 0; v < count; v++) colour.toArray(colours, v * 3);
      part.setAttribute('color', new Float32BufferAttribute(colours, 3));
      walls.push(part);
    }
    for (let row = 0; row < Math.floor(height / 2.2); row++) {
      if ((i + row) % 3 === 0) continue;
      const pane = new PlaneGeometry(0.7, 0.9);
      matrix.makeTranslation(x - width / 4 + ((i + row) % 2) * (width / 2), ground + 1.4 + row * 2.2, z + 1.52);
      pane.applyMatrix4(matrix);
      windows.push(pane);
    }
  }
  const out: [BufferGeometry, BufferGeometry] = [mergeGeometries(walls), mergeGeometries(windows)];
  for (const piece of [...walls, ...windows]) piece.dispose();
  return out;
}
