/**
 * The other players of a room, as Rapier bodies, so a round can find them
 * (spec section 21.5: friendly fire is on).
 *
 * A remote player is not in the record. They are a pose `src/net` draws
 * between the frames they sent, and `src/sim` may not import from there. So
 * the frame hands the poses in with {@link PeerBodies.hold} before it steps,
 * and each tick {@link PeerBodies.settle} stands the ones inside the box of
 * ground the physics holds: a capsule for a player on foot and a box for the
 * vehicle they drive, moved to where they are drawn. That is also where the
 * shooter sees them, so a round aimed at the drawn player meets their body.
 *
 * Both shapes are sensors, as the people of `person-bodies.ts` are: a cast
 * finds them, and nothing is pushed by them. Each player owns their own
 * vehicle (spec section 21.4), so a solid box would stop the local car
 * against a car that feels nothing on the other browser.
 *
 * A round that goes into one is not taken off anybody here. Each peer has the
 * final word on its own health, so {@link PeerBodies.shoot} writes the hit
 * into an outbox, and the frame hands the outbox to the room, which tells the
 * owner. A single-player session holds no poses, so it builds no bodies and
 * writes no hits.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { CharacterAppearance } from '../player/character.ts';
import { capsuleOf } from '../player/on-foot.ts';
import { specOf, type VehicleClass } from '../vehicles/vehicle.ts';
import type { WeaponId } from '../weapons/weapon.ts';

/** Where another player is drawn: all a body needs of them. */
export interface PeerPose {
  x: number;
  y: number;
  height: number;
  driving: boolean;
  cls: VehicleClass;
  carX: number;
  carY: number;
  carZ: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Another player of the room, as the frame hands them in. */
export interface Peer {
  id: string;
  appearance: CharacterAppearance;
  pose: PeerPose;
}

/** Which of a player's two bodies a round went into. */
export type PeerPart = 'person' | 'vehicle';

/** One round that went into another player, for the room to tell them about. */
export interface PeerHit {
  /** The room's id of the player hit. */
  peer: string;
  weapon: WeaponId;
  part: PeerPart;
  /** The way the round was flying, in world axes, so the owner dents the panel that faced it. */
  dx: number;
  dh: number;
  dy: number;
}

/** A player standing in the world, and the body they stand as. */
interface Standing {
  id: string;
  part: PeerPart;
  /** The vehicle class the box was built for, or null for a capsule. */
  cls: VehicleClass | null;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/** Where on the map a player stands: their car's place while they drive, their feet's otherwise. */
function mapPlace(pose: PeerPose): [number, number] {
  return pose.driving ? [pose.carX, pose.carZ] : [pose.x, pose.y];
}

export class PeerBodies {
  private readonly world: RAPIER.World;
  /** The poses the frame handed in last. */
  private peers: readonly Peer[] = [];
  /** The players who carry a body, in the order they were given one. */
  private readonly standing: Standing[] = [];
  /** The rounds that went into another player since the frame last took them. */
  private readonly outbox: PeerHit[] = [];
  private readonly spot = { x: 0, y: 0, z: 0 };
  private readonly turn = { x: 0, y: 0, z: 0, w: 1 };

  constructor(world: RAPIER.World) {
    this.world = world;
  }

  /** How many players stand in the world as bodies. */
  get count(): number {
    return this.standing.length;
  }

  /** The other players as the frame draws them. An empty list takes every body away at the next settle. */
  hold(peers: readonly Peer[]): void {
    this.peers = peers;
  }

