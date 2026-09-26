/**
 * The turf on the map (spec sections 12, 17.2): who holds which block, washed
 * over the land and under the icons.
 *
 * It is drawn through the overlay slot `map-draw.ts` already carries, so the
 * corner map and the full map show one thing. The canvas is handed over in
 * world metres, so a block is drawn where it stands and nothing here projects.
 *
 * Only the blocks the view can show are walked, and only the blocks with a
 * holder are filled, so a whole-world view of a city that nobody has taken is a
 * few hundred rectangles and a session in the backwoods is none.
 *
 * The boundary is what makes the wash readable: a block's edge is stroked only
 * where the block over it belongs to somebody else, so a faction's ground is
 * one outlined shape rather than a grid of squares.
 */
import { blockAt, holderColour, BLOCK_SIZE, NOBODY, type TerritoryMap } from '../../sim/crime/territory.ts';
import type { SimState } from '../../sim/simulation.ts';
import type { MapBounds, MapView } from './map.ts';

/** How much of the holder's colour the ground is washed in. */
const WASH = 0.22;

/** How much of it the boundary is stroked in, and how wide in pixels. */
const EDGE = 0.85;
const EDGE_PEN = 1.6;

/** The block being fought over is hatched in this, over the wash (spec section 17.2). */
const CONTESTED = '#ffffff';

/** Past this many metres to the pixel the boundary is not stroked: it would be a smear. */
const EDGE_SCALE = 12;

/**
 * The overlay of one session. It holds the turf map and reads the record on
 * every frame the map redraws, because a block changes hands mid-session and a
 * list built once would be wrong the moment it was.
 */
export class TerritoryOverlay {
  private readonly map: TerritoryMap;
  private readonly state: SimState;

  constructor(map: TerritoryMap, state: SimState) {
    this.map = map;
    this.state = state;
  }

  /** The overlay slot of `MapDrawOptions`: the canvas is already in world metres. */
  draw = (ctx: CanvasRenderingContext2D, view: MapView, bounds: MapBounds): void => {
    const bx0 = Math.floor(bounds.minX / BLOCK_SIZE);
    const bx1 = Math.floor(bounds.maxX / BLOCK_SIZE);
    const by0 = Math.floor(bounds.minY / BLOCK_SIZE);
    const by1 = Math.floor(bounds.maxY / BLOCK_SIZE);
    const state = this.state;
    const takeover = state.factions.takeover;
    ctx.save();
    ctx.globalAlpha = WASH;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const holder = this.map.holderAt(state, bx, by);
        if (holder === NOBODY) continue;
        ctx.fillStyle = holderColour(holder);
        ctx.fillRect(bx * BLOCK_SIZE, by * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
      }
    }
    if (view.metresPerPixel <= EDGE_SCALE) this.strokeEdges(ctx, view, bx0, bx1, by0, by1);
    // The block being taken is called out over the wash, because it is the one
    // block on the map the player is being shot at over.
    if (takeover !== null) {
      const at = blockAt(takeover.block);
      ctx.globalAlpha = EDGE;
      ctx.strokeStyle = CONTESTED;
      ctx.lineWidth = EDGE_PEN * 2 * view.metresPerPixel;
      ctx.setLineDash([10 * view.metresPerPixel, 7 * view.metresPerPixel]);
      ctx.strokeRect(at.bx * BLOCK_SIZE, at.by * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
      ctx.setLineDash([]);
    }
    ctx.restore();
  };

  /**
   * The boundary of each holding: the side of a block is stroked only where its
   * neighbour is somebody else's, so what the player reads is a border and not
   * a grid.
   */
  private strokeEdges(
    ctx: CanvasRenderingContext2D,
    view: MapView,
    bx0: number,
    bx1: number,
    by0: number,
    by1: number,
  ): void {
    ctx.globalAlpha = EDGE;
    ctx.lineWidth = EDGE_PEN * view.metresPerPixel;
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const holder = this.map.holderAt(this.state, bx, by);
        if (holder === NOBODY) continue;
        ctx.strokeStyle = holderColour(holder);
        ctx.beginPath();
        this.traceBorders(ctx, bx, by, holder);
        ctx.stroke();
      }
    }
  }

  /** Trace the sides of block (`bx`, `by`) whose neighbour is not `holder`'s too. */
  private traceBorders(ctx: CanvasRenderingContext2D, bx: number, by: number, holder: number): void {
    const x = bx * BLOCK_SIZE;
    const y = by * BLOCK_SIZE;
    if (this.map.holderAt(this.state, bx, by - 1) !== holder) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + BLOCK_SIZE, y);
    }
    if (this.map.holderAt(this.state, bx, by + 1) !== holder) {
      ctx.moveTo(x, y + BLOCK_SIZE);
      ctx.lineTo(x + BLOCK_SIZE, y + BLOCK_SIZE);
    }
    if (this.map.holderAt(this.state, bx - 1, by) !== holder) {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + BLOCK_SIZE);
    }
    if (this.map.holderAt(this.state, bx + 1, by) !== holder) {
      ctx.moveTo(x + BLOCK_SIZE, y);
      ctx.lineTo(x + BLOCK_SIZE, y + BLOCK_SIZE);
    }
  }
}
