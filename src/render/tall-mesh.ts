/**
 * The four tall building styles that are not classical masonry (spec section
 * 10.3): the glass curtain wall, the Brutalist slab, the Art Deco stack and the
 * Miami pastel block.
 *
 * `building-style.ts` says which style a building takes. This builds it, from
 * the same box kit `block-shell.ts` gives a house or a warehouse, so a styled
 * tower joins the block batch its cell already draws and costs no draw call of
 * its own. `block-mesh.ts` calls in here once per box of the building's shape
 * and caps each box with its own roof.
 *
 * Every style is a wall and a rhythm laid on it. The rhythm is geometry only
 * where the camera sees it in relief — a pier, a floor slab, an eyebrow shade —
 * and a shader pattern everywhere else: the panes of a curtain wall and the
 * portholes of a Miami corner are drawn in `building-material.ts` off the
 * metres each face carries in its `uv`. That is what makes a curtain wall far
 * cheaper than a masonry facade rather than merely different.
 *
 * Nothing a style lays on a wall reaches out of the box the shape gave it. The
 * walls are drawn in by whatever the relief stands proud, so the relief lands
 * on the edge of that box and the shell still fills its massing; a shell that
 * reached past it would be scaled back by `fitOf`, and scaling one building for
 * the sake of a 0.2 m shade would move every wall of it off the edge it shares.
 *
 * Mid detail builds the massing and the glazing bands and nothing smaller. The
 * camera is 200 m out there, where a pier is a third of a pixel, and the
 * building LOD of spec section 9.2 asks each detail to cost a fraction of the
 * one before it.
 *
 * The local frame is `block-shell.ts`'s: the middle of the lot at ground level,
 * `x` along the frontage, `z` towards the road, `y` up.
 *
 * Nothing here touches the renderer or TSL, so it runs headless.
 */
import type { BuildingMassing } from './building-mesh.ts';
import type { StyledLook } from './building-style.ts';
import {
  BLOCK_CONCRETE,
  BLOCK_CURTAIN,
  BLOCK_NEON,
  BLOCK_PORTHOLE,
  BLOCK_STONE,
  BLOCK_STUCCO,
  BLOCK_TRIM,
  MIN_WALLS,
  PROUD,
  STOREY,
  box,
  type At,
  type Shell,
} from './block-shell.ts';

/** The wall each style is built in, which is what the block material shades it by. */
const WALL_PART: Record<StyledLook, number> = {
  glass: BLOCK_CURTAIN,
  brutalist: BLOCK_CONCRETE,
  deco: BLOCK_STONE,
  miami: BLOCK_STUCCO,
};

/**
 * Metres the deepest relief of each style stands proud of its wall, which is
 * how far the wall is drawn in from the box the shape gave it.
 */
const REACH: Record<StyledLook, number> = { glass: 0.25, brutalist: 0.35, deco: 0.32, miami: 0.5 };

/** Metres of a curtain wall's spandrel line: how deep it runs, and the lobby head. */
const SPANDREL = { rise: 0.34, lobby: 0.6 };

/** Metres of a Brutalist floor slab and of the rib between two windows. */
const BRUTAL_SLAB = 0.4;
const BRUTAL_RIB = 0.45;

/** Metres of a Deco pier across the face it stands on, and of a curtain wall's mullion. */
const PIER_WIDTH = 0.6;
const MULLION = { pitch: 1.8, width: 0.14 };

/** The stepped crown of a Deco tower, in metres over the parapet, and the spire over it. */
const CROWN = [
  { from: 0.7, to: 2.6, share: 0.46 },
  { from: 2.6, to: 4.4, share: 0.28 },
];
const SPIRE = { half: 0.55, rise: 9 };

/** Metres of the cut across each corner of a Miami block, and of its eyebrow shade. */
const MIAMI = { cut: 1.5, shade: 0.2 };

/** Metres a neon strip stands tall, and how far under the parapet it runs. */
const NEON = { rise: 0.22, under: 0.1 };

/** Metres of wall over a window, inside one storey, as `block-shell.ts` lays its bands. */
const HEAD = 0.6;

/**
 * One box of a styled tall building: its walls, its glazing and whatever relief
 * the style lays on them. The roof over it is `block-mesh.ts`'s business, as it
 * is for every other kind.
 *
 * `outer` is the box's own footprint in the shape of `building-shape.ts`, laid
 * out about `at`; `bay` is the pier and window rhythm the building drew for
 * itself; `crown` says whether this box reaches the top, which is the only one
 * a Deco spire stands on.
 */