  /**
   * Give a body to every player in the box and take it from every player who
   * has left it, left the room or changed shape, then put each body where the
   * player is drawn.
   */
  settle(minX: number, minY: number, maxX: number, maxY: number): void {
    const inBox = (x: number, y: number): boolean => x >= minX && x < maxX && y >= minY && y < maxY;
    for (let i = this.standing.length - 1; i >= 0; i--) {
      const held = this.standing[i] as Standing;
      const peer = this.peers.find((p) => p.id === held.id);
      if (peer !== undefined && inBox(...mapPlace(peer.pose)) && this.fits(held, peer.pose)) continue;
      this.world.removeRigidBody(held.body);
      this.standing.splice(i, 1);
    }
    for (const peer of this.peers) {
      if (!inBox(...mapPlace(peer.pose))) continue;
      this.place(peer);
      const held = this.standing.find((s) => s.id === peer.id);
      if (held === undefined) {
        this.standing.push(this.build(peer));
        continue;
      }
      held.body.setNextKinematicTranslation(this.spot);
      held.body.setNextKinematicRotation(this.turn);
    }
  }

  /**
   * A round that met a collider. Where the collider is one of these players,
   * the hit is written into the outbox and the part it went into is the
   * answer; anywhere else the answer is undefined and nothing is written.
   */
  shoot(handle: number, weapon: WeaponId, dx: number, dh: number, dy: number): PeerPart | undefined {
    const held = this.standing.find((s) => s.collider.handle === handle);
    if (held === undefined) return undefined;
    this.outbox.push({ peer: held.id, weapon, part: held.part, dx, dh, dy });
    return held.part;
  }

  /** Whether a collider is one of these players, which a swing asks before it lands on the ground. */
  has(handle: number): boolean {
    return this.standing.some((s) => s.collider.handle === handle);
  }

  /** The hits written since the last call, which leave the outbox as they are taken. */
  take(): PeerHit[] {
    return this.outbox.splice(0, this.outbox.length);
  }

  /** Take every body out of the world, and forget the poses and the hits. */
  clear(): void {
    for (const held of this.standing) this.world.removeRigidBody(held.body);
    this.standing.length = 0;
    this.outbox.length = 0;
    this.peers = [];
  }

  /** Whether a body still has the shape the pose asks for. */
  private fits(held: Standing, pose: PeerPose): boolean {
    return pose.driving ? held.cls === pose.cls : held.part === 'person';
  }

  /** A body for one player, standing where they are drawn. */
  private build(peer: Peer): Standing {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.spot.x, this.spot.y, this.spot.z).setRotation(this.turn),
    );
    const pose = peer.pose;
    if (pose.driving) {
      const spec = specOf(pose.cls);
      const shape = RAPIER.ColliderDesc.cuboid(spec.halfLength, spec.halfHeight, spec.halfWidth).setSensor(true);
      return { id: peer.id, part: 'vehicle', cls: pose.cls, body, collider: this.world.createCollider(shape, body) };
    }
    const capsule = capsuleOf(peer.appearance);
    const shape = RAPIER.ColliderDesc.capsule(capsule.halfHeight, capsule.radius).setSensor(true);
    return { id: peer.id, part: 'person', cls: null, body, collider: this.world.createCollider(shape, body) };
  }

  /** The middle of a player's body and its turn: the car as drawn, or the capsule over their feet. */
  private place(peer: Peer): void {
    const pose = peer.pose;
    if (pose.driving) {
      this.spot.x = pose.carX;
      this.spot.y = pose.carY;
      this.spot.z = pose.carZ;
      // A turn that arrived as nothing is no turn, rather than a body Rapier cannot rotate.
      const norm = Math.sqrt(pose.qx * pose.qx + pose.qy * pose.qy + pose.qz * pose.qz + pose.qw * pose.qw);
      const ok = norm > 1e-6;
      this.turn.x = ok ? pose.qx / norm : 0;
      this.turn.y = ok ? pose.qy / norm : 0;
      this.turn.z = ok ? pose.qz / norm : 0;
      this.turn.w = ok ? pose.qw / norm : 1;
      return;
    }
    // The pose says where their feet are; the capsule is held by its middle.
    this.spot.x = pose.x;
    this.spot.y = pose.height + capsuleOf(peer.appearance).rise;
    this.spot.z = pose.y;
    this.turn.x = 0;
    this.turn.y = 0;
    this.turn.z = 0;
    this.turn.w = 1;
  }
}
