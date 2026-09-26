/**
 * The blood on the ground (spec sections 11.6, 13.1): the pools under bodies,
 * the smears a thrown body leaves and the spatter around a hit.
 *
 * `blood-layout.ts` works out where each mark lies and this draws them: one
 * batch of flat squares laid just over the ground, shaded by
 * `blood-material.ts`, so all the blood of a scene costs one draw call. The
 * batch holds {@link BLOOD_CAP} marks.
 *
 * Pools and smears are read off the record every frame. A body that is taken
 * away, or a casualty the record lets go of, takes its marks off the record
 * at once, so the view keeps the last marks it drew for each and fades them
 * out over {@link FADE_TICKS}. The spatter is the other thing it keeps: the
 * record holds a hit for only a few ticks, so the view remembers the last
 * {@link SPATTER_MEMORY} of them, and drops the oldest.
 *
 * The gore level (`gore.ts`) sets every size, and Off draws nothing.
 */
import { InstancedBufferAttribute, InstancedMesh, Object3D, PlaneGeometry } from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
import type { Casualty } from '../../sim/crowd/casualty.ts';
import type { MeleeHit } from '../../sim/weapons/melee.ts';
import type { Tracer } from '../../sim/weapons/tracer.ts';
import {
  BLOOD_CAP,
  casualtyMarks,
  emptyMark,
  spatterMarks,
  type BloodMark,
  type Spatter,
} from './blood-layout.ts';
import { bloodMaterial } from './blood-material.ts';
import { DEFAULT_GORE, GORE, type Gore } from './gore.ts';

/** Metres over the ground a mark is laid, clear of the road and under the skid marks' 0.03. */
const BLOOD_LIFT = 0.025;

/** The extra lift of a mark's layer: streaks lowest, then pools, then spots. */
function layerLift(mark: BloodMark): number {
  if (mark.streak > 0) return 0;
  return mark.owner < 0 ? 0.002 : 0.001;
}

/** Ticks the marks of a body taken away take to fade out. */
const FADE_TICKS = 3 * 60;

/** Hits the view remembers for the spatter, and marks it keeps fading at once. */
const SPATTER_MEMORY = 24;
const FADING_CAP = 32;

/** How hard a round lands, as `shot-fx.ts` counts it. */
const ROUND_STRENGTH = 0.5;

/** A mark whose casualty has left the record, and the tick it left. */
interface Fading {
  mark: BloodMark;
  from: number;
}

/** The blood on the ground. One batch, one draw call. */
export class BloodView {
  readonly mesh: InstancedMesh;
  /** How much blood is drawn. */
  gore: Gore = DEFAULT_GORE;
  private readonly data: InstancedBufferAttribute;
  private readonly dummy = new Object3D();
  /** The marks of this frame, reused from frame to frame. */
  private readonly marks: BloodMark[] = [];
  /** The casualty marks drawn last frame, copied, so a body that goes can be faded. */
  private held: BloodMark[] = [];
  private readonly fading: Fading[] = [];
  private readonly spatters: Spatter[] = [];
  /** The ids of the casualties on the record this frame; reused. */
  private readonly present = new Set<number>();
  /** The tick of the last hit taken in, so no hit is taken twice. */
  private seen = -1;

  constructor() {
    const geometry = new PlaneGeometry(1, 1);
    // Laid flat, with its length along x.
    geometry.rotateX(-Math.PI / 2);
    this.data = new InstancedBufferAttribute(new Float32Array(BLOOD_CAP * 4), 4);
    geometry.setAttribute('blood', this.data);
    this.mesh = new InstancedMesh(geometry, bloodMaterial(), BLOOD_CAP);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
  }

  /**
   * Draw the blood of the record at this tick. `heightAt` is the ground under
   * a place, which a hit in the air is laid on. Call it once a frame, after
   * the record has been stepped.
   */
  update(
    casualties: readonly Casualty[],
    hits: readonly MeleeHit[],
    tracers: readonly Tracer[],
    tick: number,
    heightAt: (x: number, y: number) => number,
  ): void {
    if (tick < this.seen) this.reset(tick);
    this.remember(hits, tracers, tick, heightAt);
    let n = 0;
    if (GORE[this.gore].pool > 0) {
      n = casualtyMarks(casualties, tick, this.gore, this.marks);
      this.fade(casualties, n, tick);
      n = this.fadingMarks(n, tick);
      n = spatterMarks(this.spatters, tick, this.gore, this.marks, n);
    } else {
      this.held.length = 0;
      this.fading.length = 0;
    }
    this.draw(n);
  }

