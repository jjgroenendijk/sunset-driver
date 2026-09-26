/**
 * The things on the beaches of spec section 20.1, drawn: towels, parasols, the
 * lifeguard towers, the ice-cream and cocktail stands, the volleyball nets,
 * the bonfires and the surfboards.
 *
 * The people of a beach are drawn with the crowd (`people/pedestrians.ts`);
 * these are the props round them. Each is grown from boxes, as the props of
 * the occupied corners are (`crime/corners.ts`), and drawn as instances of
 * one geometry each. A prop's frame has `+x` at the sea, `+y` up and `+z` to
 * the left. The towels, the parasols and the boards take a colour of their
 * own from where they lie; the flames of a fire are unlit, so a fire shows
 * after dark.
 */
import {
  Color,
  Group,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type InstancedMesh,
  type Material,
} from 'three';
import { hashInts } from '../../core/hash.ts';
import type { BeachLife, BeachProp, PlacedBeachProp } from '../../sim/city/beach-life.ts';
import type { Weather } from '../../sim/city/weather.ts';
import { boxOf, coloured, instanced, merged, TRAFFIC_VIEW } from '../vehicles/traffic.ts';
import { METAL } from '../vehicles/vehicle-mesh.ts';

/** Metres each way of the point the frame is drawn round that props are drawn in. */
const BEACH_VIEW = TRAFFIC_VIEW;

/** One box of a prop: its size along, up and across, its middle, and its colour. */
type Box = readonly [length: number, height: number, width: number, x: number, y: number, z: number, colour: number];

const WOOD = 0x9a6a4a;
const PALE = 0xe8e2d6;
const RED = 0xd8483a;
const WHITE = 0xf4f1ea;
const PINK = 0xff8fb0;
const THATCH = 0xc8a86a;

/** Posts at the four corners of a square, `half` metres from its middle. */
function posts(half: number, height: number, thick: number, x: number, colour: number): Box[] {
  const out: Box[] = [];
  for (const dx of [half, -half]) for (const dz of [half, -half]) out.push([thick, height, thick, x + dx, height / 2, dz, colour]);
  return out;
}

