/**
 * The tram stops near the player, as Rapier colliders (spec section 13.2).
 *
 * Each island platform inside the box of ground the physics holds is a set of
 * fixed colliders: the slab, which a car mounts with a jolt and a person steps
 * up onto, the shelter, the flag's mast, and the bollards at each nose, which
 * stop a car driven at them head on. They stand where
 * `render/transit/tram-stops.ts` draws them, in the same frame: `+x` along the
 * platform and `-z` across it, away from the track. Out of the box a stop has
 * no colliders.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { cos, sin } from '../../core/libm.ts';
import { TRAM_LANE } from '../../world/roads/tiers.ts';
import { TRAM_LENGTH, type TramStopPlace } from './tram.ts';
import { PLATFORM_RISE, SHELTER_LONG, SHELTER_TALL } from './tram-stop-place.ts';

/** One solid of a stop, in the stop's own frame: its half extents and its middle. */
interface Solid {
  half: [number, number, number];
  at: [number, number, number];
}

const INNER = TRAM_LANE.platformInner;
const WIDTH = TRAM_LANE.platform;
const MIDDLE = -(INNER + WIDTH / 2);
/** Metres of the mast at the end the tram arrives from, and of the bollards at each nose. */
const MAST_TALL = 2.5;
const BOLLARD_TALL = 0.9;
/** Metres past the end of the slab the bollards stand at. */
const NOSE = 0.35;

/** The solids of one stop. */
function solids(): Solid[] {
  const nose = TRAM_LENGTH / 2 + NOSE;
  const bollard = (x: number, z: number): Solid => ({ half: [0.1, BOLLARD_TALL / 2, 0.1], at: [x, PLATFORM_RISE + BOLLARD_TALL / 2, z] });
  return [
    { half: [TRAM_LENGTH / 2, PLATFORM_RISE / 2, WIDTH / 2], at: [0, PLATFORM_RISE / 2, MIDDLE] },
    { half: [SHELTER_LONG / 2, SHELTER_TALL / 2, (WIDTH - 0.3) / 2], at: [0, PLATFORM_RISE + SHELTER_TALL / 2, MIDDLE] },
    { half: [0.06, MAST_TALL / 2, 0.06], at: [-(TRAM_LENGTH / 2 - 1.2), PLATFORM_RISE + MAST_TALL / 2, MIDDLE] },
    ...[1, -1].flatMap((side) => [bollard(side * nose, -(INNER + 0.35)), bollard(side * nose, -(INNER + WIDTH - 0.3)), bollard(side * nose, MIDDLE)]),
  ];
}

const SOLIDS = solids();

export class PlatformBodies {
  private readonly world: RAPIER.World;
  private readonly places: readonly TramStopPlace[];
  /** The colliders of each stop, in stop order; undefined while it is out of the box. */
  private readonly laid: (RAPIER.Collider[] | undefined)[];

  constructor(world: RAPIER.World, places: readonly TramStopPlace[]) {
    this.world = world;
    this.places = places;
    this.laid = new Array<RAPIER.Collider[] | undefined>(places.length).fill(undefined);
  }

  /** How many stops stand in the world as colliders. */
  get count(): number {
    let count = 0;
    for (const stop of this.laid) if (stop !== undefined) count++;
    return count;
  }

  /** Lay the colliders of every stop in the box, and take those of every stop that has left it. */
  cover(minX: number, minY: number, maxX: number, maxY: number): void {
    const reach = TRAM_LENGTH / 2 + 2;
    for (let i = 0; i < this.places.length; i++) {
      const place = this.places[i] as TramStopPlace;
      const inside = place.x + reach >= minX && place.x - reach < maxX && place.y + reach >= minY && place.y - reach < maxY;
      const laid = this.laid[i];
      if (inside && laid === undefined) this.laid[i] = this.lay(place);
      if (!inside && laid !== undefined) {
        for (const collider of laid) this.world.removeCollider(collider, false);
        this.laid[i] = undefined;
      }
    }
  }

  /**
   * The solids of one stop as fixed colliders. The frame is turned as the view
   * turns it, a yaw of minus the heading, so `x` along the stop lands where the
   * view draws it.
   */
  private lay(place: TramStopPlace): RAPIER.Collider[] {
    const c = cos(place.heading);
    const s = sin(place.heading);
    const turn = { x: 0, y: sin(-place.heading / 2), z: 0, w: cos(-place.heading / 2) };
    return SOLIDS.map((solid) => {
      const [x, y, z] = solid.at;
      return this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(...solid.half)
          .setTranslation(place.x + x * c - z * s, place.height + y, place.y + x * s + z * c)
          .setRotation(turn)
          .setFriction(1),
      );
    });
  }
}
