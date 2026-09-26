/**
 * The burst a blow of a melee weapon throws off (spec section 11.6).
 *
 * `src/sim/weapons/melee.ts` carries the blows the record landed and this draws them:
 * a handful of sparks thrown out of the place the weapon met, coloured by what
 * it met. Blood off a body, sparks off a body panel, dust off a kerb. How
 * much blood a body throws is the player's gore level (`gore.ts`): Off throws
 * grey dust instead, Subtle fewer and smaller drops, Heavy more and bigger.
 *
 * It is one draw call whatever is going on, blended additively, and a spark is
 * a disc laid flat because the camera of spec section 10.7 looks straight down
 * at it. A spark is placed and coloured from its age alone, so a frame only
 * ever reads the record and the tick.
 *
 * Every spark is jittered from `rngFor(seed, tick, Subsystem.Damage, n)`, the
 * stream the smoke and the flames of `damage-fx.ts` are drawn from, so the same
 * blow at the same tick of the same seed throws the same burst in a replay as
 * it did when it was landed.
 */
import { AdditiveBlending, CircleGeometry, Color, Group, InstancedMesh, MeshBasicMaterial, Object3D } from 'three';
import { rngFor, Subsystem } from '../../core/rng.ts';
import { TICK_RATE } from '../../sim/clock.ts';
import type { HitSurface, MeleeHit } from '../../sim/weapons/melee.ts';
import { DEFAULT_GORE, GORE, type Gore } from '../people/gore.ts';
import { tinted } from '../look/tint.ts';

/** Sparks the batch holds. The oldest is dropped when a new one has nowhere to go. */
const SPARK_CAP = 64;

/** Sparks one blow throws at full strength. A punch throws a third of them. */
export const SPARKS_PER_HIT = 9;

/** Ticks a spark lives for, and metres per second it leaves the blow at. */
const SPARK_LIFE = 24;
const SPARK_SPEED = 4.5;

/** Metres per second squared a spark falls at. They are thrown, not blown. */
const SPARK_FALL = 9;

/** Metres across a spark is thrown at, before its strength is counted. */
const SPARK_SIZE = 0.17;

/** The stream of the seed a burst is jittered from, kept clear of the smoke's. */
const SPARK_STREAM = 400;

/** What each surface throws off: the colour it starts at, and the one it dies at. */
const SPARKS: Readonly<Record<HitSurface, { young: Color; old: Color }>> = Object.freeze({
  person: { young: new Color(0xd8332a), old: new Color(0x4a0d08) },
  vehicle: { young: new Color(0xfff0c0), old: new Color(0xc06a10) },
  hard: { young: new Color(0xcfc6b4), old: new Color(0x55504a) },
});

/** One spark in flight. Everything about it is read off its age. */
interface Spark {
  born: number;
  x: number;
  y: number;
  z: number;
  /** Metres per second it leaves in, in world axes. */
  dx: number;
  dy: number;
  dz: number;
  size: number;
  surface: HitSurface;
}

/** The bursts of the blows that have landed. One batch, one draw call. */
export class MeleeFx {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly live: Spark[] = [];
  private readonly dummy = new Object3D();
  private readonly colour = new Color();
  /** The tick the last blow was drawn on, so no blow is thrown twice. */
  private seen = -1;
  /** The stream of the seed the bursts are jittered from. */
  private readonly stream: number;
  /** How much blood a hit on a person throws. A burst already in the air keeps its look. */
  gore: Gore = DEFAULT_GORE;

  /**
   * `stream` keeps a second user of this burst — the rounds of `shot-fx.ts` —
   * off the stream the blows are jittered from.
   */
  constructor(cap = SPARK_CAP, stream = SPARK_STREAM) {
    this.stream = stream;
    const geometry = new CircleGeometry(0.5, 8);
    // The camera looks down, so a disc laid flat is a disc facing it.
    geometry.rotateX(-Math.PI / 2);
    const material = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    this.mesh = tinted(new InstancedMesh(geometry, material, cap));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    this.group.add(this.mesh);
  }