/** The boxes of each prop. A tinted prop is drawn white and takes its colour from its instance. */
const PROP_BOXES: Record<BeachProp, readonly Box[]> = {
  // A towel on the sand with a stripe across its foot.
  towel: [
    [1.8, 0.02, 0.9, 0.05, 0.01, 0, 0xd8d2c8],
    [0.25, 0.025, 0.9, 0.62, 0.012, 0, WHITE],
  ],
  // A parasol on its pole.
  parasol: [
    [0.04, 2.2, 0.04, 0, 1.1, 0, 0xb0b0b0],
    [2, 0.08, 2, 0, 2.2, 0, WHITE],
    [1.3, 0.1, 1.3, 0, 2.28, 0, 0xd8d2c8],
  ],
  // A hut on stilts, a deck in front of it for the lifeguard, a roof over both and a ladder.
  tower: [
    ...posts(0.7, 2, 0.12, 0, WOOD),
    [1.7, 0.1, 1.7, 0, 2, 0, WOOD],
    [0.7, 1.2, 1.5, -0.45, 2.65, 0, RED],
    [0.06, 1.3, 0.06, 0.8, 2.7, 0.8, WOOD],
    [0.06, 1.3, 0.06, 0.8, 2.7, -0.8, WOOD],
    [1.9, 0.08, 1.9, 0, 3.38, 0, RED],
    [0.08, 2, 0.5, -0.95, 1, 0, WOOD],
  ],
  // A pink kiosk: a back wall, a counter towards the sea, an awning and a cone on top.
  icecream: [
    [0.15, 2.2, 2.2, -1.1, 1.1, 0, PALE],
    [0.5, 1.05, 2.2, 0.35, 0.525, 0, PALE],
    [0.55, 0.06, 2.3, 0.35, 1.08, 0, PINK],
    ...posts(1.1, 2.3, 0.05, 0, PALE).filter((box) => box[3] > 0),
    [2, 0.08, 2.6, 0, 2.34, 0, PINK],
    [2, 0.09, 0.4, 0, 2.35, 0.6, WHITE],
    [2, 0.09, 0.4, 0, 2.35, -0.6, WHITE],
    [0.3, 0.6, 0.3, -0.3, 2.7, 0, 0xf5c16c],
  ],
  // A bamboo bar under a thatch, bottles along its counter.
  cocktail: [
    [0.15, 2.2, 2.2, -1.1, 1.1, 0, WOOD],
    [0.5, 1.05, 2.2, 0.35, 0.525, 0, 0xb8905c],
    [0.55, 0.06, 2.3, 0.35, 1.08, 0, WOOD],
    ...posts(1.1, 2.3, 0.08, 0, 0xb8905c).filter((box) => box[3] > 0),
    [2.3, 0.12, 2.9, 0, 2.3, 0, THATCH],
    [1.5, 0.22, 2.1, 0, 2.47, 0, THATCH],
    [0.08, 0.26, 0.08, 0.3, 1.24, 0.7, 0x3a9a6a],
    [0.08, 0.3, 0.08, 0.3, 1.26, 0.2, 0xe0a030],
    [0.08, 0.22, 0.08, 0.3, 1.22, -0.5, 0x4a70c8],
  ],
  // Two poles, the net between them, and the lines of the court.
  net: [
    [0.08, 2.5, 0.08, 0, 1.25, 4.5, METAL],
    [0.08, 2.5, 0.08, 0, 1.25, -4.5, METAL],
    [0.02, 0.9, 9, 0, 1.95, 0, 0xd8d8d8],
    [0.03, 0.06, 9, 0, 2.42, 0, WHITE],
    [16, 0.01, 0.08, 0, 0.005, 4.5, WHITE],
    [16, 0.01, 0.08, 0, 0.005, -4.5, WHITE],
    [0.08, 0.01, 9, 8, 0.005, 0, WHITE],
    [0.08, 0.01, 9, -8, 0.005, 0, WHITE],
  ],
  // Logs laid crossways, and stones round them. The flames are a mesh of their own.
  bonfire: [
    [1.3, 0.2, 0.22, 0, 0.1, 0, 0x5a3a22],
    [0.22, 0.2, 1.3, 0, 0.2, 0, 0x4a2e1a],
    [0.25, 0.15, 0.25, 0.75, 0.07, 0, 0x7a7670],
    [0.25, 0.15, 0.25, -0.75, 0.07, 0, 0x7a7670],
    [0.25, 0.15, 0.25, 0, 0.07, 0.75, 0x7a7670],
    [0.25, 0.15, 0.25, 0, 0.07, -0.75, 0x7a7670],
  ],
  // A board with its nose towards the way it rides.
  board: [
    [2.1, 0.06, 0.55, 0, 0.03, 0, WHITE],
    [0.3, 0.05, 0.35, 1.18, 0.03, 0, WHITE],
  ],
};

/** The flames over a fire, unlit. */
const FLAME_BOXES: readonly Box[] = [
  [0.65, 0.8, 0.65, 0, 0.6, 0, 0xff7a1a],
  [0.4, 1.3, 0.4, 0, 0.85, 0, 0xffc24a],
  [0.2, 1.6, 0.2, 0.05, 1, 0, 0xfff0a0],
];

const KINDS: readonly BeachProp[] = ['towel', 'parasol', 'tower', 'icecream', 'cocktail', 'net', 'bonfire', 'board'];

/** The props that take a colour of their own. */
const TINTED: ReadonlySet<BeachProp> = new Set<BeachProp>(['towel', 'parasol', 'board']);

/** The colours a towel, a parasol or a board is drawn in. */
const TINTS: readonly number[] = [0xe0524a, 0x3f8fd8, 0xf2c14e, 0x4fb58a, 0xe07ab8, 0xf4f1ea, 0x8a6ad8, 0xff9a4a];

