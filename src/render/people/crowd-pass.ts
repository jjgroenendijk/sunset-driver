/**
 * People passing each other on a pavement (spec sections 13.1, 20.1).
 *
 * Every person walks a lane of their own, most of them on the right, so two
 * walking at each other mostly pass already. Some keep left, and company walks
 * abreast; when two of them meet head on, each steps away from the side the
 * other stands on, keeps that room while they pass, and steps back after. A
 * walker who comes up behind somebody slower, or at somebody standing still,
 * steps round them alone. Two people standing, or walking the same way at one
 * pace, move apart as they come closer than a body's width.
 *
 * Each steps away from the other, never to a fixed side: a person keeping
 * left who stepped to their right would walk into the other one.
 *
 * Somebody else owns some of the people on the pavement: the player on foot,
 * the police, the dealers, the queues at the stops, the startled running
 * off. They are added with {@link CrowdPass.addFixed}. The crowd steps round
 * them as round anybody, and takes the whole step itself, since they do not
 * move for it. One of them coming up from behind is made room for too.
 *
 * This is drawing only. A person of the crowd is a function of the tick and
 * reads nobody else (`pedestrians.ts`), and the step is less than a metre,
 * less than anything the simulation measures a person by.
 */

/** Metres apart two people start to make room for each other. */
const PASS_REACH = 2.2;

/** Metres across their way two people want between them as they pass. */
const CLEAR = 0.6;

/** Metres apart two standing, or two walking side by side, start to move apart. */
const NEAR = 0.9;

/** Metres a person steps aside at most. */
export const PASS_STEP = 0.6;

/** Metres past the other a passer keeps the whole room, and metres past by which it is let go. */
const KEPT = 0.3;
const PAST = 1.2;

/** Metres before the other one the room is fully made. */
const READY = 0.8;

/** Cosine of the angle between two headings under which two people walk at each other. */
const HEAD_ON = -0.5;

/** Cosine under which two people walk the same way, one overtaking the other. */
const SAME_WAY = 0.5;

/** Metres per second faster a walker has to be to step round somebody ahead of them. */
const OVERTAKE = 0.2;

/** Metres across under which the other one stands dead ahead. */
const TIE = 1e-6;

/** Metres per second under which a person stands rather than walks. */
const STILL = 0.3;

/** The group and the instance of somebody the crowd steps round who does not step themselves. */
const FIXED = -1;

/** The walkers of one frame, and the step each takes. The caller fills the first `count`. */
export class CrowdPass {
  count = 0;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly heading: Float64Array;
  readonly speed: Float64Array;
  /** Who each one walks with: company never makes room for itself. */
  readonly group: Int32Array;
  /** The instance each one was written to. */
  readonly index: Int32Array;
  /** Metres right of their way each steps, left when negative, written by {@link solve}. */
  readonly step: Float64Array;
  private readonly order: number[] = [];

  constructor(cap: number) {
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.heading = new Float64Array(cap);
    this.speed = new Float64Array(cap);
    this.group = new Int32Array(cap);
    this.index = new Int32Array(cap);
    this.step = new Float64Array(cap);
  }

  /** Take a person. Returns false once the pass is full. */
  add(x: number, y: number, heading: number, speed: number, group: number, index: number): boolean {
    if (this.count >= this.x.length) return false;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.heading[i] = heading;
    this.speed[i] = speed;
    this.group[i] = group;
    this.index[i] = index;
    return true;
  }

  /** Take somebody the crowd steps round, who is drawn by someone else and does not step. */
  addFixed(x: number, y: number, heading: number, speed: number): boolean {
    return this.add(x, y, heading, speed, FIXED, FIXED);
  }