export function styledBox(
  shell: Shell,
  look: StyledLook,
  outer: BuildingMassing,
  from: number,
  to: number,
  at: At,
  detail: 'near' | 'mid',
  bay: number,
  crown: boolean,
): void {
  // At mid detail the box fills its massing, so every wall a lot shares reaches
  // the edge it shares; the relief that draws a near wall in is not built there.
  const reach = detail === 'near' ? REACH[look] : PROUD;
  const walls = inset(outer, reach);
  if (detail === 'mid' || look !== 'miami') box(shell, walls, from, to, WALL_PART[look], at);
  // At mid detail the box and its parapet are the whole building. Every one of
  // the four styles carries its windows in its material — the panes of a
  // curtain wall, the punched windows of concrete, stone and stucco, the
  // portholes of a Miami corner — so a wall reads as a building at 200 m with
  // no band of glazing to build, and near detail keeps the relief alone.
  if (detail === 'mid') return;
  switch (look) {
    case 'glass':
      curtain(shell, walls, from, to, at, reach);
      break;
    case 'brutalist':
      brutalist(shell, walls, from, to, at, reach, bay);
      break;
    case 'deco':
      deco(shell, walls, from, to, at, reach, bay, crown);
      break;
    default:
      miami(shell, walls, from, to, at, reach);
      break;
  }
}

/**
 * A glass curtain wall: the spandrel line of every floor standing proud of the
 * glass, and a deeper one over the lobby of the box that stands on the ground.
 *
 * The mullion grid and the tint of the panes are the material's, drawn off the
 * `uv` of the wall. Only the floor lines are geometry, because they are what
 * catches the sun and throws the shadow that tells a tower from a mirror.
 */
function curtain(shell: Shell, walls: BuildingMassing, from: number, to: number, at: At, reach: number): void {
  // The vertical mullions, which are what a curtain wall is held together by
  // and the one thing on it that throws a shadow across the glass.
  piers(shell, walls, from, to, at, reach, MULLION.pitch, MULLION.width, BLOCK_TRIM);
  const pitch = storeyPitch(from, to);
  for (let i = 1; from + i * pitch < to - 0.01; i++) {
    const y = from + i * pitch;
    ring(shell, walls, at, y - SPANDREL.rise / 2, y + SPANDREL.rise / 2, reach, BLOCK_TRIM);
  }
  // The head of the double-height lobby, which is what gives a glass tower a
  // ground floor without modelling one.
  if (from <= 0.01 && to > 2 * pitch) {
    ring(shell, walls, at, 2 * pitch - SPANDREL.lobby, 2 * pitch, reach, BLOCK_TRIM);
  }
}

/**
 * A Brutalist slab: raw concrete, and a heavy floor slab framing every storey.
 * The window band sits a third of a metre behind the slab that runs over it, so
 * it reads as the deep-set window of spec section 10.3 without a reveal cut
 * into the wall.
 */
function brutalist(
  shell: Shell,
  walls: BuildingMassing,
  from: number,
  to: number,
  at: At,
  reach: number,
  bay: number,
): void {
  // The rib between one column of windows and the next. With the floor slabs
  // below, the two make the frame a Brutalist window sits deep inside.
  piers(shell, walls, from, to, at, reach, bay, BRUTAL_RIB, BLOCK_CONCRETE);
  const pitch = storeyPitch(from, to);
  for (let i = 1; from + i * pitch < to - 0.01; i++) {
    const y = from + i * pitch;
    ring(shell, walls, at, y - BRUTAL_SLAB / 2, y + BRUTAL_SLAB / 2, reach, BLOCK_CONCRETE);
  }
}

/**
 * An Art Deco tier: a pier at every bay running the whole height of the tier,
 * windows set back between them, a neon strip under the parapet and, on the
 * tier that reaches the top, a stepped crown with a spire.
 *
 * The piers run the full height rather than floor by floor, so the vertical
 * emphasis of the style costs the same whether the tier is four storeys or
 * forty.
 */
function deco(
  shell: Shell,
  walls: BuildingMassing,
  from: number,
  to: number,
  at: At,
  reach: number,
  bay: number,
  crown: boolean,
): void {
  piers(shell, walls, from, to, at, reach, bay, PIER_WIDTH, BLOCK_STONE);
  ring(shell, walls, at, to - NEON.under - NEON.rise, to - NEON.under, reach / 2, BLOCK_NEON);
  if (!crown) return;
  const hw = walls.width / 2;
  const hd = walls.depth / 2;
  for (const step of CROWN) {
    shell.box(
      at.x - hw * step.share,
      at.x + hw * step.share,
      to + step.from,
      to + step.to,
      at.z - hd * step.share,
      at.z + hd * step.share,
      BLOCK_STONE,
    );
  }
  spire(shell, at, to + (CROWN[1] as { to: number }).to);
}

/**
 * The vertical members of a wall, one every `pitch` along each of its four
 * faces: the pier of a Deco tier, the rib of a Brutalist one, the mullion of a
 * curtain wall. They run the whole height of the box, so the vertical emphasis
 * of a style costs the same whether the box is four storeys or forty.
 *
 * The first and the last of a face stand on its corners, so the two faces that
 * meet there share one and the corner reads as a single member.
 */
