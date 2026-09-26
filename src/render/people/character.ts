import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Vector3,
} from 'three';
import {
  type CharacterAppearance,
  normaliseAppearance,
  resolveAppearance,
} from '../../sim/player/character.ts';
import {
  advancePhase,
  poseFor,
  stanceOf,
  type CharacterMotion,
  type CharacterPose,
  type Stance,
} from './character-pose.ts';
import { holdOver, type Hold, type HoldRig } from './character-hold.ts';

/** How quickly a raised or lowered aim settles, per second. About a fifth of a second. */
const AIM_EASE = 14;

/**
 * The player model, built from boxes at the proportions the chosen body type
 * asks for (spec section 11.1). The camera looks down, so the parts that read
 * from above — shoulders, hair, shoes — carry the colours the player picked.
 *
 * The boxes hang off a rig of groups rather than off one group, so the model
 * moves: a hip and a knee each side, a shoulder each side, the torso over the
 * hips, and the body itself, which a swimmer tips forward. `character-pose.ts`
 * says what angle each of them takes; {@link CharacterModel.animate} carries
 * the cycle along and writes it in.
 */
export class CharacterModel {
  readonly group = new Group();
  private geometries: BufferGeometry[] = [];
  private materials: Material[] = [];
  private appearance: CharacterAppearance;
  /** The body, which the pose tips and lifts, and the hips it hangs from. */
  private body = new Group();
  private hips = new Group();
  private torso = new Group();
  /** The hip and knee of each leg, and the shoulder of each arm: left, then right. */
  private legs: { hip: Group; knee: Group }[] = [];
  private arms: Group[] = [];
  /** Metres from the ground to the hips, which is where the rig hangs from. */
  private hipHeight = 0;
  /** How far through the current cycle the body is, in radians. */
  private phase = 0;
  private stance: Stance = 'stand';
  /** The sizes the arms are pointed at a gun with. */
  private rig: HoldRig = { shoulderX: 0, shoulderY: 0, reach: 0 };
  /** The middle of the right fist, where a gun is held. */
  private fist = new Group();
  /** How far the aim is raised, eased toward what the record says. */
  private aimed = 0;
  /** The grip the arms were last posed in, `none` while they hang free. */
  private held: Hold['grip'] = 'none';

  constructor(appearance: CharacterAppearance) {
    this.appearance = normaliseAppearance(appearance);
    this.build();
  }

  /** Height of the model in metres, so the camera and the HUD can frame it. */
  get height(): number {
    return resolveAppearance(this.appearance).body.height;
  }

  /**
   * Metres from the soles to the hips, which is where the rig hangs from and
   * what a body has to be lifted by to be seated on anything (`rider.ts`).
   */
  get hipsAt(): number {
    return this.hipHeight;
  }

  /**
   * The sizes an arm of this model is pointed by, so anything that puts a hand
   * on a fixed place — a gun (`character-hold.ts`), a set of handlebars
   * (`rider.ts`) — reaches it whatever body the player chose.
   */
  get reach(): HoldRig {
    return this.rig;
  }

  /** Rebuild for a new look. Cheap enough to call on every click of the creator. */
  set(appearance: CharacterAppearance): void {
    const next = normaliseAppearance(appearance);
    this.appearance = next;
    this.clear();
    this.build();
  }

  /**
   * Move the model on by `dt` seconds of the record it is drawn from: the
   * walk, the jump, the fall and the swim of spec sections 11.2 and 11.5. The
   * cycle is carried by the speed rather than by the clock, so the feet keep
   * pace with the ground at any frame rate.
   */
  animate(motion: CharacterMotion, dt: number, hold?: Hold): void {
    const stance = stanceOf(motion);
    // A change of stance starts the new cycle where the old one stopped, which
    // is what keeps a walk that becomes a run from snapping to another step.
    this.stance = stance;
    this.phase = advancePhase(this.phase, stance, motion.speed, dt);
    const pose = poseFor(stance, this.phase, motion);
    // A swimmer's arms are busy with the stroke, so a gun is not held in them.
    const grip = stance === 'swim' || hold === undefined ? 'none' : hold.grip;
    const want = grip !== 'none' && hold !== undefined ? Math.min(1, Math.max(0, hold.aim)) : 0;
    this.aimed += (want - this.aimed) * Math.min(1, AIM_EASE * Math.max(0, dt));
    this.pose(pose, { grip, aim: this.aimed, kick: hold?.kick ?? 0 });
  }

