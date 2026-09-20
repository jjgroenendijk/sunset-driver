/**
 * The materials the buildings are drawn with (spec sections 10.1, 10.3).
 *
 * Three of them, which is what a chunk's three batches need:
 *
 * - the facade, which is the generator's own material dressing the towers and
 *   the mid-rise blocks, with the night added to it;
 * - the block, which shades the walls, roofs, trim and glazing of everything
 *   else from the `part` attribute `block-mesh.ts` writes;
 * - the outline, a flat dark shell drawn back-face only, which is the hard
 *   outline of spec section 10.1.
 *
 * Both lit materials carry the emissive window mask: the glass of a building is
 * picked out, some of it is lit, and the whole of it is multiplied by one
 * `night` uniform. The uniform is 0 by daylight and nothing glows; the day and
 * night cycle of spec section 10.5 is issue #21 and owns it from there.
 *
 * The build ships no image files, so the grain of render, brick and metal is
 * fractal noise in the shader, as the ground's and the roads' are.
 *
 * Only this file, the other `*-material.ts` files and `tsl.ts` know about shader
 * nodes.
 */
import { BackSide, Color } from 'three';
import { createSkyscraperMaterial } from 'three/examples/jsm/generators/city/SkyscraperGenerator.js';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  BLOCK_CONCRETE,
  BLOCK_CURTAIN,
  BLOCK_GLASS,
  BLOCK_MEMBRANE,
  BLOCK_METAL,
  BLOCK_NEON,
  BLOCK_PAINT,
  BLOCK_PLANTED,
  BLOCK_PORTHOLE,
  BLOCK_ROOF,
  BLOCK_SLATE,
  BLOCK_SOLAR,
  BLOCK_STONE,
  BLOCK_STUCCO,
  BLOCK_TILE,
  BLOCK_TRIM,
  BLOCK_WATER,
} from './block-mesh.ts';
import type { BuildingCutaway } from './cutaway.ts';
import {
  attribute,
  float,
  fractalNoise,
  mix,
  positionWorld,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
  type TslNode,
} from './tsl.ts';

/**
 * The material zones the tower generator bakes into its `partId` attribute. Only
 * the two glazed ones are named here, because they are the ones the night lights
 * up; the generator's own material reads the rest.
 */
const FACADE_GLASS = 4;
const FACADE_SHOPGLASS = 6;

/** Metres of one period of the fine grain of a wall, and of the patches over it. */
const GRAIN_METRES = 1.1;
const PATCH_METRES = 18;

/** Metres of one storey, as the window bands are spaced (`block-mesh.ts`). */
const STOREY = 3.2;

/** Metres of one window and of the mullion between two of them. */
const WINDOW_PITCH = 2.2;
const MULLION = 0.28;

/** How much of the windows are lit after dark, and how warm that light is. */
const LIT_SHARE = 0.45;
const WINDOW_GLOW = 0xffd9a2;

/**
 * How hard a lit window burns, as a multiple of {@link WINDOW_GLOW}. At 1 it
 * stayed under the bloom threshold of `post.ts` once exposed, and a lit tower
 * read as painted yellow rather than lit.
 */
const WINDOW_GAIN = 2.5;

/** Glass by day: dark, and darker still where it faces away from the sky. */
const GLAZING = 0x2a3338;

/** The dark of every outline (spec section 10.1). */
const OUTLINE = 0x150f12;

/** Roofs and trim, which are the same felt and concrete whatever stands under them. */
const ROOF = 0x4a4742;
const TRIM = 0xb9b4a8;

/**
 * The surfaces a dressed roof and a varied low-rise building add (spec section
 * 10.3). Each is one value of the `part` attribute, so they all share the one
 * block material and no building costs a draw call for its dressing.
 */
const MEMBRANE = 0xd7d5cc;
const PLANTED = 0x5c7a43;
const SOLAR = 0x1b2440;
const METAL = 0x9aa1a4;
const TILE = 0xa85a3c;
const SLATE = 0x545a62;
const WATER = 0x2f7f9c;
const PAINT = 0xe6e2d6;

