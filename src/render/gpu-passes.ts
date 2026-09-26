/**
 * What each pass of a frame costs on the GPU, from WebGPU timestamp queries.
 *
 * `scripts/render-profile.ts --passes` loads this with the profile. A frame is
 * many passes: the sun's shadow cascades, the lamps' shadows, the scene, and
 * each full-screen step of the post chain. The time from submit to done says
 * what the frame cost; this says which pass it went to.
 *
 * three.js writes a pair of timestamps around every render context when the
 * renderer is made with `trackTimestamp`, and keys each by an id. The ids say
 * nothing about the pass, so an inspector is put on the renderer: three.js
 * hands it the scene, the camera and the target of every render context by the
 * same id, and the label is taken from those.
 *
 * The span three.js reports for a pass, its end less its start, is not what
 * the pass cost. A tiled GPU, as in every Apple machine, runs the passes of a
 * frame over each other, and there each span covers most of the frame: a
 * post step starts as soon as it is handed over and waits on the scene. So a
 * pass is given the time it moved the end of the frame's work: its end less
 * the end of the pass that ended before it, or less its own start where the
 * GPU was idle in between. The passes are ordered by when they ended, not by
 * when they were encoded: the post chain's last step is begun before the
 * passes it reads, and draws after them. Those add up to the frame's busy time on any GPU. The raw times
 * are read off the buffer three.js resolves them into, since it keeps only
 * the spans.
 */
import type { Camera, Object3D, RenderTarget, Scene } from 'three';
import { InspectorBase, type WebGPURenderer } from 'three/webgpu';

/** The pool three.js keeps the resolved timestamps in, by render context id. */
interface TimestampPool {
  timestamps: Map<string, number>;
  /** Where each render context's pair of timestamps sits in the query set. */
  queryOffsets: Map<string, number>;
  resultBuffer: GPUBuffer;
}

interface TimestampBackend {
  trackTimestamp: boolean;
  timestampQueryPool: { render: TimestampPool | null; compute: TimestampPool | null };
}

/** Milliseconds of GPU time in one frame, by pass label. */
export type PassTimes = Record<string, number>;

/**
 * The label of one render context. A shadow map says whose, a full-screen
 * step says which material it drew, and a scene pass says where it drew to.
 */
export function passLabel(scene: Object3D, target: RenderTarget | null): string {
  const name = scene.name;
  // three.js names a shadow pass `Shadow Map [ <light> ]`, by the light's name or its id.
  if (name.startsWith('Shadow Map')) return `shadow ${name.slice(name.indexOf('[') + 1, name.lastIndexOf(']')).trim()}`;
  if ((scene as { isQuadMesh?: boolean }).isQuadMesh === true) {
    const material = (scene as unknown as { material?: { name?: string } }).material;
    return `post ${material?.name || target?.texture.name || 'quad'}`;
  }
  const into = target === null ? 'canvas' : target.texture.name || `${target.width}x${target.height}`;
  return `${name || 'scene'} -> ${into}`;
}

/** Names every render context by its timestamp id, as three.js hands them over. */
class PassNames extends InspectorBase {
  readonly labels = new Map<string, string>();

  // three.js hands over a null target for the canvas, whatever its types say.
  override beginRender(uid: string, scene: Scene, _camera: Camera, target: RenderTarget): void {
    this.labels.set(uid, passLabel(scene, target as RenderTarget | null));
  }

  override beginCompute(uid: string): void {
    this.labels.set(uid, 'compute');
  }
}

/**
 * Times the passes of the frames drawn after it is made. The renderer must
 * have been made with `trackTimestamp`; on an adapter without the
 * `timestamp-query` feature `available` is false and every frame reads empty.
 */
export class PassTimer {
  private readonly renderer: WebGPURenderer;
  private readonly names = new PassNames();
  readonly available: boolean;

  /** The raw timestamps of the last resolve, in nanoseconds, copied before three.js unmaps them. */
  private raw: BigUint64Array | undefined;
  private readonly watched = new WeakSet<GPUBuffer>();

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer;
    this.available = (renderer.backend as unknown as TimestampBackend).trackTimestamp;
    renderer.inspector = this.names;
  }

  /**
   * The GPU time of every pass since the last call, summed by label. Call it
   * once a frame, after the GPU has finished the frame.
   */
  async read(): Promise<PassTimes> {
    const times: PassTimes = {};
    if (!this.available) return times;
    const pools = (this.renderer.backend as unknown as TimestampBackend).timestampQueryPool;
    for (const type of ['render', 'compute'] as const) {
      const pool = pools[type];
      if (pool === null) continue;
      this.watch(pool.resultBuffer);
      // Taken before the resolve, which clears them.
      const offsets = [...pool.queryOffsets];
      this.raw = undefined;
      await this.renderer.resolveTimestampsAsync(type);
      const raw = this.raw as BigUint64Array | undefined;
      if (raw === undefined) continue;
      this.addSpans(times, type, spansOf(raw, offsets));
      pool.timestamps.clear();
    }
    this.names.labels.clear();
    return times;
  }

  /**
   * Give each span the time it moved the end of the work, summed into `times`
   * by label. The spans come ordered by their end.
   */
  private addSpans(times: PassTimes, type: string, spans: readonly Span[]): void {
    let last: bigint | undefined;
    for (const { uid, start, end } of spans) {
      const from = last === undefined || start > last ? start : last;
      const label = this.names.labels.get(uid) ?? type;
      times[label] = (times[label] ?? 0) + Number(end > from ? end - from : 0n) / 1e6;
      if (last === undefined || end > last) last = end;
    }
  }

  /** Copy the raw timestamps out of the buffer three.js reads them from, each time it maps it. */
  private watch(buffer: GPUBuffer): void {
    if (this.watched.has(buffer)) return;
    this.watched.add(buffer);
    const getMappedRange = buffer.getMappedRange.bind(buffer);
    buffer.getMappedRange = (offset?: number, size?: number): ArrayBuffer => {
      const range = getMappedRange(offset, size);
      this.raw = new BigUint64Array(range.slice(0));
      return range;
    };
  }
}

/** One render context's pair of timestamps, in nanoseconds. */
interface Span {
  uid: string;
  start: bigint;
  end: bigint;
}

/** The whole spans in `raw`, ordered by when they ended. */
function spansOf(raw: BigUint64Array, offsets: readonly (readonly [string, number])[]): Span[] {
  const spans: Span[] = [];
  for (const [uid, offset] of offsets) {
    const start = raw[offset];
    const end = raw[offset + 1];
    if (start !== undefined && end !== undefined && end >= start) spans.push({ uid, start, end });
  }
  spans.sort((a, b) => compareBig(a.end, b.end));
  return spans;
}

function compareBig(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
