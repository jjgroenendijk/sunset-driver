/**
 * The wall a board is hung on, measured off the building that was really
 * built.
 *
 * Two things hang boards on a standing building: the harm-reduction posters of
 * spec section 19 (`poster-mesh.ts`) and the advertising of spec section 13.1
 * (`sign-mesh.ts`). Neither moves a wall or claims a piece of ground, and both
 * need the same two answers — the building's own frame in the scene's axes, and
 * how big the shell `building-mesh.ts` really built is — so both ask here.
 *
 * The shell's matrix scales it to fill its massing, which is why nothing can be
 * read off the massing alone: the numbers below are the shell's own bounding
 * box taken through that scale, which leaves every offset a caller works in
 * plain metres.
 *
 * Nothing here touches the renderer or TSL, so it runs headless.
 */
import { Matrix4, Vector3 } from 'three';
import type { BuildingPlacement } from './building-mesh.ts';
import { FOUNDATION } from './building-plan.ts';

/** One building's front wall, as the thing hung on it measures it. */
export interface WallFace {
  /** The building's own axes as unit vectors: across its front, up it, and out of it. */
  along: Vector3;
  up: Vector3;
  out: Vector3;
  /** The middle of the building at the foot of its frame. */
  at: Vector3;
  /** Metres from the pavement to the top of the built wall. */
  wall: number;
  /** Half the built frontage, and how far the front face stands from the middle. */
  halfWall: number;
  face: number;
}

/**
 * The front wall of a building that has been placed, or nothing where the shell
 * has no box to measure — a placement with a flattened axis, which nothing can
 * be hung on.
 */
export function wallFaceOf(placed: BuildingPlacement): WallFace | undefined {
  const shell = placed.shell;
  if (shell.boundingBox === null) shell.computeBoundingBox();
  const box = shell.boundingBox;
  if (box === null) return undefined;
  const matrix = placed.matrix;
  const along = new Vector3().setFromMatrixColumn(matrix, 0);
  const up = new Vector3().setFromMatrixColumn(matrix, 1);
  const out = new Vector3().setFromMatrixColumn(matrix, 2);
  const scaleAlong = along.length();
  const scaleUp = up.length();
  const scaleOut = out.length();
  if (scaleAlong === 0 || scaleUp === 0 || scaleOut === 0) return undefined;
  along.divideScalar(scaleAlong);
  up.divideScalar(scaleUp);
  out.divideScalar(scaleOut);
  return {
    along,
    up,
    out,
    at: new Vector3().setFromMatrixPosition(matrix),
    // The frame stands a foundation below the ground, so a height over the
    // pavement is that much further up the wall.
    wall: box.max.y * scaleUp - FOUNDATION,
    halfWall: box.max.x * scaleAlong,
    face: box.max.z * scaleOut,
  };
}

/** A board hung on a wall: where its middle is, which way it looks, and how far it leans back. */
export interface BoardPlace {
  x: number;
  y: number;
  height: number;
  outX: number;
  outY: number;
  /** Radians the printed face is lifted from the wall, towards the sky. */
  tilt: number;
}

/**
 * The frame of one board: its own axes, with `z` the way the print faces. The
 * lean turns the frame about the board's own width, which leaves the face
 * looking out over the street and up at the camera of spec section 10.7.
 */
export function boardFrame(board: BoardPlace): Matrix4 {
  const wall = new Vector3(board.outX, 0, board.outY);
  const sky = new Vector3(0, 1, 0);
  const along = new Vector3().crossVectors(sky, wall);
  const lean = Math.sin(board.tilt);
  const stand = Math.cos(board.tilt);
  const out = wall.clone().multiplyScalar(stand).addScaledVector(sky, lean);
  const up = sky.clone().multiplyScalar(stand).addScaledVector(wall, -lean);
  return new Matrix4().makeBasis(along, up, out).setPosition(board.x, board.height, board.y);
}
