/**
 * The ground the physics stands on, as Rapier colliders: a heightfield per tile
 * of a grid around the player, and the decks of the bridges over it.
 *
 * The grid is anchored on the origin, so a tile is the same tile whenever it is
 * built and two tiles agree along the edge they share. Only the box around the
 * player carries colliders, so the physics streams the way the city does (spec
 * section 9.1); `physics.ts` moves the box as the player moves.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { PARAPET_HEIGHT, type DeckSpan } from '../world/decks.ts';
import type { Surface } from '../world/surface.ts';
import type { Place } from './on-foot.ts';
import type { ParkedCars } from './parked.ts';
import type { AmbientTraffic } from './traffic.ts';

/** Metres each way of one tile of ground the physics holds. */
export const PHYSICS_TILE = 50;

/** Metres between height samples of a tile. Four to a cell of the chunk terrain grid. */
export const PHYSICS_CELL = 2.5;

/** Tiles each way of the player that carry a collider: a 250 m box around the car. */
export const PHYSICS_RADIUS = 2;

/** Height samples each way of one tile. */
const TILE_CELLS = PHYSICS_TILE / PHYSICS_CELL;

/**
 * What the world is, as the physics needs it: how high the ground is at a
 * place, what it is made of, and where the sea stands. `src/world` answers all
 * three; nothing here knows how.
 */
export interface Ground {
  /** The carved height of the ground at a place, in metres. */
  heightAt(x: number, y: number): number;
  /** What the ground is made of there. */
  surfaceAt(x: number, y: number): Surface;
  /** The one level the sea, the straits, the river and the harbour stand at. */
  seaLevel: number;
  /**
   * The decks the roads are carried on, which the heightfield knows nothing
   * about: a bridged segment carves no ground. A world with no bridges, and a
   * test that only needs a hillside, leaves them out.
   */
  decks?: readonly DeckSpan[];
  /**
   * The places the police stations are entered from (spec section 11.7), where
   * an arrest puts the player back. A test that needs none leaves them out.
   */
  stations?: readonly Place[];
  /**
   * The ambient traffic of the roads (spec section 13.1). A test that is not
   * about traffic leaves it out, and nothing drives past.
   */
  traffic?: AmbientTraffic;
  /**
   * The parked cars of the streets and car parks (spec section 13.1). The bays
   * are laid out in the chunk workers, so the game sets this once they answer.
   * Nothing parks where there is no traffic.
   */
  parked?: ParkedCars;
}


/** One tile of ground, and where it stands. */
interface GroundTile {
  cx: number;
  cy: number;
  collider: RAPIER.Collider;
}

/** One deck standing in the world, and the span it was built from. */
interface DeckPiece {
  span: DeckSpan;
  collider: RAPIER.Collider;
}

/** The tiles and decks standing in one Rapier world. */
export class GroundBodies {
  private readonly world: RAPIER.World;
  private readonly ground: Ground;
  private readonly tiles: GroundTile[] = [];
  /** The decks standing in the world, over the same box of ground the tiles cover. */
  private readonly decks: DeckPiece[] = [];

  constructor(world: RAPIER.World, ground: Ground) {
    this.world = world;
    this.ground = ground;
  }

  /** How many tiles of ground carry a collider, which the budget test measures. */
  get count(): number {
    return this.tiles.length;
  }

  /** Forget every collider, for a world that is being freed. */
  clear(): void {
    this.tiles.length = 0;
    this.decks.length = 0;
  }

  /**
   * Make sure every tile within {@link PHYSICS_RADIUS} of a place carries a
   * collider, and drop the ones the player has left behind. The grid is
   * anchored on the origin, so a tile is the same tile whenever it is built.
   */
  cover(x: number, z: number): void {
    const cx = Math.floor(x / PHYSICS_TILE);
    const cy = Math.floor(z / PHYSICS_TILE);
    for (let i = this.tiles.length - 1; i >= 0; i--) {
      const tile = this.tiles[i] as GroundTile;
      if (Math.max(Math.abs(tile.cx - cx), Math.abs(tile.cy - cy)) <= PHYSICS_RADIUS) continue;
      this.world.removeCollider(tile.collider, false);
      this.tiles.splice(i, 1);
    }
    // Row by row and column by column, so the colliders go into the world in
    // the same order however the player reached the place.
    for (let ty = cy - PHYSICS_RADIUS; ty <= cy + PHYSICS_RADIUS; ty++) {
      for (let tx = cx - PHYSICS_RADIUS; tx <= cx + PHYSICS_RADIUS; tx++) {
        if (this.tiles.some((tile) => tile.cx === tx && tile.cy === ty)) continue;
        this.tiles.push({ cx: tx, cy: ty, collider: this.layTile(tx, ty) });
      }
    }
    this.coverDecks(cx, cy);
  }

