import { beforeAll, describe, expect, it } from 'vitest';
import { readHit } from '../../src/net/fire.ts';
import { Party, type MessageBody, type NetLink } from '../../src/net/party.ts';
import type { MessageKind } from '../../src/net/protocol.ts';
import { EMPTY_INPUT } from '../../src/sim/input.ts';
import type { Peer, PeerPose } from '../../src/sim/physics/peer-bodies.ts';
import { initPhysics } from '../../src/sim/physics/physics.ts';
import { normaliseAppearance } from '../../src/sim/player/character.ts';
import { createSimState, type SimState } from '../../src/sim/simulation.ts';
import { rideHeight, specOf } from '../../src/sim/vehicles/vehicle.ts';
import { giveWeapon, weaponOf } from '../../src/sim/weapons/weapon.ts';
import { drive, finishBoarding, ramp, start, type Session } from '../support/sim-harness.ts';

/**
 * Friendly fire (spec section 21.5): a round one player puts into another is
 * found by the shooter's physics, carried to the player it went into, and
 * taken off them by their own browser (spec section 21.4).
 */
const SEED = 'sunset';
const ROOM = 'K7M3QX';

/** A player on foot on flat ground, out of the car and facing away from it, with a rifle. */
function armed(): Session {
  const session = start(ramp('asphalt', 0));
  drive(session, 1, { interact: true });
  finishBoarding(session);
  drive(session, 30);
  const { state } = session;
  giveWeapon(state.loadout, 'ak-47');
  const p = state.player;
  p.heading = Math.atan2(p.y - state.vehicle.z, p.x - state.vehicle.x);
  return session;
}

/** Another player standing `gap` metres in front of the shooter, on foot or in a car. */
function ahead(state: SimState, gap: number, driving: boolean): Peer {
  const p = state.player;
  const x = p.x + Math.cos(p.heading) * gap;
  const y = p.y + Math.sin(p.heading) * gap;
  const car = specOf('saloon');
  // The car stands across the line of fire, so the round meets its side.
  const turn = Math.PI / 4;
  const pose: PeerPose = {
    x, y, height: 0, driving, cls: 'saloon',
    carX: x, carY: rideHeight(car), carZ: y, qx: 0, qy: Math.sin(turn), qz: 0, qw: Math.cos(turn),
  };
  return { id: 'friend', appearance: normaliseAppearance(null), pose };
}

describe('another player as a body (spec section 21.5)', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('writes a round into a player on foot down for the room, and takes nothing off anybody here', () => {
    const session = armed();
    const { state, physics } = session;
    const peers = physics.units.peers;
    peers.hold([ahead(state, 6, false)]);
    drive(session, 1);
    expect(peers.count).toBe(1);
    const health = state.player.health;
    drive(session, 2, { fire: true, aim: true });
    const hits = peers.take();
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit).toMatchObject({ peer: 'friend', weapon: 'ak-47', part: 'person' });
      // The round flew away from the shooter, along the way they face.
      expect(hit.dx * Math.cos(state.player.heading) + hit.dy * Math.sin(state.player.heading)).toBeGreaterThan(0.9);
    }
    expect(state.player.health).toBe(health);
    // The outbox is emptied by the take.
    expect(peers.take()).toHaveLength(0);
    physics.dispose();
  });

  it('says a round into a player driving went into their vehicle', () => {
    const session = armed();
    const { state, physics } = session;
    const peers = physics.units.peers;
    peers.hold([ahead(state, 8, true)]);
    drive(session, 1);
    drive(session, 2, { fire: true, aim: true });
    const hits = peers.take();
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.part).toBe('vehicle');
    physics.dispose();
  });

  it('builds no body and writes no hit in a session on its own', () => {
    const session = armed();
    const { physics } = session;
    const peers = physics.units.peers;
    peers.hold([]);
    drive(session, 1);
    drive(session, 2, { fire: true, aim: true });
    expect(peers.count).toBe(0);
    expect(peers.take()).toHaveLength(0);
    physics.dispose();
  });

  it('takes the body away when the player leaves the room', () => {
    const session = armed();
    const { state, physics } = session;
    const peers = physics.units.peers;
    peers.hold([ahead(state, 6, false)]);
    drive(session, 1);
    expect(peers.count).toBe(1);
    peers.hold([]);
    drive(session, 1);
    expect(peers.count).toBe(0);
    physics.dispose();
  });

  it('lets the local car drive through another player’s car, as it did before they had a body', () => {
    const session = start(ramp('asphalt', 0));
    const { state, physics } = session;
    physics.spawn(state, 0, 0, 0);
    const car = specOf('saloon');
    const pose: PeerPose = {
      x: 14, y: 0, height: 0, driving: true, cls: 'saloon',
      carX: 14, carY: rideHeight(car), carZ: 0, qx: 0, qy: Math.sin(Math.PI / 4), qz: 0, qw: Math.cos(Math.PI / 4),
    };
    physics.units.peers.hold([{ id: 'friend', appearance: normaliseAppearance(null), pose }]);
    state.vehicle.vx = 18;
    physics.adopt(state);
    drive(session, 90);
    expect(state.vehicle.x).toBeGreaterThan(14 + car.halfLength);
    physics.dispose();
  });
});