  /**
   * Where the right fist is, in the model's own frame, which is where a gun is
   * drawn: undefined while the arms hold nothing. Read after
   * {@link CharacterModel.animate}.
   */
  grip(out: Vector3): Vector3 | undefined {
    if (this.held === 'none') return undefined;
    this.group.updateMatrixWorld(true);
    this.fist.getWorldPosition(out);
    return this.group.worldToLocal(out);
  }

  /** Where the model is in its cycle, which is what a test reads. */
  get at(): { stance: Stance; phase: number } {
    return { stance: this.stance, phase: this.phase };
  }

  /** Write one pose into the rig, with the arms holding a gun where `hold` says one is held. */
  pose(stance: CharacterPose, hold?: Hold): void {
    this.held = hold?.grip ?? 'none';
    const pose = hold === undefined ? stance : holdOver(stance, hold, this.rig);
    this.body.rotation.z = pose.pitch;
    this.body.position.y = pose.lift;
    // The model faces local +x, so a lunge steps along it.
    this.body.position.x = pose.lunge;
    this.hips.position.y = this.hipHeight + pose.bob;
    // A turn about +z carries a hanging limb forward, to local +x; the torso
    // stands up rather than hangs, so it leans forward the other way. A turn
    // about +y carries it round, which is the wind-up of a swing.
    this.torso.rotation.z = -pose.lean;
    this.torso.rotation.y = pose.twist;
    const [left, right] = this.legs as [{ hip: Group; knee: Group }, { hip: Group; knee: Group }];
    left.hip.rotation.z = pose.thighL;
    right.hip.rotation.z = pose.thighR;
    left.knee.rotation.z = pose.kneeL;
    right.knee.rotation.z = pose.kneeR;
    // A turn about +x carries a hanging leg toward -z, which is the side the
    // first of the pair stands on; the other takes the same angle negated, so
    // a positive spread carries each leg out to its own side. Three.js turns
    // about x before z, so the leg swings forward and is then rolled out,
    // which is a rider astride rather than a walker falling over.
    left.hip.rotation.x = pose.spreadL;
    right.hip.rotation.x = -pose.spreadR;
    const [armL, armR] = this.arms as [Group, Group];
    armL.rotation.z = pose.armL;
    armR.rotation.z = pose.armR;
    // Three.js turns about x, then y, then z, so the arm is raised in front of
    // the body first and carried round after it: an arc across the body, which
    // is what a swing reads as from overhead.
    armL.rotation.y = pose.yawL;
    armR.rotation.y = pose.yawR;
  }

  /** Release the GPU resources of the current model. */
  dispose(): void {
    this.clear();
  }

  private clear(): void {
    this.group.clear();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries = [];
    this.materials = [];
    this.legs = [];
    this.arms = [];
    this.fist = new Group();
  }

  /**
   * One part, sized and placed across the body, up, and along the way it faces,
   * within the piece of the rig it hangs from. The model faces local +x, the
   * way a yaw of -heading turns along the heading, so across is local z and
   * along is local x.
   */
  private box(
    parent: Object3D,
    w: number,
    h: number,
    d: number,
    colour: number,
    across: number,
    up: number,
    along: number,
  ): void {
    const geometry = new BoxGeometry(d, h, w);
    const material = new MeshStandardMaterial({ color: colour, roughness: 0.7 });
    const mesh = new Mesh(geometry, material);
    mesh.position.set(along, up, across);
    this.geometries.push(geometry);
    this.materials.push(material);
    parent.add(mesh);
  }

  /** A piece of the rig, hanging from another at a place given across, up and along. */
  private joint(parent: Object3D, across: number, up: number, along: number): Group {
    const group = new Group();
    group.position.set(along, up, across);
    parent.add(group);
    return group;
  }