/** Metres of one rib of corrugated metal. */
const RIB_METRES = 0.35;

/**
 * The curtain wall of a glass tower (spec section 10.3), all of it drawn in the
 * shader off the metres the wall carries in its `uv`: the pane grid across, the
 * floor line up, and the opaque spandrel band under each floor line. The wall
 * itself is six quads a box, so this is what a glass tower is made of.
 */
const PANE_METRES = 1.8;
const MULLION_SHARE = 0.1;
/** How much of a floor is spandrel rather than vision glass. */
const SPANDREL_SHARE = 0.34;
/** The mullion of a curtain wall, and how much darker a pane is than its tint. */
const MULLION_COLOUR = 0x8f9499;

/** Metres of one board of the shuttering a Brutalist wall is cast against. */
const BOARD_METRES = 0.45;

/**
 * The punched window each styled wall carries, drawn in the shader: how far
 * apart the columns stand, how much of a column is window and how much of a
 * storey is. Concrete is narrow and deep, stone is tall and slim between its
 * piers, stucco is wide and low.
 *
 * Drawing them rather than building them is what lets a styled tower keep its
 * windows at mid detail, where the relief around them is not built at all.
 */
const PUNCHED = {
  concrete: { pitch: 2.6, wide: 0.5, tall: 0.42 },
  stone: { pitch: 2.1, wide: 0.42, tall: 0.55 },
  stucco: { pitch: 2.8, wide: 0.62, tall: 0.36 },
} as const;

/** How wide across its panel a Miami porthole is drawn, and how far up its storey. */
const PORTHOLE = { across: 0.42, up: 0.55, radius: 0.26 };

/** The neon of a Deco or a Miami edge after dark, and how hard it burns. */
const NEON_COLOURS = [0xff3d8b, 0x36e6ff, 0xffc93d];
const NEON_GAIN = 3.2;

/** The materials a world's buildings are drawn with, and the night they share. */
export interface BuildingMaterials {
  /** The generated towers and mid-rise blocks. */
  facade: MeshStandardNodeMaterial;
  /** Everything built as boxes: houses, shop rows, warehouses, roadhouses. */
  block: MeshStandardNodeMaterial;
  /** The inverted hulls that outline both. */
  outline: MeshBasicNodeMaterial;
  /** How far into the night it is, 0 by day and 1 at midnight. */
  night: { value: number };
  dispose(): void;
}

/**
 * Build the three materials every chunk of a world shares. All three are cut
 * where a building hides the player (`cutaway.ts`).
 */
export function createBuildingMaterials(cutaway: BuildingCutaway): BuildingMaterials {
  const night = uniform(0);
  const facade = createFacadeMaterial(night);
  const block = createBlockMaterial(night);
  const outline = new MeshBasicNodeMaterial({ color: new Color(OUTLINE), side: BackSide, fog: true });
  cutaway.dressShell(facade);
  cutaway.dressShell(block);
  cutaway.dressOutline(outline);
  return {
    facade,
    block,
    outline,
    night,
    dispose(): void {
      facade.dispose();
      block.dispose();
      outline.dispose();
    },
  };
}

/**
 * The generator's own facade material, dressed with each building's colour and
 * given the night. The colour comes off the geometry rather than from a uniform,
 * which is what lets one material dress a whole city: `building-mesh.ts` writes
 * the palette pick of every tower into its vertices.
 */
function createFacadeMaterial(night: TslNode): MeshStandardNodeMaterial {
  const material = createSkyscraperMaterial(attribute('tint', 'vec3')) as MeshStandardNodeMaterial;
  const partId = attribute('partId', 'float');
  const glass = is(partId, FACADE_GLASS).add(is(partId, FACADE_SHOPGLASS));
  // A whole storey lights up at once. A window of the generator's is a pane of
  // its own, so lighting them one by one would need the bay each stands in, and
  // a floor read off the world height is exact wherever the pane is cut.
  const storey = vec3(
    positionWorld.x.div(40).floor(),
    positionWorld.y.div(STOREY).floor(),
    positionWorld.z.div(40).floor(),
  );
  material.emissiveNode = rgb(WINDOW_GLOW).mul(WINDOW_GAIN).mul(glass).mul(lit(storey)).mul(night);
  return material;
}

