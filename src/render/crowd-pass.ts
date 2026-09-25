/**
 * People passing each other on a pavement (spec sections 13.1, 20.1).
 *
 * Every person walks a lane of their own, most of them on the right, so two
 * walking at each other mostly pass already. Some keep left, and company walks
 * abreast; when two of them meet head on, each steps a little to their own
 * right for the moment they pass, and back.
 *
 * This is drawing only. A person of the crowd is a function of the tick and
 * reads nobody else (`pedestrians.ts`), and the step is a few tens of
 * centimetres, less than anything the simulation measures a person by.
 */

/** Metres apart two people start to step aside for each other. */
const PASS_REACH = 1.8;

/** Metres a person steps aside at most. */
export const PASS_STEP = 0.32;

/** Cosine of the angle between two headings under which two people walk at each other. */
const HEAD_ON = -0.5;

/** The walkers of one frame, and the step each takes. The caller fills the first `count`. */
export class CrowdPass {
  count = 0;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly heading: Float64Array;
  /** The instance each one was written to. */
  readonly index: Int32Array;
  /** Metres right of their way each steps, written by {@link solve}. */
  readonly step: Float64Array;
  private readonly order: number[] = [];

  constructor(cap: number) {
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.heading = new Float64Array(cap);
    this.index = new Int32Array(cap);
    this.step = new Float64Array(cap);
  }

  /** Take a walker. Returns false once the pass is full. */
  add(x: number, y: number, heading: number, index: number): boolean {
    if (this.count >= this.x.length) return false;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.heading[i] = heading;
    this.index[i] = index;
    return true;
  }

  /** Work out each walker's step, from everyone walking at them within {@link PASS_REACH}. */
  solve(): void {
    const n = this.count;
    const { x, y, heading, step, order } = this;
    step.fill(0, 0, n);
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    // Sorted along x, so each walker is held against only the ones within reach of it along x.
    order.sort((a, b) => (x[a] as number) - (x[b] as number));
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi] as number;
      const ci = Math.cos(heading[i] as number);
      const si = Math.sin(heading[i] as number);
      for (let oj = oi + 1; oj < n; oj++) {
        const j = order[oj] as number;
        const dx = (x[j] as number) - (x[i] as number);
        if (dx > PASS_REACH) break;
        const dy = (y[j] as number) - (y[i] as number);
        const gap = Math.hypot(dx, dy);
        if (gap >= PASS_REACH || gap < 1e-6) continue;
        const cj = Math.cos(heading[j] as number);
        const sj = Math.sin(heading[j] as number);
        if (ci * cj + si * sj > HEAD_ON) continue;
        // Only while each is still ahead of the other, fading as they draw level, so they drift back once past.
        const ahead = Math.min((dx * ci + dy * si) / gap, (-dx * cj - dy * sj) / gap);
        if (ahead <= 0) continue;
        // Nearer the line between them, the more each needs to give.
        const across = Math.abs(-dx * si + dy * ci);
        const need = Math.min(1, 3 * ahead) * (1 - gap / PASS_REACH) * Math.max(0, 1 - across / (2 * PASS_STEP + 0.4));
        step[i] = Math.min(PASS_STEP, (step[i] as number) + need * PASS_STEP);
        step[j] = Math.min(PASS_STEP, (step[j] as number) + need * PASS_STEP);
      }
    }
  }
}
