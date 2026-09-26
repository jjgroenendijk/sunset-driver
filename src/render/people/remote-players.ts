/**
 * The other players, drawn (spec sections 21.4, 21.5).
 *
 * Each one is the same two models the local player is drawn with: the character
 * of `character.ts` and the vehicle of `vehicle.ts`. There are at most five of
 * them — six players to a room — so they are whole models rather than instances
 * of a shared mesh, and a remote player is exactly as detailed as the one at the
 * middle of the screen.
 *
 * Nothing here decides where anybody is. The poses come from `src/net`, which
 * draws each player between the frames they sent and carries them on when one
 * is late (`replica.ts`). This file takes a pose and puts the models on it.
 *
 * A remote vehicle is drawn with no damage on it: what a peer has done to its
 * own car is theirs, and the dents are not on the wire yet.
 */
import { Group } from 'three';
import type { RemotePlayer } from '../../net/roster.ts';
import type { CharacterAppearance } from '../../sim/player/character.ts';
import { createVehicleState, specOf, type VehicleState } from '../../sim/vehicles/vehicle.ts';
import { CharacterModel } from './character.ts';
import { seatRider } from '../vehicles/rider.ts';
import { VehicleModel } from '../vehicles/vehicle.ts';

/** One player of the room, as this file holds them. */
interface Seat {
  character: CharacterModel;
  vehicle: VehicleModel;
  /** The state the model is put on, kept per seat so nothing is allocated per frame. */
  drawn: VehicleState;
  /** The look the model was built for, so it is rebuilt only when it changes. */
  look: string;
}

export class RemotePlayerViews {
  readonly group = new Group();
  private readonly seats = new Map<string, Seat>();
  private readonly seaLevel: number;

  constructor(seaLevel: number) {
    this.seaLevel = seaLevel;
  }

  /** How many players are drawn, which is what a test reads. */
  get count(): number {
    return this.seats.size;
  }

  /**
   * Draw the room as it stands. `dt` is the frame in seconds, which carries the
   * walk cycle along, and `lamps` is how far on the street lamps are, so a
   * remote car's lights come on with everybody else's.
   */
  update(players: readonly RemotePlayer[], dt: number, lamps: number): void {
    for (const player of players) {
      const seat = this.seat(player.id, player.appearance);
      this.dress(seat, player.appearance);
      const pose = player.pose;
      const drawn = seat.drawn;
      if (drawn.cls !== pose.cls) Object.assign(drawn, createVehicleState(specOf(pose.cls)));
      drawn.x = pose.carX;
      drawn.y = pose.carY;
      drawn.z = pose.carZ;
      drawn.qx = pose.qx;
      drawn.qy = pose.qy;
      drawn.qz = pose.qz;
      drawn.qw = pose.qw;
      drawn.speed = pose.carSpeed;
      drawn.paint = pose.paint;
      roll(drawn, dt);
      seat.vehicle.set(drawn);
      seat.vehicle.lamps = lamps;
      // A peer on a motorcycle is drawn on top of it, as the local player is
      // (`rider.ts`), and off the same vehicle pose the bike itself took.
      if (pose.driving && seatRider(seat.character, drawn, specOf(drawn.cls))) {
        seat.character.group.visible = true;
        continue;
      }
      seat.character.group.position.set(pose.x, pose.height, pose.y);
      seat.character.group.rotation.set(0, -pose.heading, 0);
      seat.character.group.visible = !pose.driving;
      if (pose.driving) continue;
      seat.character.animate(
        {
          speed: pose.speed,
          grounded: pose.grounded,
          vy: pose.vy,
          depth: Math.max(0, this.seaLevel - pose.height),
          stature: seat.character.height,
          swing: -1,
        },
        dt,
      );
    }
    this.retire(players);
  }

  /** Let go of every model, for a session that has left the room or ended. */
  dispose(): void {
    for (const id of [...this.seats.keys()]) this.empty(id);
  }

  private seat(id: string, appearance: CharacterAppearance): Seat {
    const held = this.seats.get(id);
    if (held) return held;
    const character = new CharacterModel(appearance);
    const vehicle = new VehicleModel();
    character.group.traverse((object) => {
      object.castShadow = true;
    });
    this.group.add(character.group);
    this.group.add(vehicle.group);
    const seat: Seat = {
      character,
      vehicle,
      drawn: createVehicleState(specOf('saloon')),
      look: JSON.stringify(appearance),
    };
    this.seats.set(id, seat);
    return seat;
  }

  /** Rebuild a model whose player changed their look, which a fresh handshake can. */
  private dress(seat: Seat, appearance: CharacterAppearance): void {
    const look = JSON.stringify(appearance);
    if (look === seat.look) return;
    seat.look = look;
    seat.character.set(appearance);
    seat.character.group.traverse((object) => {
      object.castShadow = true;
    });
  }

  /** Take down everybody who is no longer in the room. */
  private retire(players: readonly RemotePlayer[]): void {
    if (players.length === this.seats.size) return;
    const here = new Set(players.map((player) => player.id));
    for (const id of [...this.seats.keys()]) if (!here.has(id)) this.empty(id);
  }

  private empty(id: string): void {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.group.remove(seat.character.group);
    this.group.remove(seat.vehicle.group);
    seat.character.dispose();
    seat.vehicle.dispose();
    this.seats.delete(id);
  }
}

/**
 * Turn the wheels for the ground the vehicle covered this frame. The wheel
 * angles are not on the wire — they are four numbers a peer can work out for
 * itself — so they are rolled off the speed instead, which is what a wheel does.
 */
function roll(drawn: VehicleState, dt: number): void {
  const radius = specOf(drawn.cls).wheelRadius;
  if (radius <= 0) return;
  const turn = (drawn.speed / radius) * dt;
  for (const wheel of drawn.wheels) wheel.rotation += turn;
}