/**
 * The material every building that is not generated is drawn with. The `part`
 * attribute tells the walls, the roof, the trim and the glazing apart, and the
 * `uv` of a band of glazing is metres along the wall, so the windows are the
 * same width on a house and on a warehouse.
 *
 * Every part that carries a window — a band of glazing, a curtain wall, the
 * punched wall of a style, a Miami porthole — is lit off **one** grid and one
 * draw of which of its cells have their light on. A noise field is by far the
 * dearest thing this material evaluates, and the styled towers of spec section
 * 10.3 are drawn with it over most of the screen, so a field a part would cost
 * a frame several milliseconds. The grid is the same one each part draws its
 * windows on: only how wide a column of them stands changes.
 */
function createBlockMaterial(night: TslNode): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ metalness: 0 });
  const part = attribute('part', 'float');
  const tint = attribute('tint', 'vec3');
  const grain = noise01(GRAIN_METRES, 3);
  const patch = noise01(PATCH_METRES, 2);

  // Which window a fragment stands in, and how far across it: the pane grid is
  // measured from the corner the band starts at, so it never straddles a window.
  const along = uv().x;
  const glazed = gap(along.div(WINDOW_PITCH).fract(), MULLION / WINDOW_PITCH);

  // A rib of corrugated metal, as a triangle wave along the face in metres.
  const rib = float(1).sub(uv().x.div(RIB_METRES).fract().sub(0.5).abs().mul(0.7));

  // Each is 1 on the part it names and 0 everywhere else. They are drawn once
  // and used by the colour, the emissive and the roughness alike.
  const glassAt = is(part, BLOCK_GLASS);
  const curtainAt = is(part, BLOCK_CURTAIN);
  const concreteAt = is(part, BLOCK_CONCRETE);
  const stoneAt = is(part, BLOCK_STONE);
  const stuccoAt = is(part, BLOCK_STUCCO);
  const portholeAt = is(part, BLOCK_PORTHOLE);

  const seeThrough = vision();
  const eye = round();
  const punchedAt = { concrete: hole('concrete'), stone: hole('stone'), stucco: hole('stucco') };
  const neonColour = neon();
  const pastel = tint.mul(float(0.9).add(patch.mul(0.14)).add(grain.mul(0.06)));

  const wall = tint.mul(float(0.78).add(patch.mul(0.28)).add(grain.mul(0.16)));
  const glass = mix(rgb(TRIM).mul(0.7), rgb(GLAZING), glazed);
  // A tile and a slate roof take the weathering patch as their own colour, so
  // one street of houses is roofed in several shades of the same material.
  const dressed: readonly [number, TslNode][] = [
    [BLOCK_ROOF, rgb(ROOF).mul(float(0.85).add(grain.mul(0.3)))],
    [BLOCK_TRIM, rgb(TRIM).mul(float(0.86).add(grain.mul(0.22)))],
    [BLOCK_MEMBRANE, rgb(MEMBRANE).mul(float(0.9).add(grain.mul(0.16)))],
    [BLOCK_PLANTED, rgb(PLANTED).mul(float(0.75).add(patch.mul(0.4)).add(grain.mul(0.2)))],
    [BLOCK_SOLAR, rgb(SOLAR).mul(float(0.8).add(grain.mul(0.25)))],
    [BLOCK_METAL, rgb(METAL).mul(rib).mul(float(0.82).add(grain.mul(0.2)))],
    [BLOCK_TILE, rgb(TILE).mul(float(0.7).add(patch.mul(0.55)).add(grain.mul(0.18)))],
    [BLOCK_SLATE, rgb(SLATE).mul(float(0.72).add(patch.mul(0.45)).add(grain.mul(0.18)))],
    [BLOCK_WATER, rgb(WATER).mul(float(0.9).add(grain.mul(0.2)))],
    [BLOCK_PAINT, rgb(PAINT).mul(float(0.92).add(grain.mul(0.12)))],
    // The four styles of spec section 10.3. Each takes the building's own tint,
    // because colour follows the style: the tint of a glass tower is the tint
    // of its glass, and a Miami block's is its stucco.
    [BLOCK_CURTAIN, curtain(tint, seeThrough)],
    [BLOCK_CONCRETE, punched(tint.mul(float(0.72).add(board(grain)).add(patch.mul(0.18))), punchedAt.concrete)],
    [BLOCK_STONE, punched(tint.mul(float(0.84).add(patch.mul(0.2)).add(grain.mul(0.12))), punchedAt.stone)],
    [BLOCK_STUCCO, punched(pastel, punchedAt.stucco)],
    [BLOCK_PORTHOLE, mix(pastel, rgb(GLAZING), eye)],
    [BLOCK_NEON, neonColour.mul(0.7)],
  ];
  let surface = wall;
  for (const [id, colour] of dressed) surface = mix(surface, colour, is(part, id));
  material.colorNode = mix(surface, glass, glassAt);

  // How wide one column of windows stands on whichever part this is, and which
  // cell of that column the fragment is in. A floor read off the world height
  // is exact wherever a wall is cut.
  let pitch = float(WINDOW_PITCH);
  pitch = mix(pitch, float(PANE_METRES), curtainAt);
  pitch = mix(pitch, float(PUNCHED.concrete.pitch), concreteAt);
  pitch = mix(pitch, float(PUNCHED.stone.pitch), stoneAt);
  pitch = mix(pitch, float(PUNCHED.stucco.pitch), stuccoAt);
  pitch = mix(pitch, float(PORTHOLE.across), portholeAt);
  const cell = vec3(
    along.div(pitch).floor(),
    positionWorld.y.div(STOREY).floor(),
    positionWorld.x.add(positionWorld.z).div(30).floor(),
  );
  // Which fragments are a window at all, whatever part they belong to.
  const window = glassAt
    .mul(glazed)
    .add(curtainAt.mul(seeThrough))
    .add(concreteAt.mul(punchedAt.concrete))
    .add(stoneAt.mul(punchedAt.stone))
    .add(stuccoAt.mul(punchedAt.stucco))
    .add(portholeAt.mul(eye));
  // Neon burns whatever else is lit: it is the one part that is a lamp.
  const strip = neonColour.mul(NEON_GAIN).mul(is(part, BLOCK_NEON));
  material.emissiveNode = rgb(WINDOW_GLOW).mul(WINDOW_GAIN).mul(window).mul(lit(cell)).add(strip).mul(night);
  // Render, brick and felt are rough; glass, a solar panel and water are not.
  const mirror = curtainAt.mul(seeThrough);
  const smooth = glassAt.add(is(part, BLOCK_SOLAR)).add(is(part, BLOCK_WATER)).add(mirror);
  material.roughnessNode = mix(
    float(0.92).sub(grain.mul(0.12)).sub(is(part, BLOCK_METAL).mul(0.35)).sub(stuccoAt.mul(0.25)),
    float(0.1),
    smooth,
  );
  // Only a pane of vision glass is a mirror. Everything else here is a wall.
  material.metalnessNode = mirror.mul(0.65);
  return material;
}