  /** Forget every mark: a new session or a loaded save. The record's pools come back on the next frame. */
  reset(tick: number): void {
    this.held.length = 0;
    this.fading.length = 0;
    this.spatters.length = 0;
    this.seen = tick;
    this.mesh.count = 0;
  }

  /** Marks drawn in the last frame, which the tests read. */
  get drawn(): number {
    return this.mesh.count;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardNodeMaterial).dispose();
    this.mesh.dispose();
  }

  /** Take in every hit on a person since the last frame, from a blow, a car or a round. */
  private remember(
    hits: readonly MeleeHit[],
    tracers: readonly Tracer[],
    tick: number,
    heightAt: (x: number, y: number) => number,
  ): void {
    const since = this.seen;
    this.seen = tick;
    for (const hit of hits) {
      if (hit.surface !== 'person' || hit.tick <= since || hit.tick > tick) continue;
      this.keep(hit.tick, hit.x, hit.y, heightAt(hit.x, hit.y), hit.strength);
    }
    for (const t of tracers) {
      // Fire burns rather than bleeds.
      if (t.end !== 'person' || t.flame === true || t.tick <= since || t.tick > tick) continue;
      this.keep(t.tick, t.ex, t.ey, heightAt(t.ex, t.ey), ROUND_STRENGTH);
    }
  }

  private keep(tick: number, x: number, y: number, h: number, strength: number): void {
    if (this.spatters.length >= SPATTER_MEMORY) this.spatters.shift();
    this.spatters.push({ tick, x, y, h, strength });
  }

  /**
   * Start fading the marks of every casualty drawn last frame who is not on
   * the record now, or has been taken away, and hold on to this frame's.
   */
  private fade(casualties: readonly Casualty[], n: number, tick: number): void {
    this.present.clear();
    for (const record of casualties) if (!record.gone) this.present.add(record.id);
    for (const mark of this.held) {
      if (this.present.has(mark.owner)) continue;
      if (this.fading.length >= FADING_CAP) this.fading.shift();
      this.fading.push({ mark, from: tick });
    }
    const held: BloodMark[] = [];
    for (let i = 0; i < n; i++) held.push({ ...(this.marks[i] as BloodMark) });
    this.held = held;
  }

  /** Lay the fading marks after the record's, and drop the ones that are done. */
  private fadingMarks(n: number, tick: number): number {
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const { mark, from } = this.fading[i] as Fading;
      const left = 1 - (tick - from) / FADE_TICKS;
      if (left <= 0) {
        this.fading.splice(i, 1);
        continue;
      }
      if (n >= BLOOD_CAP) continue;
      const out = this.marks[n] ?? emptyMark();
      Object.assign(out, mark);
      out.alpha = mark.alpha * left;
      this.marks[n++] = out;
    }
    return n;
  }

  /** Write the marks into the batch. */
  private draw(n: number): void {
    // Nothing to draw and nothing drawn last frame is nothing to upload.
    if (n === 0 && this.mesh.count === 0) return;
    const data = this.data.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const mark = this.marks[i] as BloodMark;
      // Streaks lie a hair under the pools, and spots over both, so the
      // overlaps never flicker between two frames.
      const lift = BLOOD_LIFT + layerLift(mark);
      this.dummy.position.set(mark.x, mark.h + lift, mark.y);
      // Turned about the up axis to its angle on the map, whose y is the world's z.
      this.dummy.rotation.set(0, -mark.angle, 0);
      this.dummy.scale.set(Math.max(0.01, mark.length), 1, Math.max(0.01, mark.width));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      data.set([mark.alpha, mark.variant, mark.streak, mark.age], i * 4);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.data.needsUpdate = true;
  }
}
