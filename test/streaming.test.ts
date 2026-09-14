import { Matrix4, MeshBasicMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { batchOfPacked } from '../src/render/batch.ts';
import { CHUNK_DRAW_CALL_CAP, chunkDrawCalls } from '../src/render/chunk-cost.ts';
import {
  buildChunkPayload,
  chunkLookups,
  payloadTransfers,
  unpackGeometry,
  type ChunkPayload,
} from '../src/render/chunk-payload.ts';
import { ChunkPool, type ChunkStream, type ChunkWorker } from '../src/render/chunk-pool.ts';
import type { WorkerCommand, WorkerReply } from '../src/render/chunk-worker.ts';
import { FULL_TIER, QUALITY_TIERS, type QualityTier } from '../src/render/quality.ts';
import {
  detailAt,
  FAR_RADIUS,
  NEAR_RADIUS,
  FACADE_RADIUS,
  spendBudget,
  STREAM_BUDGET_MS,
  wantedChunks,
  type ChunkDetail,
  type ChunkWant,
} from '../src/render/streaming.ts';
import { WorldScene } from '../src/render/world-scene.ts';
import { DEFAULT_APPEARANCE } from '../src/sim/character.ts';
import { buildLayers, chunkAt, ChunkSource, CHUNK_SIZE } from '../src/world/chunks.ts';
import { Heightfield } from '../src/world/heightfield.ts';
import type { District, RoadCurve, WorldDescription, Zone } from '../src/world/types.ts';

const SIZE = 1000;
const CELL = 10;
/** Metres between the streets of the hand-built grid. */
const BLOCK = 200;

function district(id: number, zone: Zone, x: number, y: number): District {
  return { id, name: `D${id}`, zone, x, y, density: 0.5, wealth: 0.5, culture: 'none' };
}

function curve(id: number, tier: RoadCurve['tier'], coords: readonly [number, number][]): RoadCurve {
  return { id, tier, points: coords.map(([x, y]) => ({ x, y })), bridges: [], tunnels: [], interchanges: [] };
}

/**
 * A hand-built world: a flat island under a grid of streets with one arterial
 * across it, so the streaming can be checked without generating a world. The
 * arterial is what tells the two details apart — the far ring keeps it and
 * drops the streets.
 */
function gridWorld(): WorldDescription {
  const gridSize = SIZE / CELL + 1;
  const hf = Heightfield.create(gridSize, CELL);
  for (let iy = 0; iy < gridSize; iy++) {
    for (let ix = 0; ix < gridSize; ix++) hf.set(ix, iy, 20 + hf.worldX(ix) * 0.01);
  }
  const roads: RoadCurve[] = [];
  const line = -2 * BLOCK;
  for (let i = 0; i <= 4; i++) {
    const at = line + i * BLOCK;
    roads.push(curve(roads.length, 'street', [[at, line], [at, -line]]));
    roads.push(curve(roads.length, 'street', [[line, at], [-line, at]]));
  }
  roads.push(curve(roads.length, 'arterial', [[line, 100], [-line, 100]]));
  return {
    seed: 11,
    size: SIZE,
    archetype: 'archipelago',
    core: { x: 0, y: 0 },
    terrain: hf.toData(),
    water: {
      seaLevel: 0,
      islands: [{ id: 0, x: 0, y: 0, radius: SIZE / 2, main: true }],
      crossings: [],
      river: { path: [], halfWidths: [] },
      harbour: { x: 0, y: 0, radius: 10 },
    },
    districts: [district(0, 'inner', 0, 0), district(1, 'suburban', 300, 300)],
    beaches: [],
    roads,
    corridors: [],
    tram: { route: [], corridors: [], stops: [], crossings: [], length: 0 },
  };
}

const world = gridWorld();
const layers = buildLayers(world);
const source = new ChunkSource(world, layers);
const lookups = chunkLookups(world, layers);

/** The chunk on the middle of the grid, which holds roads, buildings and plants. */
const MIDDLE = chunkAt(0, 0);

/** Every payload built so far, by chunk and detail. */
const payloads = new Map<string, ChunkPayload>();

/**
 * The payload of a chunk, as a worker would hand it over. Driving the scene
 * about asks for the same chunks again and again, and building one is most of
 * what these tests cost, so each is built once. What goes out is a copy: a
 * test that transfers the buffers detaches the ones it was given, and the
 * scene releases what it uploads.
 */
function payloadOf(cx: number, cy: number, detail: ChunkDetail): ChunkPayload {
  const key = `${cx},${cy},${detail}`;
  let payload = payloads.get(key);
  if (payload === undefined) {
    payload = buildChunkPayload(source.chunk(cx, cy), lookups, detail);
    payloads.set(key, payload);
  }
  return structuredClone(payload);
}

describe('the rings around the player', () => {
  it('asks for the near ring in full and the far ring behind it', () => {
    const wants = wantedChunks(3, -2);
    const near = wants.filter((want) => want.detail === 'near');
    const mid = wants.filter((want) => want.detail === 'mid');
    const far = wants.filter((want) => want.detail === 'far');
    // Only the chunks nearest the player carry generated facades; the rest of
    // the near ring builds its buildings as blocks.
    expect(near).toHaveLength((FACADE_RADIUS * 2 + 1) ** 2);
    expect(near.length + mid.length).toBe((NEAR_RADIUS * 2 + 1) ** 2);
    expect(mid.length).toBeGreaterThan(0);
    expect(wants).toHaveLength((FAR_RADIUS * 2 + 1) ** 2);
    expect(far.length).toBeGreaterThan(0);
    // Every chunk is asked for once, and the player's own chunk is one of them.
    expect(new Set(wants.map((want) => `${want.cx},${want.cy}`)).size).toBe(wants.length);
    expect(wants[0]).toEqual({ cx: 3, cy: -2, detail: 'near' });
  });

  it('asks for the nearest chunk first, so the ground ahead is built before the ground behind', () => {
    const wants = wantedChunks(0, 0);
    const reach = wants.map((want) => want.cx * want.cx + want.cy * want.cy);
    for (let i = 1; i < reach.length; i++) expect(reach[i]).toBeGreaterThanOrEqual(reach[i - 1] as number);
    // A chunk is never asked for after one at a simpler detail.
    const details = wants.map((want) => want.detail);
    expect(details.lastIndexOf('near')).toBeLessThan(details.indexOf('mid'));
    expect(details.lastIndexOf('mid')).toBeLessThan(details.indexOf('far'));
  });

  it('says which detail a chunk stands at, and drops it past the far ring', () => {
    expect(detailAt(0, 0, 0, 0)).toBe('near');
    expect(detailAt(FACADE_RADIUS, 0, 0, 0)).toBe('near');
    expect(detailAt(FACADE_RADIUS + 1, 0, 0, 0)).toBe('mid');
    expect(detailAt(NEAR_RADIUS, 0, 0, 0)).toBe('mid');
    expect(detailAt(NEAR_RADIUS + 1, 0, 0, 0)).toBe('far');
    expect(detailAt(0, FAR_RADIUS, 0, 0)).toBe('far');
    expect(detailAt(0, FAR_RADIUS + 1, 0, 0)).toBeUndefined();
  });

  it('never carries facades past the near ring of a quality tier', () => {
    for (const tier of QUALITY_TIERS) {
      for (let ring = 0; ring <= tier.rings.far; ring++) {
        const detail = detailAt(ring, 0, 0, 0, tier.rings);
        if (ring > tier.rings.near) expect(detail, `${tier.name} ring ${ring}`).toBe('far');
        else expect(detail, `${tier.name} ring ${ring}`).not.toBe('far');
      }
    }
  });
});

describe('the frame budget', () => {
  it('is the whole of the streaming slice of the frame', () => {
    // Spec section 2.4 gives streaming 2 ms of the 16 ms frame.
    expect(STREAM_BUDGET_MS).toBe(2);
  });

  it('runs what fits and leaves the rest for the next frame', () => {
    let clock = 0;
    const now = (): number => clock;
    const ran: number[] = [];
    // Four jobs of one millisecond each, against a budget of two.
    const queue = [0, 1, 2, 3].map((i) => () => {
      ran.push(i);
      clock += 1;
    });
    expect(spendBudget(queue, 2, now)).toBe(2);
    expect(ran).toEqual([0, 1]);
    expect(queue).toHaveLength(2);
    expect(spendBudget(queue, 2, now)).toBe(2);
    expect(ran).toEqual([0, 1, 2, 3]);
    expect(spendBudget(queue, 2, now)).toBe(0);
  });

  it('always runs one job, so a job dearer than the budget still lands', () => {
    let clock = 0;
    const queue = [
      () => {
        clock += 40;
      },
    ];
    expect(spendBudget(queue, 2, () => clock)).toBe(1);
    expect(queue).toHaveLength(0);
  });
});

describe('a chunk as a payload', () => {
  it('carries everything the chunk draws, and says what it will cost', () => {
    const chunk = source.chunk(MIDDLE.cx, MIDDLE.cy);
    const payload = payloadOf(MIDDLE.cx, MIDDLE.cy, 'near');
    expect(payload.detail).toBe('near');
    expect(payload.ground.positions.length).toBeGreaterThan(0);
    expect(payload.roads.length).toBeGreaterThan(0);
    expect(payload.blocks.parts.length + payload.facades.parts.length).toBe(chunk.buildings.length);
    expect(payload.outlines.parts).toHaveLength(chunk.buildings.length);
    // The cost of a chunk is answered off the chunk alone, before any geometry
    // is built; the payload is what that answer is checked against.
    expect(payload.drawCalls).toBe(chunkDrawCalls(chunk));
    expect(payload.drawCalls).toBeLessThanOrEqual(CHUNK_DRAW_CALL_CAP);
  });

  it('builds every building as a block at mid detail, and keeps the rest of the near chunk', () => {
    const near = payloadOf(MIDDLE.cx, MIDDLE.cy, 'near');
    const mid = payloadOf(MIDDLE.cx, MIDDLE.cy, 'mid');
    expect(mid.facades.parts).toHaveLength(0);
    expect(mid.blocks.parts.length).toBe(near.facades.parts.length + near.blocks.parts.length);
    expect(mid.outlines.parts).toHaveLength(near.outlines.parts.length);
    expect(mid.ground.gridSize).toBe(near.ground.gridSize);
    expect(mid.roads.map((tier) => tier.tier)).toEqual(near.roads.map((tier) => tier.tier));
    expect(mid.plants.models).toEqual(near.plants.models);
    expect(mid.lamps).toEqual(near.lamps);
    expect(mid.drawCalls).toBeLessThanOrEqual(near.drawCalls);
  });

  it('drops the detail the far ring cannot read', () => {
    const near = payloadOf(MIDDLE.cx, MIDDLE.cy, 'near');
    const far = payloadOf(MIDDLE.cx, MIDDLE.cy, 'far');
    // The ground and the massing hold the skyline up; everything else goes.
    // The far ground is the same ground on the skeleton's coarser grid, so it
    // costs a sixteenth of the near ground and joins it along the same edges.
    expect(far.ground.gridSize).toBe((near.ground.gridSize - 1) / 4 + 1);
    expect(far.ground.positions[(far.ground.gridSize * far.ground.gridSize - 1) * 3]).toBe(
      near.ground.positions[(near.ground.gridSize * near.ground.gridSize - 1) * 3],
    );
    expect(far.blocks.parts.length).toBe(near.facades.parts.length + near.blocks.parts.length);
    expect(far.facades.parts).toHaveLength(0);
    // The outline stays: it is what the skyline reads by.
    expect(far.outlines.parts).toHaveLength(far.blocks.parts.length);
    expect(far.plants.models).toHaveLength(0);
    expect(near.plants.models.length).toBeGreaterThan(0);
    expect(far.lamps).toHaveLength(0);
    expect(near.lamps.length).toBeGreaterThan(0);
    expect(far.roads.map((tier) => tier.tier)).toEqual(['arterial']);
    expect(near.roads.map((tier) => tier.tier)).toContain('street');
    for (const tier of far.roads) expect(tier.markings).toHaveLength(0);
    expect(far.drawCalls).toBeLessThan(near.drawCalls);
  });

  it('hands over every buffer once, and comes back the same on the other side', () => {
    const payload = payloadOf(MIDDLE.cx, MIDDLE.cy, 'near');
    const before = (payload.roads[0]?.surface.parts[0]?.geometry.attributes[0]?.array as Float32Array).slice();
    const transfers = payloadTransfers(payload);
    expect(new Set(transfers).size).toBe(transfers.length);
    expect(transfers).toContain(payload.ground.positions.buffer);
    expect(transfers).toContain(payload.plants.matrices.buffer);
    expect(transfers).toContain(payload.roads[0]?.surface.storage.attributes[0]?.array.buffer);

    // What `postMessage` does to a payload, without a worker to do it.
    const copy = structuredClone(payload, { transfer: transfers }) as ChunkPayload;
    expect(copy.drawCalls).toBe(payload.drawCalls);
    const geometry = unpackGeometry(copy.roads[0]?.surface.parts[0]?.geometry as never);
    expect(geometry.getAttribute('position').array).toEqual(before);
    expect(geometry.getIndex()).not.toBeNull();
  });

  it('packs a batch of buildings out of a payload, every part of it in world places', () => {
    const payload = payloadOf(MIDDLE.cx, MIDDLE.cy, 'near');
    const material = new MeshBasicMaterial();
    const firstPart = payload.outlines.parts[0]?.geometry.attributes.find((attribute) => attribute.name === 'position');
    const firstPositions = (firstPart?.array as Float32Array).slice();
    const batch = batchOfPacked(payload.outlines, material);
    expect(batch.parts).toBe(payload.outlines.parts.length);
    expect(batch.visible).toBe(true);
    // The batch is merged into the storage the worker allocated. A batch that
    // allocated its own would do it on the frame thread, in one step.
    const storage = payload.outlines.storage.attributes.find((attribute) => attribute.name === 'position')?.array;
    const positions = batch.geometry.getAttribute('position').array as Float32Array;
    expect(positions).toBe(storage);
    expect(batch.geometry.getIndex()?.array).toBe(payload.outlines.storage.index);
    expect(batch.geometry.drawRange.count).toBe(positions.length / 3);
    // The first part stands at the start of that storage, moved by its own
    // frame: a merged batch holds each part where it stands in the world, and
    // not at the origin of the frame it was built in.
    const stood = new Matrix4().fromArray(payload.outlines.parts[0]?.matrix as Float32Array);
    let complaint: string | undefined;
    for (let v = 0; v < firstPositions.length / 3; v++) {
      const wanted = new Vector3(
        firstPositions[v * 3] as number,
        firstPositions[v * 3 + 1] as number,
        firstPositions[v * 3 + 2] as number,
      ).applyMatrix4(stood);
      const here = new Vector3(positions[v * 3] as number, positions[v * 3 + 1] as number, positions[v * 3 + 2] as number);
      if (here.distanceTo(wanted) > 1e-3) complaint ??= `vertex ${v} stands at ${here.toArray()}, not ${wanted.toArray()}`;
    }
    expect(complaint).toBeUndefined();
    // The bounds are what the view culls a chunk by, so they hold its buildings.
    const bounds = batch.geometry.boundingBox;
    expect(bounds?.min.x).toBeGreaterThanOrEqual(payload.bounds.minX - 50);
    expect(bounds?.max.x).toBeLessThanOrEqual(payload.bounds.maxX + 50);
    batch.dispose();
    material.dispose();
  });
});

/** A worker that answers when the test tells it to. */
class FakeWorker implements ChunkWorker {
  readonly orders: WorkerCommand[] = [];
  terminated = false;
  private listener: (reply: WorkerReply) => void = () => {};

  post(command: WorkerCommand): void {
    this.orders.push(command);
  }

  onReply(listener: (reply: WorkerReply) => void): void {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The layers are built: the worker is free to take chunks. */
  ready(): void {
    this.listener({ type: 'ready' });
  }

  /** Answer the chunk it was last given. */
  answer(): void {
    const order = [...this.orders].reverse().find((command) => command.type === 'chunk');
    if (order === undefined || order.type !== 'chunk') throw new Error('the worker was given no chunk');
    this.listener({ type: 'chunk', payload: payloadOf(order.cx, order.cy, order.detail) });
    this.listener({ type: 'ready' });
  }

  /** The chunks it has been given, in order. */
  get chunks(): ChunkWant[] {
    return this.orders.filter((command) => command.type === 'chunk').map((command) => command);
  }
}

/** A pool over two workers the test drives by hand. */
function pooled(): { pool: ChunkPool; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const pool = new ChunkPool(
    world,
    () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    2,
  );
  return { pool, workers };
}

describe('the pool of chunk workers', () => {
  it('sends every worker the world and waits for it to be ready', () => {
    const { pool, workers } = pooled();
    expect(workers).toHaveLength(2);
    for (const worker of workers) expect(worker.orders[0]).toEqual({ type: 'start', world });

    // Nothing is handed out before a worker says its layers are built.
    pool.want([{ cx: 0, cy: 0, detail: 'near' }]);
    expect(workers[0]?.chunks).toHaveLength(0);
    workers[0]?.ready();
    expect(workers[0]?.chunks).toEqual([{ type: 'chunk', cx: 0, cy: 0, detail: 'near' }]);
    pool.dispose();
    for (const worker of workers) expect(worker.terminated).toBe(true);
  });

  it('keeps both workers busy and never gives one chunk to two of them', () => {
    const { pool, workers } = pooled();
    for (const worker of workers) worker.ready();
    pool.want([
      { cx: 0, cy: 0, detail: 'near' },
      { cx: 1, cy: 0, detail: 'near' },
      { cx: 2, cy: 0, detail: 'near' },
    ]);
    expect(workers[0]?.chunks).toHaveLength(1);
    expect(workers[1]?.chunks).toHaveLength(1);
    // The third chunk waits for whichever worker finishes first.
    expect(pool.pending).toBe(3);
    workers[0]?.answer();
    expect(workers[0]?.chunks).toHaveLength(2);
    const asked = [...(workers[0]?.chunks ?? []), ...(workers[1]?.chunks ?? [])];
    expect(new Set(asked.map((want) => `${want.cx},${want.cy}`)).size).toBe(3);
    pool.dispose();
  });

  it('asks again for nothing it is already building', () => {
    const { pool, workers } = pooled();
    workers[0]?.ready();
    const wants: ChunkWant[] = [{ cx: 0, cy: 0, detail: 'near' }];
    pool.want(wants);
    pool.want(wants);
    pool.want(wants);
    expect(workers[0]?.chunks).toHaveLength(1);
    pool.dispose();
  });

  it('forgets a chunk the player drove away from before a worker started on it', () => {
    const { pool, workers } = pooled();
    workers[0]?.ready();
    pool.want([
      { cx: 0, cy: 0, detail: 'near' },
      { cx: 9, cy: 9, detail: 'far' },
    ]);
    // The second chunk is still in the queue: one worker is ready and it took
    // the first. Asking for a different list drops it.
    pool.want([{ cx: 0, cy: 0, detail: 'near' }]);
    workers[0]?.answer();
    expect(workers[0]?.chunks.map((want) => `${want.cx},${want.cy}`)).toEqual(['0,0']);
    pool.dispose();
  });

  it('throws away a chunk that arrives after nobody wants it', () => {
    const { pool, workers } = pooled();
    workers[0]?.ready();
    pool.want([{ cx: 0, cy: 0, detail: 'near' }]);
    // The player drives out of reach while the worker is building.
    pool.want([{ cx: 40, cy: 40, detail: 'near' }]);
    workers[0]?.answer();
    expect(pool.take()).toBeUndefined();
    pool.dispose();
  });

  it('hands over what arrived and counts what is still coming', () => {
    const { pool, workers } = pooled();
    workers[0]?.ready();
    pool.want([{ cx: 0, cy: 0, detail: 'near' }]);
    expect(pool.pending).toBe(1);
    workers[0]?.answer();
    expect(pool.pending).toBe(1);
    const payload = pool.take();
    expect(payload?.cx).toBe(0);
    expect(pool.pending).toBe(0);
    expect(pool.take()).toBeUndefined();
    pool.dispose();
  });
});

/** A stream that answers out of the hand-built world, as many chunks a frame as asked. */
class DirectStream implements ChunkStream {
  readonly asked: ChunkWant[] = [];
  private queue: ChunkWant[] = [];
  private left = 0;

  constructor(private readonly perFrame = Infinity) {}

  want(wants: readonly ChunkWant[]): void {
    this.queue = [...wants];
    this.asked.push(...wants);
    this.left = this.perFrame;
  }

  take(): ChunkPayload | undefined {
    if (this.left <= 0) return undefined;
    const want = this.queue.shift();
    if (want === undefined) return undefined;
    this.left--;
    return payloadOf(want.cx, want.cy, want.detail);
  }

  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.queue = [];
  }
}

/** A clock that moves one millisecond every time it is read. */
function tickingClock(): () => number {
  let clock = 0;
  return () => ++clock;
}

describe('the scene as the player drives', () => {
  it('spreads the upload of a chunk over frames and never loses a piece of it', () => {
    const stream = new DirectStream(1);
    const scene = new WorldScene(world, DEFAULT_APPEARANCE, stream);
    const now = tickingClock();
    // The first frame asks; the second takes one chunk and starts uploading it.
    scene.update(0, 0, STREAM_BUDGET_MS, now);
    scene.update(0, 0, STREAM_BUDGET_MS, now);
    const started = scene.scene.children.length;
    expect(scene.streaming).toBeGreaterThan(0);

    let frames = 0;
    while (scene.streaming > 0 && frames < 5000) {
      scene.update(0, 0, STREAM_BUDGET_MS, now);
      frames++;
    }
    // Every chunk of both rings ends up in the scene, a piece at a time.
    expect(scene.streaming).toBe(0);
    expect(scene.scene.children.length).toBeGreaterThan(started);
    expect(frames).toBeGreaterThan((FAR_RADIUS * 2 + 1) ** 2);
    expect(scene.drawCallsPerChunk).toBeGreaterThan(0);
    expect(scene.drawCallsPerChunk).toBeLessThanOrEqual(CHUNK_DRAW_CALL_CAP);
    scene.dispose();
  });

  it('drops what falls out of reach and puts back what comes into it', async () => {
    const stream = new DirectStream();
    const scene = new WorldScene(world, DEFAULT_APPEARANCE, stream);
    // The scene before a chunk is in it: the sea, the sun, the sky and the player.
    const bare = scene.scene.children.length;
    await scene.settle(0, 0);
    const filled = scene.scene.children.length;
    expect(filled).toBeGreaterThan(bare);

    // Far enough away that not one chunk of the first stand is still wanted.
    const away = (FAR_RADIUS * 2 + 2) * CHUNK_SIZE;
    scene.update(away, away);
    // The old chunks are gone at once; the new ones are still being built.
    expect(scene.scene.children.length).toBeLessThan(filled);
    await scene.settle(away, away);
    // Open sea past the edge of the map: one ground mesh a chunk and nothing on it.
    expect(scene.scene.children.length).toBe(bare + (FAR_RADIUS * 2 + 1) ** 2);

    // Driving back builds the same city again, piece for piece.
    await scene.settle(0, 0);
    expect(scene.scene.children.length).toBe(filled);
    scene.dispose();
  });

  it('rebuilds a chunk at its new detail when it crosses into the near ring', async () => {
    const stream = new DirectStream();
    const scene = new WorldScene(world, DEFAULT_APPEARANCE, stream);
    // Stand so the chunk of the grid is in the far ring, then drive to it.
    const away = (NEAR_RADIUS + 1) * CHUNK_SIZE;
    await scene.settle(away, 0);
    const asFar = stream.asked.filter((want) => want.cx === 0 && want.cy === 0);
    expect(asFar.every((want) => want.detail === 'far')).toBe(true);

    await scene.settle(0, 0);
    const asNear = stream.asked.filter((want) => want.cx === 0 && want.cy === 0 && want.detail === 'near');
    expect(asNear.length).toBeGreaterThan(0);
    scene.dispose();
  });

  it('pulls the rings in with the quality tier and drops what falls outside them', async () => {
    const stream = new DirectStream();
    const scene = new WorldScene(world, DEFAULT_APPEARANCE, stream);
    expect(scene.quality).toBe(FULL_TIER);
    await scene.settle(0, 0);
    const atFull = scene.scene.children.length;

    const low = QUALITY_TIERS[QUALITY_TIERS.length - 1] as QualityTier;
    scene.quality = low;
    stream.asked.length = 0;
    await scene.settle(0, 0);

    // The far ring is nearer, so the city the scene holds is smaller.
    expect(scene.scene.children.length).toBeLessThan(atFull);
    for (const want of stream.asked) {
      expect(Math.max(Math.abs(want.cx), Math.abs(want.cy))).toBeLessThanOrEqual(low.rings.far);
    }
    // A chunk that stood at full detail is asked for again as massing, since
    // the near ring no longer reaches it.
    const crossed = stream.asked.filter((want) => want.cx === NEAR_RADIUS && want.cy === 0);
    expect(crossed.length).toBeGreaterThan(0);
    for (const want of crossed) expect(want.detail).toBe('far');

    // Back at full quality the city comes back whole, piece for piece.
    scene.quality = FULL_TIER;
    await scene.settle(0, 0);
    expect(scene.scene.children.length).toBe(atFull);
    scene.dispose();
  });

  it('gives up rather than waiting for ever on a worker that never answers', async () => {
    const silent: ChunkStream = {
      want: () => {},
      take: () => undefined,
      pending: 1,
      dispose: () => {},
    };
    const scene = new WorldScene(world, DEFAULT_APPEARANCE, silent);
    await expect(scene.settle(0, 0, 1, 5)).rejects.toThrow('chunks outstanding');
    scene.dispose();
  });
});
