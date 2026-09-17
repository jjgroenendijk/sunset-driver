/**
 * The Rapier half of the arsenal (spec section 11.6): what a shot, a swing and
 * a thrown thing do to the world.
 *
 * `weapon.ts` holds the model and decides whether the weapon fires; this casts
 * the ray per pellet, sweeps the melee arc and carries everything in the air a
 * tick at a time. `physics.ts` owns the world and hands in what can be hit: the
 * player's vehicle, the police cars of spec section 14 and the faction
 * enforcers of spec section 17.2. The pedestrians of spec section 13.1 are what
 * the rays will find after them.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { damageVehicle, disableEngine, ignite } from './damage.ts';
import { unrotate } from './frame.ts';
import type { InputFrame } from './input.ts';
import { hurt, SKIN, vehicleGap } from './on-foot.ts';
import type { SimState } from './simulation.ts';
import type { VehicleSpec } from './vehicle.ts';
import { blastEnforcers, hurtEnforcer } from './enforcer.ts';
import { blastUnits, report, shootUnit } from './police.ts';
import {
  blastFalloff,
  bounceProjectile,
  projectileDue,
  roundSeverity,
  VEHICLE_SHARE_PER_POINT,
  stepProjectile,
  stepWeapons,
  swingReaches,
  weaponOf,
  type ProjectileState,
  type ShotRay,
  type WeaponSpec,
} from './weapon.ts';

/** What a shot may hit, and whose body it may not. */
export interface ShotTarget {
  /** The roster row of the vehicle, which is what the damage is read against. */
  spec: VehicleSpec;
  /** The vehicle's collider, and undefined while it carries none. */
  body: RAPIER.Collider | undefined;
  /**
   * The shooter's own collider, left out of every cast: a driver firing from a
   * seat would otherwise shoot their own door, and a player on foot their own
   * chest.
   */
  shooter: RAPIER.Collider | undefined;
  /**
   * The police cars standing in the world (spec section 14), which is how a
   * round that went into one finds the unit it hit. A ground with no police
   * leaves it out.
   */
  police?: { unitAt(handle: number): number | undefined };
  /**
   * The faction enforcers standing in the world (spec section 17.2), which is
   * how a round that went into one finds the person it hit. A ground with no
   * factions leaves it out.
   */
  enforcers?: { unitAt(handle: number): number | undefined };
}

/** The casts and the flights of one session. It owns no state but its scratch. */
export class Gunfire {
  private readonly world: RAPIER.World;
  /** Scratch vectors, so a tick allocates nothing. */
  private readonly point = { x: 0, y: 0, z: 0 };
  private readonly from = { x: 0, y: 0, z: 0 };
  private readonly along = { x: 0, y: 0, z: 0 };
  /** The one ray every shot and every projectile step is cast with. */
  private readonly ray: RAPIER.Ray;

  constructor(world: RAPIER.World) {
    this.world = world;
    this.ray = new RAPIER.Ray(this.from, this.along);
  }

  /**
   * Fire the weapon in the player's hands for a tick (spec section 11.6).
   *
   * The rules are in `weapon.ts` and this is the Rapier half of them: a gun
   * casts a ray per pellet, a melee weapon sweeps its arc, and a thrown weapon
   * or a launcher puts something in the air for {@link Gunfire.fly} to carry.
   * Nothing here decides whether the weapon fires; `stepWeapons` does, and it
   * also raises the heat a shot is worth (spec section 14).
   *
   * The player's vehicle, the police cars of spec section 14 and the faction
   * enforcers of spec section 17.2 can be hit: a ray that meets a traffic body
   * stops there (#256), and the pedestrians of spec section 13.1 are what the
   * rays will find after them.
   */
  step(state: SimState, input: InputFrame, target: ShotTarget): void {
    const shot = stepWeapons(state.loadout, input, state.player, state.seed, state.tick);
    if (shot === undefined) return;
    report(state, shot.heat);
    if (shot.projectile !== undefined) {
      state.projectiles.push(shot.projectile);
      return;
    }
    if (shot.spec.cls === 'melee') {
      this.swing(state, shot.spec, target);
      return;
    }
    for (const ray of shot.rays) this.scan(state, shot.spec, ray, shot.range, target);
  }

  /**
   * One pellet, cast against the world. The shooter's own body is left out of
   * the cast: a driver firing from a seat would otherwise shoot their own door,
   * and a player on foot their own chest.
   */
  private scan(state: SimState, spec: WeaponSpec, ray: ShotRay, range: number, target: ShotTarget): void {
    this.from.x = ray.x;
    this.from.y = ray.h;
    this.from.z = ray.y;
    this.along.x = ray.dx;
    this.along.y = ray.dh;
    this.along.z = ray.dy;
    const mine = target.shooter;
    const hit = this.world.castRay(this.ray, range, true, undefined, undefined, mine);
    if (hit === null) return;
    // A round that went into a police car is taken off that car (spec section
    // 14), and shooting at officers is what it costs the player.
    const unit = target.police?.unitAt(hit.collider.handle);
    if (unit !== undefined) {
      shootUnit(state, unit, roundSeverity(spec) * VEHICLE_SHARE_PER_POINT);
      return;
    }
    // A round that went into an enforcer is taken off them, on the health scale
    // people are measured in rather than the share a panel takes (spec section
    // 17.2). Enough of them puts the wave down.
    const enforcer = target.enforcers?.unitAt(hit.collider.handle);
    if (enforcer !== undefined) {
      hurtEnforcer(state, enforcer, spec.damage);
      return;
    }
    if (target.body === undefined || hit.collider.handle !== target.body.handle) return;
    // The round pushes the vehicle the way it was flying, which is the direction
    // the panel rule reads, exactly as a crash pushes it away from the wall.
    this.hit(state, spec, ray.dx, ray.dh, ray.dy, roundSeverity(spec), target);
  }