  /**
   * Throw a burst for every blow landed since the last frame, and draw what is
   * still in the air. Call it once a frame, after the record has been stepped.
   */
  update(hits: readonly MeleeHit[], seed: number, tick: number): void {
    if (tick < this.seen) this.reset(tick);
    const since = this.seen;
    this.seen = tick;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i] as MeleeHit;
      if (hit.tick <= since || hit.tick > tick) continue;
      this.burst(hit, seed, i);
    }
    this.draw(tick);
  }

  /** Forget everything in flight: a new session, a loaded save or a respawn. */
  reset(tick: number): void {
    this.live.length = 0;
    this.mesh.count = 0;
    this.seen = tick - 1;
  }

  /** How many sparks are in the air, which the tests read. */
  get flying(): number {
    return this.live.length;
  }

  dispose(): void {
    this.group.clear();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }

  /** The sparks one blow throws out, up and away from the weapon that landed it. */
  private burst(hit: MeleeHit, seed: number, index: number): void {
    const person = hit.surface === 'person';
    const scale = GORE[this.gore];
    // The jitter streams of two blows sit SPARKS_PER_HIT apart, so no burst
    // throws more than that, however heavy the gore.
    const share = person ? scale.sparks : 1;
    const count = Math.min(SPARKS_PER_HIT, Math.max(2, Math.round(SPARKS_PER_HIT * hit.strength * share)));
    const grow = person ? scale.sparkSize : 1;
    // With the gore off, a body throws the dust a kerb does.
    const surface: HitSurface = person && !scale.blood ? 'hard' : hit.surface;
    for (let i = 0; i < count; i++) {
      const rng = rngFor(seed, hit.tick, Subsystem.Damage, this.stream + index * SPARKS_PER_HIT + i);
      const heading = rng.range(0, Math.PI * 2);
      const speed = rng.range(0.35, 1) * SPARK_SPEED * (0.5 + 0.5 * hit.strength);
      if (this.live.length >= this.mesh.instanceMatrix.count) this.live.shift();
      this.live.push({
        born: hit.tick,
        x: hit.x,
        y: hit.h,
        z: hit.y,
        dx: Math.cos(heading) * speed,
        dy: rng.range(0.5, 3),
        dz: Math.sin(heading) * speed,
        size: SPARK_SIZE * rng.range(0.6, 1.3) * (0.6 + 0.4 * hit.strength) * grow,
        surface,
      });
    }
  }

  /** Age every spark, drop the ones that are done, and write the rest into the batch. */
  private draw(tick: number): void {
    let drawn = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const spark = this.live[i] as Spark;
      const age = (tick - spark.born) / SPARK_LIFE;
      if (age < 0 || age >= 1) {
        this.live.splice(i, 1);
        continue;
      }
      const seconds = (tick - spark.born) / TICK_RATE;
      this.dummy.position.set(
        spark.x + spark.dx * seconds,
        spark.y + spark.dy * seconds - 0.5 * SPARK_FALL * seconds * seconds,
        spark.z + spark.dz * seconds,
      );
      // It shrinks away over its life, which is how a spark leaves with nothing
      // to fade it out with.
      const size = spark.size * (1 - age);
      this.dummy.scale.set(size, size, size);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(drawn, this.dummy.matrix);
      const shade = SPARKS[spark.surface];
      this.colour.copy(shade.young).lerp(shade.old, age);
      this.mesh.setColorAt(drawn, this.colour);
      drawn++;
    }
    // Nothing to draw and nothing drawn last frame is nothing to upload: a
    // player who is not swinging should cost the frame no buffer at all.
    if (drawn === 0 && this.mesh.count === 0) return;
    this.mesh.count = drawn;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor !== null) this.mesh.instanceColor.needsUpdate = true;
  }
}