function piers(
  shell: Shell,
  walls: BuildingMassing,
  from: number,
  to: number,
  at: At,
  reach: number,
  pitch: number,
  width: number,
  part: number,
): void {
  const hw = walls.width / 2;
  const hd = walls.depth / 2;
  const half = width / 2;
  for (const along of [true, false]) {
    const span = along ? walls.width : walls.depth;
    const count = Math.max(2, Math.round(span / Math.max(pitch, 1)) + 1);
    for (let i = 0; i < count; i++) {
      const t = (-0.5 + i / (count - 1)) * (span - width);
      if (along) {
        shell.box(at.x + t - half, at.x + t + half, from, to, at.z + hd, at.z + hd + reach, part);
        shell.box(at.x + t - half, at.x + t + half, from, to, at.z - hd - reach, at.z - hd, part);
      } else {
        shell.box(at.x + hw, at.x + hw + reach, from, to, at.z + t - half, at.z + t + half, part);
        shell.box(at.x - hw - reach, at.x - hw, from, to, at.z + t - half, at.z + t + half, part);
      }
    }
  }
}

/** The four-sided spire over a Deco crown. */
function spire(shell: Shell, at: At, base: number): void {
  const h = SPIRE.half;
  const top = base + SPIRE.rise;
  const corners: readonly (readonly [number, number])[] = [
    [at.x - h, at.z + h],
    [at.x + h, at.z + h],
    [at.x + h, at.z - h],
    [at.x - h, at.z - h],
  ];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i] as readonly [number, number];
    const b = corners[(i + 1) % corners.length] as readonly [number, number];
    shell.triangle([a[0], base, a[1]], [b[0], base, b[1]], [at.x, top, at.z], BLOCK_TRIM);
  }
}

/**
 * A Miami block: pastel stucco with its four corners cut away, an eyebrow shade
 * over every band of window, and a neon strip under the parapet.
 *
 * Each cut corner is its own part, and the material draws one round window a
 * storey on it: the portholes of the style cost no geometry at all. The eyebrow
 * is a band round the whole box, so it wraps the corners and reaches the edges
 * of the massing the wall is drawn in from.
 */
function miami(shell: Shell, walls: BuildingMassing, from: number, to: number, at: At, reach: number): void {
  const faces = octagon(walls, at);
  for (const [a, b, part] of faces) {
    shell.quad([a[0], from, a[1]], [b[0], from, b[1]], [b[0], to, b[1]], [a[0], to, a[1]], part);
  }
  const pitch = storeyPitch(from, to);
  const storeys = Math.max(1, Math.round((to - from) / pitch));
  for (let i = 0; i < storeys; i++) {
    // The shade sits over the head of the window, which is where the storey's
    // band of stucco ends.
    const head = from + (i + 1) * pitch - HEAD;
    ring(shell, walls, at, head, head + MIAMI.shade, reach, BLOCK_TRIM);
  }
  ring(shell, walls, at, to - NEON.under - NEON.rise, to - NEON.under, reach / 2, BLOCK_NEON);
}

/**
 * The eight faces of a Miami block, wound the way `Shell.box` winds its own
 * four walls so each of them faces outward: a flat stucco face, then the cut
 * corner that carries the portholes, four times round.
 */
function octagon(
  walls: BuildingMassing,
  at: At,
): readonly (readonly [readonly [number, number], readonly [number, number], number])[] {
  const hw = walls.width / 2;
  const hd = walls.depth / 2;
  const cut = Math.min(MIAMI.cut, walls.width / 4, walls.depth / 4);
  const x0 = at.x - hw;
  const x1 = at.x + hw;
  const z0 = at.z - hd;
  const z1 = at.z + hd;
  const ring: readonly (readonly [number, number])[] = [
    [x0 + cut, z1],
    [x1 - cut, z1],
    [x1, z1 - cut],
    [x1, z0 + cut],
    [x1 - cut, z0],
    [x0 + cut, z0],
    [x0, z0 + cut],
    [x0, z1 - cut],
  ];
  return ring.map((a, i) => [a, ring[(i + 1) % ring.length] as readonly [number, number], i % 2 === 0 ? BLOCK_STUCCO : BLOCK_PORTHOLE] as const);
}

/** A box drawn in by `reach` each way, never below the walls a building keeps. */
function inset(outer: BuildingMassing, reach: number): BuildingMassing {
  return {
    ...outer,
    width: Math.max(MIN_WALLS, outer.width - 2 * reach),
    depth: Math.max(MIN_WALLS, outer.depth - 2 * reach),
  };
}

/** Metres of one storey of a box, as the glazing bands are spaced. */
function storeyPitch(from: number, to: number): number {
  const storeys = Math.max(1, Math.round((to - from) / STOREY));
  return (to - from) / storeys;
}

/** A band running round all four faces of a box, standing `proud` of them. */
function ring(shell: Shell, walls: BuildingMassing, at: At, y0: number, y1: number, proud: number, part: number): void {
  const hw = walls.width / 2 + proud;
  const hd = walls.depth / 2 + proud;
  shell.box(at.x - hw, at.x + hw, y0, y1, at.z - hd, at.z + hd, part);
}
