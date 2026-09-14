/**
 * The ground a junction's surfaces are drawn over, as rings on the map (spec
 * section 6.2).
 *
 * `junction-mesh.ts` lays a surface on each ring and `carve.ts` levels the
 * ground under every one of them to the junction's plane. Both read the rings
 * from here, so the carve covers exactly what is drawn. The outline of
 * `junctions.ts` alone does not: a mouth is drawn on its curve and the outline
 * is cut on a straight line, and a fan from the node reaches past a ring that is
 * not convex.
 */
import type { Junction, JunctionMouth } from './junctions.ts';
import type { RoadRibbons } from './ribbon.ts';
import { footprintHalfWidth, TIERS } from './tiers.ts';
import type { Point, RoadTier } from './types.ts';

/**
 * One corner of a junction ring. `bed` is the height of the road bed where the
 * vertex stands on a mouth's section, and undefined where it stands on the
 * carved ground. `edge` says whether it is on a kerb or on the outer edge of the
 * surface, and `tier` is the tier whose section says how high that edge stands.
 */
export interface JunctionVertex {
  x: number;
  y: number;
  bed: number | undefined;
  edge: 'kerb' | 'outer';
  tier: RoadTier;
}

/** The rings of one junction's surfaces. */
export interface JunctionShape {
  /**
   * The carriageway, anticlockwise: each mouth's two kerbs, then the kerb of
   * the corner after it. It is drawn as a fan from the node.
   */
  carriageway: JunctionVertex[];
  /** The pavement of each corner, `corners[i]` after `junction.mouths[i]`. */
  corners: JunctionVertex[][];
}

/**
 * The rings of a junction. The vertices along each mouth are the section the
 * road's own loft ends on. Nothing where fewer than two mouths meet, since then
 * nothing is drawn.
 */
export function junctionShape(junction: Junction, ribbons: RoadRibbons): JunctionShape {
  const shape: JunctionShape = { carriageway: [], corners: [] };
  const sections = junction.mouths.map((mouth) => mouthSection(mouth, ribbons));
  if (sections.length < 2) return shape;
  for (let i = 0; i < sections.length; i++) {
    const a = sections[i] as MouthSection;
    const b = sections[(i + 1) % sections.length] as MouthSection;
    const corner = junction.corners[i] as Junction['corners'][number];
    const kerb = corner.kerb.map((p) => ground(p, 'kerb', corner.tier));
    shape.carriageway.push(a.rightKerb, a.leftKerb, ...kerb);
    const outer = corner.outer.map((p) => ground(p, 'outer', corner.tier)).reverse();
    shape.corners.push([a.leftKerb, ...kerb, b.rightKerb, b.rightOuter, ...outer, a.leftOuter]);
  }
  return shape;
}

/** The four corners of the section a road's loft ends on at its mouth. */
interface MouthSection {
  leftKerb: JunctionVertex;
  rightKerb: JunctionVertex;
  leftOuter: JunctionVertex;
  rightOuter: JunctionVertex;
}

/**
 * Where a mouth's loft ends. Left is anticlockwise round the node, which is the
 * curve's own left where the road leaves along its curve and its right where
 * it leaves against it. The place is worked out as `place` in `road-section.ts`
 * works it out, so the vertices are the loft's to the last bit.
 */
function mouthSection(mouth: JunctionMouth, ribbons: RoadRibbons): MouthSection {
  const frame = ribbons.frameAt(mouth.curve, mouth.segment, mouth.at.x, mouth.at.y);
  const kerb = TIERS[mouth.tier].width / 2;
  const outer = footprintHalfWidth(mouth.tier);
  const at = (across: number, edge: 'kerb' | 'outer'): JunctionVertex => {
    const off = across * frame.mitre;
    return { x: mouth.at.x + frame.acrossX * off, y: mouth.at.y + frame.acrossY * off, bed: frame.height, edge, tier: mouth.tier };
  };
  const side = mouth.direction;
  return {
    leftKerb: at(side * kerb, 'kerb'),
    rightKerb: at(-side * kerb, 'kerb'),
    leftOuter: at(side * outer, 'outer'),
    rightOuter: at(-side * outer, 'outer'),
  };
}

function ground(p: Point, edge: 'kerb' | 'outer', tier: RoadTier): JunctionVertex {
  return { x: p.x, y: p.y, bed: undefined, edge, tier };
}