/**
 * The face of a glass curtain wall: vision glass in the building's own tint,
 * cut by a mullion grid, with an opaque spandrel band under every floor line.
 *
 * The grid is measured in metres from the corner the wall starts at, which is
 * what its `uv` carries, so the panes are the same width on every tower and the
 * pattern does not break where two faces meet.
 */
function curtain(tint: TslNode, seeThrough: TslNode): TslNode {
  const mullion = float(1).sub(gap(uv().x.div(PANE_METRES).fract(), MULLION_SHARE));
  const band = float(1).sub(seeThrough);
  const pane = tint.mul(float(0.85).add(uv().x.add(uv().y).div(7).sin().mul(0.1)));
  return mix(mix(pane, tint.mul(0.55), band), rgb(MULLION_COLOUR).mul(0.8), mullion);
}

/** 1 on the vision glass of a curtain wall, 0 on the spandrel band under a floor. */
function vision(): TslNode {
  return step(SPANDREL_SHARE, uv().y.div(STOREY).fract());
}

/**
 * A wall with a window punched through it at every column and every storey,
 * drawn off the metres the wall carries in its `uv`: across from the corner it
 * starts at, and up from the foot of the box it belongs to.
 */
function punched(wall: TslNode, at: TslNode): TslNode {
  return mix(wall, rgb(GLAZING), at);
}