  /** Work out each person's step, from everyone they have to make room for within {@link PASS_REACH}. */
  solve(): void {
    const n = this.count;
    const { x, y, step, order } = this;
    step.fill(0, 0, n);
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    // Sorted along x, so each person is held against only the ones within reach of them along x.
    order.sort((a, b) => (x[a] as number) - (x[b] as number));
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi] as number;
      for (let oj = oi + 1; oj < n; oj++) {
        const j = order[oj] as number;
        const dx = (x[j] as number) - (x[i] as number);
        if (dx > PASS_REACH) break;
        const dy = (y[j] as number) - (y[i] as number);
        if (dx * dx + dy * dy >= PASS_REACH * PASS_REACH || this.group[i] === this.group[j]) continue;
        this.pair(i, j, dx, dy);
      }
    }
    for (let i = 0; i < n; i++) step[i] = Math.max(-PASS_STEP, Math.min(PASS_STEP, step[i] as number));
  }

  /** Add what `i` and `j` owe each other to their steps. `(dx, dy)` runs from `i` to `j`. */
  private pair(i: number, j: number, dx: number, dy: number): void {
    const ci = Math.cos(this.heading[i] as number);
    const si = Math.sin(this.heading[i] as number);
    const cj = Math.cos(this.heading[j] as number);
    const sj = Math.sin(this.heading[j] as number);
    const vi = this.speed[i] as number;
    const vj = this.speed[j] as number;
    const facing = ci * cj + si * sj;
    const walksI = vi >= STILL;
    const walksJ = vj >= STILL;
    if (walksI === walksJ && (!walksI || (facing > SAME_WAY && Math.abs(vi - vj) <= OVERTAKE))) {
      this.apart(i, j, dx, dy, facing);
      return;
    }
    const [gi, gj] = this.movers(i, j, passers(walksI, walksJ, facing, vi, vj));
    const share = gi && gj ? 0.5 : 1;
    if (gi) this.give(i, dx, dy, ci, si, share, true, 1);
    if (gj) this.give(j, -dx, -dy, cj, sj, share, true, 1);
  }

  /** Two standing, or two walking the same way at one pace: they move apart as they come close. */
  private apart(i: number, j: number, dx: number, dy: number, facing: number): void {
    const near = Math.min(1, (NEAR - Math.hypot(dx, dy)) / (NEAR - CLEAR));
    if (near <= 0) return;
    // Facing one way, a tie sends them to opposite hands; facing each other, each to their right.
    const tie = facing > 0 ? -1 : 1;
    const fixedI = this.index[i] === FIXED;
    const fixedJ = this.index[j] === FIXED;
    const share = fixedI || fixedJ ? 1 : 0.5;
    const hi = this.heading[i] as number;
    const hj = this.heading[j] as number;
    if (!fixedI) this.give(i, dx, dy, Math.cos(hi), Math.sin(hi), near * share, false, 1);
    if (!fixedJ) this.give(j, -dx, -dy, Math.cos(hj), Math.sin(hj), near * share, false, tie);
  }

  /**
   * Who of two passers moves: nobody drawn by someone else. One of those who
   * should have made room leaves it to the other.
   */
  private movers(i: number, j: number, [gi, gj]: [boolean, boolean]): [boolean, boolean] {
    const fixedI = this.index[i] === FIXED;
    const fixedJ = this.index[j] === FIXED;
    return [!fixedI && (gi || (fixedJ && gj)), !fixedJ && (gj || (fixedI && gi))];
  }

  /**
   * Step person `k`, heading `(c, s)`, away from somebody `(dx, dy)` off,
   * until the two are {@link CLEAR} apart across `k`'s way. A passer makes
   * the room as they come up to the other and lets it go once past. `tie`
   * is the hand they take, +1 the right, when the other stands dead ahead.
   */
  private give(k: number, dx: number, dy: number, c: number, s: number, share: number, passing: boolean, tie: number): void {
    // How far the other stands ahead, and to the right.
    const along = dx * c + dy * s;
    const across = -dx * s + dy * c;
    const need = CLEAR - Math.abs(across);
    if (need <= 0) return;
    let weight = 1;
    if (passing) {
      if (along > 0) weight = Math.min(1, (PASS_REACH - along) / (PASS_REACH - READY));
      else weight = Math.max(0, Math.min(1, (PAST + along) / (PAST - KEPT)));
    }
    // Away from the other: to the left of somebody on the right. The tie has a margin: the sine of
    // a heading of pi is not quite 0, so two facing each other would read it apart.
    const away = sideAway(across, tie);
    this.step[k] = (this.step[k] as number) + away * need * share * weight;
  }
}

/**
 * Which of two people make room as they pass, `i` first: both when they meet
 * head on, else the one coming up on somebody who stands, or walks slower the
 * same way.
 */
function passers(walksI: boolean, walksJ: boolean, facing: number, vi: number, vj: number): [boolean, boolean] {
  if (walksI && walksJ && facing < HEAD_ON) return [true, true];
  // Somebody who stands, or walks slower the same way, is stepped round by the one coming up.
  const gi = walksI && (!walksJ || (facing > SAME_WAY && vi - vj > OVERTAKE));
  const gj = walksJ && (!walksI || (facing > SAME_WAY && vj - vi > OVERTAKE));
  return [gi, gj];
}

/** The hand to step to, +1 the right, away from somebody `across` metres to the right; `tie` when dead ahead. */
function sideAway(across: number, tie: number): number {
  if (across > TIE) return -1;
  if (across < -TIE) return 1;
  return tie;
}