  private build(): void {
    const { body, skin, hair, hairColour, outfit } = resolveAppearance(this.appearance);
    const h = body.height;
    const shoeHeight = 0.06 * h * 0.6;
    const legTop = 0.52 * h;
    const kneeTop = 0.28 * h;
    const shoulderTop = 0.82 * h;
    const headHeight = h - shoulderTop;
    const legWidth = body.hip * 0.44;
    const armWidth = body.shoulder * 0.16;
    const depth = body.shoulder * 0.52;
    const torsoHeight = shoulderTop - legTop;

    this.hipHeight = legTop;
    this.body = this.joint(this.group, 0, 0, 0);
    this.hips = this.joint(this.body, 0, legTop, 0);
    this.torso = this.joint(this.hips, 0, 0, 0);

    // Each leg hangs from its hip, and the shin and the shoe from the knee, so
    // a bent knee carries the foot with it.
    for (const side of [-1, 1]) {
      const x = side * body.hip * 0.26;
      const hip = this.joint(this.hips, x, 0, 0);
      const knee = this.joint(hip, 0, -(legTop - kneeTop), 0);
      this.box(hip, legWidth, legTop - kneeTop, depth * 0.8, outfit.bottom, 0, -(legTop - kneeTop) / 2, 0);
      this.box(knee, legWidth, kneeTop - shoeHeight, depth * 0.8, outfit.bottom, 0, -(kneeTop - shoeHeight) / 2, 0);
      this.box(knee, legWidth * 1.1, shoeHeight, depth * 1.2, outfit.shoe, 0, -kneeTop + shoeHeight / 2, depth * 0.1);
      this.legs.push({ hip, knee });
    }

    this.box(this.torso, body.shoulder, torsoHeight, depth, outfit.top, 0, torsoHeight / 2, 0);

    // Each arm hangs from its shoulder, just under the top of the torso.
    const armLength = torsoHeight * 0.86;
    const handLength = torsoHeight * 0.14;
    for (const side of [-1, 1]) {
      const x = side * (body.shoulder / 2 + armWidth / 2);
      const shoulder = this.joint(this.torso, x, torsoHeight * 0.95, 0);
      this.box(shoulder, armWidth, armLength, depth * 0.7, outfit.top, 0, -armLength / 2, 0);
      // Hands read as the skin tone from above, at the end of each arm.
      this.box(shoulder, armWidth, handLength, depth * 0.7, skin.colour, 0, -armLength - handLength / 2, 0);
      if (side === 1) this.fist = this.joint(shoulder, 0, -armLength - handLength / 2, 0);
      this.arms.push(shoulder);
    }
    this.rig = {
      shoulderX: body.shoulder / 2 + armWidth / 2,
      shoulderY: torsoHeight * 0.95,
      reach: armLength + handLength / 2,
    };

    const headWidth = h * 0.13;
    // The hair sits on the crown and, when it is long enough, falls behind.
    const capHeight = headHeight * 0.34 + hair.volume;
    const crown = h - legTop;
    // The head stops half a cap short of the crown, so its top face is buried
    // inside the hair rather than standing on the same plane as the hair's own.
    // The cap is wider than the head by the hair's volume each way, so the band
    // the head gives up was inside the cap and never drawn: the silhouette does
    // not change. The camera looks down, so the crown is the face of a person
    // it sees most of, and two surfaces fighting over it shimmer as it moves.
    const skullHeight = headHeight - capHeight / 2;
    this.box(this.torso, headWidth, skullHeight, headWidth * 1.05, skin.colour, 0, torsoHeight + skullHeight / 2, 0);

    this.box(
      this.torso,
      headWidth + hair.volume * 2,
      capHeight,
      headWidth * 1.05 + hair.volume * 2,
      hairColour.colour,
      0,
      crown - capHeight / 2,
      0,
    );
    if (hair.length > 0.03) {
      this.box(
        this.torso,
        headWidth + hair.volume,
        hair.length,
        headWidth * 0.3,
        hairColour.colour,
        0,
        crown - capHeight - hair.length / 2,
        -headWidth * 0.5,
      );
    }
  }
}