/** 1 inside a punched window of a styled wall, 0 on the wall around it. */
function hole(kind: keyof typeof PUNCHED): TslNode {
  const shape = PUNCHED[kind];
  const across = gap(uv().x.div(shape.pitch).fract(), (1 - shape.wide) / 2);
  const up = gap(uv().y.div(STOREY).fract(), (1 - shape.tall) / 2);
  return across.mul(up);
}

/**
 * 1 inside the round window of a porthole panel, 0 outside it. The panel is
 * narrow and the storey is tall, so the circle is measured in the panel's own
 * width both ways and comes out round.
 */
function round(): TslNode {
  const across = uv().x.div(PORTHOLE.across).fract().sub(0.5);
  const up = uv().y.div(STOREY).fract().sub(PORTHOLE.up).mul(PORTHOLE.across / STOREY);
  return float(1).sub(smoothstep(PORTHOLE.radius - 0.04, PORTHOLE.radius, across.mul(across).add(up.mul(up)).sqrt()));
}

/**
 * The colour of a neon strip. A building cannot pass its own seed to a shader,
 * so the colour is drawn from the ground the strip stands over: one building's
 * strips are all one colour, and its neighbour's are another.
 */
function neon(): TslNode {
  const cell = vec3(positionWorld.x.div(34).floor(), 0, positionWorld.z.div(34).floor());
  const draw = fractalNoise(cell.mul(0.43), 1).mul(0.5).add(0.5);
  const first = mix(rgb(NEON_COLOURS[0] as number), rgb(NEON_COLOURS[1] as number), step(0.34, draw));
  return mix(first, rgb(NEON_COLOURS[2] as number), step(0.67, draw));
}

/** The board marks of the shuttering a Brutalist wall was cast against. */
function board(grain: TslNode): TslNode {
  return positionWorld.y.div(BOARD_METRES).fract().sub(0.5).abs().mul(0.14).add(grain.mul(0.1));
}

/** 1 in the middle of a repeat and 0 within `share` of either end of it. */
function gap(at: TslNode, share: number): TslNode {
  return step(share, at).mul(float(1).sub(step(float(1).sub(share), at)));
}

/** 1 where a part attribute carries exactly `id`, 0 everywhere else. */
function is(part: TslNode, id: number): TslNode {
  return step(id - 0.5, part).mul(float(1).sub(step(id + 0.5, part)));
}

/** Which cells of a grid have their light on: a little under half of them. */
function lit(cell: TslNode): TslNode {
  return smoothstep(LIT_SHARE - 0.08, LIT_SHARE + 0.08, fractalNoise(cell.mul(0.37), 1).mul(0.5).add(0.5));
}

/** A colour constant in the working colour space, as a shader node. */
function rgb(hex: number): TslNode {
  const colour = new Color(hex);
  return vec3(colour.r, colour.g, colour.b);
}

/**
 * Fractal noise over the world, in 0..1. The place is the world one, so the
 * grain does not move with the mesh it is drawn on and two walls of one street
 * are not weathered identically.
 */
function noise01(metres: number, octaves: number): TslNode {
  const place = vec3(positionWorld.x.div(metres), positionWorld.y.div(metres), positionWorld.z.div(metres));
  return fractalNoise(place, octaves).mul(0.5).add(0.5);
}