  /**
   * One swing of a melee weapon (spec section 11.6). A swing is an arc rather
   * than a line, so it is a reach and a half-angle and not a ray: whatever
   * stands inside it is hit. Nobody swings at the vehicle they are sitting in.
   */
  private swing(state: SimState, spec: WeaponSpec, target: ShotTarget): void {
    const p = state.player;
    if (p.driving) return;
    const v = state.vehicle;
    const bearing = Math.atan2(v.z - p.y, v.x - p.x);
    if (!swingReaches(spec, p.heading, vehicleGap(p, v, target.spec), bearing)) return;
    this.hit(state, spec, Math.cos(bearing), 0, Math.sin(bearing), roundSeverity(spec), target);
  }

  /**
   * Put one hit into the vehicle: the dent, what it costs the vehicle, and what
   * the round does beyond that. The direction comes in world axes and is read in
   * the vehicle's own frame, so the panel that takes it is the panel that was
   * facing the shot.
   */
  private hit(state: SimState, spec: WeaponSpec, dx: number, dh: number, dy: number, severity: number, target: ShotTarget): void {
    const v = state.vehicle;
    unrotate(this.point, v, dx, dh, dy);
    // `unrotate` answers the vehicle's own axes: `x` along it, `y` up and `z`
    // across it, which is the order the panel rule reads them in.
    damageVehicle(
      v.damage,
      target.spec,
      severity,
      this.point.x,
      this.point.z,
      this.point.y,
      state.seed,
      state.tick,
      state.loadout.shots,
    );
    if (spec.effect === 'fire') ignite(v.damage, state.tick);
    if (spec.effect === 'engine') disableEngine(v.damage);
  }

  /**
   * Carry everything in the air one tick further (spec section 11.6).
   *
   * A step is a straight line between two places, so what the step ran into is
   * a ray over it. A thing that goes off on impact goes off there; anything else
   * bounces and carries on until its fuse burns through. The thrower's own body
   * is left out, so a grenade does not go off in the hand that threw it.
   */
  fly(state: SimState, target: ShotTarget): void {
    const live = state.projectiles;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i] as ProjectileState;
      const flight = weaponOf(p.weapon).projectile;
      if (flight === undefined) {
        live.splice(i, 1);
        continue;
      }
      this.from.x = p.x;
      this.from.y = p.h;
      this.from.z = p.y;
      stepProjectile(p);
      const dx = p.x - this.from.x;
      const dh = p.h - this.from.y;
      const dy = p.y - this.from.z;
      const step = Math.hypot(dx, dh, dy);
      if (step > 0) {
        this.along.x = dx / step;
        this.along.y = dh / step;
        this.along.z = dy / step;
        const mine = target.shooter;
        const hit = this.world.castRayAndGetNormal(this.ray, step, true, undefined, undefined, mine);
        if (hit !== null) {
          // Stand it on the surface it met rather than inside it, so the next
          // step starts outside the ground and not under it.
          p.x = this.from.x + this.along.x * hit.timeOfImpact + hit.normal.x * SKIN;
          p.h = this.from.y + this.along.y * hit.timeOfImpact + hit.normal.y * SKIN;
          p.y = this.from.z + this.along.z * hit.timeOfImpact + hit.normal.z * SKIN;
          if (flight.burstOnImpact) {
            this.burst(state, p, target);
            live.splice(i, 1);
            continue;
          }
          bounceProjectile(p, hit.normal.x, hit.normal.y, hit.normal.z);
        }
      }
      if (!projectileDue(p, state.tick)) continue;
      this.burst(state, p, target);
      live.splice(i, 1);
    }
  }

  /**
   * Set off one projectile where it stands (spec section 11.6). A blast is felt
   * over its radius and falls away to nothing at the edge of it; a Molotov sets
   * what it lands on alight, which is the fire that spreads of spec section
   * 11.3. Smoke and tear gas leave a cloud that nothing reads yet: it is the
   * pedestrians and the police of spec sections 13.1 and 14 that will.
   */
  private burst(state: SimState, p: ProjectileState, target: ShotTarget): void {
    const spec = weaponOf(p.weapon);
    const flight = spec.projectile;
    if (flight === undefined || spec.effect === 'smoke') return;
    const player = state.player;
    const reach = blastFalloff(Math.hypot(player.x - p.x, player.y - p.y, player.height - p.h), flight.blastRadius);
    if (reach > 0) hurt(player, spec.damage * reach);
    const v = state.vehicle;
    const dx = v.x - p.x;
    const dh = v.y - p.h;
    const dy = v.z - p.y;
    const distance = Math.hypot(dx, dh, dy);
    // A blast is felt by every police car inside it, wherever the player's own
    // car stands (spec section 14).
    blastUnits(state, p.x, p.y, roundSeverity(spec) * VEHICLE_SHARE_PER_POINT, (gap) => blastFalloff(gap, flight.blastRadius));
    // And by every enforcer inside it, who feel it as people rather than as
    // panels (spec section 17.2).
    blastEnforcers(state, p.x, p.y, spec.damage, (gap) => blastFalloff(gap, flight.blastRadius));
    const share = blastFalloff(distance, flight.blastRadius);
    if (share === 0) return;
    const length = Math.max(distance, 1e-6);
    this.hit(state, spec, dx / length, dh / length, dy / length, roundSeverity(spec) * share, target);
  }

}