/** Props of each kind drawn at most. */
const CAPS: Record<BeachProp, number> = { towel: 256, parasol: 96, tower: 16, icecream: 16, cocktail: 16, net: 24, bonfire: 32, board: 64 };

function geometryOf(boxes: readonly Box[]): BufferGeometry {
  return merged(boxes.map(([length, height, width, x, y, z, colour]) => coloured(boxOf({ length, height, width, x, y, z, colour }), colour)));
}

export class BeachPropView {
  readonly group = new Group();
  private readonly life: BeachLife;
  private readonly meshes: Record<BeachProp, InstancedMesh>;
  private readonly flames: InstancedMesh;
  private readonly materials: Material[];
  private readonly found: PlacedBeachProp[] = [];
  private readonly matrix = new Matrix4();
  private readonly at = new Vector3();
  private readonly turn = new Quaternion();
  private readonly up = new Vector3(0, 1, 0);
  private readonly one = new Vector3(1, 1, 1);
  private readonly tint = new Color();

  constructor(life: BeachLife) {
    this.life = life;
    const plain = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.02 });
    const tinted = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    const fire = new MeshBasicMaterial({ vertexColors: true });
    this.materials = [plain, tinted, fire];
    const mesh = (kind: BeachProp): InstancedMesh => {
      const made = instanced(geometryOf(PROP_BOXES[kind]), TINTED.has(kind) ? tinted : plain, kind !== 'towel', CAPS[kind]);
      // The colour attribute is made up front, so the shader is built with it the first time.
      if (TINTED.has(kind)) for (let i = 0; i < CAPS[kind]; i++) made.setColorAt(i, this.tint.set(WHITE));
      return made;
    };
    this.meshes = {
      towel: mesh('towel'),
      parasol: mesh('parasol'),
      tower: mesh('tower'),
      icecream: mesh('icecream'),
      cocktail: mesh('cocktail'),
      net: mesh('net'),
      bonfire: mesh('bonfire'),
      board: mesh('board'),
    };
    this.flames = instanced(geometryOf(FLAME_BOXES), fire, false, CAPS.bonfire);
    for (const kind of KINDS) this.group.add(this.meshes[kind]);
    this.group.add(this.flames);
  }

  /** The weather the beach is read in, which is what thins it. */
  set weather(weather: Weather) {
    this.life.weather = weather;
  }

  /** How many props the last frame drew. */
  get drawn(): number {
    let count = 0;
    for (const kind of KINDS) count += this.meshes[kind].count;
    return count;
  }

  /** Stand the props of every beach round a place at a moment. */
  update(tick: number, x: number, y: number): void {
    const found = this.life.props(x - BEACH_VIEW, y - BEACH_VIEW, x + BEACH_VIEW, y + BEACH_VIEW, tick, this.found);
    for (const kind of KINDS) this.meshes[kind].count = 0;
    this.flames.count = 0;
    for (let i = 0; i < found; i++) {
      const prop = this.found[i] as PlacedBeachProp;
      const mesh = this.meshes[prop.kind];
      if (mesh.count >= CAPS[prop.kind]) continue;
      this.at.set(prop.x, prop.height, prop.y);
      this.turn.setFromAxisAngle(this.up, -prop.heading);
      this.matrix.compose(this.at, this.turn, this.one);
      if (TINTED.has(prop.kind)) {
        const pick = (hashInts(Math.round(prop.x * 10), Math.round(prop.y * 10)) >>> 0) % TINTS.length;
        mesh.setColorAt(mesh.count, this.tint.set(TINTS[pick] as number));
      }
      mesh.setMatrixAt(mesh.count++, this.matrix);
      if (prop.kind === 'bonfire') this.flames.setMatrixAt(this.flames.count++, this.matrix);
    }
    for (const mesh of [...KINDS.map((kind) => this.meshes[kind]), this.flames]) {
      mesh.visible = mesh.count > 0;
      if (mesh.count === 0) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const mesh of [...KINDS.map((kind) => this.meshes[kind]), this.flames]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    for (const material of this.materials) material.dispose();
    this.group.clear();
  }
}