/** A room with nothing behind it: each link hands what it sends straight to the others. */
class Wire implements NetLink {
  readonly selfId: string;
  readonly via = 'test';
  private readonly room: Wire[];
  onPeerJoin: ((id: string) => void) | null = null;
  onPeerLeave: ((id: string) => void) | null = null;
  onMessage: ((kind: MessageKind, body: unknown, from: string) => void) | null = null;

  constructor(selfId: string, room: Wire[]) {
    this.selfId = selfId;
    this.room = room;
    room.push(this);
  }

  send(kind: MessageKind, body: MessageBody, to?: string): void {
    for (const other of this.room) {
      if (other === this || (to !== undefined && other.selfId !== to)) continue;
      other.onMessage?.(kind, body, this.selfId);
    }
  }

  close(): void {}
}

/** Two players in one room, both past the handshake. */
function room(): { shooter: Party; target: Party; struck: SimState; wire: Wire[] } {
  const wire: Wire[] = [];
  const a = new Wire('a', wire);
  const b = new Wire('b', wire);
  const shooter = new Party(a, { seed: SEED, room: ROOM, host: true, tick: 0 });
  const target = new Party(b, { seed: SEED, room: ROOM, host: false, tick: 0 });
  a.onPeerJoin?.('b');
  b.onPeerJoin?.('a');
  return { shooter, target, struck: createSimState(1), wire };
}

describe('friendly fire on the wire (spec sections 21.4, 21.5)', () => {
  it('takes a round in the body off the player it went into, on their own frame', () => {
    const { shooter, target, struck } = room();
    struck.player.driving = false;
    const health = struck.player.health;
    shooter.fire([{ peer: 'b', weapon: 'ak-47', part: 'person', dx: 1, dh: 0, dy: 0 }]);
    // Nothing is written until the owner's next frame.
    expect(struck.player.health).toBe(health);
    target.frame(struck, EMPTY_INPUT, 1);
    expect(struck.player.health).toBe(health - weaponOf('ak-47').damage);
    // A hit is taken once.
    target.frame(struck, EMPTY_INPUT, 1);
    expect(struck.player.health).toBe(health - weaponOf('ak-47').damage);
  });

  it('dents the car of the player a round went into, and leaves their health alone', () => {
    const { shooter, target, struck } = room();
    const health = struck.player.health;
    shooter.fire([{ peer: 'b', weapon: 'ak-47', part: 'vehicle', dx: 0, dh: 0, dy: 1 }]);
    target.frame(struck, EMPTY_INPUT, 1);
    expect(struck.vehicle.damage.integrity).toBeLessThan(1);
    expect(struck.player.health).toBe(health);
  });

  it('drops a hit on a player who is not in the room, and one from a player who is not', () => {
    const { shooter, target, struck, wire } = room();
    struck.player.driving = false;
    const health = struck.player.health;
    shooter.fire([{ peer: 'nobody', weapon: 'ak-47', part: 'person', dx: 1, dh: 0, dy: 0 }]);
    const stranger = new Wire('c', wire);
    stranger.send('hit', { weapon: 'ak-47', part: 'person', dx: 1, dh: 0, dy: 0 }, 'b');
    target.frame(struck, EMPTY_INPUT, 1);
    expect(struck.player.health).toBe(health);
  });

  it('reads a hit as sent, and refuses what is not one', () => {
    expect(readHit({ weapon: 'glock-17', part: 'vehicle', dx: 0, dh: 0, dy: 2 })).toEqual({
      weapon: 'glock-17', part: 'vehicle', dx: 0, dh: 0, dy: 1,
    });
    expect(readHit({ weapon: 'railgun', part: 'person', dx: 1, dh: 0, dy: 0 })).toBeNull();
    expect(readHit({ weapon: 'glock-17', part: 'head', dx: 1, dh: 0, dy: 0 })).toBeNull();
    expect(readHit({ weapon: 'glock-17', part: 'person', dx: 0, dh: 0, dy: 0 })).toBeNull();
    expect(readHit({ weapon: 'glock-17', part: 'person', dx: Number.NaN, dh: 0, dy: 0 })).toBeNull();
    expect(readHit({ weapon: 'glock-17', part: 'person', damage: 1000 })).toBeNull();
    expect(readHit(null)).toBeNull();
  });
});
