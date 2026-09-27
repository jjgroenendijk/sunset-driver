import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Scene, type Object3D } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { ChunkTiles, type TileSceneries } from '../../../src/render/streaming/chunk-tiles.ts';
import type { ChunkPayload } from '../../../src/render/streaming/chunk-payload.ts';
import type { ChunkStream } from '../../../src/render/streaming/chunk-pool.ts';
import type { ChunkDetail, TilePart } from '../../../src/render/streaming/streaming.ts';
import { FULL_TIER } from '../../../src/render/frame/quality.ts';

/** A block batch that fills in `steps` steps, as a batch of `batch.ts` does. */
function blockPart(steps: number): TilePart {
  const mesh = new Mesh(undefined, new MeshBasicMaterial());
  return { objects: [mesh], drawCalls: 1, steps: Array.from({ length: steps }, () => () => {}), dispose: () => {} };
}

/** The sceneries a tile is built with: blocks only, which is all these chunks hold. */
const kit = {
  ground: new MeshStandardNodeMaterial(),
  buildings: { build: () => blockPart(3) },
  lampLights: { invalidate: () => {} },
} as unknown as TileSceneries;

/** A chunk at the origin, of one block batch, at a detail. */
function payload(detail: ChunkDetail): ChunkPayload {
  return {
    cx: 0,
    cy: 0,
    detail,
    bounds: { minX: 0, minY: 0, maxX: 250, maxY: 250 },
    ground: {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      tints: new Float32Array(9),
      covers: new Float32Array(3),
      coverTints: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
    },
    roads: [],
    facades: [],
    blocks: [{}],
    roofs: new Float32Array(0),
    plants: { models: [] },
    lamps: [],
    posters: [],
    metro: [],
    signs: [],
  } as unknown as ChunkPayload;
}

/** A stream that hands over what it is given, once. */
function streamOf(queue: ChunkPayload[]): ChunkStream {
  return { want: () => {}, take: () => queue.shift(), pending: 0, dispose: () => {} } as ChunkStream;
}

/** Whether the renderer would draw an object: it and every parent up to the scene are visible. */
function shown(object: Object3D, scene: Scene): boolean {
  for (let at: Object3D | null = object; at !== null; at = at.parent) {
    if (!at.visible) return false;
    if (at === scene) return true;
  }
  return false;
}

/** The meshes of the scene that stand for buildings, drawn or not. */
function blocks(scene: Scene): Mesh[] {
  const out: Mesh[] = [];
  scene.traverse((object) => {
    if (object instanceof Mesh && object.material instanceof MeshBasicMaterial) out.push(object);
  });
  return out;
}

describe('a chunk swapped for another detail', () => {
  it('keeps the old buildings drawn until every piece of the new ones is in', () => {
    const scene = new Scene();
    const tiles = new ChunkTiles(scene, kit, () => FULL_TIER);
    const queue: ChunkPayload[] = [payload('mid')];
    const stream = streamOf(queue);
    // A clock that moves on every reading, against a budget of nothing, runs one job a frame.
    let clock = 0;
    const frame = (): void => tiles.follow(stream, 10, 10, 0, () => clock++);
    for (let i = 0; i < 20; i++) frame();
    expect(tiles.drawnAt(10, 10)).toBe('late');
    const [old] = blocks(scene);
    expect(old !== undefined && shown(old, scene)).toBe(true);

    queue.push(payload('near'));
    let frames = 0;
    while (tiles.drawnAt(10, 10) !== 'whole' && frames < 50) {
      frame();
      frames++;
      const drawn = blocks(scene).filter((mesh) => shown(mesh, scene));
      // One set of buildings stands in sight on every frame of the swap, never none and never both.
      expect(drawn).toHaveLength(1);
    }
    expect(tiles.drawnAt(10, 10)).toBe('whole');
    expect(frames).toBeGreaterThan(3);
    expect(blocks(scene)).toHaveLength(1);
    expect(blocks(scene)[0]).not.toBe(old);
  });
});