  /**
   * The decks over the same box of ground the tiles cover. A whole span is laid
   * or dropped at once, however long it is: a bridge the player is halfway
   * across must not end under them.
   */
  private coverDecks(cx: number, cy: number): void {
    const spans = this.ground.decks;
    if (spans === undefined || spans.length === 0) return;
    const minX = (cx - PHYSICS_RADIUS) * PHYSICS_TILE;
    const minY = (cy - PHYSICS_RADIUS) * PHYSICS_TILE;
    const maxX = (cx + PHYSICS_RADIUS + 1) * PHYSICS_TILE;
    const maxY = (cy + PHYSICS_RADIUS + 1) * PHYSICS_TILE;
    const near = (span: DeckSpan): boolean =>
      span.minX <= maxX && span.maxX >= minX && span.minY <= maxY && span.maxY >= minY;
    for (let i = this.decks.length - 1; i >= 0; i--) {
      const deck = this.decks[i] as DeckPiece;
      if (near(deck.span)) continue;
      this.world.removeCollider(deck.collider, false);
      this.decks.splice(i, 1);
    }
    // In the order the world lists them, so the colliders go into the world in
    // the same order however the player reached the place.
    for (const span of spans) {
      if (!near(span)) continue;
      if (this.decks.some((deck) => deck.span === span)) continue;
      this.decks.push({ span, collider: this.layDeck(span) });
    }
  }

  /**
   * One deck as a Rapier trimesh: the strip the road drives on, and a wall up
   * each side of it where the parapet stands. A trimesh has no thickness, which
   * is what the wheels' rays want; the walls are what keep the car on the
   * bridge, as the parapet keeps a driver on it.
   *
   * The world's `y` is Rapier's `z`, as it is for the ground tiles.
   */
  private layDeck(span: DeckSpan): RAPIER.Collider {
    const count = span.points.length;
    const vertices = new Float32Array(count * 4 * 3);
    for (let i = 0; i < count; i++) {
      const p = span.points[i] as DeckSpan['points'][number];
      const ox = p.acrossX * span.halfWidth;
      const oy = p.acrossY * span.halfWidth;
      const corners = [
        [p.x - ox, p.height + PARAPET_HEIGHT, p.y - oy],
        [p.x - ox, p.height, p.y - oy],
        [p.x + ox, p.height, p.y + oy],
        [p.x + ox, p.height + PARAPET_HEIGHT, p.y + oy],
      ];
      for (let c = 0; c < 4; c++) {
        const corner = corners[c] as number[];
        const at = (i * 4 + c) * 3;
        vertices[at] = corner[0] as number;
        vertices[at + 1] = corner[1] as number;
        vertices[at + 2] = corner[2] as number;
      }
    }
    // Three quads per step of the span: the left parapet, the deck, the right
    // parapet. Each is two triangles between one section and the next.
    const indices = new Uint32Array((count - 1) * 3 * 6);
    let at = 0;
    for (let i = 0; i + 1 < count; i++) {
      for (let c = 0; c < 3; c++) {
        const a = i * 4 + c;
        const b = a + 1;
        const d = (i + 1) * 4 + c;
        const e = d + 1;
        indices[at] = a;
        indices[at + 1] = b;
        indices[at + 2] = d;
        indices[at + 3] = b;
        indices[at + 4] = e;
        indices[at + 5] = d;
        at += 6;
      }
    }
    return this.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(1));
  }

  /**
   * One tile of ground as a Rapier heightfield.
   *
   * Rapier lays a heightfield in the XZ plane, centred on the collider, and
   * reads its samples as `heights[j * (rows + 1) + i]`: `i` walks `z` and `j`
   * walks `x`. The far row and column of a tile are the near ones of the next,
   * sampled from the same ground, so the seam between two tiles is flat.
   */
  private layTile(tx: number, ty: number): RAPIER.Collider {
    const heights = new Float32Array((TILE_CELLS + 1) * (TILE_CELLS + 1));
    const x0 = tx * PHYSICS_TILE;
    const y0 = ty * PHYSICS_TILE;
    for (let j = 0; j <= TILE_CELLS; j++) {
      for (let i = 0; i <= TILE_CELLS; i++) {
        heights[j * (TILE_CELLS + 1) + i] = this.ground.heightAt(x0 + j * PHYSICS_CELL, y0 + i * PHYSICS_CELL);
      }
    }
    return this.world.createCollider(
      RAPIER.ColliderDesc.heightfield(TILE_CELLS, TILE_CELLS, heights, {
        x: PHYSICS_TILE,
        y: 1,
        z: PHYSICS_TILE,
      })
        .setTranslation(x0 + PHYSICS_TILE / 2, 0, y0 + PHYSICS_TILE / 2)
        .setFriction(1),
    );
  }
}
