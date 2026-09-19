/**
 * The places of a {@link Ground}, as the simulation reads them off the physics.
 *
 * A ground carries more than heights: the police stations, the metro entrances,
 * the shops, the dealers, the safehouses, the turf, the street-crime corners
 * and the work. Each is optional, so a test can build a ground with none of
 * them. These getters hand each list over, empty where the ground has none, so
 * nothing downstream asks whether it is there. There is no arithmetic here.
 *
 * `SimPhysics` in `physics.ts` extends this class, so the getters stay on the
 * one object every caller already holds.
 */
import type { Ground } from './ground-bodies.ts';
import type { MetroPlace } from './metro.ts';
import type { ShopPlace } from './shop.ts';
import type { DealerPlace } from './dealer.ts';
import type { SafehousePlace } from './safehouse.ts';
import type { MissionWorld } from './job.ts';
import type { CrimeGround } from './street-crime.ts';
import type { TerritoryMap } from './territory.ts';
import type { Place } from './on-foot.ts';

export class GroundPlaces {
  protected readonly ground: Ground;

  constructor(ground: Ground) {
    this.ground = ground;
  }

  /** The police stations of the ground (spec section 11.7), which an arrest reads. */
  get stations(): readonly Place[] {
    return this.ground.stations ?? [];
  }

  /** The metro station entrances of the ground (spec section 13.3), which fast travel reads. */
  get metro(): readonly MetroPlace[] {
    return this.ground.metro ?? [];
  }

  /** The shops of the ground (spec section 16.1), which the doors and the counters read. */
  get shops(): readonly ShopPlace[] {
    return this.ground.shops ?? [];
  }

  /** The dealers of the ground (spec section 16.2), whose corners the contraband is traded at. */
  get dealers(): readonly DealerPlace[] {
    return this.ground.dealers ?? [];
  }

  /** The safehouses of the ground (spec section 16.3), which the doors and a respawn read. */
  get safehouses(): readonly SafehousePlace[] {
    return this.ground.safehouses ?? [];
  }

  /** The turf of the ground (spec section 17.2), which a takeover and the map overlay read. */
  get turf(): TerritoryMap | undefined {
    return this.ground.turf;
  }

  /** The corners the street crime of spec section 20.5 happens on, one set to a district. */
  get crimes(): readonly CrimeGround[] {
    return this.ground.crimes ?? [];
  }

  /** The work of the ground (spec section 18): the contacts, and where they send the player. */
  get missions(): MissionWorld | undefined {
    return this.ground.missions;
  }
}
