/**
 * The ground a junction's carriageway is drawn over, as a ring on the map (spec
 * section 6.2). A junction holds its carriageway alone: the pavement round its
 * corners is cut out of the blocks by `pavement.ts`.
 *
 * The ring covers the whole of every mouth's carriageway between the node and
 * its cut, since `road-mesh.ts` draws none of that ground. It is a fan and not
 * an outline: a vertex may stand nearer the node than the two beside it, and
 * then the ring crosses itself. Read it as the triangles it is drawn as.
 *
 * `junction-mesh.ts` lays a surface on the ring and `carve.ts` levels the
 * ground under it to the junction's plane. Both read the ring from here, so
 * the carve covers exactly what is drawn, and every vertex carries its height
 * from the one surface `bed.ts` defines. The outline of
 * `junctions.ts` alone does not cover what is drawn: a mouth is drawn on its
 * curve and the outline is cut on a straight line, and a fan from the node
 * reaches past a ring that is not convex.
 */
import { planeHeight } from './bed.ts';
import type { Junction, JunctionMouth } from './junctions.ts';
import type { RoadRibbons } from './ribbon.ts';
import { TIERS } from './tiers.ts';
import type { Point } from './types.ts';

/**
 * One corner of a junction ring. `bed` is the height of the surface there, read
 * off the one surface of `bed.ts`: the road's banked section where the vertex
 * stands on a mouth, and the junction's plane everywhere else. It is undefined
 * only where the ribbons were built without the junctions, and the vertex then
 * stands on the carved ground.
 */
export interface JunctionVertex {
  x: number;
  y: number;
  bed: number | undefined;
}

/** The ring of one junction's carriageway. */
export interface JunctionShape {
  /**
   * The carriageway, anticlockwise: each mouth's two kerbs, then the kerb of
   * the corner after it. A mouth also carries the kerbs it starts on at the
   * node, where the mouth beside it is cut too short to hold them. It is drawn
   * as a fan from the node, so a vertex nearer the node than the two beside it
   * adds ground rather than taking it away.
   */
  carriageway: JunctionVertex[];
  /** The height of the surface at the node, which the carriageway is fanned from. */
  centre: number | undefined;
}

/**
 * The carriageway of a junction. The vertices along each mouth are the section
 * the road's own loft ends on. Nothing where fewer than two mouths meet, since
 * then nothing is drawn.
 */
export function junctionShape(junction: Junction, ribbons: RoadRibbons): JunctionShape {
  const plane = ribbons.beds.planeAt(junction.node);
  const shape: JunctionShape = { carriageway: [], centre: plane?.level };
  const sections = junction.mouths.map((mouth) => mouthSection(mouth, ribbons));
  if (sections.length < 2) return shape;
  const ground = (p: Point): JunctionVertex => ({
    x: p.x,
    y: p.y,
    bed: plane === undefined ? undefined : planeHeight(plane, p.x, p.y),
  });
  const node: Point = { x: junction.x, y: junction.y };
  const last = sections.length - 1;
  for (let i = 0; i < sections.length; i++) {
    const a = sections[i] as MouthSection;
    const mouth = junction.mouths[i] as JunctionMouth;
    const corner = junction.corners[i] as Junction['corners'][number];
    // The two kerbs the mouth starts on, at the node itself. They usually stand
    // inside the mouth beside them, whose own triangle draws them; where that
    // mouth is cut too short to reach one, the ring takes it in instead, or the
    // ground under it is drawn by nothing at all (issue #299).
    const kerb = TIERS[mouth.tier].width / 2;
    const right: Point = { x: node.x + mouth.dy * kerb, y: node.y - mouth.dx * kerb };
    const left: Point = { x: node.x - mouth.dy * kerb, y: node.y + mouth.dx * kerb };
    if (!covers(node, sections[i === 0 ? last : i - 1], right)) shape.carriageway.push(ground(right));
    shape.carriageway.push(a.rightKerb, a.leftKerb);
    if (!covers(node, sections[i === last ? 0 : i + 1], left)) shape.carriageway.push(ground(left));
    shape.carriageway.push(...corner.kerb.map(ground));
  }
  return shape;
}

/** Slack on a cross product, so a place on the very edge of a triangle stands inside it. */
const EDGE_SLACK = 1e-6;

/**
 * True where the triangle from the node out to a mouth's own section holds a
 * place. That triangle is all of the fan the mouth is sure of: what the corners
 * each side of it add is the corners' own business.
 */
function covers(node: Point, section: MouthSection | undefined, p: Point): boolean {
  if (section === undefined) return false;
  const a = section.rightKerb;
  const b = section.leftKerb;
  if ((a.x - node.x) * (b.y - node.y) - (a.y - node.y) * (b.x - node.x) <= 0) return false;
  const first = (a.x - node.x) * (p.y - node.y) - (a.y - node.y) * (p.x - node.x);
  const second = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const third = (node.x - b.x) * (p.y - b.y) - (node.y - b.y) * (p.x - b.x);
  return first >= -EDGE_SLACK && second >= -EDGE_SLACK && third >= -EDGE_SLACK;
}

/** The two kerbs of the section a road's loft ends on at its mouth. */
interface MouthSection {
  leftKerb: JunctionVertex;
  rightKerb: JunctionVertex;
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
  const at = (across: number): JunctionVertex => {
    const off = across * frame.mitre;
    return {
      x: mouth.at.x + frame.acrossX * off,
      y: mouth.at.y + frame.acrossY * off,
      bed: frame.height + frame.bank * off,
    };
  };
  const side = mouth.direction;
  return { leftKerb: at(side * kerb), rightKerb: at(-side * kerb) };
}
